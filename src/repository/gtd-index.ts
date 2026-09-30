import { MetadataCache, Plugin, TAbstractFile, TFile, Vault } from "obsidian";
import type { Action, GtdSnapshot, InboxItem, IndexIssue, Project } from "../domain/types";
import { parseAction, parseInboxItem, parseProject } from "../domain/validation";
import { projectHierarchyIssue } from "../domain/project-hierarchy";
import { projectStatusLabel, strandedProjects } from "../domain/project-tree";
import { localDate } from "../utils/date";
import { isPathInDirectory, rawInboxId } from "../utils/path";
import { logTiming, timingLog } from "../utils/timing";

type Listener = () => void;

/**
 * How long after a change the views are told, and the longest they wait while changes
 * keep coming. One write is several vault events (created, then its metadata read), and
 * sync delivers files in bursts; each event used to make every open view redraw.
 */
const NOTIFY_DELAY_MS = 40;
const NOTIFY_MAX_WAIT_MS = 250;

export class GtdIndex {
  private inboxItemsByPath = new Map<string, InboxItem>();
  private actionsByPath = new Map<string, Action>();
  private projectsByPath = new Map<string, Project>();
  private parseIssues = new Map<string, IndexIssue>();
  /** Listener → its name in the timing log. */
  private listeners = new Map<Listener, string>();
  private notifyTimer: number | null = null;
  private pendingSince = 0;
  private current: GtdSnapshot = {
    revision: 0,
    inboxItems: [],
    actions: [],
    projects: [],
    inboxItemsById: new Map(),
    actionsById: new Map(),
    projectsById: new Map(),
    issues: [],
  };

  constructor(
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
    private readonly getInboxDirectory: () => string,
  ) {}

  initialize(plugin: Plugin): void {
    this.reindex();

    plugin.registerEvent(this.metadataCache.on("changed", (file) => this.refresh(file)));
    plugin.registerEvent(this.vault.on("create", (file) => {
      if (file instanceof TFile) this.refresh(file);
      else this.reindex();
    }));
    plugin.registerEvent(this.vault.on("rename", (file, oldPath) => this.rename(file, oldPath)));
    plugin.registerEvent(this.vault.on("delete", (file) => {
      if (file instanceof TFile) this.remove(file.path);
      else this.reindex();
    }));
  }

  getSnapshot = (): GtdSnapshot => this.current;

  reindex(): void {
    this.inboxItemsByPath.clear();
    this.actionsByPath.clear();
    this.projectsByPath.clear();
    this.parseIssues.clear();
    for (const file of this.vault.getFiles()) this.readFile(file);
    this.rebuildSnapshot();
  }

  subscribe = (listener: Listener, name = "listener"): (() => void) => {
    this.listeners.set(listener, name);
    return () => this.listeners.delete(listener);
  };

  refresh(file: TFile): void {
    this.removeFromMaps(file.path);
    this.readFile(file);
    this.rebuildSnapshot();
  }

