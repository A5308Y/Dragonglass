import { describe, expect, it } from "vitest";
import { ImapConnection, type ImapSocket } from "../src/mail/imap-client";

/**
 * A mail server made of a lookup table.
 *
 * `respond` is handed the tag and the command and returns the raw reply, so a test
 * says what the server sends and then asserts on what was sent to it.
 */
class FakeServer implements ImapSocket {
  written: string[] = [];
  closed = false;
  private data: ((chunk: string) => void) | null = null;
  private errored: ((error: Error) => void) | null = null;
  private ended: (() => void) | null = null;

  constructor(
    private readonly respond: (command: string, tag: string) => string | null,
    private readonly greeting = "* OK [CAPABILITY IMAP4rev1 MOVE] ready\r\n",
  ) {}

  /** The commands sent, without their tags. */
  get commands(): string[] {
    return this.written.map((line) => line.replace(/^\S+ /, "").replace(/\r\n$/, ""));
  }

  write(data: string): void {
    this.written.push(data);
    const match = /^(\S+) ([\s\S]*)\r\n$/.exec(data);
    if (!match) return;
    const reply = this.respond(match[2] ?? "", match[1] ?? "");
    if (reply !== null) queueMicrotask(() => this.data?.(reply));
  }

  onData(listener: (chunk: string) => void): void {
    this.data = listener;
    queueMicrotask(() => listener(this.greeting));
  }

  onError(listener: (error: Error) => void): void {
    this.errored = listener;
  }

  onClose(listener: () => void): void {
    this.ended = listener;
  }

  close(): void {
    this.closed = true;
  }

  /** Drops the connection, as a server does when it gives up on you. */
  hangUp(): void {
    this.ended?.();
  }

  breakDown(message: string): void {
    this.errored?.(new Error(message));
  }
}

const ok = (tag: string) => `${tag} OK done\r\n`;

/** A server that answers every command with a bare OK, plus whatever a test adds. */
function serverWith(
  replies: Array<[RegExp, (tag: string) => string]> = [],
  greeting?: string,
): FakeServer {
  return new FakeServer((command, tag) => {
    for (const [pattern, reply] of replies) if (pattern.test(command)) return reply(tag);
    return ok(tag);
  }, greeting);
}

const connect = (server: FakeServer) => ImapConnection.open(async () => server, { host: "imap.example.com", port: 993 });

describe("Opening a session", () => {
  it("waits for the server to say it is ready", async () => {
    const connection = await connect(serverWith());
    expect(connection.supports("MOVE")).toBe(true);
    connection.close();
  });

  it("accepts a preauthenticated greeting", async () => {
    const connection = await connect(serverWith([], "* PREAUTH IMAP4rev1 ready\r\n"));
    connection.close();
  });

  it("refuses a greeting that is not a greeting", async () => {
    const server = serverWith([], "* BYE too many connections\r\n");
    await expect(connect(server)).rejects.toThrow(/refused the connection/);
    expect(server.closed).toBe(true);
  });
});

describe("Logging in", () => {
  it("sends the credentials quoted, then asks again what the server can do", async () => {
    const server = serverWith([[/^CAPABILITY$/, (tag) => `* CAPABILITY IMAP4rev1 MOVE UIDPLUS\r\n${ok(tag)}`]]);
    const connection = await connect(server);
    await connection.login("ada@example.com", "app-password");
    expect(server.commands).toContain('LOGIN "ada@example.com" "app-password"');
    expect(connection.supports("UIDPLUS")).toBe(true);
  });

  it("explains an authentication failure in terms of what to do about it", async () => {
    const server = serverWith([[/^LOGIN/, (tag) => `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`]]);
    const connection = await connect(server);
    await expect(connection.login("ada@example.com", "wrong")).rejects.toThrow(/app password/);
  });

  it("refuses a non-ASCII password rather than mangling it on the wire", async () => {
    const server = serverWith();
    const connection = await connect(server);
    await expect(connection.login("ada@example.com", "Grüße")).rejects.toThrow(/plain ASCII/);
    expect(server.commands).not.toContain(expect.stringContaining("LOGIN"));
  });

  it("says so when the server will not take a password at all", async () => {
    const server = serverWith([], "* OK [CAPABILITY IMAP4rev1 LOGINDISABLED] ready\r\n");
    const connection = await connect(server);
    await expect(connection.login("ada@example.com", "app-password")).rejects.toThrow(/disabled password login/);
  });
});

