import { wouldCreateProjectCycle } from "./project-hierarchy";
import type { Action, Project, ProjectStatus } from "./types";

export type ProjectActionIssue = "No open Actions" | "No Next Action";

/** The single Action-health issue displayed on an Active Project card, if any. */
export function projectActionIssue(project: Project, actions: readonly Action[]): ProjectActionIssue | null {
  if (project.status !== "active") return null;
  const open = actions.filter((action) => action.status !== "done" && action.status !== "cancelled");
  if (!open.length) return "No open Actions";
  if (!open.some((action) => action.status === "next" || action.status === "scheduled" || action.status === "waiting")) {
    return "No Next Action";
  }
  return null;
}

export interface ProjectPlacement {
  status: ProjectStatus;
  order: number;
}

export function normalizeProjectTags(values: readonly string[]): string[] {
  const tags = new Map<string, string>();
  for (const value of values) {
    const tag = value.trim().replace(/^#+/, "");
    const key = tag.toLocaleLowerCase();
    if (tag && !tags.has(key)) tags.set(key, tag);
  }
  return [...tags.values()].sort((left, right) => left.localeCompare(right));
}

export function parseProjectTags(value: string): string[] {
  return normalizeProjectTags(value.split(","));
}

export function compareProjectPriority(left: Project, right: Project): number {
  if (left.order !== undefined && right.order !== undefined) {
    if (left.order !== right.order) return left.order - right.order;
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  }
  if (left.order !== undefined) return -1;
  if (right.order !== undefined) return 1;
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

export function projectPlacementsAfterMove(
  projects: readonly Project[],
  projectId: string,
  targetStatus: ProjectStatus,
  beforeId?: string,
): Map<string, ProjectPlacement> {
  const moving = projects.find((project) => project.id === projectId);
  if (!moving) return new Map();

  const sourceStatus = moving.status;
  const target = projects
    .filter((project) => project.status === targetStatus)
    .sort(compareProjectPriority);

  if (sourceStatus === targetStatus && beforeId === projectId) {
    return rankedPlacements(target, targetStatus);
  }

  const targetWithoutMoving = target.filter((project) => project.id !== projectId);
  const requestedIndex = beforeId
    ? targetWithoutMoving.findIndex((project) => project.id === beforeId)
    : targetWithoutMoving.length;
  const insertionIndex = requestedIndex < 0 ? targetWithoutMoving.length : requestedIndex;
  targetWithoutMoving.splice(insertionIndex, 0, moving);

  const placements = rankedPlacements(targetWithoutMoving, targetStatus);
  if (sourceStatus !== targetStatus) {
    const sourceWithoutMoving = projects
      .filter((project) => project.status === sourceStatus && project.id !== projectId)
      .sort(compareProjectPriority);
    for (const [id, placement] of rankedPlacements(sourceWithoutMoving, sourceStatus)) {
      placements.set(id, placement);
    }
  }
  return placements;
}

function rankedPlacements(projects: readonly Project[], status: ProjectStatus): Map<string, ProjectPlacement> {
  return new Map(projects.map((project, index) => [project.id, { status, order: (index + 1) * 1_000 }]));
}

export function wouldCreateProjectDependencyCycle(
  projectId: string,
  blockerIds: readonly string[],
  projectsById: ReadonlyMap<string, Project>,
): boolean {
  const pending = [...blockerIds];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === projectId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(projectsById.get(id)?.blockedByProjectIds ?? []));
  }
  return false;
}

export function activeProjectBlockers(project: Project, projectsById: ReadonlyMap<string, Project>): Project[] {
  return (project.blockedByProjectIds ?? [])
    .map((id) => projectsById.get(id))
    .filter((blocker): blocker is Project => Boolean(blocker && blocker.status !== "completed" && blocker.status !== "cancelled"));
}

export interface ProjectTagAdditions {
  /** Projects that gain at least one tag, mapped to their complete new tag list. */
  updates: Map<string, string[]>;
  /** Projects that already carried every tag. */
  unchanged: string[];
}

