/**
 * A small XML reader for feed documents.
 *
 * Feeds are the one thing Dragonglass reads that it did not write, so they are parsed
 * into plain values here and never into DOM nodes. Nothing a feed says can become
 * markup: `text` is character data with entities already resolved, and the surfaces
 * that show it render strings.
 *
 * This understands the subset a feed needs — elements, attributes, CDATA, comments,
 * processing instructions, and entities — and ignores the rest of XML rather than
 * failing on it.
 */

export interface XmlNode {
  /** The tag name without its namespace prefix, lowercased. */
  name: string;
  /** The namespace prefix, lowercased, or `""` for an unprefixed tag. */
  prefix: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Direct character data, with entities resolved and CDATA kept verbatim. */
  text: string;
}

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

/** Reads a feed document, or returns `null` when it has no element at all. */
export function parseXml(source: string): XmlNode | null {
  const root = node("", "");
  const stack: XmlNode[] = [root];
  let index = 0;

  const current = (): XmlNode => stack[stack.length - 1] ?? root;

  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open < 0) {
      current().text += decodeEntities(source.slice(index));
      break;
    }
    if (open > index) current().text += decodeEntities(source.slice(index, open));

    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      // An unterminated section is the rest of the document rather than a parse failure.
      current().text += end < 0 ? source.slice(open + 9) : source.slice(open + 9, end);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("<!", open)) {
      index = skipPast(source, open, ">");
      continue;
    }

    const close = findTagEnd(source, open);
    const raw = source.slice(open + 1, close).trim();
    index = close + 1;

    if (raw.startsWith("/")) {
      const closing = splitName(raw.slice(1).trim());
      // Close the nearest matching element so a stray end tag cannot unwind the document.
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        const candidate = stack[depth];
        if (candidate && candidate.name === closing.name && candidate.prefix === closing.prefix) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = firstWhitespace(body);
    const { name, prefix } = splitName(nameEnd < 0 ? body : body.slice(0, nameEnd));
    if (!name) continue;
    const element = node(name, prefix);
    if (nameEnd >= 0) element.attributes = parseAttributes(body.slice(nameEnd));
    current().children.push(element);
    if (!selfClosing) stack.push(element);
  }

  return root.children[0] ?? null;
}

/** The first direct child with this local name, whatever namespace it carries. */
export function child(parent: XmlNode | null, name: string): XmlNode | null {
  return parent?.children.find((candidate) => candidate.name === name) ?? null;
}

export function children(parent: XmlNode | null, name: string): XmlNode[] {
  return parent?.children.filter((candidate) => candidate.name === name) ?? [];
}

/** Every descendant with this local name, in document order. */
export function descendants(parent: XmlNode | null, name: string): XmlNode[] {
  if (!parent) return [];
  const found: XmlNode[] = [];
  const walk = (current: XmlNode): void => {
    for (const candidate of current.children) {
      if (candidate.name === name) found.push(candidate);
      walk(candidate);
    }
  };
  walk(parent);
  return found;
}

/** The trimmed text of the first matching child, or `""`. */
export function childText(parent: XmlNode | null, ...names: string[]): string {
  for (const name of names) {
    const found = child(parent, name);
    if (found) {
      const text = found.text.trim();
      if (text) return text;
    }
  }
  return "";
}

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

function node(name: string, prefix: string): XmlNode {
  return { name, prefix, attributes: {}, children: [], text: "" };
}

function splitName(raw: string): { name: string; prefix: string } {
  const lowered = raw.toLowerCase();
  const colon = lowered.indexOf(":");
  return colon < 0
    ? { name: lowered, prefix: "" }
    : { name: lowered.slice(colon + 1), prefix: lowered.slice(0, colon) };
}

function firstWhitespace(value: string): number {
  const match = /\s/.exec(value);
  return match ? match.index : -1;
}

/** The `>` that ends a tag, skipping any inside a quoted attribute value. */
function findTagEnd(source: string, open: number): number {
  let quote = "";
  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return source.length;
}

function skipPast(source: string, from: number, marker: string): number {
  const end = source.indexOf(marker, from);
  return end < 0 ? source.length : end + marker.length;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/<>]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'<>]+))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    const raw = match[2] ?? "";
    const unquoted = raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'")) ? raw.slice(1, -1) : raw;
    attributes[splitName(name).name] = decodeEntities(unquoted);
  }
  return attributes;
}
