import { normalizePath, type App, type Vault } from "obsidian";
import {
  emptyMailStore,
  forgetAccount,
  mailboxState,
  parseMailStore,
  planImport,
  recordHandled,
  reconcileValidity,
  searchFromUid,
  withMailboxState,
  withSyncError,
  openBacklog,
  type MailAccount,
  type MailCandidate,
  type MailStoreData,
} from "../domain/mail";
import { mailItemNote, mailItemTitle } from "../domain/mail-note";
import type { GtdRepository } from "../repository/gtd-repository";
import { ImapConnection, type ImapSocketFactory, type MessageSummary } from "./imap-client";
import { mailTransportAvailable, MOBILE_EXPLANATION, openTlsSocket } from "./node-socket";

export interface MailSettingsView {
  enabled: boolean;
  /** The vault-relative JSON file holding sync watermarks. */
  storePath: string;
  refreshMinutes: number;
  /** How many messages one sync will import before deferring the rest. */
  importCap: number;
  accounts: MailAccount[];
}

export interface MailImportResult {
  imported: number;
  /** Messages matched but held back by the cap, which the next sync will take. */
  deferred: number;
  /** Mailboxes whose existing contents were recorded as a starting point. */
  baselined: number;
  failed: number;
  /** Messages whose Inbox Item exists but which could not be archived. */
  unarchived: number;
}

export interface MailSyncStatus {
  state: "disabled" | "unavailable" | "idle" | "importing" | "success" | "error";
  lastImport?: string;
  error?: string;
  result?: MailImportResult;
}

/**
 * How a session reaches the server, and whether this platform can at all.
 *
 * Injected together because they are the same question asked twice, and because it
 * lets the sync loop be tested without a socket or a Node runtime.
 */
export interface MailTransport {
  connect: ImapSocketFactory;
  available: () => boolean;
}

const NODE_TRANSPORT: MailTransport = { connect: openTlsSocket, available: mailTransportAvailable };

/**
 * Mirrors mailboxes into the Inbox.
 *
 * Every message this accepts becomes an Inbox Item immediately, so the ordering of
 * the two writes is the whole safety story: the Inbox Item is created first, the
 * watermark advances second, and the message is only moved out of the mailbox once
 * both have happened. A crash anywhere in that sequence costs a repeated import at
 * worst, never a message that was marked handled and written nowhere.
 */
export class MailService {
  private store: MailStoreData = emptyMailStore();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private status: MailSyncStatus = { state: "disabled" };
  private listeners = new Set<() => void>();
  private timer: number | null = null;
  private active: Promise<MailImportResult> | null = null;

  constructor(
    private readonly app: App,
    private readonly repository: GtdRepository,
    private readonly getSettings: () => MailSettingsView,
    private readonly getPassword: (accountId: string) => string,
    private readonly transport: MailTransport = NODE_TRANSPORT,
  ) {}

