import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import {
  ELM_PROTOCOL_VERSION,
  elmSnapshot,
  parseActionBoardCommand,
  parseBrainstormCommand,
  parseInboxCommand,
  parseModalCommand,
  parseProjectReviewCommand,
  parseSomedayReviewCommand,
  parseProjectsCommand,
} from "../src/adapter/protocol";
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
    settings.googleCalendar.sharedSecret = "super-secret-not-for-elm";
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
    expect(encoded.settings).not.toHaveProperty("googleCalendar");
    expect(encoded.settings).not.toHaveProperty("inboxDirectory");
    expect(JSON.stringify(encoded)).not.toContain(settings.googleCalendar.sharedSecret);
  });

  it("gives Elm the local reading of a timed schedule, and none for an all-day one", () => {
    const snapshot: GtdSnapshot = {
      revision: 1,
      inboxItems: [],
      actions: [
        { type: "gtd-action", id: "A1", title: "Timed", file, status: "scheduled", created: "2026-09-20", scheduledStart: "2026-09-22T12:00:00.000Z", durationMinutes: 45 },
        { type: "gtd-action", id: "A2", title: "All day", file, status: "scheduled", created: "2026-09-20", scheduledStart: "2026-09-22" },
      ],
      projects: [],
      inboxItemsById: new Map(),
      actionsById: new Map(),
      projectsById: new Map(),
      issues: [],
    };

    const encoded = elmSnapshot(snapshot, defaultSettings(), "2026-09-20");

    expect(encoded.actions[0]?.scheduledLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(encoded.actions[0]!.scheduledLocal!).getTime()).toBe(Date.parse("2026-09-22T12:00:00.000Z"));
    expect(encoded.actions[1]).not.toHaveProperty("scheduledLocal");
  });

  it("rejects malformed and mismatched command envelopes", () => {
    expect(parseActionBoardCommand(null)).toBeNull();
    expect(parseActionBoardCommand({ protocolVersion: 999, requestId: "1", command: { type: "quick-capture" } })).toBeNull();
    expect(parseActionBoardCommand({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "1", command: {} })).toBeNull();
    expect(parseInboxCommand({
      protocolVersion: ELM_PROTOCOL_VERSION,
      requestId: "1",
      command: { type: "process-inbox", itemId: "I1", operation: "unknown", input: {} },
    })).toBeNull();
    expect(parseActionBoardCommand({
      protocolVersion: ELM_PROTOCOL_VERSION,
      requestId: "1",
      command: { type: "quick-capture" },
    })?.command.type).toBe("quick-capture");

    // A valid command still cannot cross into a surface that does not own it.
    expect(parseModalCommand({
      protocolVersion: ELM_PROTOCOL_VERSION,
      requestId: "1",
      command: { type: "quick-capture" },
    })).toBeNull();
  });

  it("validates Projects commands at the adapter boundary", () => {
    const envelope = (command: unknown) => ({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "projects-1", command });

    expect(parseProjectsCommand(envelope({ type: "move-subproject", projectId: "P2", status: "backlog" }))?.command.type)
      .toBe("move-subproject");
    expect(parseProjectsCommand(envelope({ type: "save-project-preferences", columns: ["active", "someday"], showImages: true, groupByArea: false }))?.command.type)
      .toBe("save-project-preferences");
    expect(parseProjectsCommand(envelope({ type: "save-project-preferences", columns: ["active"], showImages: true }))).toBeNull();
    expect(parseSomedayReviewCommand(envelope({ type: "review-someday-project", projectId: "P3", activateAt: "2026-10-01" }))?.command.type)
      .toBe("review-someday-project");
    expect(parseSomedayReviewCommand(envelope({ type: "review-someday-project", projectId: "P3", activateAt: "" }))?.command.type)
      .toBe("review-someday-project");
    expect(parseSomedayReviewCommand(envelope({ type: "review-someday-project", projectId: "P3" }))).toBeNull();
    // The review moved to its own view, so the Projects board no longer accepts it.
    expect(parseProjectsCommand(envelope({ type: "review-someday-project", projectId: "P3", activateAt: "" }))).toBeNull();
    expect(parseProjectsCommand(envelope({ type: "open-someday-review" }))?.command.type).toBe("open-someday-review");
    expect(parseProjectsCommand(envelope({ type: "set-project-area", projectId: "P2", area: "Work" }))?.command.type)
      .toBe("set-project-area");
    expect(parseProjectsCommand(envelope({ type: "set-project-area", projectId: "P2" }))).toBeNull();
    expect(parseProjectsCommand(envelope({ type: "link-project-file", projectId: "P2" }))?.command.type).toBe("link-project-file");
    expect(parseProjectsCommand(envelope({ type: "unlink-project-file", projectId: "P2", link: "[[Contracts/Lease.pdf]]" }))?.command.type)
      .toBe("unlink-project-file");
    expect(parseProjectsCommand(envelope({ type: "unlink-project-file", projectId: "P2" }))).toBeNull();
    expect(parseProjectsCommand(envelope({ type: "move-subproject", projectId: "P2", status: "next" }))).toBeNull();
    expect(parseProjectsCommand(envelope({ type: "trash-projects", projectIds: ["P1", 2] }))).toBeNull();
    expect(parseProjectsCommand(envelope({ type: "save-project-preferences", columns: [], showImages: true, groupByArea: false }))).toBeNull();
  });

  it("validates modal commands at the adapter boundary", () => {
    const envelope = (command: unknown) => ({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "7", command });
    const input = { title: "Draft", status: "next", context: "computer" };

    expect(parseModalCommand(envelope({ type: "save-new-action", input }))?.command.type).toBe("save-new-action");
    expect(parseModalCommand(envelope({
      type: "save-new-action",
      input: { ...input, schedule: { kind: "timed", localStart: "2026-09-22T12:00", durationMinutes: 45 } },
    }))?.command.type).toBe("save-new-action");
    expect(parseModalCommand(envelope({
      type: "save-action",
      actionId: "A1",
      changes: { ...input, projectId: "", energy: "", due: "", followUp: "" },
    }))?.command.type).toBe("save-action");
    expect(parseModalCommand(envelope({
      type: "save-action",
      actionId: "A1",
      changes: { ...input, projectId: "", energy: "high", due: "", followUp: "" },
    }))?.command.type).toBe("save-action");
    expect(parseModalCommand(envelope({
      type: "save-action",
      actionId: "A1",
      changes: { ...input, projectId: "", energy: "exhausted", due: "", followUp: "" },
    }))).toBeNull();
    expect(parseModalCommand(envelope({
      type: "save-project",
      projectId: "P1",
      changes: { title: "Roof", status: "someday", activateAt: "2026-10-01", area: "", image: "", tags: [], reviewed: "", parentProjectId: "" },
    }))?.command.type).toBe("save-project");
    expect(parseModalCommand(envelope({ type: "parse-import-list", kind: "subprojects", text: "- [ ] One" }))?.command.type)
      .toBe("parse-import-list");
    expect(parseModalCommand(envelope({ type: "close-modal" }))?.command.type).toBe("close-modal");

    // A schedule with no duration, an unknown status, and a half-built Project edit are all refused.
    expect(parseModalCommand(envelope({
      type: "save-new-action",
      input: { ...input, schedule: { kind: "timed", localStart: "2026-09-22T12:00" } },
    }))).toBeNull();
    expect(parseModalCommand(envelope({ type: "save-new-action", input: { ...input, status: "inbox" } }))).toBeNull();
    expect(parseModalCommand(envelope({ type: "save-action", actionId: "A1", changes: input }))).toBeNull();
    expect(parseModalCommand(envelope({ type: "parse-import-list", kind: "notes", text: "" }))).toBeNull();
    expect(parseModalCommand(envelope({ type: "add-project-tags", projectIds: ["P1"], tags: [3] }))).toBeNull();
  });

  it("validates Review and Brainstorm commands at the adapter boundary", () => {
    const envelope = (command: unknown) => ({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "workflow-1", command });

    expect(parseProjectReviewCommand(envelope({
      type: "complete-project-review",
      projectId: "P1",
      desiredOutcome: "Done looks like this",
      activeProjectIds: ["P1", "P2"],
    }))?.command.type).toBe("complete-project-review");
    expect(parseProjectReviewCommand(envelope({ type: "set-project-status", projectId: "P2", status: "active" }))?.command.type)
      .toBe("set-project-status");
    expect(parseProjectReviewCommand(envelope({ type: "set-project-status", projectId: "P2", status: "next" }))).toBeNull();
    expect(parseBrainstormCommand(envelope({
      type: "save-brainstorm",
      actionId: "A1",
      ideas: "An idea",
      desiredOutcome: "A better outcome",
    }))?.command.type).toBe("save-brainstorm");
    expect(parseBrainstormCommand(envelope({ type: "focus-brainstorm-ideas", start: 3, end: 3 }))?.command.type)
      .toBe("focus-brainstorm-ideas");
    expect(parseProjectReviewCommand(envelope({ type: "complete-project-review", projectId: "P1", desiredOutcome: "", activeProjectIds: [4] }))).toBeNull();
    expect(parseBrainstormCommand(envelope({ type: "focus-brainstorm-ideas", start: 1.5, end: 2 }))).toBeNull();
    expect(parseBrainstormCommand(envelope({ type: "focus-brainstorm-ideas", start: 4, end: 2 }))).toBeNull();
  });

  it("validates nested Inbox, settings, and menu payloads", () => {
    const envelope = (command: unknown) => ({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "nested-1", command });
    const view = defaultSettings().savedViews[0]!;

    expect(parseInboxCommand(envelope({
      type: "process-inbox",
      itemId: "I1",
      operation: "next-action",
      input: { nextAction: "Call", context: "phone", fileOriginal: true },
    }))?.command.type).toBe("process-inbox");
    expect(parseInboxCommand(envelope({
      type: "process-inbox",
      itemId: "I1",
      operation: "next-action",
      input: { nextAction: "Await reply", status: "waiting", waitingSince: "2026-09-22", context: "", fileOriginal: false },
    }))?.command.type).toBe("process-inbox");
    expect(parseInboxCommand(envelope({
      type: "process-inbox",
      itemId: "I1",
      operation: "next-action",
      input: {
        nextAction: "Call supplier",
        status: "scheduled",
        context: "phone",
        schedule: { kind: "all-day", date: "2026-09-23" },
        fileOriginal: false,
      },
    }))?.command.type).toBe("process-inbox");
    expect(parseInboxCommand(envelope({
      type: "process-inbox",
      itemId: "I1",
      operation: "next-action",
      input: { fileOriginal: "false" },
    }))).toBeNull();

    expect(parseActionBoardCommand(envelope({ type: "set-action-priorities", actionIds: ["A2", "A1"] }))?.command.type)
      .toBe("set-action-priorities");
    expect(parseActionBoardCommand(envelope({ type: "set-action-priorities", actionIds: [] }))).toBeNull();

    expect(parseActionBoardCommand(envelope({ type: "upsert-saved-view", view, activate: true }))?.command.type)
      .toBe("upsert-saved-view");
    expect(parseActionBoardCommand(envelope({ type: "upsert-saved-view", view: { ...view, sort: {} }, activate: true })))
      .toBeNull();
    expect(parseActionBoardCommand(envelope({
      type: "show-menu",
      x: 10,
      y: 20,
      entries: [{ label: "Delete", command: { type: "trash-action", actionId: "A1" } }, { separator: true }],
    }))?.command.type).toBe("show-menu");
    expect(parseActionBoardCommand(envelope({
      type: "show-menu",
      x: 10,
      y: 20,
      entries: [{ label: "Wrong surface", command: { type: "trash-project", projectId: "P1" } }],
    }))).toBeNull();
  });
});
