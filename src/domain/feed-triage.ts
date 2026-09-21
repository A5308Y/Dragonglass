/**
 * What a kept Feed Item becomes.
 *
 * Decided here rather than in the view so that the note that lands in the Inbox
 * can be tested without a vault or a browser.
 */

import type { FeedItem } from "./feed";

/** The Inbox Item title a kept Feed Item takes. */
export function feedItemTitle(item: Pick<FeedItem, "title">): string {
  return item.title.trim() || "Untitled Feed Item";
}

/**
 * The note body a kept Feed Item becomes.
 *
 * The source link comes first because it is the only part that cannot be
 * reconstructed later, and the summary is quoted so a long one reads as the
 * quotation it is rather than as something written here.
 */
export function feedItemNote(item: FeedItem, feedTitle: string): string {
  const lines: string[] = [];
  if (item.link) lines.push(`Source: ${item.link}`);
  if (item.commentsUrl) lines.push(`Comments: ${item.commentsUrl}`);
  const attribution = [feedTitle.trim(), item.author.trim(), item.published.slice(0, 10)].filter(Boolean);
  if (attribution.length) lines.push(escapeVaultText(attribution.join(" · ")));
  const summary = escapeVaultText(item.summary);
  if (summary) lines.push("", ...summary.split("\n").map((line) => `> ${line}`));
  return lines.join("\n");
}

/**
 * Neutralises vault syntax in text Dragonglass did not write.
 *
 * Feed text is stored as plain characters, but a note is Markdown: left alone, a
 * feed could put `[[Replace heating system]]` in your graph or `#urgent` on your
 * Projects simply by publishing it. Escaping happens on the way into the vault, so
 * what the row showed is what the note says.
 */
export function escapeVaultText(value: string): string {
  return value
    .replace(/!\[\[/g, "!\\[\\[")
    .replace(/\[\[/g, "\\[\\[")
    .replace(/\]\]/g, "\\]\\]")
    .replace(/(^|\s)#(?=[^\s#])/g, "$1\\#")
    .replace(/^(\s*)([-*+>])\s/gm, "$1\\$2 ")
    .replace(/^(\s*)(\d{1,9})([.)])\s/gm, "$1$2\\$3 ");
}

/** How old an Item reads on a row: short while it matters, then just the date. */
export function feedItemAge(published: string, now = new Date()): string {
  if (!published) return "";
  const at = Date.parse(published);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor((now.getTime() - at) / 60_000);
  if (minutes < 0) return "scheduled";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 28) return `${Math.floor(days / 7)}w ago`;
  return published.slice(0, 10);
}
