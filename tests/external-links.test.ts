import { describe, expect, it } from "vitest";
import { formatExternalLink, parseExternalLink } from "../src/domain/external-links";

describe("external links", () => {
  it("reads Markdown links and bare URLs", () => {
    expect(parseExternalLink("[Lease portal](https://example.com/lease)"))
      .toEqual({ entry: "[Lease portal](https://example.com/lease)", url: "https://example.com/lease", title: "Lease portal" });
    expect(parseExternalLink(" https://example.com/ "))
      .toEqual({ entry: "https://example.com/", url: "https://example.com/", title: "https://example.com/" });
  });

  it("leaves out anything that is not an http or https link", () => {
    expect(parseExternalLink("javascript:alert(1)")).toBeUndefined();
    expect(parseExternalLink("[Local](file:///etc/passwd)")).toBeUndefined();
    expect(parseExternalLink("not a link")).toBeUndefined();
  });

  it("stores a title as a Markdown link and rejects other schemes", () => {
    expect(formatExternalLink("https://example.com/a", " Docs [v2] ")).toBe("[Docs v2](https://example.com/a)");
    expect(formatExternalLink("https://example.com/a")).toBe("https://example.com/a");
    expect(() => formatExternalLink("ftp://example.com")).toThrow("http");
  });
});
