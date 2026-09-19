import { Notice } from "obsidian";
import type { GtdServices } from "./services";

/**
 * Confirms and trashes a Project, with the counts of what goes with it.
 * Returns true only when the Project was deleted.
 */
export async function confirmDeleteProject(services: GtdServices, projectId: string): Promise<boolean> {
  const snapshot = services.repository.index.getSnapshot();
  const project = snapshot.projectsById.get(projectId);
  if (!project) {
    new Notice("This Project no longer exists.");
    return false;
  }

  const children = snapshot.projects.filter((candidate) => candidate.parentProjectId === project.id);
  if (children.length) {
    new Notice(`Move or delete ${children.length} sub-project${children.length === 1 ? "" : "s"} first.`);
    return false;
  }

  const linkedActions = snapshot.actions.filter((action) => action.projectId === project.id).length;
  const supportFiles = services.repository.supportFiles(project).length;
  const supportDescription = project.supportPath
    ? `${supportFiles} support file${supportFiles === 1 ? "" : "s"} in “${project.supportPath}”`
    : "no configured support folder";
  const confirmed = window.confirm(
    `Delete “${project.title}”?\n\nThis moves the Project note, ${linkedActions} directly linked Action${linkedActions === 1 ? "" : "s"}, and ${supportDescription} to Obsidian's trash.`,
  );
  if (!confirmed) return false;

  try {
    await services.repository.trashProject(project.id);
    new Notice(`Deleted Project, ${linkedActions} Action${linkedActions === 1 ? "" : "s"}, and its support material.`);
    return true;
  } catch (error) {
    new Notice(error instanceof Error ? error.message : "Could not delete the Project.");
    return false;
  }
}
