import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { ACTION_STATUSES, type ActionStatus } from "./domain/types";
import type DragonglassGtdPlugin from "./main";
import { addImagePathSetting } from "./ui/image-input";
import { normalizeVaultPath } from "./utils/path";

export class GtdSettingTab extends PluginSettingTab {
  private unsubscribeCalendarStatus: (() => void) | undefined;

  constructor(app: App, private readonly plugin: DragonglassGtdPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.unsubscribeCalendarStatus?.();
    this.unsubscribeCalendarStatus = undefined;
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

    addImagePathSetting(
      containerEl,
      this.app,
      this.plugin.settings.defaultProjectImage,
      (value) => {
        this.plugin.settings.defaultProjectImage = normalizeVaultPath(value);
        void this.plugin.saveSettings();
      },
      undefined,
      { name: "Default project image", description: "Used on Project cards and details when a Project has no Main image." },
    );

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

    containerEl.createEl("h3", { text: "Google Calendar" });
    containerEl.createEl("p", {
      text: "One-way sync for Scheduled Actions through a user-owned Apps Script bridge. The endpoint and secret are stored as plain text in this plugin's data file.",
    });

    new Setting(containerEl)
      .setName("Enable Google Calendar sync")
      .setDesc("Automatically reconcile Scheduled Actions after changes and every five minutes.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.googleCalendar.enabled).onChange(async (value) => {
        this.plugin.settings.googleCalendar.enabled = value;
        await this.plugin.saveSettings(false);
      }));

    new Setting(containerEl)
      .setName("Apps Script URL")
      .setDesc("HTTPS web-app deployment URL ending in /exec.")
      .addText((text) => text
        .setPlaceholder("https://script.google.com/macros/s/…/exec")
        .setValue(this.plugin.settings.googleCalendar.endpointUrl)
        .onChange(async (value) => {
          this.plugin.settings.googleCalendar.endpointUrl = value.trim();
          await this.plugin.saveSettings(false);
        }));

    let secretInput: HTMLInputElement;
    new Setting(containerEl)
      .setName("Shared secret")
      .setDesc("Must match the SHARED_SECRET Script Property. Use Show or Copy to transfer it to Apps Script.")
      .addText((text) => {
        secretInput = text.inputEl;
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.googleCalendar.sharedSecret).onChange(async (value) => {
          this.plugin.settings.googleCalendar.sharedSecret = value.trim();
          await this.plugin.saveSettings(false);
        });
      })
      .addButton((button) => button.setButtonText("Show").onClick(() => {
        const visible = secretInput.type === "text";
        secretInput.type = visible ? "password" : "text";
        button.setButtonText(visible ? "Show" : "Hide");
      }))
      .addButton((button) => button.setButtonText("Copy").onClick(async () => {
        const secret = this.plugin.settings.googleCalendar.sharedSecret;
        if (!secret) {
          new Notice("Generate or enter a shared secret first.");
          return;
        }
        try {
          await navigator.clipboard.writeText(secret);
          new Notice("Shared secret copied.");
        } catch {
          secretInput.type = "text";
          secretInput.focus();
          secretInput.select();
          new Notice("Could not copy automatically. The shared secret is selected for copying.");
        }
      }))
      .addButton((button) => button.setButtonText("Generate").onClick(async () => {
        if (this.plugin.settings.googleCalendar.sharedSecret
          && !window.confirm("Replace the current shared secret? You will also need to update the SHARED_SECRET Script Property.")) return;
        const secret = randomSecret();
        this.plugin.settings.googleCalendar.sharedSecret = secret;
        await this.plugin.saveSettings(false);
        secretInput.value = secret;
        secretInput.type = "text";
        secretInput.focus();
        secretInput.select();
        new Notice("Shared secret generated and selected. Copy it to the SHARED_SECRET Script Property.");
      }));

    new Setting(containerEl)
      .setName("Default scheduled duration")
      .setDesc("Minutes suggested when an Action is first scheduled.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "5";
        text.setValue(String(this.plugin.settings.googleCalendar.defaultDurationMinutes)).onChange(async (value) => {
          const duration = Number(value);
          if (!Number.isInteger(duration) || duration <= 0) return;
          this.plugin.settings.googleCalendar.defaultDurationMinutes = duration;
          await this.plugin.saveSettings(false);
        });
      });

    const connectionSetting = new Setting(containerEl)
      .setName("Connection and sync")
      .addButton((button) => button.setButtonText("Test").onClick(async () => {
        button.setDisabled(true);
        try {
          const result = await this.plugin.testGoogleCalendar();
          new Notice(`Connected to ${result.calendar ?? "Google Calendar"}.`);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not connect to Google Calendar.");
        } finally {
          button.setDisabled(false);
          this.display();
        }
      }))
      .addButton((button) => button.setButtonText("Sync now").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          const result = await this.plugin.syncGoogleCalendar();
          new Notice(`Calendar synced: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted.`);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not sync Google Calendar.");
        } finally {
          button.setDisabled(false);
          this.display();
        }
      }));
    const refreshStatus = () => connectionSetting.setDesc(calendarStatusText(this.plugin.getGoogleCalendarStatus()));
    refreshStatus();
    this.unsubscribeCalendarStatus = this.plugin.subscribeGoogleCalendarStatus(refreshStatus);
  }

  hide(): void {
    this.unsubscribeCalendarStatus?.();
    this.unsubscribeCalendarStatus = undefined;
    super.hide();
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function calendarStatusText(status: ReturnType<DragonglassGtdPlugin["getGoogleCalendarStatus"]>): string {
  if (status.state === "success") return `Last synced ${status.lastSuccess ? new Date(status.lastSuccess).toLocaleString() : "successfully"}.`;
  if (status.state === "error") return status.error ?? "The last sync failed.";
  if (status.state === "syncing") return "Syncing…";
  if (status.state === "disabled") return "Sync is disabled.";
  return "Ready to sync.";
}
