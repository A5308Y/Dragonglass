import type { Action, GtdSnapshot, Project } from "./types";
import { projectDescendantIds } from "./project-hierarchy";

export function projectReviewMembers(root: Project, projects: readonly Project[]): Project[] {
  const ids = projectDescendantIds(root.id, projects);
  const children = new Map<string, Project[]>();
  for (const project of projects) {
    if (!project.parentProjectId || !ids.has(project.id)) continue;
    const siblings = children.get(project.parentProjectId) ?? [];
    siblings.push(project);
    children.set(project.parentProjectId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.title.localeCompare(right.title));

  const members: Project[] = [];
  const visited = new Set<string>();
  const visit = (project: Project) => {
    if (visited.has(project.id)) return;
    visited.add(project.id);
    members.push(project);
    for (const child of children.get(project.id) ?? []) visit(child);
  };
  visit(root);
  return members;
}

/**
 * Active Projects with nothing moving them forward. A Waiting Action counts: the
 * Project is still active, it is just blocked on someone else.
 */
export function activeProjectsWithoutNextAction(projects: readonly Project[], actions: readonly Action[]): Project[] {
  const nextProjectIds = new Set(actions
    .filter((action) => (action.status === "next" || action.status === "scheduled" || action.status === "waiting") && action.projectId)
    .map((action) => action.projectId!));
  return projects.filter((project) => project.status === "active" && !nextProjectIds.has(project.id));
}

/**
 * Active Projects that still block marking this review tree as reviewed.
 *
 * Every active sub-project needs a Next, Scheduled or Waiting Action. The root only
 * needs one itself when it has no active sub-projects to carry the work.
 * Returns the Projects to fix, empty when nothing blocks.
 */
export function projectsBlockingReview(root: Project, members: readonly Project[], actions: readonly Action[]): Project[] {
  const missing = activeProjectsWithoutNextAction(members, actions);
  const hasActiveSubprojects = members.some((project) => project.id !== root.id && project.status === "active");
  if (hasActiveSubprojects) return missing.filter((project) => project.id !== root.id);
  return missing;
}

export interface ProjectReviewHealth {
  /** Active Projects with no Next, Scheduled or Waiting Action. */
  needsAction: string[];
  /** For each review root, the Projects that stop its tree being marked reviewed. */
  blockers: Array<{ projectId: string; blockerIds: string[] }>;
}

/**
 * The health verdicts the Project Review shows, decided here so the Elm view
 * never re-implements what counts as a moving Action.
 */
export function projectReviewHealth(
  projects: readonly Project[],
  actions: readonly Action[],
  rootIds: readonly string[],
): ProjectReviewHealth {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return {
    needsAction: activeProjectsWithoutNextAction(projects, actions).map((project) => project.id),
    blockers: rootIds.flatMap((rootId) => {
      const root = byId.get(rootId);
      if (!root) return [];
      const blockerIds = projectsBlockingReview(root, projectReviewMembers(root, projects), actions).map((project) => project.id);
      return [{ projectId: root.id, blockerIds }];
    }),
  };
}

export function projectReviewQueue(snapshot: GtdSnapshot, today: string): string[] {
  const candidates = snapshot.projects.filter((project) => project.status === "active" && project.reviewed !== today);
  const roots = new Map<string, Project>();
  for (const candidate of candidates) {
    const root = topmostActiveAncestor(candidate, snapshot.projectsById);
    roots.set(root.id, root);
  }
  return [...roots.values()]
    .sort((left, right) => {
      const leftMembers = projectReviewMembers(left, snapshot.projects);
      const rightMembers = projectReviewMembers(right, snapshot.projects);
      const leftNeedsNext = activeProjectsWithoutNextAction(leftMembers, snapshot.actions).length > 0;
      const rightNeedsNext = activeProjectsWithoutNextAction(rightMembers, snapshot.actions).length > 0;
      if (leftNeedsNext !== rightNeedsNext) return leftNeedsNext ? -1 : 1;
      return left.title.localeCompare(right.title);
    })
    .map((project) => project.id);
}

function topmostActiveAncestor(project: Project, projectsById: ReadonlyMap<string, Project>): Project {
  const seen = new Set([project.id]);
  let root = project;
  let parentId = project.parentProjectId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = projectsById.get(parentId);
    if (!parent) break;
    if (parent.status === "active") root = parent;
    parentId = parent.parentProjectId;
  }
  return root;
}
