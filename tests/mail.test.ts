import { describe, expect, it } from "vitest";
import {
  openBacklog,
  emptyMailboxState,
  emptyMailStore,
  findAccount,
  forgetAccount,
  mailboxKey,
  mailboxState,
  normalizeMailPort,
  parseMailStore,
  planImport,
  recordHandled,
  reconcileValidity,
  searchFromUid,
  SEEN_MESSAGE_LIMIT,
  withMailboxState,
  withSyncError,
  type MailAccount,
  type MailboxState,
  type MailCandidate,
} from "../src/domain/mail";
import { formatSender, mailItemNote, mailItemTitle, type MailMessage } from "../src/domain/mail-note";

const stateWith = (changes: Partial<MailboxState> = {}): MailboxState => ({ ...emptyMailboxState(), ...changes });
const candidate = (uid: number, messageId = `id-${uid}@example.com`): MailCandidate => ({ uid, messageId });
/** A mailbox that has already been baselined, which is the ordinary steady state. */
const ready = (changes: Partial<MailboxState> = {}) => stateWith({ baselined: true, ...changes });

describe("The day-one baseline", () => {
  it("imports nothing the first time it sees a mailbox", () => {
    const plan = planImport(emptyMailboxState(), [candidate(1), candidate(2), candidate(3)]);
    expect(plan).toEqual({ baseline: true, selected: [], skipped: 3, deferred: 0 });
  });

  it("records where to start, so the next sync only sees new mail", () => {
    const recorded = recordHandled(emptyMailboxState(), [candidate(1), candidate(7)], { fetchedAt: "now", uidValidity: 42 });
    expect(recorded.baselined).toBe(true);
    expect(recorded.lastUid).toBe(7);
    expect(searchFromUid(recorded)).toBe(8);
  });

  it("can be reopened deliberately, for when the backlog is wanted after all", () => {
    const reopened = openBacklog(ready({ lastUid: 900, seen: ["a@example.com"] }));
    expect(reopened).toMatchObject({ lastUid: 0, seen: [] });
    // Still baselined, so the next sync imports the backlog rather than skipping it again.
    const plan = planImport(reopened, [candidate(1), candidate(2)]);
    expect(plan.baseline).toBe(false);
    expect(plan.selected).toHaveLength(2);
  });
});

describe("Planning an import", () => {
  it("takes everything new once a mailbox is baselined", () => {
    const plan = planImport(ready(), [candidate(5), candidate(6)]);
    expect(plan.baseline).toBe(false);
    expect(plan.selected.map((entry) => entry.uid)).toEqual([5, 6]);
    expect(plan).toMatchObject({ skipped: 0, deferred: 0 });
  });

  it("skips a message already turned into an Inbox Item", () => {
    const plan = planImport(ready({ seen: ["id-5@example.com"] }), [candidate(5), candidate(6)]);
    expect(plan.selected.map((entry) => entry.uid)).toEqual([6]);
    expect(plan.skipped).toBe(1);
  });

  it("works oldest first, so the watermark can never step over a deferred message", () => {
    const plan = planImport(ready(), [candidate(9), candidate(3), candidate(6)], { cap: 2 });
    expect(plan.selected.map((entry) => entry.uid)).toEqual([3, 6]);
    expect(plan.deferred).toBe(1);

    // The watermark advances only over what was imported; 9 is still ahead of it.
    const recorded = recordHandled(ready(), plan.selected, { fetchedAt: "now" });
    expect(searchFromUid(recorded)).toBe(7);
  });

  it("defers the rest of a surprise bulk move rather than importing all of it", () => {
    const many = Array.from({ length: 500 }, (_unused, index) => candidate(index + 1));
    const plan = planImport(ready(), many, { cap: 50 });
    expect(plan.selected).toHaveLength(50);
    expect(plan.deferred).toBe(450);
  });

  it("still imports a message that gave no Message-ID", () => {
    const plan = planImport(ready({ seen: [""] }), [{ uid: 4, messageId: "" }]);
    expect(plan.selected.map((entry) => entry.uid)).toEqual([4]);
  });

  it("ignores anything that is not a UID", () => {
    const plan = planImport(ready(), [{ uid: 0, messageId: "a" }, { uid: -2, messageId: "b" }, candidate(3)]);
    expect(plan.selected.map((entry) => entry.uid)).toEqual([3]);
  });
});

