/**
 * Checking this device's copy of the vault: does what Dragonglass shows match the files on
 * this device? Obsidian keeps a list of the vault's files and a cache of every note's
 * properties, and Dragonglass reads both; when either missed a change that sync made, the
 * views show an old state until Obsidian notices. The check reads the files themselves and
 * names every difference, so a stale state is shown rather than guessed at.
 *
 * What the check cannot see is a change that never reached this device: then the files here
 * are old too, and only the newest change that did arrive (`newestChange`) hints at it.
 */

export type Properties = Record<string, unknown>;

/** One property whose value in Obsidian's cache differs from the file. */
export interface PropertyDifference {
  key: string;
  /** As Obsidian (and so Dragonglass) shows it. */
  shown: string;
  /** As the file on this device says. */
  file: string;
}

/** Notes Dragonglass reads: Projects, Actions and Inbox Items. */
export function isGtdNote(properties: Properties | undefined): boolean {
  const type = properties?.type;
  return type === "gtd-project" || type === "gtd-action" || type === "gtd-inbox-item";
}

/**
 * The properties that differ between Obsidian's cache and the file, by key in order; none when
 * neither side is a note Dragonglass reads.
 */
export function propertyDifferences(shown: Properties | undefined, file: Properties | undefined): PropertyDifference[] {
  if (!isGtdNote(shown) && !isGtdNote(file)) return [];
  const keys = [...new Set([...Object.keys(shown ?? {}), ...Object.keys(file ?? {})])].sort();
  return keys.flatMap((key) => {
    const before = valueText(shown?.[key]);
    const after = valueText(file?.[key]);
    return before === after ? [] : [{ key, shown: before, file: after }];
  });
}

function valueText(value: unknown): string {
  if (value === undefined || value === null) return "(none)";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The note an iCloud placeholder stands for: iOS keeps a file it hasn't downloaded as
 * `.<name>.icloud` next to where the file belongs.
 */
export function iCloudPlaceholderTarget(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const match = /^\.(.+)\.icloud$/.exec(name);
  return match ? `${path.slice(0, slash + 1)}${match[1]}` : null;
}

/** Files on this device that Obsidian doesn't list, and files it lists that aren't here. */
export function fileListDifferences(listed: Iterable<string>, onDisk: Iterable<string>): { unnoticed: string[]; gone: string[] } {
  const listedSet = new Set(listed);
  const diskSet = new Set(onDisk);
  return {
    unnoticed: [...diskSet].filter((path) => !listedSet.has(path)).sort(),
    gone: [...listedSet].filter((path) => !diskSet.has(path)).sort(),
  };
}

export interface DeviceCopyReport {
  notesChecked: number;
  /** Notes whose properties Obsidian shows differently from the file. */
  stale: { path: string; differences: PropertyDifference[] }[];
  unnoticed: string[];
  gone: string[];
  /** Notes iCloud hasn't downloaded to this device. */
  notDownloaded: string[];
  /** The Project, Action or Inbox Item last changed among this device's files. */
  newestChange: { path: string; title: string; modified: number } | null;
}

export function deviceCopyMatches(report: DeviceCopyReport): boolean {
  return report.stale.length === 0 && report.unnoticed.length === 0 && report.gone.length === 0;
}

/** The newest of the given changes, if any. */
export function newestChange<T extends { modified: number }>(changes: Iterable<T>): T | null {
  let newest: T | null = null;
  for (const change of changes) if (!newest || change.modified > newest.modified) newest = change;
  return newest;
}
