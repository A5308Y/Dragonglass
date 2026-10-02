import type { TFile } from "obsidian";
import type { MiteSettings } from "./mite";

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

/** The Project statuses that can be board columns: all of them. */
export const BOARD_PROJECT_STATUSES = PROJECT_STATUSES;

/** The columns shown until the person picks their own; Cancelled is there to switch on. */
export const DEFAULT_PROJECT_BOARD_COLUMNS = [
  "active",
  "backlog",
  "someday",
  "completed",
] as const satisfies readonly (typeof PROJECT_STATUSES)[number][];

/** How much energy an Action takes when it is out of the ordinary; no level means normal. */
export const ENERGY_LEVELS = ["low", "high"] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type Energy = (typeof ENERGY_LEVELS)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface InboxItem {
  type: "gtd-inbox-item";
  id: string;
  title: string;
  file: TFile;
  created: string;
  legacyAction?: boolean;
  raw?: boolean;
  /** The `Message-ID` of the email this Item was imported from, which links back to it. */
  messageId?: string;
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
  energy?: Energy;
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
  /** Only top-level Projects carry one; sub-projects share their top-level ancestor's (see `projectArea`). */
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
  /**
   * Wikilinks to vault files the Project refers to without owning them, as written in
   * `linked_files`. Obsidian keeps them current when the files move, and deleting the
   * Project leaves the files alone.
   */
  linkedFiles?: string[];
  /** Web links as written in `external_links`: `[Title](https://…)` or a bare URL. */
  externalLinks?: string[];
}

export interface ActionInput {
  title: string;
  status: ActionStatus;
  projectId?: string;
  context: string;
  energy?: Energy;
  due?: string;
  waitingSince?: string;
  followUp?: string;
  scheduledStart?: string;
  durationMinutes?: number;
  /** Markdown under the title of a new Action's note, e.g. the links an agent run left. */
  body?: string;
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
  energy?: Energy;
  waitingSince?: string;
  followUp?: string;
  scheduledStart?: string;
  durationMinutes?: number;
  /** Keeps the captured file as reference material instead of trashing it once it is processed. */
  fileOriginal?: boolean;
}

export type ActionChanges = Partial<
  Pick<Action, "title" | "status" | "projectId" | "context" | "due" | "waitingSince" | "followUp" | "scheduledStart" | "durationMinutes">
> & {
  /** Empty clears the energy level. */
  energy?: Energy | "";
};

/** How a Project write treats the tree rules; see `GtdRepository.updateProject`. */
export interface ProjectWriteOptions {
  /** Reopens Completed or Cancelled parents of a Project that becomes Active. The views ask first. */
  reopenAncestors?: boolean;
  /** Puts an earlier state back exactly, as Undo does, without applying the tree rules. */
  restoring?: boolean;
}

export type ProjectChanges = Partial<
  Pick<Project, "title" | "status" | "area" | "reviewed" | "activateAt" | "supportPath" | "image" | "tags" | "order" | "blockedByProjectIds" | "parentProjectId">
>;

export interface IndexIssue {
  path: string;
  message: string;
  kind: "invalid" | "duplicate-id" | "stranded";
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
  /** What splits each column into sections, if anything; never the same as `groupBy`. */
  sectionBy?: GroupBy | null;
  sort: SortSpec;
  visibleColumns: string[] | null;
}

export interface BoardConfiguration {
  filters: ActionFilter[];
  groupBy: GroupBy;
  sectionBy?: GroupBy | null;
  sort: SortSpec;
  visibleColumns: string[] | null;
}

/** What the Projects board's columns are: its statuses, or the areas of its Projects. */
export type ProjectBoardColumnsBy = "status" | "area";
/** What splits each Projects board column into sections. */
export type ProjectBoardSections = "none" | "area" | "status";

export interface GtdSettings {
  inboxDirectory: string;
  referenceDirectory: string;
  projectsDirectory: string;
  actionsDirectory: string;
  defaultProjectImage: string;
  showProjectBoardImages: boolean;
  projectBoardColumnsBy: ProjectBoardColumnsBy;
  projectBoardSections: ProjectBoardSections;
  defaultActionStatus: ActionStatus;
  showDoneColumn: boolean;
  projectBoardColumns: ProjectStatus[];
  savedViews: SavedView[];
  activeSavedViewId: string | null;
  googleCalendar: GoogleCalendarSettings;
  feeds: FeedSettings;
  mail: MailSettings;
  pomodoro: PomodoroSettings;
  checklists: ChecklistSettings;
  brainstorm: BrainstormSettings;
  agent: AgentSettings;
  /** The weekday the Weekly Review falls due, as `Date.getDay()` counts: 0 is Sunday. */
  weeklyReviewDay: number;
  /** The day the last Weekly Review was finished, or `""` before the first one. */
  lastWeeklyReview: string;
  /** Writes how long clicks, index updates and redraws take to the developer console. */
  logTimings: boolean;
  schemaVersion: number;
}

