import { TFile, normalizePath, type App, type EventRef, type TAbstractFile } from "obsidian";

/**
 * A JSON store in the vault that more than one device writes.
 *
 * Vault sync copies whole files, so a device that writes its own copy without looking
 * would overwrite whatever another device did since. Instead every write is a three-way
 * merge: `base` is the file as this device last read or wrote it, `mine` is what this
 * device has now, and `theirs` is what the file holds now. What this device changed
 * since `base` is applied on top of `theirs`, so both devices' changes survive, and
 * when both changed the same thing this device's newer change wins.
 *
 * When sync changes the file, the same merge folds the other device's changes into the
 * copy in memory, so an open view updates without a restart.
 */
export interface SyncedJsonOptions<T> {
  path: () => string;
  parse: (raw: unknown) => T;
  empty: () => T;
  merge: (base: T, mine: T, theirs: T) => T;
  /** What the owner holds now. */
  current: () => T;
  /** Hands the owner a merged copy to hold instead. */
  replace: (next: T) => void;
}

/** How long to wait after a file event, so a sync writing in pieces is read once, whole. */
const SETTLE_MS = 400;

export class SyncedJsonFile<T> {
  private base: T;
  private queue: Promise<unknown> = Promise.resolve();
  private settle: number | null = null;

  constructor(private readonly app: App, private readonly options: SyncedJsonOptions<T>) {
    this.base = options.empty();
  }

  /** Reads the file, or an empty store when there is none yet or it can't be read. */
  async load(): Promise<T> {
    const read = await this.read();
    this.base = read ?? this.options.empty();
    return this.base;
  }

  /**
   * Merges `mine` into the file and writes the result, then gives the owner the merged
   * copy, keeping anything the owner changed while the write was under way.
   * Writes are serialised, so two landing together cannot interleave.
   */
  write(mine: T): Promise<void> {
    return this.enqueue(async () => {
      const theirs = (await this.read()) ?? this.base;
      const merged = this.options.merge(this.base, mine, theirs);
      const path = this.options.path();
      await ensureParent(this.app, path);
      await this.app.vault.adapter.write(path, `${JSON.stringify(merged, null, 2)}\n`);
      this.base = merged;
      this.adopt(mine, merged);
    });
  }

  /** Watches the file for changes from sync; returns the event refs to register. */
  watch(): EventRef[] {
    const changed = (file: TAbstractFile) => {
      if (!(file instanceof TFile) || file.path !== normalizePath(this.options.path())) return;
      if (this.settle !== null) window.clearTimeout(this.settle);
      this.settle = window.setTimeout(() => {
        this.settle = null;
        void this.reload();
      }, SETTLE_MS);
    };
    return [this.app.vault.on("modify", changed), this.app.vault.on("create", changed)];
  }

  /** Folds the file's current content into the owner's copy. Our own writes change nothing. */
  reload(): Promise<void> {
    return this.enqueue(async () => {
      const theirs = await this.read();
      if (!theirs || same(theirs, this.base)) return;
      const mine = this.options.current();
      const merged = this.options.merge(this.base, mine, theirs);
      this.base = theirs;
      if (!same(merged, mine)) this.options.replace(merged);
    });
  }

  /** The merged copy for the owner, with whatever it changed since handing over `mine` on top. */
  private adopt(mine: T, merged: T): void {
    const now = this.options.current();
    const next = now === mine ? merged : this.options.merge(mine, now, merged);
    if (!same(next, now)) this.options.replace(next);
  }

  /** The file's content, or `null` when it is missing or half-written (sync mid-copy). */
  private async read(): Promise<T | null> {
    try {
      return this.options.parse(JSON.parse(await this.app.vault.adapter.read(normalizePath(this.options.path()))));
    } catch {
      return null;
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function ensureParent(app: App, path: string): Promise<void> {
  const index = path.lastIndexOf("/");
  if (index <= 0) return;
  const folder = path.slice(0, index);
  if (await app.vault.adapter.exists(folder)) return;
  await app.vault.adapter.mkdir(folder);
}
