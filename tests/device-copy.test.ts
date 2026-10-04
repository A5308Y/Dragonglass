import { describe, expect, it } from "vitest";
import {
  fileListDifferences, iCloudPlaceholderTarget, isGtdNote, newestChange, propertyDifferences,
} from "../src/domain/device-copy";

describe("checking this device's copy", () => {
  it("names each property Obsidian shows differently from the file", () => {
    expect(propertyDifferences(
      { type: "gtd-project", id: "p1", status: "active", tags: ["a"] },
      { type: "gtd-project", id: "p1", status: "completed", completed: "2026-10-02", tags: ["a"] },
    )).toEqual([
      { key: "completed", shown: "(none)", file: "2026-10-02" },
      { key: "status", shown: "active", file: "completed" },
    ]);
  });

  it("finds a note that became a Project only in the file, and ignores other notes", () => {
    expect(propertyDifferences(undefined, { type: "gtd-project", id: "p1" }).map((d) => d.key)).toEqual(["id", "type"]);
    expect(propertyDifferences({ tags: ["x"] }, { tags: ["y"] })).toEqual([]);
    expect(isGtdNote({ type: "gtd-action" })).toBe(true);
    expect(isGtdNote({ type: "note" })).toBe(false);
  });

  it("knows which note an iCloud placeholder stands for", () => {
    expect(iCloudPlaceholderTarget("GTD/Projects/.Bathroom.md.icloud")).toBe("GTD/Projects/Bathroom.md");
    expect(iCloudPlaceholderTarget(".Top.md.icloud")).toBe("Top.md");
    expect(iCloudPlaceholderTarget("GTD/Projects/Bathroom.md")).toBeNull();
  });

  it("lists files Obsidian missed and files it lists that are gone", () => {
    expect(fileListDifferences(["a.md", "b.md"], ["b.md", "c.md"])).toEqual({ unnoticed: ["c.md"], gone: ["a.md"] });
  });

  it("picks the newest change", () => {
    expect(newestChange([{ path: "a", modified: 1 }, { path: "b", modified: 3 }, { path: "c", modified: 2 }])?.path).toBe("b");
    expect(newestChange([])).toBeNull();
  });
});
