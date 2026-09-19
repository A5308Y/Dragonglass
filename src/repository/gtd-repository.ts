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
import { normalizeProjectTags, wouldCreateProjectDependencyCycle } from "../domain/project-board";
import { projectBreadcrumb, projectHierarchyIssue, wouldCreateProjectCycle } from "../domain/project-hierarchy";
import { normalizeTimestamp } from "../domain/validation";
import { localDate } from "../utils/date";
import { diaryEntryMarkdown, noteBody, parseDiaryEntries, prependMarkdownSectionLine, readMarkdownSection, replaceNoteBody, setMarkdownSection, type DiaryEntry } from "../utils/markdown";
import { baseName, generatedFolderNames, normalizeVaultPath, parentPath, safeName } from "../utils/path";
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
    if (!input.context.trim()) throw new Error("A context is required.");
    validateActionSchedule(input.status, input.scheduledStart, input.durationMinutes);
    const item = await this.createInboxRecord(input.title);
    await this.convertInboxItemToAction(item, input);
  }

  /** Creates Action files straight from a pasted list. Returns how many were written. */
  async importActions(inputs: readonly ActionInput[]): Promise<number> {
    if (inputs.some((input) => input.title.trim() && !input.context.trim())) {
      throw new Error("Every imported Action needs a context.");
    }
    for (const input of inputs) validateActionSchedule(input.status, input.scheduledStart, input.durationMinutes);
    const captured = localDate();
    let created = 0;
    for (const input of inputs) {
      const title = input.title.trim();
      if (!title) continue;
      const project = input.projectId ? this.index.getSnapshot().projectsById.get(input.projectId) : undefined;
      if (input.projectId && !project) throw new Error("The selected Project no longer exists.");
      await this.createActionFile(title, input, captured, project);
      created += 1;
    }
    return created;
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
    const title = input.title.trim();
    if (!title) throw new Error("An Action title is required.");
    const context = input.context.trim();
    if (!context) throw new Error("A context is required.");
    if (item.file.extension !== "md") {
      await this.createNextActionFile(title, context, item.created, project, input.work ?? false);
      if (project) await this.fileInboxItemToProject(item, project);
      else await this.fileInboxItemToGeneralReference(item);
      return;
    }
    await this.enqueue(item.file.path, async () => {
      const oldTitle = item.title;
      const actionId = item.raw ? createUlid() : item.id;
      await this.app.fileManager.processFrontMatter(item.file, (frontmatter) => {
        frontmatter.type = "gtd-action";
        frontmatter.id = actionId;
        frontmatter.title = title;
        frontmatter.status = input.status;
        frontmatter.project_id = input.projectId ?? null;
        frontmatter.project = project ? wikiLink(project) : null;
        frontmatter.context = context;
        frontmatter.energy = input.energy || null;
        frontmatter.due = input.due || null;
        frontmatter.defer_until = input.deferUntil || null;
        frontmatter.scheduled_start = input.scheduledStart || null;
        frontmatter.duration_minutes = input.durationMinutes ?? null;
        frontmatter.work = input.work ?? false;
        frontmatter.captured = item.created;
        frontmatter.created = localDate();
        frontmatter.completed = null;
      });
      if (title !== oldTitle) await this.updateGeneratedHeading(item.file, oldTitle, title);
      await this.ensureDoneWhenSection(item.file);
      const target = this.uniqueMarkdownPath(directory, title, actionId);
      if (target !== item.file.path) await this.app.fileManager.renameFile(item.file, target);
    });
  }

  private async fileInboxItemToProject(item: InboxItem, project: Project): Promise<void> {
    const supportPath = await this.ensureProjectSupportPath(project);
    await this.enqueue(item.file.path, async () => {
      if (this.hasGtdFrontmatter(item.file)) await this.clearEntityFrontmatter(item.file);
      const target = this.uniqueInboxDestination(supportPath, item);
      if (target !== item.file.path) await this.app.fileManager.renameFile(item.file, target);
    });
  }

  private async fileInboxItemToGeneralReference(item: InboxItem): Promise<void> {
    const directory = await this.ensureFolder(normalizeVaultPath(this.getSettings().referenceDirectory) || "General Reference");
    await this.enqueue(item.file.path, async () => {
      if (this.hasGtdFrontmatter(item.file)) await this.clearEntityFrontmatter(item.file);
      const target = this.uniqueInboxDestination(directory, item);
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

  async convertActionToSubproject(id: string, title: string, parentProjectId: string): Promise<Project> {
    const action = this.requireAction(id);
    const parent = this.index.getSnapshot().projectsById.get(parentProjectId);
    if (!parent) throw new Error("The selected parent Project no longer exists.");
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new Error("A sub-project title is required.");
    const content = await this.app.vault.cachedRead(action.file);
    const project = await this.createProjectRecord({
      title: cleanTitle,
      status: "active",
      parentProjectId: parent.id,
      notes: projectNotesFromAction(content, action.title),
    });
    try {
      await this.app.fileManager.trashFile(action.file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Created the sub-project, but could not trash the original Action: ${reason}`);
    }
    return project;
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

    for (const dependent of snapshot.projects.filter((candidate) => candidate.blockedByProjectIds?.includes(project.id))) {
      await this.updateProject(dependent.id, {
        blockedByProjectIds: dependent.blockedByProjectIds!.filter((blockerId) => blockerId !== project.id),
      });
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
    await this.convertInboxItemToAction(item, actionInput(title, context, project, input.work), project);
  }

  async processInboxAsReference(itemOrId: InboxItem | string, input: InboxProcessingInput): Promise<void> {
    const item = this.resolveInboxItem(itemOrId);
    const title = input.nextAction?.trim() ?? "";
    const context = input.context?.trim() ?? "";
    if (title && !context) throw new Error("A context is required when creating a Next Action.");
    const project = await this.prepareProcessingProject(input, "active");

    if (title) await this.createNextActionFile(title, context, item.created, project, input.work ?? false);
    if (project) await this.fileInboxItemToProject(item, project);
    else await this.fileInboxItemToGeneralReference(item);
  }

  async processInboxAsSomedayProject(itemOrId: InboxItem | string, input: InboxProcessingInput): Promise<void> {
    const item = this.resolveInboxItem(itemOrId);
    const title = input.nextAction?.trim() ?? "";
    const context = input.context?.trim() ?? "";
    if (title && !context) throw new Error("A context is required when creating a Next Action.");
    // Someday/Maybe is for what is not actionable yet, so the Item's own title names the Project.
    const project = await this.prepareProcessingProject(input, "someday", title || item.title, true);
    if (!project) throw new Error("Could not create the Someday/Maybe Project.");

    if (title) await this.createNextActionFile(title, context, item.created, project, input.work ?? false);
    await this.fileInboxItemToProject(item, project);
  }

  async createProject(input: ProjectInput): Promise<TFile> {
    return (await this.createProjectRecord(input)).file;
  }

  private async createProjectRecord(input: ProjectInput & { desiredOutcome?: string; notes?: string }): Promise<Project> {
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
    const supportRoot = parent ? await this.ensureProjectSupportPath(parent) : await this.ensureFolder(PROJECT_SUPPORT_ROOT);
    const supportPath = this.uniqueFolderPath(supportRoot, title, id);
    await this.ensureFolder(supportPath);
    const status = input.status ?? "active";
    const created = localDate();
    const tags = normalizeProjectTags(input.tags ?? []);
    const siblingOrders = parent
      ? this.index.getSnapshot().projects.filter((candidate) => candidate.parentProjectId === parent.id).map((candidate) => candidate.order ?? 0)
      : [];
    const order = parent ? Math.max(0, ...siblingOrders) + 1_000 : undefined;
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
      image: input.image?.trim() || null,
      tags: tags.length ? tags : null,
      order: order ?? null,
      blocked_by_project_ids: null,
      parent_project_id: parent?.id ?? null,
      parent_project: parent ? wikiLink(parent) : null,
    };
    const body = `# ${title}\n\n## Desired outcome\n\n${input.desiredOutcome?.trim() ?? ""}\n\n## Notes\n\n${input.notes?.trim() ?? ""}\n\n## Support material\n\n\`${supportPath}/\`\n`;
    const file = await this.app.vault.create(path, markdown(frontmatter, body));
    const project: Project = { type: "gtd-project", id, title, status, created, file, supportPath };
    if (input.area?.trim()) project.area = input.area.trim();
    if (input.image?.trim()) project.image = input.image.trim();
    if (tags.length) project.tags = tags;
    if (order !== undefined) project.order = order;
    if (parent) {
      project.parentProjectId = parent.id;
      project.parentProjectLink = wikiLink(parent);
    }
    return project;
  }

  async updateAction(id: string, changes: ActionChanges): Promise<void> {
    const action = this.requireAction(id);
    if (changes.context !== undefined && !changes.context.trim()) throw new Error("A context is required.");
    validateActionSchedule(
      changes.status ?? action.status,
      changes.scheduledStart ?? action.scheduledStart,
      changes.durationMinutes ?? action.durationMinutes,
    );
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
        if (changes.context !== undefined) frontmatter.context = changes.context.trim();
        if (changes.energy !== undefined) frontmatter.energy = changes.energy || null;
        if (changes.due !== undefined) frontmatter.due = changes.due || null;
        if (changes.deferUntil !== undefined) frontmatter.defer_until = changes.deferUntil || null;
        if (changes.scheduledStart !== undefined) frontmatter.scheduled_start = changes.scheduledStart || null;
        if (changes.durationMinutes !== undefined) frontmatter.duration_minutes = changes.durationMinutes;
        if (changes.work !== undefined) frontmatter.work = changes.work;
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
    const snapshot = this.index.getSnapshot();
    const parent = changes.parentProjectId
      ? snapshot.projectsById.get(changes.parentProjectId)
      : undefined;
    if (changes.parentProjectId && !parent) throw new Error("The selected parent Project no longer exists.");
    if (parent && projectHierarchyIssue(parent, snapshot.projectsById)) {
      throw new Error("The selected parent Project has an invalid hierarchy.");
    }
    if (parent && wouldCreateProjectCycle(project.id, parent.id, snapshot.projectsById)) {
      throw new Error("A Project cannot be its own parent or a descendant of itself.");
    }
    const tags = changes.tags === undefined ? undefined : normalizeProjectTags(changes.tags);
    if (changes.order !== undefined && !Number.isFinite(changes.order)) throw new Error("Project order must be a finite number.");
    const blockers = changes.blockedByProjectIds === undefined
      ? undefined
      : [...new Set(changes.blockedByProjectIds.filter(Boolean))];
    if (blockers?.some((blockerId) => !snapshot.projectsById.has(blockerId))) {
      throw new Error("A blocking Project no longer exists.");
    }
    if (blockers && wouldCreateProjectDependencyCycle(project.id, blockers, snapshot.projectsById)) {
      throw new Error("Project dependencies cannot contain a cycle.");
    }
    await this.enqueue(project.file.path, async () => {
      const oldTitle = project.title;
      const newTitle = changes.title?.trim() || oldTitle;
      let supportPath = changes.supportPath ?? project.supportPath;
      // Only folders this plugin generated follow the Project; a hand-picked one stays put.
      const generated = Boolean(supportPath)
        && changes.supportPath === undefined
        && this.isGeneratedSupportFolder(supportPath!, oldTitle, project.id);

      if (generated && newTitle !== oldTitle) {
        supportPath = await this.moveSupportFolder(supportPath!, this.uniqueFolderPath(parentPath(supportPath!), newTitle, project.id, supportPath!));
      }
      if (generated && changes.parentProjectId !== undefined && (parent?.id ?? "") !== (project.parentProjectId ?? "")) {
        const desiredRoot = parent ? await this.ensureProjectSupportPath(parent) : await this.ensureFolder(PROJECT_SUPPORT_ROOT);
        if (parentPath(supportPath!) !== desiredRoot) {
          supportPath = await this.moveSupportFolder(supportPath!, this.uniqueFolderPath(desiredRoot, newTitle, project.id, supportPath!));
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
        if (changes.image !== undefined) frontmatter.image = changes.image.trim() || null;
        if (tags !== undefined) frontmatter.tags = tags.length ? tags : null;
        if (changes.order !== undefined) frontmatter.order = changes.order;
        if (blockers !== undefined) frontmatter.blocked_by_project_ids = blockers.length ? blockers : null;
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
    if (item.file.extension !== "md") return `${item.file.name}\n\nOpen the file to inspect it before processing.`;
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
      (content) => prependMarkdownSectionLine(content, "Diary", diaryEntryMarkdown(timestamp, clean)),
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

  private async createNextActionFile(title: string, context: string, captured: string, project?: Project, work = false): Promise<TFile> {
    return this.createActionFile(title, { title, status: "next", context, work }, captured, project);
  }

  private async createActionFile(title: string, input: ActionInput, captured: string, project?: Project): Promise<TFile> {
    const context = input.context.trim();
    if (!context) throw new Error("A context is required.");
    const id = createUlid();
    const directory = await this.ensureFolder(normalizeVaultPath(this.getSettings().actionsDirectory) || "GTD/Actions");
    const path = this.uniqueMarkdownPath(directory, title, id);
    const status = input.status ?? "next";
    const frontmatter: Record<string, unknown> = {
      type: "gtd-action",
      id,
      title,
      status,
      project_id: project?.id ?? null,
      project: project ? wikiLink(project) : null,
      context,
      energy: input.energy || null,
      due: input.due || null,
      defer_until: input.deferUntil || null,
      scheduled_start: input.scheduledStart || null,
      duration_minutes: input.durationMinutes ?? null,
      work: input.work ?? false,
      captured,
      created: localDate(),
      completed: status === "done" ? new Date().toISOString() : null,
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
    const supportPath = normalizeVaultPath(project.supportPath);
    const nestedProjectPaths = this.index.getSnapshot().projects
      .filter((candidate) => candidate.id !== project.id && candidate.supportPath)
      .map((candidate) => normalizeVaultPath(candidate.supportPath!))
      .filter((candidatePath) => candidatePath !== supportPath && pathIsWithin(candidatePath, supportPath));
    return this.app.vault.getFiles().filter((file) =>
      pathIsWithin(file.path, supportPath)
      && !nestedProjectPaths.some((nestedPath) => pathIsWithin(file.path, nestedPath))
    );
  }

  /** Repairs generated support folders so their physical nesting matches the Project hierarchy. */
  async reconcileProjectSupportPaths(): Promise<{ corrected: number; failed: number }> {
    const snapshot = this.index.getSnapshot();
    const validProjects = snapshot.projects.filter((project) => !projectHierarchyIssue(project, snapshot.projectsById));
    const originalPaths = new Map(validProjects.flatMap((project) => {
      const path = normalizeVaultPath(project.supportPath ?? "");
      return path ? [[project.id, path] as const] : [];
    }));
    const actualPaths = new Map(originalPaths);
    const generatedProjects = new Set(validProjects
      .filter((project) => {
        const path = originalPaths.get(project.id);
        return !path || this.isGeneratedSupportFolder(path, project.title, project.id);
      })
      .map((project) => project.id));
    const supportRoot = await this.ensureFolder(PROJECT_SUPPORT_ROOT);
    const failedProjects = new Set<string>();

    for (const project of [...validProjects].sort((left, right) =>
      projectDepth(left, snapshot.projectsById) - projectDepth(right, snapshot.projectsById)
    )) {
      if (!generatedProjects.has(project.id)) continue;
      const desiredRoot = project.parentProjectId ? actualPaths.get(project.parentProjectId) : supportRoot;
      if (!desiredRoot) {
        failedProjects.add(project.id);
        continue;
      }
      const currentPath = actualPaths.get(project.id);
      const desiredPath = this.uniqueFolderPath(desiredRoot, project.title, project.id, currentPath);
      try {
        if (!currentPath) {
          actualPaths.set(project.id, await this.ensureFolder(desiredPath));
          continue;
        }
        if (currentPath === desiredPath) {
          await this.ensureFolder(currentPath);
          continue;
        }

        const currentFolder = this.app.vault.getAbstractFileByPath(currentPath);
        const movedPath = currentFolder instanceof TFolder
          ? await this.moveSupportFolder(currentPath, desiredPath)
          : await this.ensureFolder(desiredPath);
        for (const [candidateId, candidatePath] of actualPaths) {
          if (candidateId !== project.id && pathIsWithin(candidatePath, currentPath)) {
            actualPaths.set(candidateId, normalizePath(`${movedPath}/${candidatePath.slice(currentPath.length + 1)}`));
          }
        }
        actualPaths.set(project.id, movedPath);
      } catch {
        failedProjects.add(project.id);
      }
    }

    let corrected = 0;
    for (const project of validProjects) {
      const oldPath = originalPaths.get(project.id);
      const newPath = actualPaths.get(project.id);
      if (!newPath || newPath === oldPath || failedProjects.has(project.id)) continue;
      try {
        await this.app.fileManager.processFrontMatter(project.file, (frontmatter) => {
          frontmatter.support_path = newPath;
        });
        if (oldPath) await this.updateSupportPathInBody(project.file, oldPath, newPath);
        corrected += 1;
      } catch {
        failedProjects.add(project.id);
      }
    }
    return { corrected, failed: failedProjects.size };
  }

  async createProjectSupportNote(projectId: string, title: string): Promise<TFile> {
    const project = this.requireProject(projectId);
    const cleanTitle = title.trim().replace(/\.md$/i, "").trim();
    if (!cleanTitle) throw new Error("A note title is required.");
    const supportPath = await this.ensureProjectSupportPath(project);
    const path = this.uniqueMarkdownPath(supportPath, cleanTitle, createUlid());
    return this.app.vault.create(path, `# ${cleanTitle}\n\nProject: ${wikiLink(project)}\n\n`);
  }

  async readProjectSupportNote(projectId: string, path: string): Promise<string> {
    const file = this.requireProjectSupportNote(projectId, path);
    return noteBody(await this.app.vault.cachedRead(file));
  }

  async updateProjectSupportNote(projectId: string, path: string, body: string): Promise<void> {
    const file = this.requireProjectSupportNote(projectId, path);
    await this.enqueue(file.path, () => this.app.vault.process(file, (content) => replaceNoteBody(content, body)));
  }

  /** A Project's support folder, created on demand inside its parent Project's own support folder. */
  private async ensureProjectSupportPath(project: Project, seen: ReadonlySet<string> = new Set()): Promise<string> {
    if (project.supportPath) return this.ensureFolder(project.supportPath);
    if (seen.has(project.id)) throw new Error("The Project hierarchy contains a cycle.");
    const supportRoot = await this.projectSupportRoot(project, new Set([...seen, project.id]));
    const supportPath = await this.ensureFolder(this.uniqueFolderPath(supportRoot, project.title, project.id));
    await this.app.fileManager.processFrontMatter(project.file, (frontmatter) => {
      frontmatter.support_path = supportPath;
    });
    return supportPath;
  }

  /** Where a Project's own support folder belongs: inside its parent's, or the shared root. */
  private async projectSupportRoot(project: { parentProjectId?: string }, seen: ReadonlySet<string> = new Set()): Promise<string> {
    const parent = project.parentProjectId ? this.index.getSnapshot().projectsById.get(project.parentProjectId) : undefined;
    return parent ? this.ensureProjectSupportPath(parent, seen) : this.ensureFolder(PROJECT_SUPPORT_ROOT);
  }

  /** Moves a generated support folder, keeping the support paths of nested sub-projects correct. */
  private async moveSupportFolder(from: string, to: string): Promise<string> {
    if (!from || to === from) return from;
    const folder = this.app.vault.getAbstractFileByPath(from);
    if (!(folder instanceof TFolder)) return from;
    const nested = this.index.getSnapshot().projects.filter((candidate) =>
      candidate.supportPath && candidate.supportPath !== from && pathIsWithin(candidate.supportPath, from)
    );
    await this.app.vault.rename(folder, to);
    for (const candidate of nested) {
      const moved = normalizePath(`${to}/${candidate.supportPath!.slice(from.length + 1)}`);
      await this.app.fileManager.processFrontMatter(candidate.file, (frontmatter) => {
        frontmatter.support_path = moved;
      });
    }
    return to;
  }

  /** True when the folder is one this plugin generated for the Project, rather than a hand-picked one. */
  private isGeneratedSupportFolder(supportPath: string, title: string, id: string): boolean {
    if (!generatedFolderNames(title, id).includes(baseName(supportPath))) return false;
    const root = parentPath(supportPath);
    if (root === PROJECT_SUPPORT_ROOT || root === "Projects") return true;
    return this.index.getSnapshot().projects.some((candidate) => candidate.id !== id && candidate.supportPath === root);
  }

  private async clearEntityFrontmatter(file: TFile): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, clearGtdFrontmatter);
  }

  private hasGtdFrontmatter(file: TFile): boolean {
    if (file.extension !== "md") return false;
    const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
    return type === "gtd-inbox-item" || type === "gtd-action" || type === "gtd-project";
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

  private requireProjectSupportNote(projectId: string, path: string): TFile {
    const project = this.requireProject(projectId);
    const supportPath = normalizeVaultPath(project.supportPath ?? "");
    const normalizedPath = normalizeVaultPath(path);
    if (!supportPath || !pathIsWithin(normalizedPath, supportPath)) {
      throw new Error("This note is not inside the Project Support Material folder.");
    }
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(file instanceof TFile) || file.extension !== "md") throw new Error("The support note no longer exists.");
    const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
    if (type === "gtd-action" || type === "gtd-project" || type === "gtd-inbox-item") {
      throw new Error("GTD entity files cannot be edited as support notes.");
    }
    return file;
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

  private uniqueInboxDestination(directory: string, item: InboxItem): string {
    const fileName = item.raw ? item.file.name : `${safeName(item.title)}.md`;
    const extensionIndex = fileName.lastIndexOf(".");
    const hasExtension = extensionIndex > 0;
    const extension = hasExtension ? fileName.slice(extensionIndex) : "";
    const stem = safeName(hasExtension ? fileName.slice(0, extensionIndex) : fileName);
    const first = normalizePath(`${directory}/${stem}${extension}`);
    if (first === item.file.path || !this.app.vault.getAbstractFileByPath(first)) return first;
    const suffix = item.id.slice(-4);
    const second = normalizePath(`${directory}/${stem} - ${suffix}${extension}`);
    if (second === item.file.path || !this.app.vault.getAbstractFileByPath(second)) return second;
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(normalizePath(`${directory}/${stem} - ${suffix}-${counter}${extension}`))) counter += 1;
    return normalizePath(`${directory}/${stem} - ${suffix}-${counter}${extension}`);
  }

  private uniqueFolderPath(root: string, title: string, id: string, currentPath?: string): string {
    const [preferred, fallback] = generatedFolderNames(title, id);
    const first = normalizePath(`${root}/${preferred}`);
    if (first === currentPath || !this.app.vault.getAbstractFileByPath(first)) return first;
    return normalizePath(`${root}/${fallback}`);
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

function projectNotesFromAction(content: string, title: string): string {
  return noteBody(content, title).replace(/^(#{1,6})(?=[ \t])/gm, (_match, hashes: string) =>
    "#".repeat(Math.min(6, Math.max(3, hashes.length + 1)))
  );
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
    "scheduled_start",
    "duration_minutes",
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

function validateActionSchedule(status: Action["status"], scheduledStart?: string, durationMinutes?: number): void {
  if (scheduledStart) normalizeTimestamp(scheduledStart, "scheduled_start");
  if (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes <= 0)) {
    throw new Error("Duration must be a positive whole number of minutes.");
  }
  if (status === "scheduled" && (!scheduledStart || durationMinutes === undefined)) {
    throw new Error("Scheduled Actions require a start time and duration.");
  }
}

function actionInput(title: string, context: string, project?: Project, work = false): ActionInput {
  return {
    title,
    status: "next",
    context,
    work,
    ...(project ? { projectId: project.id } : {}),
  };
}

function pathIsWithin(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

function projectDepth(project: Project, projectsById: ReadonlyMap<string, Project>): number {
  let depth = 0;
  let current = project;
  const seen = new Set([project.id]);
  while (current.parentProjectId) {
    const parent = projectsById.get(current.parentProjectId);
    if (!parent || seen.has(parent.id)) return Number.MAX_SAFE_INTEGER;
    seen.add(parent.id);
    current = parent;
    depth += 1;
  }
  return depth;
}
