import { Modal, Setting, type App } from "obsidian";
import type { AgentService } from "../agent/agent-service";

/**
 * Signs Dragonglass's Codex folder in to ChatGPT. Codex runs in its container and prints an
 * address and a one-time code; the person confirms the code there, and the modal shows the result.
 */
export class CodexLoginModal extends Modal {
  private readonly abort = new AbortController();

  constructor(app: App, private readonly agent: AgentService, private readonly onDone: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("dg-button-scope");
    this.titleEl.setText("Sign in to ChatGPT for Codex");
    contentEl.createEl("p", {
      text: "Starting Codex in its container. The first time, Docker builds it, which takes a minute or two. "
        + "Then open the address below, sign in, and enter the code.",
    });
    const status = contentEl.createEl("p", { cls: "dg-delegate-note", text: "Starting…" });
    const links = contentEl.createDiv();
    const output = contentEl.createEl("pre", { cls: "dg-codex-login-output" });
    const shown = new Set<string>();
    let text = "";
    new Setting(contentEl).addButton((button) => button.setButtonText("Close").onClick(() => this.close()));

    void this.agent.codexLogin((chunk) => {
      // Codex colours its output; the terminal codes would show as noise here.
      text += chunk.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
      output.setText(text.slice(-4_000));
      output.scrollTop = output.scrollHeight;
      for (const url of text.match(/https:\/\/[^\s"'<>]+/g) ?? []) {
        if (shown.has(url)) continue;
        shown.add(url);
        links.createEl("p").createEl("a", { text: url, href: url });
      }
      if (shown.size) status.setText("Waiting for you to confirm the code…");
    }, this.abort.signal).then((signedIn) => {
      status.setText(signedIn ? "✓ Signed in. Codex runs can start now." : "⚠ Not signed in. The output below says why.");
      this.onDone();
    }, (reason: unknown) => {
      status.setText(`⚠ ${reason instanceof Error ? reason.message : String(reason)}`);
    });
  }

  onClose(): void {
    // Closing gives up on a sign-in that hasn't been confirmed yet.
    this.abort.abort();
    this.contentEl.empty();
  }
}
