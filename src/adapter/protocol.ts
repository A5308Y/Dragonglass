import type { FeedStoreData } from "../domain/feed";
import { POMODORO_OUTCOMES, type PomodoroOutcome, type PomodoroStore } from "../domain/pomodoro";
import {
  MARK_STATES,
  SHORT_CHECKLIST_ITEMS,
  checklistItems,
  lastFinished,
  openRun,
  repeatedlySkipped,
  type ChecklistBlock,
  type ChecklistRun,
  type ChecklistStore,
  type MarkState,
} from "../domain/checklist";
import { addLocalDays, localDate } from "../utils/date";
import { feedItemAge } from "../domain/feed-triage";
import { isAllDaySchedule } from "../domain/schedule";
import { ACTION_STATUSES, BOARD_PROJECT_STATUSES, ENERGY_LEVELS, PROJECT_STATUSES, type Energy } from "../domain/types";
import type { ProjectReviewHealth } from "../domain/project-review";
import type {
  Action,
  GtdSettings,
  GtdSnapshot,
  InboxItem,
  InboxProcessingInput,
  Project,
  ProjectBoardColumnsBy,
  ProjectBoardSections,
  SavedView,
} from "../domain/types";

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

/** Agent runs and their costs, for the Project pages; see `src/agent/agent-service.ts`. */
export interface ElmAgentDto {
  /** Whether this device can delegate at all: the desktop app on macOS. */
  available: boolean;
  runs: Array<{
    id: string;
    projectId: string;
    /** When the run was started, in this device's time zone: "2026-09-26 14:05". */
    createdAt: string;
    status: string;
    statusText: string;
    costUsd: number | null;
    budgetUsd: number;
    runtime: string;
    /** For local runs: "loop" or "smolagents". */
    harness: string;
    model: string;
    offline: boolean;
    wholeVault: boolean;
    reportPath: string;
    questions: Array<{ id: string; question: string; askedAt: string }>;
    /** Newest first; `at` is the time of day in this device's time zone: "14:05:12". */
    activity: Array<{ at: string; kind: string; text: string }>;
  }>;
  costs: Array<{ projectId: string; own: number; tree: number }>;
}

