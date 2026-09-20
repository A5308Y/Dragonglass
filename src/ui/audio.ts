import type { TFile } from "obsidian";

/** The audio formats Obsidian itself plays, so an Inbox capture can be heard without leaving the view. */
export const AUDIO_EXTENSIONS = new Set(["3gp", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "webm"]);

export function isVaultAudio(file: TFile): boolean {
  return AUDIO_EXTENSIONS.has(file.extension.toLocaleLowerCase());
}
