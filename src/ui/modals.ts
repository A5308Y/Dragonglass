import {
  AbstractInputSuggest,
  App,
  ButtonComponent,
  Modal,
  Notice,
  prepareFuzzySearch,
  Setting,
  TextComponent,
} from "obsidian";
import { ACTION_STATUSES, PROJECT_STATUSES, type Action, type ActionStatus, type Project, type ProjectStatus } from "../domain/types";
import { projectBreadcrumb, projectBreadcrumbs, projectDescendantIds } from "../domain/project-hierarchy";
import type { GtdServices } from "./services";

abstract class FormModal extends Modal {
  protected formEl!: HTMLFormElement;
  protected actionsEl!: HTMLDivElement;
  private readonly popovers: Array<{ close(): void }> = [];

  onOpen(): void {
    this.modalEl.addClass("dg-modal-shell");
    this.contentEl.addClass("dg-modal");
    this.formEl = this.contentEl.createEl("form");
    this.actionsEl = this.formEl.createDiv({ cls: "dg-modal-actions" });
    this.formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.renderForm();
  }

  protected abstract renderForm(): void;
  protected abstract submit(): Promise<void>;

  protected registerPopover(popover: { close(): void }): void {
    this.popovers.push(popover);
  }

  protected addSubmit(label = "Save"): void {
    new ButtonComponent(this.actionsEl).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(this.actionsEl).setButtonText(label).setCta().buttonEl.type = "submit";
  }

  protected fail(error: unknown): void {
    new Notice(error instanceof Error ? error.message : "The GTD operation failed.");
  }

  onClose(): void {
    for (const popover of this.popovers) popover.close();
    this.contentEl.empty();
  }
}

export class TextPromptModal extends FormModal {
  private value = "";

