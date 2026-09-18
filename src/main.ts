import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { isActionStatus } from "./domain/validation";
import type { GtdSettings, InboxItem, SavedView } from "./domain/types";
import { GtdIndex } from "./repository/gtd-index";
import { GtdRepository } from "./repository/gtd-repository";
import { defaultSettings } from "./state/defaults";
import { GtdSettingTab } from "./settings";
import { ActionEditorModal, ProcessInboxItemModal, ProjectEditorModal, TextPromptModal } from "./ui/modals";
import type { GtdServices } from "./ui/services";
import { ActionBoardView, BOARD_VIEW_TYPE, BRAINSTORM_VIEW_TYPE, GtdBrainstormView, GtdInboxView, GtdProjectReviewView, GtdProjectsView, INBOX_VIEW_TYPE, PROJECTS_VIEW_TYPE, REVIEW_VIEW_TYPE } from "./views";

export default class DragonglassGtdPlugin extends Plugin {
  declare settings: GtdSettings;
  private index!: GtdIndex;
  private repository!: GtdRepository;
  private services!: GtdServices;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.index = new GtdIndex(this.app.vault, this.app.metadataCache);
    this.repository = new GtdRepository(this.app, this.index, () => this.settings);
    this.services = {
      app: this.app,
      repository: this.repository,
      getSettings: () => this.settings,
      saveSettings: async (settings) => {
        this.settings = settings;
        await this.saveSettings();
      },
      openFile: (file) => this.openFile(file),
      quickCapture: () => this.quickCapture(),
      openInbox: () => void this.activateView(INBOX_VIEW_TYPE),
      processInboxItem: (item) => this.processInboxItem(item),
      createProject: () => this.createProject(),
      editAction: (id) => this.editAction(id),
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

    this.app.workspace.onLayoutReady(() => {
      this.index.initialize(this);
      const count = this.index.getSnapshot().issues.length;
      if (count) new Notice(`Dragonglass GTD found ${count} file${count === 1 ? "" : "s"} with invalid or duplicate metadata.`);
    });
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
      savedViews: Array.isArray(saved?.savedViews) ? migrateSavedViews(saved.savedViews) : defaults.savedViews,
      defaultActionStatus: isActionStatus(saved?.defaultActionStatus) ? saved.defaultActionStatus : defaults.defaultActionStatus,
      schemaVersion: defaults.schemaVersion,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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

  private registerCommands(): void {
    this.addCommand({ id: "open-action-board", name: "Open Action Board", callback: () => void this.activateView(BOARD_VIEW_TYPE) });
    this.addCommand({ id: "open-inbox", name: "Open Inbox", callback: () => void this.activateView(INBOX_VIEW_TYPE) });
    this.addCommand({ id: "open-projects", name: "Open Projects", callback: () => void this.activateView(PROJECTS_VIEW_TYPE) });
    this.addCommand({ id: "start-project-review", name: "Start Project Review", callback: () => void this.activateView(REVIEW_VIEW_TYPE) });
    this.addCommand({ id: "open-brainstorm", name: "Open Brainstorm", callback: () => void this.activateView(BRAINSTORM_VIEW_TYPE) });
    this.addCommand({ id: "quick-capture-inbox-item", name: "Quick Capture Inbox Item", callback: () => this.quickCapture() });
    this.addCommand({ id: "new-project", name: "New Project", callback: () => this.createProject() });
  }

  private quickCapture(): void {
    new TextPromptModal(this.app, "Quick Capture Inbox Item", "What's on your mind?", async (title) => {
      await this.repository.createInboxItem(title);
      new Notice("Captured to Inbox.");
    }).open();
  }

  private processInboxItem(item: InboxItem): void {
    if (!this.index.getSnapshot().inboxItemsById.has(item.id)) return void new Notice("This Inbox Item is missing or has a duplicate ID.");
    new ProcessInboxItemModal(this.services, item).open();
  }

  private createProject(): void {
    new TextPromptModal(this.app, "New Project", "Project title", async (title) => {
      const file = await this.repository.createProject({ title });
      await this.openFile(file);
    }).open();
  }

  private editAction(id: string): void {
    const action = this.index.getSnapshot().actionsById.get(id);
    if (!action) return void new Notice("This Action is missing or has a duplicate ID.");
    new ActionEditorModal(this.services, action).open();
  }

  private editProject(id: string): void {
    const project = this.index.getSnapshot().projectsById.get(id);
    if (!project) return void new Notice("This Project is missing or has a duplicate ID.");
    new ProjectEditorModal(this.services, project).open();
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

  private async openProjectDetail(id: string): Promise<void> {
    const leaf = await this.activateView(PROJECTS_VIEW_TYPE);
    if (leaf.view instanceof GtdProjectsView) leaf.view.showProject(id);
  }
}

function migrateSavedViews(views: SavedView[]): SavedView[] {
  return views
    .filter((view) => view.id !== "default-inbox" && !view.filters.some((filter) =>
      filter.kind === "value"
      && filter.field === "status"
      && filter.operator === "in"
      && filter.values.length > 0
      && filter.values.every((value) => value === "inbox")
    ))
    .map((view) => ({
      ...view,
      filters: view.filters.flatMap((filter) => {
        if (filter.kind !== "value" || filter.field !== "status") return [filter];
        const values = filter.values.filter((value) => value !== "inbox");
        return values.length ? [{ ...filter, values }] : [];
      }),
      visibleColumns: view.visibleColumns?.filter((column) => column !== "inbox") ?? null,
    }));
}
