import type { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { estimateLabel, estimateStep } from "../src/domain/estimate";
import type { Action } from "../src/domain/types";
import { parseAction } from "../src/domain/validation";
import { filterActions, groupActions } from "../src/state/query";

const file = { path: "GTD/Actions/Call.md" } as TFile;
const frontmatter = (changes: Record<string, unknown>) => ({
  type: "gtd-action", id: "01J0000000000000000000000A", title: "Call", status: "next", created: "2026-10-01", context: "Phone",
  ...changes,
});
const action = (id: string, estimate?: Action["estimate"]): Action => ({
  type: "gtd-action", id, title: id, file, status: "next", created: "2026-10-01", ...(estimate ? { estimate } : {}),
});

describe("Estimates", () => {
  it("come in rough steps; other minutes count as the next step up", () => {
    expect([1, 5, 6, 20, 45, 61, 500].map(estimateStep)).toEqual([5, 5, 15, 30, 60, 120, 120]);
    expect([5, 15, 60, 120].map((minutes) => estimateLabel(estimateStep(minutes)))).toEqual(["5 min", "15 min", "1 h", "2 h"]);
  });

  it("are read from estimate_minutes, written by hand too, and dropped by Waiting Actions", () => {
    expect(parseAction(frontmatter({ estimate_minutes: 15 }), file).estimate).toBe(15);
    expect(parseAction(frontmatter({ estimate_minutes: "45" }), file).estimate).toBe(60);
    expect(parseAction(frontmatter({ estimate_minutes: null }), file).estimate).toBeUndefined();
    expect(parseAction(frontmatter({ status: "waiting", estimate_minutes: 15 }), file).estimate).toBeUndefined();
    expect(() => parseAction(frontmatter({ estimate_minutes: "soon" }), file)).toThrow("Invalid 'estimate_minutes'");
  });

  it("filter and group the board, shortest first and none last", () => {
    const actions = [action("long", 120), action("none"), action("quick", 5), action("short", 15)];
    const fits = filterActions(actions, [{ kind: "value", field: "estimate", operator: "in", values: ["5", "15"] }], "", new Map());
    expect(fits.map((entry) => entry.id)).toEqual(["quick", "short"]);
    expect(groupActions(actions, "estimate", new Map()).map((group) => group.label)).toEqual(["5 min", "15 min", "2 h", "No estimate"]);
  });
});
