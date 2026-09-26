import { wouldCreateProjectCycle } from "./project-hierarchy";
import { projectReviewMembers, projectsBlockingReview } from "./project-review";
import { strandedProjects } from "./project-tree";
import { ranksForOrder } from "./ranking";
import type { Action, Project, ProjectStatus } from "./types";
import { normalizeVaultPath } from "../utils/path";

/**
 * The Action-health issue shown on a Project's card and detail view, using the same
 * tree-level gate as Project Review, and naming the Projects that need an Action so
 * the way to them is clear: "No open Actions" for the Project itself, "No open
 * Actions in sub-project: Order materials" or "No open Actions in 2 sub-projects: A, B".
 * A Project is never both: one with an Active sub-project leaves its Actions to it.
 *
 * Only Active Projects report: nothing below an inactive Project needs an Action.
 * An Active sub-project on the way down reports too, so the cards lead to the Project.
 */
export function projectActionIssue(
  project: Project,
  projects: readonly Project[],
  actions: readonly Action[],
): string | null {
  if (project.status !== "active") return null;
  // A stranded Project, Active below an inactive one, counts as parked; the index reports it.
  if (strandedProjects(projects).some((entry) => entry.project.id === project.id)) return null;
  // Every open Action status keeps a Project moving, so a blocker has none left.
  const blockers = projectsBlockingReview(project, projectReviewMembers(project, projects), actions);
  if (!blockers.length) return null;
  const others = blockers.filter((blocker) => blocker.id !== project.id).map((blocker) => blocker.title);
  if (!others.length) return "No open Actions";
  return others.length === 1
    ? `No open Actions in sub-project: ${others[0]}`
    : `No open Actions in ${others.length} sub-projects: ${others.join(", ")}`;
}

/** Whether a file or folder belongs anywhere in a Project's full support-material subtree. */
export function isProjectSupportMaterialPath(path: string, supportPath: string): boolean {
  const candidate = normalizeVaultPath(path);
  const root = normalizeVaultPath(supportPath);
  return Boolean(root && candidate.startsWith(`${root}/`));
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

/**
 * The placements that move a Project into a status column before `beforeId`, or to
 * its end. Only what changes is returned: the moved Project, plus a sibling only when
 * no rank is left between its new neighbours. Leaving a column needs no renumbering.
 */
export function projectPlacementsAfterMove(
  projects: readonly Project[],
  projectId: string,
  targetStatus: ProjectStatus,
  beforeId?: string,
): Map<string, ProjectPlacement> {
  const moving = projects.find((project) => project.id === projectId);
  // Dropped onto itself: it is already where it was asked to go.
  if (!moving || (beforeId === projectId && moving.status === targetStatus)) return new Map();

  const target = projects
    .filter((project) => project.status === targetStatus && project.id !== projectId)
    .sort(compareProjectPriority);
  const requestedIndex = beforeId ? target.findIndex((project) => project.id === beforeId) : target.length;
  target.splice(requestedIndex < 0 ? target.length : requestedIndex, 0, moving);

  // The moved Project always takes a fresh rank, so its neighbours keep theirs.
  const ranks = ranksForOrder(target.map((project) =>
    project.id === projectId || project.order === undefined ? { id: project.id } : { id: project.id, rank: project.order }
  ));
  return new Map([...ranks].map(([id, order]) => [id, { status: targetStatus, order }]));
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

export interface ProjectCompletionPlan {
  /** Active and Backlog sub-projects: planned work the parent's outcome still depends on. */
  unfinished: Project[];
  /** Someday/Maybe sub-projects: optional ideas that can be cancelled along with the parent. */
  optional: Project[];
}

/** What completing a Project would leave behind among its direct sub-projects. */
export function planProjectCompletion(projectId: string, projects: readonly Project[]): ProjectCompletionPlan {
  const children = projects
    .filter((project) => project.parentProjectId === projectId)
    .sort(compareProjectPriority);
  return {
    unfinished: children.filter((child) => child.status === "active" || child.status === "backlog"),
    optional: children.filter((child) => child.status === "someday"),
  };
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