describe("Recording what was handled", () => {
  it("only ever moves the watermark forward", () => {
    const recorded = recordHandled(ready({ lastUid: 90 }), [candidate(5)], { fetchedAt: "now" });
    expect(recorded.lastUid).toBe(90);
  });

  it("leaves the watermark alone when nothing was handled", () => {
    expect(recordHandled(ready({ lastUid: 12 }), [], { fetchedAt: "now" }).lastUid).toBe(12);
  });

  it("clears a previous error and stamps the sync", () => {
    const recorded = recordHandled(ready({ error: "boom" }), [candidate(1)], { fetchedAt: "2026-09-22T00:00:00.000Z" });
    expect(recorded.error).toBe("");
    expect(recorded.fetched).toBe("2026-09-22T00:00:00.000Z");
  });

  it("caps remembered Message-IDs, dropping the oldest", () => {
    const seen = Array.from({ length: SEEN_MESSAGE_LIMIT }, (_unused, index) => `old-${index}@example.com`);
    const recorded = recordHandled(ready({ seen }), [candidate(1, "fresh@example.com")], { fetchedAt: "now" });
    expect(recorded.seen).toHaveLength(SEEN_MESSAGE_LIMIT);
    expect(recorded.seen).not.toContain("old-0@example.com");
    expect(recorded.seen.at(-1)).toBe("fresh@example.com");
  });

  it("keeps a sync error without disturbing the watermark", () => {
    const failed = withSyncError(ready({ lastUid: 7 }), "Connection refused.", "now");
    expect(failed).toMatchObject({ lastUid: 7, error: "Connection refused.", fetched: "now" });
  });
});

describe("UIDVALIDITY", () => {
  it("reopens the UID window but keeps what it has already imported", () => {
    const reconciled = reconcileValidity(ready({ uidValidity: 1, lastUid: 900, seen: ["a@example.com"] }), 2);
    expect(reconciled).toMatchObject({ uidValidity: 2, lastUid: 0, baselined: true, seen: ["a@example.com"] });
    // The Message-ID is what stops a renumbered mailbox importing itself again.
    expect(planImport(reconciled, [candidate(1, "a@example.com")]).selected).toEqual([]);
  });

  it("leaves an unchanged mailbox exactly as it was", () => {
    const state = ready({ uidValidity: 7, lastUid: 90 });
    expect(reconcileValidity(state, 7)).toBe(state);
    expect(reconcileValidity(state, 0)).toBe(state);
  });
});

describe("The store file", () => {
  it("returns an empty store for anything that is not one", () => {
    for (const raw of [null, 7, "text", [], undefined]) expect(parseMailStore(raw)).toEqual(emptyMailStore());
  });

  it("round-trips a mailbox's state", () => {
    const store = withMailboxState(emptyMailStore(), "acc1", "INBOX", ready({ lastUid: 12, seen: ["a@example.com"] }));
    const reread = parseMailStore(JSON.parse(JSON.stringify(store)));
    expect(mailboxState(reread, "acc1", "INBOX")).toMatchObject({ lastUid: 12, baselined: true, seen: ["a@example.com"] });
  });

  it("keeps state for an account this device has not been given", () => {
    // Accounts live in plugin settings, which need not have synced; the watermark must survive.
    const reread = parseMailStore({ states: { "unknown-account:INBOX": { lastUid: 5, baselined: true } } });
    expect(mailboxState(reread, "unknown-account", "INBOX").lastUid).toBe(5);
  });

  it("repairs nonsense fields rather than failing", () => {
    const reread = parseMailStore({ states: { "a:INBOX": { lastUid: -3, uidValidity: "x", seen: [1, "ok@example.com"], baselined: "yes" } } });
    expect(mailboxState(reread, "a", "INBOX")).toMatchObject({ lastUid: 0, uidValidity: 0, seen: ["ok@example.com"], baselined: false });
  });

  it("reports an untouched mailbox as empty", () => {
    expect(mailboxState(emptyMailStore(), "nobody", "INBOX")).toEqual(emptyMailboxState());
  });

  it("separates the account from a mailbox name containing a colon", () => {
    const store = withMailboxState(emptyMailStore(), "acc1", "Odd:Name", ready({ lastUid: 4 }));
    expect(Object.keys(store.states)).toEqual(["acc1:Odd:Name"]);
    expect(mailboxState(store, "acc1", "Odd:Name").lastUid).toBe(4);
    expect(mailboxKey("acc1", "INBOX")).toBe("acc1:INBOX");
  });

  it("forgets one account without touching another", () => {
    let store = withMailboxState(emptyMailStore(), "acc1", "INBOX", ready({ lastUid: 1 }));
    store = withMailboxState(store, "acc2", "INBOX", ready({ lastUid: 2 }));
    const pruned = forgetAccount(store, "acc1");
    expect(Object.keys(pruned.states)).toEqual(["acc2:INBOX"]);
  });
});

