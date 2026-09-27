import { TFile, normalizePath, type App, type EventRef, type TAbstractFile } from "obsidian";
import {
  checklistItems,
  dailyChecklistDue,
  discardRun,
  emptyChecklistStore,
  findRun,
  finishRun,
  markItem,
  mergeChecklistStores,
  openRun,
  parseChecklist,
  parseChecklistStore,
  renameChecklist,
  restoreRun,
  startRun,
  type ChecklistBlock,
  type ChecklistRun,
  type ChecklistStore,
  type MarkState,
} from "../domain/checklist";
import type { ChecklistSettings } from "../domain/types";
import { SyncedJsonFile } from "../state/synced-json-file";
import { showUndoNotice } from "../ui/undo";
import { localDate } from "../utils/date";
import { isPathInDirectory } from "../utils/path";
import { createUlid } from "../utils/ulid";

/** A note in the checklists folder. */
export interface ChecklistNote {
  path: string;
  title: string;
}

/**
 * Owns the checklist runs and watches the checklists folder.
 *
 * The notes are only ever read: a run keeps its marks in the store file, so working
 * through a checklist changes nothing in the note, and editing the note mid-run is fine.
 */
export class ChecklistService {
  private store: ChecklistStore = emptyChecklistStore();
  private loaded = false;
  /** The store file, merged with other devices' changes on every write and on sync. */
  private readonly file: SyncedJsonFile<ChecklistStore>;
  private listeners = new Set<() => void>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => ChecklistSettings,
    /** Tells the owner a checklist note moved, so a setting naming it can follow. */
    private readonly onRenamed: (oldPath: string, newPath: string) => Promise<void>,
  ) {
    this.file = new SyncedJsonFile(app, {
      path: () => normalizePath(this.getSettings().storePath.trim() || "GTD/checklists.json"),
      parse: parseChecklistStore,
      empty: emptyChecklistStore,
      merge: mergeChecklistStores,
      current: () => this.store,
      replace: (next) => {
        this.store = next;
        this.notify();
      },
    });
  }

  start(): () => void {
    const refs: EventRef[] = [
      ...this.file.watch(),
      this.app.vault.on("create", (file) => this.changed(file)),
      this.app.vault.on("modify", (file) => this.changed(file)),
      this.app.vault.on("delete", (file) => this.changed(file)),
      this.app.vault.on("rename", (file, oldPath) => void this.renamed(file, oldPath)),
    ];
    void this.load();
    return () => {
      for (const ref of refs) this.app.vault.offref(ref);
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The folder or the daily checklist changed: views read the checklists again. */
  settingsChanged(): void {
    this.notify();
  }

  getStore(): ChecklistStore {
    return this.store;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.store = await this.file.load();
    this.notify();
  }

  /** The notes in the checklists folder, by name. */
  checklists(): ChecklistNote[] {
    return this.app.vault.getMarkdownFiles()
      .filter((file) => this.isChecklist(file.path))
      .map((file) => ({ path: file.path, title: file.basename }))
      .sort((left, right) => left.title.localeCompare(right.title));
  }

  isChecklist(path: string): boolean {
    return path.endsWith(".md") && isPathInDirectory(path, this.getSettings().directory);
  }

  /** The note's items and the Markdown between them, or `null` when the note is gone. */
  async read(path: string): Promise<ChecklistBlock[] | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    return parseChecklist(await this.app.vault.cachedRead(file));
  }

  dailyDue(today = localDate()): boolean {
    const daily = this.getSettings().daily;
    return Boolean(daily) && this.app.vault.getAbstractFileByPath(daily) instanceof TFile && dailyChecklistDue(this.store, daily, today);
  }

  /** Starts a run of the checklist, or goes on with the one under way. */
  async begin(path: string): Promise<ChecklistRun> {
    await this.load();
    const current = openRun(this.store, path);
    if (current) return current;
    const blocks = await this.read(path);
    if (!blocks) throw new Error("This checklist no longer exists.");
    const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const id = createUlid();
    await this.update(startRun(this.store, { id, path, title, items: checklistItems(blocks) }, new Date()));
    return findRun(this.store, id) ?? openRun(this.store, path)!;
  }

  async mark(runId: string, key: string, state: MarkState): Promise<void> {
    await this.update(markItem(this.store, runId, key, state, new Date()));
  }

  async finish(runId: string): Promise<void> {
    const run = findRun(this.store, runId);
    if (!run) throw new Error("This checklist run no longer exists.");
    const blocks = await this.read(run.path);
    await this.update(finishRun(this.store, runId, blocks ? checklistItems(blocks) : run.items, new Date()));
  }

  /** Throws a run away, with Undo. */
  async discard(runId: string): Promise<void> {
    const run = findRun(this.store, runId);
    if (!run) return;
    await this.update(discardRun(this.store, runId));
    showUndoNotice(`Discarded the run of “${run.title}”.`, () => this.update(restoreRun(this.store, run)));
  }

  private changed(file: TAbstractFile): void {
    if (file instanceof TFile && this.isChecklist(file.path)) this.notify();
  }

  private async renamed(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile)) return;
    if (!this.isChecklist(oldPath) && !this.isChecklist(file.path)) return;
    await this.load();
    const next = renameChecklist(this.store, oldPath, file.path, file.basename);
    if (next !== this.store) await this.update(next);
    else this.notify();
    await this.onRenamed(oldPath, file.path);
  }

  private async update(next: ChecklistStore): Promise<void> {
    this.store = next;
    this.notify();
    await this.file.write(this.store);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
