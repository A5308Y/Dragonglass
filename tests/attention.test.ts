import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { attention, projectsWithIssues } from "../src/domain/attention";
import type { Action, GtdSnapshot, InboxItem, Project } from "../src/domain/types";

const file = (path: string) => ({ path }) as TFile;
const today = "2026-09-24";
const weekly = { weeklyReviewDay: 5, lastWeeklyReview: "" };
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
    expect(attention(snapshot([project()], [action()]), 0, weekly, today))
      .toEqual({ inbox: false, board: false, projects: false, review: false, feeds: false, checklists: false });
  });

  it("counts the Active Projects with an issue, for the Inbox", () => {
    const stuck = project({ id: "P2", title: "Garden", file: file("Garden.md") });
    expect(projectsWithIssues(snapshot([project(), stuck], [action()]))).toBe(1);
    expect(projectsWithIssues(snapshot([project({ status: "someday" })], []))).toBe(0);
  });

  it("counts a stuck sub-project once, through the Project at the top of its tree", () => {
    const parent = project({ id: "P2", title: "House", file: file("House.md") });
    const stuck = project({ id: "P3", title: "Roof", file: file("Roof.md"), parentProjectId: "P2" });
    expect(projectsWithIssues(snapshot([project(), parent, stuck], [action()]))).toBe(1);
  });

  it("marks the Checklists while the daily checklist is due", () => {
    expect(attention(snapshot([project()], [action()]), 0, weekly, today, true).checklists).toBe(true);
  });

  it("marks the Inbox, the feeds, and a Project with an issue", () => {
    const item = { type: "gtd-inbox-item", id: "I1", title: "Note", created: today, file: file("I1.md") } as InboxItem;
    const result = attention(snapshot([project()], [], [item]), 3, weekly, today);
    expect(result.inbox).toBe(true);
    expect(result.feeds).toBe(true);
    expect(result.projects).toBe(true);
  });

  it("marks the board for overdue work, due follow-ups and Calendar Actions left from earlier days", () => {
    const board = (changes: Partial<Action>) => attention(snapshot([project()], [action(changes)]), 0, weekly, today).board;
    expect(board({ due: "2026-09-23" })).toBe(true);
    expect(board({ due: today })).toBe(false);
    expect(board({ status: "waiting", followUp: today })).toBe(true);
    expect(board({ status: "waiting", followUp: "2026-09-25" })).toBe(false);
    expect(board({ status: "scheduled", scheduledStart: "2026-09-23" })).toBe(true);
    // Today's are listed above the board's columns; they aren't late.
    expect(board({ status: "scheduled", scheduledStart: today })).toBe(false);
    expect(board({ status: "scheduled", scheduledStart: "2026-09-30" })).toBe(false);
    expect(board({ status: "done", due: "2026-09-01" })).toBe(false);
  });

  it("asks for the Weekly Review while a tree is unreviewed since the review day", () => {
    // Today is a Thursday, so this review week began on Friday 2026-09-18.
    const review = (changes: Partial<Project>) => attention(snapshot([project(changes)], [action()]), 0, weekly, today).review;
    expect(review({ reviewed: "2026-09-18" })).toBe(false);
    expect(review({ reviewed: "2026-09-17" })).toBe(true);
    const { reviewed: _reviewed, ...neverReviewed } = project();
    expect(attention(snapshot([neverReviewed], [action()]), 0, weekly, today).review).toBe(true);
    expect(review({ reviewed: "2026-09-01", status: "someday" })).toBe(false);
  });

  it("stays quiet for the rest of the week once the review is finished", () => {
    const { reviewed: _reviewed, ...addedLater } = project();
    expect(attention(snapshot([addedLater], [action()]), 0, { ...weekly, lastWeeklyReview: "2026-09-19" }, today).review).toBe(false);
  });
});