export interface ElmProjectDetailDto {
  projectId: string;
  desiredOutcome: string;
  diary: ElmDiaryEntryDto[];
  supportFiles: ElmProjectSupportFileDto[];
  supportFolders: Array<{ path: string; label: string }>;
  /** Files linked from elsewhere in the vault; `path` is empty when the link no longer resolves. */
  linkedFiles: Array<{ link: string; path: string; label: string }>;
  /** Web links; entries that are not http(s) links are left out. */
  externalLinks: Array<{ entry: string; url: string; title: string }>;
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
  /** The discussion page for this Item, when the feed names one separately from `link`. */
  commentsUrl: string;
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

/** The running session, with times as epoch milliseconds so Elm can count down without parsing dates. */
export interface ElmActivePomodoroDto {
  id: string;
  /** Empty for a session on a checklist run. */
  projectId: string;
  projectTitle: string;
  checklist: { runId: string; path: string } | null;
  intention: string;
  focusActionIds: string[];
  completedActionIds: string[];
  plannedMinutes: number;
  /** Seconds focused before the current running stretch. */
  focusedBefore: number;
  /** When the current running stretch began, or `null` while paused. */
  resumedAtMs: number | null;
  /** Local wall-clock start, e.g. `14:05`. */
  startedTime: string;
}

/** A finished session, already placed on the local calendar for grouping. */
export interface ElmPomodoroSessionDto {
  id: string;
  projectId: string;
  projectTitle: string;
  projectPath: string;
  /** The checklist note a checklist session was spent on. */
  checklistPath: string | null;
  intention: string;
  /** Local `YYYY-MM-DD`. */
  day: string;
  /** Local wall-clock start and end, e.g. `14:05`. */
  startedTime: string;
  endedTime: string;
  focusedMinutes: number;
  status: "completed" | "stopped";
  outcome: PomodoroOutcome | null;
  reflection: string;
  completedActions: number;
}

export interface ElmPomodoroDto {
  focusMinutes: number;
  active: ElmActivePomodoroDto | null;
  sessions: ElmPomodoroSessionDto[];
  today: string;
  /** The Monday that starts the current week, local `YYYY-MM-DD`. */
  weekStart: string;
  /** The checklists a session can be spent on. */
  checklists: ElmChecklistChoiceDto[];
  /** The run the running session is spent on, if it is a checklist session. */
  checklistRun: ElmChecklistRunDto | null;
}

export interface ElmChecklistChoiceDto {
  path: string;
  title: string;
  itemCount: number;
}

/** What the Pomodoro view is told about checklists. */
export interface ElmPomodoroChecklists {
  choices: ElmChecklistChoiceDto[];
  run: ElmChecklistRunDto | null;
}

/** How many finished sessions the view is sent; the log itself keeps more. */
const POMODORO_HISTORY_LIMIT = 500;

export function elmPomodoro(
  store: PomodoroStore,
  focusMinutes: number,
  now = new Date(),
  checklists: ElmPomodoroChecklists = { choices: [], run: null },
): ElmPomodoroDto {
  const today = localDate(now);
  const active = store.active;
  return {
    focusMinutes,
    active: active
      ? {
        id: active.id,
        projectId: active.projectId,
        projectTitle: active.projectTitle,
        checklist: active.checklist ? { ...active.checklist } : null,
        intention: active.intention,
        focusActionIds: [...active.focusActionIds],
        completedActionIds: [...active.completedActionIds],
        plannedMinutes: active.plannedMinutes,
        focusedBefore: active.focusedBefore,
        resumedAtMs: active.resumedAt ? Date.parse(active.resumedAt) : null,
        startedTime: clockTime(active.startedAt),
      }
      : null,
    sessions: store.sessions.slice(0, POMODORO_HISTORY_LIMIT).map((session) => ({
      id: session.id,
      projectId: session.projectId,
      projectTitle: session.projectTitle,
      projectPath: session.projectPath,
      checklistPath: session.checklist?.path ?? null,
      intention: session.intention,
      day: localDate(new Date(session.startedAt)),
      startedTime: clockTime(session.startedAt),
      endedTime: clockTime(session.endedAt),
      focusedMinutes: Math.round(session.focusedSeconds / 60),
      status: session.status,
      outcome: session.outcome,
      reflection: session.reflection,
      completedActions: session.completedActionIds.length,
    })),
    today,
    weekStart: addLocalDays(today, -((now.getDay() + 6) % 7)),
    checklists: checklists.choices,
    checklistRun: checklists.run,
  };
}

/** A checklist run, with the note as it is now to show it by. */
export interface ElmChecklistRunDto {
  id: string;
  path: string;
  title: string;
  /** Local `YYYY-MM-DD` and wall-clock time. */
  startedDay: string;
  startedTime: string;
  finished: boolean;
  /** The note's items and the Markdown between them; the recorded items when the note is gone. */
  blocks: ChecklistBlock[];
  noteMissing: boolean;
  marks: Array<{ key: string; state: MarkState }>;
  /** Items marked in this run that are no longer in the note. */
  removed: Array<{ key: string; text: string; state: MarkState }>;
  /** Items skipped in each of the last few runs, to ask whether they are still needed. */
  repeatedlySkipped: string[];
}

export interface ElmChecklistSummaryDto {
  path: string;
  title: string;
  itemCount: number;
  /** The local day a run of it was last finished, or `""`. */
  lastFinished: string;
  openRunId: string | null;
}

export interface ElmChecklistRecentRunDto {
  id: string;
  title: string;
  day: string;
  done: number;
  skipped: number;
  open: number;
}

export interface ElmChecklistsDto {
  directory: string;
  /** The daily checklist's path, or `""`. */
  daily: string;
  dailyDone: boolean;
  today: string;
  /** Past this many items the view suggests shortening a checklist. */
  shortLimit: number;
  checklists: ElmChecklistSummaryDto[];
  recent: ElmChecklistRecentRunDto[];
  run: ElmChecklistRunDto | null;
}

/** A checklist note with its content, as the host read it. */
export interface ChecklistNoteContent {
  path: string;
  title: string;
  blocks: ChecklistBlock[];
}

const RECENT_RUNS = 10;

export function elmChecklistRun(run: ChecklistRun, blocks: ChecklistBlock[] | null, store: ChecklistStore): ElmChecklistRunDto {
  const shown: ChecklistBlock[] = blocks ?? run.items.map((item) => ({ kind: "item", key: item.key, text: item.text, depth: 0 }));
  const current = new Set(checklistItems(shown).map((item) => item.key));
  const recorded = new Map(run.items.map((item) => [item.key, item.text]));
  return {
    id: run.id,
    path: run.path,
    title: run.title,
    startedDay: localDate(new Date(run.startedAt)),
    startedTime: clockTime(run.startedAt),
    finished: run.finishedAt !== null,
    blocks: shown,
    noteMissing: blocks === null,
    marks: Object.entries(run.marks).map(([key, mark]) => ({ key, state: mark.state })),
    removed: Object.entries(run.marks)
      .filter(([key, mark]) => !current.has(key) && mark.state !== "open")
      .map(([key, mark]) => ({ key, text: recorded.get(key) ?? key.replace(/#\d+$/, ""), state: mark.state })),
    repeatedlySkipped: run.finishedAt !== null ? repeatedlySkipped(store, run.path, checklistItems(shown)) : [],
  };
}

export function elmChecklists(
  notes: readonly ChecklistNoteContent[],
  store: ChecklistStore,
  daily: string,
  directory: string,
  shown: ElmChecklistRunDto | null,
  now = new Date(),
): ElmChecklistsDto {
  const today = localDate(now);
  const finishedDay = (run: ChecklistRun | undefined) => (run?.finishedAt ? localDate(new Date(run.finishedAt)) : "");
  return {
    directory,
    daily,
    dailyDone: Boolean(daily) && finishedDay(lastFinished(store, daily)) === today,
    today,
    shortLimit: SHORT_CHECKLIST_ITEMS,
    checklists: notes.map((note) => ({
      path: note.path,
      title: note.title,
      itemCount: checklistItems(note.blocks).length,
      lastFinished: finishedDay(lastFinished(store, note.path)),
      openRunId: openRun(store, note.path)?.id ?? null,
    })),
    recent: store.runs.filter((run) => run.finishedAt !== null).slice(0, RECENT_RUNS).map((run) => {
      const state = (key: string) => run.marks[key]?.state ?? "open";
      return {
        id: run.id,
        title: run.title,
        day: finishedDay(run),
        done: run.items.filter((item) => state(item.key) === "done").length,
        skipped: run.items.filter((item) => state(item.key) === "skipped").length,
        open: run.items.filter((item) => state(item.key) === "open").length,
      };
    }),
    run: shown,
  };
}

function clockTime(timestamp: string): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
  projectBoardColumnsBy: ProjectBoardColumnsBy;
  projectBoardSections: ProjectBoardSections;
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
          commentsUrl: item.commentsUrl,
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
      projectBoardColumnsBy: settings.projectBoardColumnsBy,
      projectBoardSections: settings.projectBoardSections,
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
  followUp?: string;
  schedule?: ElmScheduleInput;
}

export interface ElmActionChanges extends Omit<ElmNewActionInput, "projectId" | "followUp"> {
  projectId: string;
  /** Empty clears the energy level. */
  energy: Energy | "";
  due: string;
  /** Empty clears the follow-up day. */
  followUp: string;
}

/** Inbox processing adds an editor-local schedule which the desktop host resolves to vault time. */
export interface ElmInboxProcessingInput extends Omit<InboxProcessingInput, "scheduledStart" | "durationMinutes"> {
  schedule?: ElmScheduleInput;
}

export interface ElmNewProjectInput {
  title: string;
  status: Project["status"];
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
  done: boolean;
}

type ElmNonMenuCommand =
  | { type: "create-action"; projectId?: string }
  | { type: "create-project"; parentProjectId?: string; status: Project["status"] }
  | { type: "set-project-selection"; projectId?: string }
  | { type: "quick-capture" }
  | { type: "open-inbox" }
  | { type: "show-project"; projectId: string }
  | { type: "edit-action"; actionId: string }
  | { type: "set-action-status"; actionId: string; status: Action["status"] }
  | { type: "set-action-priorities"; actionIds: string[] }
  | { type: "update-action"; actionId: string; projectId?: string; context?: string }
  | { type: "trash-action"; actionId: string }
  | { type: "edit-project"; projectId: string }
  | { type: "set-project-status"; projectId: string; status: Project["status"] }
  | { type: "set-project-area"; projectId: string; area: string }
  | { type: "move-subproject"; projectId: string; status: Project["status"]; beforeId?: string }
  | { type: "trash-project"; projectId: string }
  | { type: "trash-projects"; projectIds: string[] }
  | { type: "batch-project-tags"; projectIds: string[] }
  | { type: "batch-project-parent"; projectIds: string[] }
  | { type: "project-dependencies"; projectId: string }
  | { type: "import-actions"; projectId: string }
  | { type: "import-subprojects"; projectId: string }
  | { type: "load-project-detail"; projectId: string }
  | { type: "link-project-file"; projectId: string }
  | { type: "unlink-project-file"; projectId: string; link: string }
  | { type: "add-project-link"; projectId: string; url: string; title: string }
  | { type: "remove-project-link"; projectId: string; entry: string }
  | { type: "set-desired-outcome"; projectId: string; body: string }
  | { type: "add-diary-entry"; projectId: string; body: string }
  | { type: "create-support-note"; projectId: string; title: string }
  | { type: "create-support-folder"; projectId: string; path: string }
  | { type: "read-support-note"; projectId: string; path: string }
  | { type: "update-support-note"; projectId: string; path: string; body: string }
  | {
    type: "save-project-preferences";
    columns: Project["status"][];
    showImages: boolean;
    columnsBy: ProjectBoardColumnsBy;
    sections: ProjectBoardSections;
  }
  | { type: "review-someday-project"; projectId: string; activateAt: string }
  | { type: "open-someday-review" }
  | { type: "open-pomodoro"; projectId: string }
  | { type: "delegate-project"; projectId: string }
  | { type: "answer-agent-question"; runId: string; questionId: string; answer: string }
  | { type: "stop-agent-run"; runId: string }
  | { type: "rerun-agent-run"; runId: string }
  | { type: "delete-agent-run"; runId: string }
  | { type: "start-pomodoro"; projectId: string; intention: string; focusActionIds: string[]; minutes: number }
  | { type: "pause-pomodoro" }
  | { type: "resume-pomodoro" }
  | { type: "finish-pomodoro"; outcome: PomodoroOutcome | null; reflection: string }
  | { type: "discard-pomodoro" }
  | { type: "complete-pomodoro-action"; actionId: string }
  | { type: "start-checklist-pomodoro"; path: string; intention: string; minutes: number }
  | { type: "open-checklist-pomodoro"; path: string }
  | { type: "open-checklist-run"; runId: string }
  | { type: "start-checklist-run"; path: string }
  | { type: "show-checklist-run"; runId: string | null }
  | { type: "mark-checklist-item"; runId: string; key: string; state: MarkState }
  | { type: "finish-checklist-run"; runId: string }
  | { type: "discard-checklist-run"; runId: string }
  | { type: "capture-from-checklist"; path: string; text: string }
  | { type: "load-review-project"; projectId: string }
  | { type: "create-review-action"; title: string; projectId: string; context: string }
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
  | { type: "process-inbox"; itemId: string; operation: "next-action" | "file" | "someday" | "backlog"; input: ElmInboxProcessingInput }
  | { type: "open-mail"; itemId: string }
  | { type: "review-pull-request"; itemId: string }
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
  | { type: "open-link"; url: string }
  | { type: "open-note-link"; link: string; sourcePath: string }
  | { type: "read-feed-item"; key: string; comments: boolean };

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

/**
 * The commands each surface may send. Each list is the one source for both the
 * surface's command type and its runtime allow-list, and `elm-protocol.test.ts`
 * checks it against the constructors the matching `Gtd.Command.*` Elm module uses.
 */
export const SURFACE_COMMANDS = {
  actionBoard: [
    "create-action", "quick-capture", "open-inbox", "show-project", "edit-action", "set-action-status", "update-action",
    "set-action-priorities", "trash-action", "set-active-saved-view", "upsert-saved-view", "delete-saved-view", "prompt",
    "show-menu", "open-file", "open-link", "open-note-link",
  ],
  projects: [
    "create-action", "create-project", "set-project-selection", "edit-action", "set-action-status", "trash-action",
    "edit-project", "set-project-status", "set-project-area", "move-subproject", "trash-project", "trash-projects", "batch-project-tags",
    "batch-project-parent", "project-dependencies", "import-actions", "import-subprojects", "load-project-detail",
    "link-project-file", "unlink-project-file", "add-project-link", "remove-project-link", "open-link",
    "set-desired-outcome", "add-diary-entry", "create-support-note", "create-support-folder", "read-support-note",
    "update-support-note", "save-project-preferences", "open-file", "open-someday-review", "open-pomodoro", "show-menu",
    "delegate-project", "answer-agent-question", "stop-agent-run", "rerun-agent-run", "delete-agent-run",
    "open-note-link",
  ],
  inbox: ["quick-capture", "open-file", "read-inbox-body", "trash-inbox-item", "process-inbox", "open-mail", "review-pull-request"],
  feeds: [
    "refresh-feeds", "add-feed", "keep-feed-items", "read-feed-item", "discard-feed-items", "undo-feed-discard", "open-link",
    "open-inbox",
  ],
  projectReview: [
    "load-review-project", "create-review-action", "add-diary-entry", "complete-project-review", "move-review-to-someday",
    "trash-project", "create-project", "open-file", "edit-action", "set-action-status", "trash-action", "set-project-status",
    "open-someday-review",
  ],
  brainstorm: [
    "load-brainstorm-outcome", "save-brainstorm", "save-standalone-brainstorm", "shuffle-brainstorm-words",
    "focus-brainstorm-ideas", "show-project",
  ],
  somedayReview: ["set-project-status", "move-subproject", "review-someday-project", "show-project"],
  pomodoro: [
    "start-pomodoro", "pause-pomodoro", "resume-pomodoro", "finish-pomodoro", "discard-pomodoro",
    "complete-pomodoro-action", "show-project", "start-checklist-pomodoro", "mark-checklist-item", "open-checklist-run",
  ],
  checklists: [
    "start-checklist-run", "show-checklist-run", "mark-checklist-item", "finish-checklist-run", "discard-checklist-run",
    "capture-from-checklist", "open-checklist-pomodoro", "open-file",
  ],
  modals: [
    "save-new-action", "save-action", "schedule-action", "convert-action-to-subproject", "save-new-project", "save-project",
    "trash-project", "add-project-tags", "set-projects-parent", "set-project-blockers", "parse-import-list",
    "import-action-list", "import-subproject-list", "capture-inbox-item", "submit-prompt", "close-modal",
  ],
} as const satisfies Record<string, readonly (ElmNonMenuCommand["type"] | "show-menu")[]>;

type SurfaceCommand<S extends keyof typeof SURFACE_COMMANDS> =
  Extract<ElmNonMenuCommand, { type: (typeof SURFACE_COMMANDS)[S][number] }>;

export type ElmActionBoardCommand = SurfaceCommand<"actionBoard"> | ElmActionBoardMenuCommand;
export type ElmProjectsCommand = SurfaceCommand<"projects"> | ElmProjectsMenuCommand;
export type ElmInboxCommand = SurfaceCommand<"inbox">;
export type ElmFeedsCommand = SurfaceCommand<"feeds">;
export type ElmProjectReviewCommand = SurfaceCommand<"projectReview">;
export type ElmBrainstormCommand = SurfaceCommand<"brainstorm">;
export type ElmModalCommand = SurfaceCommand<"modals">;
export type ElmSomedayReviewCommand = SurfaceCommand<"somedayReview">;
export type ElmPomodoroCommand = SurfaceCommand<"pomodoro">;
export type ElmChecklistsCommand = SurfaceCommand<"checklists">;

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
export const parseSomedayReviewCommand = parserFor<ElmSomedayReviewCommand>(
  (value): value is ElmSomedayReviewCommand => isSurfaceCommand(value, SOMEDAY_REVIEW_COMMANDS),
);
export const parsePomodoroCommand = parserFor<ElmPomodoroCommand>(
  (value): value is ElmPomodoroCommand => isSurfaceCommand(value, POMODORO_COMMANDS),
);
export const parseChecklistsCommand = parserFor<ElmChecklistsCommand>(
  (value): value is ElmChecklistsCommand => isSurfaceCommand(value, CHECKLISTS_COMMANDS),
);

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

const ACTION_BOARD_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.actionBoard);
const ACTION_BOARD_MENU_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.actionBoard.filter((type) => type !== "show-menu"));
const PROJECTS_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.projects);
const PROJECTS_MENU_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.projects.filter((type) => type !== "show-menu"));
const INBOX_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.inbox);
const FEEDS_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.feeds);
const PROJECT_REVIEW_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.projectReview);
const BRAINSTORM_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.brainstorm);
const MODAL_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.modals);
const SOMEDAY_REVIEW_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.somedayReview);
const POMODORO_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.pomodoro);
const CHECKLISTS_COMMANDS: ReadonlySet<string> = new Set(SURFACE_COMMANDS.checklists);

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
      return (value.parentProjectId === undefined || typeof value.parentProjectId === "string")
        && isOneOf(PROJECT_STATUSES, value.status);
    case "set-project-selection":
      return value.projectId === undefined || typeof value.projectId === "string";
    case "quick-capture":
    case "open-inbox":
    case "open-someday-review":
    case "pause-pomodoro":
    case "resume-pomodoro":
    case "discard-pomodoro":
      return true;
    case "open-pomodoro":
    case "delegate-project":
      return typeof value.projectId === "string";
    case "answer-agent-question":
      return typeof value.runId === "string" && typeof value.questionId === "string" && typeof value.answer === "string";
    case "stop-agent-run":
    case "rerun-agent-run":
    case "delete-agent-run":
      return typeof value.runId === "string";
    case "start-pomodoro":
      return typeof value.projectId === "string"
        && typeof value.intention === "string"
        && isStringArray(value.focusActionIds)
        && Number.isInteger(value.minutes)
        && Number(value.minutes) >= 1
        && Number(value.minutes) <= 180;
    case "finish-pomodoro":
      return (value.outcome === null || isOneOf(POMODORO_OUTCOMES, value.outcome)) && typeof value.reflection === "string";
    case "complete-pomodoro-action":
      return typeof value.actionId === "string";
    case "start-checklist-pomodoro":
      return typeof value.path === "string"
        && typeof value.intention === "string"
        && Number.isInteger(value.minutes)
        && Number(value.minutes) >= 1
        && Number(value.minutes) <= 180;
    case "open-checklist-pomodoro":
    case "start-checklist-run":
      return typeof value.path === "string";
    case "show-checklist-run":
      return value.runId === null || typeof value.runId === "string";
    case "open-checklist-run":
    case "finish-checklist-run":
    case "discard-checklist-run":
      return typeof value.runId === "string";
    case "mark-checklist-item":
      return typeof value.runId === "string" && typeof value.key === "string" && isOneOf(MARK_STATES, value.state);
    case "capture-from-checklist":
      return typeof value.path === "string" && typeof value.text === "string";
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
    case "link-project-file":
      return typeof value.projectId === "string";
    case "unlink-project-file":
      return typeof value.projectId === "string" && typeof value.link === "string";
    case "add-project-link":
      return typeof value.projectId === "string" && typeof value.url === "string" && typeof value.title === "string";
    case "remove-project-link":
      return typeof value.projectId === "string" && typeof value.entry === "string";
    case "set-project-status":
      return typeof value.projectId === "string"
        && isOneOf(PROJECT_STATUSES, value.status);
    case "set-project-area":
      return typeof value.projectId === "string" && typeof value.area === "string";
    case "move-subproject":
      return typeof value.projectId === "string"
        && isOneOf(BOARD_PROJECT_STATUSES, value.status)
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
    case "review-someday-project":
      return typeof value.projectId === "string" && typeof value.activateAt === "string";
    case "save-project-preferences":
      return Array.isArray(value.columns)
        && value.columns.length > 0
        && value.columns.every((status) => isOneOf(BOARD_PROJECT_STATUSES, status))
        && typeof value.showImages === "boolean"
        && (value.columnsBy === "status" || value.columnsBy === "area")
        && ["none", "area", "status"].includes(String(value.sections));
    case "load-review-project":
    case "load-brainstorm-outcome":
      return typeof value.projectId === "string";
    case "create-review-action":
      return typeof value.title === "string"
        && typeof value.projectId === "string"
        && typeof value.context === "string";
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
        && isOneOf(ACTION_STATUSES, value.status);
    case "set-action-priorities":
      return isStringArray(value.actionIds) && value.actionIds.length > 0;
    case "update-action":
      return typeof value.actionId === "string"
        && (value.projectId === undefined || typeof value.projectId === "string")
        && (value.context === undefined || typeof value.context === "string");
    case "open-file":
      return typeof value.path === "string";
    case "read-inbox-body":
    case "trash-inbox-item":
    case "open-mail":
    case "review-pull-request":
      return typeof value.itemId === "string";
    case "process-inbox":
      return typeof value.itemId === "string"
        && ["next-action", "file", "someday", "backlog"].includes(String(value.operation))
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
    case "open-link":
      return typeof value.url === "string";
    case "open-note-link":
      return typeof value.link === "string" && typeof value.sourcePath === "string";
    case "read-feed-item":
      return typeof value.key === "string" && typeof value.comments === "boolean";
    default:
      return false;
  }
}

