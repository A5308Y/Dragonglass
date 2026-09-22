import { describe, expect, it } from "vitest";
import {
  attributeSection,
  attributeText,
  decodeMailbox,
  encodeMailbox,
  findTextPart,
  flattenBodyStructure,
  formatSequenceSet,
  hasAttachment,
  imapDate,
  isTagged,
  MAX_LITERAL_BYTES,
  needsLiteral,
  parseCapabilities,
  parseExists,
  parseFetchResponse,
  parseListResponse,
  parseSearchUids,
  parseStatusCode,
  parseTagged,
  quoteString,
  takeResponse,
  tokenize,
  validateCriterion,
  type Token,
} from "../src/domain/imap-protocol";

describe("Reading responses off the wire", () => {
  it("takes one line and leaves the rest", () => {
    const taken = takeResponse("* OK ready\r\na1 OK done\r\n");
    expect(taken?.response.text).toBe("* OK ready");
    expect(taken?.rest).toBe("a1 OK done\r\n");
  });

  it("waits when the line is incomplete", () => {
    expect(takeResponse("* OK rea")).toBeNull();
  });

  it("keeps a literal and the text on both sides of it as one response", () => {
    const wire = "* 12 FETCH (UID 101 BODY[TEXT] {11}\r\nHello there)\r\nnext";
    const taken = takeResponse(wire);
    expect(taken?.response.text).toBe("* 12 FETCH (UID 101 BODY[TEXT] {11})");
    expect(taken?.response.literals).toEqual(["Hello there"]);
    expect(taken?.rest).toBe("next");
  });

  it("waits when a literal has not fully arrived", () => {
    expect(takeResponse("* 12 FETCH (BODY[TEXT] {11}\r\nHello")).toBeNull();
  });

  it("counts a literal in bytes, so CRLF inside it does not end the response", () => {
    const body = "line one\r\nline two";
    const taken = takeResponse(`* 1 FETCH (BODY[TEXT] {${body.length}}\r\n${body})\r\n`);
    expect(taken?.response.literals).toEqual([body]);
    expect(taken?.rest).toBe("");
  });

  it("handles several literals in one response", () => {
    const wire = "* 1 FETCH (BODY[HEADER] {3}\r\nabcBODY[TEXT] {2}\r\nhi)\r\n";
    expect(takeResponse(wire)?.response.literals).toEqual(["abc", "hi"]);
  });

  it("refuses an absurd literal rather than buffering it", () => {
    expect(() => takeResponse(`* 1 FETCH (BODY[TEXT] {${MAX_LITERAL_BYTES + 1}}\r\n`)).toThrow(/literal/);
  });
});

describe("Tagged completions", () => {
  it("recognises its own tag", () => {
    expect(isTagged("a3 OK done", "a3")).toBe(true);
    expect(isTagged("a30 OK done", "a3")).toBe(false);
    expect(isTagged("* OK untagged", "a3")).toBe(false);
  });

  it("reads the status and its detail", () => {
    expect(parseTagged("a3 NO [AUTHENTICATIONFAILED] bad password", "a3"))
      .toEqual({ status: "NO", detail: "[AUTHENTICATIONFAILED] bad password" });
    expect(parseTagged("a3 OK", "a3")).toEqual({ status: "OK", detail: "" });
    expect(parseTagged("* OK hi", "a3")).toBeNull();
  });
});

describe("Tokenizing", () => {
  it("reads atoms, quoted strings, and nested lists", () => {
    expect(tokenize('(UID 101 FLAGS (\\Seen \\Flagged) NAME "Ada Lovelace")')).toEqual([
      ["UID", "101", "FLAGS", ["\\Seen", "\\Flagged"], "NAME", "Ada Lovelace"],
    ]);
  });

  it("keeps a bracketed section attached to its atom", () => {
    expect(tokenize("BODY[HEADER.FIELDS (SUBJECT FROM)] {3}", ["abc"]))
      .toEqual(["BODY[HEADER.FIELDS (SUBJECT FROM)]", "abc"]);
  });

  it("unescapes a quoted string", () => {
    expect(tokenize('("a \\"b\\" c")')).toEqual([['a "b" c']]);
  });

  it("substitutes literals in the order their markers appear", () => {
    expect(tokenize("({2} {3})", ["hi", "bye"])).toEqual([["hi", "bye"]]);
  });
});

