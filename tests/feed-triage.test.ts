import { describe, expect, it } from "vitest";
import { feedItemAge, feedItemNote, feedItemTitle, readingActionTitle } from "../src/domain/feed-triage";
import { plainTitle } from "../src/domain/text";
import { escapeVaultText } from "../src/domain/text";
import type { FeedItem } from "../src/domain/feed";

const item = (changes: Partial<FeedItem> = {}): FeedItem => ({
  key: "urn:1",
  feedId: "feed-1",
  title: "Heat pumps in old houses",
  link: "https://example.com/heat-pumps",
  commentsUrl: "",
  published: "2026-09-14T08:30:00.000Z",
  author: "Ada Lovelace",
  summary: "A long look at retrofits.",
  ...changes,
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

  it("records the discussion link separately from the source, right after it", () => {
    expect(feedItemNote(item({ commentsUrl: "https://news.ycombinator.com/item?id=1" }), "Hacker News")).toBe(
      "Source: https://example.com/heat-pumps\n"
      + "Comments: https://news.ycombinator.com/item?id=1\n"
      + "Hacker News · Ada Lovelace · 2026-09-14\n"
      + "\n"
      + "> A long look at retrofits.",
    );
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

describe("A reading Action made from an Item", () => {
  const source = { title: "Why [brackets] (and parens) matter", link: "https://example.com/post", commentsUrl: "https://news.example.com/item?id=1" };

  it("links the article, or its comments, from a title the board shows as a link", () => {
    expect(readingActionTitle(source, false)).toBe("Read [Why brackets and parens matter](https://example.com/post)");
    expect(readingActionTitle(source, true)).toBe("Read the comments on [Why brackets and parens matter](https://news.example.com/item?id=1)");
  });

  it("makes none without a web address", () => {
    expect(readingActionTitle({ ...source, commentsUrl: "" }, true)).toBeNull();
    expect(readingActionTitle({ ...source, link: "javascript:alert(1)" }, false)).toBeNull();
  });

  it("names the Action's file after the text, not the address", () => {
    expect(plainTitle("Read [Why it matters](https://example.com/post)")).toBe("Read Why it matters");
    expect(plainTitle("Call [[People/Mar|Mar]] about [[Quotes]]")).toBe("Call Mar about Quotes");
    expect(plainTitle("Plain title")).toBe("Plain title");
  });
});
