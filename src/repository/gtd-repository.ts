import {
  App,
  normalizePath,
  stringifyYaml,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import type {
  Action,
  ActionChanges,
  ActionInput,
  GtdSettings,
  InboxItem,
  Project,
  ProjectChanges,
  ProjectInput,
} from "../domain/types";
import { localDate } from "../utils/date";
import { normalizeVaultPath, parentPath, safeName } from "../utils/path";
import { createUlid } from "../utils/ulid";
import { GtdIndex } from "./gtd-index";

export class GtdRepository {
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly app: App,
    readonly index: GtdIndex,
    private readonly getSettings: () => GtdSettings,
  ) {}

  async createInboxItem(title: string): Promise<TFile> {
    const id = createUlid();
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new Error("An Inbox Item title is required.");
    const directory = normalizeVaultPath(this.getSettings().inboxDirectory) || "GTD/Inbox";
    await this.ensureFolder(directory);
    const path = this.uniqueMarkdownPath(directory, cleanTitle, id);
    const frontmatter: Record<string, unknown> = {
      type: "gtd-inbox-item",
      id,
      title: cleanTitle,
      created: localDate(),
    };
    return this.app.vault.create(path, markdown(frontmatter, `# ${cleanTitle}\n\n`));
  }

  async processInboxItem(id: string, input: ActionInput): Promise<void> {
    const item = this.requireInboxItem(id);
    const project = input.projectId ? this.index.getSnapshot().projectsById.get(input.projectId) : undefined;
    if (input.projectId && !project) throw new Error("The selected Project no longer exists.");
    const directory = normalizeVaultPath(this.getSettings().actionsDirectory) || "GTD/Actions";
    await this.ensureFolder(directory);
    await this.enqueue(item.file.path, async () => {
      const oldTitle = item.title;
      const title = input.title.trim();
      if (!title) throw new Error("An Action title is required.");
      await this.app.fileManager.processFrontMatter(item.file, (frontmatter) => {
        frontmatter.type = "gtd-action";
        frontmatter.id = item.id;
        frontmatter.title = title;
        frontmatter.status = input.status;
        frontmatter.project_id = input.projectId ?? null;
        frontmatter.project = project ? wikiLink(project) : null;
        frontmatter.context = input.context || null;
        frontmatter.energy = input.energy || null;
        frontmatter.due = input.due || null;
        frontmatter.defer_until = input.deferUntil || null;
        frontmatter.captured = item.created;
        frontmatter.created = localDate();
        frontmatter.completed = null;
      });
      if (title !== oldTitle) await this.updateGeneratedHeading(item.file, oldTitle, title);
      await this.ensureDoneWhenSection(item.file);
      const target = this.uniqueMarkdownPath(directory, title, item.id);
      if (target !== item.file.path) await this.app.fileManager.renameFile(item.file, target);
    });
  }

  async createProject(input: ProjectInput): Promise<TFile> {
    const id = createUlid();
    const directory = normalizeVaultPath(this.getSettings().projectsDirectory) || "GTD/Projects";
    await this.ensureFolder(directory);
    const path = this.uniqueMarkdownPath(directory, input.title, id);
    const supportPath = this.uniqueFolderPath("Projects", input.title, id);
    await this.ensureFolder(supportPath);
    const frontmatter: Record<string, unknown> = {
      type: "gtd-project",
      id,
      title: input.title.trim(),
      status: input.status ?? "active",
      area: input.area || null,
      created: localDate(),
      reviewed: null,
      completed: null,
      support_path: supportPath,
    };
    const body = `# ${input.title.trim()}\n\n## Desired outcome\n\n\n\n## Notes\n\n\n\n## Support material\n\n\`${supportPath}/\`\n`;
    return this.app.vault.create(path, markdown(frontmatter, body));
  }

  async updateAction(id: string, changes: ActionChanges): Promise<void> {
    const action = this.requireAction(id);
    await this.enqueue(action.file.path, async () => {
      const oldTitle = action.title;
      const project = changes.projectId ? this.index.getSnapshot().projectsById.get(changes.projectId) : undefined;
      if (changes.projectId && !project) throw new Error("The selected Project no longer exists.");
      await this.app.fileManager.processFrontMatter(action.file, (frontmatter) => {
        if (changes.title !== undefined) frontmatter.title = changes.title.trim();
        if (changes.status !== undefined) {
          frontmatter.status = changes.status;
          if (changes.status !== action.status) frontmatter.completed = changes.status === "done" ? new Date().toISOString() : null;
        }
        if (changes.projectId !== undefined) {
          frontmatter.project_id = changes.projectId || null;
          frontmatter.project = project ? wikiLink(project) : null;
        }
        if (changes.context !== undefined) frontmatter.context = changes.context || null;
        if (changes.energy !== undefined) frontmatter.energy = changes.energy || null;
        if (changes.due !== undefined) frontmatter.due = changes.due || null;
        if (changes.deferUntil !== undefined) frontmatter.defer_until = changes.deferUntil || null;
      });
      if (changes.title && changes.title.trim() !== oldTitle) {
        await this.updateGeneratedHeading(action.file, oldTitle, changes.title.trim());
        await this.renameMarkdownFile(action.file, changes.title.trim(), action.id);
      }
    });
  }

  async setActionStatus(id: string, status: Action["status"]): Promise<void> {
    return this.updateAction(id, { status });
  }

  async reopenAction(id: string): Promise<void> {
    return this.updateAction(id, { status: "next" });
  }

  async updateProject(id: string, changes: ProjectChanges): Promise<void> {
    const project = this.requireProject(id);
    await this.enqueue(project.file.path, async () => {
      const oldTitle = project.title;
      let supportPath = changes.supportPath ?? project.supportPath;
      if (changes.title && changes.title.trim() !== oldTitle && project.supportPath) {
        const generatedOld = normalizePath(`Projects/${safeName(oldTitle)}`);
        if (project.supportPath === generatedOld) {
          const target = this.uniqueFolderPath("Projects", changes.title.trim(), project.id, project.supportPath);
          const folder = this.app.vault.getAbstractFileByPath(project.supportPath);
          if (folder instanceof TFolder && target !== project.supportPath) {
            await this.app.vault.rename(folder, target);
            supportPath = target;
          }
        }
      }
      await this.app.fileManager.processFrontMatter(project.file, (frontmatter) => {
        if (changes.title !== undefined) frontmatter.title = changes.title.trim();
        if (changes.status !== undefined) {
          frontmatter.status = changes.status;
          if (changes.status !== project.status) frontmatter.completed = changes.status === "completed" ? new Date().toISOString() : null;
        }
        if (changes.area !== undefined) frontmatter.area = changes.area || null;
        if (changes.reviewed !== undefined) frontmatter.reviewed = changes.reviewed || null;
        if (supportPath !== undefined) frontmatter.support_path = supportPath || null;
      });
      if (project.supportPath && supportPath && project.supportPath !== supportPath) {
        await this.updateSupportPathInBody(project.file, project.supportPath, supportPath);
      }
      if (changes.title && changes.title.trim() !== oldTitle) {
        await this.updateGeneratedHeading(project.file, oldTitle, changes.title.trim());
        await this.renameMarkdownFile(project.file, changes.title.trim(), project.id);
      }
    });
  }

  async setProjectStatus(id: string, status: Project["status"]): Promise<void> {
    return this.updateProject(id, { status });
  }

  async readDesiredOutcome(project: Project): Promise<string> {
    const content = await this.app.vault.cachedRead(project.file);
    const match = /^## Desired outcome\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(content);
    return match?.[1]?.trim() ?? "";
  }

  supportFiles(project: Project): TFile[] {
    if (!project.supportPath) return [];
    const prefix = `${project.supportPath}/`;
    return this.app.vault.getFiles().filter((file) => file.path.startsWith(prefix));
  }

  private requireAction(id: string): Action {
    const action = this.index.getSnapshot().actionsById.get(id);
    if (!action) throw new Error(`Action '${id}' is missing or has a duplicate ID.`);
    return action;
  }

  private requireInboxItem(id: string): InboxItem {
    const item = this.index.getSnapshot().inboxItemsById.get(id);
    if (!item) throw new Error(`Inbox Item '${id}' is missing or has a duplicate ID.`);
    return item;
  }

  private requireProject(id: string): Project {
    const project = this.index.getSnapshot().projectsById.get(id);
    if (!project) throw new Error(`Project '${id}' is missing or has a duplicate ID.`);
    return project;
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.queues.set(key, result);
    const cleanup = () => {
      if (this.queues.get(key) === result) this.queues.delete(key);
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    const normalized = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(normalized)) return;
    const parent = parentPath(normalized);
    if (parent) await this.ensureFolder(parent);
    try {
      await this.app.vault.createFolder(normalized);
    } catch (error) {
      if (!this.app.vault.getAbstractFileByPath(normalized)) throw error;
    }
  }

  private uniqueMarkdownPath(directory: string, title: string, id: string, currentPath?: string): string {
    const clean = safeName(title);
    const first = normalizePath(`${directory}/${clean}.md`);
    if (first === currentPath || !this.app.vault.getAbstractFileByPath(first)) return first;
    const suffixed = normalizePath(`${directory}/${clean} - ${id.slice(-4)}.md`);
    if (suffixed === currentPath || !this.app.vault.getAbstractFileByPath(suffixed)) return suffixed;
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(normalizePath(`${directory}/${clean} - ${id.slice(-4)}-${counter}.md`))) counter += 1;
    return normalizePath(`${directory}/${clean} - ${id.slice(-4)}-${counter}.md`);
  }

  private uniqueFolderPath(root: string, title: string, id: string, currentPath?: string): string {
    const clean = safeName(title);
    const first = normalizePath(`${root}/${clean}`);
    if (first === currentPath || !this.app.vault.getAbstractFileByPath(first)) return first;
    return normalizePath(`${root}/${clean} - ${id.slice(-4)}`);
  }

  private async renameMarkdownFile(file: TFile, title: string, id: string): Promise<void> {
    const directory = parentPath(file.path);
    const target = this.uniqueMarkdownPath(directory, title, id, file.path);
    if (target !== file.path) await this.app.fileManager.renameFile(file, target);
  }

  private async updateGeneratedHeading(file: TFile, oldTitle: string, newTitle: string): Promise<void> {
    await this.app.vault.process(file, (content) => {
      const oldHeading = `# ${oldTitle}`;
      const index = content.indexOf(oldHeading);
      if (index < 0) return content;
      const lineStart = content.lastIndexOf("\n", index - 1) + 1;
      const lineEnd = content.indexOf("\n", index);
      if (lineStart !== index || content.slice(index, lineEnd < 0 ? undefined : lineEnd) !== oldHeading) return content;
      return `${content.slice(0, index)}# ${newTitle}${content.slice(index + oldHeading.length)}`;
    });
  }

  private async updateSupportPathInBody(file: TFile, oldPath: string, newPath: string): Promise<void> {
    await this.app.vault.process(file, (content) => content.replace(`\`${oldPath}/\``, `\`${newPath}/\``));
  }

  private async ensureDoneWhenSection(file: TFile): Promise<void> {
    await this.app.vault.process(file, (content) => /^## Done when\s*$/m.test(content) ? content : `${content.trimEnd()}\n\n## Done when\n\n`);
  }
}

function markdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}`;
}

function wikiLink(project: Project): string {
  const path = project.file.path.replace(/\.md$/i, "");
  return `[[${path}|${project.title}]]`;
}
