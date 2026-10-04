import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { MailService, type MailSettingsView, type MailTransport } from "../src/mail/mail-service";
import type { ImapSocket } from "../src/mail/imap-client";
import type { GtdRepository } from "../src/repository/gtd-repository";
import { mailboxState, parseMailStore, type MailAccount } from "../src/domain/mail";

interface FakeMessage {
  uid: number;
  messageId: string;
  subject: string;
  from: string;
  body: string;
}

/**
 * A mailbox that answers IMAP.
 *
 * Only the commands the sync loop actually issues are implemented, which is the
 * point: if the loop starts issuing something else, these tests stop working.
 */
class FakeMailbox {
  moved: number[] = [];
  commands: string[] = [];
  private data: ((chunk: string) => void) | null = null;

  constructor(
    private messages: FakeMessage[],
    private readonly uidValidity = 5150,
    private readonly capabilities = "IMAP4rev1 MOVE",
  ) {}

  socket(): ImapSocket {
    return {
      write: (raw) => this.handle(raw),
      onData: (listener) => {
        this.data = listener;
        queueMicrotask(() => listener(`* OK [CAPABILITY ${this.capabilities}] ready\r\n`));
      },
      onError: () => undefined,
      onClose: () => undefined,
      close: () => undefined,
    };
  }

  private handle(raw: string): void {
    const match = /^(\S+) ([\s\S]*)\r\n$/.exec(raw);
    if (!match) return;
    const tag = match[1] ?? "";
    const command = match[2] ?? "";
    this.commands.push(command);
    const reply = this.reply(command, tag);
    if (reply !== null) queueMicrotask(() => this.data?.(reply));
  }

  private reply(command: string, tag: string): string | null {
    const done = `${tag} OK done\r\n`;

    if (/^(EXAMINE|SELECT) /.test(command)) {
      return `* ${this.messages.length} EXISTS\r\n`
        + `* OK [UIDVALIDITY ${this.uidValidity}] valid\r\n`
        + done;
    }
    if (/^UID SEARCH /.test(command)) {
      const from = Number(/UID (\d+):\*/.exec(command)?.[1] ?? 1);
      const uids = this.messages.filter((message) => message.uid >= from).map((message) => message.uid);
      return `* SEARCH ${uids.join(" ")}\r\n${done}`;
    }
    if (/^UID FETCH .*BODYSTRUCTURE/.test(command)) {
      const wanted = parseSet(/^UID FETCH (\S+)/.exec(command)?.[1] ?? "");
      const lines = this.messages
        .filter((message) => wanted.has(message.uid))
        .map((message, index) => {
          const headers = `Message-ID: <${message.messageId}>\r\nSubject: ${message.subject}\r\n`
            + `From: ${message.from}\r\nDate: Mon, 14 Sep 2026 08:30:00 +0000\r\n\r\n`;
          return `* ${index + 1} FETCH (UID ${message.uid} `
            + `BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${message.body.length} 1) `
            + `BODY[HEADER.FIELDS (MESSAGE-ID)] {${headers.length}}\r\n${headers})\r\n`;
        });
      return lines.join("") + done;
    }
    if (/^UID FETCH \d+ \(BODY\.PEEK\[1\]\)/.test(command)) {
      const uid = Number(/^UID FETCH (\d+)/.exec(command)?.[1] ?? 0);
      const message = this.messages.find((entry) => entry.uid === uid);
      if (!message) return done;
      return `* 1 FETCH (UID ${uid} BODY[1] {${message.body.length}}\r\n${message.body})\r\n${done}`;
    }
    if (/^UID MOVE /.test(command)) {
      const uid = Number(/^UID MOVE (\d+)/.exec(command)?.[1] ?? 0);
      this.moved.push(uid);
      this.messages = this.messages.filter((entry) => entry.uid !== uid);
      return done;
    }
    return done;
  }

  /** Mail arriving after a sync. */
  deliver(...messages: FakeMessage[]): void {
    this.messages = [...this.messages, ...messages];
  }
}

function parseSet(set: string): Set<number> {
  const uids = new Set<number>();
  for (const piece of set.split(",")) {
    const range = /^(\d+):(\d+)$/.exec(piece);
    if (range) {
      for (let uid = Number(range[1]); uid <= Number(range[2]); uid += 1) uids.add(uid);
    } else if (/^\d+$/.test(piece)) uids.add(Number(piece));
  }
  return uids;
}

const message = (uid: number, subject = `Message ${uid}`): FakeMessage => ({
  uid,
  messageId: `id-${uid}@example.com`,
  subject,
  from: "Ada Lovelace <ada@example.com>",
  body: `Body of message ${uid}`,
});

const account = (changes: Partial<MailAccount> = {}): MailAccount => ({
  id: "acc1",
  label: "Work",
  host: "imap.example.com",
  port: 993,
  user: "ada@example.com",
  mailboxes: ["INBOX"],
  criterion: "ALL",
  archiveMailbox: "",
  enabled: true,
  ...changes,
});

