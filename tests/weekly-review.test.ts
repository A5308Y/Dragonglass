import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { reviewWeekStart, weeklyReviewDue, weeklyReviewFinished } from "../src/domain/weekly-review";
import type { GtdSnapshot, Project } from "../src/domain/types";

const file = (path: string) => ({ path }) as TFile;
const project = (id: string, reviewed?: string): Project => ({
  type: "gtd-project", id, title: id, status: "active", created: "2026-09-01", file: file(`${id}.md`), ...(reviewed ? { reviewed } : {}),
});
const snapshot = (projects: Project[]): GtdSnapshot => ({
  revision: 1,
  inboxItems: [],
  actions: [],
  projects,
  inboxItemsById: new Map(),
  actionsById: new Map(),
  projectsById: new Map(projects.map((item) => [item.id, item])),
  issues: [],
});
const friday = { weeklyReviewDay: 5, lastWeeklyReview: "" };

describe("Weekly Review", () => {
  it("starts the review week on the latest review day", () => {
    expect(reviewWeekStart("2026-09-25", 5)).toBe("2026-09-25"); // Friday itself
    expect(reviewWeekStart("2026-09-26", 5)).toBe("2026-09-25"); // the Saturday after
    expect(reviewWeekStart("2026-09-24", 5)).toBe("2026-09-18"); // the Thursday before the next one
  });

  it("stays due over the following days until every tree is reviewed", () => {
    const partly = snapshot([project("A", "2026-09-25"), project("B", "2026-09-18")]);
    expect(weeklyReviewDue(partly, friday, "2026-09-26")).toBe(true);
    const done = snapshot([project("A", "2026-09-25"), project("B", "2026-09-26")]);
    expect(weeklyReviewDue(done, friday, "2026-09-26")).toBe(false);
    expect(weeklyReviewFinished(done, friday, "2026-09-26")).toBe(true);
  });

  it("does not reopen a finished week for a Project added later, but asks for it next week", () => {
    const settings = { ...friday, lastWeeklyReview: "2026-09-25" };
    const added = snapshot([project("A", "2026-09-25"), project("New")]);
    expect(weeklyReviewDue(added, settings, "2026-09-28")).toBe(false);
    expect(weeklyReviewFinished(added, settings, "2026-09-28")).toBe(false);
    expect(weeklyReviewDue(added, settings, "2026-10-02")).toBe(true);
  });

  it("counts an early review for the week it was done in", () => {
    // Reviewed on Thursday, so the Friday after, a new week asks again.
    expect(weeklyReviewDue(snapshot([project("A", "2026-09-24")]), friday, "2026-09-25")).toBe(true);
  });
});
