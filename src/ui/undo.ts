import { Notice, normalizePath, type App, type TFile } from "obsidian";

const UNDO_TIMEOUT_MS = 10_000;

/**
 * Reports a reversible change with an Undo button, instead of asking first.
 * The notice stays up long enough to notice a slip; undoing after it closes is
 * not offered.
 */
export function showUndoNotice(message: string, undo: () => Promise<void>): void {
  const fragment = document.createDocumentFragment();
  const body = fragment.createDiv({ cls: "dg-undo-notice" });
  body.createSpan({ text: message });
  const button = body.createEl("button", { text: "Undo", cls: "mod-cta" });
  const notice = new Notice(fragment, UNDO_TIMEOUT_MS);
  let used = false;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (used) return;
    used = true;
    notice.hide();
    undo().catch((error: unknown) => {
      new Notice(error instanceof Error ? `Could not undo: ${error.message}` : "Could not undo.");
    });
  });
}

/**
 * Moves one file to the trash and offers to put it back. Undo recreates the
 * file byte for byte at its old path, so its frontmatter id, and with it every
 * link Dragonglass keeps to it, survives.
 */
export async function trashWithUndo(app: App, file: TFile, message: string, trash: () => Promise<void>): Promise<void> {
  const path = file.path;
  const data = await app.vault.readBinary(file);
  await trash();
  showUndoNotice(message, async () => {
    if (app.vault.getAbstractFileByPath(path)) throw new Error(`“${path}” exists again.`);
    const folder = path.includes("/") ? normalizePath(path.slice(0, path.lastIndexOf("/"))) : "";
    if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    await app.vault.createBinary(path, data);
  });
}
