import { describe, expect, it } from "vitest";
import {
  emptyFeedState,
  emptyFeedStore,
  feedState,
  mergeFetchedItems,
  normalizeFeedUrl,
  parseFeedStore,
  resolveItems,
  restoreItems,
  SEEN_KEY_LIMIT,
  UNREAD_ITEM_LIMIT,
  unreadItems,
  withFeedState,
  type FeedItem,
  type FeedState,
} from "../src/domain/feed";

const item = (key: string, published = "2026-09-01T00:00:00.000Z", feedId = "feed-1"): FeedItem => ({
  key,
  feedId,
  title: `Item ${key}`,
  link: `https://example.com/${key}`,
  commentsUrl: "",
  published,
  author: "",
  summary: "",
});

const stateWith = (changes: Partial<FeedState> = {}): FeedState => ({ ...emptyFeedState(), ...changes });

describe("Folding a fetch into a feed", () => {
  it("adds Items that are new", () => {
    const merged = mergeFetchedItems(emptyFeedState(), [item("a"), item("b")], "2026-09-02T00:00:00.000Z");
    expect(merged.unread.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(merged.fetched).toBe("2026-09-02T00:00:00.000Z");
  });

  it("does not refill Items that were already resolved", () => {
    const merged = mergeFetchedItems(stateWith({ seen: ["a"] }), [item("a"), item("b")], "now");
    expect(merged.unread.map((entry) => entry.key)).toEqual(["b"]);
  });

  it("keeps the copy already on the list rather than replacing it mid-triage", () => {
    const existing = { ...item("a"), title: "As first seen" };
    const merged = mergeFetchedItems(stateWith({ unread: [existing] }), [{ ...item("a"), title: "Rewritten" }], "now");
    expect(merged.unread).toHaveLength(1);
    expect(merged.unread[0]?.title).toBe("As first seen");
  });

  it("backfills a field a feed only started sending after an Item first arrived", () => {
    const existing = { ...item("a"), commentsUrl: "" };
    const refetched = { ...item("a"), commentsUrl: "https://news.ycombinator.com/item?id=1" };
    const merged = mergeFetchedItems(stateWith({ unread: [existing] }), [refetched], "now");
    expect(merged.unread).toHaveLength(1);
    expect(merged.unread[0]?.commentsUrl).toBe("https://news.ycombinator.com/item?id=1");
  });

  it("does not let a refetch erase a comments link the cached copy already has", () => {
    const existing = { ...item("a"), commentsUrl: "https://example.com/thread" };
    const merged = mergeFetchedItems(stateWith({ unread: [existing] }), [{ ...item("a"), commentsUrl: "" }], "now");
    expect(merged.unread[0]?.commentsUrl).toBe("https://example.com/thread");
  });

  it("orders newest first and puts undated Items last", () => {
    const merged = mergeFetchedItems(
      emptyFeedState(),
      [item("old", "2026-01-01T00:00:00.000Z"), item("undated", ""), item("new", "2026-09-01T00:00:00.000Z")],
      "now",
    );
    expect(merged.unread.map((entry) => entry.key)).toEqual(["new", "old", "undated"]);
  });

  it("clears a previous error once a fetch succeeds", () => {
    expect(mergeFetchedItems(stateWith({ error: "boom" }), [], "now").error).toBe("");
  });

  it("caps how many unread Items one feed holds", () => {
    const many = Array.from({ length: UNREAD_ITEM_LIMIT + 50 }, (_unused, index) =>
      item(`k${index}`, new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString()));
    expect(mergeFetchedItems(emptyFeedState(), many, "now").unread).toHaveLength(UNREAD_ITEM_LIMIT);
  });
});

describe("Resolving Items", () => {
  it("moves them off the list and remembers their keys", () => {
    const resolved = resolveItems(stateWith({ unread: [item("a"), item("b")] }), ["a"]);
    expect(resolved.unread.map((entry) => entry.key)).toEqual(["b"]);
    expect(resolved.seen).toEqual(["a"]);
  });

  it("leaves the state untouched when nothing matches", () => {
    const before = stateWith({ unread: [item("a")] });
    expect(resolveItems(before, ["missing"])).toBe(before);
    expect(resolveItems(before, [])).toBe(before);
  });

  it("caps remembered keys, dropping the oldest", () => {
    const seen = Array.from({ length: SEEN_KEY_LIMIT }, (_unused, index) => `old-${index}`);
    const resolved = resolveItems(stateWith({ unread: [item("fresh")], seen }), ["fresh"]);
    expect(resolved.seen).toHaveLength(SEEN_KEY_LIMIT);
    expect(resolved.seen).not.toContain("old-0");
    expect(resolved.seen.at(-1)).toBe("fresh");
  });
});

describe("Undoing a sweep", () => {
  it("puts Items back and forgets that they were resolved", () => {
    const swept = resolveItems(stateWith({ unread: [item("a"), item("b")] }), ["a", "b"]);
    const restored = restoreItems(swept, [item("a"), item("b")]);
    expect(restored.unread.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(restored.seen).toEqual([]);
  });

  it("does not duplicate an Item a later fetch already put back", () => {
    const restored = restoreItems(stateWith({ unread: [item("a")] }), [item("a")]);
    expect(restored.unread).toHaveLength(1);
  });
});

describe("Reading a store file", () => {
  it("returns an empty store for anything that is not one", () => {
    for (const raw of [null, 42, "text", [], undefined]) expect(parseFeedStore(raw)).toEqual(emptyFeedStore());
  });

  it("drops sources with no id or an unusable URL", () => {
    const store = parseFeedStore({
      sources: [
        { id: "a", url: "https://example.com/feed.xml", title: "Good" },
        { id: "", url: "https://example.com/other.xml" },
        { id: "c", url: "javascript:alert(1)" },
        "nonsense",
      ],
    });
    expect(store.sources.map((source) => source.id)).toEqual(["a"]);
  });

  it("names a source by its URL when the file gives no title", () => {
    const store = parseFeedStore({ sources: [{ id: "a", url: "https://example.com/feed.xml" }] });
    expect(store.sources[0]?.title).toBe("https://example.com/feed.xml");
  });

  it("discards state belonging to a feed that is no longer subscribed", () => {
    const store = parseFeedStore({
      sources: [{ id: "a", url: "https://example.com/a.xml" }],
      states: { a: { unread: [item("x")], seen: ["y"] }, gone: { unread: [item("z")], seen: [] } },
    });
    expect(Object.keys(store.states)).toEqual(["a"]);
    expect(store.states.a?.unread.map((entry) => entry.key)).toEqual(["x"]);
  });

  it("drops malformed Items rather than the whole feed", () => {
    const store = parseFeedStore({
      sources: [{ id: "a", url: "https://example.com/a.xml" }],
      states: { a: { unread: [item("x"), { title: "no key" }, 7], seen: ["k", 9] } },
    });
    expect(store.states.a?.unread.map((entry) => entry.key)).toEqual(["x"]);
    expect(store.states.a?.seen).toEqual(["k"]);
  });
});

describe("Store queries", () => {
  it("collects unread Items across feeds, newest first", () => {
    let store = emptyFeedStore();
    store = {
      ...store,
      sources: [
        { id: "feed-1", title: "One", url: "https://example.com/1.xml", enabled: true },
        { id: "feed-2", title: "Two", url: "https://example.com/2.xml", enabled: true },
      ],
    };
    store = withFeedState(store, "feed-1", stateWith({ unread: [item("a", "2026-01-01T00:00:00.000Z")] }));
    store = withFeedState(store, "feed-2", stateWith({ unread: [item("b", "2026-09-01T00:00:00.000Z", "feed-2")] }));
    expect(unreadItems(store).map((entry) => entry.key)).toEqual(["b", "a"]);
  });

  it("reports an empty state for a feed that has never been fetched", () => {
    expect(feedState(emptyFeedStore(), "missing")).toEqual(emptyFeedState());
  });
});

describe("Feed URLs", () => {
  it("assumes https when a bare host is typed", () => {
    expect(normalizeFeedUrl("example.com/feed.xml")).toBe("https://example.com/feed.xml");
  });

  it("keeps http and https as given", () => {
    expect(normalizeFeedUrl("http://example.com/feed.xml")).toBe("http://example.com/feed.xml");
  });

  it("refuses schemes that would let a subscription run something on a timer", () => {
    for (const hostile of ["javascript:alert(1)", "file:///etc/passwd", "obsidian://open?x=1"]) {
      expect(normalizeFeedUrl(hostile)).toBe("");
    }
    expect(normalizeFeedUrl("   ")).toBe("");
  });
});
