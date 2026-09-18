import { Component, MarkdownRenderer, Menu, Notice, Platform } from "obsidian";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Action, Project, ProjectStatus } from "../domain/types";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
import { useGtdSnapshot } from "../ui/hooks";
import type { GtdServices } from "../ui/services";

const BOARD_COLUMNS = ["active", "someday", "completed"] as const satisfies readonly ProjectStatus[];
type ProjectBoardStatus = (typeof BOARD_COLUMNS)[number];

export function ProjectsView({ services, initialProjectId = null }: { services: GtdServices; initialProjectId?: string | null }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId);
  const [optimistic, setOptimistic] = useState<Map<string, ProjectStatus>>(new Map());
  useEffect(() => setSelectedId(initialProjectId), [initialProjectId]);
  const selected = selectedId ? snapshot.projectsById.get(selectedId) : undefined;

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

  const projects = useMemo(() => snapshot.projects.map((project) => {
    const status = optimistic.get(project.id);
    return status ? { ...project, status } : project;
  }), [snapshot, optimistic]);
  const breadcrumbs = useMemo(() => projectBreadcrumbs(projects), [projects]);

  if (selected) return <ProjectDetail services={services} project={selected} onBack={() => setSelectedId(null)} onSelect={setSelectedId} />;

  const moveProject = async (id: string, status: ProjectBoardStatus) => {
    const previous = snapshot.projectsById.get(id)?.status;
    if (!previous || previous === status) return;
    setOptimistic((current) => new Map(current).set(id, status));
    try {
      await services.repository.setProjectStatus(id, status);
      await waitForProjectStatus(services, id, status);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not change Project status.");
    } finally {
      setOptimistic((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div class="dg-view dg-projects-view">
      <header class="dg-view-header">
        <div><h2>Projects</h2><span class="dg-count">{snapshot.projects.length}</span></div>
        <div class="dg-header-actions">
          <button onClick={() => services.createAction()}>New Action</button>
          <button class="mod-cta" onClick={() => services.createProject(false)}>New Project</button>
        </div>
      </header>
      <div class="dg-board dg-project-board" role="list" aria-label="Project board">
        {BOARD_COLUMNS.map((status) => {
          const columnProjects = projects
            .filter((project) => projectColumn(project.status) === status)
            .sort((a, b) => (breadcrumbs.get(a.id) ?? a.title).localeCompare(breadcrumbs.get(b.id) ?? b.title));
          return (
            <section
              class="dg-column dg-project-column"
              key={status}
              data-column={status}
              onDragOver={(event: DragEvent) => event.preventDefault()}
              onDrop={(event: DragEvent) => {
                event.preventDefault();
                const id = event.dataTransfer?.getData("text/dragonglass-project");
                if (id) void moveProject(id, status);
              }}
            >
              <header class="dg-column-header"><span>{projectStatusLabel(status)}</span><span>{columnProjects.length}</span></header>
              <div class="dg-card-list">
                {columnProjects.map((project) => (
                  <ProjectCard
                    key={`${project.id}-${project.file.path}`}
                    project={project}
                    actions={actionsByProject.get(project.id) ?? []}
                    services={services}
                    breadcrumb={breadcrumbs.get(project.id) ?? project.title}
                    onOpen={() => setSelectedId(project.id)}
                    onMove={moveProject}
                    onCreateSubproject={() => services.createProject(false, project.id)}
                  />
                ))}
                {columnProjects.length === 0 && <div class="dg-empty-row">No {projectStatusLabel(status).toLocaleLowerCase()} Projects.</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  actions,
  services,
  breadcrumb,
  onOpen,
  onMove,
  onCreateSubproject,
}: {
  key?: string;
  project: Project;
  actions: Action[];
  services: GtdServices;
  breadcrumb: string;
  onOpen: () => void;
  onMove: (id: string, status: ProjectBoardStatus) => Promise<void>;
  onCreateSubproject: () => void;
}) {
  const open = actions.filter((action) => action.status !== "done" && action.status !== "cancelled").length;
  const next = actions.filter((action) => action.status === "next").length;
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    for (const status of BOARD_COLUMNS) {
      menu.addItem((item) => item
        .setTitle(`${projectColumn(project.status) === status ? "✓ " : ""}${projectStatusLabel(status)}`)
        .onClick(() => void onMove(project.id, status)));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("New Action…").onClick(() => services.createAction(project.id)));
    menu.addItem((item) => item.setTitle("New sub-project…").onClick(onCreateSubproject));
    menu.addItem((item) => item.setTitle("Open note").onClick(() => void services.openFile(project.file)));
    menu.addItem((item) => item.setTitle("Edit…").onClick(() => services.editProject(project.id)));
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle("Delete Project…")
      .setIcon("trash-2")
      .setWarning(true)
      .onClick(() => void deleteProject()));
    menu.showAtMouseEvent(event);
  };
  const deleteProject = async () => {
    const snapshot = services.repository.index.getSnapshot();
    const children = snapshot.projects.filter((candidate) => candidate.parentProjectId === project.id);
    if (children.length) {
      new Notice(`Move or delete ${children.length} sub-project${children.length === 1 ? "" : "s"} first.`);
      return;
    }
    const linkedActions = snapshot.actions.filter((action) => action.projectId === project.id).length;
    const supportFiles = services.repository.supportFiles(project).length;
    const supportDescription = project.supportPath
      ? `${supportFiles} support file${supportFiles === 1 ? "" : "s"} in “${project.supportPath}”`
      : "no configured support folder";
    const confirmed = window.confirm(
      `Delete “${project.title}”?\n\nThis moves the Project note, ${linkedActions} directly linked Action${linkedActions === 1 ? "" : "s"}, and ${supportDescription} to Obsidian's trash.`,
    );
    if (!confirmed) return;
    try {
      await services.repository.trashProject(project.id);
      new Notice(`Deleted Project, ${linkedActions} Action${linkedActions === 1 ? "" : "s"}, and its support material.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not delete the Project.");
    }
  };

  return (
    <article
      class="dg-card dg-project-card"
      role="listitem"
      data-project-card={project.id}
      tabIndex={0}
      draggable={!Platform.isMobile}
      onDragStart={(event: DragEvent) => event.dataTransfer?.setData("text/dragonglass-project", project.id)}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Enter") { event.preventDefault(); onOpen(); }
      }}
    >
      <div class="dg-card-title-row">
        <button class="dg-card-title" onClick={onOpen}>{project.title}</button>
        <button class="dg-icon-button" aria-label={`Actions for ${project.title}`} onClick={openMenu}>•••</button>
      </div>
      {breadcrumb !== project.title && <div class="dg-project-lineage" title={breadcrumb}>{breadcrumb}</div>}
      {project.area && <div class="dg-project-area">{project.area}</div>}
      <div class="dg-project-metrics">
        <span><strong>{open}</strong> open</span>
        <span><strong>{next}</strong> next</span>
      </div>
      {project.reviewed && <div class="dg-project-reviewed">Reviewed {project.reviewed}</div>}
      {open === 0 && project.status === "active" && <div class="dg-project-health">No open Actions</div>}
      {open > 0 && next === 0 && project.status === "active" && <div class="dg-project-health">No Next Action</div>}
    </article>
  );
}

function projectColumn(status: ProjectStatus): ProjectBoardStatus | null {
  if (status === "active") return "active";
  if (status === "someday" || status === "completed") return status;
  return null;
}

function projectStatusLabel(status: ProjectStatus): string {
  return status === "someday" ? "Someday/Maybe" : title(status);
}

function waitForProjectStatus(services: GtdServices, id: string, status: ProjectStatus): Promise<void> {
  if (services.repository.index.getSnapshot().projectsById.get(id)?.status === status) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {};
    const timeout = window.setTimeout(() => { unsubscribe(); resolve(); }, 1500);
    unsubscribe = services.repository.index.subscribe(() => {
      if (services.repository.index.getSnapshot().projectsById.get(id)?.status !== status) return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

function ProjectDetail({ services, project, onBack, onSelect }: { services: GtdServices; project: Project; onBack: () => void; onSelect: (id: string) => void }) {
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
  const breadcrumbs = projectBreadcrumbs(snapshot.projects);
  const breadcrumb = breadcrumbs.get(project.id) ?? project.title;
  const parent = project.parentProjectId ? snapshot.projectsById.get(project.parentProjectId) : undefined;
  const children = snapshot.projects
    .filter((candidate) => candidate.parentProjectId === project.id)
    .sort((left, right) => (breadcrumbs.get(left.id) ?? left.title).localeCompare(breadcrumbs.get(right.id) ?? right.title));
  const hasHierarchy = Boolean(parent || project.parentProjectId || children.length > 0);

  return (
    <div class="dg-view dg-project-detail">
      <header class="dg-view-header">
        <div class="dg-detail-heading">
          <button onClick={onBack}>← Projects</button>
          <h2>{project.title}</h2>
          <span class={`dg-status dg-status-${project.status}`}>{projectStatusLabel(project.status)}</span>
        </div>
        <div class="dg-header-actions">
          <button class="mod-cta" onClick={() => services.createAction(project.id)}>New Action</button>
          <button onClick={() => void services.openFile(project.file)}>Open note</button>
          <button onClick={() => services.createProject(false, project.id)}>New sub-project</button>
          <button onClick={() => services.editProject(project.id)}>Edit</button>
        </div>
      </header>
      <main class="dg-project-detail-content">
        <div class={`dg-project-overview-grid${hasHierarchy ? "" : " is-single"}`}>
          <section class="dg-detail-section dg-project-outcome-panel">
            <div class="dg-detail-section-heading"><div><span class="dg-detail-eyebrow">Outcome</span><h3>Desired outcome</h3></div></div>
            {outcome ? <MarkdownText services={services} markdown={outcome} sourcePath={project.file.path} /> : <div class="dg-detail-empty">No desired outcome written yet.</div>}
          </section>
          {hasHierarchy && <section class="dg-detail-section dg-project-hierarchy">
            <div class="dg-detail-section-heading"><div><span class="dg-detail-eyebrow">Structure</span><h3>Project hierarchy</h3></div></div>
            <div class="dg-project-breadcrumb" title={breadcrumb}>{breadcrumb}</div>
            {parent
              ? <div><span>Parent</span><button onClick={() => onSelect(parent.id)}>{breadcrumbs.get(parent.id) ?? parent.title}</button></div>
              : project.parentProjectId && <div class="dg-missing">Missing parent Project: {project.parentProjectId}</div>}
            {children.length > 0 && <div><span>Sub-projects</span><div class="dg-hierarchy-links">{children.map((child) => <button key={child.id} onClick={() => onSelect(child.id)}>{breadcrumbs.get(child.id) ?? child.title}</button>)}</div></div>}
          </section>}
        </div>

        <section class="dg-detail-section dg-project-actions-panel">
          <div class="dg-detail-section-heading">
            <div><span class="dg-detail-eyebrow">Work</span><h3>Open Actions</h3></div>
            <span class="dg-detail-count">{open.length}</span>
          </div>
          <ActionRows actions={open} services={services} emptyText="No open Actions for this Project." />
        </section>

        {completed.length > 0 && <section class="dg-detail-section dg-completed-actions-panel">
          <button class="dg-disclosure" onClick={() => setShowCompleted(!showCompleted)}>
            <span>{showCompleted ? "▾" : "▸"} Completed Actions</span><span class="dg-detail-count">{completed.length}</span>
          </button>
          {showCompleted && <ActionRows actions={completed} services={services} />}
        </section>}

        <section class="dg-detail-section dg-support-panel">
          <div class="dg-detail-section-heading"><div><span class="dg-detail-eyebrow">Files</span><h3>Support material</h3></div><span class="dg-detail-count">{support.length}</span></div>
          <div class="dg-path">{project.supportPath ?? "No support folder configured"}</div>
          <div class="dg-support-files">
            {support.map((file) => <button key={file.path} onClick={() => void services.openFile(file)}>{file.path.slice((project.supportPath?.length ?? -1) + 1)}</button>)}
            {project.supportPath && support.length === 0 && <span class="dg-muted">The support folder is empty.</span>}
          </div>
        </section>
      </main>
    </div>
  );
}

function ActionRows({ actions, services, emptyText = "No Actions." }: { actions: Action[]; services: GtdServices; emptyText?: string }) {
  if (!actions.length) return <div class="dg-project-actions-empty"><span>✓</span><div><strong>Nothing here</strong><small>{emptyText}</small></div></div>;
  return <div class="dg-action-rows">{actions.sort((a, b) => a.title.localeCompare(b.title)).map((action) => (
    <div class="dg-action-row" key={action.id}>
      <div class="dg-action-row-main">
        <button class="dg-action-row-title" onClick={() => void services.openFile(action.file)}>{action.title}</button>
        <div class="dg-action-row-meta">
          <span class={`dg-action-status dg-action-status-${action.status}`}>{title(action.status)}</span>
          {action.context && <span>@{action.context}</span>}
          {action.energy && <span>{action.energy} energy</span>}
          {action.due && <span>Due {action.due}</span>}
        </div>
      </div>
      <button class="dg-action-row-edit" aria-label={`Edit ${action.title}`} onClick={() => services.editAction(action.id)}>Edit</button>
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
