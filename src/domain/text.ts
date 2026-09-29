/**
 * Turning text Dragonglass did not write into text it is safe to store and show.
 *
 * Feeds and mail are both arbitrary content from the open internet, arriving as
 * markup, entities, and occasionally as an attempt to be something other than text.
 * Both go through here on the way in, so neither can become markup on a surface or
 * syntax in a note.
 */

/** How much of an item's text is worth keeping for a row or a note. */
export const SUMMARY_LIMIT = 600;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  times: "×",
};

export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return codePoint(parseInt(entity.slice(2), 16), match);
    if (entity.startsWith("#")) return codePoint(parseInt(entity.slice(1), 10), match);
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function codePoint(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

/**
 * Flattens markup to plain text.
 *
 * Descriptions and mail bodies carry arbitrary HTML. Dragonglass shows it as text
 * and never as markup, so this is where it stops being markup: scripts and styles go
 * entirely, block boundaries become spaces, and tags are removed before entities are
 * resolved so an escaped tag cannot reappear as one.
 */
export function htmlToText(raw: string): string {
  return raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-zA-Z#0-9]+;/g, (entity) => decodeEntities(entity))
    .replace(/[\s ]+/g, " ")
    .trim();
}

export function summaryOf(raw: string): string {
  const text = htmlToText(raw);
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT).trimEnd()}…` : text;
}

/**
 * Neutralises vault syntax in text Dragonglass did not write.
 *
 * Content is stored as plain characters, but a note is Markdown: left alone, a feed
 * or a sender could put `[[Replace heating system]]` in your graph or `#urgent` on
 * your Projects simply by publishing or emailing it. Escaping happens on the way
 * into the vault, so what the surface showed is what the note says.
 */
/**
 * A title's text without its link syntax: `[text](url)` gives "text", `[[Note|shown]]`
 * gives "shown" and `[[Note]]` gives "Note". File names are made from this, so a title
 * with a link doesn't name its file after the address.
 */
export function plainTitle(title: string): string {
  return title
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1");
}

export function escapeVaultText(value: string): string {
  return value
    .replace(/!\[\[/g, "!\\[\\[")
    .replace(/\[\[/g, "\\[\\[")
    .replace(/\]\]/g, "\\]\\]")
    .replace(/(^|\s)#(?=[^\s#])/g, "$1\\#")
    .replace(/^(\s*)([-*+>])\s/gm, "$1\\$2 ")
    .replace(/^(\s*)(\d{1,9})([.)])\s/gm, "$1$2\\$3 ");
}
