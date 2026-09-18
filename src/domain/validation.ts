import {
  ACTION_STATUSES,
  PROJECT_STATUSES,
  type Action,
  type ActionStatus,
  type Project,
  type ProjectStatus,
} from "./types";
import type { TFile } from "obsidian";

type Frontmatter = Record<string, unknown>;

function requiredString(frontmatter: Frontmatter, key: string): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing or invalid '${key}'`);
  }
  return value.trim();
}

function optionalString(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter[key];
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`Invalid '${key}'`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function dateOnly(value: string, key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00`).getTime())) throw new Error(`Invalid '${key}' date`);
  return value;
}

export function isActionStatus(value: unknown): value is ActionStatus {
  return typeof value === "string" && ACTION_STATUSES.includes(value as ActionStatus);
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && PROJECT_STATUSES.includes(value as ProjectStatus);
}

export function parseAction(frontmatter: Frontmatter, file: TFile): Action {
  const status = frontmatter.status;
  if (!isActionStatus(status)) throw new Error("Invalid 'status'");
  const action: Action = {
    type: "gtd-action",
    id: requiredString(frontmatter, "id"),
    title: requiredString(frontmatter, "title"),
    status,
    created: dateOnly(requiredString(frontmatter, "created"), "created"),
    file,
  };
  const projectId = optionalString(frontmatter, "project_id");
  const projectLink = optionalString(frontmatter, "project");
  const context = optionalString(frontmatter, "context");
  const energy = optionalString(frontmatter, "energy");
  const due = optionalString(frontmatter, "due");
  const deferUntil = optionalString(frontmatter, "defer_until");
  const completed = optionalString(frontmatter, "completed");
  if (projectId) action.projectId = projectId;
  if (projectLink) action.projectLink = projectLink;
  if (context) action.context = context;
  if (energy) action.energy = energy;
  if (due) action.due = dateOnly(due, "due");
  if (deferUntil) action.deferUntil = dateOnly(deferUntil, "defer_until");
  if (completed) {
    if (Number.isNaN(Date.parse(completed))) throw new Error("Invalid 'completed' timestamp");
    action.completed = completed;
  }
  return action;
}

export function parseProject(frontmatter: Frontmatter, file: TFile): Project {
  const status = frontmatter.status;
  if (!isProjectStatus(status)) throw new Error("Invalid 'status'");
  const project: Project = {
    type: "gtd-project",
    id: requiredString(frontmatter, "id"),
    title: requiredString(frontmatter, "title"),
    status,
    created: dateOnly(requiredString(frontmatter, "created"), "created"),
    file,
  };
  const area = optionalString(frontmatter, "area");
  const reviewed = optionalString(frontmatter, "reviewed");
  const completed = optionalString(frontmatter, "completed");
  const supportPath = optionalString(frontmatter, "support_path");
  if (area) project.area = area;
  if (reviewed) project.reviewed = dateOnly(reviewed, "reviewed");
  if (completed) {
    if (Number.isNaN(Date.parse(completed))) throw new Error("Invalid 'completed' timestamp");
    project.completed = completed;
  }
  if (supportPath) project.supportPath = supportPath;
  return project;
}
