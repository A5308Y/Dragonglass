import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { projectsDueForActivation } from "../src/domain/project-activation";
import type { Project } from "../src/domain/types";

const file = { path: "Project.md" } as TFile;
const project = (id: string, changes: Partial<Project>): Project => ({
  type: "gtd-project",
  id,
  title: id,
  status: "someday",
  created: "2026-09-01",
  file,
  ...changes,
});

describe("scheduled Project activation", () => {
  it("selects Someday/Maybe Projects on or before today", () => {
    const projects = [
      project("past", { activateAt: "2026-09-19" }),
      project("today", { activateAt: "2026-09-20" }),
      project("future", { activateAt: "2026-09-21" }),
      project("active", { status: "active", activateAt: "2026-09-20" }),
      project("unscheduled", {}),
    ];

    expect(projectsDueForActivation(projects, "2026-09-20").map((candidate) => candidate.id))
      .toEqual(["past", "today"]);
  });
});
