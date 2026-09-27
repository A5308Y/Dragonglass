import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  emptyFeedStore,
  feedState,
  mergeFeedStores,
  parseFeedStore,
  resolveItems,
  restoreItems,
  withFeedState,
  type FeedItem,
  type FeedStoreData,
} from "../src/domain/feed";
import { emptyMailStore, emptyMailboxState, mergeMailStores, openBacklog, recordHandled, withMailboxState } from "../src/domain/mail";
import {
  emptyPomodoroStore,
  finishPomodoro,
  mergePomodoroStores,
  pausePomodoro,
  startPomodoro,
  type PomodoroStore,
} from "../src/domain/pomodoro";
import { SyncedJsonFile } from "../src/state/synced-json-file";

const item = (key: string, published = "2026-09-01T00:00:00.000Z"): FeedItem => ({
  key,
  feedId: "feed-1",
  title: `Item ${key}`,
  link: `https://example.com/${key}`,
  commentsUrl: "",
  published,
  author: "",
  summary: "",
});

const source = { id: "feed-1", title: "Feed", url: "https://example.com/feed.xml", enabled: true };

function feedStore(keys: string[]): FeedStoreData {
  return withFeedState({ ...emptyFeedStore(), sources: [source] }, "feed-1", {
    unread: keys.map((key, index) => item(key, `2026-09-0${index + 1}T00:00:00.000Z`)),
    seen: [],
    fetched: "2026-09-10T00:00:00.000Z",
    error: "",
  });
}

function resolve(store: FeedStoreData, keys: string[]): FeedStoreData {
  return withFeedState(store, "feed-1", resolveItems(feedState(store, "feed-1"), keys));
}

const unreadKeys = (store: FeedStoreData) => feedState(store, "feed-1").unread.map((entry) => entry.key).sort();

describe("Merging the feed store", () => {
  it("keeps Items resolved on either device resolved", () => {
    const base = feedStore(["a", "b", "c"]);
    const phone = resolve(base, ["a"]);
    const mac = resolve(base, ["b"]);
    const merged = mergeFeedStores(base, mac, phone);
    expect(unreadKeys(merged)).toEqual(["c"]);
    expect(feedState(merged, "feed-1").seen.sort()).toEqual(["a", "b"]);
  });

  it("brings back an Item this device restored, even though the other device lists it as resolved", () => {
    const base = resolve(feedStore(["a", "b"]), ["a"]);
    const mine = withFeedState(base, "feed-1", restoreItems(feedState(base, "feed-1"), [item("a", "2026-09-01T00:00:00.000Z")]));
    const theirs = resolve(base, ["b"]);
    const merged = mergeFeedStores(base, mine, theirs);
    expect(unreadKeys(merged)).toEqual(["a"]);
    expect(feedState(merged, "feed-1").seen).toEqual(["b"]);
  });

  it("adds Items the other device fetched and keeps its subscriptions", () => {
    const base = feedStore(["a"]);
    const other = { id: "feed-2", title: "Other", url: "https://example.org/feed.xml", enabled: true };
    const theirs = { ...feedStore(["a", "z"]), sources: [source, other] };
    const merged = mergeFeedStores(base, base, theirs);
    expect(unreadKeys(merged)).toEqual(["a", "z"]);
    expect(merged.sources.map((entry) => entry.id)).toEqual(["feed-1", "feed-2"]);
  });

  it("drops a feed unsubscribed on this device", () => {
    const base = feedStore(["a"]);
    const mine = { ...base, sources: [], states: {} };
    const theirs = resolve(base, ["a"]);
    expect(mergeFeedStores(base, mine, theirs).sources).toEqual([]);
  });
});

describe("Merging the mail store", () => {
  const handled = (uid: number, messageId: string) => [{ uid, messageId }];
  const withState = (state: ReturnType<typeof emptyMailboxState>) => withMailboxState(emptyMailStore(), "acct", "INBOX", state);

  it("keeps both computers' imports and the higher watermark", () => {
    const start = { ...emptyMailboxState(), uidValidity: 7, baselined: true, lastUid: 10 };
    const base = withState(start);
    const mine = withState(recordHandled(start, handled(12, "<m@x>"), { fetchedAt: "2026-09-10T00:00:00.000Z" }));
    const theirs = withState(recordHandled(start, handled(11, "<t@x>"), { fetchedAt: "2026-09-09T00:00:00.000Z" }));
    const state = mergeMailStores(base, mine, theirs).states["acct:INBOX"]!;
    expect(state.lastUid).toBe(12);
    expect(state.seen.sort()).toEqual(["<m@x>", "<t@x>"]);
  });

  it("lets a backlog reopened on this computer win over the other's watermark", () => {
    const start = recordHandled({ ...emptyMailboxState(), uidValidity: 7, baselined: true }, handled(10, "<old@x>"), { fetchedAt: "2026-09-01T00:00:00.000Z" });
    const base = withState(start);
    const mine = withState(openBacklog(start));
    const theirs = withState(recordHandled(start, handled(11, "<new@x>"), { fetchedAt: "2026-09-09T00:00:00.000Z" }));
    const state = mergeMailStores(base, mine, theirs).states["acct:INBOX"]!;
    expect(state.lastUid).toBe(0);
    expect(state.seen).toEqual(["<new@x>"]);
  });
});

