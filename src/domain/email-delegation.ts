/**
 * Delegating an Action by email: the Action becomes Waiting, records who it went to in
 * `delegated_to`, and your own mail app sends the message (a `mailto:` link), so the people
 * you work with need nothing but email and Dragonglass needs no way to send mail.
 *
 * The subject carries a marker made from the Action's id, `[DG-XXXXXXXX]`. Replies keep it, so
 * an imported reply is linked to its Action. A reply never changes the Action by itself: mail
 * is an open channel, and anyone could write "done" in a subject.
 */

import type { Action } from "./types";

/** The marker in a delegated Action's subject: the end of its ULID, which is the random part. */
export function delegationKey(actionId: string): string {
  return `DG-${actionId.slice(-8).toUpperCase()}`;
}

/** The marker a subject carries, if any, as `delegationKey` writes it. */
export function delegationKeyIn(subject: string): string | null {
  const match = /\[(DG-[0-9A-Z]{8})\]/i.exec(subject);
  return match ? match[1]!.toUpperCase() : null;
}

/** The delegated Action a reply's subject is about, if its marker names one. */
export function delegatedActionFor(subject: string, actions: Iterable<Action>): Action | null {
  const key = delegationKeyIn(subject);
  if (!key) return null;
  for (const action of actions) if (action.delegatedTo && delegationKey(action.id) === key) return action;
  return null;
}

/** The line an imported reply's note starts with, linking the Action it answers. */
export function replyAboutLine(action: Pick<Action, "title" | "file">): string {
  const path = action.file.path.replace(/\.md$/i, "");
  return `Reply about the delegated Action [[${path}|${action.title.replace(/[[\]|]/g, "")}]]`;
}

/** The subject as typed, with the marker added at the end when it was taken out. */
export function delegationSubject(subject: string, key: string): string {
  const clean = subject.trim();
  return delegationKeyIn(clean) === key ? clean : `${clean} [${key}]`.trim();
}

export interface DelegationMessage {
  title: string;
  projectTitle?: string;
  desiredOutcome?: string;
}

/** The message a delegation starts with, to be edited before it is sent. */
export function delegationBody(message: DelegationMessage): string {
  const lines = ["Hi,", "", "could you take care of this?", "", message.title];
  if (message.projectTitle) {
    lines.push("", `It is part of “${message.projectTitle}”.`);
    if (message.desiredOutcome?.trim()) lines.push(`What we want in the end: ${message.desiredOutcome.trim()}`);
  }
  lines.push("", "Please reply to this email when it is done or if something is unclear.", "", "Thanks");
  return lines.join("\n");
}

export function isEmailAddress(value: string): boolean {
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(value.trim());
}

/** A `mailto:` link that opens a new message in the mail app; line breaks as mail wants them. */
export function mailtoUrl(to: string, subject: string, body: string): string {
  const encode = (value: string) => encodeURIComponent(value.replace(/\r?\n/g, "\r\n"));
  return `mailto:${encodeURIComponent(to.trim()).replace(/%40/g, "@")}?subject=${encode(subject)}&body=${encode(body)}`;
}

/** Everyone Actions were delegated to, the most recent first, for picking again. */
export function recentRecipients(actions: Iterable<Action>): string[] {
  const latest = new Map<string, string>();
  for (const action of actions) {
    const to = action.delegatedTo?.trim();
    if (!to) continue;
    const when = action.waitingSince ?? action.created;
    if ((latest.get(to) ?? "") < when) latest.set(to, when);
  }
  return [...latest].sort((left, right) => right[1].localeCompare(left[1]) || left[0].localeCompare(right[0])).map(([to]) => to);
}
