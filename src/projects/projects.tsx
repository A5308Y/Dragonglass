import { Component, MarkdownRenderer } from "obsidian";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Action, Project, ProjectStatus } from "../domain/types";
import { useGtdSnapshot } from "../ui/hooks";
import type { GtdServices } from "../ui/services";

const VISIBLE_STATUSES: ProjectStatus[] = ["active", "waiting", "someday", "completed"];

export function ProjectsView({ services, initialProjectId = null }: { services: GtdServices; initialProjectId?: string | null }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId);
  useEffect(() => setSelectedId(initialProjectId), [initialProjectId]);
  const selected = selectedId ? snapshot.projectsById.get(selectedId) : undefined;
  if (selected) return <ProjectDetail services={services} project={selected} onBack={() => setSelectedId(null)} />;

  const actionsByProject = useMemo(() => {
    const result = new Map<string, Action[]>();
    for (const action of snapshot.actions) {
      if (!action.projectId) continue;
      const list = result.get(action.projectId) ?? [];
      list.push(action);
      result.set(action.projectId, list);
    }
    return result;
  }, [snapshot]);

  return (
    <div class="dg-view dg-projects-view">
      <header class="dg-view-header">
        <div><h2>Projects</h2><span class="dg-count">{snapshot.projects.length}</span></div>
        <button class="mod-cta" onClick={services.createProject}>New Project</button>
      </header>
      <div class="dg-project-groups">
        {VISIBLE_STATUSES.map((status) => {
          const projects = snapshot.projects.filter((project) => project.status === status).sort((a, b) => a.title.localeCompare(b.title));
          return (
            <section class="dg-project-group" key={status}>
              <header class="dg-column-header"><span>{title(status)}</span><span>{projects.length}</span></header>
              {projects.map((project) => {
                const actions = actionsByProject.get(project.id) ?? [];
                const open = actions.filter((action) => action.status !== "done" && action.status !== "cancelled").length;
                const next = actions.filter((action) => action.status === "next").length;
                return (
                  <article class="dg-project-row" key={project.id}>
                    <button class="dg-project-title" onClick={() => setSelectedId(project.id)}>{project.title}</button>
                    <div class="dg-project-stats">
                      <span>{open} open</span><span>{next} next</span>
                      {project.reviewed && <span>Reviewed {project.reviewed}</span>}
                      {open === 0 && project.status === "active" && <span class="dg-warning-text">No open Actions</span>}
                      {open > 0 && next === 0 && project.status === "active" && <span class="dg-warning-text">No Next Action</span>}
                    </div>
                    <div class="dg-row-actions">
                      <button onClick={() => void services.openFile(project.file)}>Open note</button>
                      <button onClick={() => services.editProject(project.id)}>Edit</button>
                    </div>
                  </article>
                );
              })}
              {projects.length === 0 && <div class="dg-empty-row">No {title(status).toLocaleLowerCase()} Projects.</div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ProjectDetail({ services, project, onBack }: { services: GtdServices; project: Project; onBack: () => void }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [outcome, setOutcome] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  useEffect(() => {
    let active = true;
    void services.repository.readDesiredOutcome(project).then((value) => { if (active) setOutcome(value); });
    return () => { active = false; };
  }, [project.file.stat.mtime, project.file.path]);
  const all = snapshot.actions.filter((action) => action.projectId === project.id);
  const open = all.filter((action) => action.status !== "done" && action.status !== "cancelled");
  const completed = all.filter((action) => action.status === "done");
  const support = services.repository.supportFiles(project);

  return (
    <div class="dg-view dg-project-detail">
      <header class="dg-view-header">
        <div class="dg-detail-heading">
          <button onClick={onBack}>← Projects</button>
          <h2>{project.title}</h2>
          <span class={`dg-status dg-status-${project.status}`}>{title(project.status)}</span>
        </div>
        <div class="dg-header-actions">
          <button onClick={() => void services.openFile(project.file)}>Open note</button>
          <button onClick={() => services.editProject(project.id)}>Edit</button>
        </div>
      </header>
      <section class="dg-detail-section">
        <h3>Desired outcome</h3>
        {outcome ? <MarkdownText services={services} markdown={outcome} sourcePath={project.file.path} /> : <div class="dg-muted">No desired outcome written yet.</div>}
      </section>
      <section class="dg-detail-section">
        <div class="dg-section-heading"><h3>Open Actions</h3><span>{open.length}</span></div>
        <ActionRows actions={open} services={services} />
      </section>
      {completed.length > 0 && <section class="dg-detail-section">
        <button class="dg-disclosure" onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? "▾" : "▸"} Completed Actions ({completed.length})</button>
        {showCompleted && <ActionRows actions={completed} services={services} />}
      </section>}
      <section class="dg-detail-section">
        <h3>Support material</h3>
        <div class="dg-path">{project.supportPath ?? "No support folder configured"}</div>
        <div class="dg-support-files">
          {support.map((file) => <button key={file.path} onClick={() => void services.openFile(file)}>{file.path.slice((project.supportPath?.length ?? -1) + 1)}</button>)}
          {project.supportPath && support.length === 0 && <span class="dg-muted">The support folder is empty.</span>}
        </div>
      </section>
    </div>
  );
}

function ActionRows({ actions, services }: { actions: Action[]; services: GtdServices }) {
  if (!actions.length) return <div class="dg-empty-row">No Actions.</div>;
  return <div class="dg-action-rows">{actions.sort((a, b) => a.title.localeCompare(b.title)).map((action) => (
    <div class="dg-action-row" key={action.id}>
      <button onClick={() => void services.openFile(action.file)}>{action.title}</button>
      <span>{title(action.status)}</span>
      {action.due && <span>{action.due}</span>}
      <button onClick={() => services.editAction(action.id)}>Edit</button>
    </div>
  ))}</div>;
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function MarkdownText({ services, markdown, sourcePath }: { services: GtdServices; markdown: string; sourcePath: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const component = new Component();
    component.load();
    ref.current.empty();
    void MarkdownRenderer.render(services.app, markdown, ref.current, sourcePath, component);
    return () => component.unload();
  }, [markdown, sourcePath]);
  return <div class="dg-outcome markdown-rendered" ref={ref} />;
}
