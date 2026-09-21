import { describe, expect, it } from "vitest";
import { escapeVaultText, feedItemAge, feedItemNote, feedItemTitle, feedSweep } from "../src/domain/feed-triage";
import type { FeedItem } from "../src/domain/feed";

const item = (changes: Partial<FeedItem> = {}): FeedItem => ({
  key: "urn:1",
  feedId: "feed-1",
  title: "Heat pumps in old houses",
  link: "https://example.com/heat-pumps",
  published: "2026-09-14T08:30:00.000Z",
  author: "Ada Lovelace",
  summary: "A long look at retrofits.",
  ...changes,
});

describe("The sweep button", () => {
  it("says it will discard everything when nothing is marked", () => {
    expect(feedSweep(0, 40)).toEqual({ keep: 0, discard: 40, label: "Discard all (40)", ready: true });
  });

  it("names both halves once some Items are marked", () => {
    expect(feedSweep(2, 40).label).toBe("Keep 2, discard 38");
  });

  it("says nothing is discarded when every Item is marked", () => {
    expect(feedSweep(3, 3).label).toBe("Keep all (3)");
  });

  it("is not ready with nothing to sweep", () => {
    expect(feedSweep(0, 0)).toEqual({ keep: 0, discard: 0, label: "Nothing to sweep", ready: false });
  });

  it("cannot report more kept than shown", () => {
    expect(feedSweep(9, 3)).toEqual({ keep: 3, discard: 0, label: "Keep all (3)", ready: true });
  });
});

describe("What a kept Item becomes", () => {
  it("leads with the source link and attributes the Item", () => {
    expect(feedItemNote(item(), "Heating Weekly")).toBe(
      "Source: https://example.com/heat-pumps\n"
      + "Heating Weekly · Ada Lovelace · 2026-09-14\n"
      + "\n"
      + "> A long look at retrofits.",
    );
  });

  it("omits the parts an Item does not carry", () => {
    expect(feedItemNote(item({ link: "", author: "", published: "", summary: "" }), "Heating Weekly"))
      .toBe("Heating Weekly");
  });

  it("falls back to a title rather than writing an untitled note", () => {
    expect(feedItemTitle(item({ title: "   " }))).toBe("Untitled Feed Item");
    expect(feedItemTitle(item({ title: " Real title " }))).toBe("Real title");
  });

  it("keeps a feed from writing into the vault graph", () => {
    const hostile = item({ summary: "See [[Replace heating system]] and ![[secret.png]] about #urgent work" });
    const note = feedItemNote(hostile, "Feed");
    expect(note).toContain("\\[\\[Replace heating system\\]\\]");
    expect(note).toContain("!\\[\\[secret.png\\]\\]");
    expect(note).toContain("\\#urgent");
  });
});

describe("Escaping feed text for a note", () => {
  it("neutralises wikilinks, embeds, and tags", () => {
    expect(escapeVaultText("[[A]] ![[B]] #tag")).toBe("\\[\\[A\\]\\] !\\[\\[B\\]\\] \\#tag");
  });

  it("leaves an ordinary hash alone", () => {
    expect(escapeVaultText("issue # 12 and C# too")).toBe("issue # 12 and C# too");
  });

  it("stops a line from becoming a list item or quote", () => {
    expect(escapeVaultText("- one\n1. two\n> three")).toBe("\\- one\n1\\. two\n\\> three");
  });

  it("leaves plain prose untouched", () => {
    expect(escapeVaultText("A long look at retrofits.")).toBe("A long look at retrofits.");
  });
});

describe("How old an Item reads", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");

  it("counts in the largest unit that still means something", () => {
    expect(feedItemAge("2026-09-21T11:59:30.000Z", now)).toBe("just now");
    expect(feedItemAge("2026-09-21T11:30:00.000Z", now)).toBe("30m ago");
    expect(feedItemAge("2026-09-21T06:00:00.000Z", now)).toBe("6h ago");
    expect(feedItemAge("2026-09-18T12:00:00.000Z", now)).toBe("3d ago");
    expect(feedItemAge("2026-09-07T12:00:00.000Z", now)).toBe("2w ago");
  });

  it("gives the date once an Item is old enough that a count stops helping", () => {
    expect(feedItemAge("2026-07-01T12:00:00.000Z", now)).toBe("2026-07-01");
  });

  it("says nothing when the feed gave no usable date", () => {
    expect(feedItemAge("", now)).toBe("");
    expect(feedItemAge("whenever", now)).toBe("");
  });

  it("does not report a future Item as aged", () => {
    expect(feedItemAge("2026-09-22T12:00:00.000Z", now)).toBe("scheduled");
  });
});