function isInboxInput(value: unknown): value is ElmInboxProcessingInput {
  return isRecord(value)
    && isOptionalString(value.projectId)
    && isOptionalString(value.projectTitle)
    && isOptionalString(value.desiredOutcome)
    && isOptionalString(value.nextAction)
    && (value.status === undefined || isOneOf(ACTION_STATUSES, value.status))
    && isOptionalString(value.context)
    && (value.energy === undefined || isOneOf(ENERGY_LEVELS, value.energy))
    && isOptionalString(value.waitingSince)
    && isOptionalString(value.followUp)
    && isOptionalSchedule(value.schedule)
    && isOptionalBoolean(value.fileOriginal);
}

function isSavedView(value: unknown): value is SavedView {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && Array.isArray(value.filters)
    && value.filters.every(isActionFilter)
    && ["status", "project", "context", "energy"].includes(String(value.groupBy))
    && (value.sectionBy === undefined || value.sectionBy === null
      || ["status", "project", "context", "energy"].includes(String(value.sectionBy)))
    && isSortSpec(value.sort)
    && (value.visibleColumns === null || isStringArray(value.visibleColumns));
}

function isActionFilter(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "value") {
    return ["status", "project", "context", "energy", "area"].includes(String(value.field))
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
    && isOneOf(ACTION_STATUSES, value.status)
    && typeof value.context === "string"
    && (value.projectId === undefined || typeof value.projectId === "string")
    && (value.waitingSince === undefined || typeof value.waitingSince === "string")
    && (value.followUp === undefined || typeof value.followUp === "string")
    && isOptionalSchedule(value.schedule);
}

