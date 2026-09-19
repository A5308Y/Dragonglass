import { projectBreadcrumb } from "../domain/project-hierarchy";
import type { GtdSnapshot } from "../domain/types";

export interface CalendarSyncEvent {
  actionId: string;
  summary: string;
  description: string;
  start: string;
  end: string;
}

export function buildCalendarSyncEvents(snapshot: GtdSnapshot, vaultName: string): CalendarSyncEvent[] {
  return snapshot.actions.flatMap((action) => {
    if (snapshot.actionsById.get(action.id)?.file.path !== action.file.path) return [];
    if (action.status !== "scheduled" || !action.scheduledStart || !action.durationMinutes) return [];
    const start = new Date(action.scheduledStart);
    if (Number.isNaN(start.getTime()) || action.durationMinutes <= 0) return [];
    const project = action.projectId ? snapshot.projectsById.get(action.projectId) : undefined;
    const details = [
      project ? `Project: ${projectBreadcrumb(project, snapshot.projectsById)}` : "",
      action.context ? `Context: @${action.context}` : "",
      `Open in Obsidian: ${obsidianOpenUrl(vaultName, action.file.path)}`,
      "Managed by Dragonglass. Calendar changes will be overwritten.",
    ].filter(Boolean);
    return [{
      actionId: action.id,
      summary: action.title,
      description: details.join("\n"),
      start: start.toISOString(),
      end: new Date(start.getTime() + action.durationMinutes * 60_000).toISOString(),
    }];
  }).sort((left, right) => left.start.localeCompare(right.start) || left.actionId.localeCompare(right.actionId));
}

function obsidianOpenUrl(vaultName: string, path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path)}`;
}
