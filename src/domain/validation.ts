import {
  ACTION_STATUSES,
  PROJECT_STATUSES,
  type Action,
  type ActionStatus,
  type InboxItem,
  type Project,
  type ProjectStatus,
} from "./types";
import type { TFile } from "obsidian";
import { normalizeProjectTags } from "./project-board";
import { isAllDaySchedule } from "./schedule";

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

function optionalStringList(frontmatter: Frontmatter, key: string): string[] {
  const value = frontmatter[key];
  if (value === null || value === undefined || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== "string")) throw new Error(`Invalid '${key}'`);
  return [...new Set((values as string[]).map((item) => item.trim()).filter(Boolean))];
}

function optionalNumber(frontmatter: Frontmatter, key: string): number | undefined {
  const value = frontmatter[key];
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid '${key}'`);
  return value;
}

function dateOnly(value: string, key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00`).getTime())) throw new Error(`Invalid '${key}' date`);
  return value;
}

/** A `scheduled_start` is either a plain date, meaning all day, or an absolute timestamp. */
export function normalizeScheduledStart(value: string, key = "scheduled_start"): string {
  return isAllDaySchedule(value) ? dateOnly(value, key) : normalizeTimestamp(value, key);
}

export function normalizeTimestamp(value: string, key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || Number.isNaN(Date.parse(value))) throw new Error(`Invalid '${key}' timestamp`);
  return new Date(value).toISOString();
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
  const waitingSince = optionalString(frontmatter, "waiting_since");
  const scheduledStart = optionalString(frontmatter, "scheduled_start");
  const durationMinutes = optionalNumber(frontmatter, "duration_minutes");
  const completed = optionalString(frontmatter, "completed");
  if (projectId) action.projectId = projectId;
  if (projectLink) action.projectLink = projectLink;
  if (context) action.context = context;
  if (energy) action.energy = energy;
  if (due) action.due = dateOnly(due, "due");
  if (deferUntil) action.deferUntil = dateOnly(deferUntil, "defer_until");
  if (waitingSince) action.waitingSince = dateOnly(waitingSince, "waiting_since");
  if (scheduledStart) action.scheduledStart = normalizeScheduledStart(scheduledStart);
  if (durationMinutes !== undefined) {
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) throw new Error("Invalid 'duration_minutes'");
    action.durationMinutes = durationMinutes;
  }
  if (completed) {
    if (Number.isNaN(Date.parse(completed))) throw new Error("Invalid 'completed' timestamp");
    action.completed = completed;
  }
  if (frontmatter.work === true || frontmatter.work === "true") action.work = true;
  return action;
}

export function parseInboxItem(frontmatter: Frontmatter, file: TFile, legacyAction = false): InboxItem {
  const item: InboxItem = {
    type: "gtd-inbox-item",
    id: requiredString(frontmatter, "id"),
    title: requiredString(frontmatter, "title"),
    created: dateOnly(requiredString(frontmatter, "created"), "created"),
    file,
  };
  if (legacyAction) item.legacyAction = true;
  return item;
}

export function parseProject(frontmatter: Frontmatter, file: TFile): Project {
  // Treat the removed Project-only `waiting` status as Active while the
  // startup migration rewrites the source frontmatter.
  const status = frontmatter.status === "waiting" ? "active" : frontmatter.status;
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
  const image = optionalString(frontmatter, "image");
  const tags = normalizeProjectTags(optionalStringList(frontmatter, "tags").flatMap((tag) => tag.split(",")));
  const order = optionalNumber(frontmatter, "order");
  const blockedByProjectIds = optionalStringList(frontmatter, "blocked_by_project_ids");
  const parentProjectId = optionalString(frontmatter, "parent_project_id");
  const parentProjectLink = optionalString(frontmatter, "parent_project");
  if (area) project.area = area;
  if (reviewed) project.reviewed = dateOnly(reviewed, "reviewed");
  if (completed) {
    if (Number.isNaN(Date.parse(completed))) throw new Error("Invalid 'completed' timestamp");
    project.completed = completed;
  }
  if (supportPath) project.supportPath = supportPath;
  if (image) project.image = image;
  if (tags.length) project.tags = tags;
  if (order !== undefined) project.order = order;
  if (blockedByProjectIds.length) project.blockedByProjectIds = blockedByProjectIds;
  if (parentProjectId) project.parentProjectId = parentProjectId;
  if (parentProjectLink) project.parentProjectLink = parentProjectLink;
  return project;
}