function isActionChanges(value: unknown): value is ElmActionChanges {
  return isNewActionInput(value)
    && typeof (value as ElmActionChanges).projectId === "string"
    && ((value as ElmActionChanges).energy === "" || isOneOf(ENERGY_LEVELS, (value as ElmActionChanges).energy))
    && typeof (value as ElmActionChanges).due === "string"
    && typeof (value as ElmActionChanges).followUp === "string";
}

function isNewProjectInput(value: unknown): value is ElmNewProjectInput {
  return isRecord(value)
    && typeof value.title === "string"
    && isOneOf(PROJECT_STATUSES, value.status)
    && typeof value.area === "string"
    && typeof value.image === "string"
    && isStringArray(value.tags)
    && (value.parentProjectId === undefined || typeof value.parentProjectId === "string");
}

function isProjectChanges(value: unknown): value is ElmProjectChanges {
  return isRecord(value)
    && typeof value.title === "string"
    && isOneOf(PROJECT_STATUSES, value.status)
    && typeof value.activateAt === "string"
    && typeof value.area === "string"
    && typeof value.image === "string"
    && isStringArray(value.tags)
    && typeof value.reviewed === "string"
    && typeof value.parentProjectId === "string";
}

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
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
  | { type: "agent"; agent: ElmAgentDto }
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
  | { type: "review-health"; health: ProjectReviewHealth }
  | { type: "review-queue"; queue: string[] }
  | ElmCommandResultEvent;
export type ElmBrainstormEvent =
  | { type: "snapshot"; snapshot: ElmSnapshotDto }
  | { type: "brainstorm-outcome"; projectId: string; desiredOutcome: string }
  | ElmCommandResultEvent;
export type ElmFeedsEvent = { type: "feeds"; feeds: ElmFeedsDto } | ElmCommandResultEvent;
export type ElmModalEvent = ElmCommandResultEvent;
export type ElmSomedayReviewEvent = { type: "snapshot"; snapshot: ElmSnapshotDto } | ElmCommandResultEvent;
export type ElmPomodoroEvent =
  | { type: "snapshot"; snapshot: ElmSnapshotDto }
  | { type: "pomodoro"; pomodoro: ElmPomodoroDto }
  | { type: "select-project"; projectId: string }
  | { type: "select-checklist"; path: string }
  | ElmCommandResultEvent;
export type ElmChecklistsEvent = { type: "checklists"; checklists: ElmChecklistsDto } | ElmCommandResultEvent;
