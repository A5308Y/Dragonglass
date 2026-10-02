import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import { formatBytes, type AgentService, type CodeEffort, type DelegationPlan, type RerunDefaults } from "../agent/agent-service";
import { codeTaskIdentifier, type AgentRuntime, type LocalHarness } from "../domain/delegation";
import type { AgentSettings } from "../domain/types";

/**
 * Asks what the agent should do with a Project tree, shows exactly what it will get,
 * and starts the run. The file list is there so the scope can be checked before
 * anything leaves the vault.
 *
 * Claude reads the Project's tree. A local model may read the tree with internet
 * access, or the whole vault without any: the more it sees, the less it can reach.
 * A code run is offered where the Project, or one above it, has a Lamdera app's
 * repository: it gets only the Project's own words, and changes that app's code.
 */
export async function delegateProject(
  app: App,
  agent: AgentService,
  projectId: string,
  settings: AgentSettings,
  previous?: RerunDefaults,
): Promise<void> {
  if (!agent.available()) {
    new Notice("Delegating to an agent needs the Obsidian desktop app on macOS.");
    return;
  }
  // Running again starts from the earlier run's choices, with the material copied afresh.
  const plan = await agent.plan(projectId, previous?.runtime === "local" && previous.wholeVault);
  new DelegateModal(app, agent, plan, settings, previous).open();
}

class DelegateModal extends Modal {
  private starting = false;
  private runtime: AgentRuntime = "claude";
  private harness: LocalHarness = "loop";
  private budget: number;
  private effort: CodeEffort = "medium";
  private continueCode: boolean;
  private readonly codeRepository: { name: string; fromProjectId: string } | null;
  private summaryEl!: HTMLElement;
  private budgetSetting!: Setting;
  private scopeSetting!: Setting;
  private earlierSetting: Setting | null = null;
  private effortSetting!: Setting;
  private continueCodeSetting!: Setting;
  private limitEl!: HTMLElement;

