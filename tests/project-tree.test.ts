import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Project } from "../src/domain/types";
import {
  ancestorsToActivate,
  finishedAncestors,
  projectDescendants,
  statusChangeProblem,
  strandedProjects,
} from "../src/domain/project-tree";

const file = { path: "Project.md" } as TFile;
const project = (id: string, title: string, changes: Partial<Project> = {}): Project => ({
  type: "gtd-project",
  id,
  title,
  status: "active",
  created: "2026-09-26",
  file,
  ...changes,
});
const byId = (projects: readonly Project[]) => new Map(projects.map((item) => [item.id, item]));

describe("Project tree rule", () => {
  const root = project("R", "Renovation", { status: "someday" });
  const middle = project("M", "Kitchen", { parentProjectId: root.id, status: "backlog" });
  const leaf = project("L", "Order tiles", { parentProjectId: middle.id, status: "backlog" });
  const tree = [root, middle, leaf];

  it("activates every inactive Project above, topmost first", () => {
    expect(ancestorsToActivate(leaf.parentProjectId, byId(tree)).map((item) => item.id)).toEqual(["R", "M"]);
    expect(ancestorsToActivate(undefined, byId(tree))).toEqual([]);
    const activeRoot = [{ ...root, status: "active" as const }, middle, leaf];
    expect(ancestorsToActivate(leaf.parentProjectId, byId(activeRoot)).map((item) => item.id)).toEqual(["M"]);
  });

  it("singles out finished parents, which need a deliberate reopen", () => {
    const finished = [{ ...root, status: "completed" as const }, middle, leaf];
    expect(finishedAncestors(leaf.parentProjectId, byId(finished)).map((item) => item.id)).toEqual(["R"]);
    expect(finishedAncestors(leaf.parentProjectId, byId(tree))).toEqual([]);
  });

  it("stops at a cycle", () => {
    const a = project("A", "A", { parentProjectId: "B", status: "backlog" });
    const b = project("B", "B", { parentProjectId: "A", status: "backlog" });
    expect(ancestorsToActivate("A", byId([a, b])).map((item) => item.id)).toEqual(["B", "A"]);
    expect(projectDescendants("A", [a, b]).map((item) => item.id)).toEqual(["B"]);
  });

  it("refuses to park or cancel a Project with Active sub-projects at any depth", () => {
    const parent = project("P", "Parent");
    const child = project("C", "Child", { parentProjectId: parent.id, status: "backlog" });
    const grandchild = project("G", "Grandchild", { parentProjectId: child.id });
    const projects = [parent, child, grandchild];
    expect(statusChangeProblem(parent, "someday", projects)).toContain("Grandchild (Active)");
    expect(statusChangeProblem(parent, "backlog", projects)).toContain("cannot be moved to Backlog");
    expect(statusChangeProblem(parent, "cancelled", projects)).toContain("cannot be cancelled");
    expect(statusChangeProblem(parent, "someday", [parent, child])).toBeUndefined();
    expect(statusChangeProblem(parent, "active", projects)).toBeUndefined();
  });

  it("blocks completion while a sub-project is Active or in the Backlog", () => {
    const parent = project("P", "Parent");
    const backlog = project("B", "Later", { parentProjectId: parent.id, status: "backlog" });
    const someday = project("S", "Maybe", { parentProjectId: parent.id, status: "someday" });
    const done = project("D", "Done", { parentProjectId: parent.id, status: "completed" });
    expect(statusChangeProblem(parent, "completed", [parent, backlog, someday, done])).toContain("Later (Backlog)");
    expect(statusChangeProblem(parent, "completed", [parent, someday, done])).toBeUndefined();
  });

  it("finds Active Projects stranded below an inactive one", () => {
    const parent = project("P", "Parent", { status: "someday" });
    const child = project("C", "Child", { parentProjectId: parent.id });
    const grandchild = project("G", "Grandchild", { parentProjectId: child.id });
    expect(strandedProjects([parent, child, grandchild]).map((entry) => [entry.project.id, entry.inactiveAncestor.id]))
      .toEqual([["C", "P"], ["G", "P"]]);
    expect(strandedProjects([{ ...parent, status: "active" }, child, grandchild])).toEqual([]);
  });
});