describe("Mailboxes", () => {
  it("lists them, decoding the non-ASCII names", async () => {
    const server = serverWith([[
      /^LIST/,
      (tag) => '* LIST (\\HasNoChildren) "/" "INBOX"\r\n'
        + '* LIST (\\HasNoChildren) "/" "Entw&APw-rfe"\r\n'
        + ok(tag),
    ]]);
    const connection = await connect(server);
    expect((await connection.listMailboxes()).map((mailbox) => mailbox.name)).toEqual(["INBOX", "Entwürfe"]);
  });

  it("opens one read-only and reads its state", async () => {
    const server = serverWith([[
      /^EXAMINE/,
      (tag) => "* 24 EXISTS\r\n* OK [UIDVALIDITY 918273] valid\r\n* OK [UIDNEXT 501] next\r\n" + ok(tag),
    ]]);
    const connection = await connect(server);
    expect(await connection.examine("INBOX")).toEqual({ uidValidity: 918_273, uidNext: 501, exists: 24 });
    expect(server.commands).toContain('EXAMINE "INBOX"');
  });

  it("encodes a non-ASCII mailbox name on the way out", async () => {
    const server = serverWith();
    const connection = await connect(server);
    await connection.examine("Entwürfe");
    expect(server.commands).toContain('EXAMINE "Entw&APw-rfe"');
  });

  it("reports a mailbox it cannot open", async () => {
    const server = serverWith([[/^EXAMINE/, (tag) => `${tag} NO Mailbox does not exist\r\n`]]);
    const connection = await connect(server);
    await expect(connection.examine("Nope")).rejects.toThrow(/mailbox could not be opened/i);
  });
});

describe("Searching", () => {
  it("asks only about mail above the watermark", async () => {
    const server = serverWith([[/^UID SEARCH/, (tag) => `* SEARCH 41 42 43\r\n${ok(tag)}`]]);
    const connection = await connect(server);
    expect(await connection.searchUids({ criterion: "ALL", fromUid: 41 })).toEqual([41, 42, 43]);
    expect(server.commands).toContain("UID SEARCH UID 41:* ALL");
  });

  it("adds a date floor when one is set", async () => {
    const server = serverWith([[/^UID SEARCH/, (tag) => `* SEARCH\r\n${ok(tag)}`]]);
    const connection = await connect(server);
    await connection.searchUids({ criterion: "UNSEEN", fromUid: 1, since: new Date(2026, 0, 1) });
    expect(server.commands).toContain("UID SEARCH UID 1:* SINCE 01-Jan-2026 UNSEEN");
  });

  it("discards the straggler that `n:*` always returns", async () => {
    // A range whose start is past the last UID still comes back with the last message.
    const server = serverWith([[/^UID SEARCH/, (tag) => `* SEARCH 12\r\n${ok(tag)}`]]);
    const connection = await connect(server);
    expect(await connection.searchUids({ criterion: "ALL", fromUid: 99 })).toEqual([]);
  });

  it("refuses a criterion carrying a second command", async () => {
    const connection = await connect(serverWith());
    await expect(connection.searchUids({ criterion: 'ALL"\r\nx DELETE "INBOX', fromUid: 1 }))
      .rejects.toThrow(/criterion/);
  });
});

