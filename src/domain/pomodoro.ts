/**
 * Pomodoro sessions: a fixed time slice of focus on one Project or one checklist run,
 * with an intention set before it starts and a short reflection after it ends.
 *
 * The log is one JSON file in the vault, like the Feeds and Mail stores, so it
 * travels with vault sync. It is also the source a time-tracking integration will
 * read from: every finished session has a stable id, exact start and end times,
 * the seconds actually focused, and an `external` map where a sync records what it
 * has already sent. `toTimeEntry` is the one neutral shape such a sync consumes.
 */

import { byKey, mergeKeyed, same } from "./merge";

export const POMODORO_STORE_VERSION = 1;

/** How many finished sessions the log keeps before the oldest are dropped. */
export const SESSION_LIMIT = 5_000;

export type PomodoroOutcome = "achieved" | "partly" | "missed";

export const POMODORO_OUTCOMES: readonly PomodoroOutcome[] = ["achieved", "partly", "missed"];

/** What a sync to an external time tracker remembers about one session. */
export interface ExternalLink {
  /** The entry's id in the external system. */
  id: string;
  /** When the entry was last written there, as an ISO timestamp. */
  syncedAt: string;
}

/** The checklist run a session is spent on, instead of a Project. */
export interface PomodoroChecklist {
  runId: string;
  /** The checklist note's path when the session started. */
  path: string;
}

interface SessionBasis {
  /** A ULID: the stable key an external time tracker reconciles against. */
  id: string;
  /** Empty for a session on a checklist run. */
  projectId: string;
  /**
   * The Project's title and breadcrumb when the session started, so history survives
   * renames and deletes. A checklist session has the checklist's title and no breadcrumb.
   */
  projectTitle: string;
  projectPath: string;
  /** Set when the session is spent on a checklist run; checklists aren't Projects. */
  checklist?: PomodoroChecklist;
  intention: string;
  /** The Actions picked to work on, if any. */
  focusActionIds: string[];
  /** The Actions marked done during the session. */
  completedActionIds: string[];
  plannedMinutes: number;
  /** ISO timestamp. */
  startedAt: string;
}

export interface ActivePomodoro extends SessionBasis {
  /** When the current running stretch began, or `null` while paused. */
  resumedAt: string | null;
  /** Seconds focused before the current running stretch. */
  focusedBefore: number;
}

export interface PomodoroSession extends SessionBasis {
  /** ISO timestamp. */
  endedAt: string;
  /** Seconds actually focused, pauses excluded, never more than planned. */
  focusedSeconds: number;
  /** Whether the full planned time was focused, or the session was finished early. */
  status: "completed" | "stopped";
  outcome: PomodoroOutcome | null;
  reflection: string;
  /** Keyed by integration, e.g. `toggl`. Empty until something syncs the session. */
  external: Record<string, ExternalLink>;
}

export interface PomodoroStore {
  version: number;
  active: ActivePomodoro | null;
  /** Newest first. */
  sessions: PomodoroSession[];
}

export interface PomodoroStart {
  id: string;
  projectId: string;
  projectTitle: string;
  projectPath: string;
  checklist?: PomodoroChecklist;
  intention: string;
  focusActionIds: string[];
  plannedMinutes: number;
}

export interface PomodoroWrapUp {
  outcome: PomodoroOutcome | null;
  reflection: string;
}

/** A neutral time entry: what a time-tracking integration sends for one session. */
export interface TimeEntry {
  /** The session id, stable across re-syncs. */
  key: string;
  start: string;
  end: string;
  durationSeconds: number;
  project: string;
  description: string;
  tags: string[];
}

export function emptyPomodoroStore(): PomodoroStore {
  return { version: POMODORO_STORE_VERSION, active: null, sessions: [] };
}

