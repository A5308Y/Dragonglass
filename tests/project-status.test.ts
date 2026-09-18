import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { PROJECT_STATUSES } from "../src/domain/types";
import { isProjectStatus, parseProject } from "../src/domain/validation";

const file = { path: "GTD/Projects/Legacy.md" } as TFile;

describe("Project statuses", () => {
  it("does not expose Waiting as a supported Project status", () => {
    expect(PROJECT_STATUSES).toEqual(["active", "backlog", "someday", "completed", "cancelled"]);
    expect(isProjectStatus("backlog")).toBe(true);
    expect(isProjectStatus("waiting")).toBe(false);
  });

  it("temporarily reads a legacy Waiting Project as Active during migration", () => {
    const project = parseProject({
      type: "gtd-project",
      id: "01KLEGACYPROJECT",
      title: "Legacy Project",
      status: "waiting",
      created: "2026-09-18",
    }, file);

    expect(project.status).toBe("active");
  });
});
