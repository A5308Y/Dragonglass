import { describe, expect, it } from "vitest";
import { inboxCreatedTime, inboxPrimaryDisposition, inboxProcessingPrefill } from "../src/domain/inbox-processing";

describe("Inbox processing prefill", () => {
  it("keeps short titles unchanged", () => {
    expect(inboxProcessingPrefill("Arrange the planning workshop")).toBe("Arrange the planning workshop");
  });

  it("limits long titles to the first 100 characters", () => {
    const title = "Plan and facilitate the quarterly strategy workshop with the whole team, including the board, two customers and the new hires";
    expect(inboxProcessingPrefill(title)).toBe(Array.from(title).slice(0, 100).join(""));
    expect(Array.from(inboxProcessingPrefill(title))).toHaveLength(100);
  });

  it("does not split characters represented by surrogate pairs", () => {
    const title = `${"A".repeat(99)}🐉extra`;
    expect(inboxProcessingPrefill(title)).toBe(`${"A".repeat(99)}🐉`);
  });
});

describe("Primary processing disposition", () => {
  const disposition = (changes: Partial<Parameters<typeof inboxPrimaryDisposition>[0]> = {}) =>
    inboxPrimaryDisposition({
      someday: false,
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

  it("parks the Project when Someday/Maybe is on, whatever filing says", () => {
    expect(disposition({ someday: true }))
      .toEqual({ operation: "someday", label: "Create Someday/Maybe Project", ready: true });
    expect(disposition({ someday: true, fileOriginal: true }).operation).toBe("someday");
    expect(disposition({ someday: true, projectName: "Heating", projectExists: true }).label)
      .toBe("Move Heating to Someday/Maybe");
  });

  it("names a Next Action parked alongside the Project", () => {
    expect(disposition({ someday: true, nextAction: "Call the plumber", context: "Calls" }).label)
      .toBe("Create Someday/Maybe Project + Next Action");
    expect(disposition({ someday: true, nextAction: "Call the plumber" }).ready).toBe(false);
  });
});

describe("Inbox capture time", () => {
  const at = (hours: number, minutes: number, day = 5) => new Date(2026, 9, day, hours, minutes);

  it("shows the local time an Item was captured", () => {
    expect(inboxCreatedTime({ created: "2026-10-05", createdAt: at(8, 4).toISOString() })).toBe("08:04");
  });

  it("falls back on the file's creation time for older Items, but only on the Item's own date", () => {
    expect(inboxCreatedTime({ created: "2026-10-05" }, at(14, 30).getTime())).toBe("14:30");
    expect(inboxCreatedTime({ created: "2026-10-05" }, at(14, 30, 7).getTime())).toBe("");
    expect(inboxCreatedTime({ created: "2026-10-05" })).toBe("");
  });
});