export function startPomodoro(store: PomodoroStore, start: PomodoroStart, now: Date): PomodoroStore {
  if (store.active) throw new Error("A Pomodoro is already running.");
  if (!start.projectId && !start.checklist) throw new Error("Choose a Project or a checklist first.");
  if (!start.intention.trim()) throw new Error("Set an intention before starting.");
  if (!Number.isInteger(start.plannedMinutes) || start.plannedMinutes < 1 || start.plannedMinutes > 180) {
    throw new Error("A Pomodoro lasts between 1 and 180 minutes.");
  }
  const startedAt = now.toISOString();
  return {
    ...store,
    active: {
      ...start,
      intention: start.intention.trim(),
      focusActionIds: unique(start.focusActionIds),
      completedActionIds: [],
      startedAt,
      resumedAt: startedAt,
      focusedBefore: 0,
    },
  };
}

/** Seconds focused so far, pauses excluded, capped at the planned length. */
export function focusedSeconds(active: ActivePomodoro, now: Date): number {
  const running = active.resumedAt ? Math.max(0, (now.getTime() - Date.parse(active.resumedAt)) / 1000) : 0;
  return Math.min(active.plannedMinutes * 60, Math.floor(active.focusedBefore + running));
}

export function remainingSeconds(active: ActivePomodoro, now: Date): number {
  return active.plannedMinutes * 60 - focusedSeconds(active, now);
}

/** When the running session reaches its planned length, or `null` while paused. */
export function endsAt(active: ActivePomodoro, now: Date): Date | null {
  if (!active.resumedAt) return null;
  return new Date(now.getTime() + remainingSeconds(active, now) * 1000);
}

export function pausePomodoro(store: PomodoroStore, now: Date): PomodoroStore {
  const active = store.active;
  if (!active?.resumedAt) return store;
  return { ...store, active: { ...active, focusedBefore: focusedSeconds(active, now), resumedAt: null } };
}

export function resumePomodoro(store: PomodoroStore, now: Date): PomodoroStore {
  const active = store.active;
  if (!active || active.resumedAt || remainingSeconds(active, now) <= 0) return store;
  return { ...store, active: { ...active, resumedAt: now.toISOString() } };
}

export function recordCompletedAction(store: PomodoroStore, actionId: string): PomodoroStore {
  const active = store.active;
  if (!active) return store;
  return { ...store, active: { ...active, completedActionIds: unique([...active.completedActionIds, actionId]) } };
}

/** Ends the active session and files it in the log, newest first. */
export function finishPomodoro(store: PomodoroStore, wrapUp: PomodoroWrapUp, now: Date): PomodoroStore {
  const active = store.active;
  if (!active) throw new Error("No Pomodoro is running.");
  const focused = focusedSeconds(active, now);
  const { resumedAt: _resumedAt, focusedBefore: _focusedBefore, ...basis } = active;
  const session: PomodoroSession = {
    ...basis,
    endedAt: now.toISOString(),
    focusedSeconds: focused,
    status: focused >= active.plannedMinutes * 60 ? "completed" : "stopped",
    outcome: wrapUp.outcome,
    reflection: wrapUp.reflection.trim(),
    external: {},
  };
  return { ...store, active: null, sessions: [session, ...store.sessions].slice(0, SESSION_LIMIT) };
}

export function discardPomodoro(store: PomodoroStore): PomodoroStore {
  return { ...store, active: null };
}

/** Puts a discarded session back, as Undo does. A session started since wins. */
export function restorePomodoro(store: PomodoroStore, active: ActivePomodoro): PomodoroStore {
  return store.active ? store : { ...store, active };
}

/**
 * Merges this device's copy of the log with the file's (see `src/domain/merge.ts`).
 * Sessions filed on either device are kept, with the time-tracking links of both; the
 * running session is whichever device changed it last, and none once it has been filed.
 */
export function mergePomodoroStores(base: PomodoroStore, mine: PomodoroStore, theirs: PomodoroStore): PomodoroStore {
  const id = (session: PomodoroSession) => session.id;
  const sessions = [...mergeKeyed(byKey(base.sessions, id), byKey(mine.sessions, id), byKey(theirs.sessions, id), (_base, ours, other) => ({
    ...ours,
    external: mergeExternal(ours.external, other.external),
  })).values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, SESSION_LIMIT);
  const active = same(mine.active, base.active) ? theirs.active : mine.active;
  const filed = active !== null && sessions.some((session) => session.id === active.id);
  return { version: POMODORO_STORE_VERSION, active: filed ? null : active, sessions };
}

