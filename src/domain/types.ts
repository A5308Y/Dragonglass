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

/** The Project statuses that own a board column; Cancelled Projects leave the board. */
export const BOARD_PROJECT_STATUSES = [
  "active",
  "backlog",
  "someday",
  "completed",
] as const satisfies readonly (typeof PROJECT_STATUSES)[number][];

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
  /** The day a Waiting Action started waiting. Every Waiting Action carries one. */
  waitingSince?: string;
  /** The day to chase up a Waiting Action. Only Waiting Actions carry one, and it is optional. */
  followUp?: string;
  scheduledStart?: string;
  durationMinutes?: number;
  completed?: string;
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
  waitingSince?: string;
  followUp?: string;
  scheduledStart?: string;
  durationMinutes?: number;
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
  followUp?: string;
  scheduledStart?: string;
  durationMinutes?: number;
  /** Keeps the captured file as reference material instead of trashing it once it is processed. */
  fileOriginal?: boolean;
}

export type ActionChanges = Partial<
  Pick<Action, "title" | "status" | "projectId" | "context" | "energy" | "due" | "waitingSince" | "followUp" | "scheduledStart" | "durationMinutes">
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

export type ValueFilterField = "status" | "project" | "context" | "energy" | "area";
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

export type ActionFilter = ValueFilter | DueFilter;
export type GroupBy = "status" | "project" | "context" | "energy";
/** `manual` is the order set by dragging cards, stored as each Action's `priority`. */
export type SortField = "manual" | "created" | "due" | "title" | "project";
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
  groupProjectBoardByArea: boolean;
  defaultActionStatus: ActionStatus;
  showDoneColumn: boolean;
  projectBoardColumns: ProjectStatus[];
  savedViews: SavedView[];
  activeSavedViewId: string | null;
  googleCalendar: GoogleCalendarSettings;
  feeds: FeedSettings;
  mail: MailSettings;
  pomodoro: PomodoroSettings;
  schemaVersion: number;
}

export interface PomodoroSettings {
  /** The vault-relative JSON file holding the running session and the session log. */
  storePath: string;
  /** The length a new session starts with. */
  focusMinutes: number;
  /** Also add one line per finished session to the Project's Diary. */
  logToDiary: boolean;
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
