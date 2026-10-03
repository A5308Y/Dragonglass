/**
 * Runs delegated Project trees in the agent sandbox (`agent/` in the repository).
 *
 * Each run is a folder under the runs directory, outside the vault:
 *   input/brief.md, input/run.json, input/material/<vault paths>   what the agent gets
 *   outbox/                                                         what it produces
 *   exchange/questions, exchange/answers, exchange/result.json      talking back
 *   logs/requests.jsonl                                             the proxy's log
 *   host.json                                                       Dragonglass's own notes
 *
 * Runs are started detached, so they carry on when Obsidian closes; everything this
 * service knows is read back from the folders and from `docker ps`. That is also what
 * lets a server take over later: point the runs directory at a folder it shares.
 *
 * Node's modules are required lazily, as in `src/mail/node-socket.ts`: on mobile they
 * don't exist, and delegation simply isn't offered there.
 */

import { Notice, Platform, TFile, normalizePath, parseYaml, type App } from "obsidian";
import type * as ChildProcess from "node:child_process";
import type * as FsPromises from "node:fs/promises";
import type * as NodeOs from "node:os";
import type * as NodePath from "node:path";
import {
  MATERIAL_FOLDER,
  agentActionTitle,
  agentCosts,
  agentQuestionTitle,
  agentRunStatus,
  agentRunStatusText,
  briefInstructions,
  codeRunConversation,
  codeTaskBrief,
  codeTaskIdentifier,
  delegationBrief,
  delegationScope,
  codeRepositories,
  type CodeRepository,
  resultsFolderName,
  reviewActionTitle,
  runFolderName,
  runReportInboxItem,
  agentRuntime,
  localHarness,
  localHarnessLabel,
  localHarnessService,
  withoutEntityFrontmatter,
  type AgentActivity,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentRuntime,
  type DelegationScope,
  type LocalHarness,
  type EarlierAttempt,
} from "../domain/delegation";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
import { nearestMapped } from "../domain/project-tree";
import type { AgentSettings } from "../domain/types";
import type { GtdRepository } from "../repository/gtd-repository";
import { localDate } from "../utils/date";

interface NodeModules {
  fs: typeof FsPromises;
  path: typeof NodePath;
  os: typeof NodeOs;
  child: typeof ChildProcess;
}

function nodeModules(): NodeModules | null {
  const required = (globalThis as Record<string, unknown>).require;
  if (typeof required !== "function") return null;
  const load = required as (id: string) => unknown;
  return {
    fs: load("fs/promises") as typeof FsPromises,
    path: load("path") as typeof NodePath,
    os: load("os") as typeof NodeOs,
    child: load("child_process") as typeof ChildProcess,
  };
}

/** Largest amount of material a run may copy; a tree bigger than this is probably a mistake. */
const MAX_MATERIAL_BYTES = 500 * 1024 * 1024;
const MAX_VAULT_BYTES = 4 * 1024 * 1024 * 1024;
const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 60_000;
const STALE_START_MS = 30 * 60_000;
/**
 * Deleted runs, one JSON line each, in the runs folder: their cost still counts, and their
 * Waiting Actions stay out of later runs' material.
 */
const DELETED_RUNS_FILE = "deleted-runs.jsonl";

interface DeletedRun {
  runId: string;
  projectId: string;
  costUsd: number | null;
  actionId?: string;
  deletedAt: string;
}

/** How often leftover Docker networks and proxies of ended runs are looked for. */
const CLEANUP_INTERVAL_MS = 10 * 60_000;
/** How much of a run's activity log is shown, and how much of the file is read to find it. */
const ACTIVITY_ENTRIES = 25;
const ACTIVITY_TAIL_BYTES = 64 * 1024;
const DOCKER_CANDIDATES = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"];

export interface DelegationOptions {
  runtime: AgentRuntime;
  /** For local runs: which harness drives the model. */
  harness?: LocalHarness;
  /** Claude runs only: the spending cap in US dollars. */
  budgetUsd: number;
  /** An earlier run to continue from: the brief tells the agent where it got to. */
  earlierAttempt?: EarlierAttempt;
}

/** Reasoning effort a code run asks Codex for, as the coding agent's labels name it. */
export type CodeEffort = "low" | "medium" | "high" | "xhigh";

export interface CodeDelegationOptions {
  effort: CodeEffort;
  /** Continue on the Project's existing branch and pull request, with the earlier runs as the conversation. */
  continuation: boolean;
}

/** A finished run's choices, for starting it again from the Delegate dialog. */
export interface RerunDefaults {
  projectId: string;
  instructions: string;
  runtime: AgentRuntime;
  harness: LocalHarness;
  wholeVault: boolean;
  budgetUsd: number;
  /** Where the earlier run got to, to continue from it. */
  earlier?: EarlierAttempt;
}

export interface AgentRunView extends AgentRunRecord {
  status: AgentRunStatus;
  statusText: string;
  /** The imported REPORT.md in the vault, or `""`. */
  reportPath: string;
}

/** What delegating a Project would hand over, shown before a run starts. */
export interface DelegationPlan {
  scope: DelegationScope;
  /** The whole vault instead of the Project's tree; only for local runs, which are then offline. */
  wholeVault: boolean;
  breadcrumb: string;
  desiredOutcome: string;
  files: TFile[];
  totalBytes: number;
  linkedFileCount: number;
  missingLinks: string[];
}

interface HostNotes {
  /** The last error line of the container's output, saved when a run ends without a result. */
  runnerError?: string;
  actionId?: string;
  actionTitle?: string;
  queued?: boolean;
  starting?: boolean;
  startError?: string;
  importedTo?: string;
  finishedAt?: string;
}

