/** One web link a Project refers to. */
export interface ExternalLink {
  /** The entry as written in `external_links`, which identifies it for removal. */
  entry: string;
  url: string;
  /** The given title, or the URL when there is none. */
  title: string;
}

const MARKDOWN_LINK = /^\[([^\]]*)\]\((\S+)\)$/;

/**
 * Reads one `external_links` entry: a Markdown link `[Title](https://…)` or a bare
 * URL. Only http and https count; anything else is left out rather than opened.
 */
export function parseExternalLink(entry: string): ExternalLink | undefined {
  const trimmed = entry.trim();
  const markdown = MARKDOWN_LINK.exec(trimmed);
  const url = webUrl(markdown ? markdown[2]! : trimmed);
  if (!url) return undefined;
  const title = markdown?.[1]?.trim() || url;
  return { entry: trimmed, url, title };
}

/** The entry to store for a URL and an optional title. Throws for anything but http(s). */
export function formatExternalLink(url: string, title = ""): string {
  const valid = webUrl(url.trim());
  if (!valid) throw new Error("Enter a web address starting with http:// or https://.");
  // Brackets would end the Markdown link text early.
  const cleanTitle = title.trim().replace(/[[\]]/g, "");
  return cleanTitle ? `[${cleanTitle}](${valid})` : valid;
}

function webUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
