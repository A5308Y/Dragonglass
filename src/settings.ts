import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { confirmDialog } from "./ui/confirm";
import { ACTION_STATUSES, type ActionStatus } from "./domain/types";
import type DragonglassGtdPlugin from "./main";
import { addImagePathSetting } from "./ui/image-input";
import { describeImport, describeMailboxState, mailboxState, normalizeMailPort } from "./domain/mail";
import { createUlid as createAccountId } from "./utils/ulid";
import { isPathInDirectory, normalizeVaultPath } from "./utils/path";

export class GtdSettingTab extends PluginSettingTab {
  private unsubscribeCalendarStatus: (() => void) | undefined;
  private unsubscribeFeedStatus: (() => void) | undefined;
  private unsubscribeMailStatus: (() => void) | undefined;
  private feedsExpanded = false;
  private pomodoroExpanded = false;
  private agentExpanded = false;
  private mailExpanded = false;

  constructor(app: App, private readonly plugin: DragonglassGtdPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.unsubscribeCalendarStatus?.();
    this.unsubscribeCalendarStatus = undefined;
    this.unsubscribeFeedStatus?.();
    this.unsubscribeFeedStatus = undefined;
    this.unsubscribeMailStatus?.();
    this.unsubscribeMailStatus = undefined;
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("dg-settings");
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

    new Setting(containerEl)
      .setName("Weekly Review day")
      .setDesc("The Project Review falls due on this day and stays due until every Project tree is reviewed, so it can be finished on a later day. "
        + (this.plugin.settings.lastWeeklyReview
          ? `Last finished on ${this.plugin.settings.lastWeeklyReview}.`
          : "Not finished yet."))
      .addDropdown((dropdown) => {
        ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
          .forEach((day, index) => dropdown.addOption(String(index), day));
        dropdown.setValue(String(this.plugin.settings.weeklyReviewDay)).onChange(async (value) => {
          this.plugin.settings.weeklyReviewDay = Number(value);
          await this.plugin.saveSettings();
        });
      });

    this.displayPomodoro(containerEl);
    this.displayFeeds(containerEl);
    this.displayMail(containerEl);
    this.displayAgent(containerEl);

    containerEl.createEl("h3", { text: "Google Calendar" });
    containerEl.createEl("p", {
      text: "One-way sync for Calendar Actions through a user-owned Apps Script bridge. The endpoint and secret are stored as plain text in this plugin's data file.",
    });

    new Setting(containerEl)
      .setName("Enable Google Calendar sync")
      .setDesc("Automatically reconcile Calendar Actions after changes and every five minutes.")
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
        if (this.plugin.settings.googleCalendar.sharedSecret && !await confirmDialog(this.app, {
          title: "Replace the shared secret?",
          message: "The current secret stops working. You will also need to update the SHARED_SECRET Script Property.",
          confirmText: "Replace secret",
          warning: true,
        })) return;
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
      .setName("Default Calendar Action duration")
      .setDesc("Minutes suggested when an Action first gets a time of day on the calendar.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "1";
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

  /**
   * Feed subscriptions.
   *
   * Subscribing is frequent and lives in the Feeds view; unsubscribing is not, and
   * lives here, where deleting a feed's triage state is a deliberate act.
   */
  private displayPomodoro(containerEl: HTMLElement): void {
    const section = containerEl.createEl("details", { cls: "dg-settings-section" });
    section.open = this.pomodoroExpanded;
    section.createEl("summary", { text: "Pomodoro", cls: "dg-settings-section-summary" });
    section.addEventListener("toggle", () => {
      this.pomodoroExpanded = section.open;
    });
    const sectionEl = section.createDiv({ cls: "dg-settings-section-content" });
    sectionEl.createEl("p", {
      text: "Focused time slices on one Project, each with an intention and a short reflection. "
        + "Finished sessions are kept in a log that a time-tracking integration can later sync from.",
    });

    new Setting(sectionEl)
      .setName("Session length")
      .setDesc("Minutes a new Pomodoro starts with. It can be changed before each session.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "180";
        text.setValue(String(this.plugin.settings.pomodoro.focusMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return;
          this.plugin.settings.pomodoro.focusMinutes = minutes;
          await this.plugin.saveSettings();
        });
      });

    new Setting(sectionEl)
      .setName("Log to Project Diary")
      .setDesc("Also add one line per finished session to the Project's Diary: length, intention, outcome and reflection.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.pomodoro.logToDiary).onChange(async (value) => {
        this.plugin.settings.pomodoro.logToDiary = value;
        await this.plugin.saveSettings(false);
      }));

