import { ItemView, WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { ActionBoard } from "./board/board";
import { ProjectsView } from "./projects/projects";
import type { GtdServices } from "./ui/services";

export const BOARD_VIEW_TYPE = "dragonglass-action-board";
export const PROJECTS_VIEW_TYPE = "dragonglass-projects";

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
