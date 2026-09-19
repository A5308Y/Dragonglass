import { describe, expect, it } from "vitest";
import { inboxProcessingPrefill } from "../src/domain/inbox-processing";

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