    new Setting(sectionEl)
      .setName("Session log")
      .setDesc("Vault-relative JSON file holding the running session and every finished one. It syncs with the vault. Changes apply after reloading the plugin.")
      .addText((text) => text.setValue(this.plugin.settings.pomodoro.storePath).onChange(async (value) => {
        const path = normalizeVaultPath(value) || "GTD/pomodoros.json";
        if (isPathInDirectory(path, this.plugin.settings.inboxDirectory)) {
          new Notice("The session log cannot live inside the Inbox directory, where every file becomes an Inbox Item.");
          return;
        }
        this.plugin.settings.pomodoro.storePath = path;
        await this.plugin.saveSettings(false);
      }));
  }

  /**
   * Delegating Project trees to an agent in a local container. The API key is not a
   * setting: it stays in the macOS Keychain and is read only when a run starts, so it
   * never lands in this plugin's data file, which syncs with the vault.
   */
  private displayAgent(containerEl: HTMLElement): void {
    const section = containerEl.createEl("details", { cls: "dg-settings-section" });
    section.open = this.agentExpanded;
    section.createEl("summary", { text: "Agent delegation", cls: "dg-settings-section-summary" });
    section.addEventListener("toggle", () => {
      this.agentExpanded = section.open;
    });
    const sectionEl = section.createDiv({ cls: "dg-settings-section-content" });
    sectionEl.createEl("p", {
      text: "Delegate a Project tree to an agent that works on a copy of it in a Docker container, with internet access "
        + "through a logging proxy. Its results are added to the Project Material. Runs use your Anthropic API key and "
        + "are billed per token. Needs the desktop app on macOS and Docker Desktop; see agent/README.md in the repository.",
    });
    const agent = this.plugin.settings.agent;
    const save = async () => this.plugin.saveSettings(false);

    new Setting(sectionEl)
      .setName("Agent kit folder")
      .setDesc("The repository's “agent” folder, holding compose.yaml and the container images.")
      .addText((text) => text.setPlaceholder("~/Repositories/dragonglass/agent").setValue(agent.kitDirectory).onChange(async (value) => {
        agent.kitDirectory = value.trim();
        await save();
      }));

    new Setting(sectionEl)
      .setName("Runs folder")
      .setDesc("Where each run's copy of the material, results and logs are kept, outside the vault. "
        + "Empty uses ~/Library/Application Support/Dragonglass/agent-runs. A shared folder lets a server run them later.")
      .addText((text) => text.setPlaceholder("~/Library/Application Support/Dragonglass/agent-runs").setValue(agent.runsDirectory).onChange(async (value) => {
        agent.runsDirectory = value.trim();
        await save();
      }));

    new Setting(sectionEl)
      .setName("Keychain item")
      .setDesc("The macOS Keychain item holding your Anthropic API key. Add it in Terminal with: "
        + `security add-generic-password -a "$USER" -s ${agent.keychainService} -w`)
      .addText((text) => text.setValue(agent.keychainService).onChange(async (value) => {
        if (!value.trim()) return;
        agent.keychainService = value.trim();
        await save();
      }));

    new Setting(sectionEl)
      .setName("Docker")
      .setDesc("The docker program. Empty tries the usual Docker Desktop locations.")
      .addText((text) => text.setPlaceholder("/usr/local/bin/docker").setValue(agent.dockerPath).onChange(async (value) => {
        agent.dockerPath = value.trim();
        await save();
      }));

    new Setting(sectionEl)
      .setName("Default budget")
      .setDesc("US dollars a new run may spend before it is stopped. It can be changed for each run.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0.5";
        text.inputEl.step = "0.5";
        text.setValue(String(agent.defaultBudgetUsd)).onChange(async (value) => {
          const budget = Number(value);
          if (!(budget > 0)) return;
          agent.defaultBudgetUsd = budget;
          await save();
        });
      });

    new Setting(sectionEl)
      .setName("Model")
      .setDesc("The Claude model runs use.")
      .addText((text) => text.setValue(agent.model).onChange(async (value) => {
        if (!value.trim()) return;
        agent.model = value.trim();
        await save();
      }));

    sectionEl.createEl("h4", { text: "Local model" });
    sectionEl.createEl("p", {
      text: "Runs with a model on this Mac through LM Studio or another OpenAI-compatible server. They cost nothing, "
        + "and offline they may read the whole vault.",
    });

    new Setting(sectionEl)
      .setName("Local model")
      .setDesc("The model's id on the server. Empty uses whichever model is loaded.")
      .addText((text) => text.setPlaceholder("qwen/qwen3.8-27b").setValue(agent.localModel).onChange(async (value) => {
        agent.localModel = value.trim();
        await save();
      }));

    new Setting(sectionEl)
      .setName("Model server")
      .setDesc("As the containers see your Mac: host.docker.internal instead of localhost.")
      .addText((text) => text.setValue(agent.localModelUrl).onChange(async (value) => {
        if (!value.trim()) return;
        agent.localModelUrl = value.trim();
        await save();
      }));

    new Setting(sectionEl)
      .setName("Model server key")
      .setDesc("The Keychain item holding the server's API key, if it requires one; only the proxy gets it. Empty for none.")
      .addText((text) => text.setPlaceholder("dragonglass-lmstudio").setValue(agent.localKeychainService).onChange(async (value) => {
        agent.localKeychainService = value.trim();
        await save();
      }));

    new Setting(sectionEl)
      .setName("Context length")
      .setDesc("Tokens, as set for the model in LM Studio. Agent runs need 32768 or more; the run keeps its conversation below this.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "4096";
        text.inputEl.step = "1024";
        text.setValue(String(agent.localContextTokens)).onChange(async (value) => {
          const tokens = Number(value);
          if (!Number.isInteger(tokens) || tokens < 4096) return;
          agent.localContextTokens = tokens;
          await save();
        });
      });

    new Setting(sectionEl)
      .setName("Time limit")
      .setDesc("Minutes a local run may take before it is stopped.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "5";
        text.setValue(String(agent.localMaxMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isInteger(minutes) || minutes < 1) return;
          agent.localMaxMinutes = minutes;
          await save();
        });
      });
  }

  private displayFeeds(containerEl: HTMLElement): void {
    const section = containerEl.createEl("details", { cls: "dg-settings-section" });
    section.open = this.feedsExpanded;
    section.createEl("summary", { text: "RSS Feeds", cls: "dg-settings-section-summary" });
    section.addEventListener("toggle", () => {
      this.feedsExpanded = section.open;
    });
    const sectionEl = section.createDiv({ cls: "dg-settings-section-content" });

    sectionEl.createEl("p", {
      text: "Fetches subscribed RSS and Atom feeds for triage in the Feeds view. Feed Items are not vault files until you keep one, "
        + "which makes it an ordinary Inbox Item. Fetching contacts each feed's server directly.",
    });

    new Setting(sectionEl)
      .setName("Enable feeds")
      .setDesc("Fetch subscribed feeds on start-up and on the refresh interval.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.feeds.enabled).onChange(async (value) => {
        this.plugin.settings.feeds.enabled = value;
        await this.plugin.saveSettings(false);
        this.display();
      }));

    new Setting(sectionEl)
      .setName("Refresh interval")
      .setDesc("Minutes between automatic fetches. Five is the minimum.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "5";
        text.inputEl.step = "5";
        text.setValue(String(this.plugin.settings.feeds.refreshMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isInteger(minutes) || minutes < 5) return;
          this.plugin.settings.feeds.refreshMinutes = minutes;
          await this.plugin.saveSettings(false);
        });
      });

    new Setting(sectionEl)
      .setName("Feed store")
      .setDesc("Vault-relative JSON file holding subscriptions and what has already been swept. It syncs with the vault, so read state follows you between devices.")
      .addText((text) => text.setValue(this.plugin.settings.feeds.storePath).onChange(async (value) => {
        const path = normalizeVaultPath(value) || "GTD/feeds.json";
        // Everything under the Inbox directory is indexed as an Inbox Item, store file included.
        if (isPathInDirectory(path, this.plugin.settings.inboxDirectory)) {
          new Notice("The feed store cannot live inside the Inbox directory, where every file becomes an Inbox Item.");
          return;
        }
        this.plugin.settings.feeds.storePath = path;
        await this.plugin.saveSettings(false);
      }));

    const feeds = this.plugin.getFeedService();
    const fetchSetting = new Setting(sectionEl)
      .setName("Subscriptions")
      .addButton((button) => button.setButtonText("Add feed").onClick(async () => {
        const url = await this.plugin.promptForFeedUrl();
        if (!url) return;
        try {
          const source = await feeds.addFeed(url);
          new Notice(`Subscribed to “${source.title}”.`);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not subscribe to that feed.");
        }
        this.display();
      }))
      .addButton((button) => button.setButtonText("Fetch now").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          const result = await this.plugin.fetchFeeds();
          new Notice(`Fetched ${result.added} new Feed Item${result.added === 1 ? "" : "s"}.`);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not fetch feeds.");
        } finally {
          button.setDisabled(false);
          this.display();
        }
      }));
    const refreshFeedStatus = () => fetchSetting.setDesc(feedStatusText(this.plugin.getFeedStatus()));
    refreshFeedStatus();
    this.unsubscribeFeedStatus = feeds.subscribe(refreshFeedStatus);

    const sources = feeds.getStore().sources;
    if (!sources.length) {
      sectionEl.createEl("p", { text: "No feeds yet." });
      return;
    }
    for (const source of sources) {
      new Setting(sectionEl)
        .setName("Title")
        .setDesc(`${source.url} · ${feeds.getStore().states[source.id]?.unread.length ?? 0} unread · The switch turns fetching this feed on or off.`)
        .addText((text) => text
          .setValue(source.title)
          .onChange(async (value) => {
            const title = value.trim();
            if (!title) return;
            await feeds.updateFeed(source.id, { title });
          }))
        .addToggle((toggle) => toggle
          .setValue(source.enabled)
          .onChange(async (value) => {
            await feeds.updateFeed(source.id, { enabled: value });
            this.display();
          }))
        .addButton((button) => button.setButtonText("Unsubscribe").setWarning().onClick(async () => {
          if (!await confirmDialog(this.app, {
            title: `Unsubscribe from “${source.title}”?`,
            message: "Its unread Items and swept history are forgotten.",
            confirmText: "Unsubscribe",
            warning: true,
          })) return;
          await feeds.removeFeed(source.id);
          new Notice(`Unsubscribed from “${source.title}”.`);
          this.display();
        }));
    }
  }

  /**
   * Email import.
   *
   * Accounts and their app passwords live in the plugin's own data file
   * (`.obsidian/plugins/dragonglass-gtd/data.json`), as plain text, and not in the
   * vault note that holds the sync watermarks, so they never show up in the vault's
   * notes. The data file is still inside the vault, though: iCloud, Obsidian Sync
   * with plugin settings, or git sync it like any other file. That is why the
   * settings ask for a revocable app password, never the account password.
   */
  private displayMail(containerEl: HTMLElement): void {
    const mail = this.plugin.getMailService();
    const mailboxStateSettings: Array<{ setting: Setting; accountId: string; mailbox: string }> = [];
    const section = containerEl.createEl("details", { cls: "dg-settings-section" });
    section.open = this.mailExpanded;
    section.createEl("summary", { text: "Email", cls: "dg-settings-section-summary" });
    section.addEventListener("toggle", () => {
      this.mailExpanded = section.open;
    });
    const sectionEl = section.createDiv({ cls: "dg-settings-section-content" });

    sectionEl.createEl("p", {
      text: "Mirrors IMAP mailboxes into the Inbox: every message it accepts becomes an ordinary Inbox Item. "
        + "A mailbox's existing contents are never imported \u2014 the first sync records where to start, so only mail "
        + "arriving afterwards comes in. Desktop only; imported Items reach your other devices through vault sync.",
    });
    if (!mail.available()) {
      sectionEl.createEl("p", { text: "This device cannot open an IMAP connection, so importing is unavailable here." });
    }

    new Setting(sectionEl)
      .setName("Enable email import")
      .setDesc("Import on start-up and on the refresh interval.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.mail.enabled).onChange(async (value) => {
        this.plugin.settings.mail.enabled = value;
        await this.plugin.saveSettings(false);
        this.display();
      }));

    new Setting(sectionEl)
      .setName("Refresh interval")
      .setDesc("Minutes between automatic imports. Five is the minimum.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "5";
        text.setValue(String(this.plugin.settings.mail.refreshMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isInteger(minutes) || minutes < 5) return;
          this.plugin.settings.mail.refreshMinutes = minutes;
          await this.plugin.saveSettings(false);
        });
      });

    new Setting(sectionEl)
      .setName("Messages per import")
      .setDesc("How many messages one import turns into Inbox Items. The rest wait for the next one, so a bulk arrival cannot flood the Inbox.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.setValue(String(this.plugin.settings.mail.importCap)).onChange(async (value) => {
          const cap = Number(value);
          if (!Number.isInteger(cap) || cap < 1) return;
          this.plugin.settings.mail.importCap = cap;
          await this.plugin.saveSettings(false);
        });
      });

    new Setting(sectionEl)
      .setName("Sync store")
      .setDesc("Vault-relative JSON file recording how far each mailbox has been read. It syncs, so two devices do not import the same message twice.")
      .addText((text) => text.setValue(this.plugin.settings.mail.storePath).onChange(async (value) => {
        const path = normalizeVaultPath(value) || "GTD/mail.json";
        if (isPathInDirectory(path, this.plugin.settings.inboxDirectory)) {
          new Notice("The sync store cannot live inside the Inbox directory, where every file becomes an Inbox Item.");
          return;
        }
        this.plugin.settings.mail.storePath = path;
        await this.plugin.saveSettings(false);
      }));

    const importSetting = new Setting(sectionEl)
      .setName("Accounts")
      .addButton((button) => button.setButtonText("Add account").onClick(async () => {
        this.plugin.settings.mail.accounts.push({
          id: createAccountId(),
          label: "Mail",
          host: "",
          port: 993,
          user: "",
          mailboxes: ["INBOX"],
          criterion: "ALL",
          archiveMailbox: "",
          appleMailLink: false,
          enabled: true,
        });
        await this.plugin.saveSettings(false);
        this.display();
      }))
      .addButton((button) => button.setButtonText("Import now").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          const result = await this.plugin.importMail();
          new Notice(describeImport(result, this.plugin.getMailStatus().error ?? ""), 12_000);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Email could not be imported.");
        } finally {
          button.setDisabled(false);
          this.display();
        }
      }));
    const refreshMailStatus = () => {
      importSetting.setDesc(mailStatusText(this.plugin.getMailStatus()));
      for (const entry of mailboxStateSettings) {
        entry.setting.setDesc(describeMailboxState(mailboxState(mail.getStore(), entry.accountId, entry.mailbox)));
      }
    };
    refreshMailStatus();
    this.unsubscribeMailStatus = mail.subscribe(refreshMailStatus);

    if (!this.plugin.settings.mail.accounts.length) {
      sectionEl.createEl("p", { text: "No accounts yet." });
      return;
    }

    for (const account of this.plugin.settings.mail.accounts) {
      const save = async () => this.plugin.saveSettings(false);
      sectionEl.createEl("h4", { text: account.label || "Mail" });

      new Setting(sectionEl)
        .setName("Label")
        .setDesc("Recorded on every Inbox Item this account produces. The switch turns importing from this account on or off.")
        .addText((text) => text.setValue(account.label).onChange(async (value) => {
          account.label = value.trim() || "Mail";
          await save();
        }))
        .addToggle((toggle) => toggle.setValue(account.enabled).onChange(async (value) => {
          account.enabled = value;
          await save();
        }));

      new Setting(sectionEl)
        .setName("Server and user")
        .setDesc("IMAP host, port, and username. Only implicit TLS on 993 is offered; cleartext IMAP is not.")
        .addText((text) => text.setPlaceholder("imap.example.com").setValue(account.host).onChange(async (value) => {
          account.host = value.trim();
          await save();
        }))
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.style.maxWidth = "6em";
          text.setValue(String(account.port)).onChange(async (value) => {
            account.port = normalizeMailPort(value);
            await save();
          });
        })
        .addText((text) => text.setPlaceholder("you@example.com").setValue(account.user).onChange(async (value) => {
          account.user = value.trim();
          await save();
        }));

      let passwordInput: HTMLInputElement;
      new Setting(sectionEl)
        .setName("App password")
        .setDesc("Use a provider-issued app password, never your account password: it is revocable and stored as plain text in this plugin's data file.")
        .addText((text) => {
          passwordInput = text.inputEl;
          text.inputEl.type = "password";
          text.setValue(this.plugin.settings.mail.passwords[account.id] ?? "").onChange(async (value) => {
            this.plugin.settings.mail.passwords[account.id] = value.trim();
            await save();
          });
        })
        .addButton((button) => button.setButtonText("Show").onClick(() => {
          const visible = passwordInput.type === "text";
          passwordInput.type = visible ? "password" : "text";
          button.setButtonText(visible ? "Show" : "Hide");
        }))
        .addButton((button) => button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          try {
            const mailboxes = await mail.listMailboxes(account, this.plugin.settings.mail.passwords[account.id] ?? "");
            new Notice(`Connected. ${mailboxes.length} mailboxes:\n${mailboxes.slice(0, 25).join("\n")}`, 15_000);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Could not connect.", 10_000);
          } finally {
            button.setDisabled(false);
          }
        }));

      new Setting(sectionEl)
        .setName("Mailboxes")
        .setDesc("Comma-separated, exactly as the server spells them \u2014 use Test above to see the list. Mirror INBOX, not All Mail or Archive, which hold every message ever.")
        .addText((text) => text.setPlaceholder("INBOX").setValue(account.mailboxes.join(", ")).onChange(async (value) => {
          account.mailboxes = value.split(",").map((mailbox) => mailbox.trim()).filter(Boolean);
          await save();
        }));

      new Setting(sectionEl)
        .setName("Which messages count")
        .setDesc("An IMAP search criterion. ALL mirrors the whole mailbox; UNSEEN takes only unread mail.")
        .addText((text) => text.setPlaceholder("ALL").setValue(account.criterion).onChange(async (value) => {
          account.criterion = value.trim() || "ALL";
          await save();
        }));

      new Setting(sectionEl)
        .setName("Move imported mail to")
        .setDesc("A mailbox such as Archive, so importing drains your mail inbox and leaves you one queue instead of two. Leave empty to leave the server untouched. Messages are never deleted.")
        .addText((text) => text.setPlaceholder("(leave the server alone)").setValue(account.archiveMailbox).onChange(async (value) => {
          account.archiveMailbox = value.trim();
          await save();
        }));

      new Setting(sectionEl)
        .setName("Link to the message in Apple Mail")
        .setDesc("Adds an \u201cOpen in Apple Mail\u201d link to each imported note. It opens the message in Mail on this Mac, found by its Message-ID, so it still works after archiving. The account must be set up in Apple Mail.")
        .addToggle((toggle) => toggle.setValue(account.appleMailLink === true).onChange(async (value) => {
          account.appleMailLink = value;
          await save();
        }));

      for (const mailbox of account.mailboxes) {
        const setting = new Setting(sectionEl)
          .setName(mailbox)
          .setDesc(describeMailboxState(mailboxState(mail.getStore(), account.id, mailbox)))
          .setClass("dg-mail-mailbox-state");
        mailboxStateSettings.push({ setting, accountId: account.id, mailbox });
      }

      new Setting(sectionEl)
        .setName("Existing mail")
        .setDesc("Whatever is in these mailboxes now is skipped. Import it if you do want the backlog \u2014 subject to the per-import limit above.")
        .addButton((button) => button.setButtonText("Import backlog").onClick(async () => {
          if (!await confirmDialog(this.app, {
            title: `Import the mail already in ${account.label}?`,
            message: "Every message there becomes an Inbox Item.",
            confirmText: "Import backlog",
          })) return;
          for (const mailbox of account.mailboxes) await mail.importBacklog(account.id, mailbox);
          new Notice("The next import will take the existing mail.");
        }))
        .addButton((button) => button.setButtonText("Remove account").setWarning().onClick(async () => {
          if (!await confirmDialog(this.app, {
            title: `Remove ${account.label}?`,
            message: "Its password and sync history are forgotten; no mail is touched.",
            confirmText: "Remove account",
            warning: true,
          })) return;
          this.plugin.settings.mail.accounts = this.plugin.settings.mail.accounts.filter((entry) => entry.id !== account.id);
          delete this.plugin.settings.mail.passwords[account.id];
          await mail.forget(account.id);
          await this.plugin.saveSettings(false);
          this.display();
        }));
    }
  }

  hide(): void {
    this.unsubscribeCalendarStatus?.();
    this.unsubscribeCalendarStatus = undefined;
    this.unsubscribeFeedStatus?.();
    this.unsubscribeFeedStatus = undefined;
    this.unsubscribeMailStatus?.();
    this.unsubscribeMailStatus = undefined;
    super.hide();
  }
}

function mailStatusText(status: ReturnType<DragonglassGtdPlugin["getMailStatus"]>): string {
  if (status.state === "unavailable") return status.error ?? "Importing is unavailable on this device.";
  if (status.result && (status.state === "success" || status.state === "error" || status.state === "idle")) {
    const when = status.lastImport ? new Date(status.lastImport).toLocaleString() : "completed";
    return `Last import ${when}. ${describeImport(status.result, status.error ?? "")}`;
  }
  if (status.state === "error") return status.error ?? "The last import failed.";
  if (status.state === "importing") return "Importing\u2026";
  if (status.state === "disabled") return "Email import is switched off.";
  return "Ready to import.";
}

function feedStatusText(status: ReturnType<DragonglassGtdPlugin["getFeedStatus"]>): string {
  if (status.state === "success") return `Last fetched ${status.lastFetch ? new Date(status.lastFetch).toLocaleString() : "successfully"}.`;
  if (status.state === "error") return status.error ?? "The last fetch failed.";
  if (status.state === "fetching") return "Fetching…";
  if (status.state === "disabled") return "Feeds are switched off.";
  return "Ready to fetch.";
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
