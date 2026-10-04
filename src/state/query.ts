import { ACTION_STATUSES, type Action, type ActionFilter, type BoardConfiguration, type GtdSnapshot, type GroupBy, type Project, type SortSpec } from "../domain/types";
import { addLocalDays, localDate } from "../utils/date";
import { estimateLabel, estimateStep } from "../domain/estimate";
import { projectArea, projectBreadcrumb, projectLineage } from "../domain/project-hierarchy";

export interface ActionGroup {
  key: string;
  label: string;
  actions: Action[];
}

function valueFor(action: Action, field: "status" | "project" | "context" | "energy" | "estimate"): string {
  if (field === "status") return action.status;
  if (field === "project") return action.projectId ?? "";
  if (field === "context") return action.context ?? "";
  if (field === "estimate") return action.estimate ? String(action.estimate) : "";
  return action.energy ?? "";
}

/**
 * Project and area filters look up the Project tree: a Project filter matches the
 * Actions of the Project's sub-projects at any depth, and an area filter matches the
 * area of the Action's top-level Project, which every sub-project shares.
 */
export function matchesFilter(
  action: Action,
  filter: ActionFilter,
  today = localDate(),
  projectsById: ReadonlyMap<string, Project> = new Map(),
): boolean {
  if (filter.kind === "value") {
    const matched = filter.field === "area"
      ? Boolean(action.projectId) && filter.values.includes(projectArea(action.projectId!, projectsById) ?? "")
      : filter.values.includes(valueFor(action, filter.field))
        || (filter.field === "project" && Boolean(action.projectId)
          && projectLineage(action.projectId!, projectsById).some((project) => filter.values.includes(project.id)));
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
    if (!filters.every((filter) => matchesFilter(action, filter, localDate(), projectsById))) return false;
    if (!needle) return true;
    const project = action.projectId ? projectsById.get(action.projectId) : undefined;
    const projectTitle = project ? projectBreadcrumb(project, projectsById) : "";
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
    // Unranked Actions follow the ranked ones in both directions, like Actions without a due date.
    if (spec.field === "manual" && (left.priority === undefined || right.priority === undefined)) {
      if (left.priority === undefined && right.priority === undefined) return left.id.localeCompare(right.id);
      return left.priority === undefined ? 1 : -1;
    }
    if (spec.field === "manual") result = left.priority! - right.priority!;
    else if (spec.field === "created") result = compareNullable(left.created, right.created, false);
    else if (spec.field === "due") result = compareNullable(left.due, right.due, true);
    else if (spec.field === "title") result = compareNullable(left.title, right.title, false);
    else {
      result = compareNullable(
        left.projectId && projectsById.get(left.projectId) ? projectBreadcrumb(projectsById.get(left.projectId)!, projectsById) : undefined,
        right.projectId && projectsById.get(right.projectId) ? projectBreadcrumb(projectsById.get(right.projectId)!, projectsById) : undefined,
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
  if (groupBy === "estimate") return action.estimate ? String(action.estimate) : "";
  return action.energy ?? "";
}

function groupLabel(key: string, groupBy: GroupBy, projectsById: ReadonlyMap<string, Project>): string {
  if (!key) {
    if (groupBy === "project") return "No project";
    if (groupBy === "context") return "No context";
    if (groupBy === "estimate") return "No estimate";
    return "Normal energy";
  }
  if (groupBy === "estimate") return estimateLabel(estimateStep(Number(key)));
  if (groupBy === "project") {
    const project = projectsById.get(key);
    return project ? projectBreadcrumb(project, projectsById) : `Missing project (${key})`;
  }
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
    if (groupBy === "estimate") return Number(left) - Number(right);
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
