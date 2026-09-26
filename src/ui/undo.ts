import { Notice, normalizePath, type App, type TFile } from "obsidian";

const UNDO_TIMEOUT_MS = 10_000;

/** The Undo notice on screen, which later changes join while it is up. */
interface UndoRun {
  notice: Notice;
  message: HTMLElement;
  button: HTMLButtonElement;
  undos: Array<() => Promise<void>>;
  timer: number;
  used: boolean;
}

let current: UndoRun | undefined;

/**
 * Reports a reversible change with an Undo button, instead of asking first.
 * The notice stays up long enough to notice a slip; undoing after it closes is
 * not offered.
 *
 * Changes made while the notice is up join it rather than stacking notices, so
 * deleting ten Items in a row shows one notice: the latest change, and an Undo
 * that takes back the whole run, newest first. Each change restarts the timer.
 */
export function showUndoNotice(message: string, undo: () => Promise<void>): void {
  const run = current && !current.used && current.notice.noticeEl.isConnected ? current : startRun();
  run.undos.push(undo);
  run.message.setText(message);
  run.button.setText(run.undos.length === 1 ? "Undo" : `Undo all ${run.undos.length}`);
  window.clearTimeout(run.timer);
  run.timer = window.setTimeout(() => run.notice.hide(), UNDO_TIMEOUT_MS);
}

function startRun(): UndoRun {
  const fragment = document.createDocumentFragment();
  const body = fragment.createDiv({ cls: "dg-undo-notice" });
  const message = body.createSpan();
  const button = body.createEl("button", { text: "Undo", cls: "mod-cta" });
  // Hidden by the timer below, so a joining change can keep it up longer.
  const notice = new Notice(fragment, 0);
  const run: UndoRun = { notice, message, button, undos: [], timer: 0, used: false };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (run.used) return;
    run.used = true;
    window.clearTimeout(run.timer);
    notice.hide();
    void undoAll(run.undos);
  });
  current = run;
  return run;
}

async function undoAll(undos: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const failures: string[] = [];
  for (const undo of [...undos].reverse()) {
    try {
      await undo();
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length === 1) new Notice(`Could not undo: ${failures[0]}`);
  else if (failures.length) new Notice(`Could not undo ${failures.length} of ${undos.length} changes: ${failures[0]}`);
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
