import { Notice } from "obsidian";
import { useEffect, useState } from "preact/hooks";
import type { Action } from "../domain/types";
import type { GtdServices } from "./services";

export function ActionRows({ actions, services, projectLabels, allowProjectConversion = false, linkTitles = true }: { actions: Action[]; services: GtdServices; projectLabels?: ReadonlyMap<string, string>; allowProjectConversion?: boolean; linkTitles?: boolean }) {
  if (!actions.length) return null;
  return <div class="dg-action-rows">{actions.sort((a, b) => a.title.localeCompare(b.title)).map((action) => (
    <ActionRow key={action.id} action={action} services={services} allowProjectConversion={allowProjectConversion} linkTitle={linkTitles} {...(projectLabels ? { projectLabels } : {})} />
  ))}</div>;
}

function ActionRow({ action, services, projectLabels, allowProjectConversion, linkTitle }: { key?: string; action: Action; services: GtdServices; projectLabels?: ReadonlyMap<string, string>; allowProjectConversion: boolean; linkTitle: boolean }) {
  const done = action.status === "done";
  const [checked, setChecked] = useState(done);
  const [updating, setUpdating] = useState(false);
  useEffect(() => setChecked(done), [done]);

  const changeCompletion = async (next: boolean) => {
    setChecked(next);
    setUpdating(true);
    try {
      if (next) await services.repository.setActionStatus(action.id, "done");
      else await services.repository.reopenAction(action.id);
    } catch (error) {
      setChecked(!next);
      new Notice(error instanceof Error ? error.message : `Could not ${next ? "complete" : "reopen"} the Action.`);
    } finally {
      setUpdating(false);
    }
  };

  const deleteAction = async () => {
    if (!window.confirm(`Delete “${action.title}”?\n\nThis moves the Action file to Obsidian's trash.`)) return;
    try {
      await services.repository.trashAction(action.id);
      new Notice(`Deleted “${action.title}”.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not delete the Action.");
    }
  };

  return (
    <div class="dg-action-row">
      <input
        class="dg-action-row-checkbox"
        type="checkbox"
        checked={checked}
        disabled={updating}
        aria-label={`${done ? "Reopen" : "Complete"} ${action.title}`}
        onChange={(event) => void changeCompletion(event.currentTarget.checked)}
      />
      <div class="dg-action-row-main">
        {linkTitle
          ? <button class="dg-action-row-title" title={action.title} onClick={() => void services.openFile(action.file)}>{action.title}</button>
          : <span class="dg-action-row-title" title={action.title}>{action.title}</span>}
        <div class="dg-action-row-meta">
          {action.status !== "next" && <span class={`dg-action-status dg-action-status-${action.status}`}>{label(action.status)}</span>}
          {action.projectId && projectLabels?.has(action.projectId) && <span class="dg-action-project-label">{projectLabels.get(action.projectId)}</span>}
          {action.context && <span>@{action.context}</span>}
          {action.energy && <span>{action.energy} energy</span>}
          {action.due && <span>Due {action.due}</span>}
          {action.scheduledStart && <span>{new Date(action.scheduledStart).toLocaleString()}{action.durationMinutes ? ` · ${action.durationMinutes} min` : ""}</span>}
          {action.status === "scheduled" && (!action.scheduledStart || !action.durationMinutes) && <span class="is-overdue">Missing schedule</span>}
        </div>
      </div>
      <div class="dg-action-row-actions">
        <button class="dg-action-row-edit" aria-label={`Edit ${action.title}`} onClick={() => services.editAction(action.id, allowProjectConversion)}>Edit</button>
        <button class="dg-action-row-delete" aria-label={`Delete ${action.title}`} onClick={() => void deleteAction()}>Delete</button>
      </div>
    </div>
  );
}

function label(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
