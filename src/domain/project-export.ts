/**
 * A Project tree exported for someone to read: one self-contained HTML file that opens in any
 * browser, with no Obsidian, account or server. It is a copy of one moment and says so; it
 * never updates.
 *
 * The tree is the Project and every Project below it, as for delegation (`delegationScope`),
 * minus what was let go: cancelled Projects and Actions never go out, finished ones only when
 * asked for. Everything typed in the vault is escaped here; the only markup that passes through
 * is the notes' rendered Markdown, which the host has already reduced to plain text markup.
 */

import { projectDescendants } from "./project-tree";
import { plainTitle } from "./text";
import type { Action, ActionStatus, Project, ProjectStatus } from "./types";

export interface ExportOptions {
  /** Done Actions and Completed sub-projects, as well as the open ones. */
  includeDone: boolean;
}

/** One Project of the tree with what the export shows of it, before its texts are added. */
export interface ExportNode {
  project: Project;
  actions: Action[];
  children: ExportNode[];
}

/** The Projects and Actions an export of this Project shows, in the order it shows them. */
export function exportTree(rootId: string, projects: readonly Project[], actions: readonly Action[], options: ExportOptions): ExportNode {
  const root = projects.find((project) => project.id === rootId);
  if (!root) throw new Error("This Project no longer exists.");
  const shown = (status: ProjectStatus) => status !== "cancelled" && (options.includeDone || status !== "completed");
  const inTree = new Set([root, ...projectDescendants(root.id, projects)].map((project) => project.id));
  const children = new Map<string, Project[]>();
  for (const project of projects) {
    if (!project.parentProjectId || !inTree.has(project.id) || !shown(project.status)) continue;
    children.set(project.parentProjectId, [...(children.get(project.parentProjectId) ?? []), project]);
  }
  const node = (project: Project): ExportNode => ({
    project,
    actions: actions
      .filter((action) => action.projectId === project.id && actionShown(action.status, options))
      .sort(compareActions),
    children: (children.get(project.id) ?? []).sort(compareProjects).map(node),
  });
  return node(root);
}

function actionShown(status: ActionStatus, options: ExportOptions): boolean {
  return status !== "cancelled" && (options.includeDone || status !== "done");
}

const ACTION_ORDER: Record<ActionStatus, number> = { next: 0, scheduled: 1, waiting: 2, done: 3, cancelled: 4 };

function compareActions(left: Action, right: Action): number {
  return ACTION_ORDER[left.status] - ACTION_ORDER[right.status]
    || (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER)
    || left.title.localeCompare(right.title);
}

function compareProjects(left: Project, right: Project): number {
  return (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || left.title.localeCompare(right.title);
}

export function countTree(node: ExportNode): { projects: number; actions: number } {
  return node.children.map(countTree).reduce(
    (total, child) => ({ projects: total.projects + child.projects, actions: total.actions + child.actions }),
    { projects: 1, actions: node.actions.length },
  );
}

/** A Project as the page shows it; the `…Html` fields are rendered Markdown the host has cleaned. */
export interface ExportedProject {
  title: string;
  status: ProjectStatus;
  purposeHtml: string;
  desiredOutcomeHtml: string;
  actions: Action[];
  notes: { title: string; html: string }[];
  children: ExportedProject[];
}

const STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active", backlog: "Backlog", someday: "Someday/Maybe", completed: "Completed", cancelled: "Cancelled",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** What an Action's line says besides its title. */
export function actionDetails(action: Action): string[] {
  const details: string[] = [];
  if (action.status === "waiting") {
    details.push(action.delegatedTo ? `Waiting for ${action.delegatedTo}` : "Waiting");
    if (action.waitingSince) details.push(`since ${action.waitingSince}`);
  }
  if (action.status === "scheduled" && action.scheduledStart) details.push(`On ${action.scheduledStart.slice(0, 10)}`);
  if (action.due) details.push(`Due ${action.due}`);
  if (action.status === "done") details.push("Done");
  return details;
}

/** The whole page: one file, its styles inside, nothing loaded from anywhere. */
export function projectExportHtml(root: ExportedProject, exportedOn: string): string {
  const title = escapeHtml(plainTitle(root.title));
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<p class="copy">A read-only copy from ${escapeHtml(exportedOn)}. It does not update.</p>`,
    projectSection(root, 1),
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function projectSection(project: ExportedProject, depth: number): string {
  const heading = `h${Math.min(depth, 5)}`;
  const parts = [
    `<section class="project depth-${Math.min(depth, 5)}">`,
    `<${heading}>${escapeHtml(plainTitle(project.title))} <span class="status">${STATUS_LABELS[project.status]}</span></${heading}>`,
  ];
  if (project.purposeHtml.trim()) parts.push('<div class="label">Purpose</div>', `<div class="text">${project.purposeHtml}</div>`);
  if (project.desiredOutcomeHtml.trim()) {
    parts.push('<div class="label">Desired outcome</div>', `<div class="text">${project.desiredOutcomeHtml}</div>`);
  }
  if (project.actions.length) {
    parts.push('<div class="label">Actions</div>', '<ul class="actions">');
    for (const action of project.actions) {
      const done = action.status === "done";
      const details = actionDetails(action).map(escapeHtml).join(" · ");
      parts.push(`<li class="${done ? "done" : ""}"><span class="box">${done ? "☑" : "☐"}</span> `
        + `${escapeHtml(plainTitle(action.title))}${details ? ` <span class="details">${details}</span>` : ""}</li>`);
    }
    parts.push("</ul>");
  }
  for (const note of project.notes) {
    parts.push('<article class="note">', `<div class="label">Note: ${escapeHtml(note.title)}</div>`, `<div class="text">${note.html}</div>`, "</article>");
  }
  for (const child of project.children) parts.push(projectSection(child, depth + 1));
  parts.push("</section>");
  return parts.join("\n");
}

const PAGE_STYLE = `
:root { color-scheme: light dark; --muted: #6b6b6b; --line: #d9d9d9; --soft: #f5f5f5; }
@media (prefers-color-scheme: dark) { :root { --muted: #a0a0a0; --line: #3a3a3a; --soft: #222; } }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
.copy { color: var(--muted); font-size: 14px; margin: 0 0 16px; }
h1, h2, h3, h4, h5 { line-height: 1.25; margin: 0 0 8px; }
.status { font-size: 13px; font-weight: normal; color: var(--muted); border: 1px solid var(--line); border-radius: 10px; padding: 1px 8px; vertical-align: middle; }
.project { margin: 0 0 20px; }
.project .project { margin: 20px 0 0; padding-left: 16px; border-left: 3px solid var(--line); }
.label { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); margin: 12px 0 4px; }
.text > :first-child { margin-top: 0; }
.text > :last-child { margin-bottom: 0; }
.actions { list-style: none; padding: 0; margin: 0; }
.actions li { padding: 3px 0; }
.actions li.done { color: var(--muted); text-decoration: line-through; }
.box { display: inline-block; width: 1.2em; }
.details { color: var(--muted); font-size: 14px; }
.note { margin-top: 12px; padding: 8px 12px; background: var(--soft); border-radius: 6px; }
pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
table { border-collapse: collapse; }
td, th { border: 1px solid var(--line); padding: 4px 8px; }
blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }
@media print { .project .project { break-inside: avoid-page; } }
`;
