import type { Project, ProjectStatus } from "./types";

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
