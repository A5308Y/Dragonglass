/**
 * Newsletters in Inbox Items, so one press turns an issue into a Next Action to read it.
 * Most newsletters link their web version ("View online", "Read in browser"); for the
 * ones known here by domain, a link to one of their posts is enough. The mail import has
 * already turned the HTML into Markdown, so links read `[label](url)`.
 */

export interface NewsletterLink {
  /** The issue's web address, without tracking parameters. */
  url: string;
  /** Where it is from, for the processor's button, e.g. `theneurondaily.com`. */
  source: string;
}

/** Newsletters recognised by a link to one of their posts, whatever its label. */
const KNOWN_NEWSLETTERS: ReadonlyArray<{ host: string; post: RegExp }> = [
  { host: "theneurondaily.com", post: /^\/p\/[^/]+\/?$/ },
];

const MARKDOWN_LINK = /\[((?:\\.|[^\]\\])*)\]\((https?:\/\/[^)\s]+)\)/g;

/** What a web-version link says: "View online", "Read in your browser", "Web version"… */
const WEB_VERSION = /^(?:(?:view|read|open|see)\b.*\b(?:online|in (?:your |a |the )?browser|on the web|as a web ?page)|(?:web|online|browser) version)\b/i;

/** The first newsletter issue linked in the text, or `null`. */
export function findNewsletter(text: string): NewsletterLink | null {
  const links = [...text.matchAll(MARKDOWN_LINK)].flatMap((match) => {
    const url = parseUrl(match[2]!);
    return url ? [{ label: match[1]!.replace(/\\(.)/g, "$1").trim(), url }] : [];
  });
  for (const { url } of links) {
    const known = KNOWN_NEWSLETTERS.find((newsletter) => hostIs(url, newsletter.host) && newsletter.post.test(url.pathname));
    if (known) return { url: `${url.origin}${url.pathname}`, source: known.host };
  }
  const web = links.find((link) => WEB_VERSION.test(link.label));
  return web ? { url: withoutTracking(web.url), source: web.url.hostname.replace(/^www\./, "") } : null;
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
