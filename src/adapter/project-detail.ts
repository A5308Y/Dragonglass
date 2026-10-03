import { Notice, TFile } from "obsidian";
import { parseExternalLink } from "../domain/external-links";
import type { Project } from "../domain/types";
import { isVaultImage } from "../ui/image-input";
import { LinkFileModal } from "../ui/link-file";
import type { GtdServices } from "../ui/services";
import { showUndoNotice } from "../ui/undo";
import type { ElmNonMenuCommand, ElmProjectDetailDto, ElmProjectSupportFileDto } from "./protocol";

/**
 * A Project's Support Material and the commands that change it, shared by the views that
 * show it: the Project page's Support tab and the running Pomodoro (`Gtd.Support` in Elm).
 */

/** The commands `executeSupportCommand` handles. */
export const SUPPORT_COMMANDS = [
  "open-file", "create-support-note", "create-support-folder", "read-support-note", "update-support-note",
  "link-project-file", "unlink-project-file", "add-project-link", "remove-project-link",
] as const;

type SupportCommand = Extract<ElmNonMenuCommand, { type: (typeof SUPPORT_COMMANDS)[number] }>;

export function isSupportCommand(command: { type: string }): command is SupportCommand {
  return (SUPPORT_COMMANDS as readonly string[]).includes(command.type);
}

/**
 * Everything the Support tab shows for a Project. `files` overrides the Project's own
 * support files, for a view that splits a tree's folders between its Projects.
 */
export async function projectDetail(services: GtdServices, project: Project, files?: readonly TFile[]): Promise<ElmProjectDetailDto> {
  const [purpose, desiredOutcome, diary, ideas] = await Promise.all([
    services.repository.readProjectPurpose(project),
    services.repository.readDesiredOutcome(project),
    services.repository.readProjectDiary(project),
    services.repository.planIdeas(project),
  ]);
  const relative = (path: string, fallback: string) =>
    project.supportPath && path.startsWith(`${project.supportPath}/`) ? path.slice(project.supportPath.length + 1) : fallback;
  const supportFiles = [...(files ?? services.repository.supportFiles(project))]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file): ElmProjectSupportFileDto => {
      const type = services.app.metadataCache.getFileCache(file)?.frontmatter?.type;
      const note = file.extension === "md" && type !== "gtd-action" && type !== "gtd-project" && type !== "gtd-inbox-item";
      const kind = note ? "note" as const : isVaultImage(file) ? "image" as const : "attachment" as const;
      return {
        path: file.path,
        name: file.name,
        basename: file.basename,
        extension: file.extension,
        label: relative(file.path, file.name),
        kind,
        resourceUrl: kind === "image" ? services.app.vault.getResourcePath(file) : "",
      };
    });
  return {
    projectId: project.id,
    purpose,
    desiredOutcome,
    ideas,
    diary: diary.map((entry) => ({ timestamp: entry.timestamp ?? "", text: entry.text })),
    supportFiles,
    linkedFiles: services.repository.linkedFiles(project).map(({ link, file }) => ({
      link,
      path: file?.path ?? "",
      label: file ? file.path : link.replace(/^\[\[|\]\]$/g, ""),
    })),
    externalLinks: (project.externalLinks ?? []).flatMap((entry) => parseExternalLink(entry) ?? []),
    supportFolders: services.repository.supportFolders(project).map((path) => ({ path, label: relative(path, path) })),
  };
}

/** Opens, creates, reads, saves, links and unlinks Support Material; unlinking offers Undo. */
export async function executeSupportCommand(services: GtdServices, command: SupportCommand): Promise<unknown> {
  const { repository } = services;
  const project = (id: string): Project => {
    const found = repository.index.getSnapshot().projectsById.get(id);
    if (!found) throw new Error("This Project no longer exists.");
    return found;
  };
  switch (command.type) {
    case "open-file": {
      const file = services.app.vault.getAbstractFileByPath(command.path);
      if (!(file instanceof TFile)) throw new Error(`File '${command.path}' no longer exists.`);
      await services.openFile(file);
      return;
    }
    case "create-support-note":
      return (await repository.createProjectSupportNote(command.projectId, command.title)).path;
    case "create-support-folder":
      return repository.createProjectSupportFolder(command.projectId, command.path);
    case "read-support-note":
      return repository.readProjectSupportNote(command.projectId, command.path);
    case "update-support-note":
      await repository.updateProjectSupportNote(command.projectId, command.path, command.body);
      return;
    case "link-project-file": {
      const target = project(command.projectId);
      // Support material is already listed, and a Project need not link its own note.
      const linked = new Set(repository.linkedFiles(target).flatMap((entry) => entry.file ? [entry.file.path] : []));
      const own = new Set(repository.supportFiles(target).map((file) => file.path));
      const candidates = services.app.vault.getFiles()
        .filter((file) => file.path !== target.file.path && !linked.has(file.path) && !own.has(file.path))
        .sort((left, right) => left.path.localeCompare(right.path));
      new LinkFileModal(services.app, candidates, (file) => {
        void repository.linkProjectFile(target.id, file)
          .catch((error: unknown) => new Notice(error instanceof Error ? error.message : "Could not link the file."));
      }).open();
      return;
    }
    case "unlink-project-file": {
      const target = project(command.projectId);
      const file = repository.linkedFiles(target).find((entry) => entry.link === command.link)?.file;
      await repository.unlinkProjectFile(target.id, command.link);
      // A link to a file that is gone has nothing to restore.
      if (file) showUndoNotice(`Unlinked “${file.name}”.`, () => repository.linkProjectFile(target.id, file));
      return;
    }
    case "add-project-link":
      return repository.addProjectLink(command.projectId, command.url, command.title);
    case "remove-project-link": {
      const target = project(command.projectId);
      const removed = parseExternalLink(command.entry);
      await repository.removeProjectLink(target.id, command.entry);
      if (removed) {
        showUndoNotice(`Removed “${removed.title}”.`, () =>
          repository.addProjectLink(target.id, removed.url, removed.title === removed.url ? "" : removed.title));
      }
      return;
    }
  }
}
