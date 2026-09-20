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
import { ACTION_STATUSES, PROJECT_STATUSES, type Action, type ActionStatus, type Project, type ProjectChanges, type ProjectStatus } from "../domain/types";
import { projectBreadcrumb, projectBreadcrumbs, projectDescendantIds } from "../domain/project-hierarchy";
import { parseActionList } from "../domain/action-import";
import { parseSubprojectList } from "../domain/project-import";
import { parseProjectTags, planProjectParentChange, projectTagAdditions } from "../domain/project-board";
import { localDate } from "../utils/date";
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
  private waitingSince: string;
  private scheduledStart = "";
  private durationMinutes: string;
  private work = false;

  constructor(private readonly services: GtdServices, projectId = "") {
    super(services.app);
    const snapshot = services.repository.index.getSnapshot();
    const project = projectId ? snapshot.projectsById.get(projectId) : undefined;
    this.status = services.getSettings().defaultActionStatus;
    this.waitingSince = localDate();
    this.durationMinutes = String(services.getSettings().googleCalendar.defaultDurationMinutes);
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
    let updateStatusVisibility: () => void = () => undefined;
    new Setting(this.formEl).setName("Status").addDropdown((dropdown) => {
      for (const status of ACTION_STATUSES) dropdown.addOption(status, label(status));
      dropdown.setValue(this.status).onChange((value) => {
        this.status = value as ActionStatus;
        updateStatusVisibility();
      });
    });
    const waitingSetting = addWaitingSinceField(this.formEl, this.waitingSince, (value) => (this.waitingSince = value));
    const scheduleSettings = addScheduleFields(
      this.formEl,
      this.scheduledStart,
      this.durationMinutes,
      (value) => (this.scheduledStart = value),
      (value) => (this.durationMinutes = value),
    );
    updateStatusVisibility = () => {
      setScheduleVisibility(scheduleSettings, this.status === "scheduled");
      setScheduleVisibility([waitingSetting], this.status === "waiting");
    };
    updateStatusVisibility();
    addWorkToggle(this.formEl, this.work, (value) => (this.work = value));
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Create Action");
  }

  protected async submit(): Promise<void> {
    if (!this.title.trim()) return void new Notice("An Action title is required.");
    if (!this.context.trim()) return void new Notice("A context is required.");
    if (!validateProjectSelection(this.projectId, this.projectQuery)) return;
    const schedule = scheduleValues(this.status, this.scheduledStart, this.durationMinutes);
    if (!schedule) return;
    try {
      await this.services.repository.createClarifiedAction({
        title: this.title.trim(),
        status: this.status,
        ...(this.projectId ? { projectId: this.projectId } : {}),
        context: this.context.trim(),
        ...(this.status === "waiting" && this.waitingSince ? { waitingSince: this.waitingSince } : {}),
        ...schedule,
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
  private waitingSince: string;
  private scheduledStart: string;
  private durationMinutes: string;
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
    this.waitingSince = action.waitingSince ?? localDate();
    this.scheduledStart = dateTimeLocalValue(action.scheduledStart);
    this.durationMinutes = String(action.durationMinutes ?? services.getSettings().googleCalendar.defaultDurationMinutes);
    this.work = action.work ?? false;
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: "Edit Action" });
    addText(this.formEl, "Title", this.title, (value) => (this.title = value));
    let updateStatusVisibility: () => void = () => undefined;
    new Setting(this.formEl).setName("Status").addDropdown((dropdown) => {
      for (const status of ACTION_STATUSES) dropdown.addOption(status, label(status));
      dropdown.setValue(this.status).onChange((value) => {
        this.status = value as ActionStatus;
        updateStatusVisibility();
      });
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
    const waitingSetting = addWaitingSinceField(this.formEl, this.waitingSince, (value) => (this.waitingSince = value));
    const scheduleSettings = addScheduleFields(
      this.formEl,
      this.scheduledStart,
      this.durationMinutes,
      (value) => (this.scheduledStart = value),
      (value) => (this.durationMinutes = value),
    );
    updateStatusVisibility = () => {
      setScheduleVisibility(scheduleSettings, this.status === "scheduled");
      setScheduleVisibility([waitingSetting], this.status === "waiting");
    };
    updateStatusVisibility();
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
    const schedule = scheduleValues(this.status, this.scheduledStart, this.durationMinutes);
    if (!schedule) return;
    try {
      await this.services.repository.updateAction(this.action.id, {
        title: this.title.trim(),
        status: this.status,
        projectId: this.projectId,
        context: this.context.trim(),
        energy: this.energy.trim(),
        due: this.due,
        deferUntil: this.deferUntil,
        ...(this.status === "waiting" && this.waitingSince ? { waitingSince: this.waitingSince } : {}),
        ...schedule,
        work: this.work,
      });
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}

export class ScheduleActionModal extends FormModal {
  private scheduledStart: string;
  private durationMinutes: string;

  constructor(private readonly services: GtdServices, private readonly action: Action) {
    super(services.app);
    this.scheduledStart = dateTimeLocalValue(action.scheduledStart);
    this.durationMinutes = String(action.durationMinutes ?? services.getSettings().googleCalendar.defaultDurationMinutes);
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: `Schedule — ${this.action.title}` });
    this.formEl.createEl("p", { cls: "dg-muted", text: "Choose when this Action should occupy time on your calendar." });
    addScheduleFields(
      this.formEl,
      this.scheduledStart,
      this.durationMinutes,
      (value) => (this.scheduledStart = value),
      (value) => (this.durationMinutes = value),
    );
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Schedule Action");
  }

  protected async submit(): Promise<void> {
    const schedule = scheduleValues("scheduled", this.scheduledStart, this.durationMinutes);
    if (!schedule) return;
    try {
      await this.services.repository.updateAction(this.action.id, { status: "scheduled", ...schedule });
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

export class ImportSubprojectsModal extends FormModal {
  private text = "";
  private parentProjectId: string;
  private parentProjectQuery: string;
  private summaryEl!: HTMLElement;
  private importing = false;

  constructor(private readonly services: GtdServices, parentProjectId = "") {
    super(services.app);
    const snapshot = services.repository.index.getSnapshot();
    const parent = parentProjectId ? snapshot.projectsById.get(parentProjectId) : undefined;
    this.parentProjectId = parent?.id ?? "";
    this.parentProjectQuery = parent ? projectBreadcrumb(parent, snapshot.projectsById) : "";
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: "Import Sub-projects" });
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
      { name: "Parent Project", description: "Required. Every imported Project becomes an immediate child of this Project." },
    );
    new Setting(this.formEl)
      .setName("Pasted list")
      .setDesc("One Sub-project per line. Checked items become Done; #tags become Project tags.")
      .addTextArea((text) => {
        text.setPlaceholder("- [ ] Research suppliers #planning\n- [x] Choose a supplier").onChange((value) => {
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
    const parsed = parseSubprojectList(this.text);
    this.summaryEl.empty();
    if (!parsed.length) {
      this.summaryEl.createSpan({ cls: "dg-muted", text: "Nothing to import yet." });
      return;
    }
    const completed = parsed.filter((project) => project.done).length;
    const tags = [...new Set(parsed.flatMap((project) => project.tags))];
    const parts = [`${parsed.length} Sub-project${parsed.length === 1 ? "" : "s"}`, `${completed} Done`];
    if (tags.length) parts.push(`tags: ${tags.join(", ")}`);
    this.summaryEl.createSpan({ text: parts.join(" · ") });
  }

  protected async submit(): Promise<void> {
    if (this.importing) return;
    const parsed = parseSubprojectList(this.text);
    if (!parsed.length) return void new Notice("Paste a list of Sub-projects first.");
    if (!validateProjectSelection(this.parentProjectId, this.parentProjectQuery)) return;
    if (!this.parentProjectId) return void new Notice("Choose a parent Project.");

    this.importing = true;
    try {
      const created = await this.services.repository.importSubprojects(
        this.parentProjectId,
        parsed.map((project) => ({
          title: project.title,
          status: project.done ? "completed" as const : "active" as const,
          tags: project.tags,
        })),
      );
      new Notice(`Imported ${created} Sub-project${created === 1 ? "" : "s"}.`);
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
  private area = "";
  private image = "";
  private tags = "";
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
    addText(this.formEl, "Area", this.area, (value) => (this.area = value));
    addImagePathSetting(
      this.formEl,
      this.services.app,
      this.image,
      (value) => (this.image = value),
      (suggest) => this.registerPopover(suggest),
      { description: "Optional. Overrides the Default project image." },
    );
    addTags(this.formEl, this.tags, (value) => (this.tags = value));
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
    const tags = parseProjectTags(this.tags);
    if (image && !resolveVaultImage(this.services.app, image, "")) return void new Notice("Select an image file from the vault.");
    if (!validateProjectSelection(this.parentProjectId, this.parentProjectQuery)) return;
    try {
      const file = await this.services.repository.createProject({
        title: this.title.trim(),
        ...(this.area.trim() ? { area: this.area.trim() } : {}),
        ...(image ? { image } : {}),
        ...(tags.length ? { tags } : {}),
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
  private tags: string;
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
    this.tags = (project.tags ?? []).join(", ");
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
    addTags(this.formEl, this.tags, (value) => (this.tags = value));
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
        tags: parseProjectTags(this.tags),
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

export class BatchProjectTagsModal extends FormModal {
  private tags = "";
  private applying = false;

  constructor(
    private readonly services: GtdServices,
    private readonly projectIds: readonly string[],
    private readonly onApplied: () => void,
  ) {
    super(services.app);
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: `Add tags — ${projectCount(this.projectIds.length)}` });
    this.formEl.createEl("p", {
      cls: "dg-muted",
      text: "Existing tags are kept. Projects that already carry a tag are left untouched.",
    });
    addTags(this.formEl, this.tags, (value) => (this.tags = value));
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Add tags");
  }

  protected async submit(): Promise<void> {
    if (this.applying) return;
    const tags = parseProjectTags(this.tags);
    if (!tags.length) return void new Notice("Name at least one tag.");
    const snapshot = this.services.repository.index.getSnapshot();
    const projects = this.projectIds
      .map((id) => snapshot.projectsById.get(id))
      .filter((project): project is Project => Boolean(project));
    const { updates, unchanged } = projectTagAdditions(projects, tags);
    if (!updates.size) {
      return void new Notice(unchanged.length
        ? `Every selected Project already has ${tags.length === 1 ? "that tag" : "those tags"}.`
        : "These Projects no longer exist.");
    }

    this.applying = true;
    const result = await applyProjectChanges(this.services, [...updates].map(([id, next]) => [id, { tags: next }]));
    this.applying = false;
    if (!result.applied && result.failure) return void new Notice(result.failure);
    new Notice([
      `Tagged ${projectCount(result.applied)}`,
      unchanged.length ? `${unchanged.length} already tagged` : "",
      result.failure ? `${updates.size - result.applied} failed — ${result.failure}` : "",
    ].filter(Boolean).join(" · "));
    this.onApplied();
    this.close();
  }
}

export class BatchProjectParentModal extends FormModal {
  private parentProjectId = "";
  private parentProjectQuery = "";
  private applying = false;

  constructor(
    private readonly services: GtdServices,
    private readonly projectIds: readonly string[],
    private readonly onApplied: () => void,
  ) {
    super(services.app);
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: `Set parent Project — ${projectCount(this.projectIds.length)}` });
    const snapshot = this.services.repository.index.getSnapshot();
    const excluded = new Set(this.projectIds);
    for (const id of this.projectIds) {
      for (const descendant of projectDescendantIds(id, snapshot.projects)) excluded.add(descendant);
    }
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
      {
        name: "Parent Project",
        description: "Clear the field to make the selection top-level. The selected Projects and their descendants are excluded.",
      },
    );
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Move Projects");
  }

  protected async submit(): Promise<void> {
    if (this.applying) return;
    if (!validateProjectSelection(this.parentProjectId, this.parentProjectQuery)) return;
    const snapshot = this.services.repository.index.getSnapshot();
    const plan = planProjectParentChange(this.projectIds, this.parentProjectId, snapshot.projectsById);
    if (!plan.changing.length) {
      return void new Notice(plan.blocked.length
        ? "That parent would create a hierarchy cycle."
        : plan.unchanged.length ? "The selected Projects already have that parent." : "These Projects no longer exist.");
    }
    const parentTitle = this.parentProjectId ? snapshot.projectsById.get(this.parentProjectId)?.title ?? "" : "";

    this.applying = true;
    const result = await applyProjectChanges(
      this.services,
      plan.changing.map((id) => [id, { parentProjectId: this.parentProjectId }]),
    );
    this.applying = false;
    if (!result.applied && result.failure) return void new Notice(result.failure);
    new Notice([
      parentTitle ? `Moved ${projectCount(result.applied)} under “${parentTitle}”` : `Moved ${projectCount(result.applied)} to the top level`,
      plan.blocked.length ? `${plan.blocked.length} would cycle` : "",
      result.failure ? `${plan.changing.length - result.applied} failed — ${result.failure}` : "",
    ].filter(Boolean).join(" · "));
    this.onApplied();
    this.close();
  }
}

/** Applies Project edits one file at a time so a single failure cannot abandon the rest. */
async function applyProjectChanges(
  services: GtdServices,
  changes: readonly (readonly [string, ProjectChanges])[],
): Promise<{ applied: number; failure: string | undefined }> {
  let applied = 0;
  let failure: string | undefined;
  for (const [id, change] of changes) {
    try {
      await services.repository.updateProject(id, change);
      applied += 1;
    } catch (error) {
      failure ??= error instanceof Error ? error.message : "The Project could not be updated.";
    }
  }
  return { applied, failure };
}

function projectCount(count: number): string {
  return `${count} Project${count === 1 ? "" : "s"}`;
}

export class ProjectDependenciesModal extends FormModal {
  private readonly selected: Set<string>;
  private readonly candidates: Project[];

  constructor(private readonly services: GtdServices, private readonly project: Project) {
    super(services.app);
    const snapshot = services.repository.index.getSnapshot();
    this.selected = new Set((project.blockedByProjectIds ?? []).filter((id) => snapshot.projectsById.has(id)));
    this.candidates = snapshot.projects
      .filter((candidate) => candidate.id !== project.id)
      .sort((left, right) => {
        const leftSibling = left.parentProjectId === project.parentProjectId ? 0 : 1;
        const rightSibling = right.parentProjectId === project.parentProjectId ? 0 : 1;
        return leftSibling - rightSibling || projectBreadcrumb(left, snapshot.projectsById).localeCompare(projectBreadcrumb(right, snapshot.projectsById));
      });
  }

  protected renderForm(): void {
    this.formEl.createEl("h2", { text: `Blocked by — ${this.project.title}` });
    this.formEl.createEl("p", {
      cls: "dg-muted",
      text: "Select Projects that must finish first. Completed or cancelled blockers no longer mark this Project as blocked.",
    });
    const list = this.formEl.createDiv({ cls: "dg-dependency-list" });
    if (!this.candidates.length) list.createSpan({ cls: "dg-muted", text: "No other Projects are available." });
    const snapshot = this.services.repository.index.getSnapshot();
    for (const candidate of this.candidates) {
      new Setting(list)
        .setName(candidate.title)
        .setDesc(projectBreadcrumb(candidate, snapshot.projectsById))
        .addToggle((toggle) => toggle.setValue(this.selected.has(candidate.id)).onChange((selected) => {
          if (selected) this.selected.add(candidate.id);
          else this.selected.delete(candidate.id);
        }));
    }
    this.formEl.appendChild(this.actionsEl);
    this.addSubmit("Save dependencies");
  }

  protected async submit(): Promise<void> {
    try {
      await this.services.repository.updateProject(this.project.id, { blockedByProjectIds: [...this.selected] });
      this.close();
    } catch (error) {
      this.fail(error);
    }
  }
}

function addText(container: HTMLElement, name: string, value: string, onChange: (value: string) => void, placeholder = ""): void {
  new Setting(container).setName(name).addText((text: TextComponent) => text.setValue(value).setPlaceholder(placeholder).onChange(onChange));
}

function addTags(container: HTMLElement, value: string, onChange: (value: string) => void): void {
  new Setting(container)
    .setName("Tags")
    .setDesc("Comma-separated. Used to filter Project boards.")
    .addText((text) => text.setValue(value).setPlaceholder("planning, home").onChange(onChange));
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

function addScheduleFields(
  container: HTMLElement,
  start: string,
  duration: string,
  onStartChange: (value: string) => void,
  onDurationChange: (value: string) => void,
): HTMLElement[] {
  const startSetting = new Setting(container).setName("Scheduled start").setDesc("Local date and time.").addText((text) => {
    text.inputEl.type = "datetime-local";
    text.setValue(start).onChange(onStartChange);
  });
  startSetting.settingEl.addClass("dg-schedule-setting");
  const durationSetting = new Setting(container).setName("Duration").setDesc("Minutes reserved on the calendar.").addText((text) => {
    text.inputEl.type = "number";
    text.inputEl.min = "1";
    text.inputEl.step = "1";
    text.setValue(duration).onChange(onDurationChange);
  });
  durationSetting.settingEl.addClass("dg-schedule-setting");
  return [startSetting.settingEl, durationSetting.settingEl];
}

function addWaitingSinceField(container: HTMLElement, value: string, onChange: (value: string) => void): HTMLElement {
  const setting = new Setting(container)
    .setName("Waiting since")
    .setDesc("The day this Action started waiting.")
    .addText((text) => {
      text.inputEl.type = "date";
      text.setValue(value).onChange(onChange);
    });
  setting.settingEl.addClass("dg-schedule-setting");
  return setting.settingEl;
}

function setScheduleVisibility(settings: HTMLElement[], visible: boolean): void {
  for (const setting of settings) setting.toggleClass("is-hidden", !visible);
}

function scheduleValues(status: ActionStatus, localStart: string, durationValue: string): Pick<Action, "scheduledStart" | "durationMinutes"> | {} | null {
  if (status !== "scheduled" && !localStart) return {};
  if (!localStart) {
    new Notice("Choose a scheduled start time.");
    return null;
  }
  const start = new Date(localStart);
  if (Number.isNaN(start.getTime()) || dateTimeLocalValue(start.toISOString()) !== localStart.slice(0, 16)) {
    new Notice("Choose a valid scheduled start time.");
    return null;
  }
  const durationMinutes = Number(durationValue);
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    new Notice("Duration must be a positive whole number of minutes.");
    return null;
  }
  return { scheduledStart: start.toISOString(), durationMinutes };
}

function dateTimeLocalValue(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
