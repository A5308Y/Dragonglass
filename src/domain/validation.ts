import {
  ACTION_STATUSES,
  ENERGY_LEVELS,
  PROJECT_STATUSES,
  type Action,
  type ActionStatus,
  type Energy,
  type InboxItem,
  type Project,
  type ProjectStatus,
} from "./types";
import { actionKeepsContext } from "./action-status";
import type { TFile } from "obsidian";
import { normalizeProjectTags } from "./project-board";
import { isAllDaySchedule } from "./schedule";
import { parseDateOnly } from "../utils/date";

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

/**
 * `linked_files` as wikilink strings. Obsidian writes them quoted; a hand-written,
 * unquoted `- [[Note]]` reaches here as YAML's nested list `[["Note"]]` and is read
 * back as the link it was meant to be.
 */
function linkedFileList(frontmatter: Frontmatter): string[] {
  const value = frontmatter.linked_files;
  if (value === null || value === undefined || value === "") return [];
  const entries = (Array.isArray(value) ? value : [value]).map((entry) => {
    const link = linkedFileEntry(entry);
    if (link === undefined) throw new Error("Invalid 'linked_files'");
    return link;
  });
  return [...new Set(entries.filter(Boolean))];
}

/** One `linked_files` entry as a wikilink string, or `undefined` when it is not one. */
export function linkedFileEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.trim();
  if (Array.isArray(entry) && entry.length === 1 && Array.isArray(entry[0]) && entry[0].length === 1 && typeof entry[0][0] === "string") {
    return `[[${entry[0][0].trim()}]]`;
  }
  return undefined;
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

/**
 * `low` or `high`, in any casing. `medium` was a level once and is now the normal
 * default, so it reads as no level; anything else is invalid metadata.
 */
function energyLevel(value: string): Energy | undefined {
  const level = value.trim().toLocaleLowerCase();
  if (level === "medium") return undefined;
  if (!isEnergy(level)) throw new Error("Invalid 'energy': use low or high, or leave it empty");
  return level;
}

function dateOnly(value: string, key: string): string {
  if (!parseDateOnly(value)) throw new Error(`Invalid '${key}' date`);
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

export function isEnergy(value: unknown): value is Energy {
  return typeof value === "string" && (ENERGY_LEVELS as readonly string[]).includes(value);
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
  const waitingSince = optionalString(frontmatter, "waiting_since");
  const followUp = optionalString(frontmatter, "follow_up");
  const delegatedTo = optionalString(frontmatter, "delegated_to");
  const scheduledStart = optionalString(frontmatter, "scheduled_start");
  const durationMinutes = optionalNumber(frontmatter, "duration_minutes");
  const priority = optionalNumber(frontmatter, "priority");
  const completed = optionalString(frontmatter, "completed");
  if (projectId) action.projectId = projectId;
  if (projectLink) action.projectLink = projectLink;
  // A Waiting Action carries neither; values left in its file are ignored and cleared on its next save.
  const keepsContext = actionKeepsContext(action.status);
  if (context && keepsContext) action.context = context;
  const energyValue = energy ? energyLevel(energy) : undefined;
  if (energyValue && keepsContext) action.energy = energyValue;
  if (due) action.due = dateOnly(due, "due");
  if (waitingSince) action.waitingSince = dateOnly(waitingSince, "waiting_since");
  if (followUp) action.followUp = dateOnly(followUp, "follow_up");
  if (delegatedTo) action.delegatedTo = delegatedTo;
  if (scheduledStart) action.scheduledStart = normalizeScheduledStart(scheduledStart);
  if (durationMinutes !== undefined) {
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) throw new Error("Invalid 'duration_minutes'");
    action.durationMinutes = durationMinutes;
  }
  if (priority !== undefined) {
    if (!Number.isInteger(priority)) throw new Error("Invalid 'priority'");
    action.priority = priority;
  }
  if (completed) {
    if (Number.isNaN(Date.parse(completed))) throw new Error("Invalid 'completed' timestamp");
    action.completed = completed;
  }
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
  const messageId = optionalString(frontmatter, "message_id");
  if (messageId) item.messageId = messageId;
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
  const activateAt = optionalString(frontmatter, "activate_at");
  const completed = optionalString(frontmatter, "completed");
  const supportPath = optionalString(frontmatter, "support_path");
  const image = optionalString(frontmatter, "image");
  const tags = normalizeProjectTags(optionalStringList(frontmatter, "tags").flatMap((tag) => tag.split(",")));
  const order = optionalNumber(frontmatter, "order");
  const blockedByProjectIds = optionalStringList(frontmatter, "blocked_by_project_ids");
  const linkedFiles = linkedFileList(frontmatter);
  const externalLinks = optionalStringList(frontmatter, "external_links");
  const parentProjectId = optionalString(frontmatter, "parent_project_id");
  const parentProjectLink = optionalString(frontmatter, "parent_project");
  // Areas belong to top-level Projects; a sub-project's own value is ignored and cleared on its next save.
  if (area && !parentProjectId) project.area = area;
  if (reviewed) project.reviewed = dateOnly(reviewed, "reviewed");
  if (activateAt) project.activateAt = dateOnly(activateAt, "activate_at");
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
  if (linkedFiles.length) project.linkedFiles = linkedFiles;
  if (externalLinks.length) project.externalLinks = externalLinks;
  return project;
}
