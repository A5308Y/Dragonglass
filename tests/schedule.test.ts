import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { actionSchedule, isAllDaySchedule, scheduleReminderMinutes } from "../src/domain/schedule";
import { normalizeScheduledStart, parseAction } from "../src/domain/validation";

const file = { path: "GTD/Actions/Dentist.md" } as TFile;
const frontmatter = (changes: Record<string, unknown> = {}) => ({
  type: "gtd-action",
  id: "01J0000000000000000000000A",
  title: "Dentist",
  status: "scheduled",
  created: "2026-09-01",
  context: "Errands",
  ...changes,
});

describe("Action schedules", () => {
  it("alarms an hour before a timed Action", () => {
    expect(scheduleReminderMinutes({ kind: "timed", start: "2026-09-22T12:00:00.000Z", durationMinutes: 45 })).toBe(60);
  });

  it("alarms at 09:00 the day before an all-day Action", () => {
    // Google counts back from midnight on the start date, so 09:00 the previous day is 15 hours.
    expect(scheduleReminderMinutes({ kind: "all-day", date: "2026-09-22" })).toBe(900);
  });

  it("treats a plain date as a schedule with no time of day", () => {
    expect(isAllDaySchedule("2026-09-22")).toBe(true);
    expect(isAllDaySchedule("2026-09-22T12:00:00.000Z")).toBe(false);
    expect(actionSchedule("2026-09-22")).toEqual({ kind: "all-day", date: "2026-09-22" });
  });

  it("needs no duration for an all-day schedule, and ignores a stale one", () => {
    expect(actionSchedule("2026-09-22", 45)).toEqual({ kind: "all-day", date: "2026-09-22" });
  });

  it("needs a positive duration for a timed schedule", () => {
    expect(actionSchedule("2026-09-22T12:00:00.000Z", 45))
      .toEqual({ kind: "timed", start: "2026-09-22T12:00:00.000Z", durationMinutes: 45 });
    expect(actionSchedule("2026-09-22T12:00:00.000Z")).toBeUndefined();
    expect(actionSchedule("2026-09-22T12:00:00.000Z", 0)).toBeUndefined();
    expect(actionSchedule(undefined, 45)).toBeUndefined();
  });

  it("normalizes both written forms and rejects neither-nor", () => {
    expect(normalizeScheduledStart("2026-09-22")).toBe("2026-09-22");
    expect(normalizeScheduledStart("2026-09-22T12:00:00Z")).toBe("2026-09-22T12:00:00.000Z");
    expect(() => normalizeScheduledStart("22-09-2026")).toThrow("Invalid 'scheduled_start' timestamp");
    expect(() => normalizeScheduledStart("tomorrow")).toThrow("Invalid 'scheduled_start' timestamp");
  });

  it("parses a date-only scheduled_start from frontmatter", () => {
    expect(parseAction(frontmatter({ scheduled_start: "2026-09-22" }), file).scheduledStart).toBe("2026-09-22");
  });
});
