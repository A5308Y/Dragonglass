import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/domain/html-markdown";

describe("mail HTML as Markdown", () => {
  it("keeps paragraphs, line breaks, headings and emphasis", () => {
    expect(htmlToMarkdown("<h2>Your  order</h2><p>Hello <b>Ada</b>,<br>thanks for <i>ordering</i>.</p><p>Bye</p>"))
      .toBe("## Your order\n\nHello **Ada**,\nthanks for *ordering*.\n\nBye");
  });

  it("keeps lists, nested lists and paragraphs inside items", () => {
    expect(htmlToMarkdown("<ol><li><p>First</p></li><li>Second<ul><li>Inner</li></ul></li></ol><p>After</p>"))
      .toBe("1. First\n2. Second\n    - Inner\n\nAfter");
  });

  it("keeps web and mail links, and drops every other scheme", () => {
    expect(htmlToMarkdown('<a href="https://example.com/a b">Shop</a> <a href="mailto:ada@example.com">Mail</a>'))
      .toBe("[Shop](https://example.com/a%20b) [Mail](mailto:ada@example.com)");
    expect(htmlToMarkdown('<a href="javascript:alert(1)">Click</a> <a href="file:///etc/passwd">File</a>'))
      .toBe("Click File");
  });

  it("quotes blockquotes", () => {
    expect(htmlToMarkdown("<p>Reply</p><blockquote><p>Original</p><p>Second</p></blockquote>"))
      .toBe("Reply\n\n> Original\n>\n> Second");
  });

  it("drops scripts, styles, comments, hidden text and images, keeping image descriptions", () => {
    const html = `<!DOCTYPE html><html><head><title>T</title><style>p{}</style></head><body>
      <div style="display: none">Preheader</div><!-- note -->
      <script>alert(1)</script><img src="https://track.example/p.gif"><img src="x.png" alt="Logo">
      <p>Text</p></body></html>`;
    expect(htmlToMarkdown(html)).toBe("\\[image: Logo\\]\n\nText");
  });

  it("escapes everything in the text that Markdown or Obsidian would read as syntax", () => {
    const text = htmlToMarkdown("<p>[[Heating]] #urgent $5 %%x%% ==hi== &lt;img src=x&gt; ![a](b) *b* _i_ `c` a|b ~~s~~</p><p>- not a list</p><p>1. nor this</p>");
    expect(text).toBe(
      "\\[\\[Heating\\]\\] \\#urgent \\$5 \\%\\%x\\%\\% \\=\\=hi\\=\\= \\<img src\\=x\\> !\\[a\\](b) \\*b\\* \\_i\\_ \\`c\\` a\\|b \\~\\~s\\~\\~"
        + "\n\n\\- not a list\n\n1\\. nor this",
    );
  });

  it("keeps preformatted line breaks", () => {
    expect(htmlToMarkdown("<pre>line one\n  line two</pre>")).toBe("line one\n  line two");
  });
});
