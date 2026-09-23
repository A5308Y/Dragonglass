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

  it("reads an optional main image from Project frontmatter", () => {
    const project = parseProject({
      type: "gtd-project",
      id: "01KIMAGEPROJECT",
      title: "Illustrated Project",
      status: "active",
      created: "2026-09-19",
      image: "Images/project.jpg",
    }, file);

    expect(project.image).toBe("Images/project.jpg");
  });

  it("reads linked files as the wikilinks written in linked_files", () => {
    const base = { type: "gtd-project", id: "01KLINKEDPROJECT", title: "Move flat", status: "active", created: "2026-09-19" };
    expect(parseProject({ ...base, linked_files: ["[[Contracts/Lease.pdf]]", "[[Notes/Landlord]]"] }, file).linkedFiles)
      .toEqual(["[[Contracts/Lease.pdf]]", "[[Notes/Landlord]]"]);
    expect(parseProject(base, file).linkedFiles).toBeUndefined();
    // Unquoted `- [[Notes/Landlord]]` is YAML for a list inside a list.
    expect(parseProject({ ...base, linked_files: [[["Notes/Landlord"]]] }, file).linkedFiles).toEqual(["[[Notes/Landlord]]"]);
  });

  it("reads Project board metadata from frontmatter", () => {
    const project = parseProject({
      type: "gtd-project",
      id: "01KBOARDPROJECT",
      title: "Sequenced Project",
      status: "active",
      created: "2026-09-19",
      tags: ["planning", "home"],
      order: 2_000,
      blocked_by_project_ids: ["P1", "P2"],
    }, file);

    expect(project.tags).toEqual(["home", "planning"]);
    expect(project.order).toBe(2_000);
    expect(project.blockedByProjectIds).toEqual(["P1", "P2"]);
  });

  it("reads and validates a scheduled activation date", () => {
    const project = parseProject({
      type: "gtd-project",
      id: "01KACTIVATEPROJECT",
      title: "Future Project",
      status: "someday",
      created: "2026-09-19",
      activate_at: "2026-10-01",
    }, file);

    expect(project.activateAt).toBe("2026-10-01");
    expect(() => parseProject({
      type: "gtd-project",
      id: "01KBADACTIVATION",
      title: "Bad date",
      status: "someday",
      created: "2026-09-19",
      activate_at: "2026-02-30",
    }, file)).toThrow("activate_at");
  });
});