export class AgentService {
  private runs: AgentRunRecord[] = [];
  private deleted: DeletedRun[] = [];
  private running = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly announced = new Set<string>();
  private readonly finishing = new Set<string>();
  private readonly launching = new Set<string>();
  /** What was last written to each run's Waiting Action, so a slow index doesn't cause repeat writes. */
  private readonly actionState = new Map<string, string>();
  /** Activity already read, per run, by the log's size; a finished run's log is read once. */
  private readonly activityCache = new Map<string, { size: number; entries: AgentActivity[] }>();
  private lastCleanup = 0;
  private timer: number | null = null;
  private scanning: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly repository: GtdRepository,
    private readonly getSettings: () => AgentSettings,
  ) {}

  /** Whether this device can run agents at all: the desktop app on macOS, for now. */
  available(): boolean {
    return Platform.isDesktopApp && Platform.isMacOS && nodeModules() !== null;
  }

  start(): () => void {
    if (!this.available()) return () => {};
    void this.scan();
    return () => {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  views(): AgentRunView[] {
    return this.runs.map((run) => {
      const status = agentRunStatus(run, this.running.has(containerName(run.id)));
      const report = run.importedTo ? normalizePath(`${run.importedTo}/REPORT.md`) : "";
      return {
        ...run,
        status,
        statusText: agentRunStatusText(run, status),
        reportPath: report && this.app.vault.getAbstractFileByPath(report) instanceof TFile ? report : "",
      };
    });
  }

  costs(): Map<string, { own: number; tree: number }> {
    return agentCosts([...this.runs, ...this.deleted], this.repository.index.getSnapshot().projects);
  }

  runsDirectory(): string {
    const node = requireNode();
    const configured = this.getSettings().runsDirectory.trim();
    if (configured) return configured.startsWith("~/") ? node.path.join(node.os.homedir(), configured.slice(2)) : configured;
    return node.path.join(node.os.homedir(), "Library", "Application Support", "Dragonglass", "agent-runs");
  }

  /** Dragonglass's own Codex sign-in folder: not ~/.codex, so this session can be ended on its own. */
  codexHome(): string {
    const node = requireNode();
    const configured = this.getSettings().codexHomeDirectory.trim();
    if (configured) return configured.startsWith("~/") ? node.path.join(node.os.homedir(), configured.slice(2)) : configured;
    return node.path.join(node.path.dirname(this.runsDirectory()), "codex");
  }

  async codexSignedIn(): Promise<boolean> {
    const node = requireNode();
    try {
      await node.fs.access(node.path.join(this.codexHome(), "auth.json"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signs Dragonglass's Codex folder in to ChatGPT, in the Codex container, with a device code:
   * `onOutput` receives what Codex prints, including the address and the code to confirm there.
   */
  async codexLogin(onOutput: (text: string) => void, signal?: AbortSignal): Promise<boolean> {
    const node = requireNode();
    const composeFile = await this.composeFile();
    const docker = await this.dockerPath();
    const home = this.codexHome();
    await node.fs.mkdir(home, { recursive: true });
    // Compose needs a run folder for the service's mounts; the sign-in doesn't use it.
    const runDir = node.path.join(this.runsDirectory(), "codex-login");
    for (const folder of ["input", "outbox", "exchange", "logs"]) await node.fs.mkdir(node.path.join(runDir, folder), { recursive: true });
    const path = [node.path.dirname(docker), "/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin", process.env.PATH ?? ""].join(":");
    return new Promise((resolve) => {
      const child = node.child.spawn(docker, ["compose", "-f", composeFile, "-p", "dg-codex-login", "run", "--rm", "--build", "-T", "agent-codex", "login"], {
        env: { ...process.env, PATH: path, RUN_DIR: runDir, CODEX_HOME_DIR: home },
      });
      signal?.addEventListener("abort", () => child.kill("SIGTERM"));
      child.stdout.on("data", (chunk: Buffer) => onOutput(chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => onOutput(chunk.toString()));
      child.on("close", async (code) => {
        await this.dockerQuietly(["compose", "-f", composeFile, "-p", "dg-codex-login", "down", "--remove-orphans"]);
        resolve(code === 0 && await this.codexSignedIn());
      });
    });
  }

  // CODE RUNS

  /** The repository a Project's code runs work on: its own, or the nearest Project's above it. */
  codeRepository(projectId: string): { name: string; fromProjectId: string } | null {
    const mapped = nearestMapped(projectId, this.repository.index.getSnapshot().projects, this.getSettings().lamdera.repositories);
    return mapped ? { name: mapped.value, fromProjectId: mapped.projectId } : null;
  }

  /** Whether a Project already has code runs, which a new one can continue (same branch and pull request). */
  hasCodeRuns(projectId: string): boolean {
    return this.runs.some((run) => run.runtime === "lamdera" && run.projectId === projectId);
  }

  /** The repositories the coding agent's repositories file offers, with their kind. */
  async codeRepositories(): Promise<CodeRepository[]> {
    const node = requireNode();
    const { kit } = await this.lamderaKit();
    const file = this.getSettings().lamdera.repositoriesFile;
    const path = node.path.isAbsolute(file) ? file : node.path.join(kit, file);
    let text: string;
    try {
      text = await node.fs.readFile(path, "utf8");
    } catch {
      throw new Error(`The coding agent's repositories file was not found at ${path}.`);
    }
    return codeRepositories(parseYaml(text));
  }

  /**
   * Starts a code run: the coding agent implements the instructions in the Project's repository,
   * runs the repository's checks before every push (`lamdera check --force` for a Lamdera app, the
   * commands in its config otherwise), and opens or updates a pull request. It gets the Project's own words in its brief and no other vault files.
   */
  async delegateCode(projectId: string, instructions: string, options: CodeDelegationOptions): Promise<string> {
    const node = requireNode();
    if (!this.available()) throw new Error("Delegating needs the Obsidian desktop app on macOS.");
    if (!instructions.trim()) throw new Error("Say what the agent should implement.");
    const snapshot = this.repository.index.getSnapshot();
    const project = snapshot.projectsById.get(projectId);
    if (!project) throw new Error("This Project no longer exists.");
    const repository = this.codeRepository(projectId);
    if (!repository) throw new Error("Choose a repository for this Project first: Settings → Agent delegation → Code repositories.");
    await this.lamderaKit();
    await this.dockerPath();
    const queue = this.laneBusy("lamdera");

    const agentActionIds = new Set([...this.runs, ...this.deleted].flatMap((run) => (run.actionId ? [run.actionId] : [])));
    const openActions = snapshot.actions
      .filter((action) => action.projectId === projectId && !agentActionIds.has(action.id) && action.status !== "done" && action.status !== "cancelled")
      .map((action) => action.title);
    const brief = codeTaskBrief({
      breadcrumb: projectBreadcrumbs(snapshot.projects).get(projectId) ?? project.title,
      desiredOutcome: await this.repository.readDesiredOutcome(project),
      projectNote: await this.app.vault.read(project.file),
      openActions,
      instructions,
    });
    const conversation = options.continuation ? await this.codeConversation(projectId) : "";

    const createdAt = new Date();
    const runId = runFolderName(createdAt, project.title);
    const runDir = node.path.join(this.runsDirectory(), runId);
    for (const folder of ["input", "outbox", "exchange", "logs"]) {
      await node.fs.mkdir(node.path.join(runDir, folder), { recursive: true });
    }
    await node.fs.writeFile(node.path.join(runDir, "input", "brief.md"), brief);
    await writeJson(node, node.path.join(runDir, "input", "run.json"), {
      runId,
      projectId,
      projectTitle: project.title,
      createdAt: createdAt.toISOString(),
      instructions: instructions.trim(),
      runtime: "lamdera",
      repository: repository.name,
      identifier: codeTaskIdentifier(projectId),
      continuation: options.continuation,
      conversation,
      effort: options.effort,
      offline: false,
      wholeVault: false,
      budgetUsd: 0,
      model: "Codex, signed in for the coding agent",
    });
    await this.writeHostNotes(runId, { ...(queue ? { queued: true } : { starting: true }), ...await this.createWaitingAction(projectId, instructions) });
    await this.scan();

    if (!queue) void this.launch(runId, {});
    else new Notice(`Queued: “${project.title}” starts when the code run before it ends.`);
    return runId;
  }

  /** The Project's earlier code runs, oldest first, for a follow-up to continue from. */
  private async codeConversation(projectId: string): Promise<string> {
    const node = requireNode();
    const earlier = this.runs.filter((run) => run.runtime === "lamdera" && run.projectId === projectId);
    const entries = await Promise.all(earlier.map(async (run) => {
      const runDir = node.path.join(this.runsDirectory(), run.id);
      const meta = await readJson(node, node.path.join(runDir, "input", "run.json"));
      const report = await node.fs.readFile(node.path.join(runDir, "outbox", "REPORT.md"), "utf8").catch(() => "");
      return { createdAt: run.createdAt, instructions: typeof meta?.instructions === "string" ? meta.instructions : "", report };
    }));
    return codeRunConversation(entries.filter((entry) => entry.instructions));
  }

  /** The coding agent's checkout and the Compose files Dragonglass starts it with. */
  private async lamderaKit(): Promise<{ kit: string; composeFile: string; envFile: string }> {
    const node = requireNode();
    const settings = this.getSettings().lamdera;
    const configured = settings.kitDirectory.trim();
    if (!configured) throw new Error("Set the coding agent's folder in Dragonglass's settings: Agent delegation → Code repositories.");
    const kit = configured.startsWith("~/") ? node.path.join(node.os.homedir(), configured.slice(2)) : configured;
    const composeFile = node.path.join(kit, "compose.yml");
    const envFile = node.path.isAbsolute(settings.envFile) ? settings.envFile : node.path.join(kit, settings.envFile);
    for (const [file, what] of [[composeFile, "compose.yml"], [envFile, "its Compose env file"]] as const) {
      try {
        await node.fs.access(file);
      } catch {
        throw new Error(`The coding agent's ${what} was not found at ${file}.`);
      }
    }
    return { kit, composeFile, envFile };
  }

  /** Collects what a run for this Project would get, without writing anything. */
  async plan(projectId: string, wholeVault = false): Promise<DelegationPlan> {
    const snapshot = this.repository.index.getSnapshot();
    // The Waiting Actions that stood for earlier runs are bookkeeping, not material: an agent
    // reading "Agent: …" Actions, done or not, could take them for its task list.
    const agentActionIds = new Set([...this.runs, ...this.deleted].flatMap((run) => (run.actionId ? [run.actionId] : [])));
    const agentActionPaths = new Set([...agentActionIds].flatMap((id) => {
      const action = snapshot.actionsById.get(id);
      return action ? [action.file.path] : [];
    }));
    const fullScope = delegationScope(projectId, snapshot.projects, snapshot.actions);
    const scope = { ...fullScope, actions: fullScope.actions.filter((action) => !agentActionIds.has(action.id)) };
    const files = new Map<string, TFile>();
    // Obsidian lists no files in hidden folders, so .obsidian (with the plugin settings) and .trash stay out.
    if (wholeVault) for (const file of this.app.vault.getFiles()) files.set(file.path, file);
    for (const project of scope.projects) files.set(project.file.path, project.file);
    for (const action of scope.actions) files.set(action.file.path, action.file);
    for (const file of this.app.vault.getFiles()) {
      if (scope.supportPaths.some((path) => file.path.startsWith(`${path}/`))) files.set(file.path, file);
    }
    const missingLinks: string[] = [];
    let linkedFileCount = 0;
    for (const project of scope.projects) {
      for (const { link, file } of this.repository.linkedFiles(project)) {
        if (file) {
          files.set(file.path, file);
          linkedFileCount += 1;
        } else missingLinks.push(`${project.title}: ${link}`);
      }
    }
    for (const path of agentActionPaths) files.delete(path);
    const sorted = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
    return {
      scope,
      wholeVault,
      breadcrumb: projectBreadcrumbs(snapshot.projects).get(projectId) ?? scope.root.title,
      desiredOutcome: await this.repository.readDesiredOutcome(scope.root),
      files: sorted,
      totalBytes: sorted.reduce((sum, file) => sum + file.stat.size, 0),
      linkedFileCount,
      missingLinks,
    };
  }

  /** Builds the run folder and starts the containers; the run carries on in the background. */
  async delegate(plan: DelegationPlan, instructions: string, options: DelegationOptions): Promise<string> {
    const node = requireNode();
    const local = options.runtime === "local";
    if (!this.available()) throw new Error("Delegating needs the Obsidian desktop app on macOS.");
    if (!instructions.trim()) throw new Error("Say what you'd like the agent to do.");
    // Whatever the agent reads can leave through the internet, so only an offline local run gets the whole vault.
    if (plan.wholeVault && !local) throw new Error("Only a local model, offline, may read the whole vault.");
    if (options.runtime === "claude" && !(options.budgetUsd > 0)) throw new Error("Set a budget above zero.");
    if (options.runtime === "codex" && !(await this.codexSignedIn())) {
      throw new Error("Sign in to ChatGPT for Codex first: Settings → Agent delegation → Sign in to ChatGPT.");
    }
    const limit = plan.wholeVault ? MAX_VAULT_BYTES : MAX_MATERIAL_BYTES;
    if (plan.totalBytes > limit) {
      throw new Error(`That is ${formatBytes(plan.totalBytes)} of material, more than the ${formatBytes(limit)} a run may copy.`);
    }
    const settings = this.getSettings();
    // Checked now, so a missing kit or Docker is reported before anything is copied.
    await this.composeFile();
    await this.dockerPath();
    // The local model, and Codex's one sign-in, serve one run at a time; a second one waits its turn.
    const queue = options.runtime !== "claude" && this.laneBusy(options.runtime);
    const env = queue ? null : await this.runEnv(options.runtime, plan.wholeVault, options.budgetUsd);

    const root = plan.scope.root;
    const createdAt = new Date();
    const runId = runFolderName(createdAt, root.title);
    const runDir = node.path.join(this.runsDirectory(), runId);
    const input = node.path.join(runDir, "input");
    for (const folder of ["input", "outbox", "exchange", "logs"]) {
      await node.fs.mkdir(node.path.join(runDir, folder), { recursive: true });
    }
    for (const file of plan.files) {
      const target = node.path.join(input, MATERIAL_FOLDER, ...file.path.split("/"));
      await node.fs.mkdir(node.path.dirname(target), { recursive: true });
      await node.fs.writeFile(target, new Uint8Array(await this.app.vault.readBinary(file)));
    }
    const brief = delegationBrief({
      ...(options.earlierAttempt ? { earlierAttempt: options.earlierAttempt } : {}),
      wholeVault: plan.wholeVault,
      breadcrumb: plan.breadcrumb,
      desiredOutcome: plan.desiredOutcome,
      instructions,
      projects: plan.scope.projects,
      actionCount: plan.scope.actions.length,
      linkedFileCount: plan.linkedFileCount,
    });
    await node.fs.writeFile(node.path.join(input, "brief.md"), brief);
    await writeJson(node, node.path.join(input, "run.json"), {
      runId,
      projectId: root.id,
      projectTitle: root.title,
      createdAt: createdAt.toISOString(),
      instructions: instructions.trim(),
      runtime: options.runtime,
      ...(local ? { harness: options.harness ?? "loop" } : {}),
      offline: local && plan.wholeVault,
      wholeVault: plan.wholeVault,
      budgetUsd: options.runtime === "claude" ? options.budgetUsd : 0,
      model: local ? settings.localModel || "the loaded local model"
        : options.runtime === "codex" ? settings.codexModel || "Codex's default model" : settings.model,
    });
    await this.writeHostNotes(runId, { ...(queue ? { queued: true } : { starting: true }), ...await this.createWaitingAction(root.id, instructions) });
    await this.scan();

    if (env) void this.launch(runId, env);
    else new Notice(`Queued: “${root.title}” starts when the local model is free.`);
    return runId;
  }

  /** What a run was started with, so it can be started again; older runs keep their instructions only in the brief. */
  async rerunDefaults(runId: string): Promise<RerunDefaults> {
    const node = requireNode();
    if (!/^[\w.-]+$/.test(runId)) throw new Error("Unknown run.");
    const input = node.path.join(this.runsDirectory(), runId, "input");
    const meta = await readJson(node, node.path.join(input, "run.json"));
    if (!meta || typeof meta.projectId !== "string") throw new Error("This run's details are missing.");
    let instructions = typeof meta.instructions === "string" ? meta.instructions : "";
    if (!instructions) instructions = briefInstructions(await node.fs.readFile(node.path.join(input, "brief.md"), "utf8").catch(() => ""));
    const view = this.views().find((run) => run.id === runId);
    return {
      ...(view ? {
        earlier: {
          statusText: view.statusText,
          resultsFolder: view.importedTo ?? "",
          activity: (view.activity ?? []).slice(0, 15).reverse(),
        },
      } : {}),
      projectId: meta.projectId,
      instructions,
      runtime: agentRuntime(meta.runtime),
      harness: localHarness(meta.harness),
      wholeVault: meta.wholeVault === true,
      budgetUsd: typeof meta.budgetUsd === "number" && meta.budgetUsd > 0 ? meta.budgetUsd : this.getSettings().defaultBudgetUsd,
    };
  }

  /** Hands the agent an answer; it picks it up within seconds. */
  async answer(runId: string, questionId: string, answer: string): Promise<void> {
    const node = requireNode();
    if (!answer.trim()) throw new Error("Write an answer first.");
    if (!/^[\w.-]+$/.test(questionId) || !/^[\w.-]+$/.test(runId)) throw new Error("Unknown question.");
    const answers = node.path.join(this.runsDirectory(), runId, "exchange", "answers");
    await node.fs.mkdir(answers, { recursive: true });
    // Written aside and renamed, so the agent never reads half an answer.
    const target = node.path.join(answers, `${questionId}.json`);
    await writeJson(node, `${target}.tmp`, { id: questionId, answer: answer.trim(), answeredAt: new Date().toISOString() });
    await node.fs.rename(`${target}.tmp`, target);
    await this.scan();
  }

  /** Stops a run; the agent records that it was stopped, and what it made so far is imported. */
  /**
   * Deletes an ended run's folder: its copy of the material, conversation and logs. With
   * `withResults`, its results in the Project Material go to the vault's trash too. What
   * it cost stays counted.
   */
  async deleteRun(runId: string, withResults: boolean): Promise<void> {
    const node = requireNode();
    const run = this.views().find((candidate) => candidate.id === runId);
    if (!run || !/^[\w.-]+$/.test(runId)) throw new Error("This run no longer exists.");
    if (["queued", "starting", "running", "waiting"].includes(run.status)) throw new Error("Stop the run before deleting it.");
    const entry: DeletedRun = {
      runId,
      projectId: run.projectId,
      costUsd: run.costUsd,
      ...(run.actionId ? { actionId: run.actionId } : {}),
      deletedAt: new Date().toISOString(),
    };
    await node.fs.appendFile(node.path.join(this.runsDirectory(), DELETED_RUNS_FILE), `${JSON.stringify(entry)}\n`);
    if (withResults && run.importedTo) {
      const folder = this.app.vault.getAbstractFileByPath(run.importedTo);
      if (folder) await this.app.fileManager.trashFile(folder);
    }
    const composeFile = await this.composeFile().catch(() => "");
    if (composeFile) await this.dockerQuietly(["compose", "-f", composeFile, "-p", composeProject(runId), "down", "--remove-orphans"]);
    await node.fs.rm(node.path.join(this.runsDirectory(), runId), { recursive: true, force: true });
    this.activityCache.delete(runId);
    await this.scan();
  }

  async stop(runId: string): Promise<void> {
    if (!/^[\w.-]+$/.test(runId)) throw new Error("Unknown run.");
    if (this.runs.find((run) => run.id === runId)?.queued) {
      // Never started: it leaves the queue as a stopped run, which can be run again.
      const node = requireNode();
      await writeJson(node, node.path.join(this.runsDirectory(), runId, "exchange", "result.json"), { subtype: "interrupted", costUsd: 0 });
      await this.writeHostNotes(runId, { queued: false });
    } else {
      await this.docker(["stop", "-t", "15", containerName(runId)]);
    }
    await this.scan();
  }

  // SCANNING

  private scan(): Promise<void> {
    this.scanning ??= this.scanNow().finally(() => {
      this.scanning = null;
      this.schedule();
    });
    return this.scanning;
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    const active = this.runs.some((run) => run.queued || run.starting || (run.importedTo === undefined && !run.startError && this.running.has(containerName(run.id))));
    this.timer = window.setTimeout(() => void this.scan(), active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }

  private async scanNow(): Promise<void> {
    const node = requireNode();
    let names: string[];
    try {
      names = (await node.fs.readdir(this.runsDirectory(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      names = [];
    }
    const runs = (await Promise.all(names.map((name) => this.readRun(name)))).filter((run): run is AgentRunRecord => run !== null);
    this.deleted = await this.readDeletedRuns();
    runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    // Only runs that may still be going need Docker asked about them. A start this session
    // didn't launch was cut off by Obsidian closing, and may have come up nonetheless.
    const orphanedStart = (run: AgentRunRecord) => Boolean(run.starting) && !this.launching.has(run.id);
    const candidates = runs.filter((run) => !run.startError && run.importedTo === undefined && (!run.starting || orphanedStart(run) || run.queued));
    if (candidates.length) {
      try {
        this.running = new Set((await this.docker(["ps", "--format", "{{.Names}}"])).split("\n").map((line) => line.trim()).filter(Boolean));
      } catch {
        // Docker is not running: nothing can be running either, but don't conclude runs ended.
        this.runs = runs;
        this.notify();
        return;
      }
    }
    for (const run of runs.filter(orphanedStart)) {
      if (this.running.has(containerName(run.id))) {
        delete run.starting;
        await this.writeHostNotes(run.id, { starting: false });
      } else if (!(Date.now() - Date.parse(run.createdAt) < STALE_START_MS)) {
        delete run.starting;
        run.startError = "it was still starting when Obsidian closed";
        await this.writeHostNotes(run.id, { starting: false, startError: run.startError });
      }
    }
    this.runs = runs;

    if (Date.now() - this.lastCleanup > CLEANUP_INTERVAL_MS) {
      this.lastCleanup = Date.now();
      void this.cleanUpDocker(runs);
    }

    // In each lane, the oldest queued run starts once the lane is free.
    for (const lane of ["local", "codex", "lamdera"] as const) {
      const next = runs.filter((run) => run.queued && run.runtime === lane).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next || this.laneBusy(lane) || this.launching.has(next.id)) continue;
      delete next.queued;
      next.starting = true;
      await this.writeHostNotes(next.id, { queued: false, starting: true });
      const free = lane === "local" ? "The local model is" : lane === "codex" ? "Codex is" : "The coding agent is";
      new Notice(`${free} free: starting the queued run on “${next.projectTitle}”.`);
      void this.launch(next.id);
    }

    for (const run of runs) {
      const alive = this.running.has(containerName(run.id));
      if (alive || run.starting) await this.syncWaitingAction(run);
      for (const question of alive ? run.openQuestions : []) {
        const key = `${run.id}/${question.id}`;
        if (this.announced.has(key)) continue;
        this.announced.add(key);
        new Notice(`The agent working on “${run.projectTitle}” asks: ${question.question}\n\nAnswer on the Project's page.`, 20_000);
      }
      if (!alive && !run.queued && !run.starting && !run.startError && run.importedTo === undefined && !this.finishing.has(run.id)) {
        void this.finish(run);
      }
    }
    this.notify();
  }

  private async readRun(name: string): Promise<AgentRunRecord | null> {
    const node = requireNode();
    const runDir = node.path.join(this.runsDirectory(), name);
    const meta = await readJson(node, node.path.join(runDir, "input", "run.json"));
    if (!meta || typeof meta.projectId !== "string") return null;
    const result = await readJson(node, node.path.join(runDir, "exchange", "result.json"));
    const host = (await readJson(node, node.path.join(runDir, "host.json"))) as HostNotes | null;
    const questions = await readJsonFolder(node, node.path.join(runDir, "exchange", "questions"));
    const answered = new Set(await listJsonIds(node, node.path.join(runDir, "exchange", "answers")));
    return {
      id: name,
      projectId: meta.projectId,
      projectTitle: typeof meta.projectTitle === "string" ? meta.projectTitle : name,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
      budgetUsd: typeof meta.budgetUsd === "number" ? meta.budgetUsd : 0,
      // A local run names the model it actually used in its result.
      model: typeof result?.model === "string" ? result.model : typeof meta.model === "string" ? meta.model : "",
      runtime: agentRuntime(meta.runtime),
      ...(meta.runtime === "local" ? { harness: localHarness(meta.harness) } : {}),
      offline: meta.offline === true,
      wholeVault: meta.wholeVault === true,
      ...(typeof result?.subtype === "string" ? { resultSubtype: result.subtype } : {}),
      ...(typeof result?.error === "string" && result.error ? { resultError: result.error } : {}),
      ...(host?.runnerError ? { runnerError: host.runnerError } : {}),
      costUsd: typeof result?.costUsd === "number" ? result.costUsd : null,
      openQuestions: questions
        .filter((question) => typeof question.id === "string" && typeof question.question === "string" && !answered.has(question.id))
        .map((question) => ({ id: String(question.id), question: String(question.question), askedAt: String(question.askedAt ?? "") })),
      ...(host?.queued ? { queued: true } : {}),
      ...(host?.starting ? { starting: true } : {}),
      ...(host?.startError ? { startError: host.startError } : {}),
      ...(host?.importedTo !== undefined ? { importedTo: host.importedTo } : {}),
      activity: await this.readActivity(name, node.path.join(runDir, "exchange", "activity.jsonl")),
      ...(host?.actionId ? { actionId: host.actionId } : {}),
      ...(host?.actionTitle ? { actionTitle: host.actionTitle } : {}),
      ...(meta.runtime === "lamdera" ? codeRunFields(meta, result) : {}),
    };
  }

  private async readDeletedRuns(): Promise<DeletedRun[]> {
    const node = requireNode();
    let text: string;
    try {
      text = await node.fs.readFile(node.path.join(this.runsDirectory(), DELETED_RUNS_FILE), "utf8");
    } catch {
      return [];
    }
    return text.split("\n").flatMap((line): DeletedRun[] => {
      try {
        const value = JSON.parse(line) as Partial<DeletedRun>;
        return typeof value.runId === "string" && typeof value.projectId === "string"
          ? [{
            runId: value.runId,
            projectId: value.projectId,
            costUsd: typeof value.costUsd === "number" ? value.costUsd : null,
            ...(typeof value.actionId === "string" ? { actionId: value.actionId } : {}),
            deletedAt: String(value.deletedAt ?? ""),
          }]
          : [];
      } catch {
        return [];
      }
    });
  }

  /** The newest entries of a run's activity log, newest first. */
  private async readActivity(runId: string, file: string): Promise<AgentActivity[]> {
    const node = requireNode();
    let size: number;
    try {
      size = (await node.fs.stat(file)).size;
    } catch {
      return [];
    }
    const cached = this.activityCache.get(runId);
    if (cached?.size === size) return cached.entries;
    const handle = await node.fs.open(file, "r");
    try {
      const length = Math.min(size, ACTIVITY_TAIL_BYTES);
      const buffer = new Uint8Array(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = new TextDecoder().decode(buffer).split("\n");
      // The first line of a tail read may be cut off; it fails to parse and is skipped.
      const entries = lines.flatMap((line): AgentActivity[] => {
        try {
          const value = JSON.parse(line) as Partial<AgentActivity>;
          return typeof value.text === "string" && (value.kind === "thought" || value.kind === "text" || value.kind === "tool")
            ? [{ at: String(value.at ?? ""), kind: value.kind, text: value.text }]
            : [];
        } catch {
          return [];
        }
      }).slice(-ACTIVITY_ENTRIES).reverse();
      this.activityCache.set(runId, { size, entries });
      return entries;
    } finally {
      await handle.close();
    }
  }

  // STARTING AND FINISHING

  /**
   * Starts a run's containers. A queued run gets its settings (and keys) only now, from
   * its run.json and the current settings, since it may start in a later session.
   */
  private async launch(runId: string, env?: Record<string, string>): Promise<void> {
    const node = requireNode();
    const runDir = node.path.join(this.runsDirectory(), runId);
    let composeFile = "";
    this.launching.add(runId);
    try {
      const meta = (await readJson(node, node.path.join(runDir, "input", "run.json"))) ?? {};
      const runtime = agentRuntime(meta.runtime);
      if (runtime === "lamdera") {
        // The coding agent's own Compose project (named in its env file), so the run uses the
        // sign-ins and preserved checkouts set up there. Never `down` that project: its daemon may run.
        const kit = await this.lamderaKit();
        await this.docker(
          ["compose", "-f", kit.composeFile, "--env-file", kit.envFile, "--profile", "dragonglass", "run", "-d", "--name", containerName(runId), "task"],
          { RUN_DIR: runDir },
        );
        await this.writeHostNotes(runId, { starting: false });
        new Notice(`The coding agent started on “${this.runs.find((run) => run.id === runId)?.projectTitle ?? runId}”.`);
        return;
      }
      composeFile = await this.composeFile();
      const budgetUsd = typeof meta.budgetUsd === "number" && meta.budgetUsd > 0 ? meta.budgetUsd : this.getSettings().defaultBudgetUsd;
      const runEnv = env ?? await this.runEnv(runtime, meta.wholeVault === true, budgetUsd);
      await this.docker(
        // Not --rm: the container is kept after it exits until its output has been saved (see finish).
        ["compose", "-f", composeFile, "-p", composeProject(runId), "run", "-d", "--build", "--name", containerName(runId),
          runtime === "claude" ? "agent" : runtime === "codex" ? "agent-codex" : localHarnessService(localHarness(meta.harness))],
        { RUN_DIR: runDir, ...runEnv },
      );
      await this.writeHostNotes(runId, { starting: false });
      new Notice(`The agent started on “${this.runs.find((run) => run.id === runId)?.projectTitle ?? runId}”.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeHostNotes(runId, { starting: false, startError: lastLine(message) });
      if (composeFile) await this.dockerQuietly(["compose", "-f", composeFile, "-p", composeProject(runId), "down", "--remove-orphans"]);
      new Notice(`The agent could not start: ${lastLine(message)}`, 15_000);
    } finally {
      this.launching.delete(runId);
    }
    await this.scan();
  }

  /** A run's container has ended: stop its proxy, copy the outbox into the vault, report. */
  private async finish(run: AgentRunRecord): Promise<void> {
    this.finishing.add(run.id);
    try {
      const runnerError = await this.saveRunnerLog(run);
      if (runnerError && !run.resultSubtype) {
        run.runnerError = runnerError;
        await this.writeHostNotes(run.id, { runnerError });
      }
      if (run.runtime !== "lamdera") {
        const composeFile = await this.composeFile().catch(() => "");
        if (composeFile) await this.dockerQuietly(["compose", "-f", composeFile, "-p", composeProject(run.id), "down", "--remove-orphans"]);
      }
      const imported = await this.importOutbox(run);
      await this.completeWaitingAction(run);
      if (run.runtime === "lamdera" && run.resultSubtype === "success" && run.pullRequestUrl) await this.createReviewAction(run);
      await this.writeHostNotes(run.id, { importedTo: imported.folder, finishedAt: new Date().toISOString() });
      const status = agentRunStatus(run, false);
      // A run taken out of the queue never started; there is nothing to report on.
      const neverStarted = status === "stopped" && !imported.folder && !run.activity?.length;
      if (this.getSettings().reportToInbox && !neverStarted) await this.reportToInbox(run, status, imported.folder);
      const cost = typeof run.costUsd === "number" ? `, about $${run.costUsd.toFixed(2)}` : "";
      const files = imported.count ? `${imported.count} file${imported.count === 1 ? "" : "s"} in its Project Material` : "nothing in the outbox";
      const cleaned = imported.cleaned
        ? ` ${imported.cleaned} note${imported.cleaned === 1 ? "" : "s"} carried a copy of a Project's or Action's metadata, which was removed.`
        : "";
      new Notice(`The agent on “${run.projectTitle}”: ${agentRunStatusText(run, status)}, ${files}${cost}.${cleaned}`, 15_000);
    } catch (error) {
      new Notice(`Could not finish the agent run for “${run.projectTitle}”: ${error instanceof Error ? error.message : String(error)}`, 15_000);
    } finally {
      this.finishing.delete(run.id);
      await this.scan();
    }
  }

  /**
   * Saves the ended container's console output to logs/runner.log, removes the container, and
   * returns the output's last error line: the only trace of a runner that crashed before it
   * could write a result.
   */
  private async saveRunnerLog(run: AgentRunRecord): Promise<string> {
    const node = requireNode();
    const container = containerName(run.id);
    let output = "";
    try {
      output = await this.execWithErrors(await this.dockerPath(), ["logs", container]);
    } catch {
      // No container left, for runs started before their output was kept.
    }
    if (output) await node.fs.writeFile(node.path.join(this.runsDirectory(), run.id, "logs", "runner.log"), output);
    await this.dockerQuietly(["rm", "-f", container]);
    // Stack frames ("from bin/run-task:14:in …", "at …") name where it failed, not what failed.
    const lines = output.split("\n").map((line) => line.trim()).filter((line) => line && !/^(from|at) \S/.test(line));
    return [...lines].reverse().find((line) => /error|exception|refused|denied|not found|cannot|can't|invalid|must/i.test(line))
      ?? lines.at(-1) ?? "";
  }

  /**
   * Copies everything the agent wrote into a new folder under the Project's Project
   * Material. Only new files are written, into a folder of their own.
   */
  private async importOutbox(run: AgentRunRecord): Promise<{ folder: string; count: number; cleaned: number }> {
    const node = requireNode();
    const outbox = node.path.join(this.runsDirectory(), run.id, "outbox");
    const files = await listFiles(node, outbox);
    if (!files.length) return { folder: "", count: 0, cleaned: 0 };
    const project = this.repository.index.getSnapshot().projectsById.get(run.projectId);
    if (!project?.supportPath) throw new Error("The Project, or its Project Material folder, no longer exists.");
    const base = normalizePath(`${project.supportPath}/Agent runs/${resultsFolderName(new Date(run.createdAt || Date.now()), run.projectTitle)}`);
    let folder = base;
    for (let suffix = 2; this.app.vault.getAbstractFileByPath(folder); suffix += 1) folder = `${base} ${suffix}`;
    let cleaned = 0;
    for (const relative of files) {
      const target = normalizePath(`${folder}/${relative.split(node.path.sep).join("/")}`);
      await this.ensureVaultFolder(target.slice(0, target.lastIndexOf("/")));
      const data = await node.fs.readFile(node.path.join(outbox, relative));
      if (target.toLowerCase().endsWith(".md")) {
        // A copied Project or Action note would be a second one with the same id; it arrives as a plain note.
        const { text, changed } = withoutEntityFrontmatter(data.toString("utf8"));
        if (changed) cleaned += 1;
        await this.app.vault.create(target, text);
      } else {
        await this.app.vault.createBinary(target, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      }
    }
    return { folder, count: files.length, cleaned };
  }

  /**
   * Leaves an Inbox Item for an ended run: its report to process, or the news that it
   * failed, so the next step is decided in the Inbox like anything else that arrives.
   */
  private async reportToInbox(run: AgentRunRecord, status: AgentRunStatus, resultsFolder: string): Promise<void> {
    try {
      const project = this.repository.index.getSnapshot().projectsById.get(run.projectId);
      const reportPath = resultsFolder ? normalizePath(`${resultsFolder}/REPORT.md`) : "";
      const report = reportPath ? this.app.vault.getAbstractFileByPath(reportPath) : null;
      const spent = run.runtime === "lamdera" ? codeRunSummary(run) : run.runtime === "codex" ? `ChatGPT plan (Codex): ${run.model}` : run.runtime === "local"
        ? `Local${run.harness && run.harness !== "loop" ? ` (${localHarnessLabel(run.harness)})` : ""}: ${run.model}${run.wholeVault ? " · whole vault" : ""}${run.offline ? " · offline" : ""}`
        : typeof run.costUsd === "number"
          ? `Cost: about $${run.costUsd.toFixed(2)} of $${run.budgetUsd.toFixed(2)}`
          : `Budget: $${run.budgetUsd.toFixed(2)}`;
      const item = runReportInboxItem({
        projectTitle: run.projectTitle,
        projectPath: project?.file.path ?? run.projectTitle,
        status,
        statusText: agentRunStatusText(run, status),
        spent,
        resultsFolder,
        hasReport: report instanceof TFile,
        reportExcerpt: report instanceof TFile ? await this.app.vault.read(report) : "",
      });
      await this.repository.createInboxItem(item.title, item.body);
    } catch (error) {
      new Notice(`Could not add the agent's report to the Inbox: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  // THE WAITING ACTION

  /**
   * A Waiting Action in the delegated Project stands for the run, so the Project counts
   * as moving and the run shows wherever Actions do. A run still starts when it can't
   * be created; the Project's page shows the run either way.
   */
  private async createWaitingAction(projectId: string, instructions: string): Promise<HostNotes> {
    const title = agentActionTitle(instructions);
    try {
      const actionId = await this.repository.createAction({ title, status: "waiting", projectId, context: "", waitingSince: localDate() });
      return { actionId, actionTitle: title };
    } catch (error) {
      new Notice(`The run starts without a Waiting Action: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  /**
   * While the agent waits for an answer, the Action says what it asks and is due for
   * follow-up today, which flags it on the board; once answered it reads as before.
   */
  private async syncWaitingAction(run: AgentRunRecord): Promise<void> {
    const action = run.actionId ? this.repository.index.getSnapshot().actionsById.get(run.actionId) : undefined;
    // Gone, finished or moved on by hand: the person has taken it over.
    if (!action || action.status !== "waiting" || !run.actionTitle) return;
    const question = run.openQuestions[0];
    const title = question ? agentQuestionTitle(question.question) : run.actionTitle;
    const followUp = question ? localDate() : "";
    const wanted = `${title}\n${followUp}`;
    const current = this.actionState.get(action.id) ?? `${action.title}\n${action.followUp ?? ""}`;
    if (current === wanted) return;
    this.actionState.set(action.id, wanted);
    try {
      await this.repository.updateAction(action.id, { title, followUp });
    } catch {
      this.actionState.delete(action.id);
    }
  }

  /** The run has ended, so its Waiting Action is done; the report is what's left to look at. */
  private async completeWaitingAction(run: AgentRunRecord): Promise<void> {
    const action = run.actionId ? this.repository.index.getSnapshot().actionsById.get(run.actionId) : undefined;
    if (!action || action.status !== "waiting") return;
    this.actionState.delete(action.id);
    await this.repository.updateAction(action.id, {
      ...(run.actionTitle ? { title: run.actionTitle } : {}),
      status: "done",
    });
  }

  /**
   * A code run's pull request is ready: a Next Action in the Project says so, with the links, as
   * Linear's "In Review" would. The run's Waiting Action is done by now.
   */
  private async createReviewAction(run: AgentRunRecord): Promise<void> {
    try {
      const node = requireNode();
      const meta = await readJson(node, node.path.join(this.runsDirectory(), run.id, "input", "run.json"));
      const instructions = typeof meta?.instructions === "string" ? meta.instructions : run.projectTitle;
      await this.repository.createAction({
        title: reviewActionTitle(instructions),
        status: "next",
        projectId: run.projectId,
        context: this.getSettings().lamdera.reviewContext,
        body: [
          `- [Pull request](${run.pullRequestUrl})`,
          ...(run.previewUrl ? [`- [Preview](${run.previewUrl})`] : []),
          ...(run.branch ? [`- Branch: \`${run.branch}\``] : []),
        ].join("\n"),
      });
    } catch (error) {
      new Notice(`The pull request is ready, but the review Action could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** What the runner and proxy are started with, from the current settings; keys come from the Keychain. */
  private async runEnv(runtime: AgentRuntime, wholeVault: boolean, budgetUsd: number): Promise<Record<string, string>> {
    const settings = this.getSettings();
    if (runtime === "codex") {
      return {
        CODEX_HOME_DIR: this.codexHome(),
        CODEX_MODEL: settings.codexModel,
        AGENT_MAX_MINUTES: String(settings.codexMaxMinutes),
        AGENT_OFFLINE: "0",
      };
    }
    if (runtime === "local") {
      return {
        LOCAL_MODEL: settings.localModel,
        LOCAL_MODEL_UPSTREAM: settings.localModelUrl,
        LOCAL_MODEL_API_KEY: settings.localKeychainService ? await this.keychainSecret(settings.localKeychainService) : "",
        AGENT_OFFLINE: wholeVault ? "1" : "0",
        AGENT_MAX_MINUTES: String(settings.localMaxMinutes),
        AGENT_MAX_TURNS: String(settings.localMaxTurns),
        LOCAL_MAX_REPLY_TOKENS: String(settings.localMaxReplyTokens),
        LOCAL_CONTEXT_TOKENS: String(settings.localContextTokens),
        // About three characters a token, less the room the tools, the reply and the model's thinking need.
        LOCAL_CONTEXT_CHARS: String(Math.max(8_000, Math.floor((settings.localContextTokens - 4_000) * 3))),
      };
    }
    return {
      ANTHROPIC_API_KEY: await this.keychainSecret(settings.keychainService),
      AGENT_MAX_BUDGET_USD: String(budgetUsd),
      AGENT_MODEL: settings.model,
      AGENT_MAX_TURNS: String(settings.maxTurns),
      AGENT_OFFLINE: "0",
    };
  }

  /**
   * Whether a run of this runtime is going: starting, working, or waiting for an answer,
   * since it continues the moment one arrives. Local runs share one model; Codex runs share
   * one sign-in, which each run renews, so two at once could break it.
   */
  private laneBusy(runtime: AgentRuntime): boolean {
    return this.runs.some((run) => run.runtime === runtime && !run.queued && !run.startError
      && (this.launching.has(run.id) || Boolean(run.starting) || this.running.has(containerName(run.id))));
  }

  /**
   * Removes what ended runs left in Docker: each run has two networks and a proxy, and
   * runs that failed to start, or whose start Obsidian cut off, skipped the cleanup that
   * ending normally does. Docker has room for only a few dozen networks.
   */
  private async cleanUpDocker(runs: readonly AgentRunRecord[]): Promise<void> {
    try {
      const composeFile = await this.composeFile();
      // A run that has ended but isn't finished yet still needs its container, for its output.
      const active = new Set(runs
        .filter((run) => run.starting || this.launching.has(run.id) || this.running.has(containerName(run.id))
          || (run.importedTo === undefined && !run.startError && !run.queued))
        .map((run) => composeProject(run.id)));
      // Docker's name filters match anywhere in the name, so the prefix is checked here. Compose
      // names a project's networks "<project>_<network>" and its containers "<project>-<service>-<n>";
      // a run's proxy that is still running keeps its networks in use.
      const lines = async (args: string[]) => (await this.docker(args)).split("\n").map((line) => line.trim()).filter(Boolean);
      const fromNetworks = (await lines(["network", "ls", "--filter", "name=dg-", "--format", "{{.Name}}"]))
        .map((name) => name.replace(/_[^_]+$/, ""));
      const fromContainers = (await lines(["ps", "-a", "--filter", "name=dg-", "--format", "{{.Label \"com.docker.compose.project\"}}"]));
      const projects = new Set([...fromNetworks, ...fromContainers]
        .filter((project) => project.startsWith("dg-") && !active.has(project)));
      for (const project of projects) {
        await this.dockerQuietly(["compose", "-f", composeFile, "-p", project, "down", "--remove-orphans"]);
      }
    } catch {
      // Docker isn't running, or the kit isn't set up: nothing to clean now; the next pass tries again.
    }
  }

  // HOST PLUMBING

  private async composeFile(): Promise<string> {
    const node = requireNode();
    const kit = this.getSettings().kitDirectory.trim();
    if (!kit) throw new Error("Set the agent kit folder in Dragonglass's settings: the repository's “agent” folder.");
    const composeFile = node.path.join(kit.startsWith("~/") ? node.path.join(node.os.homedir(), kit.slice(2)) : kit, "compose.yaml");
    try {
      await node.fs.access(composeFile);
    } catch {
      throw new Error(`No compose.yaml in the agent kit folder (${kit}).`);
    }
    return composeFile;
  }

  private async dockerPath(): Promise<string> {
    const node = requireNode();
    const configured = this.getSettings().dockerPath.trim();
    for (const candidate of configured ? [configured] : DOCKER_CANDIDATES) {
      try {
        await node.fs.access(candidate);
        return candidate;
      } catch {
        // Try the next one.
      }
    }
    throw new Error(configured ? `Docker was not found at ${configured}.` : "Docker was not found. Install Docker Desktop, or set its path in the settings.");
  }

  /**
   * The local model server's API key, when the settings name a Keychain item for one,
   * for the brainstorm partner, which asks the server directly. Read on each use and
   * never stored, like the keys runs get.
   */
  async localModelKey(): Promise<string> {
    const service = this.getSettings().localKeychainService;
    return service ? this.keychainSecret(service) : "";
  }

  /** An API key from the macOS Keychain, read only when a run starts and never stored. */
  private async keychainSecret(service: string): Promise<string> {
    try {
      const key = (await this.exec("/usr/bin/security", ["find-generic-password", "-s", service, "-w"])).trim();
      if (key) return key;
    } catch {
      // Reported below.
    }
    throw new Error(`No API key in the Keychain under “${service}”. Add one in Terminal with: security add-generic-password -a "$USER" -s ${service} -w`);
  }

  private async docker(args: string[], env: Record<string, string> = {}, docker?: string): Promise<string> {
    return this.exec(docker ?? await this.dockerPath(), args, env);
  }

  private async dockerQuietly(args: string[]): Promise<void> {
    try {
      // The compose file insists on RUN_DIR even for `down`, which mounts nothing.
      await this.docker(args, { RUN_DIR: requireNode().os.tmpdir() });
    } catch {
      // Cleaning up after a run that already ended; nothing to report.
    }
  }

  /** Like exec, but returns what the program wrote to both its output and its error output. */
  private execWithErrors(file: string, args: string[]): Promise<string> {
    const node = requireNode();
    return new Promise((resolve, reject) => {
      node.child.execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && !stdout && !stderr) reject(error);
        else resolve(`${String(stdout)}${stderr ? `\n${String(stderr)}` : ""}`.trim());
      });
    });
  }

  private exec(file: string, args: string[], env: Record<string, string> = {}): Promise<string> {
    const node = requireNode();
    // Obsidian doesn't get the shell's PATH; Docker's helpers live next to docker itself.
    const path = [node.path.dirname(file), "/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin", process.env.PATH ?? ""]
      .filter(Boolean).join(":");
    return new Promise((resolve, reject) => {
      node.child.execFile(file, args, { env: { ...process.env, PATH: path, ...env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim() || error.message));
        else resolve(String(stdout));
      });
    });
  }

  private async writeHostNotes(runId: string, changes: HostNotes): Promise<void> {
    const node = requireNode();
    const file = node.path.join(this.runsDirectory(), runId, "host.json");
    const current = ((await readJson(node, file)) ?? {}) as HostNotes;
    const next: HostNotes = { ...current, ...changes };
    if (!next.starting) delete next.starting;
    if (!next.queued) delete next.queued;
    await writeJson(node, file, next);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The Docker names a run's containers use, derived from its folder name. */
function composeProject(runId: string): string {
  return `dg-${runId}`.toLowerCase();
}

/** A code run's branch, pull request and preview, from its run.json and the result the coding agent wrote. */
function codeRunFields(meta: Record<string, unknown>, result: Record<string, unknown> | null): Partial<AgentRunRecord> {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  // Only web links are shown and linked; the coding agent checks the pull request's own address.
  const link = (value: unknown) => (typeof value === "string" && /^https:\/\/[^\s)]+$/.test(value) ? value : undefined);
  const fields = {
    repository: text(meta.repository),
    branch: text(result?.branch),
    pullRequestUrl: link(result?.pullRequestUrl),
    previewUrl: link(result?.previewUrl),
    retryAt: text(result?.retryAt),
    stack: text(result?.stack),
    checks: text(result?.checks),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<AgentRunRecord>;
}

/** The Inbox report's line on what a code run did, with its links. */
function codeRunSummary(run: AgentRunRecord): string {
  return [
    `Code: ${run.repository ?? "a repository"}${run.branch ? `, branch \`${run.branch}\`` : ""}`,
    ...(run.checks && run.resultSubtype === "success" ? [`checked with ${run.checks}`] : []),
    ...(run.pullRequestUrl ? [`[Pull request](${run.pullRequestUrl})`] : []),
    ...(run.previewUrl ? [`[Preview](${run.previewUrl})`] : []),
  ].join(" · ");
}

function containerName(runId: string): string {
  return `dg-${runId}-agent`;
}

function requireNode(): NodeModules {
  const node = nodeModules();
  if (!node) throw new Error("Delegating needs the Obsidian desktop app.");
  return node;
}

async function readJson(node: NodeModules, file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await node.fs.readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function writeJson(node: NodeModules, file: string, value: unknown): Promise<void> {
  await node.fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function listJsonIds(node: NodeModules, folder: string): Promise<string[]> {
  try {
    return (await node.fs.readdir(folder)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  } catch {
    return [];
  }
}

async function readJsonFolder(node: NodeModules, folder: string): Promise<Array<Record<string, unknown>>> {
  const ids = await listJsonIds(node, folder);
  const values = await Promise.all(ids.map((id) => readJson(node, node.path.join(folder, `${id}.json`))));
  return values.filter((value): value is Record<string, unknown> => value !== null);
}

/** Every file below `folder`, as paths relative to it. */
async function listFiles(node: NodeModules, folder: string, prefix = ""): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await node.fs.readdir(node.path.join(folder, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? node.path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(node, folder, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function lastLine(message: string): string {
  return message.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? message;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

