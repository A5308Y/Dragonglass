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

// A Markdown link or image, an autolink `<https://…>`, or a bare web address, in
// that order, so a URL inside a Markdown link is not also read as a bare one.
const NOTE_LINK = /(!?)\[([^\]]*)\]\(<?(\S+?)>?(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>[\]()]+)/g;

/**
 * The web links written in a note, as `external_links` entries, in the order they
 * first appear and once per address. Frontmatter, code and images are left out;
 * so is anything that is not http or https, such as `message:` links to Apple Mail.
 */
export function externalLinksInNote(markdown: string): string[] {
  const text = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const match of text.matchAll(NOTE_LINK)) {
    const [, image, label, markdownUrl, autolink, bare] = match;
    if (image) continue;
    // Sentence punctuation after a bare address belongs to the sentence.
    const raw = markdownUrl ?? autolink ?? bare!.replace(/[.,;:!?'"*_]+$/, "");
    const link = parseExternalLink(raw);
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    const title = label?.trim() ?? "";
    entries.push(formatExternalLink(link.url, title === raw ? "" : title));
  }
  return entries;
}
