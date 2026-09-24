/**
 * Mail accounts and the bookkeeping that keeps an import from running away.
 *
 * A mirrored mailbox is a queue Dragonglass drains: every message it accepts becomes
 * an Inbox Item straight away, so there is no mail-shaped list inside the plugin and
 * nothing here describes a message. What is recorded is only what has already been
 * dealt with, which is the entire defence against importing a decade of mail twice.
 *
 * Three guards, in the order they bite:
 *
 *  - A new mailbox is **baselined**: its current contents are recorded as the
 *    starting point and none of them are imported. Whatever is in there when you
 *    connect stays where it is.
 *  - `lastUid` marks the point below which everything has been considered, so an
 *    ordinary sync asks the server about new mail only.
 *  - `seen` holds Message-IDs as a second line of defence, for when UIDs are reset
 *    or two machines sync the same mailbox at once.
 */

export const MAIL_STORE_VERSION = 1;

/** How many Message-IDs one mailbox remembers. `lastUid` does the real work. */
export const SEEN_MESSAGE_LIMIT = 1_000;

/** How many messages one sync will turn into Inbox Items before deferring the rest. */
export const DEFAULT_IMPORT_CAP = 50;

export interface MailAccount {
  /** A ULID, so relabelling an account or correcting its host keeps its sync state. */
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  /** The mailboxes mirrored into the Inbox, usually just `INBOX`. */
  mailboxes: string[];
  /** An IMAP SEARCH criterion narrowing what counts, such as `ALL` or `UNSEEN`. */
  criterion: string;
  /**
   * Where a message goes once it has become an Inbox Item, or `""` to leave the
   * server untouched. Empty means the mail stays put and your mail client still
   * shows it, which is safe but leaves you two queues to drain.
   */
  archiveMailbox: string;
  /** Whether imported notes link back to the message in Apple Mail; see `appleMailLink`. */
  appleMailLink?: boolean;
  enabled: boolean;
}

export interface MailboxState {
  /** The server's UIDVALIDITY when these UIDs were recorded. */
  uidValidity: number;
  /** Everything at or below this UID has been considered. */
  lastUid: number;
  /** Message-IDs already turned into Inbox Items, oldest first, capped. */
  seen: string[];
  /** Set once the mailbox's existing contents have been recorded as the starting point. */
  baselined: boolean;
  /** When this mailbox was last synced, successfully or not. */
  fetched: string;
  /** Why the last sync failed, or `""`. */
  error: string;
}

export interface MailStoreData {
  version: number;
  /** Keyed by `accountId:mailbox`. */
  states: Record<string, MailboxState>;
}

export function emptyMailboxState(): MailboxState {
  return { uidValidity: 0, lastUid: 0, seen: [], baselined: false, fetched: "", error: "" };
}

export function emptyMailStore(): MailStoreData {
  return { version: MAIL_STORE_VERSION, states: {} };
}

/** A ULID never contains a colon, so the first one always separates the two parts. */
export function mailboxKey(accountId: string, mailbox: string): string {
  return `${accountId}:${mailbox}`;
}

/**
 * Reads a store file without trusting it.
 *
 * Unlike the feed store, state for an unrecognised account is kept rather than
 * dropped: accounts live in the plugin's own settings while this file lives in the
 * vault, so a machine that has not been given the account still must not forget what
 * the machine that has already imported.
 */
export function parseMailStore(raw: unknown): MailStoreData {
  if (!isRecord(raw)) return emptyMailStore();
  const states: Record<string, MailboxState> = {};
  if (isRecord(raw.states)) {
    for (const [key, value] of Object.entries(raw.states)) {
      if (key) states[key] = parseMailboxState(value);
    }
  }
  return { version: MAIL_STORE_VERSION, states };
}

export function mailboxState(store: MailStoreData, accountId: string, mailbox: string): MailboxState {
  return store.states[mailboxKey(accountId, mailbox)] ?? emptyMailboxState();
}

export function withMailboxState(
  store: MailStoreData,
  accountId: string,
  mailbox: string,
  next: MailboxState,
): MailStoreData {
  return { ...store, states: { ...store.states, [mailboxKey(accountId, mailbox)]: next } };
}

