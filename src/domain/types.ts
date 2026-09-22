import type { TFile } from "obsidian";

export const ACTION_STATUSES = [
  "next",
  "waiting",
  "scheduled",
  "done",
  "cancelled",
] as const;

export const PROJECT_STATUSES = [
  "active",
  "backlog",
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
  raw?: boolean;
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
  /** The day a Waiting Action started waiting. Every Waiting Action carries one. */
  waitingSince?: string;
  scheduledStart?: string;
  durationMinutes?: number;
  completed?: string;
  /** Marks the Action as work, independent of its context. */
  work?: boolean;
  /** Persistent, user-defined priority on the Actions Board. Lower comes first. */
  priority?: number;
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
  /** Local date on which a Someday/Maybe Project should become Active. */
  activateAt?: string;
  completed?: string;
  supportPath?: string;
  image?: string;
  tags?: string[];
  order?: number;
  blockedByProjectIds?: string[];
  parentProjectId?: string;
  parentProjectLink?: string;
}

export interface ActionInput {
  title: string;
  status: ActionStatus;
  projectId?: string;
  context: string;
  energy?: string;
  due?: string;
  deferUntil?: string;
  waitingSince?: string;
  scheduledStart?: string;
  durationMinutes?: number;
  work?: boolean;
}

export interface ProjectInput {
  title: string;
  status?: ProjectStatus;
  activateAt?: string;
  area?: string;
  image?: string;
  tags?: string[];
  parentProjectId?: string;
}

export interface InboxProcessingInput {
  projectId?: string;
  projectTitle?: string;
  desiredOutcome?: string;
  nextAction?: string;
  /** The status for an Action created while clarifying this Inbox Item. */
  status?: ActionStatus;
  context?: string;
  waitingSince?: string;
  scheduledStart?: string;
  durationMinutes?: number;
  work?: boolean;
  /** Keeps the captured file as reference material instead of trashing it once it is processed. */
  fileOriginal?: boolean;
}

export type ActionChanges = Partial<
  Pick<Action, "title" | "status" | "projectId" | "context" | "energy" | "due" | "deferUntil" | "waitingSince" | "scheduledStart" | "durationMinutes" | "work">
>;

export type ProjectChanges = Partial<
  Pick<Project, "title" | "status" | "area" | "reviewed" | "activateAt" | "supportPath" | "image" | "tags" | "order" | "blockedByProjectIds" | "parentProjectId">
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

export interface WorkFilter {
  kind: "work";
  value: boolean;
}

export type ActionFilter = ValueFilter | DueFilter | AvailabilityFilter | WorkFilter;
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
  referenceDirectory: string;
  projectsDirectory: string;
  actionsDirectory: string;
  defaultProjectImage: string;
  showProjectBoardImages: boolean;
  defaultActionStatus: ActionStatus;
  showDoneColumn: boolean;
  projectBoardColumns: ProjectStatus[];
  savedViews: SavedView[];
  activeSavedViewId: string | null;
  googleCalendar: GoogleCalendarSettings;
  feeds: FeedSettings;
  mail: MailSettings;
  schemaVersion: number;
}

export interface FeedSettings {
  enabled: boolean;
  /** The vault-relative JSON file holding subscriptions and triage state. */
  storePath: string;
  /** Minutes between automatic fetches. Five is the floor. */
  refreshMinutes: number;
}

export interface MailSettings {
  enabled: boolean;
  /** The vault-relative JSON file holding sync watermarks, which syncs between devices. */
  storePath: string;
  /** Minutes between automatic imports. Five is the floor. */
  refreshMinutes: number;
  /** How many messages one import turns into Inbox Items before deferring the rest. */
  importCap: number;
  accounts: MailAccountSettings[];
  /**
   * App passwords by account id.
   *
   * Stored as plain text in the plugin data file, like the calendar shared secret,
   * and deliberately not in the vault file the watermarks live in — that one syncs.
   */
  passwords: Record<string, string>;
}

export interface MailAccountSettings {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  mailboxes: string[];
  /** An IMAP SEARCH criterion narrowing what counts, such as `ALL` or `UNSEEN`. */
  criterion: string;
  /** Where an imported message is moved, or `""` to leave the server untouched. */
  archiveMailbox: string;
  enabled: boolean;
}

export interface GoogleCalendarSettings {
  enabled: boolean;
  endpointUrl: string;
  sharedSecret: string;
  sourceId: string;
  defaultDurationMinutes: number;
}
