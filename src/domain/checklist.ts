/**
 * Checklists: a note in the checklists folder is the template, and working through it
 * once is a run. Runs are kept in one JSON file in the vault (`GTD/checklists.json`),
 * never in the note, so the note stays as written and nothing is copied to run it.
 *
 * An item is a Markdown task line (`- [ ] …`); every other line is shown as written
 * between the items, so links and notes in the checklist keep working. Items are
 * recognised by their text, which lets a run survive edits to the note: a reworded item
 * is a new one, and marks on items no longer in the note are kept and shown as such.
 * Two items with the same text are told apart by their order.
 */

import { byKey, mergeKeyed, same } from "./merge";
import { localDate } from "../utils/date";

export const CHECKLIST_STORE_VERSION = 1;

/** How many runs the store keeps before the oldest are dropped. */
export const RUN_LIMIT = 5_000;

/** Past this many items a checklist gets skimmed rather than read; the view says so. */
export const SHORT_CHECKLIST_ITEMS = 9;

/** How many finished runs in a row an item has to be skipped in before the view asks about it. */
export const REPEATED_SKIPS = 3;

export type ChecklistBlock =
  /** Lines between items, shown as Markdown. */
  | { kind: "markdown"; markdown: string }
  /** A task line. `depth` counts how far it is nested under other items. */
  | { kind: "item"; key: string; text: string; depth: number };

export interface ChecklistItem {
  key: string;
  text: string;
}

export type MarkState = "done" | "skipped" | "open";

export const MARK_STATES: readonly MarkState[] = ["done", "skipped", "open"];

export interface ChecklistMark {
  state: MarkState;
  /** ISO timestamp; of two devices' marks on one item the later one wins. */
  at: string;
}

export interface ChecklistRun {
  /** A ULID. */
  id: string;
  /** The checklist note's vault path. Renaming the note updates it. */
  path: string;
  /** The note's name when the run was started or last renamed, so history survives deleting it. */
  title: string;
  /** ISO timestamp. */
  startedAt: string;
  /** ISO timestamp, or `null` while the run is under way. */
  finishedAt: string | null;
  /** The items as they were when the run was started, and again when it was finished. */
  items: ChecklistItem[];
  /** Item key → how it was marked. Items not marked yet have none. */
  marks: Record<string, ChecklistMark>;
}

export interface ChecklistStore {
  version: number;
  /** Newest first. */
  runs: ChecklistRun[];
}

export interface ChecklistRunStart {
  id: string;
  path: string;
  title: string;
  items: readonly ChecklistItem[];
}

const TASK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[.\](?:\s+(.*))?$/;

/** Splits a checklist note into its items and the Markdown between them. */
export function parseChecklist(markdown: string): ChecklistBlock[] {
  const blocks: ChecklistBlock[] = [];
  const counts = new Map<string, number>();
  let pending: string[] = [];
  // Indent widths of the items the current one may be nested under.
  let indents: number[] = [];
  const flush = () => {
    const chunk = dedent(trimBlankLines(pending));
    if (chunk) blocks.push({ kind: "markdown", markdown: chunk });
    pending = [];
  };
  for (const line of withoutFrontmatter(markdown).split(/\r?\n/)) {
    const match = TASK.exec(line);
    const text = match ? collapse(match[2] ?? "") : "";
    if (!match || !text) {
      pending.push(line);
      // A heading or a paragraph at the margin ends any nesting.
      if (line.trim() && !/^\s/.test(line)) indents = [];
      continue;
    }
    flush();
    const indent = width(match[1] ?? "");
    indents = indents.filter((previous) => previous < indent);
    const depth = indents.length;
    indents.push(indent);
    const seen = (counts.get(text) ?? 0) + 1;
    counts.set(text, seen);
    blocks.push({ kind: "item", key: seen === 1 ? text : `${text}#${seen}`, text, depth });
  }
  flush();
  return blocks;
}

export function checklistItems(blocks: readonly ChecklistBlock[]): ChecklistItem[] {
  return blocks.flatMap((block) => (block.kind === "item" ? [{ key: block.key, text: block.text }] : []));
}

