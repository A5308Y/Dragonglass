/**
 * The Action Board's saved views, shared by every device through `GTD/views.json`
 * (see `src/state/synced-json-file.ts`). They used to live in the plugin settings,
 * which each device writes whole, so one device's older copy could undo another's
 * new view. Which view is open is each device's own and isn't in the store.
 */

import { byKey, mergeKeyed } from "./merge";
import type { SavedView } from "./types";

export const SAVED_VIEWS_VERSION = 1;

export interface SavedViewStore {
  version: number;
  /** In the order the board lists them. */
  views: SavedView[];
}

export function emptySavedViewStore(): SavedViewStore {
  return { version: SAVED_VIEWS_VERSION, views: [] };
}

/** Adds the view, or replaces the one with its id in place. */
export function upsertSavedView(store: SavedViewStore, view: SavedView): SavedViewStore {
  const exists = store.views.some((candidate) => candidate.id === view.id);
  return {
    ...store,
    views: exists ? store.views.map((candidate) => (candidate.id === view.id ? view : candidate)) : [...store.views, view],
  };
}

export function deleteSavedView(store: SavedViewStore, id: string): SavedViewStore {
  return { ...store, views: store.views.filter((view) => view.id !== id) };
}

/**
 * Merges this device's views with the file's, view by view: one added on either device
 * is kept, one deleted on either is gone, and one edited on both takes this device's
 * edit, the newer one.
 */
export function mergeSavedViewStores(base: SavedViewStore, mine: SavedViewStore, theirs: SavedViewStore): SavedViewStore {
  const id = (view: SavedView) => view.id;
  const views = mergeKeyed(byKey(base.views, id), byKey(mine.views, id), byKey(theirs.views, id), (_base, ours) => ours);
  return { version: SAVED_VIEWS_VERSION, views: [...views.values()] };
}

/**
 * The store a device starts from: the file when it has one, and the views this device
 * still kept in its settings that the file lacks, so nothing made before the move is
 * lost. With neither, the default views.
 */
export function startingSavedViews(
  file: SavedViewStore | null,
  legacy: readonly SavedView[] | null,
  defaults: () => SavedView[],
): SavedViewStore {
  if (!file) return { version: SAVED_VIEWS_VERSION, views: legacy ? [...legacy] : defaults() };
  if (!legacy) return file;
  const known = new Set(file.views.map((view) => view.id));
  return { ...file, views: [...file.views, ...legacy.filter((view) => !known.has(view.id))] };
}

/** Reads a store file without trusting it: malformed views are dropped, not fatal. */
export function parseSavedViewStore(raw: unknown): SavedViewStore {
  if (!isRecord(raw) || !Array.isArray(raw.views)) return emptySavedViewStore();
  const seen = new Set<string>();
  const views = migrateSavedViews(raw.views.filter(isRecord) as unknown as SavedView[])
    .filter((view) => isSavedView(view) && !seen.has(view.id) && Boolean(seen.add(view.id)));
  return { version: SAVED_VIEWS_VERSION, views };
}

/**
 * Brings views saved by older versions up to date: the Inbox and Someday/Maybe views
 * and statuses went, and so did deferring Actions and the work flag, with their filters.
 */
export function migrateSavedViews(views: SavedView[]): SavedView[] {
  return views
    .filter((view) => view.id !== "default-inbox" && view.id !== "default-someday" && !(view.filters ?? []).some((filter) =>
      filter.kind === "value"
      && filter.field === "status"
      && filter.operator === "in"
      && filter.values.length > 0
      && filter.values.every((value) => value === "inbox" || value === "someday")
    ) && !(view.visibleColumns?.length && view.visibleColumns.every((column) => column === "inbox" || column === "someday")))
    .map((view) => ({
      ...view,
      filters: (view.filters ?? []).flatMap((filter) => {
        const kind = (filter as { kind: string }).kind;
        if (kind === "availability" || kind === "work") return [];
        if (filter.kind !== "value" || filter.field !== "status") return [filter];
        const values = filter.values.filter((value) => value !== "inbox" && value !== "someday");
        return values.length ? [{ ...filter, values }] : [];
      }),
      visibleColumns: view.visibleColumns?.filter((column) => column !== "inbox" && column !== "someday") ?? null,
    }));
}

const GROUP_BY = ["status", "project", "context", "energy", "estimate"];

export function isSavedView(value: unknown): value is SavedView {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && Array.isArray(value.filters)
    && value.filters.every(isActionFilter)
    && GROUP_BY.includes(String(value.groupBy))
    && (value.sectionBy === undefined || value.sectionBy === null || GROUP_BY.includes(String(value.sectionBy)))
    && isSortSpec(value.sort)
    && (value.visibleColumns === null || isStringArray(value.visibleColumns));
}

function isActionFilter(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "value") {
    return ["status", "project", "context", "energy", "estimate", "area"].includes(String(value.field))
      && (value.operator === "in" || value.operator === "notIn")
      && isStringArray(value.values);
  }
  if (value.kind === "due") {
    if (["before", "onOrBefore", "after", "onOrAfter"].includes(String(value.operator))) {
      return typeof value.value === "string";
    }
    if (value.operator === "withinNextDays") return Number.isInteger(value.value) && Number(value.value) >= 0;
    return (value.operator === "isEmpty" || value.operator === "isNotEmpty") && value.value === undefined;
  }
  return false;
}

function isSortSpec(value: unknown): boolean {
  return isRecord(value)
    && ["manual", "created", "due", "title", "project"].includes(String(value.field))
    && (value.direction === "asc" || value.direction === "desc");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
