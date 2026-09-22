/**
 * An IMAP session, over whatever transport it is handed.
 *
 * The socket is injected rather than opened here, which keeps the command
 * choreography — the part that can be got wrong — testable without a mail server.
 * `node-socket.ts` supplies the real one.
 *
 * Everything is read-only unless an archive mailbox is configured: mailboxes are
 * opened with `EXAMINE`, bodies are fetched with `BODY.PEEK`, and nothing sets
 * `\Seen`. Importing a message must not disturb the mail client you actually read
 * your mail in.
 */

import {
  attributeSection,
  attributeText,
  encodeMailbox,
  findTextPart,
  flattenBodyStructure,
  formatSequenceSet,
  hasAttachment,
  imapDate,
  isTagged,
  needsLiteral,
  parseCapabilities,
  parseFetchResponse,
  parseListResponse,
  parseSearchUids,
  parseStatusCode,
  parseTagged,
  quoteString,
  takeResponse,
  validateCriterion,
  type ImapResponse,
  type MailboxListing,
} from "../domain/imap-protocol";
import {
  decodeMessagePart,
  headerValue,
  isBulk,
  parseHeaders,
  parseMailDate,
  parseMessageId,
} from "../domain/mime";

/** How long one command may take before the session is abandoned. */
const COMMAND_TIMEOUT_MS = 30_000;

/** The headers worth pulling for a triage decision, and nothing more. */
const SUMMARY_HEADERS = "MESSAGE-ID SUBJECT FROM DATE LIST-ID LIST-UNSUBSCRIBE PRECEDENCE";

/** A part larger than this is not worth pulling to quote a few lines of it. */
const MAX_PART_BYTES = 256_000;

/**
 * The transport a session runs over.
 *
 * Data arrives as a latin-1 string so that one character is one byte, which is what
 * lets a literal's announced length line up with a string index.
 */
