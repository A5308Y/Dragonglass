import { Modal, Notice, Setting, getFrontMatterInfo, parseYaml, type App } from "obsidian";
import {
  deviceCopyMatches, fileListDifferences, iCloudPlaceholderTarget, isGtdNote, newestChange, propertyDifferences,
  type DeviceCopyReport, type Properties,
} from "../domain/device-copy";
import type { GtdIndex } from "../repository/gtd-index";

/** A change Obsidian is still reading is not a stale cache, so differences are read twice. */
const SETTLE_MS = 1500;
const BATCH = 20;
const LISTED_AT_MOST = 30;

/**
 * Reads every note on this device and compares it with what Obsidian (and so Dragonglass)
 * shows, then says what it found. Notes whose properties Obsidian has wrong are read from the
 * files from now on (`GtdIndex.useFileProperties`), so the views show what the files say.
 */
export async function checkDeviceCopy(app: App, index: GtdIndex): Promise<void> {
  const notice = new Notice("Checking this device's copy…", 0);
  try {
    const started = performance.now();
    const report = await buildReport(app, index);
    new DeviceCopyModal(app, report, (performance.now() - started) / 1000).open();
  } catch (error) {
    new Notice(`Could not check this device's copy: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    notice.hide();
  }
}

async function buildReport(app: App, index: GtdIndex): Promise<DeviceCopyReport> {
  const { vault, metadataCache } = app;
  const { files, placeholders } = await listDevice(app);
  // iOS and macOS may spell an accented name in another Unicode form than Obsidian does.
  const onDisk = new Map(files.map((path) => [path.normalize("NFC"), path]));
  const listed = new Map(vault.getFiles().map((file) => [file.path.normalize("NFC"), file]));
  const { unnoticed, gone } = fileListDifferences(listed.keys(), onDisk.keys());

  const readProperties = async (diskPath: string): Promise<Properties | undefined> => {
    const info = getFrontMatterInfo(await vault.adapter.read(diskPath));
    if (!info.exists) return undefined;
    try {
      const parsed: unknown = parseYaml(info.frontmatter);
      return parsed && typeof parsed === "object" ? parsed as Properties : undefined;
    } catch {
      // Broken properties are already an index issue; there is nothing to compare.
      return undefined;
    }
  };
  const differences = async (path: string) => {
    const file = listed.get(path);
    const diskPath = onDisk.get(path);
    if (!file || !diskPath) return { properties: undefined, differences: [] };
    const properties = await readProperties(diskPath);
    return { properties, differences: propertyDifferences(metadataCache.getFileCache(file)?.frontmatter, properties) };
  };

  const notes = [...onDisk.keys()].filter((path) => path.endsWith(".md"));
  const suspects: string[] = [];
  const gtdNotes: string[] = [];
  await inBatches(notes, async (path) => {
    const result = await differences(path);
    if (result.differences.length > 0) suspects.push(path);
    if (isGtdNote(result.properties)) gtdNotes.push(path);
  });

  const stale: DeviceCopyReport["stale"] = [];
  const fromFiles = new Map<string, Properties | null>();
  if (suspects.length > 0) await new Promise((resolve) => window.setTimeout(resolve, SETTLE_MS));
  await inBatches(suspects, async (path) => {
    const result = await differences(path);
    if (result.differences.length === 0) return;
    stale.push({ path, differences: result.differences });
    fromFiles.set(listed.get(path)!.path, result.properties ?? {});
  });
  for (const path of gone) fromFiles.set(listed.get(path)!.path, null);
  if (fromFiles.size > 0) index.useFileProperties(fromFiles);

  const changes: { path: string; title: string; modified: number }[] = [];
  await inBatches(gtdNotes, async (path) => {
    const stat = await vault.adapter.stat(onDisk.get(path)!);
    if (stat) changes.push({ path, title: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""), modified: stat.mtime });
  });

  return {
    notesChecked: notes.length,
    stale: stale.sort((left, right) => left.path.localeCompare(right.path)),
    unnoticed,
    gone,
    notDownloaded: placeholders.sort(),
    newestChange: newestChange(changes),
  };
}

/** Every file in the vault folder on this device, without hidden folders such as `.obsidian`. */
async function listDevice(app: App): Promise<{ files: string[]; placeholders: string[] }> {
  const files: string[] = [];
  const placeholders: string[] = [];
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const relative = (path: string) => path.replace(/^\/+/, "");
  const walk = async (folder: string): Promise<void> => {
    const listing = await app.vault.adapter.list(folder);
    for (const path of listing.files.map(relative)) {
      const target = iCloudPlaceholderTarget(path);
      if (target) placeholders.push(target);
      else if (!name(path).startsWith(".")) files.push(path);
    }
    for (const path of listing.folders.map(relative)) {
      if (!name(path).startsWith(".")) await walk(path);
    }
  };
  await walk("/");
  return { files, placeholders };
}

async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += BATCH) {
    await Promise.all(items.slice(start, start + BATCH).map(work));
  }
}

class DeviceCopyModal extends Modal {
  constructor(app: App, private readonly report: DeviceCopyReport, private readonly seconds: number) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, report } = this;
    contentEl.addClass("dg-button-scope");
    this.titleEl.setText("This device's copy");
    contentEl.createEl("p", { text: `Read ${report.notesChecked} notes on this device in ${this.seconds.toFixed(1)} s.` });

    if (deviceCopyMatches(report)) {
      contentEl.createEl("p", { text: "✓ Dragonglass shows exactly what this device's files say." });
    }
    if (report.stale.length > 0) {
      this.section(`Shown differently from the file (${report.stale.length})`,
        "Obsidian's cache of these notes' properties missed a change. Dragonglass now reads them from the files, "
        + "until Obsidian reads them again.");
      const list = contentEl.createEl("ul");
      for (const { path, differences } of report.stale.slice(0, LISTED_AT_MOST)) {
        const item = list.createEl("li", { text: path });
        const changes = item.createEl("ul");
        for (const difference of differences) {
          changes.createEl("li", { text: `${difference.key}: shown “${difference.shown}”, file says “${difference.file}”` });
        }
      }
      this.more(report.stale.length);
    }
    if (report.unnoticed.length > 0) {
      this.section(`On this device, but Obsidian hasn't noticed them (${report.unnoticed.length})`,
        "Restart Obsidian on this device to make it read them.");
      this.paths(report.unnoticed);
    }
    if (report.gone.length > 0) {
      this.section(`Listed by Obsidian, but not on this device (${report.gone.length})`,
        "Dragonglass no longer shows them.");
      this.paths(report.gone);
    }
    if (report.notDownloaded.length > 0) {
      this.section(`Not downloaded from iCloud yet (${report.notDownloaded.length})`,
        "iCloud keeps only a placeholder for these here. Opening the vault folder in the Files app makes it download them.");
      this.paths(report.notDownloaded);
    }

    const newest = report.newestChange;
    contentEl.createEl("h3", { text: "Changes from your other devices" });
    contentEl.createEl("p", {
      text: newest
        ? `The newest change to a Project, Action or Inbox Item on this device is “${newest.title}”, `
          + `${new Date(newest.modified).toLocaleString()}. If a note your other device changed later still looks `
          + "old here, sync hasn't delivered that file yet; this check can only see the files that arrived."
        : "There are no Projects, Actions or Inbox Items on this device.",
    });

    new Setting(contentEl).addButton((button) => button.setButtonText("Close").setCta().onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private section(heading: string, explanation: string): void {
    this.contentEl.createEl("h3", { text: heading });
    this.contentEl.createEl("p", { text: explanation });
  }

  private paths(paths: readonly string[]): void {
    const list = this.contentEl.createEl("ul");
    for (const path of paths.slice(0, LISTED_AT_MOST)) list.createEl("li", { text: path });
    this.more(paths.length);
  }

  private more(count: number): void {
    if (count > LISTED_AT_MOST) this.contentEl.createEl("p", { text: `…and ${count - LISTED_AT_MOST} more.` });
  }
}
