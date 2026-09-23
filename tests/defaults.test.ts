import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/state/defaults";

describe("Default settings", () => {
  it("shows every Project board column initially", () => {
    expect(defaultSettings().projectBoardColumns).toEqual(["active", "backlog", "someday", "completed"]);
  });

  it("shows Project card images initially", () => {
    expect(defaultSettings().showProjectBoardImages).toBe(true);
  });

  it("does not group the Project board by area initially", () => {
    expect(defaultSettings().groupProjectBoardByArea).toBe(false);
  });
});