  constructor(
    app: App,
    private readonly agent: AgentService,
    private plan: DelegationPlan,
    private readonly settings: AgentSettings,
    private readonly previous?: RerunDefaults,
  ) {
    super(app);
    this.budget = previous?.budgetUsd ?? settings.defaultBudgetUsd;
    this.runtime = previous?.runtime ?? "claude";
    this.harness = previous?.harness ?? "loop";
    this.codeRepository = agent.codeRepository(plan.scope.root.id);
    if (this.runtime === "lamdera" && !this.codeRepository) this.runtime = "claude";
    // A follow-up continues on the Project's branch and pull request unless asked otherwise.
    this.continueCode = agent.hasCodeRuns(plan.scope.root.id);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("dg-button-scope", "dg-delegate");
    this.titleEl.setText(`${this.previous ? "Run again" : "Delegate"}: “${this.plan.breadcrumb}”`);

    const localModel = this.settings.localModel || "the one loaded in LM Studio";
    new Setting(contentEl)
      .setName("Agent")
      .addDropdown((dropdown) => dropdown
        .addOption("claude", `Claude (${this.settings.model})`)
        .addOption("local", `Local model, Dragonglass's loop (${localModel})`)
        .addOption("local-smol", `Local model, smolagents (${localModel})`)
        .addOption("local-qwen", `Local model, Qwen-Agent (${localModel})`)
        .addOption("codex", `ChatGPT, with Codex and your plan (${this.settings.codexModel || "Codex's default model"})`)
        .then((dropdown) => {
          if (this.codeRepository) dropdown.addOption("lamdera", `Code: the Lamdera app “${this.codeRepository.name}”, with the coding agent`);
        })
        .setValue(this.runtime !== "local" ? this.runtime : this.harness === "smolagents" ? "local-smol" : this.harness === "qwen-agent" ? "local-qwen" : "local")
        .onChange((value) => {
          this.runtime = value === "claude" || value === "codex" || value === "lamdera" ? value : "local";
          this.harness = value === "local-smol" ? "smolagents" : value === "local-qwen" ? "qwen-agent" : "loop";
          // Only a local run may read the whole vault.
          if (this.runtime !== "local" && this.plan.wholeVault) void this.replan(false);
          else this.render();
        }));

    this.scopeSetting = new Setting(contentEl)
      .setName("What it may read")
      .addDropdown((dropdown) => dropdown
        .addOption("tree", "This Project's tree, with internet access")
        .addOption("vault", "The whole vault, offline")
        .setValue(this.plan.wholeVault ? "vault" : "tree")
        .onChange((value) => void this.replan(value === "vault")));

    this.summaryEl = contentEl.createDiv();

    const instructionsId = "dg-delegate-instructions";
    contentEl.createEl("label", { text: "What should the agent do?", attr: { for: instructionsId }, cls: "dg-delegate-label" });
    const instructions = contentEl.createEl("textarea", {
      cls: "dg-delegate-instructions",
      attr: { id: instructionsId, rows: "6", placeholder: "For example: compare three tile suppliers near Berlin and draft an order." },
    });
    if (this.previous) instructions.value = this.previous.instructions;

    let continueEarlier = Boolean(this.previous?.earlier);
    if (this.previous?.earlier) {
      const earlier = this.previous.earlier;
      this.earlierSetting = new Setting(contentEl)
        .setName("Continue from the earlier run")
        .setDesc(`It ended as: ${earlier.statusText}. `
          + (earlier.resultsFolder
            ? "The agent is told where its results are and what it did last, and builds on them."
            : "It left no files; the agent is told what it did last."))
        .addToggle((toggle) => toggle.setValue(continueEarlier).onChange((value) => {
          continueEarlier = value;
        }));
    }

    this.continueCodeSetting = new Setting(contentEl)
      .setName("Continue on the existing branch and pull request")
      .setDesc("The agent picks up its earlier checkout and is told what the earlier runs on this Project were asked and reported. "
        + "Off starts a fresh branch from the base branch.")
      .addToggle((toggle) => toggle.setValue(this.continueCode).onChange((value) => {
        this.continueCode = value;
      }));
    this.effortSetting = new Setting(contentEl)
      .setName("Reasoning effort")
      .setDesc("How long Codex thinks before it changes code. Higher takes longer and uses more of your plan.")
      .addDropdown((dropdown) => dropdown
        .addOptions({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" })
        .setValue(this.effort)
        .onChange((value) => {
          this.effort = value as CodeEffort;
        }));

    this.budgetSetting = new Setting(contentEl)
      .setName("Budget")
      .setDesc(`US dollars. The run stops once its estimated spend passes this, or after ${this.settings.maxTurns} turns.`)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0.5";
        text.inputEl.step = "0.5";
        text.setValue(String(this.budget)).onChange((value) => {
          this.budget = Number(value);
        });
      });
    this.limitEl = contentEl.createEl("p", { cls: "dg-delegate-note" });

    const error = contentEl.createEl("p", { cls: "dg-delegate-error" });
    let startButton!: ButtonComponent;
    const start = async () => {
      if (this.starting) return;
      this.starting = true;
      error.setText("");
      startButton.setDisabled(true).setButtonText("Starting…");
      try {
        if (this.runtime === "lamdera") {
          await this.agent.delegateCode(this.plan.scope.root.id, instructions.value, { effort: this.effort, continuation: this.continueCode });
        } else {
          await this.agent.delegate(this.plan, instructions.value, {
            runtime: this.runtime,
            harness: this.harness,
            budgetUsd: this.budget,
            ...(continueEarlier && this.previous?.earlier ? { earlierAttempt: this.previous.earlier } : {}),
          });
        }
        new Notice(`Starting the agent on “${this.plan.scope.root.title}”. Its progress shows on the Project's page.`);
        this.close();
      } catch (reason) {
        error.setText(reason instanceof Error ? reason.message : String(reason));
        startButton.setDisabled(false).setButtonText("Start");
        this.starting = false;
      }
    };

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
    this.render();
    instructions.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async replan(wholeVault: boolean): Promise<void> {
    this.summaryEl.setText(wholeVault ? "Collecting the vault's files…" : "Collecting the Project's files…");
    this.plan = await this.agent.plan(this.plan.scope.root.id, wholeVault);
    this.render();
  }

  /** What the agent gets and what it can reach, for the current choices. */
  private render(): void {
    const { plan } = this;
    const local = this.runtime === "local";
    const code = this.runtime === "lamdera";
    this.scopeSetting.settingEl.toggle(local);
    this.budgetSetting.settingEl.toggle(this.runtime === "claude");
    this.earlierSetting?.settingEl.toggle(!code);
    this.effortSetting.settingEl.toggle(code);
    this.continueCodeSetting.settingEl.toggle(code && this.agent.hasCodeRuns(plan.scope.root.id));
    this.limitEl.toggle(this.runtime !== "claude" && !code);
    if (code) {
      this.renderCode();
      return;
    }
    this.limitEl.setText(local
      ? `A local run costs nothing. It stops after ${this.settings.localMaxTurns} turns or `
        + `${this.settings.localMaxMinutes} minutes, whichever comes first.`
      : `A Codex run counts against your ChatGPT plan's usage limits, not per token. It stops after `
        + `${this.settings.codexMaxMinutes} minutes.`);

    const summary = this.summaryEl;
    summary.empty();
    summary.createEl("p", {
      text: plan.wholeVault
        ? `The agent gets a read-only copy of the whole vault: ${count(plan.files.length, "file")} (${formatBytes(plan.totalBytes)}), `
          + "without Obsidian's settings and the trash. The task is about this Project and the Projects below it."
        : `The agent gets copies of ${count(plan.scope.projects.length, "Project")}, ${count(plan.scope.actions.length, "Action")} and `
          + `${count(plan.files.length, "file")} in all (${formatBytes(plan.totalBytes)}), including their Project Material `
          + `and ${count(plan.linkedFileCount, "linked file")}. Nothing else from the vault.`,
    });
    if (plan.missingLinks.length && !plan.wholeVault) {
      summary.createEl("p", {
        cls: "dg-delegate-warning",
        text: `⚠ ${count(plan.missingLinks.length, "linked file")} no longer exist and won't be included: ${plan.missingLinks.join(", ")}.`,
      });
    }
    const files = summary.createEl("details", { cls: "dg-delegate-files" });
    files.createEl("summary", { text: "Show the files" });
    const list = files.createEl("ul");
    for (const file of plan.files.slice(0, 2_000)) list.createEl("li", { text: file.path });
    if (plan.files.length > 2_000) list.createEl("li", { text: `… and ${plan.files.length - 2_000} more` });

    summary.createEl("p", {
      cls: "dg-delegate-warning",
      text: plan.wholeVault
        ? "🔒 Offline: the agent has no internet access at all, so nothing it reads can leave your Mac. "
          + "It reaches only the local model server."
        : this.runtime === "codex"
          ? "⚠ The material goes to OpenAI, and the agent can reach the internet and search the web, so it could pass on "
            + "what it was given. It also holds your ChatGPT sign-in inside the container. Only delegate trees that aren't "
            + "sensitive. Every request it makes is logged in the run folder."
          : local
          ? "⚠ The model runs on your Mac, but the agent can reach the internet (without search), so it could pass on what "
            + "it was given. Every request it makes is logged in the run folder."
          : "⚠ The material goes to Anthropic's API, and the agent can reach the internet, so it could pass on what it was "
            + "given. Only delegate trees that aren't sensitive. Every request it makes is logged in the run folder.",
    });
  }

  /** What a code run gets and does: the Project's own words, and one app's repository. */
  private renderCode(): void {
    const summary = this.summaryEl;
    summary.empty();
    const repository = this.codeRepository;
    if (!repository) return;
    const inherited = repository.fromProjectId !== this.plan.scope.root.id;
    summary.createEl("p", {
      text: `The coding agent works on “${repository.name}”${inherited ? ", the repository of a Project above this one," : ""} `
        + `on the branch agent/${codeTaskIdentifier(this.plan.scope.root.id)}-…. It gets this Project's note, desired outcome `
        + "and open Actions, and your instructions; no other vault files.",
    });
    summary.createEl("p", {
      text: "Codex only edits files. The coding agent formats them, commits, runs lamdera check --force before every push "
        + "(with one repair attempt; its migrations are committed too), merges the base branch, pushes without force, opens or "
        + "updates the pull request and deploys a preview. When the pull request is ready, a “Review PR” Next Action appears here.",
    });
    summary.createEl("p", {
      cls: "dg-delegate-warning",
      text: "⚠ The Project's text goes to OpenAI. The coding agent's container holds its GitHub, Lamdera and ChatGPT sign-ins, "
        + "and Codex can reach the internet from there. It never merges, and never deploys production.",
    });
  }
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