describe("Fetching summaries", () => {
  const headers = "Message-ID: <abc@example.com>\r\n"
    + "Subject: =?UTF-8?Q?Heat_pump_quote?=\r\n"
    + "From: Ada Lovelace <ada@example.com>\r\n"
    + "Date: Mon, 14 Sep 2026 08:30:00 +0000\r\n"
    + "\r\n";

  const structure = '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 500 10)'
    + '("APPLICATION" "PDF" ("NAME" "quote.pdf") NIL NIL "BASE64" 90000) "MIXED")';

  const summaryServer = () => serverWith([[
    /^UID FETCH .* BODYSTRUCTURE/,
    (tag) => `* 7 FETCH (UID 42 BODYSTRUCTURE ${structure} BODY[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM DATE)] {${headers.length}}\r\n${headers})\r\n${ok(tag)}`,
  ]]);

  it("compacts the UIDs it asks about into a range", async () => {
    const server = summaryServer();
    const connection = await connect(server);
    await connection.fetchSummaries([42, 43, 44, 90]);
    expect(server.commands[0]).toMatch(/^UID FETCH 42:44,90 \(UID BODYSTRUCTURE BODY\.PEEK\[HEADER\.FIELDS \(/);
  });

  it("reads the headers it asked for, decoded", async () => {
    const connection = await connect(summaryServer());
    const [summary] = await connection.fetchSummaries([42]);
    expect(summary).toMatchObject({
      uid: 42,
      messageId: "abc@example.com",
      subject: "Heat pump quote",
      from: "Ada Lovelace <ada@example.com>",
      date: "2026-09-14T08:30:00.000Z",
      hasAttachment: true,
      bulk: false,
    });
  });

  it("locates the text part without fetching it", async () => {
    const connection = await connect(summaryServer());
    const [summary] = await connection.fetchSummaries([42]);
    expect(summary?.textPart).toEqual({ path: "1", encoding: "quoted-printable", charset: "UTF-8", subtype: "plain", size: 500 });
  });

  it("notices a mailing list from its own headers", async () => {
    const listHeaders = "Message-ID: <n@example.com>\r\nSubject: Weekly\r\nList-Id: <news.example.com>\r\n\r\n";
    const server = serverWith([[
      /^UID FETCH/,
      (tag) => `* 1 FETCH (UID 5 BODYSTRUCTURE ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1) BODY[HEADER.FIELDS (X)] {${listHeaders.length}}\r\n${listHeaders})\r\n${ok(tag)}`,
    ]]);
    const connection = await connect(server);
    expect((await connection.fetchSummaries([5]))[0]?.bulk).toBe(true);
  });

  it("asks about nothing when given no UIDs", async () => {
    const server = summaryServer();
    const connection = await connect(server);
    expect(await connection.fetchSummaries([])).toEqual([]);
    expect(server.commands).toEqual([]);
  });
});

describe("Fetching text", () => {
  const part = { path: "1.1", encoding: "quoted-printable", charset: "UTF-8", subtype: "plain", size: 40 };

  it("fetches the located part and decodes it", async () => {
    const body = "Attached is the caf=C3=A9 quote";
    const server = serverWith([[
      /^UID FETCH 42 \(BODY\.PEEK\[1\.1\]\)/,
      (tag) => `* 7 FETCH (UID 42 BODY[1.1] {${body.length}}\r\n${body})\r\n${ok(tag)}`,
    ]]);
    const connection = await connect(server);
    expect(await connection.fetchText(42, part)).toBe("Attached is the café quote");
    expect(server.commands).toContain("UID FETCH 42 (BODY.PEEK[1.1])");
  });

  it("flattens an HTML part", async () => {
    const body = "<p>Quote <b>attached</b></p>";
    const server = serverWith([[
      /^UID FETCH/,
      (tag) => `* 1 FETCH (UID 9 BODY[2] {${body.length}}\r\n${body})\r\n${ok(tag)}`,
    ]]);
    const connection = await connect(server);
    const html = { path: "2", encoding: "7bit", charset: "utf-8", subtype: "html", size: 40 };
    expect(await connection.fetchText(9, html)).toBe("Quote attached");
  });

  it("skips an oversized part without a round trip", async () => {
    const server = serverWith();
    const connection = await connect(server);
    expect(await connection.fetchText(42, { ...part, size: 9_000_000 })).toBe("");
    expect(server.commands).toEqual([]);
  });

  it("returns nothing when the message has no text at all", async () => {
    const connection = await connect(serverWith());
    expect(await connection.fetchText(42, null)).toBe("");
  });
});

describe("Moving a message out of the mailbox", () => {
  it("uses MOVE where the server offers it", async () => {
    const server = serverWith();
    const connection = await connect(server);
    await connection.moveMessage(42, "Archive");
    expect(server.commands).toEqual(['UID MOVE 42 "Archive"']);
  });

  it("falls back to COPY and a flag, and never expunges", async () => {
    const server = serverWith([], "* OK [CAPABILITY IMAP4rev1] ready\r\n");
    const connection = await connect(server);
    await connection.moveMessage(42, "Archive");
    expect(server.commands).toEqual(['UID COPY 42 "Archive"', "UID STORE 42 +FLAGS (\\Deleted)"]);
    expect(server.commands.join(" ")).not.toContain("EXPUNGE");
  });
});

describe("When the connection goes wrong", () => {
  it("reports a server that hangs up mid-command", async () => {
    const server = new FakeServer(() => null);
    const connection = await connect(server);
    const pending = connection.examine("INBOX");
    queueMicrotask(() => server.hangUp());
    await expect(pending).rejects.toThrow(/closed the connection/);
  });

  it("reports a transport error", async () => {
    const server = new FakeServer(() => null);
    const connection = await connect(server);
    const pending = connection.examine("INBOX");
    queueMicrotask(() => server.breakDown("socket hang up"));
    await expect(pending).rejects.toThrow(/socket hang up/);
  });

  it("refuses further commands once it has failed", async () => {
    const server = new FakeServer(() => null);
    const connection = await connect(server);
    const pending = connection.examine("INBOX");
    queueMicrotask(() => server.breakDown("gone"));
    await expect(pending).rejects.toThrow();
    await expect(connection.examine("INBOX")).rejects.toThrow(/gone/);
  });

  it("closes the socket on logout even when the server has already gone", async () => {
    const server = new FakeServer(() => null);
    const connection = await connect(server);
    queueMicrotask(() => server.hangUp());
    await connection.logout();
    expect(server.closed).toBe(true);
  });
});
