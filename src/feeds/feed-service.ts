import { normalizePath, requestUrl, type App } from "obsidian";
import {
  emptyFeedState,
  emptyFeedStore,
  mergeFeedStores,
  feedState,
  findSource,
  normalizeFeedUrl,
  parseFeedStore,
  resolveItems,
  restoreItems,
  withFeedState,
  withFetchError,
  mergeFetchedItems,
  type FeedItem,
  type FeedSource,
  type FeedStoreData,
  type FeedState,
} from "../domain/feed";
import { parseFeed } from "../domain/feed-parse";
import { SyncedJsonFile } from "../state/synced-json-file";
import { createUlid } from "../utils/ulid";

/** How long a single feed is given before the fetch is abandoned. */
const FETCH_TIMEOUT_MS = 20_000;

/** How much of a response body is read, so a misconfigured URL cannot exhaust memory. */
const MAX_RESPONSE_CHARACTERS = 4_000_000;

export type FeedRequest = (request: { url: string; method: string; throw: boolean }) => Promise<{
  status: number;
  text: string;
}>;

export interface FeedFetchResult {
  added: number;
  failed: number;
}

export interface FeedSyncStatus {
  state: "disabled" | "idle" | "fetching" | "success" | "error";
  lastFetch?: string;
  error?: string;
  result?: FeedFetchResult;
}

/**
 * Owns feed subscriptions, their triage state, and the timer that refreshes them.
 *
 * The store lives in one JSON file inside the vault so that read state travels with
 * ordinary vault sync rather than with plugin settings, and so that a phone and a
 * desktop agree on what has already been swept.
 */
export class FeedService {
  private store: FeedStoreData = emptyFeedStore();
  private loaded = false;
  /** The store file, merged with other devices' changes on every write and on sync. */
  private readonly file: SyncedJsonFile<FeedStoreData>;
  private status: FeedSyncStatus = { state: "disabled" };
  private listeners = new Set<() => void>();
  private timer: number | null = null;
  private active: Promise<FeedFetchResult> | null = null;
  /** The last sweep, kept in memory only, so Undo costs nothing and never syncs. */
  private lastSweep: FeedItem[] = [];

  constructor(
    private readonly app: App,
    private readonly getSettings: () => FeedSettingsView,
    private readonly request: FeedRequest = requestUrl,
  ) {
    this.file = new SyncedJsonFile(app, {
      path: () => this.storePath(),
      parse: parseFeedStore,
      empty: emptyFeedStore,
      merge: mergeFeedStores,
      current: () => this.store,
      replace: (next) => {
        this.store = next;
        this.notify();
      },
    });
  }

  start(): () => void {
    const watching = this.file.watch();
    void this.load().then(() => {
      this.status = { state: this.getSettings().enabled ? "idle" : "disabled" };
      this.notify();
      this.schedule(5_000);
    });
    return () => {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
      for (const ref of watching) this.app.vault.offref(ref);
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStore(): FeedStoreData {
    return this.store;
  }

  getStatus(): FeedSyncStatus {
    return this.status;
  }

  /** How many Items the last sweep took, and therefore what Undo would put back. */
  undoSize(): number {
    return this.lastSweep.length;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    // No file yet, or one that is no longer readable, gives an empty store: the next fetch rebuilds it.
    this.store = await this.file.load();
    this.notify();
  }

  /**
   * Arms the refresh timer.
   *
   * Each run re-arms itself at the configured interval, so a settings change takes
   * effect on the next tick without a second timer ever being left running.
   */
  schedule(delay = 1_000): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (!this.getSettings().enabled) {
      this.setStatus({ state: "disabled" });
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.fetchAll()
        .catch(() => undefined)
        .finally(() => this.schedule(Math.max(5, this.getSettings().refreshMinutes) * 60_000));
    }, delay);
  }

  // SUBSCRIPTIONS

  async addFeed(url: string, title = ""): Promise<FeedSource> {
    await this.load();
    const normalized = normalizeFeedUrl(url);
    if (!normalized) throw new Error("Enter a feed URL that starts with http:// or https://.");
    const existing = this.store.sources.find((source) => source.url === normalized);
    if (existing) throw new Error(`“${existing.title}” is already subscribed to that URL.`);
    const source: FeedSource = { id: createUlid(), title: title.trim() || normalized, url: normalized, enabled: true };
    this.store = { ...this.store, sources: [...this.store.sources, source] };
    await this.persist();
    // A new feed is fetched immediately so its name and Items appear without waiting for the timer.
    await this.fetchFeed(source).catch(() => undefined);
    return source;
  }

  async updateFeed(feedId: string, changes: Partial<Pick<FeedSource, "title" | "url" | "enabled">>): Promise<void> {
    await this.load();
    const source = findSource(this.store, feedId);
    if (!source) return;
    const url = changes.url === undefined ? source.url : normalizeFeedUrl(changes.url);
    if (!url) throw new Error("Enter a feed URL that starts with http:// or https://.");
    const next: FeedSource = {
      ...source,
      ...(changes.title === undefined ? {} : { title: changes.title.trim() || url }),
      ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
      url,
    };
    this.store = { ...this.store, sources: this.store.sources.map((candidate) => (candidate.id === feedId ? next : candidate)) };
    await this.persist();
  }

  async removeFeed(feedId: string): Promise<void> {
    await this.load();
    const { [feedId]: _removed, ...states } = this.store.states;
    this.store = { ...this.store, sources: this.store.sources.filter((source) => source.id !== feedId), states };
    this.lastSweep = this.lastSweep.filter((item) => item.feedId !== feedId);
    await this.persist();
  }

  // TRIAGE

