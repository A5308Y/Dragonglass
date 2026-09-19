import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Project } from "../src/domain/types";
import {
  activeProjectBlockers,
  normalizeProjectTags,
  projectPlacementsAfterMove,
  wouldCreateProjectDependencyCycle,
} from "../src/domain/project-board";

const file = { path: "Project.md" } as TFile;
const project = (id: string, title: string, changes: Partial<Project> = {}): Project => ({
  type: "gtd-project",
  id,
  title,
  status: "active",
  created: "2026-09-19",
  file,
  ...changes,
});

describe("Sub-project board metadata", () => {
  it("normalizes custom tags", () => {
    expect(normalizeProjectTags([" #Home ", "planning", "home", ""])).toEqual(["Home", "planning"]);
  });

  it("re-ranks a whole column when moving a card", () => {
    const projects = [
      project("A", "A", { order: 1_000 }),
      project("B", "B", { order: 1_000 }),
      project("C", "C", { order: 1_000 }),
    ];

    expect([...projectPlacementsAfterMove(projects, "C", "active", "A")]).toEqual([
      ["C", { status: "active", order: 1_000 }],
      ["A", { status: "active", order: 2_000 }],
      ["B", { status: "active", order: 3_000 }],
    ]);
  });

  it("re-ranks both columns when moving between statuses", () => {
    const projects = [
      project("A", "A", { order: 1_000 }),
      project("B", "B", { order: 2_000 }),
      project("C", "C", { status: "backlog", order: 1_000 }),
    ];

    expect([...projectPlacementsAfterMove(projects, "B", "backlog", "C")]).toEqual([
      ["B", { status: "backlog", order: 1_000 }],
      ["C", { status: "backlog", order: 2_000 }],
      ["A", { status: "active", order: 1_000 }],
    ]);
  });

  it("rejects dependency cycles and ignores completed blockers", () => {
    const first = project("A", "First", { blockedByProjectIds: ["B"] });
    const second = project("B", "Second");
    const completed = project("C", "Complete", { status: "completed" });
    const byId = new Map([[first.id, first], [second.id, second], [completed.id, completed]]);

    expect(wouldCreateProjectDependencyCycle("B", ["A"], byId)).toBe(true);
    expect(activeProjectBlockers({ ...first, blockedByProjectIds: ["B", "C"] }, byId)).toEqual([second]);
  });
});
