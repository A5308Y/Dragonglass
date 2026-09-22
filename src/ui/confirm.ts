import { Modal, Setting, type App } from "obsidian";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  /** Styles the confirm button as destructive. */
  warning?: boolean;
}

/**
 * Asks before a change that cannot be undone or touches many files at once.
 * Reversible single changes use `showUndoNotice` instead of asking.
 */
export function confirmDialog(app: App, options: ConfirmOptions): Promise<boolean> {
  return new ConfirmModal(app, options).choose();
}

class ConfirmModal extends Modal {
  private confirmed = false;
  private resolve: (confirmed: boolean) => void = () => {};

  constructor(app: App, private readonly options: ConfirmOptions) {
    super(app);
  }

  choose(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    for (const paragraph of this.options.message.split("\n\n")) this.contentEl.createEl("p", { text: paragraph });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => {
        button.setButtonText(this.options.confirmText).onClick(() => {
          this.confirmed = true;
          this.close();
        });
        if (this.options.warning) button.setWarning();
        else button.setCta();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(this.confirmed);
  }
}
