import type { Project } from "./types";

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
  if (left.order !== undefined && right.order !== undefined && left.order !== right.order) return left.order - right.order;
  if (left.order !== undefined) return -1;
  if (right.order !== undefined) return 1;
  return left.title.localeCompare(right.title);
}

export function priorityOrderBefore(projects: readonly Project[], beforeId?: string): number {
  const ordered = [...projects].sort(compareProjectPriority);
  if (!ordered.length) return 1_000;
  const maxStored = Math.max(0, ...ordered.flatMap((project) => project.order === undefined ? [] : [project.order]));
  const fallbackStart = maxStored + 1_000;
  const effective = ordered.map((project, index) => project.order ?? fallbackStart + index * 1_000);
  const nextIndex = beforeId ? ordered.findIndex((project) => project.id === beforeId) : ordered.length;
  if (nextIndex <= 0) return effective[0]! - 1_000;
  if (nextIndex >= ordered.length) return effective[effective.length - 1]! + 1_000;
  return (effective[nextIndex - 1]! + effective[nextIndex]!) / 2;
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
