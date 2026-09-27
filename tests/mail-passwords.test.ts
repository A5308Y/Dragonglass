import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { MailPasswords, mailSecretId } from "../src/mail/mail-passwords";
import type { MailSettings } from "../src/domain/types";

function setup(passwords: Record<string, string>, secrets = new Map<string, string>()) {
  const app = {
    secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => void secrets.set(id, value),
    },
  } as unknown as App;
  const settings = { passwords } as MailSettings;
  return { store: new MailPasswords(app, () => settings), secrets };
}

describe("Mail passwords in secret storage", () => {
  it("copies old passwords from the settings file into this device's secret storage", () => {
    const { store, secrets } = setup({ "01ABC": "app-pass" });
    expect(store.migrate()).toBe(1);
    expect(secrets.get(mailSecretId("01ABC"))).toBe("app-pass");
    expect(store.migrate()).toBe(0);
  });

  it("prefers this device's password over an old copy, and finds the old copy until it is migrated", () => {
    const { store } = setup({ "01ABC": "old" });
    expect(store.get("01ABC")).toBe("old");
    store.set("01ABC", "new ");
    expect(store.get("01ABC")).toBe("new");
  });

  it("treats a forgotten password as missing", () => {
    const { store } = setup({});
    store.set("01ABC", "x");
    store.forget("01ABC");
    expect(store.has("01ABC")).toBe(false);
    expect(store.get("01ABC")).toBe("");
  });

  it("makes ids secret storage accepts", () => {
    expect(mailSecretId("01HZX9ABCDEF")).toBe("dragonglass-mail-01hzx9abcdef");
  });
});
