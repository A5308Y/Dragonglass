/**
 * Delegating a Project tree to an agent: what it gets to see, what it is told, and
 * how a run's state and cost read afterwards.
 *
 * The agent runs outside the vault on a copy (see `agent/README.md` for the sandbox).
 * It sees the delegated Project and every Project below it, their Actions, their
 * Project Material, and the files each of them lists in `linked_files`, one hop and
 * no further: a link inside a linked file does not widen the scope.
 */

import { projectDescendants, projectStatusLabel } from "./project-tree";
import type { Action, Project } from "./types";
import { normalizeVaultPath } from "../utils/path";

export interface DelegationScope {
  root: Project;
  /** The delegated Project first, then every Project below it. */
  projects: Project[];
  actions: Action[];
  /** Project Material folders, without those nested inside another one in the list. */
  supportPaths: string[];
  /** Each Project's `linked_files` entries, still to be resolved against the vault. */
  linkedFiles: Array<{ projectId: string; link: string }>;
}

export function delegationScope(rootId: string, projects: readonly Project[], actions: readonly Action[]): DelegationScope {
  const root = projects.find((project) => project.id === rootId);
  if (!root) throw new Error("This Project no longer exists.");
  const tree = [root, ...projectDescendants(root.id, projects)];
  const ids = new Set(tree.map((project) => project.id));
  const paths = [...new Set(tree.map((project) => normalizeVaultPath(project.supportPath ?? "")).filter(Boolean))].sort();
  return {
    root,
    projects: tree,
    actions: actions.filter((action) => action.projectId !== undefined && ids.has(action.projectId)),
    // A sub-project's material usually sits inside its parent's folder; copying the outer one covers it.
    supportPaths: paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`))),
    linkedFiles: tree.flatMap((project) => (project.linkedFiles ?? []).map((link) => ({ projectId: project.id, link }))),
  };
}

/** The folder, inside a run's input, that holds the copied vault files at their vault paths. */
export const MATERIAL_FOLDER = "material";

export interface BriefInput {
  /** Whether the material is the whole vault rather than this Project's tree. */
  wholeVault?: boolean;
  breadcrumb: string;
  desiredOutcome: string;
  instructions: string;
  projects: readonly Project[];
  actionCount: number;
  linkedFileCount: number;
}

/**
 * The brief the agent starts from. The first line under "## Project" names the
 * Project, which is also how a run started by hand is attributed its cost.
 */
export function delegationBrief(input: BriefInput): string {
  const projectLines = input.projects.map((project) =>
    `- ${project.title} (${projectStatusLabel(project.status)}): \`${MATERIAL_FOLDER}/${project.file.path}\``);
  return [
    "# Brief",
    "",
    "## Project",
    "",
    input.breadcrumb,
    "",
    "## Desired outcome",
    "",
    input.desiredOutcome.trim() || "(No desired outcome has been written down yet.)",
    "",
    "## What I'd like from you",
    "",
    input.instructions.trim(),
    "",
    "## The material",
    "",
    ...(input.wholeVault
      ? [
        `\`${MATERIAL_FOLDER}/\` holds a copy of the whole vault, at the files' paths in the vault, as reference:`,
        "use whatever helps. The task is about this Project; these are its notes and the Projects below it.",
        `Its ${plural(input.actionCount, "Action")} and its Project Material are in there too.`,
      ]
      : [
        `\`${MATERIAL_FOLDER}/\` holds copies of the vault files for this Project, at their paths in the vault:`,
        "the Project notes below, "
          + `${plural(input.actionCount, "Action")}, their Project Material and `
          + `${plural(input.linkedFileCount, "linked file")}. It is reference: change nothing there.`,
      ]),
    "",
    ...projectLines,
    "",
  ].join("\n");
}

/** A run folder's name: sortable, unique per second, readable. */
export function runFolderName(date: Date, title: string): string {
  const stamp = date.toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "");
  return `${stamp}-${slug(title)}`;
}

/** The Project Material folder a run's results are copied into, in local time. */
export function resultsFolderName(date: Date, title: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  const safeTitle = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim() || "Run";
  return `${day} ${time} ${safeTitle}`;
}

function slug(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project";
}

// THE WAITING ACTION

