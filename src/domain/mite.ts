/**
 * Reporting finished Pomodoros to mite (mite.de), one time entry per session.
 *
 * mite records a date and minutes, no start or end. A completed session also counts the
 * break that follows it, since breaks are working time; a stopped one counts only what
 * was focused. Which mite project a session goes to is set per Dragonglass Project and
 * inherited by its sub-projects. Sessions are sent once: the entry's id is recorded in
 * `session.external.mite`, and the log merges between devices, so a second device
 * doesn't send them again.
 */

import type { PomodoroSession, PomodoroStore } from "./pomodoro";
import type { Project } from "./types";
import { localDate } from "../utils/date";

export const MITE = "mite";

/** Where a Dragonglass Project's sessions go in mite. */
export interface MiteTarget {
  projectId: number;
  /** The service (Leistung); `null` uses the default from the settings. */
  serviceId: number | null;
  /** The names in mite when it was chosen, for showing it without asking mite. */
  label: string;
}

export interface MiteSettings {
  enabled: boolean;
  /** The account's subdomain: `acme` for acme.mite.de. */
  account: string;
  /** The name of the API key in Obsidian's secret storage, never the key itself. */
  apiKeySecret: string;
  defaultServiceId: number | null;
  defaultServiceLabel: string;
  /** Minutes added to each completed session for the break after it. */
  breakMinutes: number;
  /** Only sessions ended on or after this day are sent, so turning it on doesn't send the whole log. */
  sendFrom: string;
  /** Dragonglass Project id → where its sessions (and its sub-projects') go. */
  projects: Record<string, MiteTarget>;
}

export interface MiteEntry {
  date_at: string;
  minutes: number;
  note: string;
  project_id: number;
  service_id?: number;
}

/** Focused time, plus the break for a completed session, rounded to whole minutes. */
export function miteMinutes(session: PomodoroSession, breakMinutes: number): number {
  const breakSeconds = session.status === "completed" ? Math.max(0, breakMinutes) * 60 : 0;
  return Math.round((session.focusedSeconds + breakSeconds) / 60);
}

/** The target set on the Project or the nearest Project above it, or `null`. */
export function miteTargetFor(
  projectId: string,
  projects: readonly Project[],
  targets: Readonly<Record<string, MiteTarget>>,
): MiteTarget | null {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const visited = new Set<string>();
  let current: string | undefined = projectId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const target = targets[current];
    if (target) return target;
    current = byId.get(current)?.parentProjectId;
  }
  return null;
}

export function miteEntry(session: PomodoroSession, target: MiteTarget, settings: Pick<MiteSettings, "breakMinutes" | "defaultServiceId">): MiteEntry {
  const outcome = session.outcome === "achieved" ? "achieved" : session.outcome === "partly" ? "partly achieved" : session.outcome === "missed" ? "not achieved" : "";
  const note = [`🍅 ${session.projectTitle}: ${session.intention}`, outcome, session.status === "stopped" ? "stopped early" : ""]
    .filter(Boolean)
    .join(" — ");
  const serviceId = target.serviceId ?? settings.defaultServiceId;
  return {
    date_at: localDate(new Date(session.startedAt)),
    minutes: miteMinutes(session, settings.breakMinutes),
    note,
    project_id: target.projectId,
    ...(serviceId !== null ? { service_id: serviceId } : {}),
  };
}

/** Finished sessions not sent yet, oldest first; sessions under a minute have nothing to report. */
export function unsentSessions(store: PomodoroStore, sendFrom: string): PomodoroSession[] {
  return store.sessions
    .filter((session) => !session.external[MITE] && localDate(new Date(session.endedAt)) >= sendFrom && session.focusedSeconds >= 60)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/** Records the mite entry a session became. */
export function withExternalLink(store: PomodoroStore, sessionId: string, integration: string, id: string, syncedAt: string): PomodoroStore {
  return {
    ...store,
    sessions: store.sessions.map((session) => (session.id === sessionId
      ? { ...session, external: { ...session.external, [integration]: { id, syncedAt } } }
      : session)),
  };
}

/** Reads the mite part of saved settings without trusting it. */
export function parseMiteSettings(raw: unknown, today: string): MiteSettings {
  const value = isRecord(raw) ? raw : {};
  const projects: Record<string, MiteTarget> = {};
  if (isRecord(value.projects)) {
    for (const [projectId, target] of Object.entries(value.projects)) {
      if (!isRecord(target) || !isId(target.projectId)) continue;
      projects[projectId] = {
        projectId: target.projectId,
        serviceId: isId(target.serviceId) ? target.serviceId : null,
        label: typeof target.label === "string" ? target.label : `mite project ${target.projectId}`,
      };
    }
  }
  return {
    enabled: value.enabled === true,
    account: typeof value.account === "string" ? value.account.trim() : "",
    apiKeySecret: typeof value.apiKeySecret === "string" ? value.apiKeySecret : "",
    defaultServiceId: isId(value.defaultServiceId) ? value.defaultServiceId : null,
    defaultServiceLabel: typeof value.defaultServiceLabel === "string" ? value.defaultServiceLabel : "",
    breakMinutes: Number.isInteger(value.breakMinutes) && (value.breakMinutes as number) >= 0 && (value.breakMinutes as number) <= 60
      ? value.breakMinutes as number
      : 5,
    sendFrom: typeof value.sendFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.sendFrom) ? value.sendFrom : today,
    projects,
  };
}

/** `acme`, `acme.mite.de` or `https://acme.mite.de/` all mean the account `acme`. */
export function miteAccount(raw: string): string {
  return raw.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.mite\.(de|yo\.lk)$/, "").toLowerCase();
}

function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
