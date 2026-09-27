import type { App } from "obsidian";
import type { MailSettings } from "../domain/types";

/**
 * Mail app passwords, kept in Obsidian's secret storage on each device instead of the
 * plugin's data file, which syncs with the vault.
 *
 * Older versions kept them in `settings.mail.passwords`. Each device copies those into its
 * own secret storage when it starts; the copies in the data file stay until the person
 * removes them in the settings, so a computer that hasn't started since still finds them.
 */
export class MailPasswords {
  constructor(private readonly app: App, private readonly getSettings: () => MailSettings) {}

  get(accountId: string): string {
    return this.stored(accountId) || this.getSettings().passwords[accountId] || "";
  }

  /** Whether this device has the password in its own secret storage. */
  has(accountId: string): boolean {
    return Boolean(this.stored(accountId));
  }

  set(accountId: string, password: string): void {
    this.app.secretStorage.setSecret(mailSecretId(accountId), password.trim());
  }

  /** Secret storage can't delete; an empty secret counts as none. */
  forget(accountId: string): void {
    this.set(accountId, "");
  }

  /** Copies passwords from the data file that this device doesn't have yet. Returns how many. */
  migrate(): number {
    let copied = 0;
    for (const [accountId, password] of Object.entries(this.getSettings().passwords)) {
      if (!password || this.has(accountId)) continue;
      this.set(accountId, password);
      copied += 1;
    }
    return copied;
  }

  /** How many passwords the data file still holds. */
  legacyCount(): number {
    return Object.values(this.getSettings().passwords).filter(Boolean).length;
  }

  private stored(accountId: string): string {
    return this.app.secretStorage.getSecret(mailSecretId(accountId)) ?? "";
  }
}

/** Secret ids are lowercase letters, digits and dashes; account ids are ULIDs. */
export function mailSecretId(accountId: string): string {
  return `dragonglass-mail-${accountId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}