/** Delegating a Project tree to an agent in a local container; see `agent/README.md`. */
export interface AgentSettings {
  /** Where run folders live, outside the vault. Empty means the platform default. */
  runsDirectory: string;
  /** The folder holding `compose.yaml` and the runner and proxy images: the repository's `agent/`. */
  kitDirectory: string;
  /** The `docker` binary. Empty means the usual install locations are tried. */
  dockerPath: string;
  /** The macOS Keychain item (service name) holding the Anthropic API key. */
  keychainService: string;
  /** The spending cap a new run starts with, in US dollars. */
  defaultBudgetUsd: number;
  model: string;
  /** How many turns (tool round trips) a Claude run may take before it is stopped. */
  maxTurns: number;
  /** Whether an ended run leaves an Inbox Item with its report, to be processed like anything else. */
  reportToInbox: boolean;
  /** The local model's id on the model server; empty uses whichever model is loaded. */
  localModel: string;
  /** The OpenAI-compatible model server as the containers see your Mac, e.g. LM Studio. */
  localModelUrl: string;
  /** The Keychain item holding the model server's API key, or empty when it needs none. */
  localKeychainService: string;
  /** How long a local run may take, in minutes. */
  localMaxMinutes: number;
  /** How many turns a local run may take; they cost nothing, so this can be much higher. */
  localMaxTurns: number;
  /**
   * The folder holding Codex's ChatGPT sign-in, Dragonglass's own rather than ~/.codex, so it
   * can be ended on its own. Empty means the default next to the runs folder.
   */
  codexHomeDirectory: string;
  /** The model Codex runs use; empty leaves the choice to Codex. */
  codexModel: string;
  /** How long a Codex run may take, in minutes. */
  codexMaxMinutes: number;
  /** The context length the local model is loaded with, in tokens; the run stays well below it. */
  localContextTokens: number;
  /** The longest single reply a local model may write, in tokens, thinking included. */
  localMaxReplyTokens: number;
  lamdera: LamderaAgentSettings;
}

/**
 * Code runs: the Lamdera coding agent (its own repository, lamdera_linear_agent_ruby) changes
 * one of the Lamdera apps and opens a pull request. Its sign-ins and its list of repositories
 * stay with that agent; Dragonglass only names a repository and starts a run.
 */
export interface LamderaAgentSettings {
  /** The coding agent's checkout, holding its compose.yml. Empty turns code runs off. */
  kitDirectory: string;
  /** Its Compose env file, relative to the checkout: it sets the instance's project name and volumes. */
  envFile: string;
  /** Its repositories file, relative to the checkout, read for the names it knows. */
  repositoriesFile: string;
  /** Dragonglass Project id → repository name in that file. Sub-projects inherit it. */
  repositories: Record<string, string>;
  /** The context of the "Review PR" Next Action a finished code run leaves. */
  reviewContext: string;
}

export const POMODORO_SOUNDS = ["off", "ticking", "folder"] as const;
export type PomodoroSound = (typeof POMODORO_SOUNDS)[number];

export interface PomodoroSettings {
  /** The vault-relative JSON file holding the running session and the session log. */
  storePath: string;
  /** The length a new session starts with. */
  focusMinutes: number;
  /** Also add one line per finished session to the Project's Diary. */
  logToDiary: boolean;
  /** What plays while a session runs: nothing, a clock tick, or the sound folder's files. */
  sound: PomodoroSound;
  /** Vault folder whose audio files play, one after another at random, for `sound: "folder"`. */
  soundFolder: string;
  /** Volume of either sound, 0 to 100. */
  soundVolume: number;
  /** Sending finished sessions to mite as time entries. */
  mite: MiteSettings;
}

export interface BrainstormSettings {
  /** The vault folder whose images the Brainstorm view shows, one at a time, as inspiration. */
  imagesDirectory: string;
}

/** Checklist notes and their runs; see `src/domain/checklist.ts`. */
export interface ChecklistSettings {
  /** The folder whose notes are checklists. */
  directory: string;
  /** The vault-relative JSON file holding the runs. */
  storePath: string;
  /** The path of the checklist to work through every day, or `""` for none. */
  daily: string;
}

export interface FeedSettings {
  enabled: boolean;
  /** The vault-relative JSON file holding subscriptions and triage state. */
  storePath: string;
  /** Minutes between automatic fetches. Five is the floor. */
  refreshMinutes: number;
  /** The context of reading Actions made straight from a feed Item. */
  readingContext: string;
}

export interface MailSettings {
  enabled: boolean;
  /** The vault-relative JSON file holding sync watermarks, which syncs between devices. */
  storePath: string;
  /** Minutes between automatic imports. Five is the floor. */
  refreshMinutes: number;
  /** How many messages one import turns into Inbox Items before deferring the rest. */
  importCap: number;
  /** The context of review Actions made from a pull request while processing. */
  reviewContext: string;
  accounts: MailAccountSettings[];
  /**
   * Old copies of app passwords by account id, from before they moved to Obsidian's
   * secret storage (`MailPasswords`). Read only to migrate them; nothing new is written
   * here, and the person removes them in the settings once every computer has copied them.
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
  /** Adds a link to each imported note that opens the message in Apple Mail. */
  appleMailLink?: boolean;
  enabled: boolean;
}

export interface GoogleCalendarSettings {
  enabled: boolean;
  endpointUrl: string;
  /**
   * An old copy of the bridge's shared secret, from before it moved to Obsidian's secret
   * storage (`CalendarSecret`). Read only to migrate it; nothing new is written here.
   */
  sharedSecret: string;
  sourceId: string;
  defaultDurationMinutes: number;
}