  constructor(app: App, private readonly titleText: string, private readonly placeholder: string, private readonly onSubmit: (value: string) => Promise<void>) {
    super(app);
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: this.titleText });
    const setting = new Setting(this.formEl).setName("Title");
    setting.addText((text) => {
      text.setPlaceholder(this.placeholder).onChange((value) => (this.value = value));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Create");
  }

  protected async submit(): Promise<void> {
    if (!this.value.trim()) {
      new Notice("A title is required.");
      return;
    }
    try {
      await this.onSubmit(this.value.trim());
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}

export class ActionEditorModal extends FormModal {
  private title: string;
  private status: ActionStatus;
  private projectId: string;
  private projectQuery: string;
  private context: string;
  private energy: string;
  private due: string;
  private deferUntil: string;

  constructor(private readonly services: GtdServices, private readonly action: Action) {
    super(services.app);
    this.title = action.title;
    this.status = action.status;
    const project = action.projectId ? services.repository.index.getSnapshot().projectsById.get(action.projectId) : undefined;
    this.projectId = project?.id ?? "";
    this.projectQuery = project
      ? projectBreadcrumb(project, services.repository.index.getSnapshot().projectsById)
      : action.projectId ? `Missing Project: ${action.projectId}` : "";
    this.context = action.context ?? "";
    this.energy = action.energy ?? "";
    this.due = action.due ?? "";
    this.deferUntil = action.deferUntil ?? "";
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: "Edit Action" });
    addText(this.formEl, "Title", this.title, (value) => (this.title = value));
    new Setting(this.formEl).setName("Status").addDropdown((dropdown) => {
      for (const status of ACTION_STATUSES) dropdown.addOption(status, label(status));
      dropdown.setValue(this.status).onChange((value) => (this.status = value as ActionStatus));
    });
    addProjectSearch(
      this.formEl,
      this.services.app,
      this.services.repository.index.getSnapshot().projects,
      this.projectQuery,
      (projectId, query) => {
        this.projectId = projectId;
        this.projectQuery = query;
      },
      (popover) => this.registerPopover(popover),
    );
    addText(this.formEl, "Context", this.context, (value) => (this.context = value), "computer");
    addText(this.formEl, "Energy", this.energy, (value) => (this.energy = value), "medium");
    addDate(this.formEl, "Due", this.due, (value) => (this.due = value));
    addDate(this.formEl, "Defer until", this.deferUntil, (value) => (this.deferUntil = value));
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit();
  }

  protected async submit(): Promise<void> {
    if (!this.title.trim()) {
      new Notice("A title is required.");
      return;
    }
    if (!validateProjectSelection(this.projectId, this.projectQuery)) return;
    try {
      await this.services.repository.updateAction(this.action.id, {
        title: this.title.trim(),
        status: this.status,
        projectId: this.projectId,
        context: this.context.trim(),
        energy: this.energy.trim(),
        due: this.due,
        deferUntil: this.deferUntil,
      });
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}

export class NewProjectModal extends FormModal {
  private title = "";
  private parentProjectId: string;
  private parentProjectQuery: string;

  constructor(
    private readonly services: GtdServices,
    private readonly onCreated: (file: import("obsidian").TFile) => Promise<void>,
    parentProjectId = "",
  ) {
    super(services.app);
    const snapshot = services.repository.index.getSnapshot();
    const parent = parentProjectId ? snapshot.projectsById.get(parentProjectId) : undefined;
    this.parentProjectId = parent?.id ?? "";
    this.parentProjectQuery = parent ? projectBreadcrumb(parent, snapshot.projectsById) : "";
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: this.parentProjectId ? "New Sub-project" : "New Project" });
    new Setting(this.formEl).setName("Title").addText((text) => {
      text.setPlaceholder("Project title").onChange((value) => (this.title = value));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    addProjectSearch(
      this.formEl,
      this.services.app,
      this.services.repository.index.getSnapshot().projects,
      this.parentProjectQuery,
      (projectId, query) => {
        this.parentProjectId = projectId;
        this.parentProjectQuery = query;
      },
      (popover) => this.registerPopover(popover),
      { name: "Parent Project", description: "Optional. Type to fuzzy-search the full Project hierarchy." },
    );
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Create");
  }

  protected async submit(): Promise<void> {
    if (!this.title.trim()) return void new Notice("A Project title is required.");
    if (!validateProjectSelection(this.parentProjectId, this.parentProjectQuery)) return;
    try {
      const file = await this.services.repository.createProject({
        title: this.title.trim(),
        ...(this.parentProjectId ? { parentProjectId: this.parentProjectId } : {}),
      });
      await this.onCreated(file);
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}

export class ProjectEditorModal extends FormModal {
  private title: string;
  private status: ProjectStatus;
  private area: string;
  private reviewed: string;
  private parentProjectId: string;
  private parentProjectQuery: string;

  constructor(private readonly services: GtdServices, private readonly project: Project) {
    super(services.app);
    this.title = project.title;
    this.status = project.status;
    this.area = project.area ?? "";
    this.reviewed = project.reviewed ?? "";
    const snapshot = services.repository.index.getSnapshot();
    const parent = project.parentProjectId ? snapshot.projectsById.get(project.parentProjectId) : undefined;
    this.parentProjectId = parent?.id ?? "";
    this.parentProjectQuery = parent
      ? projectBreadcrumb(parent, snapshot.projectsById)
      : project.parentProjectId ? `Missing Project: ${project.parentProjectId}` : "";
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: "Edit Project" });
    addText(this.formEl, "Title", this.title, (value) => (this.title = value));
    new Setting(this.formEl).setName("Status").addDropdown((dropdown) => {
      for (const status of PROJECT_STATUSES) dropdown.addOption(status, status === "someday" ? "Someday/Maybe" : label(status));
      dropdown.setValue(this.status).onChange((value) => (this.status = value as ProjectStatus));
    });
    addText(this.formEl, "Area", this.area, (value) => (this.area = value));
    const snapshot = this.services.repository.index.getSnapshot();
    const excluded = projectDescendantIds(this.project.id, snapshot.projects);
    excluded.add(this.project.id);
    addProjectSearch(
      this.formEl,
      this.services.app,
      snapshot.projects.filter((candidate) => !excluded.has(candidate.id)),
      this.parentProjectQuery,
      (projectId, query) => {
        this.parentProjectId = projectId;
        this.parentProjectQuery = query;
      },
      (popover) => this.registerPopover(popover),
      { name: "Parent Project", description: "Optional. Descendants are excluded to prevent hierarchy cycles." },
    );
    addDate(this.formEl, "Reviewed", this.reviewed, (value) => (this.reviewed = value));
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit();
  }

  protected async submit(): Promise<void> {
    if (!this.title.trim()) {
      new Notice("A title is required.");
      return;
    }
    if (!validateProjectSelection(this.parentProjectId, this.parentProjectQuery)) return;
    try {
      await this.services.repository.updateProject(this.project.id, {
        title: this.title.trim(),
        status: this.status,
        area: this.area.trim(),
        reviewed: this.reviewed,
        parentProjectId: this.parentProjectId,
      });
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}

function addText(container: HTMLElement, name: string, value: string, onChange: (value: string) => void, placeholder = ""): void {
  new Setting(container).setName(name).addText((text: TextComponent) => text.setValue(value).setPlaceholder(placeholder).onChange(onChange));
}

function addDate(container: HTMLElement, name: string, value: string, onChange: (value: string) => void): void {
  new Setting(container).setName(name).addText((text) => {
    text.inputEl.type = "date";
    text.setValue(value).onChange(onChange);
  });
}

function addProjectSearch(
  container: HTMLElement,
  app: App,
  projects: readonly Project[],
  value: string,
  onChange: (projectId: string, query: string) => void,
  registerPopover: (popover: ProjectInputSuggest) => void,
  configuration: { name?: string; description?: string } = {},
): void {
  const breadcrumbs = projectBreadcrumbs(projects);
  const sortedProjects = [...projects].sort((a, b) => (breadcrumbs.get(a.id) ?? a.title).localeCompare(breadcrumbs.get(b.id) ?? b.title));
  new Setting(container)
    .setName(configuration.name ?? "Project")
    .setDesc(configuration.description ?? "Type to fuzzy-search. Clear the field for no Project.")
    .addText((text) => {
      text.setValue(value).setPlaceholder(sortedProjects.length ? "Search Projects…" : "No Projects yet");
      text.onChange((query) => onChange("", query));
      const suggest = new ProjectInputSuggest(app, text.inputEl, sortedProjects, breadcrumbs, (project) => {
        onChange(project.id, breadcrumbs.get(project.id) ?? project.title);
      });
      registerPopover(suggest);
      text.inputEl.addEventListener("focus", () => text.inputEl.select(), { once: true });
    });
}

class ProjectInputSuggest extends AbstractInputSuggest<Project> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly projects: readonly Project[],
    private readonly breadcrumbs: ReadonlyMap<string, string>,
    private readonly choose: (project: Project) => void,
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  protected getSuggestions(query: string): Project[] {
    const trimmed = query.trim();
    if (!trimmed) return this.projects.slice(0, this.limit);
    const matches = prepareFuzzySearch(trimmed);
    return this.projects.filter((project) => matches(projectSearchText(project, this.breadcrumbs.get(project.id))) !== null).slice(0, this.limit);
  }

  renderSuggestion(project: Project, el: HTMLElement): void {
    el.addClass("dg-project-suggestion");
    el.createDiv({ cls: "dg-project-suggestion-title", text: this.breadcrumbs.get(project.id) ?? project.title });
    el.createDiv({
      cls: "dg-project-suggestion-meta",
      text: project.area ? `${project.area} · ${project.file.path}` : project.file.path,
    });
  }

  selectSuggestion(project: Project): void {
    this.setValue(this.breadcrumbs.get(project.id) ?? project.title);
    this.choose(project);
    this.close();
  }
}

function projectSearchText(project: Project, breadcrumb?: string): string {
  return [breadcrumb, project.title, project.area, project.file.path].filter(Boolean).join(" ");
}

function validateProjectSelection(projectId: string, query: string): boolean {
  if (!projectId && query.trim()) {
    new Notice("Choose a Project from the search results, or clear the Project field.");
    return false;
  }
  return true;
}

export function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
