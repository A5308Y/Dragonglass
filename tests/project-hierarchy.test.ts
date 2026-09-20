import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import type { Project } from "../src/domain/types";
import {
  activeDescendantCounts,
  parseProjectPath,
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

describe("Active sub-project counts", () => {
  const at = (id: string, status: Project["status"], parentProjectId?: string): Project => ({
    type: "gtd-project",
    id,
    title: id,
    status,
    created: "2026-09-18",
    file: file(`${id}.md`),
    ...(parentProjectId ? { parentProjectId } : {}),
  });

  it("counts Active descendants at every depth", () => {
    const counts = activeDescendantCounts([
      at("P1", "active"),
      at("P2", "active", "P1"),
      at("P3", "active", "P2"),
      at("P4", "active", "P3"),
    ]);

    expect([...counts]).toEqual([["P1", 3], ["P2", 2], ["P3", 1]]);
  });

  it("skips descendants that are not Active without hiding the Active ones beneath them", () => {
    const counts = activeDescendantCounts([
      at("P1", "active"),
      at("P2", "completed", "P1"),
      at("P3", "active", "P2"),
      at("P4", "someday", "P1"),
      at("P5", "backlog", "P1"),
    ]);

    // P3 still counts for P1 even though its own parent is Done.
    expect(counts.get("P1")).toBe(1);
    expect(counts.get("P2")).toBe(1);
    expect(counts.has("P4")).toBe(false);
  });

  it("survives a hierarchy cycle", () => {
    const counts = activeDescendantCounts([at("P1", "active", "P2"), at("P2", "active", "P1")]);

    expect([...counts]).toEqual([["P2", 1], ["P1", 1]]);
  });
});

describe("Typed Project paths", () => {
  const named = (id: string, title: string, parentProjectId?: string): Project => ({
    type: "gtd-project",
    id,
    title,
    status: "active",
    created: "2026-09-18",
    file: file(`${id}.md`),
    ...(parentProjectId ? { parentProjectId } : {}),
  });
  const house = named("P1", "House");
  const heating = named("P2", "Heating", "P1");
  const all = [house, heating];

  it("leaves a plain name alone", () => {
    expect(parseProjectPath("Heat pump", all)).toEqual({ title: "Heat pump" });
  });

  it("nests under a parent named by its full breadcrumb", () => {
    expect(parseProjectPath("House > Heating > Heat pump", all))
      .toEqual({ parentId: "P2", parentBreadcrumb: "House > Heating", title: "Heat pump" });
  });

  it("nests under a parent named by its bare title", () => {
    expect(parseProjectPath("heating > Heat pump", all))
      .toEqual({ parentId: "P2", parentBreadcrumb: "House > Heating", title: "Heat pump" });
  });

  it("keeps an unresolvable prefix in the title rather than inventing a parent", () => {
    expect(parseProjectPath("Nonsense > Heat pump", all)).toEqual({ title: "Nonsense > Heat pump" });
    // Only the final segment is ever created, so a missing middle resolves nothing.
    expect(parseProjectPath("House > Missing > Heat pump", all)).toEqual({ title: "House > Missing > Heat pump" });
  });

  it("refuses a bare title carried by two Projects", () => {
    const elsewhere = [named("P3", "Garden"), named("P4", "Heating", "P3")];
    expect(parseProjectPath("Heating > Heat pump", [...all, ...elsewhere])).toEqual({ title: "Heating > Heat pump" });
  });

  it("prefers the Project whose whole breadcrumb was typed", () => {
    // A top-level "Heating" is named exactly by "Heating", so a nested namesake does not blur it.
    const topLevel = named("P3", "Heating");
    expect(parseProjectPath("Heating > Heat pump", [...all, topLevel]))
      .toEqual({ parentId: "P3", parentBreadcrumb: "Heating", title: "Heat pump" });
  });

  it("ignores a separator with nothing on one side", () => {
    expect(parseProjectPath("Heating >", all)).toEqual({ title: "Heating >" });
    expect(parseProjectPath("> Heat pump", all)).toEqual({ title: "> Heat pump" });
  });
});