describe("Sequence sets", () => {
  it("compacts runs and keeps singles", () => {
    expect(formatSequenceSet([1, 2, 3, 4, 5, 8, 10, 11, 12])).toBe("1:5,8,10:12");
  });

  it("sorts and de-duplicates", () => {
    expect(formatSequenceSet([5, 1, 3, 1, 2])).toBe("1:3,5");
  });

  it("drops anything that is not a UID", () => {
    expect(formatSequenceSet([0, -1, 2.5, 7])).toBe("7");
    expect(formatSequenceSet([])).toBe("");
  });
});

describe("Building commands safely", () => {
  it("quotes and escapes", () => {
    expect(quoteString("INBOX")).toBe('"INBOX"');
    expect(quoteString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("refuses a newline, which would append a second command", () => {
    expect(() => quoteString("INBOX\r\na9 DELETE \"INBOX\"")).toThrow(/newline/);
    expect(() => quoteString("INBOX\nX")).toThrow(/newline/);
  });

  it("knows when a value cannot be sent as a quoted string", () => {
    expect(needsLiteral("simple")).toBe(false);
    expect(needsLiteral("Grüße")).toBe(true);
  });

  it("accepts ordinary search criteria", () => {
    expect(validateCriterion("ALL")).toBe("ALL");
    expect(validateCriterion("  UNSEEN  ")).toBe("UNSEEN");
    expect(validateCriterion("KEYWORD Dragonglass")).toBe("KEYWORD Dragonglass");
    expect(validateCriterion("")).toBe("ALL");
  });

  it("refuses a criterion that would smuggle in another command", () => {
    expect(() => validateCriterion('ALL\r\na9 DELETE "INBOX"')).toThrow(/criterion/);
    expect(() => validateCriterion("ALL\nX")).toThrow(/criterion/);
  });

  it("formats a SINCE date the way IMAP wants it", () => {
    expect(imapDate(new Date(2026, 0, 1))).toBe("01-Jan-2026");
    expect(imapDate(new Date(2026, 8, 14))).toBe("14-Sep-2026");
  });
});

describe("Reading untagged responses", () => {
  it("reads a SEARCH result", () => {
    expect(parseSearchUids("* SEARCH 1 4 9")).toEqual([1, 4, 9]);
    expect(parseSearchUids("* SEARCH")).toEqual([]);
    expect(parseSearchUids("* EXISTS 4")).toEqual([]);
  });

  it("reads a status code out of a response", () => {
    expect(parseStatusCode("* OK [UIDVALIDITY 1234] Ready", "UIDVALIDITY")).toBe("1234");
    expect(parseStatusCode("* OK [UIDNEXT 99] Ready", "UIDVALIDITY")).toBe("");
  });

  it("reads EXISTS and capabilities", () => {
    expect(parseExists("* 42 EXISTS")).toBe(42);
    expect(parseExists("* OK ready")).toBeNull();
    expect(parseCapabilities("* CAPABILITY IMAP4rev1 idle MOVE")).toEqual(["IMAP4REV1", "IDLE", "MOVE"]);
    expect(parseCapabilities("* OK [CAPABILITY IMAP4rev1 IDLE] ready")).toEqual(["IMAP4REV1", "IDLE"]);
  });

  it("reads a LIST line", () => {
    const listing = parseListResponse({ text: '* LIST (\\HasNoChildren) "/" "INBOX"', literals: [] });
    expect(listing).toEqual({ name: "INBOX", delimiter: "/", flags: ["\\HasNoChildren"] });
  });

  it("decodes a non-ASCII mailbox name from a LIST line", () => {
    const listing = parseListResponse({ text: '* LIST () "/" "Entw&APw-rfe"', literals: [] });
    expect(listing?.name).toBe("Entwürfe");
  });
});

describe("FETCH responses", () => {
  const response = {
    text: "* 12 FETCH (UID 101 RFC822.SIZE 4242 BODY[HEADER.FIELDS (SUBJECT)] {19})",
    literals: ["Subject: Lunch?\r\n\r\n"],
  };

  it("reads the sequence number and attributes", () => {
    const parsed = parseFetchResponse(response);
    expect(parsed?.sequence).toBe(12);
    expect(attributeText(parsed!.attributes, "UID")).toBe("101");
    expect(attributeText(parsed!.attributes, "RFC822.SIZE")).toBe("4242");
  });

  it("finds a section by its prefix, brackets and all", () => {
    const parsed = parseFetchResponse(response);
    expect(attributeSection(parsed!.attributes, "BODY[")).toBe("Subject: Lunch?\r\n\r\n");
  });

  it("ignores a response that is not a FETCH", () => {
    expect(parseFetchResponse({ text: "* 12 EXISTS", literals: [] })).toBeNull();
  });
});

describe("Body structures", () => {
  const single: Token = ["TEXT", "PLAIN", ["CHARSET", "UTF-8"], "NIL", "NIL", "7BIT", "1234", "20"];

  const alternative: Token = [
    ["TEXT", "PLAIN", ["CHARSET", "UTF-8"], "NIL", "NIL", "QUOTED-PRINTABLE", "500", "10"],
    ["TEXT", "HTML", ["CHARSET", "UTF-8"], "NIL", "NIL", "BASE64", "2000", "40"],
    "ALTERNATIVE",
  ];

  const withAttachment: Token = [
    alternative,
    ["APPLICATION", "PDF", ["NAME", "invoice.pdf"], "NIL", "NIL", "BASE64", "90000"],
    "MIXED",
  ];

  it("numbers a single-part message as part one", () => {
    expect(flattenBodyStructure(single)).toEqual([
      { path: "1", type: "text", subtype: "plain", charset: "UTF-8", encoding: "7bit", size: 1234 },
    ]);
  });

  it("numbers the children of a multipart", () => {
    expect(flattenBodyStructure(alternative).map((part) => part.path)).toEqual(["1", "2"]);
  });

  it("numbers nested parts by their full path", () => {
    expect(flattenBodyStructure(withAttachment).map((part) => part.path)).toEqual(["1.1", "1.2", "2"]);
  });

  it("prefers plain text, then falls back to HTML", () => {
    expect(findTextPart(flattenBodyStructure(alternative))?.subtype).toBe("plain");
    const htmlOnly = flattenBodyStructure([["TEXT", "HTML", ["CHARSET", "UTF-8"], "NIL", "NIL", "BASE64", "9", "1"], "ALTERNATIVE"]);
    expect(findTextPart(htmlOnly)?.subtype).toBe("html");
    expect(findTextPart([])).toBeNull();
  });

  it("carries the encoding and charset a fetch will need", () => {
    expect(findTextPart(flattenBodyStructure(alternative)))
      .toMatchObject({ path: "1", encoding: "quoted-printable", charset: "UTF-8", size: 500 });
    // The same subtree one level down is addressed by its full path.
    expect(findTextPart(flattenBodyStructure(withAttachment)))
      .toMatchObject({ path: "1.1", encoding: "quoted-printable", size: 500 });
  });

  it("notices a message that brought something with it", () => {
    expect(hasAttachment(flattenBodyStructure(withAttachment))).toBe(true);
    expect(hasAttachment(flattenBodyStructure(alternative))).toBe(false);
  });
});

describe("Mailbox names", () => {
  it("round-trips a non-ASCII name through modified UTF-7", () => {
    expect(decodeMailbox("Entw&APw-rfe")).toBe("Entwürfe");
    expect(encodeMailbox("Entwürfe")).toBe("Entw&APw-rfe");
    expect(decodeMailbox(encodeMailbox("Gelöschte Objekte"))).toBe("Gelöschte Objekte");
  });

  it("leaves an ASCII name alone", () => {
    expect(decodeMailbox("INBOX")).toBe("INBOX");
    expect(encodeMailbox("[Gmail]/All Mail")).toBe("[Gmail]/All Mail");
  });

  it("handles a literal ampersand", () => {
    expect(decodeMailbox("R&-D")).toBe("R&D");
    expect(encodeMailbox("R&D")).toBe("R&-D");
  });
});
