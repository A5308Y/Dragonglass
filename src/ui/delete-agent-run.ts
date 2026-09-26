import { Modal, Notice, Setting, type App } from "obsidian";
import type { AgentService } from "../agent/agent-service";

/**
 * Asks before deleting an ended agent run. Its folder lives outside the vault, so there
 * is no trash to recover it from; its results in the Project Material are only moved
 * to the vault's trash, and only when asked to.
 */
export async function confirmDeleteAgentRun(app: App, agent: AgentService, runId: string): Promise<void> {
  const run = agent.views().find((candidate) => candidate.id === runId);
  if (!run) throw new Error("This run no longer exists.");
  const choice = await new DeleteAgentRunModal(app, run.projectTitle, run.importedTo && app.vault.getAbstractFileByPath(run.importedTo) ? run.importedTo : "").choose();
  if (!choice.confirmed) return;
  await agent.deleteRun(runId, choice.withResults);
  new Notice(choice.withResults ? "Deleted the run, and moved its results to the trash." : "Deleted the run.");
}

class DeleteAgentRunModal extends Modal {
  private choice = { confirmed: false, withResults: false };
  private resolve: (choice: { confirmed: boolean; withResults: boolean }) => void = () => {};

  constructor(app: App, private readonly projectTitle: string, private readonly resultsFolder: string) {
    super(app);
  }

  choose(): Promise<{ confirmed: boolean; withResults: boolean }> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("dg-button-scope");
    this.titleEl.setText(`Delete this agent run on “${this.projectTitle}”?`);
    contentEl.createEl("p", {
      text: "Its folder, with the copy of the material, the conversation and the logs, is deleted. That can't be undone. "
        + "What the run cost stays counted.",
    });
    if (this.resultsFolder) {
      new Setting(contentEl)
        .setName("Also delete its results")
        .setDesc(`Moves ${this.resultsFolder} in the Project Material to the trash.`)
        .addToggle((toggle) => toggle.setValue(false).onChange((value) => {
          this.choice.withResults = value;
        }));
    }
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Delete run").setWarning().onClick(() => {
        this.choice.confirmed = true;
        this.close();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(this.choice);
  }
}
