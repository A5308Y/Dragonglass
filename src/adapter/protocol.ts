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
  | { type: "create-action" }
  | { type: "quick-capture" }
  | { type: "open-inbox" }
  | { type: "show-project"; projectId: string }
  | { type: "edit-action"; actionId: string }
  | { type: "set-action-status"; actionId: string; status: Action["status"] }
  | { type: "update-action"; actionId: string; projectId?: string; context?: string }
  | { type: "trash-action"; actionId: string }
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
    case "quick-capture":
    case "open-inbox":
      return true;
    case "show-project":
      return typeof value.projectId === "string";
    case "edit-action":
    case "trash-action":
      return typeof value.actionId === "string";
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
  | { type: "start-processing" }
  | { type: "command-result"; requestId: string; ok: true; value?: unknown }
  | { type: "command-result"; requestId: string; ok: false; error: string };
