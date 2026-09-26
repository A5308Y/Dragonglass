import { projectPlacementsAfterMove } from "../domain/project-board";
import { ancestorsToActivate, finishedAncestors, projectStatusLabel } from "../domain/project-tree";
import type { Project, ProjectWriteOptions } from "../domain/types";
import { confirmCompleteProject } from "./complete-project";
import { confirmDialog } from "./confirm";
import type { GtdServices } from "./services";
import { showUndoNotice } from "./undo";

/**
 * Changes a Project's status the way every surface should: completing one checks
 * its sub-projects first, activating one activates the Projects above it (asking
 * before reopening a finished one), and cancelling or activating offers Undo.
 */
export async function setProjectStatus(services: GtdServices, projectId: string, status: Project["status"]): Promise<void> {
  if (status === "completed" && !await confirmCompleteProject(services, projectId)) return;
  const snapshot = services.repository.index.getSnapshot();
  const before = snapshot.projectsById.get(projectId);
  const activating = activatedAbove(services, before, status);
  const options = await activationOptions(services, before, status);
  if (!options) return;
  await services.repository.setProjectStatus(projectId, status, options);
  if (status === "cancelled" && before && before.status !== "cancelled") offerRestore(services, before, "Cancelled");
  if (before && activating.length) offerUndoActivation(services, before, activating);
}

/**
 * Moves a Project into a status column before `beforeId`, or to its end. Usually
 * only the moved Project's file is written; see `projectPlacementsAfterMove`.
 * Top-level Projects are siblings of each other.
 */
export async function moveProject(
  services: GtdServices,
  projectId: string,
  status: Project["status"],
  beforeId?: string,
): Promise<void> {
  if (status === "completed" && !await confirmCompleteProject(services, projectId)) return;
  const snapshot = services.repository.index.getSnapshot();
  const moving = snapshot.projectsById.get(projectId);
  if (!moving) throw new Error("This Project no longer exists.");
  const activating = activatedAbove(services, moving, status);
  const options = await activationOptions(services, moving, status);
  if (!options) return;
  const siblings = snapshot.projects.filter((project) => project.parentProjectId === moving.parentProjectId);
  const placements = projectPlacementsAfterMove(siblings, projectId, status, beforeId);
  await Promise.all([...placements].map(([id, placement]) => services.repository.updateProject(id, placement, options)));
  if (status === "cancelled" && moving.status !== "cancelled") offerRestore(services, moving, "Cancelled");
  // Completed Projects fold away, so a mis-ticked checkbox can be taken back.
  if (status === "completed" && moving.status !== "completed") offerRestore(services, moving, "Completed");
  if (activating.length) offerUndoActivation(services, moving, activating);
}

/**
 * The write options for a Project that may end up Active below `parentId`, asking
 * first when that reopens a Completed or Cancelled Project above it. `null` when
 * the person declines.
 */
export async function activationOptions(
  services: GtdServices,
  project: Project | undefined,
  status: Project["status"],
  parentId = project?.parentProjectId,
): Promise<ProjectWriteOptions | null> {
  if (!project || status !== "active") return {};
  const finished = finishedAncestors(parentId, services.repository.index.getSnapshot().projectsById);
  if (!finished.length) return {};
  const names = finished.map((item) => `“${item.title}” (${projectStatusLabel(item.status)})`).join(", ");
  const reopen = await confirmDialog(services.app, {
    title: "Reopen the Projects above?",
    message: `“${project.title}” can only be Active while every Project above it is Active.\n\nReopen ${names}?`,
    confirmText: "Reopen and activate",
  });
  return reopen ? { reopenAncestors: true } : null;
}

/** The Projects above that a change to Active will activate too. */
function activatedAbove(services: GtdServices, project: Project | undefined, status: Project["status"]): Project[] {
  if (!project || status !== "active" || project.status === "active") return [];
  return ancestorsToActivate(project.parentProjectId, services.repository.index.getSnapshot().projectsById);
}

/** One Undo takes back the whole activation: the Project first, then the Projects above it. */
function offerUndoActivation(services: GtdServices, before: Project, activated: readonly Project[]): void {
  const names = activated.map((project) => `“${project.title}”`).join(", ");
  showUndoNotice(`Activated “${before.title}” and above it ${names}.`, async () => {
    await restore(services, before);
    for (const project of [...activated].reverse()) await restore(services, project);
  });
}

function offerRestore(services: GtdServices, before: Project, verb: string): void {
  showUndoNotice(`${verb} “${before.title}”.`, () => restore(services, before));
}

function restore(services: GtdServices, before: Project): Promise<void> {
  return services.repository.updateProject(before.id, {
    status: before.status,
    activateAt: before.activateAt ?? "",
    ...(before.order === undefined ? {} : { order: before.order }),
  }, { restoring: true });
}
