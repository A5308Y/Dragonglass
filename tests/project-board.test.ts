import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Project } from "../src/domain/types";
import {
  activeProjectBlockers,
  normalizeProjectTags,
  priorityOrderBefore,
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

  it("calculates stable priority positions before and after cards", () => {
    const projects = [project("A", "A", { order: 1_000 }), project("B", "B", { order: 2_000 })];
    expect(priorityOrderBefore(projects, "A")).toBe(0);
    expect(priorityOrderBefore(projects, "B")).toBe(1_500);
    expect(priorityOrderBefore(projects)).toBe(3_000);
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
