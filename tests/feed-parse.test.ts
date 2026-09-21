import { describe, expect, it } from "vitest";
import { htmlToText, itemKey, parseFeed, publishedAt, safeLink, SUMMARY_LIMIT } from "../src/domain/feed-parse";
import { childText, decodeEntities, parseXml } from "../src/domain/feed-xml";

describe("XML reading", () => {
  it("reads nested elements, attributes, and namespaced names", () => {
    const root = parseXml('<rss version="2.0"><channel><dc:creator>Ada</dc:creator></channel></rss>');
    expect(root?.name).toBe("rss");
    expect(root?.attributes.version).toBe("2.0");
    expect(childText(root?.children[0] ?? null, "creator")).toBe("Ada");
  });

  it("keeps CDATA verbatim rather than resolving it as entities", () => {
    const root = parseXml("<title><![CDATA[Tom & Jerry <b>win</b>]]></title>");
    expect(root?.text).toBe("Tom & Jerry <b>win</b>");
  });

  it("does not end a tag at a > inside a quoted attribute", () => {
    const root = parseXml('<link href="https://example.com/?a=1&gt;2" rel="alternate"/>');
    expect(root?.attributes.href).toBe("https://example.com/?a=1>2");
    expect(root?.attributes.rel).toBe("alternate");
  });

  it("skips comments, declarations, and doctypes", () => {
    const root = parseXml('<?xml version="1.0"?><!DOCTYPE feed><!-- note --><feed><id>x</id></feed>');
    expect(root?.name).toBe("feed");
    expect(childText(root, "id")).toBe("x");
  });

  it("survives a stray end tag instead of unwinding the document", () => {
    const root = parseXml("<rss><channel><item><title>A</title></wrong></item></channel></rss>");
    expect(root?.name).toBe("rss");
    expect(parseFeed("<rss><channel><item><title>A</title></wrong></item></channel></rss>", "f").items).toHaveLength(1);
  });

  it("returns nothing for a document with no element", () => {
    expect(parseXml("   ")).toBeNull();
    expect(parseFeed("not xml at all", "f")).toEqual({ title: "", items: [] });
  });

  it("resolves numeric and named entities and leaves unknown ones alone", () => {
    expect(decodeEntities("a &amp; b &#65; &#x42; &nbsp;c &bogus;")).toBe("a & b A B  c &bogus;");
  });
});

describe("RSS feeds", () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel>
        <title>Heating Weekly</title>
        <item>
          <title>Heat pumps in old houses</title>
          <link>https://example.com/heat-pumps</link>
          <guid isPermaLink="false">tag:example.com,2026:1</guid>
          <pubDate>Mon, 14 Sep 2026 08:30:00 GMT</pubDate>
          <dc:creator>Ada Lovelace</dc:creator>
          <description><![CDATA[<p>A <b>long</b> look at retrofits.</p>]]></description>
        </item>
      </channel>
    </rss>`;

  it("reads the channel title and its items", () => {
    const parsed = parseFeed(rss, "feed-1");
    expect(parsed.title).toBe("Heating Weekly");
    expect(parsed.items).toHaveLength(1);
  });

  it("maps every field an item carries", () => {
    const [item] = parseFeed(rss, "feed-1").items;
    expect(item).toEqual({
      key: "tag:example.com,2026:1",
      feedId: "feed-1",
      title: "Heat pumps in old houses",
      link: "https://example.com/heat-pumps",
      commentsUrl: "",
      published: "2026-09-14T08:30:00.000Z",
      author: "Ada Lovelace",
      summary: "A long look at retrofits.",
    });
  });

  it("reads the discussion link Hacker News and similar feeds carry separately from the article", () => {
    const hackerNews = `<rss><channel><item>
      <title>Show HN: Dragonglass</title>
      <link>https://example.com/dragonglass</link>
      <comments>https://news.ycombinator.com/item?id=1</comments>
      <description>&lt;a href="https://news.ycombinator.com/item?id=1"&gt;Comments&lt;/a&gt;</description>
    </item></channel></rss>`;
    const [item] = parseFeed(hackerNews, "hn").items;
    expect(item?.link).toBe("https://example.com/dragonglass");
    expect(item?.commentsUrl).toBe("https://news.ycombinator.com/item?id=1");
  });

  it("drops a hostile comments link the same as any other", () => {
    const hostile = `<rss><channel><item><title>A</title><comments>javascript:alert(1)</comments></item></channel></rss>`;
    expect(parseFeed(hostile, "f").items[0]?.commentsUrl).toBe("");
  });

  it("reads RSS 1.0 items that sit beside the channel rather than inside it", () => {
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <channel><title>Old School</title></channel>
      <item><title>One</title><link>https://example.com/one</link></item>
      <item><title>Two</title><link>https://example.com/two</link></item>
    </rdf:RDF>`;
    const parsed = parseFeed(rdf, "feed-1");
    expect(parsed.title).toBe("Old School");
    expect(parsed.items.map((item) => item.title)).toEqual(["One", "Two"]);
  });

  it("does not treat a non-permalink guid as a link", () => {
    const noLink = `<rss><channel><item>
      <title>A</title><guid isPermaLink="false">urn:uuid:1</guid>
    </item></channel></rss>`;
    expect(parseFeed(noLink, "f").items[0]?.link).toBe("");
  });
});