  /**
   * Resolves Items without keeping them.
   *
   * The whole batch is remembered so one Undo puts a whole sweep back; nothing has
   * been written to the vault, so there is nothing to recover from the trash.
   */
  async discard(keys: readonly string[]): Promise<FeedItem[]> {
    await this.load();
    const resolving = new Set(keys);
    const removed: FeedItem[] = [];
    let store = this.store;
    for (const source of store.sources) {
      const state = feedState(store, source.id);
      const hit = state.unread.filter((item) => resolving.has(item.key));
      if (!hit.length) continue;
      removed.push(...hit);
      store = withFeedState(store, source.id, resolveItems(state, hit.map((item) => item.key)));
    }
    if (!removed.length) return [];
    this.store = store;
    this.lastSweep = removed;
    await this.persist();
    return removed;
  }

  /** Resolves Items after something else has consumed them, leaving Undo alone. */
  async consume(keys: readonly string[]): Promise<void> {
    await this.load();
    let store = this.store;
    for (const source of store.sources) {
      store = withFeedState(store, source.id, resolveItems(feedState(store, source.id), keys));
    }
    this.store = store;
    await this.persist();
  }

  async undoLastSweep(): Promise<number> {
    return this.restore(this.lastSweep);
  }

  /**
   * Puts discarded Items back on the list. Items already back are left alone, so
   * the header's Undo and the Undo notice can both be used on one sweep.
   */
  async restore(items: readonly FeedItem[]): Promise<number> {
    await this.load();
    if (!items.length) return 0;
    const returning = [...items];
    const returned = new Set(returning.map((item) => item.key));
    this.lastSweep = this.lastSweep.filter((item) => !returned.has(item.key));
    let store = this.store;
    for (const source of store.sources) {
      const mine = returning.filter((item) => item.feedId === source.id);
      if (!mine.length) continue;
      store = withFeedState(store, source.id, restoreItems(feedState(store, source.id), mine));
    }
    this.store = store;
    await this.persist();
    return returning.length;
  }

  findItem(key: string): FeedItem | undefined {
    for (const source of this.store.sources) {
      const found = feedState(this.store, source.id).unread.find((item) => item.key === key);
      if (found) return found;
    }
    return undefined;
  }

  // FETCHING

  async fetchAll(): Promise<FeedFetchResult> {
    if (this.active) return this.active;
    await this.load();
    const sources = this.store.sources.filter((source) => source.enabled);
    if (!sources.length) {
      this.setStatus({ state: "idle", lastFetch: new Date().toISOString() });
      return { added: 0, failed: 0 };
    }
    this.setStatus({ ...this.status, state: "fetching" });
    const run = (async () => {
      let added = 0;
      let failed = 0;
      // Sequential on purpose: a handful of feeds is not worth a request burst from one vault.
      for (const source of sources) {
        try {
          added += await this.fetchFeed(source);
        } catch {
          failed += 1;
        }
      }
      const result = { added, failed };
      this.setStatus({
        state: failed && !added ? "error" : "success",
        lastFetch: new Date().toISOString(),
        result,
        ...(failed ? { error: `${failed} feed${failed === 1 ? "" : "s"} could not be fetched.` } : {}),
      });
      return result;
    })().finally(() => {
      this.active = null;
    });
    this.active = run;
    return run;
  }

  /** Fetches one feed and folds it in, returning how many Items were new. */
  async fetchFeed(source: FeedSource): Promise<number> {
    const fetchedAt = new Date().toISOString();
    let body: string;
    try {
      body = await this.read(source.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The feed could not be fetched.";
      this.store = withFeedState(this.store, source.id, withFetchError(this.currentState(source.id), message, fetchedAt));
      await this.persist();
      throw error;
    }
    const parsed = parseFeed(body, source.id);
    const before = this.currentState(source.id);
    // Counted against what the feed already knew rather than by list length, which the unread cap distorts.
    const known = new Set([...before.seen, ...before.unread.map((item) => item.key)]);
    const added = new Set(parsed.items.map((item) => item.key).filter((key) => !known.has(key))).size;
    const merged = mergeFetchedItems(before, parsed.items, fetchedAt);
    this.store = withFeedState(this.store, source.id, merged);
    // A feed still named by its URL takes the name the feed gives itself.
    if (parsed.title && source.title === source.url) {
      this.store = {
        ...this.store,
        sources: this.store.sources.map((candidate) => (candidate.id === source.id ? { ...candidate, title: parsed.title } : candidate)),
      };
    }
    await this.persist();
    return added;
  }

  private currentState(feedId: string): FeedState {
    return this.store.states[feedId] ?? emptyFeedState();
  }

  private async read(url: string): Promise<string> {
    let expiry: number | null = null;
    const response = await Promise.race([
      this.request({ url, method: "GET", throw: false }),
      new Promise<never>((_resolve, reject) => {
        expiry = window.setTimeout(() => reject(new Error("The feed did not respond in time.")), FETCH_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (expiry !== null) window.clearTimeout(expiry);
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The feed returned HTTP ${response.status}.`);
    }
    const text = response.text ?? "";
    if (!text.trim()) throw new Error("The feed returned an empty document.");
    return text.length > MAX_RESPONSE_CHARACTERS ? text.slice(0, MAX_RESPONSE_CHARACTERS) : text;
  }

  // PERSISTENCE

  private storePath(): string {
    const configured = this.getSettings().storePath.trim();
    return normalizePath(configured || "GTD/feeds.json");
  }

  /** Merged with the file first, so a sweep on another device isn't undone by this one's copy. */
  private async persist(): Promise<void> {
    this.notify();
    await this.file.write(this.store);
  }

  private setStatus(status: FeedSyncStatus): void {
    this.status = status;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface FeedSettingsView {
  enabled: boolean;
  storePath: string;
  refreshMinutes: number;
}
