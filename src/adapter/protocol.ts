import type { Action, GtdSettings, GtdSnapshot, Project } from "../domain/types";

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

export interface ElmSnapshotDto {
  protocolVersion: typeof ELM_PROTOCOL_VERSION;
  revision: number;
  today: string;
  actions: ElmActionDto[];
  projects: ElmProjectDto[];
  issues: Array<{ path: string; message: string; kind: string }>;
  settings: GtdSettings;
}

export function elmSnapshot(snapshot: GtdSnapshot, settings: GtdSettings, today: string): ElmSnapshotDto {
  return {
    protocolVersion: ELM_PROTOCOL_VERSION,
    revision: snapshot.revision,
    today,
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
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ElmCommandEnvelope>;
  if (candidate.protocolVersion !== ELM_PROTOCOL_VERSION || typeof candidate.requestId !== "string") return null;
  if (!candidate.command || typeof candidate.command !== "object" || typeof candidate.command.type !== "string") return null;
  return candidate as ElmCommandEnvelope;
}

export type ElmHostEvent =
  | { type: "snapshot"; snapshot: ElmSnapshotDto }
  | { type: "command-result"; requestId: string; ok: true; value?: unknown }
  | { type: "command-result"; requestId: string; ok: false; error: string };
