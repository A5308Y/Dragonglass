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
import { parseActionList } from "../domain/action-import";
import { normalizeVaultPath } from "../utils/path";
import { confirmDeleteProject } from "./delete-project";
import { addImagePathSetting, resolveVaultImage } from "./image-input";
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
    const cancel = new ButtonComponent(this.actionsEl).setButtonText("Cancel").onClick(() => this.close());
    cancel.buttonEl.type = "button";
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

export class NewActionModal extends FormModal {
  private title = "";
  private status: ActionStatus;
  private projectId: string;
  private projectQuery: string;
  private context = "";
  private work = false;

  constructor(private readonly services: GtdServices, projectId = "") {
    super(services.app);
    const snapshot = services.repository.index.getSnapshot();
    const project = projectId ? snapshot.projectsById.get(projectId) : undefined;
    this.status = services.getSettings().defaultActionStatus;
    this.projectId = project?.id ?? "";
    this.projectQuery = project ? projectBreadcrumb(project, snapshot.projectsById) : "";
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: "New Action" });
    new Setting(this.formEl).setName("Title").addText((text) => {
      text.setPlaceholder("What is the next physical Action?").onChange((value) => (this.title = value));
      window.setTimeout(() => text.inputEl.focus(), 0);
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
    addContextSearch(
      this.formEl,
      this.services.app,
      this.services.repository.index.getSnapshot().actions,
      this.context,
      (value) => (this.context = value),
      (popover) => this.registerPopover(popover),
    );
    new Setting(this.formEl).setName("Status").addDropdown((dropdown) => {
      for (const status of ACTION_STATUSES) dropdown.addOption(status, label(status));
      dropdown.setValue(this.status).onChange((value) => (this.status = value as ActionStatus));
    });
    addWorkToggle(this.formEl, this.work, (value) => (this.work = value));
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Create Action");
  }

  protected async submit(): Promise<void> {
    if (!this.title.trim()) return void new Notice("An Action title is required.");
    if (!this.context.trim()) return void new Notice("A context is required.");
    if (!validateProjectSelection(this.projectId, this.projectQuery)) return;
    try {
      await this.services.repository.createClarifiedAction({
        title: this.title.trim(),
        status: this.status,
        ...(this.projectId ? { projectId: this.projectId } : {}),
        context: this.context.trim(),
        work: this.work,
      });
      new Notice("Action created.");
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
  private work: boolean;

  constructor(private readonly services: GtdServices, private readonly action: Action, private readonly allowProjectConversion = false) {
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
    this.work = action.work ?? false;
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
    addContextSearch(
      this.formEl,
      this.services.app,
      this.services.repository.index.getSnapshot().actions,
      this.context,
      (value) => (this.context = value),
      (popover) => this.registerPopover(popover),
    );
    addText(this.formEl, "Energy", this.energy, (value) => (this.energy = value), "medium");
    addDate(this.formEl, "Due", this.due, (value) => (this.due = value));
    addDate(this.formEl, "Defer until", this.deferUntil, (value) => (this.deferUntil = value));
    addWorkToggle(this.formEl, this.work, (value) => (this.work = value));
    this.formEl.appendChild(this.actionsEl);
    if (this.allowProjectConversion && this.action.projectId) {
      const convert = new ButtonComponent(this.actionsEl)
        .setButtonText("Convert to Sub-project")
        .onClick(() => void this.convertToSubproject());
      convert.buttonEl.type = "button";
    }
    this.addSubmit();
  }

  private async convertToSubproject(): Promise<void> {
    const title = this.title.trim();
    if (!title) return void new Notice("A sub-project title is required.");
    if (!validateProjectSelection(this.projectId, this.projectQuery) || !this.projectId) {
      return void new Notice("Select the parent Project before converting this Action.");
    }
    const parent = this.services.repository.index.getSnapshot().projectsById.get(this.projectId);
    if (!parent) return void new Notice("The selected parent Project no longer exists.");
    if (!window.confirm(
      `Convert “${this.action.title}” into an Active sub-project of “${parent.title}”?\n\nThe Action body will be copied to Project Notes, then the original Action will be moved to Obsidian's trash.`,
    )) return;
    try {
      await this.services.repository.convertActionToSubproject(this.action.id, title, parent.id);
      this.close();
      new Notice(`Converted “${this.action.title}” to a sub-project.`);
    } catch (error) {
      this.fail(error);
    }
  }

  protected async submit(): Promise<void> {
    if (!this.title.trim()) {
      new Notice("A title is required.");
      return;
    }
    if (!this.context.trim()) return void new Notice("A context is required.");
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
        work: this.work,
      });
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}

export class ImportActionsModal extends FormModal {
  private text = "";
  private projectId: string;
  private projectQuery: string;
  private summaryEl!: HTMLElement;
  private importing = false;

  constructor(private readonly services: GtdServices, projectId = "") {
    super(services.app);
    const snapshot = services.repository.index.getSnapshot();
    const project = projectId ? snapshot.projectsById.get(projectId) : undefined;
    this.projectId = project?.id ?? "";
    this.projectQuery = project ? projectBreadcrumb(project, snapshot.projectsById) : "";
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: "Import Actions" });
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
      { name: "Project", description: "Leave empty to import the Actions without a Project." },
    );
    new Setting(this.formEl)
      .setName("Pasted list")
      .setDesc("One Action per line. “#Work” sets the work flag, any other #tag becomes the context.")
      .addTextArea((text) => {
        text.setPlaceholder("- [ ] Draft the proposal #Laptop #Work").onChange((value) => {
          this.text = value;
          this.paintSummary();
        });
        text.inputEl.rows = 10;
        text.inputEl.addClass("dg-import-input");
        window.setTimeout(() => text.inputEl.focus(), 0);
      });
    this.summaryEl = this.formEl.createDiv({ cls: "dg-import-summary" });
    this.paintSummary();
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Import");
  }

  private paintSummary(): void {
    const parsed = parseActionList(this.text);
    const work = parsed.filter((action) => action.work).length;
    const contexts = [...new Set(parsed.flatMap((action) => action.contexts.slice(0, 1)))];
    this.summaryEl.empty();
    if (!parsed.length) {
      this.summaryEl.createSpan({ cls: "dg-muted", text: "Nothing to import yet." });
      return;
    }
    const parts = [`${parsed.length} Action${parsed.length === 1 ? "" : "s"}`, `${work} marked Work`];
    if (contexts.length) parts.push(`contexts: ${contexts.join(", ")}`);
    this.summaryEl.createSpan({ text: parts.join(" · ") });
  }

  protected async submit(): Promise<void> {
    if (this.importing) return;
    const parsed = parseActionList(this.text);
    if (!parsed.length) return void new Notice("Paste a list of Actions first.");
    if (parsed.some((action) => !action.contexts[0])) return void new Notice("Every imported Action needs a context tag.");
    if (!validateProjectSelection(this.projectId, this.projectQuery)) return;

    this.importing = true;
    try {
      const created = await this.services.repository.importActions(parsed.map((action) => ({
        title: action.title,
        status: action.done ? "done" as const : "next" as const,
        work: action.work,
        context: action.contexts[0] ?? "",
        ...(this.projectId ? { projectId: this.projectId } : {}),
      })));
      new Notice(`Imported ${created} Action${created === 1 ? "" : "s"}.`);
      this.close();
    } catch (error) {
      this.fail(error);
    } finally {
      this.importing = false;
    }
  }
}

