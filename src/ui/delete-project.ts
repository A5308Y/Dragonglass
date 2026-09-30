import { Notice } from "obsidian";
import { confirmDialog } from "./confirm";
import { planProjectDeletion } from "../domain/project-board";
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
  const confirmed = await confirmDialog(services.app, {
    title: `Delete “${project.title}”?`,
    message: `This moves the Project note, ${linkedActions} directly linked Action${linkedActions === 1 ? "" : "s"}, and ${supportDescription} to Obsidian's trash.`
      + (project.linkedFiles?.length
        ? ` Its ${project.linkedFiles.length} linked file${project.linkedFiles.length === 1 ? "" : "s"} stay${project.linkedFiles.length === 1 ? "s" : ""} where ${project.linkedFiles.length === 1 ? "it is" : "they are"}.`
        : ""),
    confirmText: "Delete Project",
    warning: true,
  });
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

/**
 * Confirms and trashes a batch of Projects, deepest sub-projects first.
 * Returns how many Projects were deleted.
 */
export async function confirmDeleteProjects(services: GtdServices, projectIds: readonly string[]): Promise<number> {
  const snapshot = services.repository.index.getSnapshot();
  const plan = planProjectDeletion(projectIds, snapshot.projects);
  if (!plan.order.length) {
    new Notice(plan.blocked.length
      ? "Select the sub-projects as well, or move them first."
      : "These Projects no longer exist.");
    return 0;
  }

  const deleting = new Set(plan.order);
  const projects = plan.order.map((id) => snapshot.projectsById.get(id)!);
  const linkedActions = snapshot.actions.filter((action) => action.projectId && deleting.has(action.projectId)).length;
  const supportFiles = projects.reduce((count, project) => count + services.repository.supportFiles(project).length, 0);
  const titles = projects.map((project) => project.title).sort((left, right) => left.localeCompare(right));
  const listed = titles.slice(0, 12).map((title) => `• ${title}`);
  if (titles.length > listed.length) listed.push(`• …and ${titles.length - listed.length} more`);
  const skipped = plan.blocked.length
    ? `\n\nSkipping ${plan.blocked.length} Project${plan.blocked.length === 1 ? "" : "s"} that still ha${plan.blocked.length === 1 ? "s" : "ve"} sub-projects outside the selection.`
    : "";
  const confirmed = await confirmDialog(services.app, {
    title: `Delete ${plan.order.length} Project${plan.order.length === 1 ? "" : "s"}?`,
    message: `This moves the Project notes, ${linkedActions} directly linked Action${linkedActions === 1 ? "" : "s"}, `
      + `and ${supportFiles} support file${supportFiles === 1 ? "" : "s"} to Obsidian's trash.${skipped}\n\n`
      + listed.join("\n"),
    confirmText: `Delete ${plan.order.length} Project${plan.order.length === 1 ? "" : "s"}`,
    warning: true,
  });
  if (!confirmed) return 0;

  let deleted = 0;
  const failures: string[] = [];
  for (const project of projects) {
    try {
      await services.repository.trashProject(project.id);
      deleted += 1;
      // A parent can only follow once the index has forgotten the child it just lost.
      await waitForProjectRemoval(services, project.id);
    } catch (error) {
      failures.push(`${project.title}: ${error instanceof Error ? error.message : "could not be deleted"}`);
    }
  }
  new Notice(failures.length
    ? `Deleted ${deleted} Project${deleted === 1 ? "" : "s"}. ${failures.length} failed — ${failures[0]}`
    : `Deleted ${deleted} Project${deleted === 1 ? "" : "s"}, ${linkedActions} Action${linkedActions === 1 ? "" : "s"}, and their support material.`);
  return deleted;
}

function waitForProjectRemoval(services: GtdServices, id: string): Promise<void> {
  const gone = () => !services.repository.index.getSnapshot().projectsById.has(id);
  if (gone()) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {};
    const timeout = window.setTimeout(() => { unsubscribe(); resolve(); }, 1_500);
    unsubscribe = services.repository.index.subscribe(() => {
      if (!gone()) return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve();
    }, "Project deletion");
  });
}
