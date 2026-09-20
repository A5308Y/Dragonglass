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
      inboxItems: [{ type: "gtd-inbox-item", id: "I1", title: "Voice note", file, created: "2026-09-20", raw: true }],
      actions: [{ type: "gtd-action", id: "A1", title: "Test", file, status: "next", created: "2026-09-20", context: "computer" }],
      projects: [],
      inboxItemsById: new Map(),
      actionsById: new Map(),
      projectsById: new Map(),
      issues: [],
    };

    const encoded = elmSnapshot(snapshot, defaultSettings(), "2026-09-20", () => "app://resource/Test.md");

    expect(encoded.protocolVersion).toBe(ELM_PROTOCOL_VERSION);
    expect(encoded.actions[0]?.file).toEqual({
      path: "GTD/Actions/Test.md",
      name: "Test.md",
      basename: "Test",
      extension: "md",
    });
    expect(JSON.stringify(encoded)).not.toContain("forbidden");
    expect(encoded.inboxItems[0]).toMatchObject({
      id: "I1",
      resourceUrl: "app://resource/Test.md",
      file: { path: "GTD/Actions/Test.md", extension: "md" },
    });
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
      command: { type: "process-inbox", itemId: "I1", operation: "unknown", input: {} },
    })).toBeNull();
    expect(parseElmCommand({
      protocolVersion: ELM_PROTOCOL_VERSION,
      requestId: "1",
      command: { type: "quick-capture" },
    })?.command.type).toBe("quick-capture");
  });

  it("validates Projects commands at the adapter boundary", () => {
    const envelope = (command: unknown) => ({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "projects-1", command });

    expect(parseElmCommand(envelope({ type: "move-subproject", projectId: "P2", status: "backlog" }))?.command.type)
      .toBe("move-subproject");
    expect(parseElmCommand(envelope({ type: "save-project-preferences", columns: ["active", "someday"], showImages: true }))?.command.type)
      .toBe("save-project-preferences");
    expect(parseElmCommand(envelope({ type: "move-subproject", projectId: "P2", status: "next" }))).toBeNull();
    expect(parseElmCommand(envelope({ type: "trash-projects", projectIds: ["P1", 2] }))).toBeNull();
    expect(parseElmCommand(envelope({ type: "save-project-preferences", columns: [], showImages: true }))).toBeNull();
  });

  it("validates Review and Brainstorm commands at the adapter boundary", () => {
    const envelope = (command: unknown) => ({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "workflow-1", command });

    expect(parseElmCommand(envelope({
      type: "complete-project-review",
      projectId: "P1",
      desiredOutcome: "Done looks like this",
      activeProjectIds: ["P1", "P2"],
    }))?.command.type).toBe("complete-project-review");
    expect(parseElmCommand(envelope({
      type: "save-brainstorm",
      actionId: "A1",
      ideas: "An idea",
      desiredOutcome: "A better outcome",
    }))?.command.type).toBe("save-brainstorm");
    expect(parseElmCommand(envelope({ type: "focus-brainstorm-ideas", start: 3, end: 3 }))?.command.type)
      .toBe("focus-brainstorm-ideas");
    expect(parseElmCommand(envelope({ type: "complete-project-review", projectId: "P1", desiredOutcome: "", activeProjectIds: [4] }))).toBeNull();
    expect(parseElmCommand(envelope({ type: "focus-brainstorm-ideas", start: 1.5, end: 2 }))).toBeNull();
    expect(parseElmCommand(envelope({ type: "focus-brainstorm-ideas", start: 4, end: 2 }))).toBeNull();
  });
});
