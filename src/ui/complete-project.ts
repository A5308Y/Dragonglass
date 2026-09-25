import { Modal, Notice, Setting, type App } from "obsidian";
import { planProjectCompletion, type ProjectCompletionPlan } from "../domain/project-board";
import type { Project } from "../domain/types";
import type { GtdServices } from "./services";

interface CompletionChoice {
  confirmed: boolean;
  cancelOptional: boolean;
}

/**
 * Confirms completing a Project that still has open sub-projects. Unfinished
 * Active and Backlog sub-projects earn a warning, since the plan is not done;
 * Someday/Maybe sub-projects can be cancelled along with it.
 * Returns true when the caller should go ahead and complete the Project.
 */
export async function confirmCompleteProject(services: GtdServices, projectId: string): Promise<boolean> {
  const snapshot = services.repository.index.getSnapshot();
  const project = snapshot.projectsById.get(projectId);
  if (!project || project.status === "completed") return true;

  const plan = planProjectCompletion(project.id, snapshot.projects);
  if (!plan.unfinished.length && !plan.optional.length) return true;

  const choice = await new CompleteProjectModal(services.app, project, plan).choose();
  if (!choice.confirmed) return false;
  if (choice.cancelOptional) {
    for (const child of plan.optional) await services.repository.setProjectStatus(child.id, "cancelled");
    new Notice(`Cancelled ${plural(plan.optional.length, "Someday/Maybe sub-project")}.`);
  }
  return true;
}

class CompleteProjectModal extends Modal {
  private choice: CompletionChoice = { confirmed: false, cancelOptional: true };
  private resolve: (choice: CompletionChoice) => void = () => {};

  constructor(app: App, private readonly project: Project, private readonly plan: ProjectCompletionPlan) {
    super(app);
  }

  choose(): Promise<CompletionChoice> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, plan } = this;
    contentEl.addClass("dg-button-scope");
    this.titleEl.setText(`Complete “${this.project.title}”?`);

    if (plan.unfinished.length) {
      contentEl.createEl("p", {
        text: `${plural(plan.unfinished.length, "sub-project")} of the plan ${plan.unfinished.length === 1 ? "is" : "are"} not finished yet. They stay open.`,
      });
      projectList(contentEl, plan.unfinished);
    }

    if (plan.optional.length) {
      new Setting(contentEl)
        .setName(`Cancel ${plural(plan.optional.length, "Someday/Maybe sub-project")}`)
        .setDesc(plan.optional.map((child) => child.title).join(", "))
        .addToggle((toggle) => toggle
          .setValue(this.choice.cancelOptional)
          .onChange((value) => { this.choice.cancelOptional = value; }));
    }

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Keep open").onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText(plan.unfinished.length ? "Complete anyway" : "Complete Project")
        .setCta()
        .onClick(() => {
          this.choice.confirmed = true;
          this.close();
        }));
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(this.choice);
  }
}

function projectList(parent: HTMLElement, projects: readonly Project[]): void {
  const list = parent.createEl("ul");
  for (const project of projects) {
    list.createEl("li", { text: `${project.title} (${project.status === "backlog" ? "Backlog" : "Active"})` });
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
