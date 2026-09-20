import type { Action, GtdSettings, GtdSnapshot, InboxItem, InboxProcessingInput, Project } from "../domain/types";

export const ELM_PROTOCOL_VERSION = 1;

export interface ElmFileDto {
  path: string;
  name: string;
  basename: string;
  extension: string;
}

export interface ElmActionDto extends Omit<Action, "file"> {
  file: ElmFileDto;
}

export interface ElmProjectDto extends Omit<Project, "file"> {
  file: ElmFileDto;
}

export interface ElmProjectMetaDto {
  id: string;
  breadcrumb: string;
  activeSubprojects: number;
  supportFiles: number;
  imageUrl: string;
  actionIssue: string | null;
  blockers: string[];
}

export interface ElmProjectSupportFileDto extends ElmFileDto {
  label: string;
  kind: "note" | "image" | "attachment";
  resourceUrl: string;
}

export interface ElmDiaryEntryDto {
  timestamp: string;
  text: string;
}

export interface ElmProjectDetailDto {
  projectId: string;
  desiredOutcome: string;
  diary: ElmDiaryEntryDto[];
  supportFiles: ElmProjectSupportFileDto[];
  supportFolders: Array<{ path: string; label: string }>;
}

export interface ElmInboxItemDto extends Omit<InboxItem, "file"> {
  file: ElmFileDto;
  resourceUrl: string;
}

export interface ElmSnapshotDto {
  protocolVersion: typeof ELM_PROTOCOL_VERSION;
  revision: number;
  today: string;
  inboxItems: ElmInboxItemDto[];
  actions: ElmActionDto[];
  projects: ElmProjectDto[];
  issues: Array<{ path: string; message: string; kind: string }>;
  settings: GtdSettings;
}

export function elmSnapshot(
  snapshot: GtdSnapshot,
  settings: GtdSettings,
  today: string,
  resourceUrl: (file: InboxItem["file"]) => string = () => "",
): ElmSnapshotDto {
  return {
    protocolVersion: ELM_PROTOCOL_VERSION,
    revision: snapshot.revision,
    today,
    inboxItems: snapshot.inboxItems.map((item) => ({ ...item, file: fileDto(item.file), resourceUrl: resourceUrl(item.file) })),
    actions: snapshot.actions.map((action) => ({ ...action, file: fileDto(action.file) })),
    projects: snapshot.projects.map((project) => ({ ...project, file: fileDto(project.file) })),
    issues: snapshot.issues.map((issue) => ({ ...issue })),
    settings: structuredClone(settings),
  };
}

function fileDto(file: Action["file"] | Project["file"]): ElmFileDto {
  return {
    path: file.path,
    name: file.name,
    basename: file.basename,
    extension: file.extension,
  };
}

export type ElmHostCommand =
  | { type: "create-action"; projectId?: string }
  | { type: "create-project"; parentProjectId?: string }
  | { type: "set-project-selection"; projectId?: string }
  | { type: "quick-capture" }
  | { type: "open-inbox" }
  | { type: "show-project"; projectId: string }
  | { type: "edit-action"; actionId: string }
  | { type: "set-action-status"; actionId: string; status: Action["status"] }
  | { type: "update-action"; actionId: string; projectId?: string; context?: string }
  | { type: "trash-action"; actionId: string }
  | { type: "edit-project"; projectId: string }
  | { type: "set-project-status"; projectId: string; status: Project["status"] }
  | { type: "move-subproject"; projectId: string; status: Project["status"]; beforeId?: string }
  | { type: "trash-project"; projectId: string }
  | { type: "trash-projects"; projectIds: string[] }
  | { type: "batch-project-tags"; projectIds: string[] }
  | { type: "batch-project-parent"; projectIds: string[] }
  | { type: "project-dependencies"; projectId: string }
  | { type: "import-actions"; projectId: string }
  | { type: "import-subprojects"; projectId: string }
  | { type: "load-project-detail"; projectId: string }
  | { type: "set-desired-outcome"; projectId: string; body: string }
  | { type: "add-diary-entry"; projectId: string; body: string }
  | { type: "create-support-note"; projectId: string; title: string }
  | { type: "create-support-folder"; projectId: string; path: string }
  | { type: "read-support-note"; projectId: string; path: string }
  | { type: "update-support-note"; projectId: string; path: string; body: string }
  | { type: "save-project-preferences"; columns: Project["status"][]; showImages: boolean }
  | { type: "open-file"; path: string }
  | { type: "read-inbox-body"; itemId: string }
  | { type: "trash-inbox-item"; itemId: string }
  | { type: "process-inbox"; itemId: string; operation: "next-action" | "file" | "someday"; input: InboxProcessingInput }
  | { type: "save-settings"; settings: GtdSettings }
  | { type: "prompt"; title: string; placeholder: string }
  | { type: "show-menu"; x: number; y: number; entries: ElmMenuEntry[] };

