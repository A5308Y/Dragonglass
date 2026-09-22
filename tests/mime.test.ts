import { describe, expect, it } from "vitest";
import {
  addressLabel,
  decodeBase64,
  decodeCharset,
  decodeEncodedWords,
  decodeQuotedPrintable,
  decodeTransferEncoding,
  headerValue,
  isBulk,
  latin1Bytes,
  parseAddress,
  parseHeaders,
  parseMailDate,
  parseMessageId,
} from "../src/domain/mime";

const text = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

describe("Reading a header block", () => {
  it("lowercases names and keeps values", () => {
    const headers = parseHeaders("Subject: Heat pumps\r\nFrom: ada@example.com\r\n");
    expect(headers.get("subject")).toEqual(["Heat pumps"]);
    expect(headers.get("from")).toEqual(["ada@example.com"]);
  });

  it("unfolds a continuation line without inventing a space", () => {
    const headers = parseHeaders("Subject: Heat pumps in\r\n old houses\r\n");
    expect(headers.get("subject")).toEqual(["Heat pumps in old houses"]);
  });

  it("keeps every occurrence of a repeated header", () => {
    const headers = parseHeaders("Received: one\r\nReceived: two\r\n");
    expect(headers.get("received")).toEqual(["one", "two"]);
  });

  it("ignores a line that is not a header", () => {
    expect(parseHeaders("not a header\r\nSubject: Real\r\n").get("subject")).toEqual(["Real"]);
  });

  it("reads a named header back decoded, or empty when absent", () => {
    const headers = parseHeaders("Subject: =?UTF-8?B?SGVsbG8=?=\r\n");
    expect(headerValue(headers, "Subject")).toBe("Hello");
    expect(headerValue(headers, "X-Missing")).toBe("");
  });
});

describe("Encoded words", () => {
  it("decodes base64 and quoted-printable words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?SGVhdCBwdW1wcw==?=")).toBe("Heat pumps");
    expect(decodeEncodedWords("=?UTF-8?Q?Heat_pumps?=")).toBe("Heat pumps");
  });

  it("drops only the whitespace that separates two encoded words", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Heat?= =?UTF-8?Q?pumps?=")).toBe("Heatpumps");
    expect(decodeEncodedWords("Re: =?UTF-8?Q?Heat?= today")).toBe("Re: Heat today");
  });

  it("handles a non-UTF-8 charset", () => {
    // "Grüße" in ISO-8859-1: ü = 0xFC, ß = 0xDF
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Gr=FC=DFe?=")).toBe("Grüße");
  });

  it("leaves text that only looks like an encoded word alone", () => {
    expect(decodeEncodedWords("Is =? a valid token?")).toBe("Is =? a valid token?");
    expect(decodeEncodedWords("plain subject")).toBe("plain subject");
  });
});

describe("Transfer encodings", () => {
  it("decodes quoted-printable, including soft line breaks", () => {
    expect(text(decodeQuotedPrintable("Heat=20pumps"))).toBe("Heat pumps");
    expect(text(decodeQuotedPrintable("Heat pum=\r\nps"))).toBe("Heat pumps");
    expect(text(decodeQuotedPrintable("caf=C3=A9"))).toBe("café");
  });

  it("keeps a lone = that is not an escape", () => {
    expect(text(decodeQuotedPrintable("a=b"))).toBe("a=b");
  });

  it("decodes base64, ignoring the line wrapping mail adds", () => {
    expect(text(decodeBase64("SGVhdCBwdW1wcw=="))).toBe("Heat pumps");
    expect(text(decodeBase64("SGVhdCBw\r\ndW1wcw=="))).toBe("Heat pumps");
  });

  it("passes 7bit and unknown encodings through as bytes", () => {
    expect(text(decodeTransferEncoding("Heat pumps", "7bit"))).toBe("Heat pumps");
    expect(text(decodeTransferEncoding("Heat pumps", "x-weird"))).toBe("Heat pumps");
  });

  it("dispatches on the declared encoding", () => {
    expect(text(decodeTransferEncoding("SGVhdA==", "BASE64"))).toBe("Heat");
    expect(text(decodeTransferEncoding("He=61t", " Quoted-Printable "))).toBe("Heat");
  });
});

describe("Charsets", () => {
  it("reads a declared charset", () => {
    expect(decodeCharset(Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65]), "iso-8859-1")).toBe("Grüße");
  });

  it("falls back to UTF-8 rather than failing on a charset it does not know", () => {
    expect(decodeCharset(latin1Bytes("Heat"), "x-nonsense-9000")).toBe("Heat");
    expect(decodeCharset(latin1Bytes("Heat"), "")).toBe("Heat");
  });
});

describe("Addresses", () => {
  it("splits a display name from the address", () => {
    expect(parseAddress("Ada Lovelace <Ada@Example.COM>")).toEqual({ name: "Ada Lovelace", address: "ada@example.com" });
  });

  it("unquotes and unescapes a quoted display name", () => {
    expect(parseAddress('"Lovelace, Ada" <ada@example.com>').name).toBe("Lovelace, Ada");
    expect(parseAddress('"Ada \\"A\\" Lovelace" <ada@example.com>').name).toBe('Ada "A" Lovelace');
  });

  it("decodes an encoded display name", () => {
    expect(parseAddress("=?UTF-8?Q?Gr=C3=BC=C3=9Fe?= <hi@example.com>").name).toBe("Grüße");
  });

  it("handles a bare address and an empty header", () => {
    expect(parseAddress("ada@example.com")).toEqual({ name: "", address: "ada@example.com" });
    expect(parseAddress("   ")).toEqual({ name: "", address: "" });
  });

  it("takes only the first of several addresses", () => {
    expect(parseAddress("ada@example.com, grace@example.com").address).toBe("ada@example.com");
  });

  it("labels a sender by name, falling back to the address", () => {
    expect(addressLabel("Ada Lovelace <ada@example.com>")).toBe("Ada Lovelace");
    expect(addressLabel("ada@example.com")).toBe("ada@example.com");
  });
});

describe("Message identity and dates", () => {
  it("strips the angle brackets from a Message-ID", () => {
    expect(parseMessageId("<abc123@example.com>")).toBe("abc123@example.com");
    expect(parseMessageId("  abc123@example.com  ")).toBe("abc123@example.com");
  });

  it("normalises a Date header to RFC 3339", () => {
    expect(parseMailDate("Mon, 14 Sep 2026 08:30:00 +0000")).toBe("2026-09-14T08:30:00.000Z");
  });

  it("gives up rather than inventing a date", () => {
    expect(parseMailDate("")).toBe("");
    expect(parseMailDate("sometime last week")).toBe("");
  });
});

describe("Bulk mail", () => {
  it("recognises list and bulk headers", () => {
    expect(isBulk(parseHeaders("List-Id: <news.example.com>\r\n"))).toBe(true);
    expect(isBulk(parseHeaders("List-Unsubscribe: <https://example.com/u>\r\n"))).toBe(true);
    expect(isBulk(parseHeaders("Precedence: bulk\r\n"))).toBe(true);
  });

  it("leaves ordinary mail alone", () => {
    expect(isBulk(parseHeaders("Subject: Lunch?\r\nFrom: ada@example.com\r\n"))).toBe(false);
  });
});