export interface ImapSocket {
  write(data: string): void;
  onData(listener: (chunk: string) => void): void;
  onError(listener: (error: Error) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export type ImapSocketFactory = (target: { host: string; port: number }) => Promise<ImapSocket>;

export interface MailboxStatus {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface MessageSummary {
  uid: number;
  messageId: string;
  subject: string;
  from: string;
  /** RFC 3339, or `""`. */
  date: string;
  hasAttachment: boolean;
  /** True when the message's own headers say it is a mailing list or bulk send. */
  bulk: boolean;
  /** Where the readable text lives, for a later fetch, or `null` when there is none. */
  textPart: { path: string; encoding: string; charset: string; subtype: string; size: number } | null;
}

export class ImapConnection {
  private buffer = "";
  private waiter: { resolve: (response: ImapResponse) => void; reject: (error: Error) => void } | null = null;
  private queue: ImapResponse[] = [];
  private failure: Error | null = null;
  private closed = false;
  private tagCounter = 0;
  private capabilities = new Set<string>();

  private constructor(private readonly socket: ImapSocket) {
    socket.onData((chunk) => this.receive(chunk));
    socket.onError((error) => this.fail(error));
    socket.onClose(() => this.fail(new Error("The mail server closed the connection.")));
  }

  /** Opens a session and waits for the server to say it is ready. */
  static async open(factory: ImapSocketFactory, target: { host: string; port: number }): Promise<ImapConnection> {
    const connection = new ImapConnection(await factory(target));
    const greeting = await connection.next();
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) {
      connection.close();
      throw new Error(`The mail server refused the connection: ${greeting.text.slice(0, 120)}`);
    }
    connection.absorbCapabilities(greeting.text);
    return connection;
  }

  supports(capability: string): boolean {
    return this.capabilities.has(capability.toUpperCase());
  }

  async login(user: string, password: string): Promise<void> {
    if (needsLiteral(user) || needsLiteral(password)) {
      throw new Error("Dragonglass can only send credentials made of plain ASCII. An app password will be.");
    }
    if (!this.capabilities.size) await this.run("CAPABILITY");
    if (this.supports("LOGINDISABLED")) {
      throw new Error("The mail server has disabled password login, which is the only method Dragonglass offers.");
    }
    // The password reaches the wire here and nowhere else; it is never logged.
    await this.run(`LOGIN ${quoteString(user)} ${quoteString(password)}`);
    // A server may only reveal its full capabilities after authentication.
    await this.run("CAPABILITY");
  }

  async listMailboxes(): Promise<MailboxListing[]> {
    const { responses } = await this.run(`LIST "" "*"`);
    return responses.map(parseListResponse).filter((listing): listing is MailboxListing => listing !== null);
  }

  /** Opens a mailbox read-only, which is how every sync reads one. */
  async examine(mailbox: string): Promise<MailboxStatus> {
    return this.openMailbox("EXAMINE", mailbox);
  }

  /** Opens a mailbox for writing, needed only to move a message out of it. */
  async select(mailbox: string): Promise<MailboxStatus> {
    return this.openMailbox("SELECT", mailbox);
  }

  private async openMailbox(command: "EXAMINE" | "SELECT", mailbox: string): Promise<MailboxStatus> {
    const { responses } = await this.run(`${command} ${quoteString(encodeMailbox(mailbox))}`);
    const status: MailboxStatus = { uidValidity: 0, uidNext: 0, exists: 0 };
    for (const response of responses) {
      const validity = Number(parseStatusCode(response.text, "UIDVALIDITY"));
      const next = Number(parseStatusCode(response.text, "UIDNEXT"));
      const exists = /^\* (\d+) EXISTS$/i.exec(response.text.trim());
      if (Number.isInteger(validity) && validity > 0) status.uidValidity = validity;
      if (Number.isInteger(next) && next > 0) status.uidNext = next;
      if (exists) status.exists = Number(exists[1]);
    }
    return status;
  }

  /**
   * The UIDs a sync should consider.
   *
   * The configured criterion is ANDed with a UID window and an optional date floor,
   * so an ordinary sync asks about new mail rather than the whole mailbox.
   */
  async searchUids(options: { criterion: string; fromUid: number; since?: Date }): Promise<number[]> {
    const parts = [`UID ${Math.max(1, options.fromUid)}:*`];
    if (options.since) parts.push(`SINCE ${imapDate(options.since)}`);
    parts.push(validateCriterion(options.criterion));
    const { responses } = await this.run(`UID SEARCH ${parts.join(" ")}`);
    const uids = responses.flatMap((response) => parseSearchUids(response.text));
    // `UID n:*` always returns at least one message even when none is above n.
    return uids.filter((uid) => uid >= options.fromUid);
  }

  /** Headers and structure for a batch, in one round trip and without marking anything read. */
  async fetchSummaries(uids: readonly number[]): Promise<MessageSummary[]> {
    const set = formatSequenceSet(uids);
    if (!set) return [];
    const { responses } = await this.run(
      `UID FETCH ${set} (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (${SUMMARY_HEADERS})])`,
    );

    const summaries: MessageSummary[] = [];
    for (const response of responses) {
      const fetched = parseFetchResponse(response);
      if (!fetched) continue;
      const uid = Number(attributeText(fetched.attributes, "UID"));
      if (!Number.isInteger(uid) || uid <= 0) continue;

      const headers = parseHeaders(attributeSection(fetched.attributes, "BODY["));
      const structure = fetched.attributes.get("BODYSTRUCTURE");
      const parts = structure ? flattenBodyStructure(structure) : [];
      const text = findTextPart(parts);

      summaries.push({
        uid,
        messageId: parseMessageId(headerValue(headers, "message-id")),
        subject: headerValue(headers, "subject"),
        from: headers.get("from")?.[0] ?? "",
        date: parseMailDate(headerValue(headers, "date")),
        hasAttachment: hasAttachment(parts),
        bulk: isBulk(headers),
        textPart: text
          ? { path: text.path, encoding: text.encoding, charset: text.charset, subtype: text.subtype, size: text.size }
          : null,
      });
    }
    return summaries;
  }

  /**
   * The readable text of one message, as plain text.
   *
   * Only the part that carries the text is fetched: pulling the message whole would
   * drag every attachment across the wire to quote three lines of it. A part too
   * large to be worth that is skipped rather than truncated mid-encoding.
   */
  async fetchText(uid: number, part: MessageSummary["textPart"]): Promise<string> {
    if (!part || part.size > MAX_PART_BYTES) return "";
    const { responses } = await this.run(`UID FETCH ${uid} (BODY.PEEK[${part.path}])`);
    for (const response of responses) {
      const fetched = parseFetchResponse(response);
      if (!fetched) continue;
      const raw = attributeSection(fetched.attributes, "BODY[");
      if (raw) return decodeMessagePart(raw, part);
    }
    return "";
  }

  /**
   * Moves a message out of the mailbox it was imported from.
   *
   * `MOVE` where the server has it, and `COPY` plus `\Deleted` where it does not —
   * but never an `EXPUNGE`: leaving the original flagged in place is recoverable,
   * and erasing someone's mail to tidy a queue is not a trade Dragonglass makes.
   */
  async moveMessage(uid: number, destination: string): Promise<void> {
    const mailbox = quoteString(encodeMailbox(destination));
    if (this.supports("MOVE")) {
      await this.run(`UID MOVE ${uid} ${mailbox}`);
      return;
    }
    await this.run(`UID COPY ${uid} ${mailbox}`);
    await this.run(`UID STORE ${uid} +FLAGS (\\Deleted)`);
  }

  async logout(): Promise<void> {
    try {
      await this.run("LOGOUT");
    } catch {
      // A server that drops the connection on LOGOUT has still logged us out.
    }
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }

  // COMMANDS

  /** Sends one command and collects the untagged responses that answer it. */
  private async run(command: string): Promise<{ responses: ImapResponse[] }> {
    if (this.failure) throw this.failure;
    const tag = `dg${(this.tagCounter += 1)}`;
    this.socket.write(`${tag} ${command}\r\n`);

    const responses: ImapResponse[] = [];
    for (;;) {
      const response = await this.next();
      if (!isTagged(response.text, tag)) {
        // A continuation request means the server wants a literal we never offered.
        if (response.text.startsWith("+ ")) throw new Error("The mail server asked for data Dragonglass cannot send.");
        this.absorbCapabilities(response.text);
        responses.push(response);
        continue;
      }
      const result = parseTagged(response.text, tag);
      if (result && result.status !== "OK") throw new Error(describeFailure(command, result.detail));
      this.absorbCapabilities(response.text);
      return { responses };
    }
  }

  private absorbCapabilities(text: string): void {
    for (const capability of parseCapabilities(text)) this.capabilities.add(capability);
  }

  // TRANSPORT

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      let taken;
      try {
        taken = takeResponse(this.buffer);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("The mail server sent something unreadable."));
        return;
      }
      if (!taken) return;
      this.buffer = taken.rest;
      const waiting = this.waiter;
      if (waiting) waiting.resolve(taken.response);
      else this.queue.push(taken.response);
    }
  }

  /** The next response, whether it has already arrived or is still on its way. */
  private next(): Promise<ImapResponse> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);

    return new Promise<ImapResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("The mail server stopped responding.")),
        COMMAND_TIMEOUT_MS,
      );
      const settle = (): void => {
        clearTimeout(timer);
        this.waiter = null;
      };
      this.waiter = {
        resolve: (response) => {
          settle();
          resolve(response);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    // Whoever is waiting learns first; a later read rejects from `failure`.
    this.waiter?.reject(this.failure);
  }
}

/**
 * Turns a server rejection into something worth reading.
 *
 * `NO [AUTHENTICATIONFAILED]` on a LOGIN is the one failure a user will actually hit,
 * and it deserves to name the likely cause rather than echo the protocol.
 */
function describeFailure(command: string, detail: string): string {
  const verb = command.split(" ")[0] ?? "command";
  if (verb === "LOGIN") {
    return /AUTHENTICATIONFAILED|Invalid credentials|AUTHORIZATIONFAILED/i.test(detail)
      ? "The mail server rejected the username or password. Most providers need an app password rather than your account password."
      : `The mail server rejected the login: ${detail}`;
  }
  if (verb === "EXAMINE" || verb === "SELECT") {
    return `The mailbox could not be opened: ${detail}`;
  }
  return `The mail server rejected ${verb}: ${detail}`;
}
