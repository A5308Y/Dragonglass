import type { FeedStoreData } from "../domain/feed";
import { feedItemAge } from "../domain/feed-triage";
import { isAllDaySchedule } from "../domain/schedule";
import { ACTION_STATUSES, PROJECT_STATUSES } from "../domain/types";
import type { Action, GtdSettings, GtdSnapshot, InboxItem, InboxProcessingInput, Project, SavedView } from "../domain/types";

export const ELM_PROTOCOL_VERSION = 2;

export interface ElmFileDto {
  path: string;
  name: string;
  basename: string;
  extension: string;
}

export interface ElmActionDto extends Omit<Action, "file"> {
  file: ElmFileDto;
  /**
   * A timed `scheduledStart` as local wall-clock `YYYY-MM-DDTHH:mm`.
   * Only the host knows the vault's zone, so the editor is given the reading it shows.
   */
  scheduledLocal?: string;
}

export interface ElmProjectDto extends Omit<Project, "file"> {
  file: ElmFileDto;
}

export interface ElmProjectMetaDto {
  id: string;
  breadcrumb: string;
  activeSubprojects: number;
  supportFiles: number;
  imageUrl: string;
  actionIssue: string | null;
  blockers: string[];
}

export interface ElmProjectSupportFileDto extends ElmFileDto {
  label: string;
  kind: "note" | "image" | "attachment";
  resourceUrl: string;
}

export interface ElmDiaryEntryDto {
  timestamp: string;
  text: string;
}

export interface ElmProjectDetailDto {
  projectId: string;
  desiredOutcome: string;
  diary: ElmDiaryEntryDto[];
  supportFiles: ElmProjectSupportFileDto[];
  supportFolders: Array<{ path: string; label: string }>;
}

export interface ElmReviewProjectDataDto {
  projectId: string;
  desiredOutcome: string;
  diary: ElmDiaryEntryDto[];
}

export interface ElmInboxItemDto extends Omit<InboxItem, "file"> {
  file: ElmFileDto;
  resourceUrl: string;
}

export interface ElmFeedItemDto {
  key: string;
  title: string;
  link: string;
  published: string;
  /** How old the Item reads on a row, computed by the host so Elm needs no clock. */
  age: string;
  author: string;
  summary: string;
}

export interface ElmFeedDto {
  id: string;
  title: string;
  url: string;
  enabled: boolean;
  /** When this feed was last fetched, or `""`. */
  fetched: string;
  /** Why this feed's last fetch failed, or `""`. */
  error: string;
  items: ElmFeedItemDto[];
}

/**
 * The Feeds surface is fed separately from the GTD snapshot.
 *
 * Feed Items are not vault entities, so they never travel in a snapshot; a fetch
 * that adds two hundred rows must not look like two hundred Projects changing.
 */
export interface ElmFeedsDto {
  protocolVersion: typeof ELM_PROTOCOL_VERSION;
  /** False while the integration is switched off, which is what the empty state explains. */
  enabled: boolean;
  state: "disabled" | "idle" | "fetching" | "success" | "error";
  lastFetch: string;
  error: string;
  /** How many Items the last sweep took, and therefore what Undo would put back. */
  undoCount: number;
  feeds: ElmFeedDto[];
}

export interface ElmSnapshotDto {
  protocolVersion: typeof ELM_PROTOCOL_VERSION;
  revision: number;
  today: string;
  inboxItems: ElmInboxItemDto[];
  actions: ElmActionDto[];
  projects: ElmProjectDto[];
  issues: Array<{ path: string; message: string; kind: string }>;
  settings: ElmSettingsDto;
}

export interface ElmSettingsDto {
  showProjectBoardImages: boolean;
  defaultActionStatus: Action["status"];
  showDoneColumn: boolean;
  projectBoardColumns: Project["status"][];
  savedViews: SavedView[];
  activeSavedViewId: string | null;
  defaultDurationMinutes: number;
}

