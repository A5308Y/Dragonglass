/**
 * The IMAP wire format, without the socket.
 *
 * Everything here is a pure function over strings so that the protocol — the part
 * with the sharp edges — can be tested without a mail server. The socket layer does
 * nothing but move bytes and hand them to `takeResponse`.
 *
 * Buffers are byte strings: the connection decodes the wire as latin-1 so that one
 * character is one byte. A literal announces itself as `{342}` and is then exactly
 * 342 characters, which only holds if nothing has re-encoded the stream on the way
 * in. Text is decoded later, in `mime.ts`, once a part's charset is known.
 */

/** A literal larger than this is not mail Dragonglass has any use for. */
export const MAX_LITERAL_BYTES = 8_000_000;

export interface ImapResponse {
  /** The response with each literal left as its `{n}` marker. */
  text: string;
  /** Literal payloads, in the order their markers appear in `text`. */
  literals: string[];
}

/**
 * Pulls one complete response off the front of a buffer.
 *
 * Returns `null` when the buffer holds only part of a response, which is the normal
 * case while bytes are still arriving. A response can span several physical lines,
 * because a literal interrupts one: `... BODY[TEXT] {23}\r\n<23 bytes>)\r\n` is a
 * single response, and splitting on CRLF would tear it in half.
 */
export function takeResponse(buffer: string): { response: ImapResponse; rest: string } | null {
  const literals: string[] = [];
  let text = "";
  let index = 0;

  for (;;) {
    const end = buffer.indexOf("\r\n", index);
    if (end < 0) return null;
    const line = buffer.slice(index, end);
    text += line;

    const marker = /\{(\d+)\+?\}$/.exec(line);
    if (!marker) return { response: { text, literals }, rest: buffer.slice(end + 2) };

    const size = Number(marker[1]);
    if (size > MAX_LITERAL_BYTES) throw new Error(`The server announced a ${size} byte literal.`);
    const start = end + 2;
    if (buffer.length < start + size) return null;
    literals.push(buffer.slice(start, start + size));
    index = start + size;
  }
}

/** Whether a response is the tagged completion of the command with this tag. */
export function isTagged(text: string, tag: string): boolean {
  return text.startsWith(`${tag} `);
}

export interface TaggedResult {
  status: "OK" | "NO" | "BAD";
  detail: string;
}

export function parseTagged(text: string, tag: string): TaggedResult | null {
  const match = new RegExp(`^${tag} (OK|NO|BAD)(?: (.*))?$`, "i").exec(text);
  if (!match) return null;
  return { status: (match[1] ?? "").toUpperCase() as TaggedResult["status"], detail: match[2] ?? "" };
}

// TOKENS

/** An atom or string, or a parenthesised list of them. */
export type Token = string | Token[];

/**
 * Reads a response body into atoms, strings, and lists.
 *
 * Bracketed sections stay attached to the atom that owns them, so
 * `BODY[HEADER.FIELDS (SUBJECT FROM)]` is one key rather than four tokens — the
 * brackets are part of the name, not structure.
 */
export function tokenize(text: string, literals: readonly string[] = []): Token[] {
  let index = 0;
  let literalIndex = 0;

  const readList = (terminated: boolean): Token[] => {
    const items: Token[] = [];
    while (index < text.length) {
      const character = text[index];
      if (character === " ") {
        index += 1;
      } else if (character === "(") {
        index += 1;
        items.push(readList(true));
      } else if (character === ")") {
        index += 1;
        if (terminated) return items;
      } else if (character === '"') {
        items.push(readQuoted());
      } else if (character === "{") {
        const marker = /^\{(\d+)\+?\}/.exec(text.slice(index));
        if (marker) {
          index += marker[0].length;
          items.push(literals[literalIndex] ?? "");
          literalIndex += 1;
        } else index += 1;
      } else {
        items.push(readAtom());
      }
    }
    return items;
  };

  const readQuoted = (): string => {
    index += 1;
    let value = "";
    while (index < text.length) {
      const character = text[index] ?? "";
      if (character === "\\") {
        value += text[index + 1] ?? "";
        index += 2;
      } else if (character === '"') {
        index += 1;
        return value;
      } else {
        value += character;
        index += 1;
      }
    }
    return value;
  };

  const readAtom = (): string => {
    let value = "";
    let brackets = 0;
    while (index < text.length) {
      const character = text[index] ?? "";
      if (character === "[") brackets += 1;
      else if (character === "]") brackets -= 1;
      else if (brackets === 0 && (character === " " || character === "(" || character === ")")) break;
      value += character;
      index += 1;
    }
    return value;
  };

  return readList(false);
}

// COMMANDS

/**
 * Compacts UIDs into a sequence set.
 *
 * A mailbox sync asks about hundreds of UIDs at once, and `1:400` is both shorter
 * than four hundred numbers and what servers are optimised for.
 */
