import { App, PluginSettingTab, Setting } from "obsidian";
import { ACTION_STATUSES, type ActionStatus } from "./domain/types";
import type DragonglassGtdPlugin from "./main";
import { normalizeVaultPath } from "./utils/path";

export class GtdSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DragonglassGtdPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Dragonglass GTD" });
    containerEl.createEl("p", { text: "Directories are creation destinations. Existing GTD files are discovered by their type property anywhere in the vault." });

    new Setting(containerEl)
      .setName("Inbox directory")
      .setDesc("Vault-relative destination for new Inbox Item files.")
      .addText((text) => text.setValue(this.plugin.settings.inboxDirectory).onChange(async (value) => {
        this.plugin.settings.inboxDirectory = normalizeVaultPath(value) || "GTD/Inbox";
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Actions directory")
      .setDesc("Vault-relative destination for new Action files.")
      .addText((text) => text.setValue(this.plugin.settings.actionsDirectory).onChange(async (value) => {
        this.plugin.settings.actionsDirectory = normalizeVaultPath(value) || "GTD/Actions";
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Reference directory")
      .setDesc("Vault-relative destination when an Inbox Item is filed as reference.")
      .addText((text) => text.setValue(this.plugin.settings.referenceDirectory).onChange(async (value) => {
        this.plugin.settings.referenceDirectory = normalizeVaultPath(value) || "General Reference";
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Projects directory")
      .setDesc("Vault-relative destination for new Project files.")
      .addText((text) => text.setValue(this.plugin.settings.projectsDirectory).onChange(async (value) => {
        this.plugin.settings.projectsDirectory = normalizeVaultPath(value) || "GTD/Projects";
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Default Action status")
      .addDropdown((dropdown) => {
        for (const status of ACTION_STATUSES) dropdown.addOption(status, status.charAt(0).toUpperCase() + status.slice(1));
        dropdown.setValue(this.plugin.settings.defaultActionStatus).onChange(async (value) => {
          this.plugin.settings.defaultActionStatus = value as ActionStatus;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show Done column")
      .setDesc("Show Done on the unsaved default board. Saved views keep their own column choices.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showDoneColumn).onChange(async (value) => {
        this.plugin.settings.showDoneColumn = value;
        await this.plugin.saveSettings();
      }));
  }
}