describe("Merging the Pomodoro log", () => {
  const start = (id: string, at: string, store: PomodoroStore = emptyPomodoroStore()) =>
    startPomodoro(store, { id, projectId: "p", projectTitle: "P", projectPath: "P.md", intention: "Write", focusActionIds: [], plannedMinutes: 25 }, new Date(at));
  const wrapUp = { outcome: null, reflection: "" };

  it("keeps sessions filed on both devices", () => {
    const base = emptyPomodoroStore();
    const mine = finishPomodoro(start("one", "2026-09-10T08:00:00Z"), wrapUp, new Date("2026-09-10T08:25:00Z"));
    const theirs = finishPomodoro(start("two", "2026-09-10T09:00:00Z"), wrapUp, new Date("2026-09-10T09:25:00Z"));
    expect(mergePomodoroStores(base, mine, theirs).sessions.map((session) => session.id)).toEqual(["two", "one"]);
  });

  it("drops a running session another device has already filed", () => {
    const base = start("one", "2026-09-10T08:00:00Z");
    const mine = pausePomodoro(base, new Date("2026-09-10T08:10:00Z"));
    const theirs = finishPomodoro(base, wrapUp, new Date("2026-09-10T08:25:00Z"));
    const merged = mergePomodoroStores(base, mine, theirs);
    expect(merged.active).toBeNull();
    expect(merged.sessions.map((session) => session.id)).toEqual(["one"]);
  });

  it("keeps the time-tracking links both devices recorded", () => {
    const base = finishPomodoro(start("one", "2026-09-10T08:00:00Z"), wrapUp, new Date("2026-09-10T08:25:00Z"));
    const link = (integration: string) => ({
      ...base,
      sessions: [{ ...base.sessions[0]!, external: { [integration]: { id: integration, syncedAt: "2026-09-10T09:00:00Z" } } }],
    });
    const merged = mergePomodoroStores(base, link("toggl"), link("clockify"));
    expect(Object.keys(merged.sessions[0]!.external).sort()).toEqual(["clockify", "toggl"]);
  });
});

describe("A store file written by two devices", () => {
  function device(files: Map<string, string>) {
    let store = emptyFeedStore();
    const app = {
      vault: {
        adapter: {
          read: async (path: string) => {
            const value = files.get(path);
            if (value === undefined) throw new Error("no such file");
            return value;
          },
          write: async (path: string, data: string) => void files.set(path, data),
          exists: async () => true,
          mkdir: async () => undefined,
        },
      },
    } as unknown as App;
    const file = new SyncedJsonFile(app, {
      path: () => "GTD/feeds.json",
      parse: parseFeedStore,
      empty: emptyFeedStore,
      merge: mergeFeedStores,
      current: () => store,
      replace: (next) => {
        store = next;
      },
    });
    return {
      file,
      get store() {
        return store;
      },
      set store(next: FeedStoreData) {
        store = next;
      },
    };
  }

  it("keeps both devices' sweeps, and each device sees the other's after its next write or reload", async () => {
    const files = new Map([["GTD/feeds.json", JSON.stringify(feedStore(["a", "b", "c"]))]]);
    const phone = device(files);
    const mac = device(files);
    phone.store = await phone.file.load();
    mac.store = await mac.file.load();

    phone.store = resolve(phone.store, ["a"]);
    await phone.file.write(phone.store);
    mac.store = resolve(mac.store, ["b"]);
    await mac.file.write(mac.store);

    expect(unreadKeys(parseFeedStore(JSON.parse(files.get("GTD/feeds.json")!)))).toEqual(["c"]);
    expect(unreadKeys(mac.store)).toEqual(["c"]);
    await phone.file.reload();
    expect(unreadKeys(phone.store)).toEqual(["c"]);
  });

  it("writes this device's copy when the file is half-written", async () => {
    const files = new Map([["GTD/feeds.json", JSON.stringify(feedStore(["a", "b"]))]]);
    const phone = device(files);
    phone.store = await phone.file.load();
    files.set("GTD/feeds.json", "{\"version\": 1, \"sour");
    phone.store = resolve(phone.store, ["a"]);
    await phone.file.write(phone.store);
    expect(unreadKeys(parseFeedStore(JSON.parse(files.get("GTD/feeds.json")!)))).toEqual(["b"]);
  });
});
