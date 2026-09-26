import { ItemView, WorkspaceLeaf } from "obsidian";
import { ElmActionBoardHost } from "./adapter/elm-action-board";
import { ElmBrainstormHost } from "./adapter/elm-brainstorm";
import { ElmFeedsHost } from "./adapter/elm-feeds";
import { ElmInboxHost } from "./adapter/elm-inbox";
import { ElmProjectsHost } from "./adapter/elm-projects";
import { ElmProjectReviewHost } from "./adapter/elm-project-review";
import { ElmSomedayReviewHost } from "./adapter/elm-someday-review";
import { ElmPomodoroHost } from "./adapter/elm-pomodoro";
import type { PomodoroService } from "./pomodoro/pomodoro-service";
import type { FeedService } from "./feeds/feed-service";
import type { GtdServices } from "./ui/services";
import { routeModEnter } from "./ui/mod-enter";

export const BOARD_VIEW_TYPE = "dragonglass-action-board";
export const BRAINSTORM_VIEW_TYPE = "dragonglass-brainstorm";
export const FEEDS_VIEW_TYPE = "dragonglass-feeds";
export const INBOX_VIEW_TYPE = "dragonglass-inbox";
export const PROJECTS_VIEW_TYPE = "dragonglass-projects";
export const REVIEW_VIEW_TYPE = "dragonglass-project-review";
export const SOMEDAY_VIEW_TYPE = "dragonglass-someday-review";
export const POMODORO_VIEW_TYPE = "dragonglass-pomodoro";

export class GtdBrainstormView extends ItemView {
  private host: ElmBrainstormHost | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) { super(leaf); }
  getViewType(): string { return BRAINSTORM_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Brainstorm"; }
  getIcon(): string { return "lightbulb"; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
    this.contentEl.empty();
  }
  refresh(): void {
    if (this.host) return this.host.refresh();
    this.contentEl.empty();
    this.host = new ElmBrainstormHost(this.contentEl, this.services);
  }
}

export class GtdProjectReviewView extends ItemView {
  private host: ElmProjectReviewHost | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) { super(leaf); }
  getViewType(): string { return REVIEW_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Project Review"; }
  getIcon(): string { return "clipboard-check"; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
    this.contentEl.empty();
  }
  refresh(): void {
    if (this.host) return this.host.refresh();
    this.contentEl.empty();
    this.host = new ElmProjectReviewHost(this.contentEl, this.services, () => {
      // Same tab: the Someday/Maybe Review is the next step of the same review.
      void this.leaf.setViewState({ type: SOMEDAY_VIEW_TYPE, active: true });
    });
  }
}

export class GtdSomedayReviewView extends ItemView {
  private host: ElmSomedayReviewHost | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) { super(leaf); }
  getViewType(): string { return SOMEDAY_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Someday/Maybe Review"; }
  getIcon(): string { return "cloud"; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
    this.contentEl.empty();
  }
  refresh(): void {
    if (this.host) return this.host.refresh();
    this.contentEl.empty();
    this.host = new ElmSomedayReviewHost(this.contentEl, this.services);
  }
}

export class GtdPomodoroView extends ItemView {
  private host: ElmPomodoroHost | null = null;
  private pendingProjectId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices, private readonly pomodoro: PomodoroService) {
    super(leaf);
    routeModEnter(this);
  }
  getViewType(): string { return POMODORO_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Pomodoro"; }
  getIcon(): string { return "timer"; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
    this.contentEl.empty();
  }

  /** Chooses the Project for the next session; a running session is left alone. */
  selectProject(projectId: string): void {
    if (this.host) this.host.selectProject(projectId);
    else this.pendingProjectId = projectId;
  }

  refresh(): void {
    if (this.host) return this.host.refresh();
    this.contentEl.empty();
    this.host = new ElmPomodoroHost(this.contentEl, this.services, this.pomodoro, this.pendingProjectId);
    this.pendingProjectId = null;
  }
}

export class GtdFeedsView extends ItemView {
  private host: ElmFeedsHost | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices, private readonly feeds: FeedService) { super(leaf); }
  getViewType(): string { return FEEDS_VIEW_TYPE; }
  getDisplayText(): string { return "RSS Feeds"; }
  getIcon(): string { return "rss"; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
    this.contentEl.empty();
  }
  refresh(): void {
    if (this.host) return this.host.refresh();
    this.contentEl.empty();
    this.host = new ElmFeedsHost(this.contentEl, this.services, this.feeds);
  }
}

export class GtdInboxView extends ItemView {
  private processing = false;
  private processingItemId: string | undefined;
  private host: ElmInboxHost | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) {
    super(leaf);
    routeModEnter(this);
  }

  getViewType(): string { return INBOX_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Inbox"; }
  getIcon(): string { return "inbox"; }

  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
    this.contentEl.empty();
  }

  startProcessing(itemId?: string): void {
    this.processing = true;
    this.processingItemId = itemId;
    this.refresh();
  }

  refresh(): void {
    if (this.host) {
      this.host.refresh(this.processing, this.processingItemId);
      this.processing = false;
      this.processingItemId = undefined;
      return;
    }
    this.contentEl.empty();
    this.host = new ElmInboxHost(this.contentEl, this.services, this.processing);
    // A named Item arrives as an event, because the program is only told once at start-up.
    if (this.processing && this.processingItemId) this.host.refresh(true, this.processingItemId);
    this.processing = false;
    this.processingItemId = undefined;
  }
}

export class ActionBoardView extends ItemView {
  private host: ElmActionBoardHost | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) {
    super(leaf);
  }

  getViewType(): string { return BOARD_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Actions"; }
  getIcon(): string { return "list-checks"; }

  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
    this.contentEl.empty();
  }

  refresh(): void {
    if (this.host) {
      this.host.refresh();
      return;
    }
    this.contentEl.empty();
    this.host = new ElmActionBoardHost(this.contentEl, this.services);
  }
}

export class GtdProjectsView extends ItemView {
  private projectId: string | null = null;
  private host: ElmProjectsHost | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) {
    super(leaf);
    routeModEnter(this);
  }

  getViewType(): string { return PROJECTS_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Projects"; }
  getIcon(): string { return "folder-kanban"; }

  async setState(state: unknown, result: { history: boolean }): Promise<void> {
    if (state && typeof state === "object" && "projectId" in state && typeof state.projectId === "string") this.projectId = state.projectId;
    else this.projectId = null;
    await super.setState(state, result);
    if (this.host) this.host.setSelection(this.projectId);
    else this.refresh();
  }

  getState(): Record<string, unknown> { return this.projectId ? { projectId: this.projectId } : {}; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
    this.contentEl.empty();
  }

  showProject(projectId: string): void {
    this.projectId = projectId;
    if (this.host) this.host.showProject(projectId);
    else this.refresh();
  }


  refresh(): void {
    if (this.host) {
      this.host.refresh();
      return;
    }
    this.contentEl.empty();
    this.host = new ElmProjectsHost(this.contentEl, this.services, this.projectId, (projectId) => { this.projectId = projectId; });
  }
}
