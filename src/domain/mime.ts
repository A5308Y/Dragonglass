/**
 * Decoding the parts of a message that are not plain text.
 *
 * Mail arrives as bytes in whatever encoding and charset the sender chose, and a
 * subject line may carry three of them at once. Everything here turns those bytes
 * into ordinary strings so that the rest of Dragonglass never has to know about
 * base64, quoted-printable, or `=?UTF-8?B?`.
 *
 * Byte strings, not `Buffer`: the IMAP reader holds the wire as a latin-1 string so
 * that one character is one byte and a literal's byte count lines up with a string
 * index. Conversion to real text happens here, once the part's charset is known.
 */

import { htmlToText } from "./text";

/** Header values longer than this are almost certainly a header-injection attempt. */
const MAX_HEADER_VALUE = 4_000;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export type MailHeaders = ReadonlyMap<string, readonly string[]>;

/**
 * Splits a raw header block into lowercased names and unfolded values.
 *
 * Folding is whitespace at the start of a continuation line, and RFC 5322 says the
 * fold is removed rather than replaced, so the leading whitespace of the
 * continuation is what joins the pieces.
 */
export function parseHeaders(raw: string): MailHeaders {
  const headers = new Map<string, string[]>();
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let current = "";

  const flush = (): void => {
    const separator = current.indexOf(":");
    if (separator > 0) {
      const name = current.slice(0, separator).trim().toLowerCase();
      const value = current.slice(separator + 1).trim().slice(0, MAX_HEADER_VALUE);
      const existing = headers.get(name);
      if (existing) existing.push(value);
      else headers.set(name, [value]);
    }
    current = "";
  };

  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && current) current += line;
    else {
      flush();
      current = line;
    }
  }
  flush();
  return headers;
}

/** The first value of a header, already decoded from any encoded-words, or `""`. */
export function headerValue(headers: MailHeaders, name: string): string {
  return decodeEncodedWords(headers.get(name.toLowerCase())?.[0] ?? "");
}

/**
 * Resolves RFC 2047 encoded-words.
 *
 * Whitespace separating two encoded-words is a separator for the encoding, not part
 * of the text, so it is dropped — otherwise a subject split across folds gains a
 * space in the middle of a word. Anything that fails to decode is left exactly as it
 * arrived rather than replaced, since a literal `=?` in a subject is not an error.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  const pattern = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let result = "";
  let index = 0;
  let previousEnd = -1;

  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const between = value.slice(index, start);
    // Only whitespace between two encoded-words disappears; real text survives.
    if (!(previousEnd === start - between.length && between.trim() === "" && between.length > 0)) {
      result += between;
    }
    result += decodeWord(match[1] ?? "", match[2] ?? "q", match[3] ?? "") ?? match[0];
    index = start + match[0].length;
    previousEnd = index;
  }
  return result + value.slice(index);
}

function decodeWord(charset: string, encoding: string, text: string): string | null {
  try {
    const bytes = encoding.toLowerCase() === "b"
      ? decodeBase64(text)
      // Inside an encoded-word an underscore stands for a space.
      : decodeQuotedPrintable(text.replace(/_/g, " "));
    return decodeCharset(bytes, charset);
  } catch {
    return null;
  }
}

/** Decodes a part body according to its `Content-Transfer-Encoding`. */
export function decodeTransferEncoding(body: string, encoding: string): Uint8Array {
  switch (encoding.trim().toLowerCase()) {
    case "base64":
      return decodeBase64(body);
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    default:
      // 7bit, 8bit, binary, and anything unrecognised are already the bytes themselves.
      return latin1Bytes(body);
  }
}

export function decodeQuotedPrintable(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (character !== "=") {
      if (character !== "\r") bytes.push(character.charCodeAt(0) & 0xff);
      continue;
    }
    const pair = text.slice(index + 1, index + 3);
    if (/^\r?\n/.test(text.slice(index + 1))) {
      // A soft line break: the newline is the encoding's, not the text's.
      index += text[index + 1] === "\r" ? 2 : 1;
      continue;
    }
    if (/^[0-9a-fA-F]{2}$/.test(pair)) {
      bytes.push(parseInt(pair, 16));
      index += 2;
    } else bytes.push(0x3d);
  }
  return Uint8Array.from(bytes);
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Reads bytes as text.
 *
 * An unknown or misspelled charset is common in real mail and is not worth failing
 * over, so anything `TextDecoder` refuses falls back to UTF-8 with replacement.
 */
export function decodeCharset(bytes: Uint8Array, charset: string): string {
  const label = charset.trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** The wire form of a byte string: one character per byte. */
export function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

/**
 * Turns a fetched body part into the plain text a note will quote.
 *
 * The three steps have to happen in this order: undo the transfer encoding to get
 * the real bytes, read those bytes in the part's charset, and only then flatten any
 * markup. Flattening first would strip tags that base64 had not yet revealed.
 */
export function decodeMessagePart(
  raw: string,
  part: { encoding: string; charset: string; subtype?: string },
): string {
  const text = decodeCharset(decodeTransferEncoding(raw, part.encoding), part.charset);
  return part.subtype === "plain" ? text : htmlToText(text);
}

export interface MailAddress {
  /** The display name, or `""` when the sender gave none. */
  name: string;
  /** The addr-spec, lowercased, or `""` when none could be read. */
  address: string;
}

/**
 * The first address of an address header.
 *
 * Only the first is kept: Dragonglass shows who a message is from, not the full
 * recipient list, and a `From` with several addresses is vanishingly rare.
 */
export function parseAddress(value: string): MailAddress {
  const decoded = decodeEncodedWords(value).trim();
  if (!decoded) return { name: "", address: "" };

  const angled = /^(.*)<([^>]*)>/.exec(decoded);
  if (angled) {
    return {
      name: unquote((angled[1] ?? "").trim()),
      address: (angled[2] ?? "").trim().toLowerCase(),
    };
  }
  const bare = decoded.split(",")[0]?.trim() ?? "";
  return bare.includes("@") ? { name: "", address: bare.toLowerCase() } : { name: unquote(bare), address: "" };
}

/** How a sender reads on a row: the display name, falling back to the address. */
export function addressLabel(value: string): string {
  const parsed = parseAddress(value);
  return parsed.name || parsed.address;
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value);
  return (quoted ? quoted[1] ?? "" : value).replace(/\\(.)/g, "$1").trim();
}

/**
 * The `Message-ID` a message is identified by.
 *
 * Kept with its angle brackets stripped and case preserved — the RFC treats the
 * addr-spec as case-sensitive, and some servers do use mixed case.
 */
export function parseMessageId(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

/** RFC 3339, or `""` when the header's date cannot be read. */
export function parseMailDate(value: string): string {
  const trimmed = decodeEncodedWords(value).trim();
  if (!trimmed) return "";
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

/** Whether a message came from a mailing list or bulk sender, per its own headers. */
export function isBulk(headers: MailHeaders): boolean {
  if (headers.has("list-id") || headers.has("list-unsubscribe")) return true;
  const precedence = headerValue(headers, "precedence").toLowerCase();
  return precedence === "bulk" || precedence === "list" || precedence === "junk";
}
