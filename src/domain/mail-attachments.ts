/**
 * Which attachments of an imported message become Inbox Items of their own.
 *
 * Mail is an adversarial channel, and an attachment is the sender's file landing in
 * the vault, so the rules are strict and decided here, where they can be tested:
 *
 * - Only kinds of file on an allowlist are written: documents, images, audio and
 *   video that open in a viewer. Never Markdown, Canvas or Bases files (Obsidian
 *   reads them, and a note with an Action's frontmatter would join your Projects),
 *   never HTML or SVG, archives, scripts, programs, or Office files that can carry
 *   macros. Files Dragonglass writes carry no quarantine mark, so macOS won't warn
 *   when they are opened the way it does for a file saved from Mail.
 * - The extension the file is saved with is the one checked, since that is what
 *   decides which app opens it; `invoice.pdf.exe` is an `.exe`.
 * - The name is the sender's text: path separators, control and direction-changing
 *   characters, leading dots and characters links can't hold are removed.
 * - Size and count are capped, so one message can't fill the vault.
 *
 * A small image embedded in the HTML (a signature logo) is part of the text, not an
 * attachment, and isn't listed at all: listing every logo is how a note learns to
 * say "Attachments" about mail that has none worth opening.
 */

import type { BodyPart } from "./imap-protocol";
import { mimeParameter } from "./mime";
import { AUDIO_EXTENSIONS } from "./transcription";
import { escapeVaultText } from "./text";
import { safeName } from "../utils/path";

/** File kinds an attachment may be saved as. */
export const ATTACHMENT_EXTENSIONS: readonly string[] = [
  // Documents.
  "pdf", "txt", "csv", "rtf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "pages", "numbers", "key", "ics", "vcf",
  // Images.
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp",
  // Audio and video.
  ...AUDIO_EXTENSIONS, "mp4", "m4v", "mov",
];

/** An embedded image smaller than this (on the wire) is taken for decoration. */
export const EMBEDDED_IMAGE_MIN_BYTES = 40_000;

/** At most this many attachments of one message become Inbox Items. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** The settings' bounds for the largest attachment, in MB. */
export const ATTACHMENT_LIMIT_MB = { default: 10, max: 25 } as const;

/** Extensions for parts that arrive without a file name. */
const TYPE_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "text/calendar": "ics",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/html": "html",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "message/rfc822": "eml",
};

export interface AttachmentPlan {
  part: BodyPart;
  /** The name it is saved and shown under, already made safe. */
  fileName: string;
  /** Its decoded size, estimated from the wire size. */
  bytes: number;
  /** Why it stays in the message, or `undefined` when it is to be imported. */
  skip?: "kind" | "size" | "count" | "off";
}

/** The attachments worth naming in the note: everything that isn't the text or decoration. */
export function attachmentParts(parts: readonly BodyPart[], textPart: Pick<BodyPart, "path"> | null): BodyPart[] {
  return parts.filter((part) => {
    if (part.type === "multipart" || part.path === textPart?.path) return false;
    if (part.disposition === "attachment") return true;
    const named = Boolean(mimeParameter(part.parameters, "filename") || mimeParameter(part.parameters, "name"));
    // Embedded in the HTML: small ones are logos; a pasted screenshot is worth keeping.
    if (part.contentId && part.type === "image") return part.size >= EMBEDDED_IMAGE_MIN_BYTES;
    // The alternative text and HTML versions of the message itself.
    if (part.type === "text" && !named) return false;
    return true;
  });
}

