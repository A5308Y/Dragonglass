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

import { Notice, Platform, TFile, normalizePath, type App } from "obsidian";
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
  delegationBrief,
  delegationScope,
  resultsFolderName,
  runFolderName,
  runReportInboxItem,
  withoutEntityFrontmatter,
  type AgentActivity,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentRuntime,
  type DelegationScope,
  type EarlierAttempt,
} from "../domain/delegation";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
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
  /** Claude runs only: the spending cap in US dollars. */
  budgetUsd: number;
  /** An earlier run to continue from: the brief tells the agent where it got to. */
  earlierAttempt?: EarlierAttempt;
}

/** A finished run's choices, for starting it again from the Delegate dialog. */
export interface RerunDefaults {
  projectId: string;
  instructions: string;
  runtime: AgentRuntime;
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
    // Obsidian lists no files in hidden folders, so .obsidian (with the mail passwords) and .trash stay out.
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
    if (!local && !(options.budgetUsd > 0)) throw new Error("Set a budget above zero.");
    const limit = plan.wholeVault ? MAX_VAULT_BYTES : MAX_MATERIAL_BYTES;
    if (plan.totalBytes > limit) {
      throw new Error(`That is ${formatBytes(plan.totalBytes)} of material, more than the ${formatBytes(limit)} a run may copy.`);
    }
    const settings = this.getSettings();
    // Checked now, so a missing kit or Docker is reported before anything is copied.
    await this.composeFile();
    await this.dockerPath();
    // The local model serves one run at a time; a second one waits its turn.
    const queue = local && this.localModelBusy();
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
      offline: local && plan.wholeVault,
      wholeVault: plan.wholeVault,
      budgetUsd: local ? 0 : options.budgetUsd,
      model: local ? settings.localModel || "the loaded local model" : settings.model,
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
      runtime: meta.runtime === "local" ? "local" : "claude",
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

    // The oldest queued local run starts once the local model is free.
    const next = runs.filter((run) => run.queued && run.runtime === "local").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (next && !this.localModelBusy() && !this.launching.has(next.id)) {
      delete next.queued;
      next.starting = true;
      await this.writeHostNotes(next.id, { queued: false, starting: true });
      new Notice(`The local model is free: starting the queued run on “${next.projectTitle}”.`);
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
      runtime: meta.runtime === "local" ? "local" : "claude",
      offline: meta.offline === true,
      wholeVault: meta.wholeVault === true,
      ...(typeof result?.subtype === "string" ? { resultSubtype: result.subtype } : {}),
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
      composeFile = await this.composeFile();
      const meta = (await readJson(node, node.path.join(runDir, "input", "run.json"))) ?? {};
      const runtime: AgentRuntime = meta.runtime === "local" ? "local" : "claude";
      const budgetUsd = typeof meta.budgetUsd === "number" && meta.budgetUsd > 0 ? meta.budgetUsd : this.getSettings().defaultBudgetUsd;
      const runEnv = env ?? await this.runEnv(runtime, meta.wholeVault === true, budgetUsd);
      await this.docker(
        ["compose", "-f", composeFile, "-p", composeProject(runId), "run", "-d", "--rm", "--build", "--name", containerName(runId), runtime === "local" ? "agent-local" : "agent"],
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
      const composeFile = await this.composeFile().catch(() => "");
      if (composeFile) await this.dockerQuietly(["compose", "-f", composeFile, "-p", composeProject(run.id), "down", "--remove-orphans"]);
      const imported = await this.importOutbox(run);
      await this.completeWaitingAction(run);
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
      const spent = run.runtime === "local"
        ? `Local: ${run.model}${run.wholeVault ? " · whole vault" : ""}${run.offline ? " · offline" : ""}`
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

  /** What the runner and proxy are started with, from the current settings; keys come from the Keychain. */
  private async runEnv(runtime: AgentRuntime, wholeVault: boolean, budgetUsd: number): Promise<Record<string, string>> {
    const settings = this.getSettings();
    if (runtime === "local") {
      return {
        LOCAL_MODEL: settings.localModel,
        LOCAL_MODEL_UPSTREAM: settings.localModelUrl,
        LOCAL_MODEL_API_KEY: settings.localKeychainService ? await this.keychainSecret(settings.localKeychainService) : "",
        AGENT_OFFLINE: wholeVault ? "1" : "0",
        AGENT_MAX_MINUTES: String(settings.localMaxMinutes),
        AGENT_MAX_TURNS: String(settings.localMaxTurns),
        LOCAL_MAX_REPLY_TOKENS: String(settings.localMaxReplyTokens),
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
   * Whether a local run holds the local model: starting, working, or waiting for an
   * answer, since the run continues the moment one arrives.
   */
  private localModelBusy(): boolean {
    return this.runs.some((run) => run.runtime === "local" && !run.queued && !run.startError
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
      const active = new Set(runs
        .filter((run) => run.starting || this.launching.has(run.id) || this.running.has(containerName(run.id)))
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
      await this.docker(args);
    } catch {
      // Cleaning up after a run that already ended; nothing to report.
    }
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

