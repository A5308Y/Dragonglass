import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Project } from "../src/domain/types";
import {
  activeProjectBlockers,
  normalizeProjectTags,
  planProjectDeletion,
  planProjectParentChange,
  projectPlacementsAfterMove,
  projectSupportFileCounts,
  projectTagAdditions,
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

describe("Batch Project edits", () => {
  it("adds tags without disturbing the ones a Project already carries", () => {
    const untagged = project("A", "A");
    const tagged = project("B", "B", { tags: ["planning"] });
    const complete = project("C", "C", { tags: ["Home", "planning"] });

    const { updates, unchanged } = projectTagAdditions([untagged, tagged, complete], [" #home "]);

    expect([...updates]).toEqual([["A", ["home"]], ["B", ["home", "planning"]]]);
    expect(unchanged).toEqual(["C"]);
  });

  it("splits a parent change into moves, no-ops, and cycles", () => {
    const root = project("A", "A");
    const child = project("B", "B", { parentProjectId: "A" });
    const grandchild = project("C", "C", { parentProjectId: "B" });
    const outsider = project("D", "D");
    const byId = new Map([root, child, grandchild, outsider].map((candidate) => [candidate.id, candidate]));

    // Moving under B makes A an ancestor of its own ancestor, and B its own parent.
    expect(planProjectParentChange(["A", "B", "C", "D"], "B", byId)).toEqual({
      changing: ["D"],
      unchanged: ["C"],
      blocked: ["A", "B"],
    });
  });

  it("clears the parent of every selected Project", () => {
    const root = project("A", "A");
    const child = project("B", "B", { parentProjectId: "A" });
    const byId = new Map([root, child].map((candidate) => [candidate.id, candidate]));

    expect(planProjectParentChange(["A", "B"], "", byId)).toEqual({
      changing: ["B"],
      unchanged: ["A"],
      blocked: [],
    });
  });

  it("deletes sub-projects before their parents", () => {
    const projects = [
      project("A", "A"),
      project("B", "B", { parentProjectId: "A" }),
      project("C", "C", { parentProjectId: "B" }),
    ];

    expect(planProjectDeletion(["A", "B", "C"], projects)).toEqual({ order: ["C", "B", "A"], blocked: [] });
  });

  it("keeps Projects whose sub-projects stay behind", () => {
    const projects = [
      project("A", "A"),
      project("B", "B", { parentProjectId: "A" }),
      project("C", "C", { parentProjectId: "B" }),
      project("D", "D"),
    ];

    // B survives because C stays, and A survives in turn because B does.
    expect(planProjectDeletion(["A", "B", "D", "missing"], projects)).toEqual({
      order: ["D"],
      blocked: ["B", "A"],
    });
  });
});

describe("Project support material counts", () => {
  const folders = [
    { id: "A", path: "Support/Alpha" },
    { id: "B", path: "Support/Alpha/Beta" },
    { id: "C", path: "Support/Gamma" },
  ];

  it("credits the file to the deepest support folder that contains it", () => {
    const counts = projectSupportFileCounts(folders, [
      "Support/Alpha/Brief.md",
      "Support/Alpha/Beta/Notes.md",
      "Support/Alpha/Beta/Deeper/Scan.pdf",
      "Support/Gamma/Plan.md",
      "Elsewhere/Unrelated.md",
      "Support/Alphabet/Decoy.md",
    ]);

    expect([...counts]).toEqual([["A", 1], ["B", 2], ["C", 1]]);
  });

  it("counts a file for every Project sharing the same support folder", () => {
    const shared = [{ id: "A", path: "Support/Alpha" }, { id: "B", path: "Support/Alpha" }];

    expect([...projectSupportFileCounts(shared, ["Support/Alpha/Brief.md"])]).toEqual([["A", 1], ["B", 1]]);
  });

  it("returns nothing when no Project has a support folder", () => {
    expect([...projectSupportFileCounts([], ["Support/Alpha/Brief.md"])]).toEqual([]);
  });
});
