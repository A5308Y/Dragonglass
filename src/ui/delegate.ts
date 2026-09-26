import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import { formatBytes, type AgentService, type DelegationPlan } from "../agent/agent-service";

/**
 * Asks what the agent should do with a Project tree, shows exactly what it will get,
 * and starts the run. The file list is there so the scope can be checked before
 * anything leaves the vault.
 */
export async function delegateProject(app: App, agent: AgentService, projectId: string, defaultBudgetUsd: number): Promise<void> {
  if (!agent.available()) {
    new Notice("Delegating to an agent needs the Obsidian desktop app on macOS.");
    return;
  }
  const plan = await agent.plan(projectId);
  new DelegateModal(app, agent, plan, defaultBudgetUsd).open();
}

class DelegateModal extends Modal {
  private starting = false;

  constructor(
    app: App,
    private readonly agent: AgentService,
    private readonly plan: DelegationPlan,
    private readonly defaultBudgetUsd: number,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, plan } = this;
    contentEl.addClass("dg-button-scope", "dg-delegate");
    this.titleEl.setText(`Delegate “${plan.breadcrumb}”`);

    const projects = plan.scope.projects.length;
    const actions = plan.scope.actions.length;
    contentEl.createEl("p", {
      text: `The agent gets copies of ${count(projects, "Project")}, ${count(actions, "Action")} and `
        + `${count(plan.files.length, "file")} in all (${formatBytes(plan.totalBytes)}), including their Project Material `
        + `and ${count(plan.linkedFileCount, "linked file")}. Nothing else from the vault.`,
    });
    if (plan.missingLinks.length) {
      contentEl.createEl("p", {
        cls: "dg-delegate-warning",
        text: `⚠ ${count(plan.missingLinks.length, "linked file")} no longer exist and won't be included: ${plan.missingLinks.join(", ")}.`,
      });
    }
    const files = contentEl.createEl("details", { cls: "dg-delegate-files" });
    files.createEl("summary", { text: "Show the files" });
    const list = files.createEl("ul");
    for (const file of plan.files) list.createEl("li", { text: file.path });

    contentEl.createEl("p", {
      cls: "dg-delegate-warning",
      text: "⚠ The agent can reach the internet, so it could pass on what it was given. Only delegate trees that aren't "
        + "sensitive. Every request it makes is logged in the run folder.",
    });

    const instructionsId = "dg-delegate-instructions";
    contentEl.createEl("label", { text: "What should the agent do?", attr: { for: instructionsId }, cls: "dg-delegate-label" });
    const instructions = contentEl.createEl("textarea", {
      cls: "dg-delegate-instructions",
      attr: { id: instructionsId, rows: "6", placeholder: "For example: compare three tile suppliers near Berlin and draft an order." },
    });

    let budget = this.defaultBudgetUsd;
    new Setting(contentEl)
      .setName("Budget")
      .setDesc("US dollars. The run stops once its estimated spend passes this.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0.5";
        text.inputEl.step = "0.5";
        text.setValue(String(budget)).onChange((value) => {
          budget = Number(value);
        });
      });

    const error = contentEl.createEl("p", { cls: "dg-delegate-error" });
    const start = async () => {
      if (this.starting) return;
      this.starting = true;
      error.setText("");
      startButton.setDisabled(true).setButtonText("Starting…");
      try {
        await this.agent.delegate(this.plan, instructions.value, budget);
        new Notice(`Starting the agent on “${this.plan.scope.root.title}”. Its progress shows on the Project's page.`);
        this.close();
      } catch (reason) {
        error.setText(reason instanceof Error ? reason.message : String(reason));
        startButton.setDisabled(false).setButtonText("Start");
        this.starting = false;
      }
    };

    let startButton!: ButtonComponent;
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => {
        startButton = button;
        button.setButtonText("Start").setCta().onClick(() => void start());
      });
    // Obsidian's keymap takes ⌘+Enter first, so the modal's own scope claims it.
    this.scope.register(["Mod"], "Enter", () => {
      void start();
      return false;
    });
    instructions.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
