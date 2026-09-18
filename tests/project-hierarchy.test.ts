import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Project } from "../src/domain/types";
import {
  projectBreadcrumb,
  projectBreadcrumbs,
  projectDescendantIds,
  projectHierarchyIssue,
  wouldCreateProjectCycle,
} from "../src/domain/project-hierarchy";
import { parseProject } from "../src/domain/validation";

const file = (path: string) => ({ path } as TFile);
const root: Project = { type: "gtd-project", id: "P1", title: "House", status: "active", created: "2026-09-18", file: file("House.md") };
const child: Project = { type: "gtd-project", id: "P2", title: "Heating", status: "active", created: "2026-09-18", file: file("Heating.md"), parentProjectId: "P1" };
const grandchild: Project = { type: "gtd-project", id: "P3", title: "Heat pump", status: "active", created: "2026-09-18", file: file("Heat pump.md"), parentProjectId: "P2" };
const projects = [root, child, grandchild];
const projectsById = new Map(projects.map((project) => [project.id, project]));

describe("Project hierarchy", () => {
  it("builds complete, searchable breadcrumbs", () => {
    expect(projectBreadcrumb(grandchild, projectsById)).toBe("House > Heating > Heat pump");
    expect(projectBreadcrumbs(projects).get("P2")).toBe("House > Heating");
  });

  it("finds descendants and rejects cyclic parenting", () => {
    expect([...projectDescendantIds("P1", projects)]).toEqual(expect.arrayContaining(["P2", "P3"]));
    expect(wouldCreateProjectCycle("P1", "P3", projectsById)).toBe(true);
    expect(wouldCreateProjectCycle("P3", "P1", projectsById)).toBe(false);
  });

  it("reports missing parents and cycles without making files unreadable", () => {
    const missing = { ...child, parentProjectId: "MISSING" };
    expect(projectHierarchyIssue(missing, new Map([[missing.id, missing]]))).toContain("Missing parent Project");

    const cyclicRoot = { ...root, parentProjectId: "P3" };
    const cyclicMap = new Map([[cyclicRoot.id, cyclicRoot], [child.id, child], [grandchild.id, grandchild]]);
    expect(projectHierarchyIssue(cyclicRoot, cyclicMap)).toBe("Project hierarchy contains a cycle");
  });

  it("reads stable parent IDs and convenience links from frontmatter", () => {
    const parsed = parseProject({
      type: "gtd-project",
      id: "P2",
      title: "Heating",
      status: "active",
      created: "2026-09-18",
      parent_project_id: "P1",
      parent_project: "[[House]]",
    }, file("Heating.md"));

    expect(parsed.parentProjectId).toBe("P1");
    expect(parsed.parentProjectLink).toBe("[[House]]");
  });
});
