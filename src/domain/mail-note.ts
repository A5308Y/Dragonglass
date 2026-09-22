/**
 * What an imported message becomes.
 *
 * Decided here rather than in the sync loop so that the note landing in the Inbox
 * can be tested without a mail server or a vault.
 */

import { addressLabel, parseAddress } from "./mime";
import { escapeVaultText, summaryOf } from "./text";

export interface MailMessage {
  /** The `Message-ID`, or `""` when the sender omitted one. */
  messageId: string;
  accountId: string;
  mailbox: string;
  uid: number;
  subject: string;
  /** The raw `From` header, still to be split into a name and an address. */
  from: string;
  /** RFC 3339, or `""` when the header's date could not be read. */
  date: string;
  /** Plain text. Transfer encoding and markup are already resolved. */
  body: string;
  hasAttachment: boolean;
}

/** The Inbox Item title an imported message takes. */
export function mailItemTitle(message: Pick<MailMessage, "subject">): string {
  return message.subject.trim() || "(No subject)";
}

/**
 * The note body an imported message becomes.
 *
 * The sender comes first, because who it is from decides what to do with it more
 * often than what it says does. The `Message-ID` is recorded because it is the only
 * durable way back to the original once the message has been archived — on Gmail it
 * is even searchable as `rfc822msgid:`.
 *
 * Everything a sender wrote is escaped. Mail is an adversarial channel: left alone,
 * a subject line could add itself to your Project graph.
 */
export function mailItemNote(message: MailMessage, accountLabel: string): string {
  const lines: string[] = [];
  const sender = formatSender(message.from);
  if (sender) lines.push(`From: ${escapeVaultText(sender)}`);
  if (message.date) lines.push(`Date: ${message.date.slice(0, 10)}`);

  const location = [accountLabel.trim(), message.mailbox.trim()].filter(Boolean).join(" · ");
  if (location) lines.push(`Mailbox: ${escapeVaultText(location)}`);
  if (message.messageId) lines.push(`Message-ID: ${escapeVaultText(message.messageId)}`);
  if (message.hasAttachment) lines.push("Attachments: yes");

  const body = escapeVaultText(summaryOf(message.body));
  if (body) lines.push("", ...body.split("\n").map((line) => `> ${line}`));
  return lines.join("\n");
}

/**
 * How a sender reads in a note: the name and the address when both are known.
 *
 * Both, rather than just the display name, because a display name is chosen by the
 * sender and is the first thing a phishing attempt gets right.
 */
export function formatSender(from: string): string {
  const parsed = parseAddress(from);
  if (parsed.name && parsed.address) return `${parsed.name} <${parsed.address}>`;
  return parsed.address || parsed.name || addressLabel(from);
}