describe("Account settings", () => {
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

  it("finds an account by id", () => {
    expect(findAccount([account()], "acc1")?.label).toBe("Work");
    expect(findAccount([account()], "missing")).toBeUndefined();
  });

  it("refuses the cleartext IMAP port", () => {
    // 143 is unencrypted; correcting it beats sending a password in the open.
    expect(normalizeMailPort(143)).toBe(993);
  });

  it("falls back to implicit TLS for anything unusable", () => {
    for (const port of [0, -1, 70_000, 1.5, "abc", null, undefined]) expect(normalizeMailPort(port)).toBe(993);
  });

  it("keeps a deliberate non-standard port", () => {
    expect(normalizeMailPort(1993)).toBe(1993);
  });
});

describe("What an imported message becomes", () => {
  const message = (changes: Partial<MailMessage> = {}): MailMessage => ({
    messageId: "abc123@example.com",
    accountId: "acc1",
    mailbox: "INBOX",
    uid: 42,
    subject: "Heat pump quote",
    from: "Ada Lovelace <ada@example.com>",
    date: "2026-09-14T08:30:00.000Z",
    body: "Attached is the quote you asked for.",
    hasAttachment: true,
    ...changes,
  });

  it("leads with the sender and records the way back to the original", () => {
    expect(mailItemNote(message(), "Work")).toBe(
      "From: Ada Lovelace <ada@example.com>\n"
      + "Date: 2026-09-14\n"
      + "Mailbox: Work · INBOX\n"
      + "Message-ID: abc123@example.com\n"
      + "Attachments: yes\n"
      + "\n"
      + "> Attached is the quote you asked for.",
    );
  });

  it("omits what a message does not carry", () => {
    expect(mailItemNote(message({ from: "", date: "", messageId: "", body: "", hasAttachment: false }), ""))
      .toBe("Mailbox: INBOX");
  });

  it("titles an Item by its subject, and says so when there is none", () => {
    expect(mailItemTitle(message())).toBe("Heat pump quote");
    expect(mailItemTitle(message({ subject: "   " }))).toBe("(No subject)");
  });

  it("keeps a sender from writing into the vault graph", () => {
    const hostile = message({
      subject: "hi",
      from: '"[[Replace heating system]]" <spam@example.com>',
      body: "See [[Secret Project]] and #urgent",
    });
    const note = mailItemNote(hostile, "Work");
    expect(note).toContain("\\[\\[Replace heating system\\]\\]");
    expect(note).toContain("\\[\\[Secret Project\\]\\]");
    expect(note).toContain("\\#urgent");
  });

  it("flattens markup a sender used in the body", () => {
    expect(mailItemNote(message({ body: "<p>Quote <b>attached</b></p>" }), "Work"))
      .toContain("> Quote attached");
  });
});

describe("Naming a sender", () => {
  it("shows the name and the address together, since a display name is chosen by the sender", () => {
    expect(formatSender("Ada Lovelace <ada@example.com>")).toBe("Ada Lovelace <ada@example.com>");
  });

  it("falls back to whichever half it has", () => {
    expect(formatSender("ada@example.com")).toBe("ada@example.com");
    expect(formatSender("Mailer Daemon")).toBe("Mailer Daemon");
    expect(formatSender("")).toBe("");
  });
});