/** What happens to each attachment: imported, or left in the message and why. */
export function planAttachments(
  parts: readonly BodyPart[],
  options: { enabled: boolean; limitMb: number },
): AttachmentPlan[] {
  const limit = Math.min(Math.max(options.limitMb, 0), ATTACHMENT_LIMIT_MB.max) * 1_000_000;
  let imported = 0;
  return parts.map((part) => {
    const fileName = attachmentFileName(part);
    const bytes = decodedSize(part);
    const plan: AttachmentPlan = { part, fileName, bytes };
    if (!options.enabled) return { ...plan, skip: "off" };
    if (!ATTACHMENT_EXTENSIONS.includes(extensionOf(fileName))) return { ...plan, skip: "kind" };
    if (bytes > limit) return { ...plan, skip: "size" };
    if (imported >= MAX_ATTACHMENTS_PER_MESSAGE) return { ...plan, skip: "count" };
    imported += 1;
    return plan;
  });
}

/**
 * The sender's file name, made safe for the vault and for a link: no folders, no
 * control or bidirectional characters (`invoice‮fdp.exe` reads as `invoiceexe.pdf`),
 * no leading dot, and none of the characters Obsidian links or file systems refuse.
 * The extension is lowercased, and a part without a name gets one from its type.
 */
export function attachmentFileName(part: Pick<BodyPart, "type" | "subtype" | "parameters">): string {
  const given = mimeParameter(part.parameters, "filename") || mimeParameter(part.parameters, "name");
  const base = (given.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/^[.\s]+/, "")
    .trim();
  const dot = base.lastIndexOf(".");
  const typed = TYPE_EXTENSIONS[`${part.type}/${part.subtype}`] ?? "";
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : typed;
  const stem = safeName((dot > 0 ? base.slice(0, dot) : base).replace(/^[.\s]+/, ""), "Attachment").replace(/^\.+/, "");
  return extension ? `${stem}.${extension}` : stem;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

function decodedSize(part: Pick<BodyPart, "size" | "encoding">): number {
  return part.encoding === "base64" ? Math.floor((part.size * 3) / 4) : part.size;
}

/** An attachment as the note lists it. */
export interface AttachmentEntry {
  fileName: string;
  bytes: number;
  /** Where it was saved in the vault, when it was. */
  path?: string;
  skip?: AttachmentPlan["skip"] | "failed";
}

/**
 * The note's attachment block: a callout, so it stands out from the header lines,
 * with each saved file linked and each other one saying why it stayed in the message.
 * `""` for a message without attachments.
 */
export function attachmentCallout(entries: readonly AttachmentEntry[], limitMb: number): string {
  if (!entries.length) return "";
  const saved = entries.filter((entry) => entry.path).length;
  const count = `${entries.length} ${entries.length === 1 ? "attachment" : "attachments"}`;
  const title = saved === entries.length
    ? `${count}, ${saved === 1 ? "an Inbox Item of its own" : "each an Inbox Item of its own"}`
    : saved
      ? `${count}, ${saved} saved as ${saved === 1 ? "an Inbox Item" : "Inbox Items"}`
      : `${count}, in the message`;
  const lines = entries.map((entry) => {
    const name = entry.path ? `[[${entry.path}|${entry.fileName}]]` : escapeVaultText(entry.fileName);
    const size = entry.bytes > 0 ? ` · ${formatBytes(entry.bytes)}` : "";
    return `> - ${name}${size}${entry.skip ? ` · ${skipReason(entry.skip, limitMb)}` : ""}`;
  });
  return [`> [!dg-attachments] ${title}`, ...lines].join("\n");
}

function skipReason(skip: NonNullable<AttachmentEntry["skip"]>, limitMb: number): string {
  switch (skip) {
    case "kind":
      return "not imported: Dragonglass doesn't save this kind of file";
    case "size":
      return `not imported: larger than ${limitMb} MB`;
    case "count":
      return `not imported: only ${MAX_ATTACHMENTS_PER_MESSAGE} per message are`;
    case "failed":
      return "not imported: it couldn't be downloaded";
    case "off":
      return "not imported";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`;
}

/**
 * For notes imported while the note said only `Attachments: yes`: the same callout,
 * saying where the files are.
 */
export const LEGACY_ATTACHMENT_CALLOUT = "> [!dg-attachments] Attachments\n> Imported before Dragonglass saved attachments: they are in the message.";