/** Drops everything remembered about an account, for when it is removed. */
export function forgetAccount(store: MailStoreData, accountId: string): MailStoreData {
  const states: Record<string, MailboxState> = {};
  for (const [key, value] of Object.entries(store.states)) {
    if (!key.startsWith(`${accountId}:`)) states[key] = value;
  }
  return { ...store, states };
}

/**
 * Reconciles stored UIDs against the server's current UIDVALIDITY.
 *
 * A changed UIDVALIDITY means every UID we hold refers to nothing, so the UID window
 * reopens from the beginning. `seen` survives it, because a Message-ID means the same
 * thing whatever the server has done to its numbering — which is what keeps a
 * renumbered mailbox from re-importing itself.
 */
export function reconcileValidity(state: MailboxState, uidValidity: number): MailboxState {
  if (!uidValidity || state.uidValidity === uidValidity) return state;
  return { ...state, uidValidity, lastUid: 0 };
}

/** The lowest UID a search still needs to ask about. */
export function searchFromUid(state: MailboxState): number {
  return state.lastUid + 1;
}

export interface MailCandidate {
  uid: number;
  /** The `Message-ID`, or `""` when the sender omitted one. */
  messageId: string;
}

export interface ImportPlan {
  /** True when this run only records where to start, importing nothing. */
  baseline: boolean;
  /** What to fetch and turn into Inbox Items, oldest first. */
  selected: MailCandidate[];
  /** Candidates already dealt with. */
  skipped: number;
  /** Candidates past the cap, which the next sync will pick up. */
  deferred: number;
}

/**
 * Decides what a sync actually imports.
 *
 * Oldest first, deliberately: it means everything at or below the highest UID
 * imported has been handled, so `lastUid` can advance without stepping over a
 * message that was deferred for being past the cap. Taking the newest first would
 * leave holes below the watermark that nothing would ever come back for.
 *
 * A candidate with no Message-ID is still importable — it is identified by its UID
 * for this pass — but it cannot be remembered across a UID reset, which is a fair
 * trade for mail that failed to identify itself.
 */
export function planImport(
  state: MailboxState,
  candidates: readonly MailCandidate[],
  options: { cap?: number } = {},
): ImportPlan {
  const cap = Math.max(1, options.cap ?? DEFAULT_IMPORT_CAP);
  const ordered = [...candidates]
    .filter((candidate) => Number.isInteger(candidate.uid) && candidate.uid > 0)
    .sort((left, right) => left.uid - right.uid);

  if (!state.baselined) return { baseline: true, selected: [], skipped: ordered.length, deferred: 0 };

  const resolved = new Set(state.seen);
  const pending: MailCandidate[] = [];
  let skipped = 0;
  for (const candidate of ordered) {
    if (candidate.messageId && resolved.has(candidate.messageId)) skipped += 1;
    else pending.push(candidate);
  }

  return {
    baseline: false,
    selected: pending.slice(0, cap),
    skipped,
    deferred: Math.max(0, pending.length - cap),
  };
}

/**
 * Advances the watermark over messages that have been dealt with.
 *
 * Called after the Inbox Items exist, never before: a crash between the two should
 * cost a repeated import, not a message that was silently marked handled and never
 * written anywhere.
 */
export function recordHandled(
  state: MailboxState,
  handled: readonly MailCandidate[],
  options: { uidValidity?: number; fetchedAt: string },
): MailboxState {
  const uids = handled.map((candidate) => candidate.uid).filter((uid) => Number.isInteger(uid) && uid > 0);
  const messageIds = handled.map((candidate) => candidate.messageId).filter(Boolean);
  return {
    ...state,
    uidValidity: options.uidValidity ?? state.uidValidity,
    lastUid: Math.max(state.lastUid, ...(uids.length ? uids : [state.lastUid])),
    seen: capSeen([...state.seen, ...messageIds]),
    baselined: true,
    fetched: options.fetchedAt,
    error: "",
  };
}

export function withSyncError(state: MailboxState, message: string, fetchedAt: string): MailboxState {
  return { ...state, fetched: fetchedAt, error: message };
}

