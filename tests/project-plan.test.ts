import { describe, expect, it } from "vitest";
import { ideasFromText, openPlanIdeas, planNoteBody, tickPlanIdea } from "../src/domain/project-plan";
import { setMarkdownSectionBefore } from "../src/utils/markdown";

describe("Planning a Project", () => {
  it("turns brainstormed lines into ideas, without bullets, numbering or boxes", () => {
    expect(ideasFromText("- Find tiles\n2. Book plumber\n\n* [ ] Pick colour\n  Measure the room  ")).toEqual([
      "Find tiles", "Book plumber", "Pick colour", "Measure the room",
    ]);
  });

  it("writes the ideas as open boxes, and reads back the ones still open", () => {
    const body = planNoteBody("Plan - Bathroom", "2026-10-03", ["Find tiles", "Book plumber"]);
    expect(body).toBe("# Plan - Bathroom\n\n*2026-10-03*\n\n## Ideas\n\n- [ ] Find tiles\n- [ ] Book plumber\n");
    expect(openPlanIdeas(body)).toEqual(["Find tiles", "Book plumber"]);
  });

  it("ticks exactly the idea that was organised, and nothing when it is already gone", () => {
    const body = "## Ideas\n\n- [ ] Find tiles\n- [x] Old idea\n- [ ] Find tiles later\n";
    const ticked = tickPlanIdea(body, "Find tiles");
    expect(ticked).toBe("## Ideas\n\n- [x] Find tiles\n- [x] Old idea\n- [ ] Find tiles later\n");
    expect(openPlanIdeas(ticked)).toEqual(["Find tiles later"]);
    expect(tickPlanIdea(ticked, "Find tiles")).toBe(ticked);
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