export function formatSequenceSet(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].filter((uid) => Number.isInteger(uid) && uid > 0).sort((left, right) => left - right);
  const ranges: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;

  for (const uid of sorted) {
    if (start === null || previous === null) {
      start = uid;
    } else if (uid !== previous + 1) {
      ranges.push(start === previous ? `${start}` : `${start}:${previous}`);
      start = uid;
    }
    previous = uid;
  }
  if (start !== null && previous !== null) ranges.push(start === previous ? `${start}` : `${start}:${previous}`);
  return ranges.join(",");
}

/**
 * Quotes a value for a command.
 *
 * CR and LF are refused outright rather than escaped: IMAP is newline-framed, so a
 * newline inside a mailbox name or a search term would end the command and start
 * another one the user did not write.
 */
export function quoteString(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("A newline cannot appear in an IMAP command.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Whether a value has to be sent as a literal rather than a quoted string. */
export function needsLiteral(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x20-\x7e]/.test(value);
}

/**
 * Validates a configured search criterion before it reaches the wire.
 *
 * The criterion is user-written — `ALL`, `UNSEEN`, `KEYWORD Dragonglass` — so it is
 * interpolated into a command verbatim. Only the characters a criterion legitimately
 * needs are allowed, which is what stops a stray newline from appending a second,
 * unrelated command.
 */
export function validateCriterion(criterion: string): string {
  const trimmed = criterion.trim() || "ALL";
  if (!/^[A-Za-z0-9 ()"$*:,./+@_-]+$/.test(trimmed)) {
    throw new Error("A search criterion may only contain letters, digits, and simple punctuation.");
  }
  return trimmed;
}

/** `SINCE` wants `01-Jan-2026`, not an ISO date. */
export function imapDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(date.getDate()).padStart(2, "0")}-${months[date.getMonth()]}-${date.getFullYear()}`;
}

// RESPONSES

export function parseSearchUids(text: string): number[] {
  const match = /^\* SEARCH(.*)$/i.exec(text);
  if (!match) return [];
  return (match[1] ?? "")
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((uid) => Number.isInteger(uid) && uid > 0);
}

/** The value of a `[NAME value]` status code, or `""`. */
export function parseStatusCode(text: string, name: string): string {
  const match = new RegExp(`\\[${name}\\s+([^\\]]*)\\]`, "i").exec(text);
  return (match?.[1] ?? "").trim();
}

export function parseExists(text: string): number | null {
  const match = /^\* (\d+) EXISTS$/i.exec(text.trim());
  return match ? Number(match[1]) : null;
}

export function parseCapabilities(text: string): string[] {
  const inline = parseStatusCode(text, "CAPABILITY");
  const listed = /^\* CAPABILITY (.*)$/i.exec(text)?.[1] ?? "";
  return (inline || listed).split(/\s+/).filter(Boolean).map((value) => value.toUpperCase());
}

export interface MailboxListing {
  name: string;
  /** The hierarchy separator this server uses, usually `/` or `.`. */
  delimiter: string;
  flags: string[];
}

/** One `* LIST (\HasNoChildren) "/" "INBOX"` line. */
export function parseListResponse(response: ImapResponse): MailboxListing | null {
  if (!/^\* LIST /i.test(response.text)) return null;
  const tokens = tokenize(response.text.replace(/^\* LIST /i, ""), response.literals);
  const flags = Array.isArray(tokens[0]) ? tokens[0].filter((flag): flag is string => typeof flag === "string") : [];
  const delimiter = typeof tokens[1] === "string" && tokens[1] !== "NIL" ? tokens[1] : "/";
  const name = typeof tokens[2] === "string" ? tokens[2] : "";
  return name ? { name: decodeMailbox(name), delimiter, flags } : null;
}

export interface FetchResponse {
  sequence: number;
  /** Attribute name (upper-cased, brackets intact) to its value. */
  attributes: Map<string, Token>;
}

export function parseFetchResponse(response: ImapResponse): FetchResponse | null {
  const match = /^\* (\d+) FETCH /i.exec(response.text);
  if (!match) return null;
  const tokens = tokenize(response.text.slice(match[0].length), response.literals);
  const items = Array.isArray(tokens[0]) ? tokens[0] : tokens;
  const attributes = new Map<string, Token>();
  for (let index = 0; index < items.length; index += 2) {
    const key = items[index];
    if (typeof key !== "string") continue;
    attributes.set(key.toUpperCase(), items[index + 1] ?? "");
  }
  return { sequence: Number(match[1]), attributes };
}

export function attributeText(attributes: Map<string, Token>, name: string): string {
  const value = attributes.get(name.toUpperCase());
  return typeof value === "string" ? value : "";
}

/** The `BODY[...]` payload, whichever section was asked for. */
export function attributeSection(attributes: Map<string, Token>, prefix: string): string {
  for (const [key, value] of attributes) {
    if (key.startsWith(prefix.toUpperCase()) && typeof value === "string") return value;
  }
  return "";
}

// BODY STRUCTURE

export interface BodyPart {
  /** The section number `BODY[...]` wants, such as `1.2`. */
  path: string;
  type: string;
  subtype: string;
  charset: string;
  encoding: string;
  size: number;
}

/**
 * Flattens a BODYSTRUCTURE into the leaf parts a fetch can ask for.
 *
 * The tree matters only for numbering the parts, and numbering is the whole point:
 * fetching `BODY[1.1]` pulls a few kilobytes of text where fetching the message
 * whole would pull every attachment with it.
 */
export function flattenBodyStructure(token: Token): BodyPart[] {
  const parts: BodyPart[] = [];

  const walk = (node: Token, prefix: string): void => {
    if (!Array.isArray(node)) return;
    if (Array.isArray(node[0])) {
      // A multipart: its children are the leading lists, numbered from one.
      let child = 0;
      for (const item of node) {
        if (!Array.isArray(item)) break;
        child += 1;
        walk(item, prefix ? `${prefix}.${child}` : `${child}`);
      }
      return;
    }
    const type = String(node[0] ?? "").toLowerCase();
    const subtype = String(node[1] ?? "").toLowerCase();
    const parameters = Array.isArray(node[2]) ? node[2] : [];
    let charset = "";
    for (let index = 0; index < parameters.length; index += 2) {
      if (String(parameters[index] ?? "").toLowerCase() === "charset") charset = String(parameters[index + 1] ?? "");
    }
    parts.push({
      path: prefix || "1",
      type,
      subtype,
      charset,
      encoding: String(node[5] ?? "7bit").toLowerCase(),
      size: Number(node[6] ?? 0) || 0,
    });
  };

  walk(token, "");
  return parts;
}

/** The part worth reading: the first plain-text one, or failing that the first HTML. */
export function findTextPart(parts: readonly BodyPart[]): BodyPart | null {
  return parts.find((part) => part.type === "text" && part.subtype === "plain")
    ?? parts.find((part) => part.type === "text")
    ?? null;
}

/**
 * Whether the message carries something beyond its text.
 *
 * Read from the structure rather than from Content-Disposition, because an inline
 * image is still a thing the message brought with it, and a note that says so is
 * more useful than a note that quibbles about how it was attached.
 */
export function hasAttachment(parts: readonly BodyPart[]): boolean {
  return parts.some((part) => part.type !== "text" && part.type !== "multipart");
}

// MAILBOX NAMES

/**
 * Decodes modified UTF-7, which is how IMAP spells non-ASCII mailbox names.
 *
 * `Entw&APw-rfe` is `Entwürfe`. Servers that support UTF8=ACCEPT send the name
 * directly, and a name with no `&` passes through untouched either way.
 */
export function decodeMailbox(name: string): string {
  if (!name.includes("&")) return name;
  return name.replace(/&([^-]*)-/g, (match, encoded: string) => {
    if (!encoded) return "&";
    try {
      const bytes = base64Bytes(encoded.replace(/,/g, "/"));
      let value = "";
      for (let index = 0; index + 1 < bytes.length; index += 2) {
        value += String.fromCharCode(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
      }
      return value;
    } catch {
      return match;
    }
  });
}

/** Encodes a mailbox name back into modified UTF-7 for a command. */
export function encodeMailbox(name: string): string {
  let result = "";
  let pending = "";

  const flush = (): void => {
    if (!pending) return;
    const units: number[] = [];
    for (const character of pending) {
      const code = character.codePointAt(0) ?? 0;
      if (code > 0xffff) {
        const offset = code - 0x10000;
        units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
      } else units.push(code);
    }
    const bytes = new Uint8Array(units.length * 2);
    units.forEach((unit, index) => {
      bytes[index * 2] = unit >> 8;
      bytes[index * 2 + 1] = unit & 0xff;
    });
    result += `&${bytesBase64(bytes).replace(/=+$/, "").replace(/\//g, ",")}-`;
    pending = "";
  };

  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "&") {
      flush();
      result += "&-";
    } else if (code >= 0x20 && code <= 0x7e) {
      flush();
      result += character;
    } else pending += character;
  }
  flush();
  return result;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE64.indexOf(character);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function bytesBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += BASE64[(triple >> 18) & 63] ?? "";
    result += BASE64[(triple >> 12) & 63] ?? "";
    result += second === undefined ? "=" : BASE64[(triple >> 6) & 63] ?? "";
    result += third === undefined ? "=" : BASE64[triple & 63] ?? "";
  }
  return result;
}
