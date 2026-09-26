import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Action, Project } from "../src/domain/types";
import {
  agentActionTitle,
  agentCosts,
  agentQuestionTitle,
  agentRunStatus,
  agentRunStatusText,
  briefInstructions,
  withoutEntityFrontmatter,
  delegationBrief,
  delegationScope,
  resultsFolderName,
  runFolderName,
  type AgentRunRecord,
} from "../src/domain/delegation";

const file = (path: string) => ({ path }) as TFile;
const project = (id: string, title: string, changes: Partial<Project> = {}): Project => ({
  type: "gtd-project",
  id,
  title,
  status: "active",
  created: "2026-09-26",
  file: file(`GTD/Projects/${title}.md`),
  ...changes,
});
const action = (id: string, projectId?: string): Action => ({
  type: "gtd-action",
  id,
  title: id,
  status: "next",
  created: "2026-09-26",
  file: file(`GTD/Actions/${id}.md`),
  ...(projectId ? { projectId } : {}),
});

describe("Delegation scope", () => {
  const house = project("H", "House", { supportPath: "Projects/House" });
  const kitchen = project("K", "Kitchen", {
    parentProjectId: "H",
    supportPath: "Projects/House/Kitchen",
    linkedFiles: ["[[Floor plan]]"],
  });
  const tiles = project("T", "Tiles", { parentProjectId: "K", supportPath: "Projects/House/Kitchen/Tiles", linkedFiles: ["[[Supplier list]]"] });
  const garden = project("G", "Garden", { parentProjectId: "H", supportPath: "Projects/House/Garden" });
  const elsewhere = project("E", "Elsewhere", { supportPath: "Projects/Kitchen extra" });
  const projects = [house, kitchen, tiles, garden, elsewhere];
  const actions = [action("a1", "K"), action("a2", "T"), action("a3", "G"), action("a4")];

  it("covers the Project and everything below it, and nothing beside or above it", () => {
    const scope = delegationScope("K", projects, actions);
    expect(scope.projects.map((item) => item.id)).toEqual(["K", "T"]);
    expect(scope.actions.map((item) => item.id)).toEqual(["a1", "a2"]);
  });

  it("copies nested Project Material through its outermost folder, and no lookalike path", () => {
    expect(delegationScope("K", projects, actions).supportPaths).toEqual(["Projects/House/Kitchen"]);
    expect(delegationScope("H", projects, actions).supportPaths).toEqual(["Projects/House"]);
  });

  it("takes every Project's linked files, one hop", () => {
    expect(delegationScope("K", projects, actions).linkedFiles).toEqual([
      { projectId: "K", link: "[[Floor plan]]" },
      { projectId: "T", link: "[[Supplier list]]" },
    ]);
  });

  it("refuses a Project that no longer exists", () => {
    expect(() => delegationScope("missing", projects, actions)).toThrow("no longer exists");
  });
});

