import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { CalendarSecret } from "../src/calendar/calendar-secret";
import type { GoogleCalendarSettings } from "../src/domain/types";

function setup(sharedSecret: string) {
  const secrets = new Map<string, string>();
  const app = {
    secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => void secrets.set(id, value),
    },
  } as unknown as App;
  const settings = { enabled: true, endpointUrl: "https://example.com/exec", sharedSecret, sourceId: "s", defaultDurationMinutes: 30 };
  return { secret: new CalendarSecret(app, () => settings as GoogleCalendarSettings), settings };
}

describe("The calendar shared secret in secret storage", () => {
  it("copies the old secret into this device's secret storage once", () => {
    const { secret } = setup("old");
    expect(secret.migrate()).toBe(true);
    expect(secret.migrate()).toBe(false);
    expect(secret.get()).toBe("old");
  });

  it("gives the sync this device's secret, even after the old copy is removed", () => {
    const { secret, settings } = setup("old");
    secret.migrate();
    secret.set("new");
    settings.sharedSecret = "";
    expect(secret.settings().sharedSecret).toBe("new");
    expect(secret.hasLegacyCopy()).toBe(false);
  });
});
