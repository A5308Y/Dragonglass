import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Action, GtdSnapshot, Project } from "../src/domain/types";
import { isActionStatus } from "../src/domain/validation";
import { buildBoard, filterActions, matchesFilter, sortActions } from "../src/state/query";
import { createDefaultViews } from "../src/state/defaults";

const file = (path: string) => ({ path } as TFile);
const project: Project = { type: "gtd-project", id: "P1", title: "Heating", file: file("GTD/Projects/Heating.md"), status: "active", created: "2026-09-01" };
const actions: Action[] = [
  { type: "gtd-action", id: "A1", title: "Compare offers", file: file("A1.md"), status: "next", projectId: "P1", context: "computer", energy: "medium", due: "2026-09-20", created: "2026-09-18" },
  { type: "gtd-action", id: "A2", title: "Call installer", file: file("A2.md"), status: "waiting", projectId: "P1", context: "phone", due: "2026-09-25", created: "2026-09-17" },
  { type: "gtd-action", id: "A3", title: "Future research", file: file("A3.md"), status: "next", deferUntil: "2026-10-01", created: "2026-09-16" },
];
const projects = new Map([[project.id, project]]);

describe("query model", () => {
  it("does not treat inbox as an Action status", () => {
    expect(isActionStatus("inbox")).toBe(false);
    expect(isActionStatus("next")).toBe(true);
    expect(JSON.stringify(createDefaultViews())).not.toContain("inbox");
  });

  it("combines filters with AND", () => {
    const result = filterActions(actions, [
      { kind: "value", field: "status", operator: "in", values: ["next"] },
      { kind: "value", field: "context", operator: "in", values: ["computer"] },
    ], "", projects);
    expect(result.map((action) => action.id)).toEqual(["A1"]);
  });

  it("hides future deferred actions from available-now queries", () => {
    expect(matchesFilter(actions[0]!, { kind: "availability", operator: "available" }, "2026-09-18")).toBe(true);
    expect(matchesFilter(actions[2]!, { kind: "availability", operator: "available" }, "2026-09-18")).toBe(false);
  });

  it("uses inclusive due-soon boundaries", () => {
    expect(matchesFilter(actions[0]!, { kind: "due", operator: "withinNextDays", value: 2 }, "2026-09-18")).toBe(true);
    expect(matchesFilter(actions[1]!, { kind: "due", operator: "withinNextDays", value: 2 }, "2026-09-18")).toBe(false);
  });

  it("searches resolved project titles", () => {
    expect(filterActions(actions, [], "heat", projects).map((action) => action.id)).toEqual(["A1", "A2"]);
  });

  it("searches full nested Project breadcrumbs", () => {
    const child: Project = { type: "gtd-project", id: "P2", title: "Boiler", parentProjectId: "P1", file: file("GTD/Projects/Boiler.md"), status: "active", created: "2026-09-01" };
    const nestedProjects = new Map([...projects, [child.id, child]]);
    const nestedAction: Action = { type: "gtd-action", id: "A4", title: "Request quote", projectId: "P2", file: file("A4.md"), status: "next", created: "2026-09-18" };
    expect(filterActions([nestedAction], [], "heating > boil", nestedProjects).map((action) => action.id)).toEqual(["A4"]);
  });

  it("sorts empty due dates last in both directions", () => {
    expect(sortActions(actions, { field: "due", direction: "asc" }, projects).at(-1)?.id).toBe("A3");
    expect(sortActions(actions, { field: "due", direction: "desc" }, projects).at(-1)?.id).toBe("A3");
  });

  it("builds serializable project groups", () => {
    const snapshot: GtdSnapshot = {
      revision: 1,
      inboxItems: [],
      actions,
      projects: [project],
      inboxItemsById: new Map(),
      actionsById: new Map(actions.map((action) => [action.id, action])),
      projectsById: projects,
      issues: [],
    };
    const groups = buildBoard(snapshot, { filters: [], groupBy: "project", sort: { field: "title", direction: "asc" }, visibleColumns: null });
    expect(groups.map((group) => group.label)).toEqual(["Heating", "No project"]);
  });
});
