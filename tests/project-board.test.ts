import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Project } from "../src/domain/types";
import {
  activeProjectBlockers,
  isProjectSupportMaterialPath,
  normalizeProjectTags,
  planProjectCompletion,
  planProjectDeletion,
  planProjectParentChange,
  projectPlacementsAfterMove,
  projectActionIssue,
  projectSupportFileCounts,
  projectSupportFiles,
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
  it("reports the same Action-health issues shown on Active Project cards", () => {
    const active = project("A", "Active");
    const action = (status: "next" | "waiting" | "scheduled" | "done" | "cancelled", projectId = active.id) => ({
      type: "gtd-action" as const,
      id: status,
      title: status,
      status,
      projectId,
      context: "computer",
      created: "2026-09-19",
      file,
    });

    expect(projectActionIssue(active, [active], [])).toBe("No open Actions");
    expect(projectActionIssue(active, [active], [action("done")])).toBe("No open Actions");
    expect(projectActionIssue(active, [active], [action("next")])).toBeNull();
    expect(projectActionIssue(active, [active], [action("scheduled")])).toBeNull();
    expect(projectActionIssue(active, [active], [action("waiting")])).toBeNull();
    expect(projectActionIssue({ ...active, status: "someday" }, [active], [])).toBeNull();
  });

  it("uses the Project Review gate for parent Projects", () => {
    const parent = project("P", "Parent");
    const child = project("C", "Child", { parentProjectId: parent.id });
    const inactiveChild = project("I", "Inactive", { parentProjectId: parent.id, status: "backlog" });
    const action = (id: string, projectId: string, status: "next" | "waiting") => ({
      type: "gtd-action" as const,
      id,
      title: id,
      status,
      projectId,
      context: "computer",
      created: "2026-09-19",
      file,
    });
    const projects = [parent, child, inactiveChild];

    expect(projectActionIssue(parent, projects, [action("A1", child.id, "next")])).toBeNull();
    expect(projectActionIssue(parent, projects, [])).toBe("No open Actions in sub-project: Child");
    expect(projectActionIssue(parent, projects, [action("A1", child.id, "waiting")])).toBeNull();
    expect(projectActionIssue(parent, projects, [action("A1", parent.id, "next")])).toBe("No open Actions in sub-project: Child");
    expect(projectActionIssue(child, projects, [])).toBe("No open Actions");

    const grandchild = project("G", "Grandchild", { parentProjectId: child.id });
    const tree = [...projects, grandchild];
    expect(projectActionIssue(parent, tree, [action("A1", grandchild.id, "next")])).toBeNull();
    expect(projectActionIssue(child, tree, [action("A1", grandchild.id, "next")])).toBeNull();
    expect(projectActionIssue(parent, tree, [action("A1", child.id, "next")])).toBe("No open Actions in sub-project: Grandchild");
  });

  it("ignores everything below a sub-project that is not Active", () => {
    const parent = project("P", "Parent");
    const parked = project("B", "Parked", { parentProjectId: parent.id, status: "backlog" });
    // Active below a Backlog Project breaks the tree rule; it counts as parked.
    const stranded = project("H", "Stranded", { parentProjectId: parked.id });
    const other = project("O", "Other", { parentProjectId: parent.id });
    const tree = [parent, parked, stranded, other];

    expect(projectActionIssue(parked, tree, [])).toBeNull();
    expect(projectActionIssue(stranded, tree, [])).toBeNull();
    expect(projectActionIssue(parent, tree, [])).toBe("No open Actions in sub-project: Other");
    expect(projectActionIssue(parent, [parent, parked, stranded], [])).toBe("No open Actions");
  });

  it("normalizes custom tags", () => {
    expect(normalizeProjectTags([" #Home ", "planning", "home", ""])).toEqual(["Home", "planning"]);
  });

  it("rewrites only the moved card when its new neighbours leave room", () => {
    const projects = [
      project("A", "A", { order: 1_000 }),
      project("B", "B", { order: 2_000 }),
      project("C", "C", { order: 3_000 }),
    ];

    expect([...projectPlacementsAfterMove(projects, "C", "active", "B")]).toEqual([
      ["C", { status: "active", order: 1_500 }],
    ]);
    expect([...projectPlacementsAfterMove(projects, "A", "active")]).toEqual([
      ["A", { status: "active", order: 4_000 }],
    ]);
  });

  it("orders cards that share a rank by writing the fewest", () => {
    const projects = [
      project("A", "A", { order: 1_000 }),
      project("B", "B", { order: 1_000 }),
      project("C", "C", { order: 1_000 }),
    ];

    expect([...projectPlacementsAfterMove(projects, "C", "active", "A")]).toEqual([
      ["C", { status: "active", order: -1_000 }],
      ["A", { status: "active", order: 0 }],
    ]);
  });

  it("leaves the source column alone when moving between statuses", () => {
    const projects = [
      project("A", "A", { order: 1_000 }),
      project("B", "B", { order: 2_000 }),
      project("C", "C", { status: "backlog", order: 1_000 }),
    ];

    expect([...projectPlacementsAfterMove(projects, "B", "backlog", "C")]).toEqual([
      ["B", { status: "backlog", order: 0 }],
    ]);
    expect([...projectPlacementsAfterMove(projects, "A", "backlog")]).toEqual([
      ["A", { status: "backlog", order: 2_000 }],
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
  it("recognizes ordinary folders and nested sub-project material in the full detail subtree", () => {
    expect(isProjectSupportMaterialPath("Support/Alpha/Archive", "Support/Alpha")).toBe(true);
    expect(isProjectSupportMaterialPath("Support/Alpha/Sub-project/Notes.md", "Support/Alpha")).toBe(true);
    expect(isProjectSupportMaterialPath("Support/Alpha", "Support/Alpha")).toBe(false);
    expect(isProjectSupportMaterialPath("Support/Alphabet/Decoy.md", "Support/Alpha")).toBe(false);
  });

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

  it("lists each file under the Project that owns it most deeply", () => {
    const files = projectSupportFiles(folders, [
      "Support/Alpha/Brief.md",
      "Support/Alpha/Beta/Notes.md",
      "Support/Alpha/Beta/Deeper/Scan.pdf",
      "Elsewhere/Unrelated.md",
      "Support/Alphabet/Decoy.md",
    ]);

    expect(files.get("A")).toEqual(["Support/Alpha/Brief.md"]);
    expect(files.get("B")).toEqual(["Support/Alpha/Beta/Notes.md", "Support/Alpha/Beta/Deeper/Scan.pdf"]);
    expect(files.get("C")).toEqual([]);
  });

  it("counts a file for every Project sharing the same support folder", () => {
    const shared = [{ id: "A", path: "Support/Alpha" }, { id: "B", path: "Support/Alpha" }];

    expect([...projectSupportFileCounts(shared, ["Support/Alpha/Brief.md"])]).toEqual([["A", 1], ["B", 1]]);
  });

  it("returns nothing when no Project has a support folder", () => {
    expect([...projectSupportFileCounts([], ["Support/Alpha/Brief.md"])]).toEqual([]);
  });
});

describe("Completing a Project", () => {
  const parent = project("P", "Parent");
  const child = (id: string, status: Project["status"], order?: number) =>
    project(id, id, { parentProjectId: parent.id, status, ...(order === undefined ? {} : { order }) });

  it("separates planned sub-projects from optional ones", () => {
    const projects = [
      parent,
      child("A", "active"),
      child("B2", "backlog", 2_000),
      child("B1", "backlog", 1_000),
      child("S", "someday"),
      child("C", "completed"),
      child("X", "cancelled"),
      project("G", "Grandchild", { parentProjectId: "A", status: "backlog" }),
    ];
    const plan = planProjectCompletion(parent.id, projects);
    expect(plan.unfinished.map((item) => item.id)).toEqual(["B1", "B2", "A"]);
    expect(plan.optional.map((item) => item.id)).toEqual(["S"]);
  });

  it("has nothing to report for a Project without open sub-projects", () => {
    expect(planProjectCompletion(parent.id, [parent, child("C", "completed")])).toEqual({ unfinished: [], optional: [] });
  });
});