/**
 * While an agent works on a Project, the Project carries a Waiting Action, so it counts
 * as moving and the run shows on the Actions board and in reviews. Its title says what
 * the agent is doing, or what it is asking while it waits for an answer.
 */
export function agentActionTitle(instructions: string): string {
  return `Agent: ${firstLine(instructions) || "delegated work"}`;
}

export function agentQuestionTitle(question: string): string {
  return `Agent asks: ${firstLine(question) || "a question"}`;
}

const TITLE_TEXT_LIMIT = 70;

function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return line.length > TITLE_TEXT_LIMIT ? `${line.slice(0, TITLE_TEXT_LIMIT - 1).trimEnd()}…` : line;
}

// RUNS

/** What Dragonglass records about a run, next to what the runner writes itself. */
export interface AgentRunRecord {
  id: string;
  projectId: string;
  projectTitle: string;
  createdAt: string;
  budgetUsd: number;
  model: string;
  /** Claude through the API, or a model on this Mac; local runs cost nothing. */
  runtime: AgentRuntime;
  /** A local run cut off from the internet, which is what allows it the whole vault. */
  offline: boolean;
  wholeVault: boolean;
  /** The runner's result subtype, once it wrote one: `success`, `interrupted`, `error_…`. */
  resultSubtype?: string;
  costUsd: number | null;
  openQuestions: Array<{ id: string; question: string; askedAt: string }>;
  /** Set while the containers are being built and started. */
  starting?: boolean;
  /** Why the run could not start, when it could not. */
  startError?: string;
  /** The vault folder its results were copied into. */
  importedTo?: string;
  /** The Waiting Action that stands for the run in the Project, and its title while no question is open. */
  actionId?: string;
  actionTitle?: string;
}

export type AgentRuntime = "claude" | "local";

export type AgentRunStatus = "starting" | "running" | "waiting" | "finished" | "failed" | "stopped" | "interrupted";

/** A run's state: `alive` when its agent container is still running. */
export function agentRunStatus(run: AgentRunRecord, alive: boolean): AgentRunStatus {
  if (run.startError) return "failed";
  if (run.starting) return "starting";
  if (alive) return run.openQuestions.length ? "waiting" : "running";
  if (run.resultSubtype === "success") return "finished";
  if (run.resultSubtype === "interrupted") return "stopped";
  if (run.resultSubtype) return "failed";
  return "interrupted";
}

/** How a run's state reads on the Project's page. */
export function agentRunStatusText(run: AgentRunRecord, status: AgentRunStatus): string {
  switch (status) {
    case "starting":
      return "Starting (the first run builds the containers, which takes a few minutes)";
    case "running":
      return "Working";
    case "waiting":
      return "Waiting for your answer";
    case "finished":
      return "Finished";
    case "stopped":
      return "Stopped";
    case "interrupted":
      return "Ended without a result";
    case "failed":
      if (run.startError) return `Could not start: ${run.startError}`;
      if (run.resultSubtype === "error_max_budget_usd") return "Stopped at its budget";
      if (run.resultSubtype === "error_max_turns") return "Stopped at its turn limit";
      if (run.resultSubtype === "error_max_time") return "Stopped at its time limit";
      if (run.resultSubtype === "error_no_tool_calls") return "Stopped: the model kept answering without using its tools";
      return "Failed";
  }
}

/**
 * What delegating has cost, per Project: its own runs, and its whole tree's. Only
 * Projects with a run anywhere in their tree appear. Runs without a known cost count
 * as nothing, which is why the numbers are estimates.
 */
export function agentCosts(runs: readonly AgentRunRecord[], projects: readonly Project[]): Map<string, { own: number; tree: number }> {
  const own = new Map<string, number>();
  for (const run of runs) {
    if (typeof run.costUsd === "number") own.set(run.projectId, (own.get(run.projectId) ?? 0) + run.costUsd);
  }
  const costs = new Map<string, { own: number; tree: number }>();
  if (!own.size) return costs;
  for (const project of projects) {
    const tree = [project, ...projectDescendants(project.id, projects)]
      .reduce((sum, member) => sum + (own.get(member.id) ?? 0), 0);
    const mine = own.get(project.id) ?? 0;
    if (tree > 0 || mine > 0) costs.set(project.id, { own: mine, tree });
  }
  return costs;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
