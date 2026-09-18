import { ACTION_STATUSES, type Action, type ActionFilter, type BoardConfiguration, type GtdSnapshot, type GroupBy, type Project, type SortSpec } from "../domain/types";
import { addLocalDays, localDate } from "../utils/date";

export interface ActionGroup {
  key: string;
  label: string;
  actions: Action[];
}

function valueFor(action: Action, field: "status" | "project" | "context" | "energy"): string {
  if (field === "status") return action.status;
  if (field === "project") return action.projectId ?? "";
  if (field === "context") return action.context ?? "";
  return action.energy ?? "";
}

export function matchesFilter(action: Action, filter: ActionFilter, today = localDate()): boolean {
  if (filter.kind === "availability") {
    return !action.deferUntil || action.deferUntil <= today;
  }
  if (filter.kind === "value") {
    const matched = filter.values.includes(valueFor(action, filter.field));
    return filter.operator === "in" ? matched : !matched;
  }
  const due = action.due;
  if (filter.operator === "isEmpty") return !due;
  if (filter.operator === "isNotEmpty") return Boolean(due);
  if (!due) return false;
  if (filter.operator === "withinNextDays") {
    const days = typeof filter.value === "number" ? filter.value : Number(filter.value ?? 7);
    return due >= today && due <= addLocalDays(today, Number.isFinite(days) ? days : 7);
  }
  const target = String(filter.value ?? "");
  if (filter.operator === "before") return due < target;
  if (filter.operator === "onOrBefore") return due <= target;
  if (filter.operator === "after") return due > target;
  return due >= target;
}

export function filterActions(
  actions: readonly Action[],
  filters: readonly ActionFilter[],
  search: string,
  projectsById: ReadonlyMap<string, Project>,
): Action[] {
  const needle = search.trim().toLocaleLowerCase();
  return actions.filter((action) => {
    if (!filters.every((filter) => matchesFilter(action, filter))) return false;
    if (!needle) return true;
    const projectTitle = action.projectId ? projectsById.get(action.projectId)?.title ?? "" : "";
    return action.title.toLocaleLowerCase().includes(needle) || projectTitle.toLocaleLowerCase().includes(needle);
  });
}

function compareNullable(left: string | undefined, right: string | undefined, emptyLast: boolean): number {
  if (!left && !right) return 0;
  if (!left) return emptyLast ? 1 : -1;
  if (!right) return emptyLast ? -1 : 1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function sortActions(actions: readonly Action[], spec: SortSpec, projectsById: ReadonlyMap<string, Project>): Action[] {
  const direction = spec.direction === "asc" ? 1 : -1;
  return [...actions].sort((left, right) => {
    if (spec.field === "due" && (!left.due || !right.due)) {
      if (!left.due && !right.due) return left.id.localeCompare(right.id);
      return left.due ? -1 : 1;
    }
    let result: number;
    if (spec.field === "created") result = compareNullable(left.created, right.created, false);
    else if (spec.field === "due") result = compareNullable(left.due, right.due, true);
    else if (spec.field === "title") result = compareNullable(left.title, right.title, false);
    else {
      result = compareNullable(
        left.projectId ? projectsById.get(left.projectId)?.title : undefined,
        right.projectId ? projectsById.get(right.projectId)?.title : undefined,
        true,
      );
    }
    return result === 0 ? left.id.localeCompare(right.id) : result * direction;
  });
}

function groupKey(action: Action, groupBy: GroupBy): string {
  if (groupBy === "status") return action.status;
  if (groupBy === "project") return action.projectId ?? "";
  if (groupBy === "context") return action.context ?? "";
  return action.energy ?? "";
}

function groupLabel(key: string, groupBy: GroupBy, projectsById: ReadonlyMap<string, Project>): string {
  if (!key) {
    if (groupBy === "project") return "No project";
    if (groupBy === "context") return "No context";
    return "No energy";
  }
  if (groupBy === "project") return projectsById.get(key)?.title ?? `Missing project (${key})`;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function groupActions(actions: readonly Action[], groupBy: GroupBy, projectsById: ReadonlyMap<string, Project>): ActionGroup[] {
  const groups = new Map<string, Action[]>();
  for (const action of actions) {
    const key = groupKey(action, groupBy);
    const group = groups.get(key) ?? [];
    group.push(action);
    groups.set(key, group);
  }
  const keys = [...groups.keys()];
  keys.sort((left, right) => {
    if (groupBy === "status") return ACTION_STATUSES.indexOf(left as (typeof ACTION_STATUSES)[number]) - ACTION_STATUSES.indexOf(right as (typeof ACTION_STATUSES)[number]);
    if (!left) return 1;
    if (!right) return -1;
    return groupLabel(left, groupBy, projectsById).localeCompare(groupLabel(right, groupBy, projectsById), undefined, { sensitivity: "base" });
  });
  return keys.map((key) => ({ key, label: groupLabel(key, groupBy, projectsById), actions: groups.get(key) ?? [] }));
}

export function buildBoard(snapshot: GtdSnapshot, configuration: BoardConfiguration, search = ""): ActionGroup[] {
  const filtered = filterActions(snapshot.actions, configuration.filters, search, snapshot.projectsById);
  const sorted = sortActions(filtered, configuration.sort, snapshot.projectsById);
  const groups = groupActions(sorted, configuration.groupBy, snapshot.projectsById);
  if (!configuration.visibleColumns) return groups;
  const visible = new Set(configuration.visibleColumns);
  return groups.filter((group) => visible.has(group.key));
}