  private rename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) {
      this.reindex();
      return;
    }
    this.removeFromMaps(oldPath);
    this.readFile(file);
    this.rebuildSnapshot();
  }

  private remove(path: string): void {
    this.removeFromMaps(path);
    // Untracked files still matter to views that read the vault directly, such as Project support material.
    this.rebuildSnapshot();
  }

  private removeFromMaps(path: string): void {
    this.inboxItemsByPath.delete(path);
    this.actionsByPath.delete(path);
    this.projectsByPath.delete(path);
    this.parseIssues.delete(path);
  }

  private readFile(file: TFile): void {
    const frontmatter = file.extension === "md" ? this.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const type = frontmatter?.type;
    try {
      if (isPathInDirectory(file.path, this.getInboxDirectory())) {
        if (type === "gtd-inbox-item" && frontmatter) this.inboxItemsByPath.set(file.path, parseInboxItem(frontmatter, file));
        else if (type === "gtd-action" && frontmatter?.status === "inbox") this.inboxItemsByPath.set(file.path, parseInboxItem(frontmatter, file, true));
        else this.inboxItemsByPath.set(file.path, rawInboxItem(file));
      } else if (type === "gtd-action" && frontmatter?.status === "inbox") this.inboxItemsByPath.set(file.path, parseInboxItem(frontmatter, file, true));
      else if (type === "gtd-action" && frontmatter) this.actionsByPath.set(file.path, parseAction(frontmatter, file));
      else if (type === "gtd-project" && frontmatter) this.projectsByPath.set(file.path, parseProject(frontmatter, file));
    } catch (error) {
      if (isPathInDirectory(file.path, this.getInboxDirectory())) this.inboxItemsByPath.set(file.path, rawInboxItem(file));
      this.parseIssues.set(file.path, {
        path: file.path,
        kind: "invalid",
        message: error instanceof Error ? error.message : "Invalid GTD metadata",
      });
    }
  }

  private rebuildSnapshot(): void {
    const start = timingLog() ? performance.now() : 0;
    this.buildSnapshot();
    // Every vault event passes here, typing included, so only noticeable ones are logged.
    if (start && performance.now() - start >= 1) logTiming("Index rebuilt", performance.now() - start);
    this.scheduleNotify();
  }

  private buildSnapshot(): void {
    const issues: IndexIssue[] = [...this.parseIssues.values()];
    const inboxItemsById = new Map<string, InboxItem>();
    const actionsById = new Map<string, Action>();
    const projectsById = new Map<string, Project>();
    const duplicateInboxItemIds = duplicates([...this.inboxItemsByPath.values()]);
    const duplicateActionIds = duplicates([...this.actionsByPath.values()]);
    const duplicateProjectIds = duplicates([...this.projectsByPath.values()]);

    for (const item of this.inboxItemsByPath.values()) {
      if (duplicateInboxItemIds.has(item.id)) {
        issues.push({ path: item.file.path, kind: "duplicate-id", message: `Duplicate Inbox Item ID '${item.id}'` });
      } else inboxItemsById.set(item.id, item);
    }
    for (const action of this.actionsByPath.values()) {
      if (duplicateActionIds.has(action.id)) {
        issues.push({ path: action.file.path, kind: "duplicate-id", message: `Duplicate Action ID '${action.id}'` });
      } else actionsById.set(action.id, action);
    }
    for (const project of this.projectsByPath.values()) {
      if (duplicateProjectIds.has(project.id)) {
        issues.push({ path: project.file.path, kind: "duplicate-id", message: `Duplicate Project ID '${project.id}'` });
      } else projectsById.set(project.id, project);
    }
    for (const project of projectsById.values()) {
      const message = projectHierarchyIssue(project, projectsById);
      if (message) issues.push({ path: project.file.path, kind: "invalid", message });
    }
    // Trees that break the rule, from before it was enforced or from edits by hand.
    for (const { project, inactiveAncestor } of strandedProjects([...projectsById.values()])) {
      issues.push({
        path: project.file.path,
        kind: "stranded",
        message: `Active, but “${inactiveAncestor.title}” above it is ${projectStatusLabel(inactiveAncestor.status)}. `
          + "Activate that Project or park this one.",
      });
    }

    this.current = {
      revision: this.current.revision + 1,
      inboxItems: [...this.inboxItemsByPath.values()],
      actions: [...this.actionsByPath.values()],
      projects: [...this.projectsByPath.values()],
      inboxItemsById,
      actionsById,
      projectsById,
      issues,
    };
  }

  /** `getSnapshot` is current at once; the listeners hear of a burst of changes once. */
  private scheduleNotify(): void {
    if (this.notifyTimer !== null) {
      if (performance.now() - this.pendingSince >= NOTIFY_MAX_WAIT_MS) return;
      window.clearTimeout(this.notifyTimer);
    } else {
      this.pendingSince = performance.now();
    }
    this.notifyTimer = window.setTimeout(() => {
      this.notifyTimer = null;
      if (!timingLog()) {
        for (const listener of this.listeners.keys()) listener();
        return;
      }
      // Each listener takes in the new data now (an Elm view updates its model); the
      // views draw in the next frame, which the last line measures.
      const told = performance.now();
      const costs: string[] = [];
      for (const [listener, name] of this.listeners) {
        const start = performance.now();
        listener();
        costs.push(`${name} ${Math.round(performance.now() - start)} ms`);
      }
      logTiming("Views told", performance.now() - told, `${Math.round(told - this.pendingSince)} ms after the change; ${costs.join(", ")}`);
      window.requestAnimationFrame(() => logTiming("Views drawn", performance.now() - told, "since they were told"));
    }, NOTIFY_DELAY_MS);
  }
}

function rawInboxItem(file: TFile): InboxItem {
  return {
    type: "gtd-inbox-item",
    id: rawInboxId(file.path),
    title: file.extension === "md" ? file.basename : file.name,
    created: localDate(new Date(file.stat.ctime)),
    file,
    raw: true,
  };
}

function duplicates<T extends { id: string }>(entities: T[]): Set<string> {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const entity of entities) {
    if (seen.has(entity.id)) result.add(entity.id);
    seen.add(entity.id);
  }
  return result;
}
