import { Modal, Notice, Setting, type App } from "obsidian";
import { planProjectCompletion, type ProjectCompletionPlan } from "../domain/project-board";
import { statusChangeProblem } from "../domain/project-tree";
import type { Project } from "../domain/types";
import type { GtdServices } from "./services";

interface CompletionChoice {
  confirmed: boolean;
  cancelOptional: boolean;
}

/**
 * Checks and confirms completing a Project. While a sub-project at any depth is
 * still Active or in the Backlog, completion is refused and the notice names them,
 * so nothing committed to is missed. Someday/Maybe sub-projects may stay, or be
 * cancelled along with it.
 * Returns true when the caller should go ahead and complete the Project.
 */
export async function confirmCompleteProject(services: GtdServices, projectId: string): Promise<boolean> {
  const snapshot = services.repository.index.getSnapshot();
  const project = snapshot.projectsById.get(projectId);
  if (!project || project.status === "completed") return true;

  const problem = statusChangeProblem(project, "completed", snapshot.projects);
  if (problem) {
    new Notice(problem, 15_000);
    return false;
  }
  const plan = planProjectCompletion(project.id, snapshot.projects);
  if (!plan.optional.length) return true;

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
        .setButtonText("Complete Project")
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
