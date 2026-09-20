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

/**
 * Counts Active descendants for every Project, at any depth.
 * Walking up from each Active Project credits all of its ancestors in a single pass.
 */
export function activeDescendantCounts(projects: readonly Project[]): Map<string, number> {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const counts = new Map<string, number>();
  for (const project of projects) {
    if (project.status !== "active") continue;
    const seen = new Set([project.id]);
    let ancestorId = project.parentProjectId;
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      counts.set(ancestorId, (counts.get(ancestorId) ?? 0) + 1);
      ancestorId = projectsById.get(ancestorId)?.parentProjectId;
    }
  }
  return counts;
}

/** The separator a breadcrumb uses, and so the one a typed Project path uses. */
export const PROJECT_PATH_SEPARATOR = ">";

export interface ProjectPath {
  /** The existing Project a newly named one would be created under. */
  parentId?: string;
  /** That parent's breadcrumb, for telling the reader where the Project will land. */
  parentBreadcrumb?: string;
  /** The title to create, with any resolved parent path stripped. */
  title: string;
}

/**
 * Reads a typed Project name as a path into the hierarchy, so `Heating > Heat pump` names a new
 * sub-project of an existing `Heating`.
 *
 * Only the segment after the final separator is ever created. An unresolvable prefix stays part
 * of the title, because inventing an unasked-for parent is worse than one oddly named Project.
 */
export function parseProjectPath(query: string, projects: readonly Project[]): ProjectPath {
  const title = query.trim();
  const separator = title.lastIndexOf(PROJECT_PATH_SEPARATOR);
  if (separator < 0) return { title };

  const prefix = title.slice(0, separator).trim();
  const leaf = title.slice(separator + PROJECT_PATH_SEPARATOR.length).trim();
  if (!prefix || !leaf) return { title };

  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const normalized = prefix.toLocaleLowerCase();
  const breadcrumbs = new Map(projects.map((project) => [project.id, projectBreadcrumb(project, projectsById)]));
  const byBreadcrumb = projects.find((project) => breadcrumbs.get(project.id)?.toLocaleLowerCase() === normalized);
  // A bare title only resolves when it is unambiguous; two "Heating" Projects name no parent.
  const byTitle = projects.filter((project) => project.title.toLocaleLowerCase() === normalized);
  const parent = byBreadcrumb ?? (byTitle.length === 1 ? byTitle[0] : undefined);
  if (!parent) return { title };

  return { parentId: parent.id, parentBreadcrumb: breadcrumbs.get(parent.id) ?? parent.title, title: leaf };
}
