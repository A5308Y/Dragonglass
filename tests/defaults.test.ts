import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/state/defaults";

describe("Default settings", () => {
  it("shows every Project board column initially", () => {
    expect(defaultSettings().projectBoardColumns).toEqual(["active", "backlog", "someday", "completed"]);
  });
});
