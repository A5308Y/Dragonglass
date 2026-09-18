import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { activeProjectsWithoutNextAction, projectReviewMembers, projectReviewQueue, projectsBlockingReview } from "../src/domain/project-review";
import type { Action, GtdSnapshot, Project } from "../src/domain/types";

const file = (path: string) => ({ path }) as TFile;
const root: Project = { type: "gtd-project", id: "P1", title: "Root", status: "active", created: "2026-09-01", file: file("Root.md") };
const child: Project = { type: "gtd-project", id: "P2", title: "Child", status: "active", created: "2026-09-01", file: file("Child.md"), parentProjectId: "P1" };
const grandchild: Project = { type: "gtd-project", id: "P3", title: "Grandchild", status: "backlog", created: "2026-09-01", file: file("Grandchild.md"), parentProjectId: "P2" };
const other: Project = { type: "gtd-project", id: "P4", title: "Other", status: "active", created: "2026-09-01", file: file("Other.md") };
const actions: Action[] = [
  { type: "gtd-action", id: "A1", title: "Root next", status: "next", projectId: "P1", created: "2026-09-01", file: file("A1.md") },
];

function snapshot(): GtdSnapshot {
  const projects = [root, child, grandchild, other];
  return {
    revision: 1,
    inboxItems: [],
    actions,
    projects,
    inboxItemsById: new Map(),
    actionsById: new Map(actions.map((action) => [action.id, action])),
    projectsById: new Map(projects.map((project) => [project.id, project])),
    issues: [],
  };
}

describe("combined Project Review", () => {
  it("reviews an active Project tree once", () => {
    expect(projectReviewQueue(snapshot(), "2026-09-18")).toEqual(["P4", "P1"]);
    expect(projectReviewMembers(root, snapshot().projects).map((project) => project.id)).toEqual(["P1", "P2", "P3"]);
  });

  it("keeps a partially reviewed hierarchy together", () => {
    const current = snapshot();
    current.projectsById = new Map([
      [root.id, { ...root, reviewed: "2026-09-18" }],
      [child.id, child],
      [grandchild.id, grandchild],
      [other.id, { ...other, reviewed: "2026-09-18" }],
    ]);
    current.projects = [...current.projectsById.values()];
    expect(projectReviewQueue(current, "2026-09-18")).toEqual(["P1"]);
  });

  it("requires a Next Action for each active Project, not backlog Projects", () => {
    expect(activeProjectsWithoutNextAction(projectReviewMembers(root, snapshot().projects), actions).map((project) => project.id)).toEqual(["P2"]);
  });
});

describe("Next Action gate for marking a tree reviewed", () => {
  const members = () => projectReviewMembers(root, snapshot().projects);
  const nextFor = (id: string, projectId: string): Action =>
    ({ type: "gtd-action", id, title: `${projectId} next`, status: "next", projectId, created: "2026-09-01", file: file(`${id}.md`) });

  it("still blocks on an active sub-project without a Next Action, even when the root has one", () => {
    expect(activeProjectsWithoutNextAction(members(), actions).map((project) => project.id)).toEqual(["P2"]);
    expect(projectsBlockingReview(root, members(), actions).map((project) => project.id)).toEqual(["P2"]);
  });

  it("lets the root carry no Next Action once every active sub-project has one", () => {
    expect(projectsBlockingReview(root, members(), [nextFor("A2", "P2")])).toEqual([]);
  });

  it("still requires a Next Action for a root with no active sub-projects", () => {
    expect(projectsBlockingReview(other, [other], []).map((project) => project.id)).toEqual(["P4"]);
  });

  it("names only the sub-projects when the root lacks one too", () => {
    expect(projectsBlockingReview(root, members(), []).map((project) => project.id)).toEqual(["P2"]);
  });

  it("ignores sub-projects that are not active", () => {
    expect(members().map((project) => project.id)).toEqual(["P1", "P2", "P3"]);
    expect(projectsBlockingReview(root, members(), [nextFor("A2", "P2")]).map((project) => project.id)).toEqual([]);
  });
});
