/**
 * The rule that keeps Project trees consistent: an Active Project's parent, and
 * every Project above it, is Active too. So nothing below a Backlog, Someday/Maybe,
 * Completed or Cancelled Project is Active.
 *
 * Activating a sub-project activates its parents; a parent cannot be parked or
 * cancelled while it has Active sub-projects, nor completed while any sub-project
 * is still Active or in the Backlog. The repository enforces this on every write;
 * the views ask first where a choice is involved, such as reopening a finished
 * parent.
 */

import type { Project, ProjectStatus } from "./types";

const STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active",
  backlog: "Backlog",
  someday: "Someday/Maybe",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function projectStatusLabel(status: ProjectStatus): string {
  return STATUS_LABELS[status];
}

/** A Project's parent, grandparent and so on, nearest first. Stops at a cycle or a missing parent. */
export function projectAncestors(parentId: string | undefined, projectsById: ReadonlyMap<string, Project>): Project[] {
  const ancestors: Project[] = [];
  const seen = new Set<string>();
  let current = parentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = projectsById.get(current);
    if (!parent) break;
    ancestors.push(parent);
    current = parent.parentProjectId;
  }
  return ancestors;
}

/**
 * The Projects above a would-be Active Project that must become Active with it,
 * topmost first, so that each is written after its own parent.
 */
export function ancestorsToActivate(parentId: string | undefined, projectsById: ReadonlyMap<string, Project>): Project[] {
  return projectAncestors(parentId, projectsById).filter((ancestor) => ancestor.status !== "active").reverse();
}

/** Those of `ancestorsToActivate` that are finished, which only a deliberate reopen may activate. */
export function finishedAncestors(parentId: string | undefined, projectsById: ReadonlyMap<string, Project>): Project[] {
  return ancestorsToActivate(parentId, projectsById)
    .filter((ancestor) => ancestor.status === "completed" || ancestor.status === "cancelled");
}

/** Every Project below this one, at any depth. */
export function projectDescendants(projectId: string, projects: readonly Project[]): Project[] {
  const children = new Map<string, Project[]>();
  for (const project of projects) {
    if (!project.parentProjectId) continue;
    const siblings = children.get(project.parentProjectId) ?? [];
    siblings.push(project);
    children.set(project.parentProjectId, siblings);
  }
  const found: Project[] = [];
  const seen = new Set([projectId]);
  const pending = [...(children.get(projectId) ?? [])];
  while (pending.length) {
    const next = pending.shift()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    found.push(next);
    pending.push(...(children.get(next.id) ?? []));
  }
  return found;
}

/**
 * Why a Project may not move to `status`, or `undefined` when it may. Parking or
 * cancelling needs every sub-project inactive; completing also needs none left in
 * the Backlog, so nothing committed to is left behind.
 */
export function statusChangeProblem(project: Project, status: ProjectStatus, projects: readonly Project[]): string | undefined {
  if (status === project.status || status === "active") return undefined;
  const descendants = projectDescendants(project.id, projects);
  if (status === "completed") {
    const unfinished = descendants.filter((child) => child.status === "active" || child.status === "backlog");
    if (unfinished.length) {
      return `“${project.title}” still has unfinished sub-projects: ${describe(unfinished)}. `
        + "Complete or cancel them, or move them to Someday/Maybe, first.";
    }
    return undefined;
  }
  const active = descendants.filter((child) => child.status === "active");
  if (active.length) {
    const verb = status === "cancelled" ? "cancelled" : `moved to ${projectStatusLabel(status)}`;
    return `“${project.title}” cannot be ${verb} while it has Active sub-projects: ${describe(active)}. `
      + "Complete, cancel or park them first.";
  }
  return undefined;
}

/**
 * Active Projects below an inactive one, which break the rule: written before it
 * was enforced, or by hand. They count as parked until someone fixes the tree.
 */
export function strandedProjects(projects: readonly Project[]): Array<{ project: Project; inactiveAncestor: Project }> {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return projects.flatMap((project) => {
    if (project.status !== "active") return [];
    const inactiveAncestor = projectAncestors(project.parentProjectId, byId).find((ancestor) => ancestor.status !== "active");
    return inactiveAncestor ? [{ project, inactiveAncestor }] : [];
  });
}

function describe(projects: readonly Project[]): string {
  return projects.map((project) => `${project.title} (${projectStatusLabel(project.status)})`).join(", ");
}

/**
 * A setting kept per Project and inherited by its sub-projects (a mite project, a code
 * repository): the value set on the Project itself or on the nearest Project above it.
 */
export function nearestMapped<T>(
  projectId: string,
  projects: readonly Project[],
  values: Readonly<Record<string, T>>,
): { projectId: string; value: T } | null {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const visited = new Set<string>();
  let current: string | undefined = projectId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const value = values[current];
    if (value !== undefined) return { projectId: current, value };
    current = byId.get(current)?.parentProjectId;
  }
  return null;
}