/** The Feeds payload, built from the store and the fetcher's status. */
export function elmFeeds(
  store: FeedStoreData,
  status: { state: ElmFeedsDto["state"]; lastFetch?: string; error?: string },
  options: { enabled: boolean; undoCount: number; now?: Date },
): ElmFeedsDto {
  const now = options.now ?? new Date();
  return {
    protocolVersion: ELM_PROTOCOL_VERSION,
    enabled: options.enabled,
    state: status.state,
    lastFetch: status.lastFetch ?? "",
    error: status.error ?? "",
    undoCount: options.undoCount,
    feeds: store.sources.map((source) => {
      const state = store.states[source.id];
      return {
        id: source.id,
        title: source.title,
        url: source.url,
        enabled: source.enabled,
        fetched: state?.fetched ?? "",
        error: state?.error ?? "",
        items: (state?.unread ?? []).map((item) => ({
          key: item.key,
          title: item.title,
          link: item.link,
          published: item.published,
          age: feedItemAge(item.published, now),
          author: item.author,
          summary: item.summary,
        })),
      };
    }),
  };
}

export function elmSnapshot(
  snapshot: GtdSnapshot,
  settings: GtdSettings,
  today: string,
  resourceUrl: (file: InboxItem["file"]) => string = () => "",
): ElmSnapshotDto {
  return {
    protocolVersion: ELM_PROTOCOL_VERSION,
    revision: snapshot.revision,
    today,
    inboxItems: snapshot.inboxItems.map((item) => ({ ...item, file: fileDto(item.file), resourceUrl: resourceUrl(item.file) })),
    actions: snapshot.actions.map((action) => ({
      ...action,
      file: fileDto(action.file),
      ...(action.scheduledStart && !isAllDaySchedule(action.scheduledStart)
        ? { scheduledLocal: dateTimeLocal(action.scheduledStart) }
        : {}),
    })),
    projects: snapshot.projects.map((project) => ({ ...project, file: fileDto(project.file) })),
    issues: snapshot.issues.map((issue) => ({ ...issue })),
    settings: {
      showProjectBoardImages: settings.showProjectBoardImages,
      defaultActionStatus: settings.defaultActionStatus,
      showDoneColumn: settings.showDoneColumn,
      projectBoardColumns: [...settings.projectBoardColumns],
      savedViews: structuredClone(settings.savedViews),
      activeSavedViewId: settings.activeSavedViewId,
      defaultDurationMinutes: settings.googleCalendar.defaultDurationMinutes,
    },
  };
}

