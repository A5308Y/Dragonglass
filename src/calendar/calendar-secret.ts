import type { App } from "obsidian";
import type { GoogleCalendarSettings } from "../domain/types";

const SECRET_ID = "dragonglass-calendar-secret";

/**
 * The Apps Script bridge's shared secret, kept in Obsidian's secret storage on each device
 * instead of the plugin's data file, which syncs with the vault.
 *
 * Older versions kept it in `settings.googleCalendar.sharedSecret`. Each device copies it
 * into its own secret storage when it starts; the copy in the data file stays until the
 * person removes it in the settings, so a device that hasn't started since still finds it.
 */
export class CalendarSecret {
  constructor(private readonly app: App, private readonly getSettings: () => GoogleCalendarSettings) {}

  get(): string {
    return this.stored() || this.getSettings().sharedSecret;
  }

  set(secret: string): void {
    this.app.secretStorage.setSecret(SECRET_ID, secret.trim());
  }

  /** Copies the data file's secret if this device doesn't have one yet. */
  migrate(): boolean {
    const legacy = this.getSettings().sharedSecret;
    if (!legacy || this.stored()) return false;
    this.set(legacy);
    return true;
  }

  hasLegacyCopy(): boolean {
    return Boolean(this.getSettings().sharedSecret);
  }

  /** The settings the sync works with, carrying the secret from secret storage. */
  settings(): GoogleCalendarSettings {
    return { ...this.getSettings(), sharedSecret: this.get() };
  }

  private stored(): string {
    return this.app.secretStorage.getSecret(SECRET_ID) ?? "";
  }
}
