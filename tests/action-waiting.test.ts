import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { actionRequiresContext, waitingSinceFor } from "../src/domain/action-status";
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
  it("is the only Action status that does not require a context", () => {
    expect(actionRequiresContext("waiting")).toBe(false);
    for (const status of ["next", "scheduled", "done", "cancelled"] as const) {
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
