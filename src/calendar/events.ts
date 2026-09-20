import { projectBreadcrumb } from "../domain/project-hierarchy";
import { actionSchedule, scheduleReminderMinutes } from "../domain/schedule";
import type { GtdSnapshot } from "../domain/types";
import { addLocalDays } from "../utils/date";

export interface CalendarSyncEvent {
  /** Stable reconciliation key. Action IDs stay unprefixed for bridge compatibility. */
  actionId: string;
  summary: string;
  description: string;
  /** An RFC3339 timestamp when timed, or a plain date when the event covers a whole day. */
  start: string;
  /** For an all-day event this is the exclusive end date Google expects, one day after the start. */
  end: string;
  allDay: boolean;
  /** Minutes before the event that its alarm fires. Google counts an all-day event's back from midnight. */
  reminderMinutes: number;
}

export function buildCalendarSyncEvents(snapshot: GtdSnapshot, vaultName: string): CalendarSyncEvent[] {
  const actionEvents = snapshot.actions.flatMap((action): CalendarSyncEvent[] => {
    if (snapshot.actionsById.get(action.id)?.file.path !== action.file.path) return [];
    if (action.status !== "scheduled") return [];
    const schedule = actionSchedule(action.scheduledStart, action.durationMinutes);
    if (!schedule) return [];
    const project = action.projectId ? snapshot.projectsById.get(action.projectId) : undefined;
    const details = [
      project ? `Project: ${projectBreadcrumb(project, snapshot.projectsById)}` : "",
      action.context ? `Context: @${action.context}` : "",
      `Open in Obsidian: ${obsidianOpenUrl(vaultName, action.file.path)}`,
      "Managed by Dragonglass. Calendar changes will be overwritten.",
    ].filter(Boolean);
    const span = schedule.kind === "all-day"
      // Google treats an all-day end date as exclusive, so a single day ends on the next one.
      ? { start: schedule.date, end: addLocalDays(schedule.date, 1), allDay: true }
      : {
        start: new Date(schedule.start).toISOString(),
        end: new Date(new Date(schedule.start).getTime() + schedule.durationMinutes * 60_000).toISOString(),
        allDay: false,
      };
    return [{
      actionId: action.id,
      summary: action.title,
      description: details.join("\n"),
      ...span,
      reminderMinutes: scheduleReminderMinutes(schedule),
    }];
  });
  const projectEvents = snapshot.projects.flatMap((project): CalendarSyncEvent[] => {
    if (snapshot.projectsById.get(project.id)?.file.path !== project.file.path || !project.activateAt) return [];
    return [{
      actionId: `project:${project.id}`,
      summary: `Activate Project: ${project.title}`,
      description: [
        `Project: ${projectBreadcrumb(project, snapshot.projectsById)}`,
        `Open in Obsidian: ${obsidianOpenUrl(vaultName, project.file.path)}`,
        "Managed by Dragonglass. Calendar changes will be overwritten.",
      ].join("\n"),
      start: project.activateAt,
      end: addLocalDays(project.activateAt, 1),
      allDay: true,
      reminderMinutes: 900,
    }];
  });
  return [...actionEvents, ...projectEvents]
    .sort((left, right) => left.start.localeCompare(right.start) || left.actionId.localeCompare(right.actionId));
}

function obsidianOpenUrl(vaultName: string, path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path)}`;
}
