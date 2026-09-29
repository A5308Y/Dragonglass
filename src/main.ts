import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { GoogleCalendarSync, type CalendarSyncStatus, type CalendarSyncResult } from "./calendar/calendar-sync";
import { FeedService, type FeedFetchResult, type FeedSyncStatus } from "./feeds/feed-service";
import { MailService, type MailImportResult, type MailSyncStatus } from "./mail/mail-service";
import { isActionStatus, isProjectStatus } from "./domain/validation";
import { projectsDueForActivation } from "./domain/project-activation";
import { ancestorsToActivate } from "./domain/project-tree";
import { attention } from "./domain/attention";
import { weeklyReviewFinished } from "./domain/weekly-review";
import { unreadItems } from "./domain/feed";
import { RibbonAttention } from "./ui/ribbon-attention";
import { describeImport, normalizeMailPort } from "./domain/mail";
import type { ActionStatus, GtdSettings, MailAccountSettings, Project, ProjectStatus, SavedView } from "./domain/types";
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
import { ActionBoardView, BOARD_VIEW_TYPE, BRAINSTORM_VIEW_TYPE, CHECKLISTS_VIEW_TYPE, FEEDS_VIEW_TYPE, GtdBrainstormView, GtdChecklistsView, GtdFeedsView, GtdInboxView, GtdProjectReviewView, GtdProjectsView, GtdPomodoroView, GtdSomedayReviewView, INBOX_VIEW_TYPE, POMODORO_VIEW_TYPE, PROJECTS_VIEW_TYPE, REVIEW_VIEW_TYPE, SOMEDAY_VIEW_TYPE } from "./views";
import { registerObsidianMarkdown } from "./adapter/obsidian-markdown";
import { VIEW_LINK_ACTION, VIEW_LINK_NAMES, viewLinkName, type ViewLinkName } from "./domain/view-links";
import { PomodoroService } from "./pomodoro/pomodoro-service";
import { ChecklistService } from "./checklists/checklist-service";
import { MiteSync } from "./pomodoro/mite-sync";
import { MailPasswords } from "./mail/mail-passwords";
import { CalendarSecret } from "./calendar/calendar-secret";
import { parseMiteSettings } from "./domain/mite";
import { AgentService } from "./agent/agent-service";
import { delegateProject } from "./ui/delegate";
import { confirmDeleteAgentRun } from "./ui/delete-agent-run";
import type { PomodoroSession } from "./domain/pomodoro";

/** The view each Dragonglass link name opens. */
const LINKED_VIEWS: Record<ViewLinkName, string> = {
  inbox: INBOX_VIEW_TYPE,
  board: BOARD_VIEW_TYPE,
  projects: PROJECTS_VIEW_TYPE,
  review: REVIEW_VIEW_TYPE,
  someday: SOMEDAY_VIEW_TYPE,
  brainstorm: BRAINSTORM_VIEW_TYPE,
  pomodoro: POMODORO_VIEW_TYPE,
  feeds: FEEDS_VIEW_TYPE,
  checklists: CHECKLISTS_VIEW_TYPE,
};

