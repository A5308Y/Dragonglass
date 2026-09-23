import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Action, GtdSnapshot, Project } from "../src/domain/types";
import { isActionStatus, parseAction } from "../src/domain/validation";
import { buildBoard, filterActions, matchesFilter, sortActions } from "../src/state/query";
import { createDefaultViews } from "../src/state/defaults";

const file = (path: string) => ({ path } as TFile);
const project: Project = { type: "gtd-project", id: "P1", title: "Heating", file: file("GTD/Projects/Heating.md"), status: "active", created: "2026-09-01" };
const actions: Action[] = [
  { type: "gtd-action", id: "A1", title: "Compare offers", file: file("A1.md"), status: "next", projectId: "P1", context: "computer", energy: "medium", due: "2026-09-20", created: "2026-09-18" },
  { type: "gtd-action", id: "A2", title: "Call installer", file: file("A2.md"), status: "waiting", projectId: "P1", context: "phone", due: "2026-09-25", created: "2026-09-17" },
  { type: "gtd-action", id: "A3", title: "Future research", file: file("A3.md"), status: "next", created: "2026-09-16" },
];
const projects = new Map([[project.id, project]]);

describe("query model", () => {
  it("does not treat inbox as an Action status", () => {
    expect(isActionStatus("inbox")).toBe(false);
    expect(isActionStatus("someday")).toBe(false);
    expect(isActionStatus("next")).toBe(true);
    expect(JSON.stringify(createDefaultViews())).not.toContain("inbox");
    expect(JSON.stringify(createDefaultViews())).not.toContain("someday");
  });

  it("rejects a manually written Someday Action as invalid metadata", () => {
    expect(() => parseAction({
      type: "gtd-action",
      id: "A-LEGACY",
      title: "Old someday item",
      status: "someday",
      created: "2026-09-18",
    }, file("Legacy.md"))).toThrow("Invalid 'status'");
  });

  it("combines filters with AND", () => {
    const result = filterActions(actions, [
      { kind: "value", field: "status", operator: "in", values: ["next"] },
      { kind: "value", field: "context", operator: "in", values: ["computer"] },
    ], "", projects);
    expect(result.map((action) => action.id)).toEqual(["A1"]);
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

  it("sorts by the drag order only when Manual is chosen, with unranked Actions last", () => {
    const ranked = [{ ...actions[0]!, priority: 2_000 }, { ...actions[1]!, priority: 1_000 }, actions[2]!];
    expect(sortActions(ranked, { field: "manual", direction: "asc" }, projects).map((action) => action.id)).toEqual(["A2", "A1", "A3"]);
    expect(sortActions(ranked, { field: "manual", direction: "desc" }, projects).map((action) => action.id)).toEqual(["A1", "A2", "A3"]);
    expect(sortActions(ranked, { field: "title", direction: "asc" }, projects).map((action) => action.id)).toEqual(["A2", "A1", "A3"]);
    expect(sortActions(ranked, { field: "created", direction: "asc" }, projects).map((action) => action.id)).toEqual(["A3", "A2", "A1"]);
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

  it("filters Actions by the area of their Project or any ancestor", () => {
    const root: Project = { ...project, id: "R", title: "Home", area: "Household" };
    const middle: Project = { ...project, id: "M", title: "Heating", parentProjectId: "R" };
    const leaf: Project = { ...project, id: "L", title: "Boiler", parentProjectId: "M", area: "Maintenance" };
    const byId = new Map([root, middle, leaf].map((item) => [item.id, item]));
    // A3 has no Project, so it is the base for the one left without one.
    const inProject = (id: string, projectId?: string): Action => ({ ...actions[2]!, id, ...(projectId ? { projectId } : {}) });
    const candidates = [inProject("A-root", "R"), inProject("A-middle", "M"), inProject("A-leaf", "L"), inProject("A-none")];
    const household = candidates.filter((action) =>
      matchesFilter(action, { kind: "value", field: "area", operator: "in", values: ["Household"] }, "2026-09-18", byId));
    expect(household.map((action) => action.id)).toEqual(["A-root", "A-middle", "A-leaf"]);
    const notMaintenance = candidates.filter((action) =>
      matchesFilter(action, { kind: "value", field: "area", operator: "notIn", values: ["Maintenance"] }, "2026-09-18", byId));
    expect(notMaintenance.map((action) => action.id)).toEqual(["A-root", "A-middle", "A-none"]);
  });

  it("matches the Actions of a filtered Project's sub-projects at any depth", () => {
    const root: Project = { ...project, id: "R", title: "Home" };
    const middle: Project = { ...project, id: "M", title: "Heating", parentProjectId: "R" };
    const leaf: Project = { ...project, id: "L", title: "Boiler", parentProjectId: "M" };
    const byId = new Map([root, middle, leaf, project].map((item) => [item.id, item]));
    const inProject = (id: string, projectId?: string): Action => ({ ...actions[2]!, id, ...(projectId ? { projectId } : {}) });
    const candidates = [inProject("A-root", "R"), inProject("A-middle", "M"), inProject("A-leaf", "L"), inProject("A-other", "P1"), inProject("A-none")];
    const underMiddle = candidates.filter((action) =>
      matchesFilter(action, { kind: "value", field: "project", operator: "in", values: ["M"] }, "2026-09-18", byId));
    expect(underMiddle.map((action) => action.id)).toEqual(["A-middle", "A-leaf"]);
    const notUnderRoot = candidates.filter((action) =>
      matchesFilter(action, { kind: "value", field: "project", operator: "notIn", values: ["R"] }, "2026-09-18", byId));
    expect(notUnderRoot.map((action) => action.id)).toEqual(["A-other", "A-none"]);
  });

  it("accepts only the low, medium and high energy levels, in any casing", () => {
    const withEnergy = (energy: unknown) => parseAction({ id: "A-energy", title: "Tidy desk", status: "next", created: "2026-09-19", energy }, file("Energy.md"));
    expect(withEnergy("low").energy).toBe("low");
    expect(withEnergy(" High ").energy).toBe("high");
    expect(parseAction({ id: "A-none", title: "Tidy desk", status: "next", created: "2026-09-19" }, file("None.md")).energy).toBeUndefined();
    expect(() => withEnergy("exhausted")).toThrow("Invalid 'energy'");
  });

  it("reads an integer Action priority from frontmatter", () => {
    expect(parseAction({ id: "A-priority", title: "First", status: "next", created: "2026-09-19", priority: 1_000 }, file("Priority.md")).priority)
      .toBe(1_000);
    expect(() => parseAction({ id: "A-bad-priority", title: "Broken", status: "next", created: "2026-09-19", priority: 1.5 }, file("Broken.md")))
      .toThrow("Invalid 'priority'");
  });

  it("reads and normalizes scheduled Action timing", () => {
    const parsed = parseAction({
      id: "A10",
      title: "Plan the sprint",
      status: "scheduled",
      created: "2026-09-19",
      scheduled_start: "2026-09-20T14:00:00+02:00",
      duration_minutes: 45,
    }, file("A10.md"));
    expect(parsed.scheduledStart).toBe("2026-09-20T12:00:00.000Z");
    expect(parsed.durationMinutes).toBe(45);
    expect(() => parseAction({
      id: "A11",
      title: "Broken schedule",
      status: "scheduled",
      created: "2026-09-19",
      scheduled_start: "not-a-date",
      duration_minutes: 0,
    }, file("A11.md"))).toThrow("scheduled_start");
    expect(() => parseAction({
      id: "A12",
      title: "Ambiguous local schedule",
      status: "scheduled",
      created: "2026-09-19",
      scheduled_start: "2026-09-20T14:00",
      duration_minutes: 30,
    }, file("A12.md"))).toThrow("scheduled_start");
  });

  it("keeps legacy Scheduled Actions without timing readable", () => {
    const parsed = parseAction({
      id: "A13",
      title: "Legacy calendar item",
      status: "scheduled",
      created: "2026-09-19",
    }, file("A13.md"));
    expect(parsed.scheduledStart).toBeUndefined();
    expect(parsed.durationMinutes).toBeUndefined();
  });
});
