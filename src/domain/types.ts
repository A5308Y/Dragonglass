import type { TFile } from "obsidian";

export const ACTION_STATUSES = [
  "next",
  "waiting",
  "scheduled",
  "someday",
  "done",
  "cancelled",
] as const;

export const PROJECT_STATUSES = [
  "active",
  "waiting",
  "someday",
  "completed",
  "cancelled",
] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface InboxItem {
  type: "gtd-inbox-item";
  id: string;
  title: string;
  file: TFile;
  created: string;
  legacyAction?: boolean;
}

export interface Action {
  type: "gtd-action";
  id: string;
  title: string;
  file: TFile;
  status: ActionStatus;
  created: string;
  projectId?: string;
  projectLink?: string;
  context?: string;
  energy?: string;
  due?: string;
  deferUntil?: string;
  completed?: string;
}

export interface Project {
  type: "gtd-project";
  id: string;
  title: string;
  file: TFile;
  status: ProjectStatus;
  created: string;
  area?: string;
  reviewed?: string;
  completed?: string;
  supportPath?: string;
}

export interface ActionInput {
  title: string;
  status: ActionStatus;
  projectId?: string;
  context?: string;
  energy?: string;
  due?: string;
  deferUntil?: string;
}

export interface ProjectInput {
  title: string;
  status?: ProjectStatus;
  area?: string;
}

export type ActionChanges = Partial<
  Pick<Action, "title" | "status" | "projectId" | "context" | "energy" | "due" | "deferUntil">
>;

export type ProjectChanges = Partial<
  Pick<Project, "title" | "status" | "area" | "reviewed" | "supportPath">
>;

export interface IndexIssue {
  path: string;
  message: string;
  kind: "invalid" | "duplicate-id";
}

export interface GtdSnapshot {
  revision: number;
  inboxItems: readonly InboxItem[];
  actions: readonly Action[];
  projects: readonly Project[];
  inboxItemsById: ReadonlyMap<string, InboxItem>;
  actionsById: ReadonlyMap<string, Action>;
  projectsById: ReadonlyMap<string, Project>;
  issues: readonly IndexIssue[];
}

export type ValueFilterField = "status" | "project" | "context" | "energy";
export interface ValueFilter {
  kind: "value";
  field: ValueFilterField;
  operator: "in" | "notIn";
  values: string[];
}

export interface DueFilter {
  kind: "due";
  operator:
    | "before"
    | "onOrBefore"
    | "after"
    | "onOrAfter"
    | "withinNextDays"
    | "isEmpty"
    | "isNotEmpty";
  value?: string | number;
}

export interface AvailabilityFilter {
  kind: "availability";
  operator: "available";
}

export type ActionFilter = ValueFilter | DueFilter | AvailabilityFilter;
export type GroupBy = "status" | "project" | "context" | "energy";
export type SortField = "created" | "due" | "title" | "project";
export type SortDirection = "asc" | "desc";

export interface SortSpec {
  field: SortField;
  direction: SortDirection;
}

export interface SavedView {
  id: string;
  name: string;
  filters: ActionFilter[];
  groupBy: GroupBy;
  sort: SortSpec;
  visibleColumns: string[] | null;
}

export interface BoardConfiguration {
  filters: ActionFilter[];
  groupBy: GroupBy;
  sort: SortSpec;
  visibleColumns: string[] | null;
}

export interface GtdSettings {
  inboxDirectory: string;
  projectsDirectory: string;
  actionsDirectory: string;
  defaultActionStatus: ActionStatus;
  showDoneColumn: boolean;
  savedViews: SavedView[];
  activeSavedViewId: string | null;
  schemaVersion: number;
}
