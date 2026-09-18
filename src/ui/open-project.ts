import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
import type { Project } from "../domain/types";

export class OpenProjectModal extends FuzzySuggestModal<Project> {
  private readonly breadcrumbs: ReadonlyMap<string, string>;
  private readonly projects: Project[];

  constructor(app: App, projects: readonly Project[], private readonly choose: (project: Project) => void) {
    super(app);
    this.breadcrumbs = projectBreadcrumbs(projects);
    this.projects = [...projects].sort((left, right) => this.label(left).localeCompare(this.label(right)));
    this.limit = 50;
    this.setPlaceholder("Search Projects…");
  }

  getItems(): Project[] {
    return this.projects;
  }

  getItemText(project: Project): string {
    return [this.label(project), project.area, project.status, project.file.path].filter(Boolean).join(" ");
  }

  renderSuggestion(match: FuzzyMatch<Project>, el: HTMLElement): void {
    const project = match.item;
    el.addClass("dg-project-suggestion");
    el.createDiv({ cls: "dg-project-suggestion-title", text: this.label(project) });
    el.createDiv({
      cls: "dg-project-suggestion-meta",
      text: [projectStatusLabel(project.status), project.area, project.file.path].filter(Boolean).join(" · "),
    });
  }

  onChooseItem(project: Project): void {
    this.choose(project);
  }

  private label(project: Project): string {
    return this.breadcrumbs.get(project.id) ?? project.title;
  }
}

function projectStatusLabel(status: Project["status"]): string {
  if (status === "someday") return "Someday/Maybe";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
