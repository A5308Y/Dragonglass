import { describe, expect, it } from "vitest";
import { inboxPrimaryDisposition, inboxProcessingPrefill } from "../src/domain/inbox-processing";

describe("Inbox processing prefill", () => {
  it("keeps short titles unchanged", () => {
    expect(inboxProcessingPrefill("Arrange the planning workshop")).toBe("Arrange the planning workshop");
  });

  it("limits long titles to the first 50 characters", () => {
    const title = "Plan and facilitate the quarterly strategy workshop with the whole team";
    expect(inboxProcessingPrefill(title)).toBe(Array.from(title).slice(0, 50).join(""));
    expect(Array.from(inboxProcessingPrefill(title))).toHaveLength(50);
  });

  it("does not split characters represented by surrogate pairs", () => {
    const title = `${"A".repeat(49)}🐉extra`;
    expect(inboxProcessingPrefill(title)).toBe(`${"A".repeat(49)}🐉`);
  });
});

describe("Primary processing disposition", () => {
  const disposition = (changes: Partial<Parameters<typeof inboxPrimaryDisposition>[0]> = {}) =>
    inboxPrimaryDisposition({
      fileOriginal: false,
      projectName: "",
      projectExists: false,
      nextAction: "",
      context: "",
      ...changes,
    });

  it("creates an Action, consuming the capture, when filing is off", () => {
    expect(disposition({ nextAction: "Call the plumber", context: "Calls" }))
      .toEqual({ operation: "next-action", label: "Create Next Action", ready: true });
  });

  it("names the Project it will create or reuse", () => {
    expect(disposition({ projectName: "Heating" }).label).toBe("Create Project + Next Action");
    expect(disposition({ projectName: "Heating", projectExists: true }).label).toBe("Create Next Action in Heating");
  });

  it("needs a Next Action and a context before it will create one", () => {
    expect(disposition({ nextAction: "Call the plumber" }).ready).toBe(false);
    expect(disposition({ context: "Calls" }).ready).toBe(false);
  });

  it("files the capture instead once filing is on, with no Next Action required", () => {
    expect(disposition({ fileOriginal: true }))
      .toEqual({ operation: "file", label: "File as General Reference", ready: true });
    expect(disposition({ fileOriginal: true, projectName: "Heating" }).label).toBe("File with Heating");
  });

  it("still files and creates an Action together", () => {
    expect(disposition({ fileOriginal: true, projectName: "Heating", nextAction: "Call the plumber", context: "Calls" }))
      .toEqual({ operation: "file", label: "File with Heating + Next Action", ready: true });
  });

  it("holds back a filed Next Action that has no context", () => {
    expect(disposition({ fileOriginal: true, nextAction: "Call the plumber" }).ready).toBe(false);
  });
});
