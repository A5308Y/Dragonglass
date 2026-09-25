import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { actionKeepsContext, actionRequiresContext, followUpFor, waitingSinceFor } from "../src/domain/action-status";
import { parseAction } from "../src/domain/validation";

const file = { path: "GTD/Actions/Chase invoice.md" } as TFile;
const frontmatter = (changes: Record<string, unknown> = {}) => ({
  type: "gtd-action",
  id: "01J0000000000000000000000A",
  title: "Chase invoice",
  status: "waiting",
  created: "2026-09-01",
  context: "Calls",
  ...changes,
});

describe("Waiting since", () => {
  it("is, with Done and Cancelled, an Action status that does not require a context", () => {
    for (const status of ["waiting", "done", "cancelled"] as const) {
      expect(actionRequiresContext(status)).toBe(false);
    }
    for (const status of ["next", "scheduled"] as const) {
      expect(actionRequiresContext(status)).toBe(true);
    }
  });

  it("starts the wait today when nothing is known yet", () => {
    expect(waitingSinceFor("waiting", undefined, undefined, "2026-09-20")).toBe("2026-09-20");
  });

  it("keeps the date an Action is already waiting since", () => {
    expect(waitingSinceFor("waiting", "2026-08-04", undefined, "2026-09-20")).toBe("2026-08-04");
  });

  it("lets an explicit date override both", () => {
    expect(waitingSinceFor("waiting", "2026-08-04", " 2026-07-15 ", "2026-09-20")).toBe("2026-07-15");
    expect(waitingSinceFor("waiting", undefined, "", "2026-09-20")).toBe("2026-09-20");
  });

  it("carries no date on any other status", () => {
    for (const status of ["next", "scheduled", "done", "cancelled"] as const) {
      expect(waitingSinceFor(status, "2026-08-04", "2026-07-15", "2026-09-20")).toBeNull();
    }
  });

  it("reads waiting_since from frontmatter", () => {
    expect(parseAction(frontmatter({ waiting_since: "2026-08-04" }), file).waitingSince).toBe("2026-08-04");
    expect(parseAction(frontmatter({ waiting_since: null }), file).waitingSince).toBeUndefined();
    expect(parseAction(frontmatter(), file).waitingSince).toBeUndefined();
  });

  it("rejects a waiting_since that is not a plain date", () => {
    expect(() => parseAction(frontmatter({ waiting_since: "2026-08-04T10:00:00Z" }), file)).toThrow("Invalid 'waiting_since' date");
  });
});

describe("Context and energy on Waiting Actions", () => {
  it("are kept by every status but Waiting", () => {
    expect(actionKeepsContext("waiting")).toBe(false);
    for (const status of ["next", "scheduled", "done", "cancelled"] as const) expect(actionKeepsContext(status)).toBe(true);
  });

  it("are ignored when a Waiting Action's file still carries them", () => {
    const parsed = parseAction(frontmatter({ energy: "high" }), file);
    expect(parsed.context).toBeUndefined();
    expect(parsed.energy).toBeUndefined();
    const next = parseAction(frontmatter({ status: "next", energy: "high" }), file);
    expect(next.context).toBe("Calls");
    expect(next.energy).toBe("high");
  });
});

describe("Follow-up", () => {
  it("is optional and kept while an Action stays Waiting", () => {
    expect(followUpFor("waiting")).toBeNull();
    expect(followUpFor("waiting", "2026-10-01")).toBe("2026-10-01");
  });

  it("lets an explicit value replace or clear it", () => {
    expect(followUpFor("waiting", "2026-10-01", " 2026-10-15 ")).toBe("2026-10-15");
    expect(followUpFor("waiting", "2026-10-01", "")).toBeNull();
  });

  it("is cleared when the Action leaves Waiting", () => {
    for (const status of ["next", "scheduled", "done", "cancelled"] as const) {
      expect(followUpFor(status, "2026-10-01", "2026-10-15")).toBeNull();
    }
  });

  it("reads follow_up from frontmatter", () => {
    expect(parseAction(frontmatter({ follow_up: "2026-10-01" }), file).followUp).toBe("2026-10-01");
    expect(parseAction(frontmatter(), file).followUp).toBeUndefined();
    expect(() => parseAction(frontmatter({ follow_up: "soon" }), file)).toThrow("Invalid 'follow_up' date");
  });
});