export function emptyChecklistStore(): ChecklistStore {
  return { version: CHECKLIST_STORE_VERSION, runs: [] };
}

/** The run of this checklist that is under way, the newest if two devices each started one. */
export function openRun(store: ChecklistStore, path: string): ChecklistRun | undefined {
  return store.runs.find((run) => run.path === path && run.finishedAt === null);
}

export function findRun(store: ChecklistStore, runId: string): ChecklistRun | undefined {
  return store.runs.find((run) => run.id === runId);
}

/** Starts a run, unless one of this checklist is already under way; that one goes on instead. */
export function startRun(store: ChecklistStore, start: ChecklistRunStart, now: Date): ChecklistStore {
  if (openRun(store, start.path)) return store;
  const run: ChecklistRun = {
    id: start.id,
    path: start.path,
    title: start.title,
    startedAt: now.toISOString(),
    finishedAt: null,
    items: start.items.map((item) => ({ ...item })),
    marks: {},
  };
  return { ...store, runs: [run, ...store.runs].slice(0, RUN_LIMIT) };
}

export function markItem(store: ChecklistStore, runId: string, key: string, state: MarkState, now: Date): ChecklistStore {
  return updateRun(store, runId, (run) => ({ ...run, marks: { ...run.marks, [key]: { state, at: now.toISOString() } } }));
}

/** Ends a run, recording the items as the note has them now. */
export function finishRun(store: ChecklistStore, runId: string, items: readonly ChecklistItem[], now: Date): ChecklistStore {
  return updateRun(store, runId, (run) => (run.finishedAt !== null
    ? run
    : { ...run, finishedAt: now.toISOString(), items: items.map((item) => ({ ...item })) }));
}

export function discardRun(store: ChecklistStore, runId: string): ChecklistStore {
  return { ...store, runs: store.runs.filter((run) => run.id !== runId) };
}

/** Puts a discarded run back, as Undo does. */
export function restoreRun(store: ChecklistStore, run: ChecklistRun): ChecklistStore {
  if (findRun(store, run.id)) return store;
  return { ...store, runs: sortRuns([run, ...store.runs]).slice(0, RUN_LIMIT) };
}

/** Follows a checklist note that was renamed or moved. */
export function renameChecklist(store: ChecklistStore, oldPath: string, newPath: string, title: string): ChecklistStore {
  if (!store.runs.some((run) => run.path === oldPath)) return store;
  return { ...store, runs: store.runs.map((run) => (run.path === oldPath ? { ...run, path: newPath, title } : run)) };
}

/** Whether a run of this checklist was finished on the given local day. */
export function finishedOn(store: ChecklistStore, path: string, day: string): boolean {
  return store.runs.some((run) => run.path === path && run.finishedAt !== null && localDate(new Date(run.finishedAt)) === day);
}

/** The daily checklist is due until a run of it has been finished today. */
export function dailyChecklistDue(store: ChecklistStore, dailyPath: string, today = localDate()): boolean {
  return Boolean(dailyPath) && !finishedOn(store, dailyPath, today);
}

export function lastFinished(store: ChecklistStore, path: string): ChecklistRun | undefined {
  return store.runs.find((run) => run.path === path && run.finishedAt !== null);
}

/**
 * Items skipped in each of the last `REPEATED_SKIPS` finished runs of the checklist that
 * had them: candidates for taking off it. A run where the item wasn't on the list doesn't count.
 */
export function repeatedlySkipped(store: ChecklistStore, path: string, items: readonly ChecklistItem[]): string[] {
  const finished = store.runs.filter((run) => run.path === path && run.finishedAt !== null);
  return items
    .filter((item) => {
      const runs = finished.filter((run) => run.items.some((other) => other.key === item.key)).slice(0, REPEATED_SKIPS);
      return runs.length === REPEATED_SKIPS && runs.every((run) => run.marks[item.key]?.state === "skipped");
    })
    .map((item) => item.key);
}