describe("Delegation brief", () => {
  it("names the Project first, and lists what the material holds", () => {
    const brief = delegationBrief({
      breadcrumb: "House > Kitchen",
      desiredOutcome: "",
      instructions: "Compare three tile suppliers.",
      projects: [project("K", "Kitchen"), project("T", "Tiles", { status: "backlog" })],
      actionCount: 1,
      linkedFileCount: 2,
    });
    expect(brief).toMatch(/^# Brief\n\n## Project\n\nHouse > Kitchen\n/);
    expect(brief).toContain("(No desired outcome has been written down yet.)");
    expect(brief).toContain("Compare three tile suppliers.");
    expect(brief).toContain("1 Action, their Project Material and 2 linked files");
    expect(brief).toContain("- Tiles (Backlog): `material/GTD/Projects/Tiles.md`");
  });

  it("gives back the instructions a brief was written from", () => {
    const brief = delegationBrief({
      breadcrumb: "Kitchen",
      desiredOutcome: "Done.",
      instructions: "Compare suppliers.\n\n## Not a heading of the brief? It is, but only at line start.",
      projects: [project("K", "Kitchen")],
      actionCount: 0,
      linkedFileCount: 0,
    });
    expect(briefInstructions(brief)).toBe("Compare suppliers.");
    expect(briefInstructions("# Brief\n\n## What I'd like from you\n\nOnly this.\n")).toBe("Only this.");
    expect(briefInstructions("no sections")).toBe("");
  });

  it("says when the material is the whole vault, and still names the Project's own notes", () => {
    const brief = delegationBrief({
      wholeVault: true,
      breadcrumb: "Kitchen",
      desiredOutcome: "Done.",
      instructions: "Find related notes.",
      projects: [project("K", "Kitchen")],
      actionCount: 2,
      linkedFileCount: 0,
    });
    expect(brief).toContain("holds a copy of the whole vault");
    expect(brief).toContain("- Kitchen (Active): `material/GTD/Projects/Kitchen.md`");
  });
});

describe("The Waiting Action", () => {
  it("says what the agent does, from the first line of the instructions", () => {
    expect(agentActionTitle("\n  Compare three   tile suppliers.\nThen draft an order.")).toBe("Agent: Compare three tile suppliers.");
    expect(agentActionTitle("   ")).toBe("Agent: delegated work");
  });

  it("says what the agent asks while it waits, shortened for a card", () => {
    expect(agentQuestionTitle("Which budget?")).toBe("Agent asks: Which budget?");
    const long = agentQuestionTitle("x".repeat(100));
    expect(long).toHaveLength("Agent asks: ".length + 70);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("Importing an agent's notes", () => {
  it("turns a copied Project note into an ordinary note, keeping other frontmatter", () => {
    const copy = [
      "---",
      "type: gtd-project",
      "id: 01ABC",
      "title: Kitchen brainstorm",
      "status: active",
      "parent_project_id: 01PARENT",
      "parent_project: \"[[House]]\"",
      "blocked_by_project_ids:",
      "  - 01X",
      "  - 01Y",
      "tags:",
      "  - ideas",
      "---",
      "# Kitchen brainstorm",
      "",
    ].join("\n");
    const { text, changed } = withoutEntityFrontmatter(copy);
    expect(changed).toBe(true);
    expect(text).toBe(["---", "title: Kitchen brainstorm", "status: active", "tags:", "  - ideas", "---", "# Kitchen brainstorm", ""].join("\n"));
  });

  it("drops the frontmatter block when nothing else is left", () => {
    expect(withoutEntityFrontmatter("---\ntype: gtd-action\nid: 1\nproject_id: 2\n---\nBody\n").text).toBe("Body\n");
  });

  it("leaves ordinary notes alone", () => {
    const note = "---\ntype: meeting\nid: 7\n---\nText";
    expect(withoutEntityFrontmatter(note)).toEqual({ text: note, changed: false });
    expect(withoutEntityFrontmatter("No frontmatter")).toEqual({ text: "No frontmatter", changed: false });
  });
});

describe("Run folders", () => {
  it("name runs so they sort by time and read by Project", () => {
    expect(runFolderName(new Date("2026-09-26T07:14:05Z"), "Küche & Bad!")).toBe("2026-09-26-071405-kuche-bad");
    expect(runFolderName(new Date("2026-09-26T07:14:05Z"), "???")).toBe("2026-09-26-071405-project");
  });

  it("name results folders without characters a vault path cannot hold", () => {
    const name = resultsFolderName(new Date(2026, 8, 26, 9, 5), "Tiles: A/B #1");
    expect(name).toBe("2026-09-26 0905 Tiles A B 1");
  });
});

describe("Run status and costs", () => {
  const run = (changes: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
    id: "r",
    projectId: "K",
    projectTitle: "Kitchen",
    createdAt: "2026-09-26T07:00:00Z",
    budgetUsd: 5,
    model: "claude-opus-5-5",
    runtime: "claude",
    offline: false,
    wholeVault: false,
    costUsd: null,
    openQuestions: [],
    ...changes,
  });

  it("reads a run's state from whether it runs and what the runner reported", () => {
    expect(agentRunStatus(run({ starting: true }), false)).toBe("starting");
    expect(agentRunStatus(run(), true)).toBe("running");
    expect(agentRunStatus(run({ openQuestions: [{ id: "q", question: "?", askedAt: "" }] }), true)).toBe("waiting");
    expect(agentRunStatus(run({ resultSubtype: "success" }), false)).toBe("finished");
    expect(agentRunStatus(run({ resultSubtype: "interrupted" }), false)).toBe("stopped");
    expect(agentRunStatus(run({ resultSubtype: "error_max_budget_usd" }), false)).toBe("failed");
    expect(agentRunStatus(run({ startError: "Docker is not running" }), false)).toBe("failed");
    expect(agentRunStatus(run(), false)).toBe("interrupted");
  });

  it("says why a run failed", () => {
    expect(agentRunStatusText(run({ resultSubtype: "error_max_budget_usd" }), "failed")).toBe("Stopped at its budget");
    expect(agentRunStatusText(run({ startError: "Docker is not running" }), "failed")).toBe("Could not start: Docker is not running");
    expect(agentRunStatusText(run({ resultSubtype: "error_max_time" }), "failed")).toBe("Stopped at its time limit");
  });

  it("adds up costs per Project and per tree", () => {
    const projects = [project("H", "House"), project("K", "Kitchen", { parentProjectId: "H" }), project("G", "Garden", { parentProjectId: "H" })];
    const costs = agentCosts([
      run({ projectId: "K", costUsd: 1.5 }),
      run({ projectId: "K", costUsd: 0.25 }),
      run({ projectId: "H", costUsd: 1 }),
      run({ projectId: "G", costUsd: null }),
    ], projects);
    expect(costs.get("K")).toEqual({ own: 1.75, tree: 1.75 });
    expect(costs.get("H")).toEqual({ own: 1, tree: 2.75 });
    expect(costs.has("G")).toBe(false);
  });
});
