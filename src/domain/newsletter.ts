/**
 * Newsletters in Inbox Items, so one press turns an issue into a Next Action to read it.
 * Most newsletters link their web version ("View online", "Read in browser"); for the
 * ones known here by domain, a link to one of their posts is enough. The mail import keeps
 * an email's plain-text version, where a link is its address after its label ("Read Online
 * (https://…)", or the label on the line above); a Markdown `[label](url)` counts too.
 */

export interface NewsletterLink {
  /** The issue's web address, without tracking parameters. */
  url: string;
  /**
   * How the processor's button names it: a known newsletter's domain, e.g. `theneurondaily.com`,
   * or "newsletter" for one found by its web-version link, whose address is often a click tracker.
   */
  source: string;
}

/** Newsletters recognised by a link to one of their posts, whatever its label. */
const KNOWN_NEWSLETTERS: ReadonlyArray<{ host: string; post: RegExp }> = [
  { host: "theneurondaily.com", post: /^\/p\/[^/]+\/?$/ },
];

const MARKDOWN_LINK = /\[((?:\\.|[^\]\\])*)\]\((https?:\/\/[^)\s]+)\)/g;
const PLAIN_URL = /https?:\/\/[^\s<>()[\]"']+/g;

/**
 * What a web-version link says, at the end of the text before it: "View online", "Read
 * Online", "View this email in your browser", "Web version"…
 */
const WEB_VERSION = /(?:\b(?:view|read|open|see)\b[^.!?\n]{0,40}?\b(?:online|in (?:your |a |the )?browser|on the web|as a web ?page)|\b(?:web|online|browser) version)\W*$/i;

/** The first newsletter issue linked in the text, or `null`. */
export function findNewsletter(text: string): NewsletterLink | null {
  const links = textLinks(text);
  for (const { url } of links) {
    const known = KNOWN_NEWSLETTERS.find((newsletter) => hostIs(url, newsletter.host) && newsletter.post.test(url.pathname));
    if (known) return { url: `${url.origin}${url.pathname}`, source: known.host };
  }
  const web = links.find((link) => WEB_VERSION.test(link.label));
  return web ? { url: withoutTracking(web.url), source: "newsletter" } : null;
}

/**
 * The reading Action's title: "Read" and a link the board shows, named after the email's
 * subject. The subject comes from an email, so characters that would end the link go.
 */
export function readActionTitle(link: NewsletterLink, subject: string): string {
  const title = subject
    .replace(/^(?:(?:re|fwd?|aw|wg)\s*:\s*)+/i, "")
    .replace(/[[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `Read [${title || link.source}](${link.url})`;
}

/** Whether an Action's title links this issue. */
export function linksNewsletter(title: string, link: NewsletterLink): boolean {
  return title.includes(`](${link.url})`);
}

/** Every link in the text with what stands before it: its Markdown label, or the text leading up to it. */
function textLinks(text: string): Array<{ label: string; url: URL }> {
  const links: Array<{ label: string; url: URL }> = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const url = parseUrl(match[2]!);
    if (url) links.push({ label: plainLabel(match[1]!), url });
  }
  for (const match of text.matchAll(PLAIN_URL)) {
    const url = parseUrl(match[0].replace(/[.,;:!?]+$/, ""));
    if (url) links.push({ label: labelBefore(text, match.index), url });
  }
  return links;
}

/** The plain text before a link on its line, or the line above when the link stands alone. */
function labelBefore(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const sameLine = plainLabel(text.slice(lineStart, index));
  if (sameLine) return sameLine;
  const lines = text.slice(0, lineStart).split("\n").map(plainLabel).filter(Boolean);
  return lines.at(-1) ?? "";
}

/** A label without quoting, emphasis, escapes and the bracket or colon leading to its address. */
function plainLabel(raw: string): string {
  return raw
    .replace(/^\s*>\s?/, "")
    .replace(/\\(.)/g, "$1")
    .replace(/[*_]/g, "")
    .replace(/[\s([<:\-–—|]+$/, "")
    .trim();
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function hostIs(url: URL, host: string): boolean {
  return url.hostname === host || url.hostname.endsWith(`.${host}`);
}

/** The address without `utm_…` and similar tracking parameters, so the same issue reads the same. */
function withoutTracking(url: URL): string {
  const clean = new URL(url.toString());
  for (const key of [...clean.searchParams.keys()]) {
    if (/^(?:utm_|mc_|_hs|mkt_)/i.test(key) || key === "ref") clean.searchParams.delete(key);
  }
  clean.hash = "";
  return clean.toString();
}
