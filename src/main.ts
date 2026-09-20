import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { GoogleCalendarSync, type CalendarSyncStatus, type CalendarSyncResult } from "./calendar/calendar-sync";
import { isActionStatus, isProjectStatus } from "./domain/validation";
import type { GtdSettings, SavedView } from "./domain/types";
import { GtdIndex } from "./repository/gtd-index";
import { GtdRepository } from "./repository/gtd-repository";
import { defaultSettings } from "./state/defaults";
import { GtdSettingTab } from "./settings";
import { ActionEditorModal, ImportActionsModal, ImportSubprojectsModal, NewActionModal, NewProjectModal, ProjectEditorModal, ScheduleActionModal, TextPromptModal } from "./ui/modals";
import { OpenProjectModal } from "./ui/open-project";
import type { GtdServices } from "./ui/services";
import { localDate } from "./utils/date";
import { normalizeVaultPath } from "./utils/path";
import { createUlid } from "./utils/ulid";
import { ActionBoardView, BOARD_VIEW_TYPE, BRAINSTORM_VIEW_TYPE, GtdBrainstormView, GtdInboxView, GtdProjectReviewView, GtdProjectsView, INBOX_VIEW_TYPE, PROJECTS_VIEW_TYPE, REVIEW_VIEW_TYPE } from "./views";

export default class DragonglassGtdPlugin extends Plugin {
  declare settings: GtdSettings;
  private index!: GtdIndex;
  private repository!: GtdRepository;
  private calendarSync!: GoogleCalendarSync;
  private services!: GtdServices;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.index = new GtdIndex(this.app.vault, this.app.metadataCache, () => this.settings.inboxDirectory);
    this.repository = new GtdRepository(this.app, this.index, () => this.settings);
    this.calendarSync = new GoogleCalendarSync(this.app, this.index, () => this.settings.googleCalendar);
    this.services = {
      app: this.app,
      repository: this.repository,
      getSettings: () => this.settings,
      saveSettings: async (settings, refreshViews = true) => {
        this.settings = settings;
        await this.saveSettings(refreshViews);
        if (refreshViews) this.index.reindex();
      },
      openFile: (file) => this.openFile(file),
      quickCapture: () => this.quickCapture(),
      openInbox: () => void this.activateView(INBOX_VIEW_TYPE),
      createAction: (projectId) => this.createAction(projectId),
      scheduleAction: (id) => this.scheduleAction(id),
      importActions: (projectId) => this.importActions(projectId),
      importSubprojects: (parentProjectId) => this.importSubprojects(parentProjectId),
      createProject: (openAfterCreate = true, parentProjectId) => this.createProject(openAfterCreate, parentProjectId),
      editAction: (id, allowProjectConversion) => this.editAction(id, allowProjectConversion),
      editProject: (id) => this.editProject(id),
      showProjectDetail: (id) => void this.openProjectDetail(id),
    };

