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
  agentCosts,
  agentRunStatus,
  agentRunStatusText,
  delegationBrief,
  delegationScope,
  resultsFolderName,
  runFolderName,
  type AgentRunRecord,
  type AgentRunStatus,
  type DelegationScope,
} from "../domain/delegation";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
import type { AgentSettings } from "../domain/types";
import type { GtdRepository } from "../repository/gtd-repository";

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
const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 60_000;
const STALE_START_MS = 30 * 60_000;
const DOCKER_CANDIDATES = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"];

export interface AgentRunView extends AgentRunRecord {
  status: AgentRunStatus;
  statusText: string;
  /** The imported REPORT.md in the vault, or `""`. */
  reportPath: string;
}

/** What delegating a Project would hand over, shown before a run starts. */
export interface DelegationPlan {
  scope: DelegationScope;
  breadcrumb: string;
  desiredOutcome: string;
  files: TFile[];
  totalBytes: number;
  linkedFileCount: number;
  missingLinks: string[];
}

interface HostNotes {
  starting?: boolean;
  startError?: string;
  importedTo?: string;
  finishedAt?: string;
}

export class AgentService {
  private runs: AgentRunRecord[] = [];
  private running = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly announced = new Set<string>();
  private readonly finishing = new Set<string>();
  private readonly launching = new Set<string>();
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
    return agentCosts(this.runs, this.repository.index.getSnapshot().projects);
  }

  runsDirectory(): string {
    const node = requireNode();
    const configured = this.getSettings().runsDirectory.trim();
    if (configured) return configured.startsWith("~/") ? node.path.join(node.os.homedir(), configured.slice(2)) : configured;
    return node.path.join(node.os.homedir(), "Library", "Application Support", "Dragonglass", "agent-runs");
  }

  /** Collects what a run for this Project would get, without writing anything. */
  async plan(projectId: string): Promise<DelegationPlan> {
    const snapshot = this.repository.index.getSnapshot();
    const scope = delegationScope(projectId, snapshot.projects, snapshot.actions);
    const files = new Map<string, TFile>();
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
    const sorted = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
    return {
      scope,
      breadcrumb: projectBreadcrumbs(snapshot.projects).get(projectId) ?? scope.root.title,
      desiredOutcome: await this.repository.readDesiredOutcome(scope.root),
      files: sorted,
      totalBytes: sorted.reduce((sum, file) => sum + file.stat.size, 0),
      linkedFileCount,
      missingLinks,
    };
  }

  /** Builds the run folder and starts the containers; the run carries on in the background. */
  async delegate(plan: DelegationPlan, instructions: string, budgetUsd: number): Promise<string> {
    const node = requireNode();
    if (!this.available()) throw new Error("Delegating needs the Obsidian desktop app on macOS.");
    if (!instructions.trim()) throw new Error("Say what you'd like the agent to do.");
    if (!(budgetUsd > 0)) throw new Error("Set a budget above zero.");
    if (plan.totalBytes > MAX_MATERIAL_BYTES) {
      throw new Error(`This tree holds ${formatBytes(plan.totalBytes)} of material, more than the ${formatBytes(MAX_MATERIAL_BYTES)} a run may copy.`);
    }
    const settings = this.getSettings();
    const composeFile = await this.composeFile();
    const docker = await this.dockerPath();
    const apiKey = await this.apiKey();

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
      budgetUsd,
      model: settings.model,
    });
    await this.writeHostNotes(runId, { starting: true });
    await this.scan();

    void this.launch(runId, runDir, composeFile, docker, apiKey, budgetUsd, settings.model);
    return runId;
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
  async stop(runId: string): Promise<void> {
    if (!/^[\w.-]+$/.test(runId)) throw new Error("Unknown run.");
    await this.docker(["stop", "-t", "15", containerName(runId)]);
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
    const active = this.runs.some((run) => run.starting || (run.importedTo === undefined && !run.startError && this.running.has(containerName(run.id))));
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
    runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    // Only runs that may still be going need Docker asked about them.
    const candidates = runs.filter((run) => !run.startError && run.importedTo === undefined && !run.starting);
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
    this.runs = runs;

    for (const run of runs) {
      const alive = this.running.has(containerName(run.id));
      for (const question of alive ? run.openQuestions : []) {
        const key = `${run.id}/${question.id}`;
        if (this.announced.has(key)) continue;
        this.announced.add(key);
        new Notice(`The agent working on “${run.projectTitle}” asks: ${question.question}\n\nAnswer on the Project's page.`, 20_000);
      }
      if (!alive && !run.starting && !run.startError && run.importedTo === undefined && !this.finishing.has(run.id)) {
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
    // A start that never finished, because Obsidian closed during it, would otherwise stay "starting".
    const createdAt = typeof meta.createdAt === "string" ? Date.parse(meta.createdAt) : NaN;
    const staleStart = Boolean(host?.starting) && !this.launching.has(name) && !(Date.now() - createdAt < STALE_START_MS);
    return {
      id: name,
      projectId: meta.projectId,
      projectTitle: typeof meta.projectTitle === "string" ? meta.projectTitle : name,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
      budgetUsd: typeof meta.budgetUsd === "number" ? meta.budgetUsd : 0,
      model: typeof meta.model === "string" ? meta.model : "",
      ...(typeof result?.subtype === "string" ? { resultSubtype: result.subtype } : {}),
      costUsd: typeof result?.costUsd === "number" ? result.costUsd : null,
      openQuestions: questions
        .filter((question) => typeof question.id === "string" && typeof question.question === "string" && !answered.has(question.id))
        .map((question) => ({ id: String(question.id), question: String(question.question), askedAt: String(question.askedAt ?? "") })),
      ...(host?.starting && !staleStart ? { starting: true } : {}),
      ...(host?.startError ? { startError: host.startError } : staleStart ? { startError: "it was still starting when Obsidian closed" } : {}),
      ...(host?.importedTo !== undefined ? { importedTo: host.importedTo } : {}),
    };
  }

  // STARTING AND FINISHING

  private async launch(runId: string, runDir: string, composeFile: string, docker: string, apiKey: string, budgetUsd: number, model: string): Promise<void> {
    this.launching.add(runId);
    try {
      await this.docker(
        ["compose", "-f", composeFile, "-p", composeProject(runId), "run", "-d", "--rm", "--build", "--name", containerName(runId), "agent"],
        { RUN_DIR: runDir, ANTHROPIC_API_KEY: apiKey, AGENT_MAX_BUDGET_USD: String(budgetUsd), AGENT_MODEL: model },
        docker,
      );
      await this.writeHostNotes(runId, { starting: false });
      new Notice(`The agent started on “${this.runs.find((run) => run.id === runId)?.projectTitle ?? runId}”.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeHostNotes(runId, { starting: false, startError: lastLine(message) });
      await this.dockerQuietly(["compose", "-f", composeFile, "-p", composeProject(runId), "down", "--remove-orphans"]);
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
      await this.writeHostNotes(run.id, { importedTo: imported.folder, finishedAt: new Date().toISOString() });
      const status = agentRunStatus(run, false);
      const cost = typeof run.costUsd === "number" ? `, about $${run.costUsd.toFixed(2)}` : "";
      const files = imported.count ? `${imported.count} file${imported.count === 1 ? "" : "s"} in its Project Material` : "nothing in the outbox";
      new Notice(`The agent on “${run.projectTitle}”: ${agentRunStatusText(run, status)}, ${files}${cost}.`, 15_000);
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
  private async importOutbox(run: AgentRunRecord): Promise<{ folder: string; count: number }> {
    const node = requireNode();
    const outbox = node.path.join(this.runsDirectory(), run.id, "outbox");
    const files = await listFiles(node, outbox);
    if (!files.length) return { folder: "", count: 0 };
    const project = this.repository.index.getSnapshot().projectsById.get(run.projectId);
    if (!project?.supportPath) throw new Error("The Project, or its Project Material folder, no longer exists.");
    const base = normalizePath(`${project.supportPath}/Agent runs/${resultsFolderName(new Date(run.createdAt || Date.now()), run.projectTitle)}`);
    let folder = base;
    for (let suffix = 2; this.app.vault.getAbstractFileByPath(folder); suffix += 1) folder = `${base} ${suffix}`;
    for (const relative of files) {
      const target = normalizePath(`${folder}/${relative.split(node.path.sep).join("/")}`);
      await this.ensureVaultFolder(target.slice(0, target.lastIndexOf("/")));
      const data = await node.fs.readFile(node.path.join(outbox, relative));
      await this.app.vault.createBinary(target, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    }
    return { folder, count: files.length };
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
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

  /** The API key, from the macOS Keychain, read only when a run starts and never stored. */
  private async apiKey(): Promise<string> {
    const service = this.getSettings().keychainService;
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

