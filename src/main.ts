import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { GoogleCalendarSync, type CalendarSyncStatus, type CalendarSyncResult } from "./calendar/calendar-sync";
import { FeedService, type FeedFetchResult, type FeedSyncStatus } from "./feeds/feed-service";
import { MailService, type MailImportResult, type MailSyncStatus } from "./mail/mail-service";
import { isActionStatus, isProjectStatus } from "./domain/validation";
import { projectsDueForActivation } from "./domain/project-activation";
import { describeImport, normalizeMailPort } from "./domain/mail";
import type { GtdSettings, MailAccountSettings, SavedView } from "./domain/types";
import { GtdIndex } from "./repository/gtd-index";
import { GtdRepository } from "./repository/gtd-repository";
import { defaultSettings } from "./state/defaults";
import { GtdSettingTab } from "./settings";
import { ElmModal } from "./adapter/elm-modals";
import { OpenProjectModal } from "./ui/open-project";
import type { GtdServices } from "./ui/services";
import { localDate } from "./utils/date";
import { normalizeVaultPath } from "./utils/path";
import { createUlid } from "./utils/ulid";
import { ActionBoardView, BOARD_VIEW_TYPE, BRAINSTORM_VIEW_TYPE, FEEDS_VIEW_TYPE, GtdBrainstormView, GtdFeedsView, GtdInboxView, GtdProjectReviewView, GtdProjectsView, GtdPomodoroView, GtdSomedayReviewView, INBOX_VIEW_TYPE, POMODORO_VIEW_TYPE, PROJECTS_VIEW_TYPE, REVIEW_VIEW_TYPE, SOMEDAY_VIEW_TYPE } from "./views";
import { PomodoroService } from "./pomodoro/pomodoro-service";
import type { PomodoroSession } from "./domain/pomodoro";