/**
 * Reopens a mailbox so the next sync imports what is already in it.
 *
 * The deliberate opposite of the day-one guard, for when the backlog is wanted after
 * all. Note that `baselined` stays set: clearing it would only make the next sync
 * take a fresh baseline and import nothing again. What reopens the mailbox is
 * dropping the watermark, so everything falls back inside the search window.
 */
export function openBacklog(state: MailboxState): MailboxState {
  return { ...state, baselined: true, lastUid: 0, seen: [] };
}

export function findAccount(accounts: readonly MailAccount[], accountId: string): MailAccount | undefined {
  return accounts.find((account) => account.id === accountId);
}

export interface MailImportResult {
  imported: number;
  /** Messages matched but held back by the cap, which the next import will take. */
  deferred: number;
  /** Mailboxes whose existing contents were recorded as a starting point. */
  baselined: number;
  failed: number;
  /** Messages whose Inbox Item exists but which could not be archived. */
  unarchived: number;
  /** Set when there was nothing to run: no enabled account with a mailbox. */
  idle: boolean;
}

export function emptyImportResult(): MailImportResult {
  return { imported: 0, deferred: 0, baselined: 0, failed: 0, unarchived: 0, idle: false };
}

/**
 * Says what an import actually did.
 *
 * Importing nothing is the correct outcome in three quite different situations — a
 * mailbox's first sync, a mailbox with no new mail, and a mailbox that could not be
 * opened at all — and reporting all three as "0 imported" makes a working import
 * look broken. Each gets its own sentence.
 */
export function describeImport(result: MailImportResult, error = ""): string {
  if (result.idle) return "No enabled account has a mailbox to import from.";

  const parts: string[] = [];
  if (result.baselined) {
    parts.push(
      `${result.baselined} mailbox${result.baselined === 1 ? "" : "es"} set to start from now — `
      + "existing mail was left alone, and new mail will be imported from here",
    );
  }
  if (result.imported) parts.push(`${result.imported} message${result.imported === 1 ? "" : "s"} imported`);
  if (result.deferred) parts.push(`${result.deferred} waiting for the next import`);
  if (result.unarchived) parts.push(`${result.unarchived} could not be archived`);
  if (result.failed) parts.push(`${result.failed} failed${error ? `: ${error}` : ""}`);

  // A platform or service-level failure can prevent an import before an account is
  // attempted, so it has no failed count of its own. Do not call that "no new mail".
  if (!parts.length && error) return error;
  // The quiet, ordinary case, which otherwise reads as a failure.
  if (!parts.length) return "No new mail since the last import.";
  return parts.join(" · ");
}

/**
 * Where one mailbox has got to, for the settings tab.
 *
 * The one place that can distinguish "nothing to import" from "never managed to
 * read this mailbox", which is the question anyone debugging an empty import has.
 */
export function describeMailboxState(state: MailboxState): string {
  const parts: string[] = [];
  if (!state.baselined) parts.push("Not yet synced — the next import records where to start and imports nothing");
  else if (state.lastUid) parts.push(`Importing mail above UID ${state.lastUid}`);
  else parts.push("Importing all new mail");

  if (state.fetched) parts.push(`last checked ${state.fetched.slice(0, 16).replace("T", " ")}`);
  if (state.seen.length) parts.push(`${state.seen.length} remembered`);
  if (state.error) parts.push(`Error: ${state.error}`);
  return parts.join(" · ");
}

/**
 * A port is only ever the implicit-TLS one unless the user says otherwise.
 *
 * 143 is cleartext IMAP; Dragonglass does not offer it, so a configured 143 is
 * corrected to 993 rather than quietly sending a password in the open.
 */
export function normalizeMailPort(port: unknown): number {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535 || value === 143) return 993;
  return value;
}

function capSeen(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  return unique.length > SEEN_MESSAGE_LIMIT ? unique.slice(unique.length - SEEN_MESSAGE_LIMIT) : unique;
}

function parseMailboxState(raw: unknown): MailboxState {
  if (!isRecord(raw)) return emptyMailboxState();
  return {
    uidValidity: count(raw.uidValidity),
    lastUid: count(raw.lastUid),
    seen: capSeen(Array.isArray(raw.seen) ? raw.seen.filter((id): id is string => typeof id === "string") : []),
    baselined: raw.baselined === true,
    fetched: text(raw.fetched),
    error: text(raw.error),
  };
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
