import { describe, expect, it } from "vitest";
import { ideasFromText, planDiaryEntry, plannedSteps, type PlanItem } from "../src/domain/project-plan";
import { setMarkdownSectionBefore } from "../src/utils/markdown";

const item = (title: string, kind: PlanItem["kind"], changes: Partial<PlanItem> = {}): PlanItem =>
  ({ title, kind, context: "", after: "", ...changes });

describe("Planning a Project", () => {
  it("turns typed ideas into a list, without bullets or numbering", () => {
    expect(ideasFromText("- Find tiles\n2. Book plumber\n\n* [ ] Pick colour\n  Measure the room  ")).toEqual([
      "Find tiles", "Book plumber", "Pick colour", "Measure the room",
    ]);
  });

  it("sorts the decisions and creates a Sub-project before the one that waits for it", () => {
    const steps = plannedSteps([
      item("Install the bathroom", "subproject", { after: "idea:2" }),
      item("Call the plumber", "action", { context: "Phone" }),
      item("Demolish the old one", "subproject"),
      item("Sauna", "someday"),
      item("Gold taps", "drop"),
      item("  ", "action"),
    ], new Set());

    expect(steps.subprojects.map((planned) => planned.title)).toEqual(["Demolish the old one", "Install the bathroom", "Sauna"]);
    expect(steps.subprojects[1]).toMatchObject({ afterIdea: 2, someday: false });
    expect(steps.subprojects[2]).toMatchObject({ someday: true });
    expect(steps.actions).toEqual([{ title: "Call the plumber", context: "Phone" }]);
    expect(steps.dropped).toEqual(["Gold taps"]);
  });

  it("lets a Sub-project wait for one that already exists in the tree, and nothing else", () => {
    expect(plannedSteps([item("Tiles", "subproject", { after: "project:P2" })], new Set(["P2"])).subprojects[0])
      .toMatchObject({ afterProjectId: "P2" });
    expect(() => plannedSteps([item("Tiles", "subproject", { after: "project:X" })], new Set(["P2"]))).toThrow("outside");
  });

  it("refuses an Action without a context, a wait on a non-Sub-project and a cycle", () => {
    expect(() => plannedSteps([item("Call", "action")], new Set())).toThrow("needs a context");
    expect(() => plannedSteps([item("A", "subproject", { after: "idea:1" }), item("B", "action", { context: "X" })], new Set()))
      .toThrow("isn't a Sub-project");
    expect(() => plannedSteps([item("A", "subproject", { after: "idea:1" }), item("B", "subproject", { after: "idea:0" })], new Set()))
      .toThrow("waits for itself");
  });

  it("keeps the plan's decisions, dropped ideas included, as a Diary entry", () => {
    const entry = planDiaryEntry(plannedSteps([
      item("Call the plumber", "action", { context: "Phone" }),
      item("Demolish", "subproject"),
      item("Sauna", "someday"),
      item("Gold taps", "drop"),
    ], new Set()));
    expect(entry).toBe("Planned the Project.\nNext Actions: Call the plumber\nSub-projects: Demolish\nSomeday: Sauna\nDropped ideas: Gold taps");
  });

  it("puts a Project's Purpose before its Desired outcome, and rewrites it in place later", () => {
    const note = "# Bathroom\n\n## Desired outcome\n\nA new bathroom.\n\n## Notes\n";
    const first = setMarkdownSectionBefore(note, "Purpose", "Less mould.", "Desired outcome");
    expect(first).toBe("# Bathroom\n\n## Purpose\n\nLess mould.\n\n## Desired outcome\n\nA new bathroom.\n\n## Notes\n");
    expect(setMarkdownSectionBefore(first, "Purpose", "Healthier air.", "Desired outcome"))
      .toBe("# Bathroom\n\n## Purpose\n\nHealthier air.\n\n## Desired outcome\n\nA new bathroom.\n\n## Notes\n");
    expect(setMarkdownSectionBefore("# Old\n", "Purpose", "Why.", "Desired outcome")).toBe("# Old\n\n## Purpose\n\nWhy.\n");
  });
});
