import { MetadataCache, Plugin, TAbstractFile, TFile, Vault } from "obsidian";
import type { Action, GtdSnapshot, InboxItem, IndexIssue, Project } from "../domain/types";
import { parseAction, parseInboxItem, parseProject } from "../domain/validation";
import { projectHierarchyIssue } from "../domain/project-hierarchy";
import { localDate } from "../utils/date";
import { isPathInDirectory, rawInboxId } from "../utils/path";

type Listener = () => void;

export class GtdIndex {
  private inboxItemsByPath = new Map<string, InboxItem>();
  private actionsByPath = new Map<string, Action>();
  private projectsByPath = new Map<string, Project>();
  private parseIssues = new Map<string, IndexIssue>();
  private listeners = new Set<Listener>();
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

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
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
    for (const listener of this.listeners) listener();
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
