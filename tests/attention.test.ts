import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { attention } from "../src/domain/attention";
import type { Action, GtdSnapshot, InboxItem, Project } from "../src/domain/types";

const file = (path: string) => ({ path }) as TFile;
const today = "2026-09-24";
const project = (changes: Partial<Project> = {}): Project =>
  ({ type: "gtd-project", id: "P1", title: "Roof", status: "active", created: "2026-09-01", file: file("Roof.md"), reviewed: today, ...changes });
const action = (changes: Partial<Action> = {}): Action =>
  ({ type: "gtd-action", id: "A1", title: "Call roofer", status: "next", projectId: "P1", context: "phone", created: "2026-09-01", file: file("A1.md"), ...changes });
const snapshot = (projects: Project[], actions: Action[], inboxItems: InboxItem[] = []): GtdSnapshot => ({
  revision: 1,
  inboxItems,
  actions,
  projects,
  inboxItemsById: new Map(inboxItems.map((item) => [item.id, item])),
  actionsById: new Map(actions.map((item) => [item.id, item])),
  projectsById: new Map(projects.map((item) => [item.id, item])),
  issues: [],
});

describe("attention dots", () => {
  it("stays quiet when nothing waits", () => {
    expect(attention(snapshot([project()], [action()]), 0, today))
      .toEqual({ inbox: false, board: false, projects: false, review: false, feeds: false });
  });

  it("marks the Inbox, the feeds, and a Project with an issue", () => {
    const item = { type: "gtd-inbox-item", id: "I1", title: "Note", created: today, file: file("I1.md") } as InboxItem;
    const result = attention(snapshot([project()], [], [item]), 3, today);
    expect(result.inbox).toBe(true);
    expect(result.feeds).toBe(true);
    expect(result.projects).toBe(true);
  });

  it("marks the board for overdue work, due follow-ups and today's Calendar Actions", () => {
    const board = (changes: Partial<Action>) => attention(snapshot([project()], [action(changes)]), 0, today).board;
    expect(board({ due: "2026-09-23" })).toBe(true);
    expect(board({ due: today })).toBe(false);
    expect(board({ status: "waiting", followUp: today })).toBe(true);
    expect(board({ status: "waiting", followUp: "2026-09-25" })).toBe(false);
    expect(board({ status: "scheduled", scheduledStart: today })).toBe(true);
    expect(board({ status: "scheduled", scheduledStart: "2026-09-30" })).toBe(false);
    expect(board({ status: "done", due: "2026-09-01" })).toBe(false);
  });

  it("asks for a review once a top-level Project has gone a week without one", () => {
    const review = (changes: Partial<Project>) => attention(snapshot([project(changes)], [action()]), 0, today).review;
    expect(review({ reviewed: "2026-09-18" })).toBe(false);
    expect(review({ reviewed: "2026-09-17" })).toBe(true);
    const { reviewed: _reviewed, ...neverReviewed } = project();
    expect(attention(snapshot([neverReviewed], [action()]), 0, today).review).toBe(true);
    expect(review({ reviewed: "2026-09-01", status: "someday" })).toBe(false);
  });
});
