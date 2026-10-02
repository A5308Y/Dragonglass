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
  agentRuntime,
  codeRunConversation,
  codeTaskBrief,
  codeTaskIdentifier,
  reviewActionTitle,
  localHarness,
  localHarnessService,
  runReportInboxItem,
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

  it("tells a new run about an earlier attempt, and keeps its own instructions recoverable", () => {
    const brief = delegationBrief({
      breadcrumb: "Kitchen",
      desiredOutcome: "Done.",
      instructions: "Compare suppliers.",
      projects: [project("K", "Kitchen")],
      actionCount: 0,
      linkedFileCount: 0,
      earlierAttempt: {
        statusText: "Stopped at its turn limit",
        resultsFolder: "Projects/Kitchen/Agent runs/2026-09-26 1400 Kitchen",
        activity: [
          { at: "", kind: "thought", text: "Two suppliers left." },
          { at: "", kind: "tool", text: "write_file suppliers.md" },
        ],
      },
    });
    expect(brief).toContain("that run ended as: Stopped at its turn limit.");
    expect(brief).toContain("`material/Projects/Kitchen/Agent runs/2026-09-26 1400 Kitchen/`");
    expect(brief).toContain("- Thought: Two suppliers left.\n- Tool: write_file suppliers.md");
    // Running again from this run must not pick up the earlier-attempt text as instructions.
    expect(briefInstructions(brief)).toBe("Compare suppliers.");
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

describe("Reporting a run to the Inbox", () => {
  const base = {
    projectTitle: "Kitchen",
    projectPath: "GTD/Projects/Kitchen.md",
    spent: "about $0.42 of $5.00",
    resultsFolder: "Projects/Kitchen/Agent runs/2026-09-26 1400 Kitchen",
    hasReport: true,
  };

  it("links a finished run's report and quotes its start, escaped", () => {
    const { title, body } = runReportInboxItem({
      ...base,
      status: "finished",
      statusText: "Finished",
      reportExcerpt: "---\ntags: x\n---\n# Suppliers\n\nSee [[Secret plan]] #urgent\n- first",
    });
    expect(title).toBe("Agent report: Kitchen");
    expect(body).toContain("The agent working on [[GTD/Projects/Kitchen|Kitchen]] ended: Finished.");
    expect(body).toContain("[[Projects/Kitchen/Agent runs/2026-09-26 1400 Kitchen/REPORT|the report]]");
    expect(body).toContain("> # Suppliers");
    expect(body).toContain("> See \\[\\[Secret plan\\]\\] \\#urgent");
    expect(body).not.toContain("tags: x");
    expect(body).not.toContain("Run again");
  });

  it("says when a run ended without finishing, and how to try again", () => {
    const { title, body } = runReportInboxItem({
      ...base,
      status: "failed",
      statusText: "Stopped at its turn limit",
      resultsFolder: "",
      hasReport: false,
      reportExcerpt: "",
    });
    expect(title).toBe("Agent run ended: Kitchen");
    expect(body).toContain("ended: Stopped at its turn limit.");
    expect(body).toContain("It left no results.");
    expect(body).toContain("“Run again…”");
    expect(body).not.toContain("## Report");
  });
});

describe("Local harnesses", () => {
  it("maps each harness to its container, and anything unknown to Dragonglass's own loop", () => {
    expect(localHarnessService(localHarness("smolagents"))).toBe("agent-smol");
    expect(localHarnessService(localHarness("qwen-agent"))).toBe("agent-qwen");
    expect(localHarnessService(localHarness("loop"))).toBe("agent-local");
    expect(localHarnessService(localHarness(undefined))).toBe("agent-local");
  });
});

describe("Agent runtimes", () => {
  it("reads Codex and local runs back, and older runs without a runtime as Claude", () => {
    expect(agentRuntime("codex")).toBe("codex");
    expect(agentRuntime("local")).toBe("local");
    expect(agentRuntime("lamdera")).toBe("lamdera");
    expect(agentRuntime(undefined)).toBe("claude");
    expect(agentRuntime("gpt")).toBe("claude");
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
    expect(agentRunStatus(run({ queued: true }), false)).toBe("queued");
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
    expect(agentRunStatusText(run({ resultSubtype: "error_repeating" }), "failed")).toBe("Stopped: it kept repeating the same step");
    expect(agentRunStatusText(run({ resultSubtype: "error_during_execution", resultError: "PermissionError: 'workspace'" }), "failed"))
      .toBe("Failed: PermissionError: 'workspace'");
    expect(agentRunStatusText(run({ runnerError: "ModuleNotFoundError: No module named 'numpy'" }), "interrupted"))
      .toBe("Ended without a result: ModuleNotFoundError: No module named 'numpy'");
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

describe("Code runs", () => {
  const run = (changes: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
    id: "r",
    projectId: "K",
    projectTitle: "Kitchen",
    createdAt: "2026-09-26T07:00:00Z",
    budgetUsd: 0,
    model: "Codex default",
    runtime: "lamdera",
    offline: false,
    wholeVault: false,
    costUsd: 0,
    openQuestions: [],
    ...changes,
  });

  it("names a Project's task the same way every time, short enough for a Lamdera preview", () => {
    expect(codeTaskIdentifier("01K6ABCDEF0123456789XYZWVU")).toBe("DG-XYZWVU");
    expect(codeTaskIdentifier("01K6ABCDEF0123456789XYZWVU")).toBe(codeTaskIdentifier("01K6ABCDEF0123456789XYZWVU"));
    expect(codeTaskIdentifier("p-1")).toMatch(/^DG-[A-Z0-9]{6}$/);
    expect(codeTaskIdentifier("p-1")).not.toBe(codeTaskIdentifier("p-2"));
  });

  it("briefs the coding agent with the Project's own words only", () => {
    const brief = codeTaskBrief({
      breadcrumb: "Habits › Dark mode",
      desiredOutcome: "The app follows the system theme.",
      projectNote: "---\ntype: gtd-project\nid: X\n---\nUsers asked for it.\n",
      openActions: ["Check the colours"],
      instructions: "Add a dark theme.",
    });
    expect(brief).toContain("## What to implement\n\nAdd a dark theme.");
    expect(brief).toContain("- Check the colours");
    expect(brief).toContain("## The Project note\n\nUsers asked for it.");
    expect(brief).not.toContain("gtd-project");
    expect(codeTaskBrief({ breadcrumb: "A", desiredOutcome: "", projectNote: "", openActions: [], instructions: "Do it." }))
      .not.toContain("## Open Actions");
  });

  it("turns earlier runs into the transcript a follow-up continues, oldest first", () => {
    expect(codeRunConversation([
      { createdAt: "2026-10-02T10:00:00Z", instructions: "Make the button blue.", report: "" },
      { createdAt: "2026-10-01T10:00:00Z", instructions: "Add a button.", report: "Ready for review." },
    ])).toBe("User (2026-10-01T10:00:00Z): Add a button.\nAgent: Ready for review.\n\nUser (2026-10-02T10:00:00Z): Make the button blue.");
    expect(codeRunConversation([])).toBe("");
  });

  it("titles the review Action after the task", () => {
    expect(reviewActionTitle("Add a dark theme.\nWith a toggle.")).toBe("Review PR: Add a dark theme.");
  });

  it("says why a code run stopped", () => {
    expect(agentRunStatusText(run({ resultSubtype: "error_validation" }), "failed")).toContain("lamdera check --force");
    expect(agentRunStatusText(run({ resultSubtype: "error_merge" }), "failed")).toContain("manual merge");
    expect(agentRunStatusText(run({ resultSubtype: "usage_limited" }), "failed")).toBe("Stopped at Codex's usage limit");
    expect(agentRunStatusText(run({ resultSubtype: "usage_limited", retryAt: "2026-10-02T12:00:00Z" }), "failed"))
      .toMatch(/^Stopped at Codex's usage limit: start it again after 2026-10-0\d \d\d:\d\d$/);
    expect(agentRunStatusText(run({ queued: true }), "queued")).toBe("Queued: it starts when the code run before it ends");
    expect(agentRunStatusText(run({ queued: true, runtime: "codex" }), "queued")).toBe("Queued: it starts when the Codex run before it ends");
  });
});
