/**
 * Feed subscriptions and the triage state behind the Feeds surface.
 *
 * Feed Items are not GTD entities and never become vault files on their own. Keeping
 * one promotes it to an Inbox Item, and from there it is an ordinary capture. Until
 * then an Item is a row in this store, which is why discarding a whole feed is one
 * cheap write that can be undone rather than a hundred files sent to the trash.
 */

export const FEED_STORE_VERSION = 1;

/** How many resolved keys a feed remembers, so discarded Items cannot come back. */
export const SEEN_KEY_LIMIT = 800;

/** How many unread Items one feed holds before the oldest are dropped. */
export const UNREAD_ITEM_LIMIT = 300;

export interface FeedSource {
  /** A ULID, so renaming a feed or correcting its URL keeps its triage state. */
  id: string;
  title: string;
  url: string;
  enabled: boolean;
}

export interface FeedItem {
  /** Identity within one feed: its guid, id, link, or a digest of what it does carry. */
  key: string;
  feedId: string;
  title: string;
  /** An `http`/`https` URL, or `""` when the feed offered nothing safe to open. */
  link: string;
  /** RFC 3339, or `""` when the feed omitted a usable date. */
  published: string;
  author: string;
  /** Plain text. Feed markup is flattened before it is stored. */
  summary: string;
}

export interface FeedState {
  /** Items fetched and not yet kept or discarded, newest first. */
  unread: FeedItem[];
  /** Keys already resolved, oldest first, capped at `SEEN_KEY_LIMIT`. */
  seen: string[];
  /** When the last fetch finished, whether or not it succeeded. */
  fetched: string;
  /** Why the last fetch failed, or `""`. */
  error: string;
}

export interface FeedStoreData {
  version: number;
  sources: FeedSource[];
  states: Record<string, FeedState>;
}

export function emptyFeedState(): FeedState {
  return { unread: [], seen: [], fetched: "", error: "" };
}

export function emptyFeedStore(): FeedStoreData {
  return { version: FEED_STORE_VERSION, sources: [], states: {} };
}

/**
 * Reads a store file without trusting it.
 *
 * The file syncs between devices and is hand-editable, so anything malformed is
 * dropped rather than allowed to break the view. A store that cannot be read at all
 * costs only unread Items, which the next fetch restores.
 */
export function parseFeedStore(raw: unknown): FeedStoreData {
  if (!isRecord(raw)) return emptyFeedStore();
  const sources = Array.isArray(raw.sources) ? raw.sources.flatMap(parseSource) : [];
  const known = new Set(sources.map((source) => source.id));
  const states: Record<string, FeedState> = {};
  if (isRecord(raw.states)) {
    for (const [feedId, value] of Object.entries(raw.states)) {
      // State for a removed feed is dead weight, and keeping it would resurrect nothing.
      if (known.has(feedId)) states[feedId] = parseState(feedId, value);
    }
  }
  return { version: FEED_STORE_VERSION, sources, states };
}

export function feedState(store: FeedStoreData, feedId: string): FeedState {
  return store.states[feedId] ?? emptyFeedState();
}

/** Every unread Item across the store, newest first, with unknown feeds excluded. */
export function unreadItems(store: FeedStoreData): FeedItem[] {
  return store.sources
    .flatMap((source) => feedState(store, source.id).unread)
    .sort(byNewestFirst);
}

/**
 * Folds a fetch into a feed's state.
 *
 * An Item already resolved stays resolved, so a feed that keeps serving the same
 * window does not refill a list you have swept. Items already unread keep their
 * position rather than being replaced, because a rewritten title mid-triage is a
 * worse outcome than a slightly stale one.
 */
export function mergeFetchedItems(state: FeedState, fetched: readonly FeedItem[], fetchedAt: string): FeedState {
  const resolved = new Set(state.seen);
  const present = new Set(state.unread.map((item) => item.key));
  const added: FeedItem[] = [];
  for (const item of fetched) {
    if (resolved.has(item.key) || present.has(item.key)) continue;
    present.add(item.key);
    added.push(item);
  }
  return {
    unread: [...added, ...state.unread].sort(byNewestFirst).slice(0, UNREAD_ITEM_LIMIT),
    seen: state.seen,
    fetched: fetchedAt,
    error: "",
  };
}

/** Moves Items out of the unread list and records their keys so a refetch skips them. */
export function resolveItems(state: FeedState, keys: readonly string[]): FeedState {
  const resolving = new Set(keys);
  if (!resolving.size) return state;
  const removed = state.unread.filter((item) => resolving.has(item.key));
  if (!removed.length) return state;
  return {
    ...state,
    unread: state.unread.filter((item) => !resolving.has(item.key)),
    seen: capSeen([...state.seen, ...removed.map((item) => item.key)]),
  };
}

/** Puts swept Items back, which is what Undo does. */
export function restoreItems(state: FeedState, items: readonly FeedItem[]): FeedState {
  if (!items.length) return state;
  const returning = new Set(items.map((item) => item.key));
  const present = new Set(state.unread.map((item) => item.key));
  return {
    ...state,
    unread: [...items.filter((item) => !present.has(item.key)), ...state.unread].sort(byNewestFirst),
    seen: state.seen.filter((key) => !returning.has(key)),
  };
}

export function withFeedState(store: FeedStoreData, feedId: string, next: FeedState): FeedStoreData {
  return { ...store, states: { ...store.states, [feedId]: next } };
}

export function withFetchError(state: FeedState, message: string, fetchedAt: string): FeedState {
  return { ...state, fetched: fetchedAt, error: message };
}

/**
 * The URL a feed is subscribed by.
 *
 * Only `http` and `https` are subscribable: a feed URL is fetched automatically on a
 * timer, so anything else is a way to make the plugin open something on its own.
 */
export function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function findSource(store: FeedStoreData, feedId: string): FeedSource | undefined {
  return store.sources.find((source) => source.id === feedId);
}

/** Newest first, with undated Items last rather than pretending they are old. */
function byNewestFirst(left: FeedItem, right: FeedItem): number {
  if (left.published === right.published) return left.key < right.key ? -1 : 1;
  if (!left.published) return 1;
  if (!right.published) return -1;
  return left.published < right.published ? 1 : -1;
}

function capSeen(keys: string[]): string[] {
  const unique = [...new Set(keys)];
  return unique.length > SEEN_KEY_LIMIT ? unique.slice(unique.length - SEEN_KEY_LIMIT) : unique;
}

function parseSource(raw: unknown): FeedSource[] {
  if (!isRecord(raw)) return [];
  const id = text(raw.id);
  const url = normalizeFeedUrl(text(raw.url));
  if (!id || !url) return [];
  return [{ id, title: text(raw.title) || url, url, enabled: raw.enabled !== false }];
}

function parseState(feedId: string, raw: unknown): FeedState {
  if (!isRecord(raw)) return emptyFeedState();
  const unread = Array.isArray(raw.unread) ? raw.unread.flatMap((item) => parseItem(feedId, item)) : [];
  const seen = Array.isArray(raw.seen) ? raw.seen.filter((key): key is string => typeof key === "string") : [];
  return {
    unread: unread.slice(0, UNREAD_ITEM_LIMIT),
    seen: capSeen(seen),
    fetched: text(raw.fetched),
    error: text(raw.error),
  };
}

function parseItem(feedId: string, raw: unknown): FeedItem[] {
  if (!isRecord(raw)) return [];
  const key = text(raw.key);
  if (!key) return [];
  return [{
    key,
    feedId,
    title: text(raw.title),
    link: text(raw.link),
    published: text(raw.published),
    author: text(raw.author),
    summary: text(raw.summary),
  }];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