export default class DragonglassGtdPlugin extends Plugin {
  declare settings: GtdSettings;
  private index!: GtdIndex;
  private repository!: GtdRepository;
  private calendarSync!: GoogleCalendarSync;
  private feeds!: FeedService;
  private mail!: MailService;
  private pomodoro!: PomodoroService;
  private services!: GtdServices;
  private activationRun: Promise<void> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.index = new GtdIndex(this.app.vault, this.app.metadataCache, () => this.settings.inboxDirectory);
    this.repository = new GtdRepository(this.app, this.index, () => this.settings);
    this.calendarSync = new GoogleCalendarSync(this.app, this.index, () => this.settings.googleCalendar);
    this.feeds = new FeedService(this.app, () => this.settings.feeds);
    this.mail = new MailService(
      this.app,
      this.repository,
      () => this.settings.mail,
      (accountId) => this.settings.mail.passwords[accountId] ?? "",
    );
    this.pomodoro = new PomodoroService(
      this.app,
      () => this.settings.pomodoro,
      (session) => this.logPomodoro(session),
      () => void this.openPomodoro(),
    );
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
      promptForText: (title, placeholder) => this.promptForText(title, placeholder),
      createAction: (projectId) => this.createAction(projectId),
      scheduleAction: (id) => this.scheduleAction(id),
      importActions: (projectId) => this.importActions(projectId),
      importSubprojects: (parentProjectId) => this.importSubprojects(parentProjectId),
      createProject: (openAfterCreate = true, parentProjectId) => this.createProject(openAfterCreate, parentProjectId),
      editAction: (id, allowProjectConversion) => this.editAction(id, allowProjectConversion),
      editProject: (id) => this.editProject(id),
      showProjectDetail: (id) => void this.openProjectDetail(id),
      openSomedayReview: () => void this.activateView(SOMEDAY_VIEW_TYPE),
      openPomodoro: (projectId) => void this.openPomodoro(projectId),
    };

    this.registerView(BOARD_VIEW_TYPE, (leaf) => new ActionBoardView(leaf, this.services));
    this.registerView(BRAINSTORM_VIEW_TYPE, (leaf) => new GtdBrainstormView(leaf, this.services));
    this.registerView(FEEDS_VIEW_TYPE, (leaf) => new GtdFeedsView(leaf, this.services, this.feeds));
    this.registerView(INBOX_VIEW_TYPE, (leaf) => new GtdInboxView(leaf, this.services));
    this.registerView(PROJECTS_VIEW_TYPE, (leaf) => new GtdProjectsView(leaf, this.services));
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new GtdProjectReviewView(leaf, this.services));
    this.registerView(SOMEDAY_VIEW_TYPE, (leaf) => new GtdSomedayReviewView(leaf, this.services));
    this.registerView(POMODORO_VIEW_TYPE, (leaf) => new GtdPomodoroView(leaf, this.services, this.pomodoro));
    this.register(this.pomodoro.start(this.addStatusBarItem()));
    this.addRibbonIcon("list-checks", "Open GTD Action Board", () => void this.activateView(BOARD_VIEW_TYPE));
    this.addRibbonIcon("inbox", "Open GTD Inbox", () => void this.activateView(INBOX_VIEW_TYPE));
    this.addRibbonIcon("folder-kanban", "Open GTD Projects", () => void this.activateView(PROJECTS_VIEW_TYPE));
    this.addRibbonIcon("clipboard-check", "Start GTD Project Review", () => void this.activateView(REVIEW_VIEW_TYPE));
    this.addRibbonIcon("lightbulb", "Open GTD Brainstorm", () => void this.activateView(BRAINSTORM_VIEW_TYPE));
    this.addRibbonIcon("timer", "Open GTD Pomodoro", () => void this.openPomodoro());
    this.addRibbonIcon("rss", "Open RSS Feeds", () => void this.activateView(FEEDS_VIEW_TYPE));
    this.addSettingTab(new GtdSettingTab(this.app, this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => void this.initializeIndex());
  }

  onunload(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(BRAINSTORM_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(FEEDS_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(PROJECTS_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(SOMEDAY_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(POMODORO_VIEW_TYPE)) leaf.detach();
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
      mail: {
        ...defaults.mail,
        ...(saved?.mail ?? {}),
        storePath: normalizeVaultPath(saved?.mail?.storePath ?? "") || defaults.mail.storePath,
        refreshMinutes: Number.isInteger(saved?.mail?.refreshMinutes) && saved!.mail!.refreshMinutes >= 5
          ? saved!.mail!.refreshMinutes
          : defaults.mail.refreshMinutes,
        importCap: Number.isInteger(saved?.mail?.importCap) && saved!.mail!.importCap > 0
          ? saved!.mail!.importCap
          : defaults.mail.importCap,
        accounts: Array.isArray(saved?.mail?.accounts) ? saved.mail.accounts.map(migrateMailAccount) : [],
        passwords: isStringMap(saved?.mail?.passwords) ? saved.mail.passwords : {},
      },
      pomodoro: {
        ...defaults.pomodoro,
        ...(saved?.pomodoro ?? {}),
        storePath: normalizeVaultPath(saved?.pomodoro?.storePath ?? "") || defaults.pomodoro.storePath,
        focusMinutes: Number.isInteger(saved?.pomodoro?.focusMinutes)
          && saved!.pomodoro!.focusMinutes >= 1 && saved!.pomodoro!.focusMinutes <= 180
          ? saved!.pomodoro!.focusMinutes
          : defaults.pomodoro.focusMinutes,
        logToDiary: saved?.pomodoro?.logToDiary === true,
      },
      feeds: {
        ...defaults.feeds,
        ...(saved?.feeds ?? {}),
        storePath: normalizeVaultPath(saved?.feeds?.storePath ?? "") || defaults.feeds.storePath,
        refreshMinutes: Number.isInteger(saved?.feeds?.refreshMinutes) && saved!.feeds!.refreshMinutes >= 5
          ? saved!.feeds!.refreshMinutes
          : defaults.feeds.refreshMinutes,
      },
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
    this.feeds?.schedule(0);
    this.mail?.schedule(0);
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
    for (const leaf of this.app.workspace.getLeavesOfType(SOMEDAY_VIEW_TYPE)) {
      if (leaf.view instanceof GtdSomedayReviewView) leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(POMODORO_VIEW_TYPE)) {
      if (leaf.view instanceof GtdPomodoroView) leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(BRAINSTORM_VIEW_TYPE)) {
      if (leaf.view instanceof GtdBrainstormView) leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(FEEDS_VIEW_TYPE)) {
      if (leaf.view instanceof GtdFeedsView) leaf.view.refresh();
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

  getFeedService(): FeedService {
    return this.feeds;
  }

  getMailService(): MailService {
    return this.mail;
  }

  getMailStatus(): MailSyncStatus {
    return this.mail.getStatus();
  }

  async importMail(): Promise<MailImportResult> {
    return this.mail.importAll();
  }

  getFeedStatus(): FeedSyncStatus {
    return this.feeds.getStatus();
  }

  async fetchFeeds(): Promise<FeedFetchResult> {
    return this.feeds.fetchAll();
  }

  promptForFeedUrl(): Promise<string> {
    return this.promptForText("Subscribe to a feed", "https://example.com/feed.xml");
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
    this.addCommand({ id: "start-someday-review", name: "Start Someday/Maybe Review", callback: () => void this.activateView(SOMEDAY_VIEW_TYPE) });
    this.addCommand({ id: "open-brainstorm", name: "Open Brainstorm", callback: () => void this.activateView(BRAINSTORM_VIEW_TYPE) });
    this.addCommand({ id: "open-pomodoro", name: "Open Pomodoro", callback: () => void this.openPomodoro() });
    this.addCommand({ id: "start-pomodoro", name: "Start Pomodoro…", callback: () => this.pickPomodoroProject() });
    this.addCommand({ id: "open-feeds", name: "Open RSS Feeds", callback: () => void this.activateView(FEEDS_VIEW_TYPE) });
    this.addCommand({ id: "fetch-feeds", name: "Fetch RSS Feeds", callback: () => void this.fetchFeedsWithNotice() });
    this.addCommand({ id: "import-email", name: "Import Email", callback: () => void this.importMailWithNotice() });
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
    await this.activateScheduledProjects();
    this.register(this.calendarSync.start());
    this.register(this.feeds.start());
    this.register(this.mail.start());
    this.registerInterval(window.setInterval(() => this.calendarSync.schedule(0), 5 * 60_000));
    this.registerInterval(window.setInterval(() => void this.activateScheduledProjects(), 60_000));
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

  private async activateScheduledProjects(): Promise<void> {
    if (this.activationRun) return this.activationRun;
    const run = (async () => {
      let activated = 0;
      let failed = 0;
      for (const project of projectsDueForActivation(this.index.getSnapshot().projects)) {
        try {
          // Keep activate_at as the calendar record of the automatic transition.
          await this.repository.updateProject(project.id, { status: "active" });
          activated += 1;
        } catch {
          failed += 1;
        }
      }
      if (activated) new Notice(`Activated ${activated} scheduled Project${activated === 1 ? "" : "s"}.`);
      if (failed) new Notice(`Could not activate ${failed} scheduled Project${failed === 1 ? "" : "s"}.`);
    })().finally(() => {
      this.activationRun = null;
    });
    this.activationRun = run;
    return run;
  }

  private quickCapture(): void {
    new ElmModal(this.services, { kind: "capture" }).open();
  }

  private createProject(openAfterCreate = true, parentProjectId = ""): void {
    new ElmModal(this.services, { kind: "new-project", ...(parentProjectId ? { parentProjectId } : {}) }, {
      onProjectCreated: async (file) => {
        if (openAfterCreate) await this.openFile(file);
      },
    }).open();
  }

  private createAction(projectId = ""): void {
    new ElmModal(this.services, { kind: "new-action", ...(projectId ? { projectId } : {}) }).open();
  }

  private importActions(projectId = ""): void {
    new ElmModal(this.services, { kind: "import-actions", ...(projectId ? { projectId } : {}) }).open();
  }

  private importSubprojects(parentProjectId = ""): void {
    new ElmModal(this.services, { kind: "import-subprojects", ...(parentProjectId ? { parentProjectId } : {}) }).open();
  }

  private scheduleAction(id: string): void {
    if (!this.index.getSnapshot().actionsById.has(id)) return void new Notice("This Action is missing or has a duplicate ID.");
    new ElmModal(this.services, { kind: "schedule-action", actionId: id }).open();
  }

  private editAction(id: string, allowProjectConversion = false): void {
    if (!this.index.getSnapshot().actionsById.has(id)) return void new Notice("This Action is missing or has a duplicate ID.");
    new ElmModal(this.services, { kind: "edit-action", actionId: id, allowProjectConversion }).open();
  }

  private editProject(id: string): void {
    if (!this.index.getSnapshot().projectsById.has(id)) return void new Notice("This Project is missing or has a duplicate ID.");
    new ElmModal(this.services, { kind: "edit-project", projectId: id }).open();
  }

  private async openPomodoro(projectId?: string): Promise<void> {
    const leaf = await this.activateView(POMODORO_VIEW_TYPE);
    if (projectId && leaf.view instanceof GtdPomodoroView) leaf.view.selectProject(projectId);
  }

  /** Picks the Project for a new session from those still open. */
  private pickPomodoroProject(): void {
    const projects = this.index.getSnapshot().projects.filter((project) => project.status !== "completed" && project.status !== "cancelled");
    if (!projects.length) return void new Notice("There are no open Projects to focus on.");
    new OpenProjectModal(this.app, projects, (project) => void this.openPomodoro(project.id)).open();
  }

  /** Optionally notes a finished session in its Project's Diary. */
  private async logPomodoro(session: PomodoroSession): Promise<void> {
    if (!this.settings.pomodoro.logToDiary || !this.index.getSnapshot().projectsById.has(session.projectId)) return;
    const outcome = session.outcome === "achieved" ? "achieved" : session.outcome === "partly" ? "partly achieved" : session.outcome === "missed" ? "not achieved" : "";
    const parts = [
      `🍅 ${Math.round(session.focusedSeconds / 60)} min: ${session.intention}`,
      outcome,
      session.reflection,
    ].filter(Boolean);
    try {
      await this.repository.addProjectDiaryEntry(session.projectId, parts.join(" — "));
    } catch {
      new Notice("The Pomodoro was saved, but could not be added to the Project Diary.");
    }
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

  private async processInbox(itemId?: string): Promise<void> {
    const leaf = await this.activateView(INBOX_VIEW_TYPE);
    if (leaf.view instanceof GtdInboxView) leaf.view.startProcessing(itemId);
  }

  /** Asks for one line of text. A dismissed prompt answers with `""` rather than hanging. */
  private promptForText(title: string, placeholder: string): Promise<string> {
    return new Promise<string>((resolve) => {
      let answered = false;
      new ElmModal(this.services, { kind: "prompt", title, placeholder }, {
        onPrompt: (value) => {
          answered = true;
          resolve(value);
        },
        onDismissed: () => {
          if (!answered) resolve("");
        },
      }).open();
    });
  }

  /**
   * Reports an import in the terms that matter: what arrived, and what was held back.
   *
   * A baseline is called out explicitly, because "nothing was imported" is the
   * correct outcome on a mailbox's first sync and looks like a failure otherwise.
   */
  private async importMailWithNotice(): Promise<void> {
    if (!this.settings.mail.enabled) return void new Notice("Email import is switched off in Dragonglass settings.");
    if (!this.mail.available()) return void new Notice("Email can only be imported on the desktop app.");
    try {
      const result = await this.mail.importAll();
      new Notice(describeImport(result, this.mail.getStatus().error ?? ""), 10_000);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Email could not be imported.");
    }
  }

  private async fetchFeedsWithNotice(): Promise<void> {
    if (!this.settings.feeds.enabled) return void new Notice("Feeds are switched off in Dragonglass settings.");
    const result = await this.feeds.fetchAll();
    new Notice(result.added ? `Fetched ${result.added} new Feed Item${result.added === 1 ? "" : "s"}.` : "No new Feed Items.");
  }

  private async openProjectDetail(id: string): Promise<void> {
    const leaf = await this.activateView(PROJECTS_VIEW_TYPE);
    if (leaf.view instanceof GtdProjectsView) leaf.view.showProject(id);
  }
}

/** Repairs an account read back from the data file, so one bad field cannot break start-up. */
function migrateMailAccount(account: MailAccountSettings): MailAccountSettings {
  return {
    ...account,
    id: typeof account?.id === "string" && account.id ? account.id : createUlid(),
    label: typeof account?.label === "string" && account.label.trim() ? account.label : "Mail",
    host: typeof account?.host === "string" ? account.host.trim() : "",
    port: normalizeMailPort(account?.port),
    user: typeof account?.user === "string" ? account.user.trim() : "",
    mailboxes: Array.isArray(account?.mailboxes)
      ? account.mailboxes.filter((mailbox): mailbox is string => typeof mailbox === "string" && mailbox.trim().length > 0)
      : [],
    criterion: typeof account?.criterion === "string" && account.criterion.trim() ? account.criterion.trim() : "ALL",
    archiveMailbox: typeof account?.archiveMailbox === "string" ? account.archiveMailbox.trim() : "",
    enabled: account?.enabled !== false,
  };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
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
        // Deferring Actions was removed, and the "Available now" filter with it.
        if ((filter as { kind: string }).kind === "availability") return [];
        if (filter.kind !== "value" || filter.field !== "status") return [filter];
        const values = filter.values.filter((value) => value !== "inbox" && value !== "someday");
        return values.length ? [{ ...filter, values }] : [];
      }),
      visibleColumns: view.visibleColumns?.filter((column) => column !== "inbox" && column !== "someday") ?? null,
    }));
}