export function projectTagAdditions(projects: readonly Project[], tags: readonly string[]): ProjectTagAdditions {
  const added = normalizeProjectTags(tags);
  const updates = new Map<string, string[]>();
  const unchanged: string[] = [];
  for (const project of projects) {
    const current = normalizeProjectTags(project.tags ?? []);
    const next = normalizeProjectTags([...current, ...added]);
    if (next.length === current.length) unchanged.push(project.id);
    else updates.set(project.id, next);
  }
  return { updates, unchanged };
}

export interface ProjectParentPlan {
  /** Projects whose parent changes. */
  changing: string[];
  /** Projects already under that parent. */
  unchanged: string[];
  /** Projects skipped because the move would create a hierarchy cycle. */
  blocked: string[];
}

export function planProjectParentChange(
  projectIds: readonly string[],
  parentProjectId: string,
  projectsById: ReadonlyMap<string, Project>,
): ProjectParentPlan {
  const changing: string[] = [];
  const unchanged: string[] = [];
  const blocked: string[] = [];
  for (const id of projectIds) {
    const project = projectsById.get(id);
    if (!project) continue;
    if ((project.parentProjectId ?? "") === parentProjectId) unchanged.push(id);
    else if (parentProjectId && wouldCreateProjectCycle(id, parentProjectId, projectsById)) blocked.push(id);
    else changing.push(id);
  }
  return { changing, unchanged, blocked };
}

export interface ProjectDeletionPlan {
  /** Deletion order, deepest sub-projects first, so no Project outlives its children. */
  order: string[];
  /** Projects kept because they still have sub-projects outside the selection. */
  blocked: string[];
}

export function planProjectDeletion(projectIds: readonly string[], projects: readonly Project[]): ProjectDeletionPlan {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const childIds = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.parentProjectId) continue;
    const ids = childIds.get(project.parentProjectId) ?? [];
    ids.push(project.id);
    childIds.set(project.parentProjectId, ids);
  }
  const depth = (id: string): number => {
    const seen = new Set([id]);
    let count = 0;
    let current = projectsById.get(id)?.parentProjectId;
    while (current && !seen.has(current)) {
      seen.add(current);
      count += 1;
      current = projectsById.get(current)?.parentProjectId;
    }
    return count;
  };
  const candidates = [...new Set(projectIds)].filter((id) => projectsById.has(id));
  candidates.sort((left, right) => depth(right) - depth(left) || left.localeCompare(right));

  // Children sort ahead of their parents, so a parent already knows whether its whole subtree goes.
  const deletable = new Set<string>();
  const blocked: string[] = [];
  for (const id of candidates) {
    if ((childIds.get(id) ?? []).every((childId) => deletable.has(childId))) deletable.add(id);
    else blocked.push(id);
  }
  return { order: candidates.filter((id) => deletable.has(id)), blocked };
}

export interface ProjectSupportFolder {
  id: string;
  path: string;
}

/**
 * Counts support material per Project in one pass over the vault's file paths.
 * A file belongs to the Project whose support folder contains it most deeply, so a nested
 * Project's material never inflates its ancestor's count.
 */
export function projectSupportFileCounts(
  folders: readonly ProjectSupportFolder[],
  filePaths: Iterable<string>,
): Map<string, number> {
  const counts = new Map(folders.map((folder) => [folder.id, 0]));
  const owners = [...folders].sort((left, right) => right.path.length - left.path.length);
  if (!owners.length) return counts;

  for (const filePath of filePaths) {
    let deepest = 0;
    for (const owner of owners) {
      if (deepest && owner.path.length < deepest) break;
      if (filePath !== owner.path && !filePath.startsWith(`${owner.path}/`)) continue;
      deepest = owner.path.length;
      counts.set(owner.id, counts.get(owner.id)! + 1);
    }
  }
  return counts;
}