/** The `datetime-local` reading of an absolute timestamp, or empty when it is not one. */
function dateTimeLocal(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fileDto(file: Action["file"] | Project["file"]): ElmFileDto {
  return {
    path: file.path,
    name: file.name,
    basename: file.basename,
    extension: file.extension,
  };
}

/** What a Scheduled Action reserves, as the Elm editor stated it. */
export type ElmScheduleInput =
  | { kind: "all-day"; date: string }
  | { kind: "timed"; localStart: string; durationMinutes: number };

export interface ElmNewActionInput {
  title: string;
  status: Action["status"];
  projectId?: string;
  context: string;
  waitingSince?: string;
  schedule?: ElmScheduleInput;
  work: boolean;
}

export interface ElmActionChanges extends Omit<ElmNewActionInput, "projectId"> {
  projectId: string;
  energy: string;
  due: string;
  deferUntil: string;
}

export interface ElmNewProjectInput {
  title: string;
  area: string;
  image: string;
  tags: string[];
  parentProjectId?: string;
}

export interface ElmProjectChanges {
  title: string;
  status: Project["status"];
  activateAt: string;
  area: string;
  image: string;
  tags: string[];
  reviewed: string;
  parentProjectId: string;
}

/** One row of a pasted list, normalized so Elm reads Actions and Sub-projects alike. */
export interface ElmImportedRow {
  title: string;
  tags: string[];
  work: boolean;
  done: boolean;
}

type ElmNonMenuCommand =
  | { type: "create-action"; projectId?: string }
  | { type: "create-project"; parentProjectId?: string }
  | { type: "set-project-selection"; projectId?: string }
  | { type: "quick-capture" }
  | { type: "open-inbox" }
  | { type: "show-project"; projectId: string }
  | { type: "edit-action"; actionId: string }
  | { type: "set-action-status"; actionId: string; status: Action["status"] }
  | { type: "update-action"; actionId: string; projectId?: string; context?: string }
  | { type: "trash-action"; actionId: string }
  | { type: "edit-project"; projectId: string }
  | { type: "set-project-status"; projectId: string; status: Project["status"] }
  | { type: "move-subproject"; projectId: string; status: Project["status"]; beforeId?: string }
  | { type: "trash-project"; projectId: string }
  | { type: "trash-projects"; projectIds: string[] }
  | { type: "batch-project-tags"; projectIds: string[] }
  | { type: "batch-project-parent"; projectIds: string[] }
  | { type: "project-dependencies"; projectId: string }
  | { type: "import-actions"; projectId: string }
  | { type: "import-subprojects"; projectId: string }
  | { type: "load-project-detail"; projectId: string }
  | { type: "set-desired-outcome"; projectId: string; body: string }
  | { type: "add-diary-entry"; projectId: string; body: string }
  | { type: "create-support-note"; projectId: string; title: string }
  | { type: "create-support-folder"; projectId: string; path: string }
  | { type: "read-support-note"; projectId: string; path: string }
  | { type: "update-support-note"; projectId: string; path: string; body: string }
  | { type: "save-project-preferences"; columns: Project["status"][]; showImages: boolean }
  | { type: "load-review-project"; projectId: string }
  | { type: "create-review-action"; title: string; projectId: string; context: string; work: boolean }
  | { type: "complete-project-review"; projectId: string; desiredOutcome: string; activeProjectIds: string[] }
  | { type: "move-review-to-someday"; projectId: string; desiredOutcome: string; activeProjectIds: string[] }
  | { type: "load-brainstorm-outcome"; projectId: string }
  | { type: "save-brainstorm"; actionId: string; ideas: string; desiredOutcome?: string }
  | { type: "save-standalone-brainstorm"; topic: string; ideas: string }
  | { type: "shuffle-brainstorm-words" }
  | { type: "focus-brainstorm-ideas"; start: number; end: number }
  | { type: "open-file"; path: string }
  | { type: "read-inbox-body"; itemId: string }
  | { type: "trash-inbox-item"; itemId: string }
  | { type: "process-inbox"; itemId: string; operation: "next-action" | "file" | "someday"; input: InboxProcessingInput }
  | { type: "save-new-action"; input: ElmNewActionInput }
  | { type: "save-action"; actionId: string; changes: ElmActionChanges }
  | { type: "schedule-action"; actionId: string; schedule: ElmScheduleInput }
  | { type: "convert-action-to-subproject"; actionId: string; title: string; parentProjectId: string }
  | { type: "save-new-project"; input: ElmNewProjectInput }
  | { type: "save-project"; projectId: string; changes: ElmProjectChanges }
  | { type: "add-project-tags"; projectIds: string[]; tags: string[] }
  | { type: "set-projects-parent"; projectIds: string[]; parentProjectId: string }
  | { type: "set-project-blockers"; projectId: string; blockedByProjectIds: string[] }
  | { type: "parse-import-list"; kind: ElmImportKind; text: string }
  | { type: "import-action-list"; projectId?: string; text: string }
  | { type: "import-subproject-list"; parentProjectId: string; text: string }
  | { type: "capture-inbox-item"; title: string }
  | { type: "submit-prompt"; value: string }
  | { type: "close-modal" }
  | { type: "set-active-saved-view"; savedViewId: string | null }
  | { type: "upsert-saved-view"; view: SavedView; activate: boolean }
  | { type: "delete-saved-view"; savedViewId: string }
  | { type: "prompt"; title: string; placeholder: string }
  | { type: "refresh-feeds" }
  | { type: "add-feed" }
  | { type: "keep-feed-items"; keys: string[] }
  | { type: "discard-feed-items"; keys: string[] }
  | { type: "undo-feed-discard" }
  | { type: "process-feed-item"; key: string }
  | { type: "open-link"; url: string };

export type ElmImportKind = "actions" | "subprojects";

export interface ElmMenuEntry<C> {
  label?: string;
  separator?: boolean;
  command?: C;
}

interface ElmActionBoardMenuCommand {
  type: "show-menu";
  x: number;
  y: number;
  entries: ElmMenuEntry<Exclude<ElmActionBoardCommand, ElmActionBoardMenuCommand>>[];
}

interface ElmProjectsMenuCommand {
  type: "show-menu";
  x: number;
  y: number;
  entries: ElmMenuEntry<Exclude<ElmProjectsCommand, ElmProjectsMenuCommand>>[];
}

export type ElmActionBoardCommand = Extract<ElmNonMenuCommand,
  | { type: "create-action" | "quick-capture" | "open-inbox" | "show-project" | "edit-action" }
  | { type: "set-action-status" | "update-action" | "trash-action" }
  | { type: "set-active-saved-view" | "upsert-saved-view" | "delete-saved-view" | "prompt" }
> | ElmActionBoardMenuCommand;

export type ElmProjectsCommand = Extract<ElmNonMenuCommand,
  | { type: "create-action" | "create-project" | "set-project-selection" | "edit-action" }
  | { type: "set-action-status" | "trash-action" | "edit-project" | "set-project-status" | "move-subproject" }
  | { type: "trash-project" | "trash-projects" | "batch-project-tags" | "batch-project-parent" | "project-dependencies" }
  | { type: "import-actions" | "import-subprojects" | "load-project-detail" | "set-desired-outcome" | "add-diary-entry" }
  | { type: "create-support-note" | "create-support-folder" | "read-support-note" | "update-support-note" }
  | { type: "save-project-preferences" | "open-file" }
> | ElmProjectsMenuCommand;

export type ElmInboxCommand = Extract<ElmNonMenuCommand,
  { type: "quick-capture" | "open-file" | "read-inbox-body" | "trash-inbox-item" | "process-inbox" }
>;

export type ElmFeedsCommand = Extract<ElmNonMenuCommand,
  | { type: "refresh-feeds" | "add-feed" | "keep-feed-items" | "discard-feed-items" }
  | { type: "undo-feed-discard" | "process-feed-item" | "open-link" | "open-inbox" }
>;

export type ElmProjectReviewCommand = Extract<ElmNonMenuCommand,
  | { type: "load-review-project" | "create-review-action" | "add-diary-entry" }
  | { type: "complete-project-review" | "move-review-to-someday" | "trash-project" | "create-project" }
  | { type: "open-file" | "edit-action" | "set-action-status" | "trash-action" }
>;

export type ElmBrainstormCommand = Extract<ElmNonMenuCommand,
  | { type: "load-brainstorm-outcome" | "save-brainstorm" | "save-standalone-brainstorm" }
  | { type: "shuffle-brainstorm-words" | "focus-brainstorm-ideas" | "show-project" }
>;

export type ElmModalCommand = Extract<ElmNonMenuCommand,
  | { type: "save-new-action" | "save-action" | "schedule-action" | "convert-action-to-subproject" }
  | { type: "save-new-project" | "save-project" | "trash-project" | "add-project-tags" }
  | { type: "set-projects-parent" | "set-project-blockers" | "parse-import-list" }
  | { type: "import-action-list" | "import-subproject-list" | "capture-inbox-item" | "submit-prompt" | "close-modal" }
>;

export type ElmActionBoardMenuEntry = ElmMenuEntry<Exclude<ElmActionBoardCommand, { type: "show-menu" }>>;
export type ElmProjectsMenuEntry = ElmMenuEntry<Exclude<ElmProjectsCommand, { type: "show-menu" }>>;

export interface ElmCommandEnvelope<C> {
  protocolVersion: number;
  requestId: string;
  command: C;
}

type CommandValidator<C> = (value: unknown) => value is C;

export const parseActionBoardCommand = parserFor<ElmActionBoardCommand>(isActionBoardCommand);
export const parseProjectsCommand = parserFor<ElmProjectsCommand>(isProjectsCommand);
export const parseInboxCommand = parserFor<ElmInboxCommand>(isInboxCommand);
export const parseFeedsCommand = parserFor<ElmFeedsCommand>(isFeedsCommand);
export const parseProjectReviewCommand = parserFor<ElmProjectReviewCommand>(isProjectReviewCommand);
export const parseBrainstormCommand = parserFor<ElmBrainstormCommand>(isBrainstormCommand);
export const parseModalCommand = parserFor<ElmModalCommand>(isModalCommand);

function parserFor<C>(validator: CommandValidator<C>): (value: unknown) => ElmCommandEnvelope<C> | null {
  return (value) => parseCommandEnvelope(value, validator);
}

function parseCommandEnvelope<C>(value: unknown, validator: CommandValidator<C>): ElmCommandEnvelope<C> | null {
  if (!isRecord(value)) return null;
  const candidate = value as Partial<ElmCommandEnvelope<unknown>>;
  if (candidate.protocolVersion !== ELM_PROTOCOL_VERSION || typeof candidate.requestId !== "string") return null;
  if (!validator(candidate.command)) return null;
  return candidate as ElmCommandEnvelope<C>;
}

function isActionBoardCommand(value: unknown): value is ElmActionBoardCommand {
  return isSurfaceCommand(value, ACTION_BOARD_COMMANDS, isActionBoardMenuItemCommand);
}

function isProjectsCommand(value: unknown): value is ElmProjectsCommand {
  return isSurfaceCommand(value, PROJECTS_COMMANDS, isProjectsMenuItemCommand);
}

function isActionBoardMenuItemCommand(value: unknown): value is Exclude<ElmActionBoardCommand, { type: "show-menu" }> {
  return isSurfaceCommand(value, ACTION_BOARD_MENU_COMMANDS);
}

function isProjectsMenuItemCommand(value: unknown): value is Exclude<ElmProjectsCommand, { type: "show-menu" }> {
  return isSurfaceCommand(value, PROJECTS_MENU_COMMANDS);
}

function isInboxCommand(value: unknown): value is ElmInboxCommand {
  return isSurfaceCommand(value, INBOX_COMMANDS);
}

function isFeedsCommand(value: unknown): value is ElmFeedsCommand {
  return isSurfaceCommand(value, FEEDS_COMMANDS);
}

function isProjectReviewCommand(value: unknown): value is ElmProjectReviewCommand {
  return isSurfaceCommand(value, PROJECT_REVIEW_COMMANDS);
}

function isBrainstormCommand(value: unknown): value is ElmBrainstormCommand {
  return isSurfaceCommand(value, BRAINSTORM_COMMANDS);
}

function isModalCommand(value: unknown): value is ElmModalCommand {
  return isSurfaceCommand(value, MODAL_COMMANDS);
}

const ACTION_BOARD_COMMANDS = new Set([
  "create-action", "quick-capture", "open-inbox", "show-project", "edit-action", "set-action-status", "update-action",
  "trash-action", "set-active-saved-view", "upsert-saved-view", "delete-saved-view", "prompt", "show-menu",
]);
const ACTION_BOARD_MENU_COMMANDS = new Set([...ACTION_BOARD_COMMANDS].filter((type) => type !== "show-menu"));
const PROJECTS_COMMANDS = new Set([
  "create-action", "create-project", "set-project-selection", "edit-action", "set-action-status", "trash-action",
  "edit-project", "set-project-status", "move-subproject", "trash-project", "trash-projects", "batch-project-tags",
  "batch-project-parent", "project-dependencies", "import-actions", "import-subprojects", "load-project-detail",
  "set-desired-outcome", "add-diary-entry", "create-support-note", "create-support-folder", "read-support-note",
  "update-support-note", "save-project-preferences", "open-file", "show-menu",
]);
const PROJECTS_MENU_COMMANDS = new Set([...PROJECTS_COMMANDS].filter((type) => type !== "show-menu"));
const INBOX_COMMANDS = new Set(["quick-capture", "open-file", "read-inbox-body", "trash-inbox-item", "process-inbox"]);
const FEEDS_COMMANDS = new Set([
  "refresh-feeds", "add-feed", "keep-feed-items", "discard-feed-items", "undo-feed-discard",
  "process-feed-item", "open-link", "open-inbox",
]);
const PROJECT_REVIEW_COMMANDS = new Set([
  "load-review-project", "create-review-action", "add-diary-entry", "complete-project-review", "move-review-to-someday",
  "trash-project", "create-project", "open-file", "edit-action", "set-action-status", "trash-action",
]);
const BRAINSTORM_COMMANDS = new Set([
  "load-brainstorm-outcome", "save-brainstorm", "save-standalone-brainstorm", "shuffle-brainstorm-words",
  "focus-brainstorm-ideas", "show-project",
]);
const MODAL_COMMANDS = new Set([
  "save-new-action", "save-action", "schedule-action", "convert-action-to-subproject", "save-new-project", "save-project",
  "trash-project", "add-project-tags", "set-projects-parent", "set-project-blockers", "parse-import-list",
  "import-action-list", "import-subproject-list", "capture-inbox-item", "submit-prompt", "close-modal",
]);

function isSurfaceCommand(value: unknown, allowed: ReadonlySet<string>, nested?: CommandValidator<unknown>): boolean {
  if (!isRecord(value) || typeof value.type !== "string" || !allowed.has(value.type)) return false;
  if (value.type === "show-menu") return nested !== undefined && isMenuCommand(value, nested);
  return isNonMenuCommand(value);
}

function isMenuCommand(value: Record<string, unknown>, commandValidator: CommandValidator<unknown>): boolean {
  return typeof value.x === "number"
    && Number.isFinite(value.x)
    && typeof value.y === "number"
    && Number.isFinite(value.y)
    && Array.isArray(value.entries)
    && value.entries.every((entry) => isMenuEntry(entry, commandValidator));
}

function isMenuEntry(value: unknown, commandValidator: CommandValidator<unknown>): boolean {
  if (!isRecord(value)) return false;
  if (value.separator === true) return value.label === undefined && value.command === undefined;
  return typeof value.label === "string" && commandValidator(value.command)
    && isRecord(value.command) && value.command.type !== "show-menu";
}

function isNonMenuCommand(value: unknown): value is ElmNonMenuCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "create-action":
      return value.projectId === undefined || typeof value.projectId === "string";
    case "create-project":
      return value.parentProjectId === undefined || typeof value.parentProjectId === "string";
    case "set-project-selection":
      return value.projectId === undefined || typeof value.projectId === "string";
    case "quick-capture":
    case "open-inbox":
      return true;
    case "show-project":
      return typeof value.projectId === "string";
    case "edit-action":
    case "trash-action":
      return typeof value.actionId === "string";
    case "edit-project":
    case "trash-project":
    case "project-dependencies":
    case "import-actions":
    case "import-subprojects":
    case "load-project-detail":
      return typeof value.projectId === "string";
    case "set-project-status":
      return typeof value.projectId === "string"
        && ["active", "backlog", "someday", "completed", "cancelled"].includes(String(value.status));
    case "move-subproject":
      return typeof value.projectId === "string"
        && ["active", "backlog", "someday", "completed"].includes(String(value.status))
        && (value.beforeId === undefined || typeof value.beforeId === "string");
    case "trash-projects":
    case "batch-project-tags":
    case "batch-project-parent":
      return Array.isArray(value.projectIds) && value.projectIds.every((id) => typeof id === "string");
    case "set-desired-outcome":
    case "add-diary-entry":
      return typeof value.projectId === "string" && typeof value.body === "string";
    case "create-support-note":
      return typeof value.projectId === "string" && typeof value.title === "string";
    case "create-support-folder":
      return typeof value.projectId === "string" && typeof value.path === "string";
    case "read-support-note":
      return typeof value.projectId === "string" && typeof value.path === "string";
    case "update-support-note":
      return typeof value.projectId === "string" && typeof value.path === "string" && typeof value.body === "string";
    case "save-project-preferences":
      return Array.isArray(value.columns)
        && value.columns.length > 0
        && value.columns.every((status) => ["active", "backlog", "someday", "completed"].includes(String(status)))
        && typeof value.showImages === "boolean";
    case "load-review-project":
    case "load-brainstorm-outcome":
      return typeof value.projectId === "string";
    case "create-review-action":
      return typeof value.title === "string"
        && typeof value.projectId === "string"
        && typeof value.context === "string"
        && typeof value.work === "boolean";
    case "complete-project-review":
    case "move-review-to-someday":
      return typeof value.projectId === "string"
        && typeof value.desiredOutcome === "string"
        && Array.isArray(value.activeProjectIds)
        && value.activeProjectIds.every((id) => typeof id === "string");
    case "save-brainstorm":
      return typeof value.actionId === "string"
        && typeof value.ideas === "string"
        && (value.desiredOutcome === undefined || typeof value.desiredOutcome === "string");
    case "save-standalone-brainstorm":
      return typeof value.topic === "string" && typeof value.ideas === "string";
    case "shuffle-brainstorm-words":
      return true;
    case "focus-brainstorm-ideas":
      return Number.isInteger(value.start)
        && Number.isInteger(value.end)
        && Number(value.start) >= 0
        && Number(value.end) >= Number(value.start);
    case "set-action-status":
      return typeof value.actionId === "string"
        && ["next", "waiting", "scheduled", "done", "cancelled"].includes(String(value.status));
    case "update-action":
      return typeof value.actionId === "string"
        && (value.projectId === undefined || typeof value.projectId === "string")
        && (value.context === undefined || typeof value.context === "string");
    case "open-file":
      return typeof value.path === "string";
    case "read-inbox-body":
    case "trash-inbox-item":
      return typeof value.itemId === "string";
    case "process-inbox":
      return typeof value.itemId === "string"
        && ["next-action", "file", "someday"].includes(String(value.operation))
        && isInboxInput(value.input);
    case "save-new-action":
      return isNewActionInput(value.input);
    case "save-action":
      return typeof value.actionId === "string" && isActionChanges(value.changes);
    case "schedule-action":
      return typeof value.actionId === "string" && isScheduleInput(value.schedule);
    case "convert-action-to-subproject":
      return typeof value.actionId === "string"
        && typeof value.title === "string"
        && typeof value.parentProjectId === "string";
    case "save-new-project":
      return isNewProjectInput(value.input);
    case "save-project":
      return typeof value.projectId === "string" && isProjectChanges(value.changes);
    case "add-project-tags":
      return isStringArray(value.projectIds) && isStringArray(value.tags);
    case "set-projects-parent":
      return isStringArray(value.projectIds) && typeof value.parentProjectId === "string";
    case "set-project-blockers":
      return typeof value.projectId === "string" && isStringArray(value.blockedByProjectIds);
    case "parse-import-list":
      return (value.kind === "actions" || value.kind === "subprojects") && typeof value.text === "string";
    case "import-action-list":
      return typeof value.text === "string" && (value.projectId === undefined || typeof value.projectId === "string");
    case "import-subproject-list":
      return typeof value.parentProjectId === "string" && typeof value.text === "string";
    case "capture-inbox-item":
      return typeof value.title === "string";
    case "submit-prompt":
      return typeof value.value === "string";
    case "close-modal":
      return true;
    case "set-active-saved-view":
      return value.savedViewId === null || typeof value.savedViewId === "string";
    case "upsert-saved-view":
      return isSavedView(value.view) && typeof value.activate === "boolean";
    case "delete-saved-view":
      return typeof value.savedViewId === "string";
    case "prompt":
      return typeof value.title === "string" && typeof value.placeholder === "string";
    case "refresh-feeds":
    case "add-feed":
    case "undo-feed-discard":
      return true;
    case "keep-feed-items":
    case "discard-feed-items":
      return isStringArray(value.keys);
    case "process-feed-item":
      return typeof value.key === "string";
    case "open-link":
      return typeof value.url === "string";
    default:
      return false;
  }
}

