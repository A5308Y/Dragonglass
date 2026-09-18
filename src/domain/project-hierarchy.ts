import type { Project } from "./types";

export function projectBreadcrumb(project: Project, projectsById: ReadonlyMap<string, Project>): string {
  const titles: string[] = [];
  const seen = new Set<string>();
  let current: Project | undefined = project;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    titles.unshift(current.title);
    current = current.parentProjectId ? projectsById.get(current.parentProjectId) : undefined;
  }
  if (current) titles.unshift("…");
  return titles.join(" > ");
}

export function projectBreadcrumbs(projects: readonly Project[]): Map<string, string> {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  return new Map(projects.map((project) => [project.id, projectBreadcrumb(project, projectsById)]));
}

export function projectDescendantIds(projectId: string, projects: readonly Project[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.parentProjectId) continue;
    const ids = children.get(project.parentProjectId) ?? [];
    ids.push(project.id);
    children.set(project.parentProjectId, ids);
  }
  const descendants = new Set<string>();
  const pending = [...(children.get(projectId) ?? [])];
  while (pending.length) {
    const id = pending.pop()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return descendants;
}

export function projectHierarchyIssue(project: Project, projectsById: ReadonlyMap<string, Project>): string | undefined {
  if (!project.parentProjectId) return undefined;
  if (!projectsById.has(project.parentProjectId)) return `Missing parent Project '${project.parentProjectId}'`;
  const seen = new Set([project.id]);
  let currentId: string | undefined = project.parentProjectId;
  while (currentId) {
    if (seen.has(currentId)) return "Project hierarchy contains a cycle";
    seen.add(currentId);
    currentId = projectsById.get(currentId)?.parentProjectId;
  }
  return undefined;
}

export function wouldCreateProjectCycle(projectId: string, parentProjectId: string, projectsById: ReadonlyMap<string, Project>): boolean {
  const seen = new Set<string>();
  let currentId: string | undefined = parentProjectId;
  while (currentId) {
    if (currentId === projectId || seen.has(currentId)) return true;
    seen.add(currentId);
    currentId = projectsById.get(currentId)?.parentProjectId;
  }
  return false;
}