export interface ElmMenuEntry {
  label?: string;
  separator?: boolean;
  command?: Exclude<ElmHostCommand, { type: "show-menu" }>;
}

export interface ElmCommandEnvelope {
  protocolVersion: number;
  requestId: string;
  command: ElmHostCommand;
}

export function parseElmCommand(value: unknown): ElmCommandEnvelope | null {
  if (!isRecord(value)) return null;
  const candidate = value as Partial<ElmCommandEnvelope>;
  if (candidate.protocolVersion !== ELM_PROTOCOL_VERSION || typeof candidate.requestId !== "string") return null;
  if (!isHostCommand(candidate.command)) return null;
  return candidate as ElmCommandEnvelope;
}

function isHostCommand(value: unknown): value is ElmHostCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "create-action":
      return value.projectId === undefined || typeof value.projectId === "string";
    case "create-project":
      return value.parentProjectId === undefined || typeof value.parentProjectId === "string";
    case "set-project-selection":
      return value.projectId === undefined || typeof value.projectId === "string";
    case "quick-capture":
    case "open-inbox":
      return true;
    case "show-project":
      return typeof value.projectId === "string";
    case "edit-action":
    case "trash-action":
      return typeof value.actionId === "string";
    case "edit-project":
    case "trash-project":
    case "project-dependencies":
    case "import-actions":
    case "import-subprojects":
    case "load-project-detail":
      return typeof value.projectId === "string";
    case "set-project-status":
      return typeof value.projectId === "string"
        && ["active", "backlog", "someday", "completed", "cancelled"].includes(String(value.status));
    case "move-subproject":
      return typeof value.projectId === "string"
        && ["active", "backlog", "someday", "completed"].includes(String(value.status))
        && (value.beforeId === undefined || typeof value.beforeId === "string");
    case "trash-projects":
    case "batch-project-tags":
    case "batch-project-parent":
      return Array.isArray(value.projectIds) && value.projectIds.every((id) => typeof id === "string");
    case "set-desired-outcome":
    case "add-diary-entry":
      return typeof value.projectId === "string" && typeof value.body === "string";
    case "create-support-note":
      return typeof value.projectId === "string" && typeof value.title === "string";
    case "create-support-folder":
      return typeof value.projectId === "string" && typeof value.path === "string";
    case "read-support-note":
      return typeof value.projectId === "string" && typeof value.path === "string";
    case "update-support-note":
      return typeof value.projectId === "string" && typeof value.path === "string" && typeof value.body === "string";
    case "save-project-preferences":
      return Array.isArray(value.columns)
        && value.columns.length > 0
        && value.columns.every((status) => ["active", "backlog", "someday", "completed"].includes(String(status)))
        && typeof value.showImages === "boolean";
    case "set-action-status":
      return typeof value.actionId === "string"
        && ["next", "waiting", "scheduled", "done", "cancelled"].includes(String(value.status));
    case "update-action":
      return typeof value.actionId === "string"
        && (value.projectId === undefined || typeof value.projectId === "string")
        && (value.context === undefined || typeof value.context === "string");
    case "open-file":
      return typeof value.path === "string";
    case "read-inbox-body":
    case "trash-inbox-item":
      return typeof value.itemId === "string";
    case "process-inbox":
      return typeof value.itemId === "string"
        && ["next-action", "file", "someday"].includes(String(value.operation))
        && isRecord(value.input);
    case "save-settings":
      return isRecord(value.settings);
    case "prompt":
      return typeof value.title === "string" && typeof value.placeholder === "string";
    case "show-menu":
      return typeof value.x === "number" && typeof value.y === "number" && Array.isArray(value.entries);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type ElmHostEvent =
  | { type: "snapshot"; snapshot: ElmSnapshotDto }
  | { type: "project-detail"; detail: ElmProjectDetailDto }
  | { type: "show-project"; projectId: string | null }
  | { type: "start-processing" }
  | { type: "command-result"; requestId: string; ok: true; value?: unknown }
  | { type: "command-result"; requestId: string; ok: false; error: string };
