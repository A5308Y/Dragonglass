import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { buildCalendarSyncEvents } from "../src/calendar/events";
import type { Action, GtdSnapshot, Project } from "../src/domain/types";

const file = (path: string) => ({ path } as TFile);
const project: Project = {
  type: "gtd-project",
  id: "P1",
  title: "Dragonglass",
  status: "active",
  created: "2026-09-19",
  file: file("GTD/Projects/Dragonglass.md"),
};
const scheduled: Action = {
  type: "gtd-action",
  id: "A1",
  title: "Review calendar sync",
  status: "scheduled",
  created: "2026-09-19",
  file: file("GTD/Actions/Review calendar sync.md"),
  projectId: project.id,
  context: "computer",
  scheduledStart: "2026-09-20T12:00:00.000Z",
  durationMinutes: 45,
};

function snapshot(actions: Action[]): GtdSnapshot {
  return {
    revision: 1,
    inboxItems: [],
    actions,
    projects: [project],
    inboxItemsById: new Map(),
    actionsById: new Map(actions.map((action) => [action.id, action])),
    projectsById: new Map([[project.id, project]]),
    issues: [],
  };
}

describe("Google Calendar event projection", () => {
  it("exports Scheduled Actions with calculated end times and metadata", () => {
    expect(buildCalendarSyncEvents(snapshot([scheduled]), "Personal Vault")).toEqual([{
      actionId: "A1",
      summary: "Review calendar sync",
      description: [
        "Project: Dragonglass",
        "Context: @computer",
        "Open in Obsidian: obsidian://open?vault=Personal%20Vault&file=GTD%2FActions%2FReview%20calendar%20sync.md",
        "Managed by Dragonglass. Calendar changes will be overwritten.",
      ].join("\n"),
      start: "2026-09-20T12:00:00.000Z",
      end: "2026-09-20T12:45:00.000Z",
    }]);
  });

  it("does not export non-Scheduled or incomplete legacy schedules", () => {
    const { scheduledStart: _start, ...missingStart } = scheduled;
    const { durationMinutes: _duration, ...missingDuration } = scheduled;
    expect(buildCalendarSyncEvents(snapshot([
      { ...scheduled, id: "A2", status: "next" },
      { ...missingStart, id: "A3" },
      { ...missingDuration, id: "A4" },
    ]), "Personal Vault")).toEqual([]);
  });

  it("sorts exported events deterministically", () => {
    const later = { ...scheduled, id: "A2", scheduledStart: "2026-09-21T12:00:00.000Z" };
    expect(buildCalendarSyncEvents(snapshot([later, scheduled]), "Vault").map((event) => event.actionId)).toEqual(["A1", "A2"]);
  });
});
