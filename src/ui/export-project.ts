import { Component, MarkdownRenderer, Modal, Notice, Platform, Setting, TFile, getFrontMatterInfo, normalizePath, type App } from "obsidian";
import {
  countTree, exportTree, projectExportHtml, type ExportNode, type ExportOptions, type ExportedProject,
} from "../domain/project-export";
import { plainTitle } from "../domain/text";
import type { GtdRepository } from "../repository/gtd-repository";
import { localDate } from "../utils/date";
import { normalizeVaultPath, safeName } from "../utils/path";

/** Elements a reader's copy has no use for, or that would load or run something. */
const DROPPED = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO", "SVG", "CANVAS", "BUTTON", "FORM", "TEXTAREA", "SELECT",
  "LINK", "META",
]);
/** The attributes kept; links only when they go to the web or to mail. */
const KEPT_ATTRIBUTES = new Set(["href", "colspan", "rowspan"]);

/**
 * Asks what to include, then writes a Project tree as one HTML file for someone to read,
 * into an `Exports` folder next to the Actions folder (`project-export.ts` decides the rest).
 */
export function exportProjectTree(app: App, repository: GtdRepository, projectId: string, actionsDirectory: string): void {
  const snapshot = repository.index.getSnapshot();
  const project = snapshot.projectsById.get(projectId);
  if (!project) throw new Error("This Project no longer exists.");
  const parent = normalizeVaultPath(actionsDirectory || "GTD/Actions").split("/").slice(0, -1).join("/");
  const folder = normalizePath(parent ? `${parent}/Exports` : "Exports");
  new ExportProjectModal(app, plainTitle(project.title), folder, (options) => exportTree(projectId, snapshot.projects, snapshot.actions, options),
    async (tree, withNotes) => {
      const path = normalizePath(`${folder}/${safeName(plainTitle(project.title))} - ${localDate()}.html`);
      const component = new Component();
      component.load();
      try {
        const notes = withNotes ? repository.supportFilesByProject(flatten(tree)) : new Map<string, TFile[]>();
        const page = await exportedProject(app, repository, tree, notes, component);
        await writeFile(app, folder, path, projectExportHtml(page, new Date().toLocaleDateString(undefined, { dateStyle: "long" })));
      } finally {
        component.unload();
      }
      const reveal = (app as unknown as { showInFolder?: (path: string) => void }).showInFolder;
      if (Platform.isDesktopApp && reveal) reveal.call(app, path);
      new Notice(Platform.isDesktopApp
        ? `Exported to ${path}.`
        : `Exported to ${path}. Share it from the Files app, in the vault folder.`);
    }).open();
}

function flatten(node: ExportNode): ExportNode["project"][] {
  return [node.project, ...node.children.flatMap(flatten)];
}

async function exportedProject(
  app: App,
  repository: GtdRepository,
  node: ExportNode,
  notes: ReadonlyMap<string, TFile[]>,
  component: Component,
): Promise<ExportedProject> {
  const { project } = node;
  const [purpose, desiredOutcome] = await Promise.all([repository.readProjectPurpose(project), repository.readDesiredOutcome(project)]);
  const noteFiles = (notes.get(project.id) ?? [])
    .filter((file) => file.extension === "md" && !String(app.metadataCache.getFileCache(file)?.frontmatter?.type ?? "").startsWith("gtd-"))
    .sort((left, right) => left.path.localeCompare(right.path));
  const renderedNotes = [];
  for (const file of noteFiles) {
    const content = await app.vault.cachedRead(file);
    const html = await renderMarkdown(app, content.slice(getFrontMatterInfo(content).contentStart), file.path, component);
    if (html.trim()) renderedNotes.push({ title: file.basename, html });
  }
  const children = [];
  for (const child of node.children) children.push(await exportedProject(app, repository, child, notes, component));
  return {
    title: project.title,
    status: project.status,
    purposeHtml: purpose.trim() ? await renderMarkdown(app, purpose, project.file.path, component) : "",
    desiredOutcomeHtml: desiredOutcome.trim() ? await renderMarkdown(app, desiredOutcome, project.file.path, component) : "",
    actions: node.actions,
    notes: renderedNotes,
    children,
  };
}

/** Markdown as Obsidian renders it, cut down to text, lists, tables and web links. */
async function renderMarkdown(app: App, markdown: string, sourcePath: string, component: Component): Promise<string> {
  const container = document.createElement("div");
  await MarkdownRenderer.render(app, markdown, container, sourcePath, component);
  for (const image of Array.from(container.querySelectorAll("img"))) {
    image.replaceWith(document.createTextNode(image.alt ? `[Image: ${image.alt}]` : "[Image]"));
  }
  for (const box of Array.from(container.querySelectorAll("input"))) {
    box.replaceWith(document.createTextNode(box.checked ? "☑ " : "☐ "));
  }
  for (const element of Array.from(container.querySelectorAll("*"))) {
    if (DROPPED.has(element.tagName.toUpperCase())) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const webLink = attribute.name === "href" && element.tagName === "A" && /^(https?:|mailto:)/i.test(attribute.value);
      if (!KEPT_ATTRIBUTES.has(attribute.name) || (attribute.name === "href" && !webLink)) element.removeAttribute(attribute.name);
    }
  }
  return container.innerHTML;
}

async function writeFile(app: App, folder: string, path: string, html: string): Promise<void> {
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await app.vault.modify(existing, html);
  else await app.vault.create(path, html);
}

class ExportProjectModal extends Modal {
  private options: ExportOptions = { includeDone: false };
  private withNotes = true;
  private exporting = false;
  private summary!: HTMLElement;

  constructor(
    app: App,
    private readonly title: string,
    private readonly folder: string,
    private readonly tree: (options: ExportOptions) => ExportNode,
    private readonly write: (tree: ExportNode, withNotes: boolean) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("dg-button-scope", "dg-delegate");
    this.titleEl.setText(`Export “${this.title}” for reading`);
    contentEl.createEl("p", {
      text: "One HTML file with this Project and every Project below it: purpose, desired outcome and Actions. "
        + "It opens in any browser and can be printed as a PDF. It's a copy of today and doesn't update. "
        + "Cancelled Projects and Actions are left out.",
    });
    this.summary = contentEl.createEl("p");
    new Setting(contentEl)
      .setName("Support notes")
      .setDesc("The Markdown notes in the Projects' support folders, as text. Images and attachments are left out.")
      .addToggle((toggle) => toggle.setValue(this.withNotes).onChange((value) => {
        this.withNotes = value;
      }));
    new Setting(contentEl)
      .setName("Finished work")
      .setDesc("Done Actions and Completed sub-projects too.")
      .addToggle((toggle) => toggle.setValue(this.options.includeDone).onChange((value) => {
        this.options = { includeDone: value };
        this.showSummary();
      }));
    const error = contentEl.createEl("p", { cls: "dg-delegate-error" });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Export").setCta().onClick(() => {
        if (this.exporting) return;
        this.exporting = true;
        button.setDisabled(true);
        void this.write(this.tree(this.options), this.withNotes)
          .then(() => this.close())
          .catch((failure: unknown) => {
            this.exporting = false;
            button.setDisabled(false);
            error.setText(failure instanceof Error ? failure.message : "Could not export the Project.");
          });
      }));
    this.showSummary();
  }

  private showSummary(): void {
    const { projects, actions } = countTree(this.tree(this.options));
    this.summary.setText(`${projects} ${projects === 1 ? "Project" : "Projects"}, ${actions} ${actions === 1 ? "Action" : "Actions"}. `
      + `Saved in ${this.folder}.`);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