function mergeExternal(mine: Record<string, ExternalLink>, theirs: Record<string, ExternalLink>): Record<string, ExternalLink> {
  const merged = { ...theirs };
  for (const [integration, link] of Object.entries(mine)) {
    const other = merged[integration];
    if (!other || link.syncedAt >= other.syncedAt) merged[integration] = link;
  }
  return merged;
}

export function toTimeEntry(session: PomodoroSession): TimeEntry {
  return {
    key: session.id,
    start: session.startedAt,
    end: session.endedAt,
    durationSeconds: session.focusedSeconds,
    project: session.projectPath || session.projectTitle,
    description: session.intention,
    tags: ["pomodoro", session.status],
  };
}

/** Reads a store file without trusting it: malformed sessions are dropped, not fatal. */
export function parsePomodoroStore(raw: unknown): PomodoroStore {
  if (!isRecord(raw)) return emptyPomodoroStore();
  const sessions = Array.isArray(raw.sessions) ? raw.sessions.flatMap(parseSession) : [];
  sessions.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return {
    version: POMODORO_STORE_VERSION,
    active: parseActive(raw.active),
    sessions: sessions.slice(0, SESSION_LIMIT),
  };
}

function parseBasis(raw: Record<string, unknown>): SessionBasis | null {
  const id = text(raw.id);
  const projectId = text(raw.projectId);
  const startedAt = text(raw.startedAt);
  const plannedMinutes = Number(raw.plannedMinutes);
  const checklist = isRecord(raw.checklist) && text(raw.checklist.runId)
    ? { runId: text(raw.checklist.runId), path: text(raw.checklist.path) }
    : undefined;
  if (!id || (!projectId && !checklist) || Number.isNaN(Date.parse(startedAt)) || !Number.isInteger(plannedMinutes) || plannedMinutes < 1) {
    return null;
  }
  return {
    id,
    projectId,
    projectTitle: text(raw.projectTitle),
    projectPath: text(raw.projectPath),
    intention: text(raw.intention),
    focusActionIds: strings(raw.focusActionIds),
    completedActionIds: strings(raw.completedActionIds),
    plannedMinutes,
    startedAt,
    ...(checklist ? { checklist } : {}),
  };
}

function parseActive(raw: unknown): ActivePomodoro | null {
  if (!isRecord(raw)) return null;
  const basis = parseBasis(raw);
  if (!basis) return null;
  const resumedAt = typeof raw.resumedAt === "string" && !Number.isNaN(Date.parse(raw.resumedAt)) ? raw.resumedAt : null;
  const focusedBefore = Number(raw.focusedBefore);
  return { ...basis, resumedAt, focusedBefore: Number.isFinite(focusedBefore) && focusedBefore > 0 ? focusedBefore : 0 };
}

function parseSession(raw: unknown): PomodoroSession[] {
  if (!isRecord(raw)) return [];
  const basis = parseBasis(raw);
  const endedAt = text(raw.endedAt);
  const focused = Number(raw.focusedSeconds);
  if (!basis || Number.isNaN(Date.parse(endedAt)) || !Number.isFinite(focused) || focused < 0) return [];
  const external: Record<string, ExternalLink> = {};
  if (isRecord(raw.external)) {
    for (const [integration, link] of Object.entries(raw.external)) {
      if (isRecord(link) && text(link.id)) external[integration] = { id: text(link.id), syncedAt: text(link.syncedAt) };
    }
  }
  return [{
    ...basis,
    endedAt,
    focusedSeconds: Math.floor(focused),
    status: raw.status === "stopped" ? "stopped" : "completed",
    outcome: POMODORO_OUTCOMES.includes(raw.outcome as PomodoroOutcome) ? raw.outcome as PomodoroOutcome : null,
    reflection: text(raw.reflection),
    external,
  }];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === "string")) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