function isInboxInput(value: unknown): value is InboxProcessingInput {
  return isRecord(value)
    && isOptionalString(value.projectId)
    && isOptionalString(value.projectTitle)
    && isOptionalString(value.desiredOutcome)
    && isOptionalString(value.nextAction)
    && isOptionalString(value.context)
    && isOptionalBoolean(value.work)
    && isOptionalBoolean(value.fileOriginal);
}

function isSavedView(value: unknown): value is SavedView {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && Array.isArray(value.filters)
    && value.filters.every(isActionFilter)
    && ["status", "project", "context", "energy"].includes(String(value.groupBy))
    && isSortSpec(value.sort)
    && (value.visibleColumns === null || isStringArray(value.visibleColumns));
}

function isActionFilter(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "value") {
    return ["status", "project", "context", "energy"].includes(String(value.field))
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
  if (value.kind === "availability") return value.operator === "available";
  return value.kind === "work" && typeof value.value === "boolean";
}

function isSortSpec(value: unknown): boolean {
  return isRecord(value)
    && ["created", "due", "title", "project"].includes(String(value.field))
    && (value.direction === "asc" || value.direction === "desc");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isScheduleInput(value: unknown): value is ElmScheduleInput {
  if (!isRecord(value)) return false;
  if (value.kind === "all-day") return typeof value.date === "string";
  return value.kind === "timed"
    && typeof value.localStart === "string"
    && Number.isInteger(value.durationMinutes)
    && Number(value.durationMinutes) > 0;
}

function isOptionalSchedule(value: unknown): boolean {
  return value === undefined || isScheduleInput(value);
}

function isNewActionInput(value: unknown): value is ElmNewActionInput {
  return isRecord(value)
    && typeof value.title === "string"
    && ACTION_STATUSES.includes(value.status as Action["status"])
    && typeof value.context === "string"
    && typeof value.work === "boolean"
    && (value.projectId === undefined || typeof value.projectId === "string")
    && (value.waitingSince === undefined || typeof value.waitingSince === "string")
    && isOptionalSchedule(value.schedule);
}

function isActionChanges(value: unknown): value is ElmActionChanges {
  return isNewActionInput(value)
    && typeof (value as ElmActionChanges).projectId === "string"
    && typeof (value as ElmActionChanges).energy === "string"
    && typeof (value as ElmActionChanges).due === "string"
    && typeof (value as ElmActionChanges).deferUntil === "string";
}

function isNewProjectInput(value: unknown): value is ElmNewProjectInput {
  return isRecord(value)
    && typeof value.title === "string"
    && typeof value.area === "string"
    && typeof value.image === "string"
    && isStringArray(value.tags)
    && (value.parentProjectId === undefined || typeof value.parentProjectId === "string");
}

function isProjectChanges(value: unknown): value is ElmProjectChanges {
  return isRecord(value)
    && typeof value.title === "string"
    && PROJECT_STATUSES.includes(value.status as Project["status"])
    && typeof value.activateAt === "string"
    && typeof value.area === "string"
    && typeof value.image === "string"
    && isStringArray(value.tags)
    && typeof value.reviewed === "string"
    && typeof value.parentProjectId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type ElmCommandResultEvent =
  | { type: "command-result"; requestId: string; ok: true; value?: unknown }
  | { type: "command-result"; requestId: string; ok: false; error: string };

export type ElmActionBoardEvent = { type: "snapshot"; snapshot: ElmSnapshotDto } | ElmCommandResultEvent;
export type ElmProjectsEvent =
  | { type: "snapshot"; snapshot: ElmSnapshotDto }
  | { type: "project-meta"; projectMeta: ElmProjectMetaDto[] }
  | { type: "project-detail"; detail: ElmProjectDetailDto }
  | { type: "show-project"; projectId: string | null }
  | ElmCommandResultEvent;
export type ElmInboxEvent =
  | { type: "snapshot"; snapshot: ElmSnapshotDto }
  | { type: "start-processing"; itemId?: string }
  | ElmCommandResultEvent;
export type ElmProjectReviewEvent =
  | { type: "snapshot"; snapshot: ElmSnapshotDto }
  | { type: "support-counts"; counts: Array<{ projectId: string; count: number }> }
  | { type: "review-project-data"; data: ElmReviewProjectDataDto }
  | ElmCommandResultEvent;
export type ElmBrainstormEvent =
  | { type: "snapshot"; snapshot: ElmSnapshotDto }
  | { type: "brainstorm-outcome"; projectId: string; desiredOutcome: string }
  | ElmCommandResultEvent;
export type ElmFeedsEvent = { type: "feeds"; feeds: ElmFeedsDto } | ElmCommandResultEvent;
export type ElmModalEvent = ElmCommandResultEvent;