  start(): () => void {
    void this.load().then(() => {
      this.status = { state: this.initialState() };
      this.notify();
      if (this.getSettings().enabled) this.schedule(20_000);
    });
    return () => {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStore(): MailStoreData {
    return this.store;
  }

  getStatus(): MailSyncStatus {
    return this.status;
  }

  available(): boolean {
    return this.transport.available();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.store = parseMailStore(JSON.parse(await this.app.vault.adapter.read(this.storePath())));
    } catch {
      // No file yet, or one no longer readable. A fresh store re-baselines rather than floods.
      this.store = emptyMailStore();
    }
    this.notify();
  }

  /** Arms the refresh timer, re-arming itself so a settings change lands on the next tick. */
  schedule(delay = 1_000): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (!this.getSettings().enabled || !this.available()) {
      this.setStatus({ state: this.initialState() });
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.importAll()
        .catch(() => undefined)
        .finally(() => this.schedule(Math.max(5, this.getSettings().refreshMinutes) * 60_000));
    }, delay);
  }

  // ACCOUNTS

  /** Connects, authenticates, and lists mailboxes, for configuring an account. */
  async listMailboxes(account: MailAccount, password: string): Promise<string[]> {
    const connection = await this.openSession(account, password);
    try {
      const mailboxes = await connection.listMailboxes();
      return mailboxes
        // A mailbox that cannot hold messages is not one to mirror.
        .filter((mailbox) => !mailbox.flags.some((flag) => /^\\Noselect$/i.test(flag)))
        .map((mailbox) => mailbox.name)
        .sort((left, right) => left.localeCompare(right));
    } finally {
      await connection.logout().catch(() => undefined);
    }
  }

  async forget(accountId: string): Promise<void> {
    await this.load();
    this.store = forgetAccount(this.store, accountId);
    await this.persist();
  }

  /**
   * Drops a mailbox's baseline so the next sync imports what is already in it.
   *
   * The deliberate way to ask for the backlog that day one held back.
   */
  async importBacklog(accountId: string, mailbox: string): Promise<void> {
    await this.load();
    this.store = withMailboxState(this.store, accountId, mailbox, openBacklog(mailboxState(this.store, accountId, mailbox)));
    await this.persist();
  }

  // IMPORTING

  async importAll(): Promise<MailImportResult> {
    if (this.active) return this.active;
    await this.load();

    if (!this.available()) {
      this.setStatus({ state: "unavailable", error: MOBILE_EXPLANATION });
      return emptyResult();
    }
    const accounts = this.getSettings().accounts.filter((account) => account.enabled && account.mailboxes.length);
    if (!accounts.length) {
      this.setStatus({ state: "idle", lastImport: new Date().toISOString() });
      return emptyResult();
    }

    this.setStatus({ ...this.status, state: "importing" });
    const run = (async () => {
      const total = emptyResult();
      const failures: string[] = [];
      // One account at a time: several simultaneous IMAP sessions from one vault is
      // how a provider decides you are not a mail client.
      for (const account of accounts) {
        try {
          const result = await this.importAccount(account);
          total.imported += result.imported;
          total.deferred += result.deferred;
          total.baselined += result.baselined;
          total.unarchived += result.unarchived;
          total.failed += result.failed;
        } catch (error) {
          total.failed += 1;
          failures.push(`${account.label}: ${error instanceof Error ? error.message : "import failed"}`);
        }
      }
      this.setStatus({
        state: failures.length && !total.imported ? "error" : "success",
        lastImport: new Date().toISOString(),
        result: total,
        ...(failures.length ? { error: failures.join(" · ") } : {}),
      });
      return total;
    })().finally(() => {
      this.active = null;
    });

    this.active = run;
    return run;
  }

  async importAccount(account: MailAccount): Promise<MailImportResult> {
    await this.load();
    const password = this.getPassword(account.id);
    if (!password) throw new Error(`${account.label} has no app password configured.`);

    const result = emptyResult();
    const connection = await this.openSession(account, password);
    try {
      for (const mailbox of account.mailboxes) {
        try {
          await this.importMailbox(connection, account, mailbox, result);
        } catch (error) {
          result.failed += 1;
          const message = error instanceof Error ? error.message : "The mailbox could not be read.";
          this.store = withMailboxState(
            this.store,
            account.id,
            mailbox,
            withSyncError(mailboxState(this.store, account.id, mailbox), message, new Date().toISOString()),
          );
          await this.persist();
        }
      }
    } finally {
      await connection.logout().catch(() => undefined);
    }
    return result;
  }

  private async importMailbox(
    connection: ImapConnection,
    account: MailAccount,
    mailbox: string,
    result: MailImportResult,
  ): Promise<void> {
    // Archiving writes to the mailbox, so it has to be opened for writing from the start.
    const archiving = Boolean(account.archiveMailbox.trim());
    const status = archiving ? await connection.select(mailbox) : await connection.examine(mailbox);

    let state = reconcileValidity(mailboxState(this.store, account.id, mailbox), status.uidValidity);
    const uids = await connection.searchUids({ criterion: account.criterion, fromUid: searchFromUid(state) });
    const summaries = uids.length ? await connection.fetchSummaries(uids) : [];
    const candidates: MailCandidate[] = summaries.map((summary) => ({ uid: summary.uid, messageId: summary.messageId }));
    const plan = planImport(state, candidates, { cap: this.getSettings().importCap });
    const fetchedAt = new Date().toISOString();

    if (plan.baseline) {
      // Day one: whatever is already in the mailbox stays there and is never imported.
      state = recordHandled(state, candidates, { uidValidity: status.uidValidity, fetchedAt });
      this.store = withMailboxState(this.store, account.id, mailbox, state);
      await this.persist();
      result.baselined += 1;
      return;
    }

    result.deferred += plan.deferred;
    for (const candidate of plan.selected) {
      const summary = summaries.find((entry) => entry.uid === candidate.uid);
      if (!summary) continue;
      const body = await connection.fetchText(summary.uid, summary.textPart);

      await this.createInboxItem(account, mailbox, summary, body);
      // Handled the moment the Item exists, so a later failure cannot duplicate it.
      state = recordHandled(state, [candidate], { uidValidity: status.uidValidity, fetchedAt });
      this.store = withMailboxState(this.store, account.id, mailbox, state);
      await this.persist();
      result.imported += 1;

      if (archiving) {
        try {
          await connection.moveMessage(summary.uid, account.archiveMailbox.trim());
        } catch {
          // The Item exists and is recorded; the message simply stays where it is.
          result.unarchived += 1;
        }
      }
    }
  }

  private async createInboxItem(
    account: MailAccount,
    mailbox: string,
    summary: MessageSummary,
    body: string,
  ): Promise<void> {
    const message = {
      messageId: summary.messageId,
      accountId: account.id,
      mailbox,
      uid: summary.uid,
      subject: summary.subject,
      from: summary.from,
      date: summary.date,
      body,
      hasAttachment: summary.hasAttachment,
    };
    await this.repository.createIdentifiedInboxItem(mailItemTitle(message), mailItemNote(message, account.label));
  }

  private async openSession(account: MailAccount, password: string): Promise<ImapConnection> {
    if (!account.host.trim()) throw new Error(`${account.label} has no server configured.`);
    const connection = await ImapConnection.open(this.transport.connect, { host: account.host.trim(), port: account.port });
    try {
      await connection.login(account.user.trim(), password);
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  }

  // PERSISTENCE

  private storePath(): string {
    return normalizePath(this.getSettings().storePath.trim() || "GTD/mail.json");
  }

  /** Writes are serialised, so two mailboxes finishing together cannot interleave. */
  private async persist(): Promise<void> {
    this.notify();
    const write = this.writing.then(async () => {
      const path = this.storePath();
      await ensureParent(this.app.vault, path);
      await this.app.vault.adapter.write(path, `${JSON.stringify(this.store, null, 2)}\n`);
    });
    this.writing = write.catch(() => undefined);
    return write;
  }

  private initialState(): MailSyncStatus["state"] {
    if (!this.available()) return "unavailable";
    return this.getSettings().enabled ? "idle" : "disabled";
  }

  private setStatus(status: MailSyncStatus): void {
    this.status = status;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function emptyResult(): MailImportResult {
  return { imported: 0, deferred: 0, baselined: 0, failed: 0, unarchived: 0 };
}

async function ensureParent(vault: Vault, path: string): Promise<void> {
  const index = path.lastIndexOf("/");
  if (index <= 0) return;
  const folder = path.slice(0, index);
  if (await vault.adapter.exists(folder)) return;
  await vault.adapter.mkdir(folder);
}