/**
 * Merges this device's copy of the store with the file's (see `src/domain/merge.ts`).
 * Runs started on either device are kept and a discarded one is gone. When both devices
 * changed one run, each item keeps its later mark, a finish on either side stands, and a
 * rename on this device wins.
 */
export function mergeChecklistStores(base: ChecklistStore, mine: ChecklistStore, theirs: ChecklistStore): ChecklistStore {
  const id = (run: ChecklistRun) => run.id;
  const runs = [...mergeKeyed(byKey(base.runs, id), byKey(mine.runs, id), byKey(theirs.runs, id), (original, ours, other) => {
    const renamed = original !== undefined && (ours.path !== original.path || ours.title !== original.title);
    const finished = latestFinish(ours, other);
    return {
      ...(finished === other ? other : ours),
      path: renamed ? ours.path : other.path,
      title: renamed ? ours.title : other.title,
      marks: mergeMarks(ours.marks, other.marks),
    };
  }).values()];
  return { version: CHECKLIST_STORE_VERSION, runs: sortRuns(runs).slice(0, RUN_LIMIT) };
}

/** Reads a store file without trusting it: malformed runs are dropped, not fatal. */
export function parseChecklistStore(raw: unknown): ChecklistStore {
  if (!isRecord(raw)) return emptyChecklistStore();
  const runs = Array.isArray(raw.runs) ? raw.runs.flatMap(parseRun) : [];
  return { version: CHECKLIST_STORE_VERSION, runs: sortRuns(runs).slice(0, RUN_LIMIT) };
}

function parseRun(raw: unknown): ChecklistRun[] {
  if (!isRecord(raw)) return [];
  const id = text(raw.id);
  const path = text(raw.path);
  const startedAt = text(raw.startedAt);
  if (!id || !path || Number.isNaN(Date.parse(startedAt))) return [];
  const finishedAt = typeof raw.finishedAt === "string" && !Number.isNaN(Date.parse(raw.finishedAt)) ? raw.finishedAt : null;
  const items = Array.isArray(raw.items)
    ? raw.items.flatMap((item) => (isRecord(item) && text(item.key) ? [{ key: text(item.key), text: text(item.text) }] : []))
    : [];
  const marks: Record<string, ChecklistMark> = {};
  if (isRecord(raw.marks)) {
    for (const [key, mark] of Object.entries(raw.marks)) {
      if (isRecord(mark) && MARK_STATES.includes(mark.state as MarkState)) marks[key] = { state: mark.state as MarkState, at: text(mark.at) };
    }
  }
  return [{ id, path, title: text(raw.title), startedAt, finishedAt, items, marks }];
}

function updateRun(store: ChecklistStore, runId: string, change: (run: ChecklistRun) => ChecklistRun): ChecklistStore {
  const run = findRun(store, runId);
  if (!run) throw new Error("This checklist run no longer exists.");
  const next = change(run);
  if (same(next, run)) return store;
  return { ...store, runs: store.runs.map((other) => (other.id === runId ? next : other)) };
}

function latestFinish(mine: ChecklistRun, theirs: ChecklistRun): ChecklistRun {
  if (mine.finishedAt === null) return theirs.finishedAt === null ? mine : theirs;
  if (theirs.finishedAt === null) return mine;
  return mine.finishedAt >= theirs.finishedAt ? mine : theirs;
}

function mergeMarks(mine: Record<string, ChecklistMark>, theirs: Record<string, ChecklistMark>): Record<string, ChecklistMark> {
  const merged = { ...theirs };
  for (const [key, mark] of Object.entries(mine)) {
    const other = merged[key];
    if (!other || mark.at >= other.at) merged[key] = mark;
  }
  return merged;
}

function sortRuns(runs: ChecklistRun[]): ChecklistRun[] {
  return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function withoutFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start += 1;
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  return lines.slice(start, end);
}

/** Takes off the indentation all lines share, so a note nested under an item isn't read as code. */
function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(common, /^[ \t]*/.exec(line)![0].length))).join("\n");
}

function width(indent: string): number {
  return indent.replace(/\t/g, "    ").length;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
