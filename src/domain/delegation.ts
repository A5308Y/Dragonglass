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
import { escapeVaultText } from "./text";
import type { Action, LamderaAgentSettings, Project } from "./types";
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

/** What an earlier run on the same task got to, so a new run can build on it. */
export interface EarlierAttempt {
  /** How the earlier run ended, as the Project's page words it. */
  statusText: string;
  /** The vault folder its results were copied into, or `""` when it left none. */
  resultsFolder: string;
  /** Its last steps, oldest first. */
  activity: AgentActivity[];
}

/** The part of a brief that tells the agent about an earlier attempt, and to build on it. */
export function earlierAttemptSection(earlier: EarlierAttempt): string {
  const steps = earlier.activity.map((entry) => {
    const label = entry.kind === "thought" ? "Thought" : entry.kind === "tool" ? "Tool" : "Said";
    return `- ${label}: ${entry.text}`;
  });
  return [
    "## An earlier attempt",
    "",
    `This task was started before, and that run ended as: ${earlier.statusText}.`,
    earlier.resultsFolder
      ? `What it produced is in \`${MATERIAL_FOLDER}/${earlier.resultsFolder}/\`. Read it first, and build on it rather than starting over; `
        + "put your own results in the outbox, including updated versions of files you improve."
      : "It left no files, so start over, but avoid what made it stop.",
    ...(steps.length ? ["", "Its last steps:", "", ...steps] : []),
    "",
  ].join("\n");
}

