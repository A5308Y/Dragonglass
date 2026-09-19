import { ItemView, WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { ActionBoard } from "./board/board";
import { BrainstormView } from "./brainstorm/brainstorm";
import { InboxView } from "./inbox/inbox";
import { ProjectsView } from "./projects/projects";
import { ProjectReview } from "./review/project-review";
import type { GtdServices } from "./ui/services";

export const BOARD_VIEW_TYPE = "dragonglass-action-board";
export const BRAINSTORM_VIEW_TYPE = "dragonglass-brainstorm";
export const INBOX_VIEW_TYPE = "dragonglass-inbox";
export const PROJECTS_VIEW_TYPE = "dragonglass-projects";
export const REVIEW_VIEW_TYPE = "dragonglass-project-review";

export class GtdBrainstormView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) { super(leaf); }
  getViewType(): string { return BRAINSTORM_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Brainstorm"; }
  getIcon(): string { return "lightbulb"; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> { render(null, this.contentEl); }
  refresh(): void { render(null, this.contentEl); render(<BrainstormView services={this.services} />, this.contentEl); }
}

export class GtdProjectReviewView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) { super(leaf); }
  getViewType(): string { return REVIEW_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Project Review"; }
  getIcon(): string { return "clipboard-check"; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> { render(null, this.contentEl); }
  refresh(): void { render(null, this.contentEl); render(<ProjectReview services={this.services} />, this.contentEl); }
}

export class GtdInboxView extends ItemView {
  private processing = false;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) {
    super(leaf);
  }

  getViewType(): string { return INBOX_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Inbox"; }
  getIcon(): string { return "inbox"; }

  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> { render(null, this.contentEl); }

  startProcessing(): void {
    this.processing = true;
    this.refresh();
  }

  refresh(): void {
    render(null, this.contentEl);
    render(<InboxView services={this.services} initialProcessing={this.processing} />, this.contentEl);
  }
}

export class ActionBoardView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) {
    super(leaf);
  }

  getViewType(): string { return BOARD_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Actions"; }
  getIcon(): string { return "list-checks"; }

  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> { render(null, this.contentEl); }

  refresh(): void {
    render(null, this.contentEl);
    render(<ActionBoard services={this.services} />, this.contentEl);
  }
}

export class GtdProjectsView extends ItemView {
  private projectId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly services: GtdServices) {
    super(leaf);
  }

  getViewType(): string { return PROJECTS_VIEW_TYPE; }
  getDisplayText(): string { return "GTD Projects"; }
  getIcon(): string { return "folder-kanban"; }

  async setState(state: unknown, result: { history: boolean }): Promise<void> {
    if (state && typeof state === "object" && "projectId" in state && typeof state.projectId === "string") this.projectId = state.projectId;
    else this.projectId = null;
    await super.setState(state, result);
    this.refresh();
  }

  getState(): Record<string, unknown> { return this.projectId ? { projectId: this.projectId } : {}; }
  async onOpen(): Promise<void> { this.refresh(); }
  async onClose(): Promise<void> { render(null, this.contentEl); }

  showProject(projectId: string): void {
    this.projectId = projectId;
    this.refresh();
  }

  refresh(): void {
    render(null, this.contentEl);
    render(<ProjectsView services={this.services} initialProjectId={this.projectId} />, this.contentEl);
  }
}