export default class DragonglassGtdPlugin extends Plugin {
  declare settings: GtdSettings;
  private index!: GtdIndex;
  private repository!: GtdRepository;
  private calendarSync!: GoogleCalendarSync;
  private feeds!: FeedService;
  private ribbonAttention!: RibbonAttention;
  private mail!: MailService;
  private pomodoro!: PomodoroService;
  checklists!: ChecklistService;
  mite!: MiteSync;
  mailPasswords!: MailPasswords;
  calendarSecret!: CalendarSecret;
  agent!: AgentService;
  private services!: GtdServices;
  private activationRun: Promise<void> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.mailPasswords = new MailPasswords(this.app, () => this.settings.mail);
    this.mailPasswords.migrate();
    this.calendarSecret = new CalendarSecret(this.app, () => this.settings.googleCalendar);
    this.calendarSecret.migrate();
    this.index = new GtdIndex(this.app.vault, this.app.metadataCache, () => this.settings.inboxDirectory);
    this.repository = new GtdRepository(this.app, this.index, () => this.settings);
    this.repository.onParentsActivated = (title, parents) => {
      new Notice(`Created “${title}” as Active, so ${quotedTitles(parents)} above it ${parents.length === 1 ? "is" : "are"} Active now too.`);
    };
    this.calendarSync = new GoogleCalendarSync(this.app, this.index, () => this.calendarSecret.settings());
    this.feeds = new FeedService(this.app, () => this.settings.feeds);
    this.mail = new MailService(
      this.app,
      this.repository,
      () => this.settings.mail,
      (accountId) => this.mailPasswords.get(accountId),
    );
    this.pomodoro = new PomodoroService(
      this.app,
      () => this.settings.pomodoro,
      (session) => this.pomodoroFinished(session),
      () => void this.openPomodoro(),
    );
    this.checklists = new ChecklistService(this.app, () => this.settings.checklists, async (oldPath, newPath) => {
      if (this.settings.checklists.daily !== oldPath) return;
      this.settings.checklists.daily = newPath;
      await this.saveSettings(false);
    });
    this.mite = new MiteSync(this.app, this.pomodoro, () => this.settings.pomodoro.mite, () => this.index.getSnapshot().projects);
    this.agent = new AgentService(this.app, this.repository, () => this.settings.agent);
    this.services = {
      app: this.app,
      repository: this.repository,
      agent: this.agent,
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
      createProject: (openAfterCreate = true, parentProjectId, status) => this.createProject(openAfterCreate, parentProjectId, status),
      editAction: (id, allowProjectConversion, status) => this.editAction(id, allowProjectConversion, status),
      editProject: (id) => this.editProject(id),
      showProjectDetail: (id) => void this.openProjectDetail(id),
      openSomedayReview: () => void this.activateView(SOMEDAY_VIEW_TYPE),
      openPomodoro: (projectId) => void this.openPomodoro(projectId),
      openChecklistPomodoro: (path) => void this.openChecklistPomodoro(path),
      openChecklists: (runId) => void this.openChecklists(runId),
      delegateProject: (projectId) => delegateProject(this.app, this.agent, projectId, this.settings.agent),
      deleteAgentRun: (runId) => confirmDeleteAgentRun(this.app, this.agent, runId),
      rerunAgentRun: async (runId) => {
        const previous = await this.agent.rerunDefaults(runId);
        await delegateProject(this.app, this.agent, previous.projectId, this.settings.agent, previous);
      },
    };

