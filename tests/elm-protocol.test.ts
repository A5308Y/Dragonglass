import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { ELM_PROTOCOL_VERSION, elmSnapshot, parseElmCommand } from "../src/adapter/protocol";
import { defaultSettings } from "../src/state/defaults";
import type { GtdSnapshot } from "../src/domain/types";

const file = {
  path: "GTD/Actions/Test.md",
  name: "Test.md",
  basename: "Test",
  extension: "md",
  stat: { ctime: 1, mtime: 2, size: 3 },
  vault: { forbidden: true },
} as unknown as TFile;

describe("Elm adapter protocol", () => {
  it("serializes snapshots without leaking Obsidian file objects", () => {
    const snapshot: GtdSnapshot = {
      revision: 7,
      inboxItems: [],
      actions: [{ type: "gtd-action", id: "A1", title: "Test", file, status: "next", created: "2026-09-20", context: "computer" }],
      projects: [],
      inboxItemsById: new Map(),
      actionsById: new Map(),
      projectsById: new Map(),
      issues: [],
    };

    const encoded = elmSnapshot(snapshot, defaultSettings(), "2026-09-20");

    expect(encoded.protocolVersion).toBe(ELM_PROTOCOL_VERSION);
    expect(encoded.actions[0]?.file).toEqual({
      path: "GTD/Actions/Test.md",
      name: "Test.md",
      basename: "Test",
      extension: "md",
    });
    expect(JSON.stringify(encoded)).not.toContain("forbidden");
  });

  it("copies settings so Elm flags cannot mutate plugin state", () => {
    const settings = defaultSettings();
    const snapshot: GtdSnapshot = {
      revision: 1,
      inboxItems: [],
      actions: [],
      projects: [],
      inboxItemsById: new Map(),
      actionsById: new Map(),
      projectsById: new Map(),
      issues: [],
    };

    const encoded = elmSnapshot(snapshot, settings, "2026-09-20");
    encoded.settings.savedViews[0]!.name = "Changed";

    expect(settings.savedViews[0]?.name).not.toBe("Changed");
  });

  it("rejects malformed and mismatched command envelopes", () => {
    expect(parseElmCommand(null)).toBeNull();
    expect(parseElmCommand({ protocolVersion: 999, requestId: "1", command: { type: "quick-capture" } })).toBeNull();
    expect(parseElmCommand({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "1", command: {} })).toBeNull();
    expect(parseElmCommand({
      protocolVersion: ELM_PROTOCOL_VERSION,
      requestId: "1",
      command: { type: "quick-capture" },
    })?.command.type).toBe("quick-capture");
  });
});