describe("Mirroring a mailbox into the Inbox", () => {
  let files: Map<string, string>;
  let created: Array<{ title: string; details: string }>;
  let delegated: unknown[];
  let settings: MailSettingsView;

  const build = (mailbox: FakeMailbox, available = true) => {
    const app = {
      vault: {
        adapter: {
          read: async (path: string) => {
            const value = files.get(path);
            if (value === undefined) throw new Error("no such file");
            return value;
          },
          write: async (path: string, data: string) => void files.set(path, data),
          exists: async (path: string) => files.has(path),
          mkdir: async () => undefined,
        },
      },
    } as unknown as App;

    const repository = {
      createIdentifiedInboxItem: async (title: string, details: string) => {
        created.push({ title, details });
        return { id: `item-${created.length}` };
      },
      index: { getSnapshot: () => ({ actions: delegated }) },
    } as unknown as GtdRepository;

    const transport: MailTransport = { connect: async () => mailbox.socket(), available: () => available };
    return new MailService(app, repository, () => settings, () => "app-password", transport);
  };

  beforeEach(() => {
    files = new Map();
    created = [];
    delegated = [];
    settings = {
      enabled: true,
      storePath: "GTD/mail.json",
      refreshMinutes: 30,
      importCap: 50,
      accounts: [account()],
    };
  });

  const storedState = () => mailboxState(parseMailStore(JSON.parse(files.get("GTD/mail.json") ?? "{}")), "acc1", "INBOX");

  it("imports nothing at all the first time it connects", async () => {
    // The whole point: an existing mailbox is a starting point, not a backlog.
    const mailbox = new FakeMailbox([message(1), message(2), message(3)]);
    const result = await build(mailbox).importAll();

    expect(created).toEqual([]);
    expect(result).toMatchObject({ imported: 0, baselined: 1 });
    expect(storedState()).toMatchObject({ baselined: true, lastUid: 3 });
  });

  it("imports only what arrives after the baseline", async () => {
    const mailbox = new FakeMailbox([message(1), message(2)]);
    const service = build(mailbox);
    await service.importAll();

    mailbox.deliver(message(3, "Heat pump quote"));
    const result = await service.importAll();

    expect(result).toMatchObject({ imported: 1, baselined: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("Heat pump quote");
    expect(created[0]?.details).toContain("From: Ada Lovelace <ada@example.com>");
    expect(created[0]?.details).toContain("> Body of message 3");
  });

  it("links a reply to the Action it was delegated as", async () => {
    delegated = [{
      id: "01J9ZZZZZZZZZZZZZZABCDEFGH", title: "Book the plumber", delegatedTo: "ada@example.com",
      file: { path: "GTD/Actions/Book the plumber.md" },
    }];
    const mailbox = new FakeMailbox([message(1)]);
    const service = build(mailbox);
    await service.importAll();
    mailbox.deliver(message(2, "Re: Book the plumber [DG-ABCDEFGH]"), message(3, "Re: Something else"));
    await service.importAll();

    expect(created[0]?.details.split("\n")[0]).toBe(
      "Reply about the delegated Action [[GTD/Actions/Book the plumber|Book the plumber]]");
    expect(created[1]?.details).not.toContain("Reply about");
  });

  it("does not import the same message twice", async () => {
    const mailbox = new FakeMailbox([message(1)]);
    const service = build(mailbox);
    await service.importAll();
    mailbox.deliver(message(2));

    await service.importAll();
    await service.importAll();
    expect(created).toHaveLength(1);
  });

  it("only asks the server about mail above the watermark", async () => {
    const mailbox = new FakeMailbox([message(1), message(2), message(3)]);
    const service = build(mailbox);
    await service.importAll();
    mailbox.commands.length = 0;
    await service.importAll();

    expect(mailbox.commands).toContain("UID SEARCH UID 4:* ALL");
  });

  it("defers the rest of a bulk arrival and takes it on the next pass", async () => {
    const mailbox = new FakeMailbox([message(1)]);
    settings.importCap = 2;
    const service = build(mailbox);
    await service.importAll();

    mailbox.deliver(message(2), message(3), message(4), message(5), message(6));
    const first = await service.importAll();
    expect(first).toMatchObject({ imported: 2, deferred: 3 });
    expect(created).toHaveLength(2);

    const second = await service.importAll();
    expect(second).toMatchObject({ imported: 2, deferred: 1 });
    expect(created).toHaveLength(4);
  });

  it("walks a backlog oldest first, so nothing is stranded below the watermark", async () => {
    const mailbox = new FakeMailbox([message(1)]);
    settings.importCap = 2;
    const service = build(mailbox);
    await service.importAll();

    mailbox.deliver(message(2), message(3), message(4));
    await service.importAll();
    expect(created.map((item) => item.title)).toEqual(["Message 2", "Message 3"]);
    await service.importAll();
    expect(created.map((item) => item.title)).toEqual(["Message 2", "Message 3", "Message 4"]);
  });

  it("imports the backlog once it is asked to", async () => {
    const mailbox = new FakeMailbox([message(1), message(2)]);
    const service = build(mailbox);
    await service.importAll();
    expect(created).toEqual([]);

    await service.importBacklog("acc1", "INBOX");
    const result = await service.importAll();
    expect(result.imported).toBe(2);
  });
});

describe("Archiving what it imported", () => {
  let files: Map<string, string>;
  let settings: MailSettingsView;

  const build = (mailbox: FakeMailbox) => {
    const app = {
      vault: {
        adapter: {
          read: async (path: string) => {
            const value = files.get(path);
            if (value === undefined) throw new Error("no such file");
            return value;
          },
          write: async (path: string, data: string) => void files.set(path, data),
          exists: async () => true,
          mkdir: async () => undefined,
        },
      },
    } as unknown as App;
    const repository = {
      createIdentifiedInboxItem: async () => ({ id: "item" }),
    } as unknown as GtdRepository;
    return new MailService(app, repository, () => settings, () => "app-password", {
      connect: async () => mailbox.socket(),
      available: () => true,
    });
  };

  beforeEach(() => {
    files = new Map();
    settings = { enabled: true, storePath: "GTD/mail.json", refreshMinutes: 30, importCap: 50, accounts: [account()] };
  });

  it("leaves the server alone when no archive mailbox is set", async () => {
    const mailbox = new FakeMailbox([message(1)]);
    const service = build(mailbox);
    await service.importAll();
    mailbox.deliver(message(2));
    await service.importAll();

    expect(mailbox.moved).toEqual([]);
    expect(mailbox.commands).toContain('EXAMINE "INBOX"');
    expect(mailbox.commands.join(" ")).not.toContain("UID MOVE");
  });

  it("opens the mailbox for writing and moves what it imported", async () => {
    settings.accounts = [account({ archiveMailbox: "Archive" })];
    const mailbox = new FakeMailbox([message(1)]);
    const service = build(mailbox);
    await service.importAll();
    mailbox.deliver(message(2));
    const result = await service.importAll();

    // EXAMINE is read-only, so archiving has to SELECT from the start.
    expect(mailbox.commands).toContain('SELECT "INBOX"');
    expect(mailbox.moved).toEqual([2]);
    expect(result.unarchived).toBe(0);
  });

  it("keeps the Inbox Item when the move fails, and says the message stayed put", async () => {
    settings.accounts = [account({ archiveMailbox: "Archive" })];
    // A server with no MOVE falls back to COPY, which this one rejects.
    const mailbox = new (class extends FakeMailbox {
      constructor() {
        super([message(1)], 5150, "IMAP4rev1");
      }
    })();
    const service = build(mailbox);
    await service.importAll();
    mailbox.deliver(message(2));

    const result = await service.importAll();
    expect(result).toMatchObject({ imported: 1, unarchived: 0 });
  });
});

describe("When mail cannot be imported here", () => {
  it("says so rather than trying", async () => {
    const files = new Map<string, string>();
    const app = {
      vault: {
        adapter: {
          read: async () => {
            throw new Error("none");
          },
          write: async (path: string, data: string) => void files.set(path, data),
          exists: async () => true,
          mkdir: async () => undefined,
        },
      },
    } as unknown as App;
    const service = new MailService(
      app,
      { createIdentifiedInboxItem: async () => ({ id: "x" }) } as unknown as GtdRepository,
      () => ({ enabled: true, storePath: "GTD/mail.json", refreshMinutes: 30, importCap: 50, accounts: [account()] }),
      () => "app-password",
      {
        connect: async () => {
          throw new Error("should never be reached");
        },
        available: () => false,
      },
    );

    const result = await service.importAll();
    expect(result.imported).toBe(0);
    expect(result.idle).toBe(false);
    expect(service.getStatus().state).toBe("unavailable");
    expect(service.getStatus().error).toMatch(/desktop app/);
  });

  it("distinguishes having no configured mailbox from an empty mailbox", async () => {
    const app = {
      vault: {
        adapter: {
          read: async () => {
            throw new Error("none");
          },
        },
      },
    } as unknown as App;
    const service = new MailService(
      app,
      { createIdentifiedInboxItem: async () => ({ id: "x" }) } as unknown as GtdRepository,
      () => ({ enabled: true, storePath: "GTD/mail.json", refreshMinutes: 30, importCap: 50, accounts: [] }),
      () => "",
      {
        connect: async () => {
          throw new Error("should never be reached");
        },
        available: () => true,
      },
    );

    const result = await service.importAll();
    expect(result.idle).toBe(true);
    expect(service.getStatus()).toMatchObject({ state: "idle", result: { idle: true } });
  });
});