    // `obsidian://dragonglass?view=inbox` opens a view, from a note, a checklist or outside Obsidian.
    registerObsidianMarkdown(this.app, (view) => this.openViewLink(view));
    this.registerObsidianProtocolHandler(VIEW_LINK_ACTION, (params) => this.openViewLink(params.view));
    this.registerView(BOARD_VIEW_TYPE, (leaf) => new ActionBoardView(leaf, this.services));
    this.registerView(BRAINSTORM_VIEW_TYPE, (leaf) => new GtdBrainstormView(leaf, this.services));
    this.registerView(FEEDS_VIEW_TYPE, (leaf) => new GtdFeedsView(leaf, this.services, this.feeds));
    this.registerView(INBOX_VIEW_TYPE, (leaf) => new GtdInboxView(leaf, this.services));
    this.registerView(PROJECTS_VIEW_TYPE, (leaf) => new GtdProjectsView(leaf, this.services));
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new GtdProjectReviewView(leaf, this.services));
    this.registerView(SOMEDAY_VIEW_TYPE, (leaf) => new GtdSomedayReviewView(leaf, this.services));
    this.registerView(POMODORO_VIEW_TYPE, (leaf) => new GtdPomodoroView(leaf, this.services, this.pomodoro, this.checklists));
    this.registerView(CHECKLISTS_VIEW_TYPE, (leaf) => new GtdChecklistsView(leaf, this.services, this.checklists));
    this.register(this.pomodoro.start(this.addStatusBarItem()));
    const board = this.addRibbonIcon("list-checks", "Open GTD Action Board", () => void this.activateView(BOARD_VIEW_TYPE));
    const inbox = this.addRibbonIcon("inbox", "Open GTD Inbox", () => void this.activateView(INBOX_VIEW_TYPE));
    const projects = this.addRibbonIcon("folder-kanban", "Open GTD Projects", () => void this.activateView(PROJECTS_VIEW_TYPE));
    const review = this.addRibbonIcon("clipboard-check", "Start GTD Project Review", () => void this.activateView(REVIEW_VIEW_TYPE));
    this.addRibbonIcon("lightbulb", "Open GTD Brainstorm", () => void this.activateView(BRAINSTORM_VIEW_TYPE));
    this.addRibbonIcon("timer", "Open GTD Pomodoro", () => void this.openPomodoro());
    const checklists = this.addRibbonIcon("clipboard-list", "Open GTD Checklists", () => void this.openChecklists());
    const feeds = this.addRibbonIcon("rss", "Open RSS Feeds", () => void this.activateView(FEEDS_VIEW_TYPE));
    this.ribbonAttention = new RibbonAttention({ board, inbox, projects, review, feeds, checklists }, () =>
      attention(this.index.getSnapshot(), unreadItems(this.feeds.getStore()).length, this.settings, localDate(), this.checklists.dailyDue()));
    this.register(() => this.ribbonAttention.stop());
    this.addSettingTab(new GtdSettingTab(this.app, this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(() => void this.initializeIndex());
    // Sessions finished while offline, or on a device without the mite key, go out once the vault has settled.
    this.app.workspace.onLayoutReady(() => {
      const timer = window.setTimeout(() => void this.sendToMite(false), 30_000);
      this.register(() => window.clearTimeout(timer));
    });
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
      projectBoardColumnsBy: saved?.projectBoardColumnsBy === "area" ? "area" : "status",
      // "Group by area" was the first form of area sections.
      projectBoardSections: saved?.projectBoardSections === "area" || saved?.projectBoardSections === "status"
        ? saved.projectBoardSections
        : (saved as { groupProjectBoardByArea?: unknown } | null)?.groupProjectBoardByArea === true ? "area" : "none",
      weeklyReviewDay: Number.isInteger(saved?.weeklyReviewDay) && saved!.weeklyReviewDay! >= 0 && saved!.weeklyReviewDay! <= 6
        ? saved!.weeklyReviewDay!
        : defaults.weeklyReviewDay,
      lastWeeklyReview: typeof saved?.lastWeeklyReview === "string" ? saved.lastWeeklyReview : defaults.lastWeeklyReview,
      projectBoardColumns: Array.isArray(saved?.projectBoardColumns)
        ? saved.projectBoardColumns.filter((status) => isProjectStatus(status))
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
        mite: parseMiteSettings(saved?.pomodoro?.mite, localDate()),
      },
      checklists: {
        directory: normalizeVaultPath(saved?.checklists?.directory ?? "") || defaults.checklists.directory,
        storePath: normalizeVaultPath(saved?.checklists?.storePath ?? "") || defaults.checklists.storePath,
        daily: typeof saved?.checklists?.daily === "string" ? normalizeVaultPath(saved.checklists.daily) : "",
      },
      agent: {
        runsDirectory: typeof saved?.agent?.runsDirectory === "string" ? saved.agent.runsDirectory.trim() : defaults.agent.runsDirectory,
        kitDirectory: typeof saved?.agent?.kitDirectory === "string" ? saved.agent.kitDirectory.trim() : defaults.agent.kitDirectory,
        dockerPath: typeof saved?.agent?.dockerPath === "string" ? saved.agent.dockerPath.trim() : defaults.agent.dockerPath,
        keychainService: typeof saved?.agent?.keychainService === "string" && saved.agent.keychainService.trim()
          ? saved.agent.keychainService.trim()
          : defaults.agent.keychainService,
        defaultBudgetUsd: typeof saved?.agent?.defaultBudgetUsd === "number" && saved.agent.defaultBudgetUsd > 0
          ? saved.agent.defaultBudgetUsd
          : defaults.agent.defaultBudgetUsd,
        model: typeof saved?.agent?.model === "string" && saved.agent.model.trim() ? saved.agent.model.trim() : defaults.agent.model,
        localModel: typeof saved?.agent?.localModel === "string" ? saved.agent.localModel.trim() : defaults.agent.localModel,
        localModelUrl: typeof saved?.agent?.localModelUrl === "string" && saved.agent.localModelUrl.trim()
          ? saved.agent.localModelUrl.trim()
          : defaults.agent.localModelUrl,
        localKeychainService: typeof saved?.agent?.localKeychainService === "string"
          ? saved.agent.localKeychainService.trim()
          : defaults.agent.localKeychainService,
        localMaxMinutes: Number.isInteger(saved?.agent?.localMaxMinutes) && saved!.agent!.localMaxMinutes > 0
          ? saved!.agent!.localMaxMinutes
          : defaults.agent.localMaxMinutes,
        reportToInbox: saved?.agent?.reportToInbox !== false,
        maxTurns: Number.isInteger(saved?.agent?.maxTurns) && saved!.agent!.maxTurns > 0
          ? saved!.agent!.maxTurns
          : defaults.agent.maxTurns,
        codexHomeDirectory: typeof saved?.agent?.codexHomeDirectory === "string" ? saved.agent.codexHomeDirectory.trim() : "",
        codexModel: typeof saved?.agent?.codexModel === "string" ? saved.agent.codexModel.trim() : "",
        codexMaxMinutes: Number.isInteger(saved?.agent?.codexMaxMinutes) && saved!.agent!.codexMaxMinutes > 0
          ? saved!.agent!.codexMaxMinutes
          : defaults.agent.codexMaxMinutes,
        localMaxTurns: Number.isInteger(saved?.agent?.localMaxTurns) && saved!.agent!.localMaxTurns > 0
          ? saved!.agent!.localMaxTurns
          : defaults.agent.localMaxTurns,
        localMaxReplyTokens: Number.isInteger(saved?.agent?.localMaxReplyTokens) && saved!.agent!.localMaxReplyTokens >= 512
          ? saved!.agent!.localMaxReplyTokens
          : defaults.agent.localMaxReplyTokens,
        localContextTokens: Number.isInteger(saved?.agent?.localContextTokens) && saved!.agent!.localContextTokens >= 4096
          ? saved!.agent!.localContextTokens
          : defaults.agent.localContextTokens,
      },
      feeds: {
        ...defaults.feeds,
        ...(saved?.feeds ?? {}),
        storePath: normalizeVaultPath(saved?.feeds?.storePath ?? "") || defaults.feeds.storePath,
        refreshMinutes: Number.isInteger(saved?.feeds?.refreshMinutes) && saved!.feeds!.refreshMinutes >= 5
          ? saved!.feeds!.refreshMinutes
          : defaults.feeds.refreshMinutes,
        readingContext: typeof saved?.feeds?.readingContext === "string" && saved.feeds.readingContext.trim()
          ? saved.feeds.readingContext.trim()
          : defaults.feeds.readingContext,
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
    this.addCommand({ id: "open-checklists", name: "Open Checklists", callback: () => void this.openChecklists() });
    this.addCommand({ id: "run-daily-checklist", name: "Run the daily checklist", callback: () => void this.runDailyChecklist() });
    this.addCommand({ id: "send-pomodoros-to-mite", name: "Send Pomodoros to mite", callback: () => void this.sendToMite(true) });
    this.addCommand({ id: "open-feeds", name: "Open RSS Feeds", callback: () => void this.activateView(FEEDS_VIEW_TYPE) });
    this.addCommand({ id: "fetch-feeds", name: "Fetch RSS Feeds", callback: () => void this.fetchFeedsWithNotice() });
    this.addCommand({ id: "import-email", name: "Import Email", callback: () => void this.importMailWithNotice() });
    this.addCommand({
      id: "quick-capture-inbox-item",
      name: "Quick Capture Inbox Item",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
      callback: () => this.quickCapture(),
    });
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
    this.register(this.checklists.start());
    this.register(this.mail.start());
    this.register(this.agent.start());
    // Dots on the ribbon icons for views with something to do; the hourly pass catches a new day.
    this.register(this.index.subscribe(() => {
      this.ribbonAttention.schedule();
      void this.recordFinishedWeeklyReview();
    }));
    this.register(this.feeds.subscribe(() => this.ribbonAttention.schedule()));
    this.register(this.checklists.subscribe(() => this.ribbonAttention.schedule()));
    this.registerInterval(window.setInterval(() => {
      this.ribbonAttention.schedule();
      void this.recordFinishedWeeklyReview();
    }, 60 * 60_000));
    await this.recordFinishedWeeklyReview();
    this.ribbonAttention.update();
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
    if (count) new Notice(`Dragonglass GTD found ${count} file${count === 1 ? "" : "s"} with problems.`);
  }

  private async activateScheduledProjects(): Promise<void> {
    if (this.activationRun) return this.activationRun;
    const run = (async () => {
      let activated = 0;
      let failed = 0;
      for (const project of projectsDueForActivation(this.index.getSnapshot().projects)) {
        try {
          // The date was chosen deliberately, so the Projects above follow it, even a
          // finished one; the notice says which, since nobody was asked.
          const parents = ancestorsToActivate(project.parentProjectId, this.index.getSnapshot().projectsById);
          // Keep activate_at as the calendar record of the automatic transition.
          await this.repository.updateProject(project.id, { status: "active" }, { reopenAncestors: true });
          activated += 1;
          if (parents.length) {
            const reopened = parents.filter((parent) => parent.status === "completed" || parent.status === "cancelled");
            new Notice(`Activated “${project.title}” on schedule, and above it ${quotedTitles(parents)}`
              + (reopened.length ? `, reopening ${quotedTitles(reopened)}.` : "."), 15_000);
          }
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

  private createProject(openAfterCreate = true, parentProjectId = "", status?: ProjectStatus): void {
    new ElmModal(this.services, { kind: "new-project", ...(parentProjectId ? { parentProjectId } : {}), ...(status ? { status } : {}) }, {
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

  private editAction(id: string, allowProjectConversion = false, status?: ActionStatus): void {
    if (!this.index.getSnapshot().actionsById.has(id)) return void new Notice("This Action is missing or has a duplicate ID.");
    new ElmModal(this.services, { kind: "edit-action", actionId: id, allowProjectConversion, ...(status ? { status } : {}) }).open();
  }

  private editProject(id: string): void {
    if (!this.index.getSnapshot().projectsById.has(id)) return void new Notice("This Project is missing or has a duplicate ID.");
    new ElmModal(this.services, { kind: "edit-project", projectId: id }).open();
  }

  private async openPomodoro(projectId?: string): Promise<void> {
    const leaf = await this.activateView(POMODORO_VIEW_TYPE);
    if (projectId && leaf.view instanceof GtdPomodoroView) leaf.view.select({ kind: "project", projectId });
  }

  /** Opens the view a Dragonglass link names, or says which names there are. */
  private openViewLink(view: unknown): void {
    const name = viewLinkName(view);
    if (!name) {
      new Notice(`Dragonglass has no view called “${typeof view === "string" ? view : ""}”. Links can open: ${VIEW_LINK_NAMES.join(", ")}.`, 10_000);
      return;
    }
    void this.activateView(LINKED_VIEWS[name]);
  }

  private async openChecklistPomodoro(path: string): Promise<void> {
    const leaf = await this.activateView(POMODORO_VIEW_TYPE);
    if (leaf.view instanceof GtdPomodoroView) leaf.view.select({ kind: "checklist", path });
  }

  private async openChecklists(runId?: string): Promise<void> {
    const leaf = await this.activateView(CHECKLISTS_VIEW_TYPE);
    if (runId && leaf.view instanceof GtdChecklistsView) leaf.view.showRun(runId);
  }

  /** Starts the daily checklist, or goes on with today's run of it. */
  private async runDailyChecklist(): Promise<void> {
    const daily = this.settings.checklists.daily;
    if (!daily) return void new Notice("Choose a daily checklist in the Checklists settings first.");
    try {
      const run = await this.checklists.begin(daily);
      await this.openChecklists(run.id);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not start the daily checklist.");
    }
  }

  /** Picks the Project for a new session from those still open. */
  private pickPomodoroProject(): void {
    const projects = this.index.getSnapshot().projects.filter((project) => project.status !== "completed" && project.status !== "cancelled");
    if (!projects.length) return void new Notice("There are no open Projects to focus on.");
    new OpenProjectModal(this.app, projects, (project) => void this.openPomodoro(project.id)).open();
  }

  private async pomodoroFinished(session: PomodoroSession): Promise<void> {
    await this.logPomodoro(session);
    void this.sendToMite(false);
  }

  /** Every Project, for the settings' mite mapping. */
  projectList(): readonly Project[] {
    return this.index.getSnapshot().projects;
  }

  /**
   * Sends unsent Pomodoros to mite. Quiet when nothing happened, unless asked by hand;
   * a session whose Project has no mite project yet is named once so it isn't forgotten.
   */
  async sendToMite(announce: boolean): Promise<void> {
    const settings = this.settings.pomodoro.mite;
    if (!settings.enabled) {
      if (announce) new Notice("Turn on mite in the Pomodoro settings first.");
      return;
    }
    if (!this.mite.ready() && !announce) return;
    const result = await this.mite.sync();
    const parts = [
      result.sent ? `Sent ${result.sent} Pomodoro${result.sent === 1 ? "" : "s"} to mite.` : "",
      result.unmapped ? `${result.unmapped} wait${result.unmapped === 1 ? "s" : ""} for a mite project: set one for the Project in the Pomodoro settings.` : "",
      result.error ? `Not sent: ${result.error}` : "",
    ].filter(Boolean);
    if (parts.length) new Notice(parts.join(" "), result.error ? 10_000 : 5_000);
    else if (announce) new Notice("Every finished Pomodoro is already in mite.");
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

  /**
   * Records the week's review as finished once no Project tree is left in it, so a
   * Project added later in the week waits for the next review instead of reopening it.
   * Only a read vault counts: before the first index pass everything looks reviewed.
   */
  private async recordFinishedWeeklyReview(): Promise<void> {
    const snapshot = this.index.getSnapshot();
    if (snapshot.revision === 0 || !weeklyReviewFinished(snapshot, this.settings)) return;
    this.settings.lastWeeklyReview = localDate();
    await this.saveSettings(false);
    this.ribbonAttention.schedule();
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
    appleMailLink: account?.appleMailLink === true,
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
        // Deferring Actions and the work flag were removed, and their filters with them.
        const kind = (filter as { kind: string }).kind;
        if (kind === "availability" || kind === "work") return [];
        if (filter.kind !== "value" || filter.field !== "status") return [filter];
        const values = filter.values.filter((value) => value !== "inbox" && value !== "someday");
        return values.length ? [{ ...filter, values }] : [];
      }),
      visibleColumns: view.visibleColumns?.filter((column) => column !== "inbox" && column !== "someday") ?? null,
    }));
}

function quotedTitles(projects: readonly Project[]): string {
  return projects.map((project) => `“${project.title}”`).join(", ");
}