    this.registerView(BOARD_VIEW_TYPE, (leaf) => new ActionBoardView(leaf, this.services));
    this.registerView(BRAINSTORM_VIEW_TYPE, (leaf) => new GtdBrainstormView(leaf, this.services));
    this.registerView(INBOX_VIEW_TYPE, (leaf) => new GtdInboxView(leaf, this.services));
    this.registerView(PROJECTS_VIEW_TYPE, (leaf) => new GtdProjectsView(leaf, this.services));
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new GtdProjectReviewView(leaf, this.services));
    this.addRibbonIcon("list-checks", "Open GTD Action Board", () => void this.activateView(BOARD_VIEW_TYPE));
    this.addRibbonIcon("inbox", "Open GTD Inbox", () => void this.activateView(INBOX_VIEW_TYPE));
    this.addRibbonIcon("folder-kanban", "Open GTD Projects", () => void this.activateView(PROJECTS_VIEW_TYPE));
    this.addRibbonIcon("clipboard-check", "Start GTD Project Review", () => void this.activateView(REVIEW_VIEW_TYPE));
    this.addRibbonIcon("lightbulb", "Open GTD Brainstorm", () => void this.activateView(BRAINSTORM_VIEW_TYPE));
    this.addSettingTab(new GtdSettingTab(this.app, this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => void this.initializeIndex());
  }

  onunload(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(BRAINSTORM_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(PROJECTS_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) leaf.detach();
  }

  async loadSettings(): Promise<void> {
    const defaults = defaultSettings();
    const saved = (await this.loadData()) as Partial<GtdSettings> | null;
    this.settings = {
      ...defaults,
      ...(saved ?? {}),
      referenceDirectory: saved?.referenceDirectory === "Reference"
        ? defaults.referenceDirectory
        : saved?.referenceDirectory ?? defaults.referenceDirectory,
      defaultProjectImage: typeof saved?.defaultProjectImage === "string"
        ? normalizeVaultPath(saved.defaultProjectImage)
        : defaults.defaultProjectImage,
      savedViews: Array.isArray(saved?.savedViews) ? migrateSavedViews(saved.savedViews) : defaults.savedViews,
      defaultActionStatus: isActionStatus(saved?.defaultActionStatus) ? saved.defaultActionStatus : defaults.defaultActionStatus,
      projectBoardColumns: Array.isArray(saved?.projectBoardColumns)
        ? saved.projectBoardColumns.filter((status) => isProjectStatus(status) && status !== "cancelled")
        : defaults.projectBoardColumns,
      schemaVersion: defaults.schemaVersion,
      googleCalendar: {
        ...defaults.googleCalendar,
        ...(saved?.googleCalendar ?? {}),
        sourceId: typeof saved?.googleCalendar?.sourceId === "string" && saved.googleCalendar.sourceId.trim()
          ? saved.googleCalendar.sourceId.trim()
          : createUlid(),
        defaultDurationMinutes: Number.isInteger(saved?.googleCalendar?.defaultDurationMinutes)
          && saved!.googleCalendar!.defaultDurationMinutes > 0
          ? saved!.googleCalendar!.defaultDurationMinutes
          : defaults.googleCalendar.defaultDurationMinutes,
      },
    };
    if (!saved?.googleCalendar?.sourceId) await this.saveData(this.settings);
  }

  async saveSettings(refreshViews = true): Promise<void> {
    await this.saveData(this.settings);
    this.calendarSync?.schedule(0);
    if (!refreshViews) return;
    for (const leaf of this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE)) {
      if (leaf.view instanceof ActionBoardView) leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) {
      if (leaf.view instanceof GtdInboxView) leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(PROJECTS_VIEW_TYPE)) {
      if (leaf.view instanceof GtdProjectsView) leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
      if (leaf.view instanceof GtdProjectReviewView) leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(BRAINSTORM_VIEW_TYPE)) {
      if (leaf.view instanceof GtdBrainstormView) leaf.view.refresh();
    }
  }

  getGoogleCalendarStatus(): CalendarSyncStatus {
    return this.calendarSync.getStatus();
  }

  subscribeGoogleCalendarStatus(listener: () => void): () => void {
    return this.calendarSync.subscribe(listener);
  }

  async testGoogleCalendar(): Promise<CalendarSyncResult> {
    return this.calendarSync.testConnection();
  }

  async syncGoogleCalendar(): Promise<CalendarSyncResult> {
    return this.calendarSync.syncNow();
  }

  private registerCommands(): void {
    this.addCommand({ id: "open-action-board", name: "Open Action Board", callback: () => void this.activateView(BOARD_VIEW_TYPE) });
    this.addCommand({ id: "open-inbox", name: "Open Inbox", callback: () => void this.activateView(INBOX_VIEW_TYPE) });
    this.addCommand({ id: "process-inbox", name: "Process Inbox", callback: () => void this.processInbox() });
    this.addCommand({ id: "open-projects", name: "Open Projects", callback: () => void this.activateView(PROJECTS_VIEW_TYPE) });
    this.addCommand({
      id: "open-project",
      name: "Open Project",
      // Mod+K is Obsidian's own "Insert Markdown link", which wins the conflict and leaves this dead.
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "o" }],
      callback: () => this.openProjectPicker(),
    });
    this.addCommand({ id: "start-project-review", name: "Start Project Review", callback: () => void this.activateView(REVIEW_VIEW_TYPE) });
    this.addCommand({ id: "open-brainstorm", name: "Open Brainstorm", callback: () => void this.activateView(BRAINSTORM_VIEW_TYPE) });
    this.addCommand({ id: "quick-capture-inbox-item", name: "Quick Capture Inbox Item", callback: () => this.quickCapture() });
    this.addCommand({ id: "new-action", name: "New Action", callback: () => this.createAction() });
    this.addCommand({ id: "import-actions", name: "Import Actions", callback: () => this.importActions() });
    this.addCommand({ id: "import-subprojects", name: "Import Sub-projects", callback: () => this.importSubprojects() });
    this.addCommand({ id: "new-project", name: "New Project", callback: () => this.createProject() });
  }

  private async initializeIndex(): Promise<void> {
    let migratedProjects = 0;
    let failedProjects = 0;
    let migratedActions = 0;
    let failedActions = 0;
    let stampedWaiting = 0;
    let failedWaiting = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.type === "gtd-project" && frontmatter.status === "waiting") {
        try {
          await this.app.fileManager.processFrontMatter(file, (properties) => {
            if (properties.type === "gtd-project" && properties.status === "waiting") {
              properties.status = "active";
              properties.completed = null;
            }
          });
          migratedProjects += 1;
        } catch {
          failedProjects += 1;
        }
      } else if (frontmatter?.type === "gtd-action" && frontmatter.status === "someday") {
        try {
          await this.app.fileManager.processFrontMatter(file, (properties) => {
            if (properties.type === "gtd-action" && properties.status === "someday") {
              properties.status = "next";
              properties.completed = null;
            }
          });
          migratedActions += 1;
        } catch {
          failedActions += 1;
        }
      } else if (frontmatter?.type === "gtd-action" && frontmatter.status === "waiting" && !frontmatter.waiting_since) {
        // Actions already waiting predate the field, so today is when Dragonglass started counting.
        try {
          await this.app.fileManager.processFrontMatter(file, (properties) => {
            if (properties.type === "gtd-action" && properties.status === "waiting" && !properties.waiting_since) {
              properties.waiting_since = localDate();
            }
          });
          stampedWaiting += 1;
        } catch {
          failedWaiting += 1;
        }
      }
    }

    this.index.initialize(this);
    let correctedSupportPaths = 0;
    let failedSupportPaths = 0;
    try {
      const result = await this.repository.reconcileProjectSupportPaths();
      correctedSupportPaths = result.corrected;
      failedSupportPaths = result.failed;
    } catch {
      failedSupportPaths = 1;
    }
    this.register(this.calendarSync.start());
    this.registerInterval(window.setInterval(() => this.calendarSync.schedule(0), 5 * 60_000));
    if (migratedProjects) new Notice(`Migrated ${migratedProjects} waiting Project${migratedProjects === 1 ? "" : "s"} to Active.`);
    if (failedProjects) new Notice(`Could not migrate ${failedProjects} waiting Project${failedProjects === 1 ? "" : "s"}.`);
    if (migratedActions) new Notice(`Migrated ${migratedActions} Someday Action${migratedActions === 1 ? "" : "s"} to Next.`);
    if (failedActions) new Notice(`Could not migrate ${failedActions} Someday Action${failedActions === 1 ? "" : "s"}.`);
    if (stampedWaiting) new Notice(`Dated ${stampedWaiting} Waiting Action${stampedWaiting === 1 ? "" : "s"} from today.`);
    if (failedWaiting) new Notice(`Could not date ${failedWaiting} Waiting Action${failedWaiting === 1 ? "" : "s"}.`);
    if (correctedSupportPaths) new Notice(`Nested support material for ${correctedSupportPaths} Project${correctedSupportPaths === 1 ? "" : "s"}.`);
    if (failedSupportPaths) new Notice(`Could not correct support material for ${failedSupportPaths} Project${failedSupportPaths === 1 ? "" : "s"}.`);
    const count = this.index.getSnapshot().issues.length;
    if (count) new Notice(`Dragonglass GTD found ${count} file${count === 1 ? "" : "s"} with invalid or duplicate metadata.`);
  }

  private quickCapture(): void {
    new TextPromptModal(this.app, "Quick Capture Inbox Item", "What's on your mind?", async (title) => {
      await this.repository.createInboxItem(title);
      new Notice("Captured to Inbox.");
    }).open();
  }

  private createProject(openAfterCreate = true, parentProjectId = ""): void {
    new NewProjectModal(this.services, async (file) => {
      if (openAfterCreate) await this.openFile(file);
    }, parentProjectId).open();
  }

  private createAction(projectId = ""): void {
    new NewActionModal(this.services, projectId).open();
  }

  private importActions(projectId = ""): void {
    new ImportActionsModal(this.services, projectId).open();
  }

  private importSubprojects(parentProjectId = ""): void {
    new ImportSubprojectsModal(this.services, parentProjectId).open();
  }

  private scheduleAction(id: string): void {
    const action = this.index.getSnapshot().actionsById.get(id);
    if (!action) return void new Notice("This Action is missing or has a duplicate ID.");
    new ScheduleActionModal(this.services, action).open();
  }

  private editAction(id: string, allowProjectConversion = false): void {
    const action = this.index.getSnapshot().actionsById.get(id);
    if (!action) return void new Notice("This Action is missing or has a duplicate ID.");
    new ActionEditorModal(this.services, action, allowProjectConversion).open();
  }

  private editProject(id: string): void {
    const project = this.index.getSnapshot().projectsById.get(id);
    if (!project) return void new Notice("This Project is missing or has a duplicate ID.");
    new ProjectEditorModal(this.services, project).open();
  }

  private openProjectPicker(): void {
    const projects = this.index.getSnapshot().projects;
    if (!projects.length) return void new Notice("There are no Projects to open.");
    new OpenProjectModal(this.app, projects, (project) => void this.openProjectDetail(project.id)).open();
  }

  private async openFile(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async activateView(type: string): Promise<WorkspaceLeaf> {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  private async processInbox(): Promise<void> {
    const leaf = await this.activateView(INBOX_VIEW_TYPE);
    if (leaf.view instanceof GtdInboxView) leaf.view.startProcessing();
  }

  private async openProjectDetail(id: string): Promise<void> {
    const leaf = await this.activateView(PROJECTS_VIEW_TYPE);
    if (leaf.view instanceof GtdProjectsView) leaf.view.showProject(id);
  }
}

function migrateSavedViews(views: SavedView[]): SavedView[] {
  return views
    .filter((view) => view.id !== "default-inbox" && view.id !== "default-someday" && !view.filters.some((filter) =>
      filter.kind === "value"
      && filter.field === "status"
      && filter.operator === "in"
      && filter.values.length > 0
      && filter.values.every((value) => value === "inbox" || value === "someday")
    ) && !(view.visibleColumns?.length && view.visibleColumns.every((column) => column === "inbox" || column === "someday")))
    .map((view) => ({
      ...view,
      filters: view.filters.flatMap((filter) => {
        if (filter.kind !== "value" || filter.field !== "status") return [filter];
        const values = filter.values.filter((value) => value !== "inbox" && value !== "someday");
        return values.length ? [{ ...filter, values }] : [];
      }),
      visibleColumns: view.visibleColumns?.filter((column) => column !== "inbox" && column !== "someday") ?? null,
    }));
}
