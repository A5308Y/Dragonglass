import { projectPlacementsAfterMove } from "../domain/project-board";
import type { Project } from "../domain/types";
import { confirmCompleteProject } from "./complete-project";
import type { GtdServices } from "./services";
import { showUndoNotice } from "./undo";

/**
 * Changes a Project's status the way every surface should: completing one with
 * open sub-projects asks first, and cancelling one offers Undo, since Cancelled
 * Projects leave every board.
 */
export async function setProjectStatus(services: GtdServices, projectId: string, status: Project["status"]): Promise<void> {
  if (status === "completed" && !await confirmCompleteProject(services, projectId)) return;
  const before = services.repository.index.getSnapshot().projectsById.get(projectId);
  await services.repository.setProjectStatus(projectId, status);
  if (status === "cancelled" && before && before.status !== "cancelled") offerRestore(services, before, "Cancelled");
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
  const siblings = snapshot.projects.filter((project) => project.parentProjectId === moving.parentProjectId);
  const placements = projectPlacementsAfterMove(siblings, projectId, status, beforeId);
  await Promise.all([...placements].map(([id, placement]) => services.repository.updateProject(id, placement)));
  if (status === "cancelled" && moving.status !== "cancelled") offerRestore(services, moving, "Cancelled");
  // Completed Projects fold away, so a mis-ticked checkbox can be taken back.
  if (status === "completed" && moving.status !== "completed") offerRestore(services, moving, "Completed");
}

function offerRestore(services: GtdServices, before: Project, verb: string): void {
  showUndoNotice(`${verb} “${before.title}”.`, () => services.repository.updateProject(before.id, {
    status: before.status,
    activateAt: before.activateAt ?? "",
    ...(before.order === undefined ? {} : { order: before.order }),
  }));
}