export class NewProjectModal extends FormModal {
  private title = "";
  private image = "";
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
    addImagePathSetting(
      this.formEl,
      this.services.app,
      this.image,
      (value) => (this.image = value),
      (suggest) => this.registerPopover(suggest),
      { description: "Optional. Overrides the Default project image." },
    );
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
    const image = normalizeVaultPath(this.image);
    if (image && !resolveVaultImage(this.services.app, image, "")) return void new Notice("Select an image file from the vault.");
    if (!validateProjectSelection(this.parentProjectId, this.parentProjectQuery)) return;
    try {
      const file = await this.services.repository.createProject({
        title: this.title.trim(),
        ...(image ? { image } : {}),
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
  private image: string;
  private reviewed: string;
  private parentProjectId: string;
  private parentProjectQuery: string;
  private desiredOutcome = "";
  private loadedOutcome = "";
  private outcomeLoad: Promise<void> = Promise.resolve();

  constructor(private readonly services: GtdServices, private readonly project: Project) {
    super(services.app);
    this.title = project.title;
    this.status = project.status;
    this.area = project.area ?? "";
    this.image = project.image ?? "";
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
    addImagePathSetting(
      this.formEl,
      this.services.app,
      this.image,
      (value) => (this.image = value),
      (suggest) => this.registerPopover(suggest),
      { description: "Optional. Overrides the Default project image." },
    );
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
    this.renderDesiredOutcome();
    this.formEl.appendChild(this.actionsEl);
    const remove = new ButtonComponent(this.actionsEl).setButtonText("Delete Project").setWarning();
    remove.buttonEl.type = "button";
    remove.buttonEl.addClass("dg-modal-delete");
    remove.onClick(() => void this.deleteProject());
    this.addSubmit();
  }

  private async deleteProject(): Promise<void> {
    if (await confirmDeleteProject(this.services, this.project.id)) this.close();
  }

  /** The outcome lives in the note body, so it loads after the form is on screen. */
  private renderDesiredOutcome(): void {
    let edited = false;
    new Setting(this.formEl)
      .setName("Desired outcome")
      .setDesc("What will be true when this Project is complete?")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.addClass("dg-outcome-input");
        text.setPlaceholder("Loading…").onChange((value) => {
          edited = true;
          this.desiredOutcome = value;
        });
        this.outcomeLoad = this.services.repository.readDesiredOutcome(this.project)
          .then((value) => {
            this.loadedOutcome = value;
            text.setPlaceholder("What does done look like?");
            // Do not clobber anything typed while the note was being read.
            if (edited) return;
            this.desiredOutcome = value;
            text.setValue(value);
          })
          .catch(() => {
            text.setPlaceholder("Could not read the Desired outcome.");
          });
      });
  }

  protected async submit(): Promise<void> {
    if (!this.title.trim()) {
      new Notice("A title is required.");
      return;
    }
    const image = normalizeVaultPath(this.image);
    if (image && !resolveVaultImage(this.services.app, image, this.project.file.path)) {
      new Notice("Select an image file from the vault.");
      return;
    }
    if (!validateProjectSelection(this.parentProjectId, this.parentProjectQuery)) return;
    try {
      // Establish the original value before comparing, including when Save is
      // pressed while the note is still loading.
      await this.outcomeLoad;
      await this.services.repository.updateProject(this.project.id, {
        title: this.title.trim(),
        status: this.status,
        area: this.area.trim(),
        image,
        reviewed: this.reviewed,
        parentProjectId: this.parentProjectId,
      });
      if (this.desiredOutcome.trim() !== this.loadedOutcome.trim()) {
        await this.services.repository.setDesiredOutcome(this.project.id, this.desiredOutcome.trim());
      }
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}

function addText(container: HTMLElement, name: string, value: string, onChange: (value: string) => void, placeholder = ""): void {
  new Setting(container).setName(name).addText((text: TextComponent) => text.setValue(value).setPlaceholder(placeholder).onChange(onChange));
}

function addWorkToggle(container: HTMLElement, value: boolean, onChange: (value: boolean) => void): void {
  new Setting(container)
    .setName("Work")
    .setDesc("Independent of the Action's context.")
    .addToggle((toggle) => toggle.setValue(value).onChange(onChange));
}

function addDate(container: HTMLElement, name: string, value: string, onChange: (value: string) => void): void {
  new Setting(container).setName(name).addText((text) => {
    text.inputEl.type = "date";
    text.setValue(value).onChange(onChange);
  });
}

function addContextSearch(
  container: HTMLElement,
  app: App,
  actions: readonly Action[],
  value: string,
  onChange: (value: string) => void,
  registerPopover: (popover: ContextInputSuggest) => void,
): void {
  const contexts = [...new Set(actions.map((action) => action.context).filter((context): context is string => Boolean(context)))].sort();
  new Setting(container)
    .setName("Context")
    .setDesc("Required. Select an existing Context or type a new one.")
    .addText((text) => {
      text.setValue(value).setPlaceholder(contexts.length ? "Search or name a Context…" : "Name a Context…").onChange(onChange);
      const suggest = new ContextInputSuggest(app, text.inputEl, contexts, onChange);
      registerPopover(suggest);
    });
}

class ContextInputSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly contexts: readonly string[],
    private readonly choose: (context: string) => void,
  ) {
    super(app, inputEl);
    this.limit = 30;
  }

  protected getSuggestions(query: string): string[] {
    const trimmed = query.trim();
    if (!trimmed) return this.contexts.slice(0, this.limit);
    const matches = prepareFuzzySearch(trimmed);
    return this.contexts.filter((context) => matches(context) !== null).slice(0, this.limit);
  }

  renderSuggestion(context: string, el: HTMLElement): void {
    el.setText(`@${context}`);
  }

  selectSuggestion(context: string): void {
    this.setValue(context);
    this.choose(context);
    this.close();
  }
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