export interface BriefInput {
  /** An earlier run on the same task to continue from. */
  earlierAttempt?: EarlierAttempt;
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
    ...(input.earlierAttempt ? [earlierAttemptSection(input.earlierAttempt)] : []),
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

/**
 * The instructions a brief was written from, for running it again: the text under
 * "What I'd like from you", up to the next section.
 */
export function briefInstructions(brief: string): string {
  const match = /^## What I'd like from you\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(brief);
  return match?.[1]?.trim() ?? "";
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

// IMPORTING RESULTS

/** The frontmatter that makes a note a Dragonglass Project, Action or Inbox Item, and ties it to others. */
const ENTITY_KEYS = new Set(["type", "id", "project_id", "project", "parent_project_id", "parent_project", "blocked_by_project_ids", "support_path"]);

/**
 * An agent's note as it may enter the vault: when it carries a Dragonglass entity's
 * frontmatter, often copied from the material it was given, that part is removed, so the
 * note arrives as an ordinary note instead of a second Project with the same id. Other
 * frontmatter stays.
 */
export function withoutEntityFrontmatter(markdown: string): { text: string; changed: boolean } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(markdown);
  if (!match) return { text: markdown, changed: false };
  const lines = match[1]!.split(/\r?\n/);
  const isEntity = lines.some((line) => /^type:\s*["']?gtd-[\w-]+["']?\s*$/.test(line));
  if (!isEntity) return { text: markdown, changed: false };
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1];
    if (key !== undefined) dropping = ENTITY_KEYS.has(key);
    // A dropped key's list items and continuation lines go with it.
    else if (!/^[\s-]/.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }
  const rest = markdown.slice(match[0].length);
  const body = kept.some((line) => line.trim()) ? `---\n${kept.join("\n")}\n---\n${rest}` : rest;
  return { text: body, changed: true };
}

// REPORTING TO THE INBOX

export interface RunReportInput {
  projectTitle: string;
  /** The Project note's vault path, for a link back to it. */
  projectPath: string;
  status: AgentRunStatus;
  statusText: string;
  /** "Local: qwen/… · offline" or "about $0.42 of $5.00". */
  spent: string;
  /** The vault folder its results were copied into, or `""`. */
  resultsFolder: string;
  /** Whether REPORT.md is among the results. */
  hasReport: boolean;
  /** The start of REPORT.md, as the agent wrote it. */
  reportExcerpt: string;
}

const REPORT_EXCERPT_CHARS = 1_500;

/**
 * The Inbox Item an ended run leaves, so what it produced, or that it failed, is
 * processed like anything else that arrives. The report is the agent's text, which may
 * carry what it read on the web, so it is escaped like imported mail and quoted.
 */
export function runReportInboxItem(input: RunReportInput): { title: string; body: string } {
  const finished = input.status === "finished";
  const alias = (text: string) => text.replace(/[[\]|#^]/g, " ").trim();
  const link = (path: string, text: string) => `[[${path.replace(/\.md$/, "")}|${alias(text)}]]`;
  const excerpt = input.reportExcerpt.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const shortened = excerpt.length > REPORT_EXCERPT_CHARS ? `${excerpt.slice(0, REPORT_EXCERPT_CHARS).trimEnd()}\n…` : excerpt;
  const quoted = shortened
    ? escapeVaultText(shortened).split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")
    : "";
  return {
    title: `${finished ? "Agent report" : "Agent run ended"}: ${input.projectTitle}`,
    body: [
      `The agent working on ${link(input.projectPath, input.projectTitle)} ended: ${input.statusText}.`,
      input.spent,
      "",
      input.resultsFolder
        ? `Results: ${input.hasReport ? `${link(`${input.resultsFolder}/REPORT.md`, "the report")}, and the rest in ` : ""}\`${input.resultsFolder}\`.`
        : "It left no results.",
      ...(finished ? [] : ["", "To try again, use “Run again…” in the Agent section of the Project's page."]),
      ...(quoted ? ["", "## Report", "", quoted] : []),
    ].join("\n"),
  };
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
  /** For local runs: which harness drives the model. */
  harness?: LocalHarness;
  wholeVault: boolean;
  /** The runner's result subtype, once it wrote one: `success`, `interrupted`, `error_…`. */
  resultSubtype?: string;
  /** What the runner said went wrong, when it failed. */
  resultError?: string;
  /** The last error line of the container's output, for a run that ended without a result. */
  runnerError?: string;
  costUsd: number | null;
  openQuestions: Array<{ id: string; question: string; askedAt: string }>;
  /** A local run waiting for the local model, which serves one run at a time. */
  queued?: boolean;
  /** Set while the containers are being built and started. */
  starting?: boolean;
  /** Why the run could not start, when it could not. */
  startError?: string;
  /** The vault folder its results were copied into. */
  importedTo?: string;
  /** The agent's latest thoughts, narration and tool calls, newest first. */
  activity?: AgentActivity[];
  /** The Waiting Action that stands for the run in the Project, and its title while no question is open. */
  actionId?: string;
  actionTitle?: string;
  /** For code runs: the repository's name in the coding agent's config, and what the run published. */
  repository?: string;
  branch?: string;
  pullRequestUrl?: string;
  previewUrl?: string;
  /** When a code run stopped at Codex's usage limit: when it can be started again. */
  retryAt?: string;
}

/**
 * Claude through the API, a model on this Mac, OpenAI's Codex on a ChatGPT plan, or the
 * Lamdera coding agent, which changes code in one of the Lamdera apps and opens a pull request.
 */
export type AgentRuntime = "claude" | "local" | "codex" | "lamdera";

export function agentRuntime(value: unknown): AgentRuntime {
  return value === "local" || value === "codex" || value === "lamdera" ? value : "claude";
}

/** What drives a local model: Dragonglass's own small loop, smolagents' CodeAgent, or Qwen-Agent. */
export type LocalHarness = "loop" | "smolagents" | "qwen-agent";

export function localHarness(value: unknown): LocalHarness {
  return value === "smolagents" || value === "qwen-agent" ? value : "loop";
}

/** The compose service that runs a local harness. */
export function localHarnessService(harness: LocalHarness): string {
  return harness === "smolagents" ? "agent-smol" : harness === "qwen-agent" ? "agent-qwen" : "agent-local";
}

export function localHarnessLabel(harness: LocalHarness): string {
  return harness === "smolagents" ? "smolagents" : harness === "qwen-agent" ? "Qwen-Agent" : "Dragonglass's loop";
}

/** One line of what an agent did: a thought (a summary of its reasoning), something it said, or a tool call. */
export interface AgentActivity {
  at: string;
  kind: "thought" | "text" | "tool";
  text: string;
}

export type AgentRunStatus = "queued" | "starting" | "running" | "waiting" | "finished" | "failed" | "stopped" | "interrupted";

/** A run's state: `alive` when its agent container is still running. */
export function agentRunStatus(run: AgentRunRecord, alive: boolean): AgentRunStatus {
  if (run.startError) return "failed";
  if (run.queued) return "queued";
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
    case "queued":
      return run.runtime === "codex"
        ? "Queued: it starts when the Codex run before it ends"
        : run.runtime === "lamdera"
          ? "Queued: it starts when the code run before it ends"
          : "Queued: it starts when the local model is free";
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
      return run.runnerError ? `Ended without a result: ${run.runnerError}` : "Ended without a result";
    case "failed":
      if (run.startError) return `Could not start: ${run.startError}`;
      if (run.resultSubtype === "error_max_budget_usd") return "Stopped at its budget";
      if (run.resultSubtype === "error_max_turns") return "Stopped at its turn limit";
      if (run.resultSubtype === "error_max_time") return "Stopped at its time limit";
      if (run.resultSubtype === "error_no_tool_calls") return "Stopped: the model kept answering without using its tools";
      if (run.resultSubtype === "error_repeating") return "Stopped: it kept repeating the same step";
      if (run.resultSubtype === "error_validation") return "Failed: `lamdera check --force` still fails after one repair, so nothing was pushed";
      if (run.resultSubtype === "error_merge") return "Failed: merging the base branch needs a manual merge";
      if (run.resultSubtype === "usage_limited") {
        return run.retryAt ? `Stopped at Codex's usage limit: start it again after ${localTime(run.retryAt)}` : "Stopped at Codex's usage limit";
      }
      return run.resultError ? `Failed: ${run.resultError}` : "Failed";
  }
}

/**
 * What delegating has cost, per Project: its own runs, and its whole tree's. Only
 * Projects with a run anywhere in their tree appear. Runs without a known cost count
 * as nothing, which is why the numbers are estimates.
 */
export function agentCosts(
  runs: ReadonlyArray<Pick<AgentRunRecord, "projectId" | "costUsd">>,
  projects: readonly Project[],
): Map<string, { own: number; tree: number }> {
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

function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// CODE RUNS

/**
 * The coding agent's name for a Project's task: stable, so every run on the Project works
 * on the same branch and pull request (`agent/DG-…`), and short, because Lamdera names the
 * preview after the branch and caps that name at 20 characters.
 */
export function codeTaskIdentifier(projectId: string): string {
  const characters = projectId.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (characters.length >= 6) return `DG-${characters.slice(-6)}`;
  let hash = 2_166_136_261;
  for (const character of projectId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `DG-${(hash >>> 0).toString(36).toUpperCase().padStart(6, "0").slice(-6)}`;
}

export interface CodeTaskBriefInput {
  breadcrumb: string;
  desiredOutcome: string;
  /** The Project note's text, without its frontmatter. */
  projectNote: string;
  openActions: readonly string[];
  instructions: string;
}

/**
 * What the coding agent is told about the task. It reads the app's code, not the vault, so
 * the brief carries the Project's own words and nothing else from the vault.
 */
export function codeTaskBrief(input: CodeTaskBriefInput): string {
  const note = input.projectNote.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "").trim();
  return [
    "# Task",
    "",
    "## Project",
    "",
    input.breadcrumb,
    "",
    "## Desired outcome",
    "",
    input.desiredOutcome.trim() || "(No desired outcome has been written down yet.)",
    "",
    "## What to implement",
    "",
    input.instructions.trim(),
    "",
    ...(input.openActions.length ? ["## Open Actions in the Project", "", ...input.openActions.map((title) => `- ${title}`), ""] : []),
    ...(note ? ["## The Project note", "", note, ""] : []),
  ].join("\n");
}

export interface EarlierCodeRun {
  createdAt: string;
  instructions: string;
  /** The start of the run's REPORT.md, or `""`. */
  report: string;
}

/** The earlier runs on the same task, oldest first, as the transcript a follow-up continues. */
export function codeRunConversation(runs: readonly EarlierCodeRun[]): string {
  return [...runs]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .flatMap((run) => [`User (${run.createdAt}): ${run.instructions.trim()}`, ...(run.report.trim() ? [`Agent: ${run.report.trim()}`] : []), ""])
    .join("\n")
    .trim();
}

/** The Next Action a code run leaves once its pull request is ready, in the Project it worked on. */
export function reviewActionTitle(instructions: string): string {
  return `Review PR: ${firstLine(instructions) || "agent changes"}`;
}

/** The coding agent's repository names are slugs (see its `repositories.yml`). */
const REPOSITORY_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Saved code-run settings, read without trusting them: they sync with the vault. */
export function parseLamderaAgentSettings(raw: unknown, defaults: LamderaAgentSettings): LamderaAgentSettings {
  const value = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const text = (field: unknown, fallback: string) => (typeof field === "string" && field.trim() ? field.trim() : fallback);
  const repositories: Record<string, string> = {};
  if (typeof value.repositories === "object" && value.repositories !== null) {
    for (const [projectId, name] of Object.entries(value.repositories as Record<string, unknown>)) {
      if (typeof name === "string" && REPOSITORY_NAME.test(name)) repositories[projectId] = name;
    }
  }
  return {
    kitDirectory: typeof value.kitDirectory === "string" ? value.kitDirectory.trim() : defaults.kitDirectory,
    envFile: text(value.envFile, defaults.envFile),
    repositoriesFile: text(value.repositoriesFile, defaults.repositoriesFile),
    repositories,
    reviewContext: text(value.reviewContext, defaults.reviewContext),
  };
}

/** The repository names a parsed `repositories.yml` offers to code runs, in its order. */
export function repositoryNames(document: unknown): string[] {
  const projects = typeof document === "object" && document !== null ? (document as Record<string, unknown>).projects : undefined;
  if (!Array.isArray(projects)) return [];
  return projects.flatMap((project) => {
    const name = typeof project === "object" && project !== null ? (project as Record<string, unknown>).name : undefined;
    return typeof name === "string" && REPOSITORY_NAME.test(name) ? [name] : [];
  });
}
