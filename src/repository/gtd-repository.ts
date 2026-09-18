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
  InboxProcessingInput,
  Project,
  ProjectChanges,
  ProjectInput,
} from "../domain/types";
import { projectBreadcrumb, projectHierarchyIssue, wouldCreateProjectCycle } from "../domain/project-hierarchy";
import { localDate } from "../utils/date";
import { noteBody, parseDiaryEntries, prependMarkdownSectionLine, readMarkdownSection, setMarkdownSection, type DiaryEntry } from "../utils/markdown";
import { normalizeVaultPath, parentPath, safeName } from "../utils/path";
import { createUlid } from "../utils/ulid";
import { GtdIndex } from "./gtd-index";

const PROJECT_SUPPORT_ROOT = "Project Support Material";

export class GtdRepository {
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly app: App,
    readonly index: GtdIndex,
    private readonly getSettings: () => GtdSettings,
  ) {}

  async createInboxItem(title: string, details = ""): Promise<TFile> {
    return (await this.createInboxRecord(title, details)).file;
  }

  async createClarifiedAction(input: ActionInput): Promise<void> {
    const item = await this.createInboxRecord(input.title);
    await this.convertInboxItemToAction(item, input);
  }

  private async createInboxRecord(title: string, details = ""): Promise<InboxItem> {
    const id = createUlid();
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new Error("An Inbox Item title is required.");
    const directory = await this.ensureFolder(normalizeVaultPath(this.getSettings().inboxDirectory) || "GTD/Inbox");
    const path = this.uniqueMarkdownPath(directory, cleanTitle, id);
    const frontmatter: Record<string, unknown> = {
      type: "gtd-inbox-item",
      id,
      title: cleanTitle,
      created: localDate(),
    };
    const body = `# ${cleanTitle}\n\n${details.trim()}${details.trim() ? "\n" : ""}`;
    const file = await this.app.vault.create(path, markdown(frontmatter, body));
    return { type: "gtd-inbox-item", id, title: cleanTitle, created: String(frontmatter.created), file };
  }

  private async convertInboxItemToAction(item: InboxItem, input: ActionInput, resolvedProject?: Project): Promise<void> {
    const project = resolvedProject ?? (input.projectId ? this.index.getSnapshot().projectsById.get(input.projectId) : undefined);
    if (input.projectId && !project) throw new Error("The selected Project no longer exists.");
    const directory = await this.ensureFolder(normalizeVaultPath(this.getSettings().actionsDirectory) || "GTD/Actions");
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

  private async fileInboxItemToProject(item: InboxItem, project: Project): Promise<void> {
    const supportPath = await this.ensureProjectSupportPath(project);
    await this.enqueue(item.file.path, async () => {
      await this.clearEntityFrontmatter(item.file);
      const target = this.uniqueMarkdownPath(supportPath, item.title, item.id);
      if (target !== item.file.path) await this.app.fileManager.renameFile(item.file, target);
    });
  }

  private async fileInboxItemToGeneralReference(item: InboxItem): Promise<void> {
    const directory = await this.ensureFolder(normalizeVaultPath(this.getSettings().referenceDirectory) || "General Reference");
    await this.enqueue(item.file.path, async () => {
      await this.clearEntityFrontmatter(item.file);
      const target = this.uniqueMarkdownPath(directory, item.title, item.id);
      if (target !== item.file.path) await this.app.fileManager.renameFile(item.file, target);
    });
  }

  async trashInboxItem(itemOrId: InboxItem | string): Promise<void> {
    const item = this.resolveInboxItem(itemOrId);
    await this.app.fileManager.trashFile(item.file);
  }

  async trashAction(id: string): Promise<void> {
    const action = this.requireAction(id);
    await this.app.fileManager.trashFile(action.file);
  }

  async trashProject(id: string): Promise<void> {
    const project = this.requireProject(id);
    const snapshot = this.index.getSnapshot();
    const children = snapshot.projects.filter((candidate) => candidate.parentProjectId === project.id);
    if (children.length) {
      throw new Error(`Move or delete ${children.length} sub-project${children.length === 1 ? "" : "s"} before deleting this Project.`);
    }

    const actions = snapshot.actions.filter((action) => action.projectId === project.id);
    const supportPath = normalizeVaultPath(project.supportPath ?? "");
    const supportEntry = supportPath ? this.app.vault.getAbstractFileByPath(supportPath) : null;
    if (supportEntry && !(supportEntry instanceof TFolder)) {
      throw new Error(`Project support path is not a folder: ${supportPath}`);
    }

    if (supportEntry instanceof TFolder) {
      const unrelatedProjects = snapshot.projects.filter((candidate) =>
        candidate.id !== project.id && pathIsWithin(candidate.file.path, supportPath)
      );
      const unrelatedActions = snapshot.actions.filter((action) =>
        action.projectId !== project.id && pathIsWithin(action.file.path, supportPath)
      );
      const inboxItems = snapshot.inboxItems.filter((item) => pathIsWithin(item.file.path, supportPath));
      if (unrelatedProjects.length || unrelatedActions.length || inboxItems.length) {
        throw new Error("The support folder contains unrelated GTD entities. Move them before deleting this Project.");
      }
    }

    for (const action of actions) {
      if (!supportPath || !pathIsWithin(action.file.path, supportPath)) {
        await this.app.fileManager.trashFile(action.file);
      }
    }
    if (supportEntry instanceof TFolder) await this.app.fileManager.trashFile(supportEntry);
    if (!supportPath || !pathIsWithin(project.file.path, supportPath)) {
      await this.app.fileManager.trashFile(project.file);
    }
  }

  async processInboxAsNextAction(itemOrId: InboxItem | string, input: InboxProcessingInput): Promise<void> {
    const item = this.resolveInboxItem(itemOrId);
    const title = requiredProcessingValue(input.nextAction, "A Next Action is required.");
    const context = requiredProcessingValue(input.context, "A context is required.");
    const project = await this.prepareProcessingProject(input, "active");
    await this.convertInboxItemToAction(item, actionInput(title, context, project), project);
  }

  async processInboxAsReference(itemOrId: InboxItem | string, input: InboxProcessingInput): Promise<void> {
    const item = this.resolveInboxItem(itemOrId);
    const title = input.nextAction?.trim() ?? "";
    const context = input.context?.trim() ?? "";
    if (title && !context) throw new Error("A context is required when creating a Next Action.");
    const project = await this.prepareProcessingProject(input, "active");

    if (title) await this.createNextActionFile(title, context, item.created, project);
    if (project) await this.fileInboxItemToProject(item, project);
    else await this.fileInboxItemToGeneralReference(item);
  }

  async processInboxAsSomedayProject(itemOrId: InboxItem | string, input: InboxProcessingInput): Promise<void> {
    const item = this.resolveInboxItem(itemOrId);
    const title = requiredProcessingValue(input.nextAction, "A Next Action is required.");
    const context = requiredProcessingValue(input.context, "A context is required.");
    const project = await this.prepareProcessingProject(input, "someday", title, true);
    if (!project) throw new Error("Could not create the Someday/Maybe Project.");

    await this.createNextActionFile(title, context, item.created, project);
    await this.fileInboxItemToProject(item, project);
  }

  async createProject(input: ProjectInput): Promise<TFile> {
    return (await this.createProjectRecord(input)).file;
  }

  private async createProjectRecord(input: ProjectInput & { desiredOutcome?: string }): Promise<Project> {
    const id = createUlid();
    const title = input.title.trim();
    if (!title) throw new Error("A Project title is required.");
    const parent = input.parentProjectId ? this.index.getSnapshot().projectsById.get(input.parentProjectId) : undefined;
    if (input.parentProjectId && !parent) throw new Error("The selected parent Project no longer exists.");
    if (parent && projectHierarchyIssue(parent, this.index.getSnapshot().projectsById)) {
      throw new Error("The selected parent Project has an invalid hierarchy.");
    }
    const directory = await this.ensureFolder(normalizeVaultPath(this.getSettings().projectsDirectory) || "GTD/Projects");
    const path = this.uniqueMarkdownPath(directory, title, id);
    const supportRoot = await this.ensureFolder(PROJECT_SUPPORT_ROOT);
    const supportPath = this.uniqueFolderPath(supportRoot, title, id);
    await this.ensureFolder(supportPath);
    const status = input.status ?? "active";
    const created = localDate();
    const frontmatter: Record<string, unknown> = {
      type: "gtd-project",
      id,
      title,
      status,
      area: input.area || null,
      created,
      reviewed: null,
      completed: null,
      support_path: supportPath,
      parent_project_id: parent?.id ?? null,
      parent_project: parent ? wikiLink(parent) : null,
    };
    const body = `# ${title}\n\n## Desired outcome\n\n${input.desiredOutcome?.trim() ?? ""}\n\n## Notes\n\n\n\n## Support material\n\n\`${supportPath}/\`\n`;
    const file = await this.app.vault.create(path, markdown(frontmatter, body));
    const project: Project = { type: "gtd-project", id, title, status, created, file, supportPath };
    if (input.area?.trim()) project.area = input.area.trim();
    if (parent) {
      project.parentProjectId = parent.id;
      project.parentProjectLink = wikiLink(parent);
    }
    return project;
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
    const parent = changes.parentProjectId
      ? this.index.getSnapshot().projectsById.get(changes.parentProjectId)
      : undefined;
    if (changes.parentProjectId && !parent) throw new Error("The selected parent Project no longer exists.");
    if (parent && projectHierarchyIssue(parent, this.index.getSnapshot().projectsById)) {
      throw new Error("The selected parent Project has an invalid hierarchy.");
    }
    if (parent && wouldCreateProjectCycle(project.id, parent.id, this.index.getSnapshot().projectsById)) {
      throw new Error("A Project cannot be its own parent or a descendant of itself.");
    }
    await this.enqueue(project.file.path, async () => {
      const oldTitle = project.title;
      let supportPath = changes.supportPath ?? project.supportPath;
      if (changes.title && changes.title.trim() !== oldTitle && project.supportPath) {
        const generatedOldPaths = [PROJECT_SUPPORT_ROOT, "Projects"].map((root) => normalizePath(`${root}/${safeName(oldTitle)}`));
        if (generatedOldPaths.includes(project.supportPath)) {
          const target = this.uniqueFolderPath(PROJECT_SUPPORT_ROOT, changes.title.trim(), project.id, project.supportPath);
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
        if (changes.parentProjectId !== undefined) {
          frontmatter.parent_project_id = parent?.id ?? null;
          frontmatter.parent_project = parent ? wikiLink(parent) : null;
        }
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
    return readMarkdownSection(content, "Desired outcome");
  }

  async setDesiredOutcome(projectId: string, desiredOutcome: string): Promise<void> {
    const project = this.requireProject(projectId);
    await this.enqueue(project.file.path, () => this.app.vault.process(
      project.file,
      (content) => setMarkdownSection(content, "Desired outcome", desiredOutcome),
    ));
  }

  async readInboxBody(item: InboxItem): Promise<string> {
    return noteBody(await this.app.vault.cachedRead(item.file), item.title);
  }

  async readProjectDiary(project: Project): Promise<DiaryEntry[]> {
    return parseDiaryEntries(await this.app.vault.cachedRead(project.file));
  }

  async addProjectDiaryEntry(projectId: string, text: string): Promise<DiaryEntry> {
    const project = this.requireProject(projectId);
    const clean = text.trim();
    if (!clean) throw new Error("A diary entry is required.");
    const timestamp = localDateTime();
    await this.enqueue(project.file.path, () => this.app.vault.process(
      project.file,
      (content) => prependMarkdownSectionLine(content, "Diary", `- **${timestamp}** — ${clean}`),
    ));
    return { timestamp, text: clean };
  }

  async markProjectReviewed(projectId: string): Promise<void> {
    await this.updateProject(projectId, { reviewed: localDate() });
  }

  async saveBrainstorm(actionId: string, ideas: string, desiredOutcome?: string): Promise<TFile> {
    const action = this.requireAction(actionId);
    const cleanIdeas = ideas.trim();
    if (!cleanIdeas) throw new Error("Brainstorming notes are required.");
    const project = action.projectId ? this.index.getSnapshot().projectsById.get(action.projectId) : undefined;
    const date = localDate();
    const title = `Brainstorm - ${action.title}`;
    const visionBlock = desiredOutcome?.trim() ? `\n## Desired outcome\n\n${desiredOutcome.trim()}\n` : "";
    let file: TFile;
    if (project) {
      const supportPath = await this.ensureProjectSupportPath(project);
      const path = this.uniqueMarkdownPath(supportPath, `${title} ${date}`, action.id);
      const body = `# ${title}\n\n*${date}*\n${visionBlock}\n## Ideas\n\n${cleanIdeas}\n`;
      file = await this.app.vault.create(path, body);
      if (desiredOutcome !== undefined) await this.setDesiredOutcome(project.id, desiredOutcome);
    } else {
      file = await this.createInboxItem(title, `${visionBlock}\n## Ideas\n\n${cleanIdeas}`);
    }
    await this.updateAction(action.id, { status: "done" });
    return file;
  }

  async saveStandaloneBrainstorm(topic: string, ideas: string): Promise<TFile> {
    const cleanTopic = topic.trim();
    const cleanIdeas = ideas.trim();
    if (!cleanTopic) throw new Error("A brainstorming topic is required.");
    if (!cleanIdeas) throw new Error("Brainstorming notes are required.");
    return this.createInboxItem(`Brainstorm - ${cleanTopic}`, `## Ideas\n\n${cleanIdeas}`);
  }

  private async createNextActionFile(title: string, context: string, captured: string, project?: Project): Promise<TFile> {
    const id = createUlid();
    const directory = await this.ensureFolder(normalizeVaultPath(this.getSettings().actionsDirectory) || "GTD/Actions");
    const path = this.uniqueMarkdownPath(directory, title, id);
    const frontmatter: Record<string, unknown> = {
      type: "gtd-action",
      id,
      title,
      status: "next",
      project_id: project?.id ?? null,
      project: project ? wikiLink(project) : null,
      context,
      energy: null,
      due: null,
      defer_until: null,
      captured,
      created: localDate(),
      completed: null,
    };
    return this.app.vault.create(path, markdown(frontmatter, `# ${title}\n\n## Done when\n\n`));
  }

  private async prepareProcessingProject(
    input: InboxProcessingInput,
    newProjectStatus: Project["status"],
    fallbackTitle = "",
    updateExistingStatus = false,
  ): Promise<Project | undefined> {
    const snapshot = this.index.getSnapshot();
    let project: Project | undefined;
    if (input.projectId) {
      project = snapshot.projectsById.get(input.projectId);
      if (!project) throw new Error("The selected Project no longer exists.");
    } else if (input.projectTitle?.trim()) {
      const normalized = input.projectTitle.trim().toLocaleLowerCase();
      project = snapshot.projects.find((candidate) =>
        candidate.title.toLocaleLowerCase() === normalized
        || projectBreadcrumb(candidate, snapshot.projectsById).toLocaleLowerCase() === normalized
      );
    }

    const desiredOutcome = input.desiredOutcome?.trim() ?? "";
    if (project) {
      if (updateExistingStatus && project.status !== newProjectStatus) {
        await this.updateProject(project.id, { status: newProjectStatus });
        project = { ...project, status: newProjectStatus };
      }
      if (desiredOutcome) await this.setDesiredOutcomeForProject(project, desiredOutcome);
      return project;
    }

    const title = input.projectTitle?.trim() || fallbackTitle.trim();
    if (!title) return undefined;
    return this.createProjectRecord({
      title,
      status: newProjectStatus,
      ...(desiredOutcome ? { desiredOutcome } : {}),
    });
  }

  private async setDesiredOutcomeForProject(project: Project, desiredOutcome: string): Promise<void> {
    await this.enqueue(project.file.path, () => this.app.vault.process(
      project.file,
      (content) => setMarkdownSection(content, "Desired outcome", desiredOutcome),
    ));
  }

  supportFiles(project: Project): TFile[] {
    if (!project.supportPath) return [];
    const prefix = `${project.supportPath}/`;
    return this.app.vault.getFiles().filter((file) => file.path.startsWith(prefix));
  }

  private async ensureProjectSupportPath(project: Project): Promise<string> {
    const supportRoot = await this.ensureFolder(PROJECT_SUPPORT_ROOT);
    const requestedPath = project.supportPath || this.uniqueFolderPath(supportRoot, project.title, project.id);
    const supportPath = await this.ensureFolder(requestedPath);
    if (!project.supportPath) {
      await this.app.fileManager.processFrontMatter(project.file, (frontmatter) => {
        frontmatter.support_path = supportPath;
      });
    }
    return supportPath;
  }

  private async clearEntityFrontmatter(file: TFile): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, clearGtdFrontmatter);
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

  private resolveInboxItem(itemOrId: InboxItem | string): InboxItem {
    if (typeof itemOrId === "string") return this.requireInboxItem(itemOrId);
    const current = this.app.vault.getAbstractFileByPath(itemOrId.file.path);
    if (!(current instanceof TFile)) throw new Error(`Inbox Item '${itemOrId.id}' no longer exists.`);
    return { ...itemOrId, file: current };
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

  private async ensureFolder(path: string): Promise<string> {
    if (!path) return "";
    const normalized = normalizePath(path);
    const indexed = this.app.vault.getAbstractFileByPath(normalized);
    if (indexed instanceof TFolder) return indexed.path;
    if (indexed) throw new Error(`A file already exists where a folder is required: ${normalized}`);
    const caseInsensitiveMatch = this.app.vault.getAllLoadedFiles().find((entry): entry is TFolder =>
      entry instanceof TFolder && entry.path.toLocaleLowerCase() === normalized.toLocaleLowerCase()
    );
    if (caseInsensitiveMatch) return caseInsensitiveMatch.path;
    const adapterEntry = await this.app.vault.adapter.stat(normalized);
    if (adapterEntry?.type === "folder") return normalized;
    if (adapterEntry) throw new Error(`A file already exists where a folder is required: ${normalized}`);
    const parent = parentPath(normalized);
    let target = normalized;
    if (parent) {
      const canonicalParent = await this.ensureFolder(parent);
      target = normalizePath(`${canonicalParent}/${normalized.slice(parent.length + 1)}`);
    }
    try {
      const created = await this.app.vault.createFolder(target);
      return created.path;
    } catch (error) {
      const created = this.app.vault.getAbstractFileByPath(target);
      const createdOnAdapter = created ? null : await this.app.vault.adapter.stat(target);
      if (created instanceof TFolder) return created.path;
      if (createdOnAdapter?.type === "folder") return target;
      throw error;
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

function clearGtdFrontmatter(frontmatter: Record<string, unknown>): void {
  for (const key of [
    "type",
    "id",
    "status",
    "project_id",
    "project",
    "context",
    "energy",
    "due",
    "defer_until",
    "completed",
    "area",
    "reviewed",
    "support_path",
    "parent_project_id",
    "parent_project",
  ]) delete frontmatter[key];
}

function localDateTime(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function requiredProcessingValue(value: string | undefined, message: string): string {
  const clean = value?.trim() ?? "";
  if (!clean) throw new Error(message);
  return clean;
}

function actionInput(title: string, context: string, project?: Project): ActionInput {
  return {
    title,
    status: "next",
    context,
    ...(project ? { projectId: project.id } : {}),
  };
}

function pathIsWithin(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}