describe("Atom feeds", () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <title>Dragon Notes</title>
    <entry>
      <title>Obsidian plugins</title>
      <id>urn:uuid:9</id>
      <link rel="edit" href="https://example.com/edit/9"/>
      <link rel="alternate" href="https://example.com/posts/9"/>
      <published>2026-09-01T10:00:00Z</published>
      <author><name>Grace</name></author>
      <summary>Short and to the point.</summary>
    </entry>
  </feed>`;

  it("prefers the alternate link over other relations", () => {
    const [item] = parseFeed(atom, "feed-2").items;
    expect(item?.link).toBe("https://example.com/posts/9");
    expect(item?.key).toBe("urn:uuid:9");
    expect(item?.author).toBe("Grace");
    expect(item?.published).toBe("2026-09-01T10:00:00.000Z");
  });

  it("reads the Atom Threading Extension's rel=\"replies\" link as the discussion page", () => {
    const withReplies = `<feed><entry>
      <title>A</title><id>1</id>
      <link rel="alternate" href="https://example.com/a"/>
      <link rel="replies" href="https://example.com/a/comments"/>
    </entry></feed>`;
    const [item] = parseFeed(withReplies, "f").items;
    expect(item?.link).toBe("https://example.com/a");
    expect(item?.commentsUrl).toBe("https://example.com/a/comments");
  });

  it("falls back to updated when an entry has no published date", () => {
    const updated = `<feed><entry><title>A</title><id>1</id><updated>2026-08-02T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(updated, "f").items[0]?.published).toBe("2026-08-02T00:00:00.000Z");
  });
});

describe("Item identity", () => {
  it("prefers a guid, then a link", () => {
    expect(itemKey("urn:1", "https://example.com/a", "A", "")).toBe("urn:1");
    expect(itemKey("", "https://example.com/a", "A", "")).toBe("https://example.com/a");
  });

  it("digests the title and date when a feed offers neither", () => {
    const key = itemKey("", "", "A headline", "2026-09-01");
    expect(key).toMatch(/^dg:[a-z0-9]+$/);
    expect(itemKey("", "", "A headline", "2026-09-01")).toBe(key);
    expect(itemKey("", "", "A headline", "2026-09-02")).not.toBe(key);
  });
});

describe("Link safety", () => {
  it("accepts http and https", () => {
    expect(safeLink("https://example.com/a")).toBe("https://example.com/a");
    expect(safeLink(" http://example.com/b ")).toBe("http://example.com/b");
  });

  it("drops every other scheme, so a feed cannot choose what a click runs", () => {
    for (const hostile of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>", "obsidian://open"]) {
      expect(safeLink(hostile)).toBe("");
    }
  });

  it("drops a hostile link during parsing rather than storing it", () => {
    const feed = `<rss><channel><item><title>A</title><link>javascript:alert(1)</link></item></channel></rss>`;
    expect(parseFeed(feed, "f").items[0]?.link).toBe("");
  });
});

describe("Flattening feed markup", () => {
  it("removes tags and collapses whitespace", () => {
    expect(htmlToText("<p>One</p>\n<p>Two   three</p>")).toBe("One Two three");
  });

  it("drops scripts and styles entirely, including an unterminated one", () => {
    expect(htmlToText("<script>alert(1)</script>Safe")).toBe("Safe");
    expect(htmlToText("Safe<style>body{}")).toBe("Safe");
  });

  it("does not let an escaped tag reappear as one", () => {
    // The XML reader resolves the entities first, so this is the second pass.
    expect(htmlToText("&lt;img src=x onerror=alert(1)&gt;caption")).toBe("<img src=x onerror=alert(1)>caption");
    expect(htmlToText(htmlToText("&lt;img src=x onerror=alert(1)&gt;caption"))).toBe("caption");
  });

  it("truncates a long summary", () => {
    const long = `<rss><channel><item><title>A</title><description>${"x".repeat(SUMMARY_LIMIT + 200)}</description></item></channel></rss>`;
    const summary = parseFeed(long, "f").items[0]?.summary ?? "";
    expect(summary).toHaveLength(SUMMARY_LIMIT + 1);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("Publication dates", () => {
  it("normalises RFC 822 and ISO dates to RFC 3339", () => {
    expect(publishedAt("Mon, 14 Sep 2026 08:30:00 GMT")).toBe("2026-09-14T08:30:00.000Z");
    expect(publishedAt("2026-09-14T08:30:00Z")).toBe("2026-09-14T08:30:00.000Z");
  });

  it("gives up rather than inventing a date", () => {
    expect(publishedAt("")).toBe("");
    expect(publishedAt("last Tuesday-ish")).toBe("");
  });
});
