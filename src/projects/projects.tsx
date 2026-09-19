import { Component, MarkdownRenderer, Menu, Notice, Platform, type TFile } from "obsidian";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Action, Project, ProjectStatus } from "../domain/types";
import type { DiaryEntry } from "../utils/markdown";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
import { ActionRows } from "../ui/action-rows";
import { confirmDeleteProject } from "../ui/delete-project";
import { useGtdSnapshot } from "../ui/hooks";
import type { GtdServices } from "../ui/services";

const BOARD_COLUMNS = ["active", "backlog", "someday", "completed"] as const satisfies readonly ProjectStatus[];
type ProjectBoardStatus = (typeof BOARD_COLUMNS)[number];
const SUBPROJECT_COLUMNS = ["active", "backlog", "completed"] as const satisfies readonly ProjectStatus[];
type SubprojectColumnStatus = (typeof SUBPROJECT_COLUMNS)[number];
const SUBPROJECT_COLUMN_LABELS: Record<SubprojectColumnStatus, string> = { active: "Active", backlog: "Backlog", completed: "Done" };
const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

export function ProjectsView({ services, initialProjectId = null }: { services: GtdServices; initialProjectId?: string | null }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId);
  const [optimistic, setOptimistic] = useState<Map<string, ProjectStatus>>(new Map());
  const [search, setSearch] = useState("");
  const [showSubprojects, setShowSubprojects] = useState(true);
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
  const searchQuery = search.trim().toLocaleLowerCase();
  const matchesSearch = (project: Project) => !searchQuery || [
    project.title,
    breadcrumbs.get(project.id) ?? "",
    project.area ?? "",
  ].some((value) => value.toLocaleLowerCase().includes(searchQuery));

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
      <div class="dg-toolbar dg-project-toolbar">
        <input
          type="search"
          placeholder="Search Projects"
          value={search}
          onInput={(event: Event) => setSearch((event.currentTarget as HTMLInputElement).value)}
        />
        <button
          class={showSubprojects ? "is-active" : ""}
          aria-pressed={showSubprojects}
          title={showSubprojects ? "Hide sub-projects" : "Show sub-projects"}
          onClick={() => setShowSubprojects(!showSubprojects)}
        >Sub-projects</button>
      </div>
      <div class="dg-board dg-project-board" role="list" aria-label="Project board">
        {BOARD_COLUMNS.map((status) => {
          const columnProjects = projects
            .filter((project) => projectColumn(project.status) === status
              && matchesSearch(project)
              && (showSubprojects || !project.parentProjectId))
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
      .onClick(() => void confirmDeleteProject(services, project.id)));
    menu.showAtMouseEvent(event);
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
        <button class="dg-card-title" title={breadcrumb} onClick={onOpen}>{project.title}</button>
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
  if (status === "backlog" || status === "someday" || status === "completed") return status;
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
  const [optimisticSubprojectStatuses, setOptimisticSubprojectStatuses] = useState<Map<string, ProjectStatus>>(new Map());
  const [supportNoteTitle, setSupportNoteTitle] = useState("");
  const [creatingSupportNote, setCreatingSupportNote] = useState(false);
  const [newSupportNotePath, setNewSupportNotePath] = useState("");
  useEffect(() => {
    let active = true;
    void services.repository.readDesiredOutcome(project).then((value) => { if (active) setOutcome(value); });
    return () => { active = false; };
  }, [project.file.stat.mtime, project.file.path]);
  const all = snapshot.actions.filter((action) => action.projectId === project.id);
  const open = all.filter((action) => action.status !== "done" && action.status !== "cancelled");
  const completed = all.filter((action) => action.status === "done");
  const support = services.repository.supportFiles(project);
  const supportNotes = support
    .filter((file) => isEditableSupportNote(services, file))
    .sort((left, right) => left.path.localeCompare(right.path));
  const supportImages = support
    .filter(isSupportImage)
    .sort((left, right) => left.path.localeCompare(right.path));
  const supportAttachments = support
    .filter((file) => !isEditableSupportNote(services, file) && !isSupportImage(file))
    .sort((left, right) => left.path.localeCompare(right.path));
  const breadcrumbs = projectBreadcrumbs(snapshot.projects);
  const parent = project.parentProjectId ? snapshot.projectsById.get(project.parentProjectId) : undefined;
  const children = snapshot.projects
    .filter((candidate) => candidate.parentProjectId === project.id)
    .map((child) => {
      const status = optimisticSubprojectStatuses.get(child.id);
      return status ? { ...child, status } : child;
    })
    .sort((left, right) => (breadcrumbs.get(left.id) ?? left.title).localeCompare(breadcrumbs.get(right.id) ?? right.title));
  const activeChildren = children.filter((child) => child.status === "active");
  const backlogChildren = children.filter((child) => child.status === "backlog");
  const completedChildren = children.filter((child) => child.status === "completed");
  const otherChildren = children.filter((child) => !SUBPROJECT_COLUMNS.includes(child.status as SubprojectColumnStatus));
  const hasParent = Boolean(parent || project.parentProjectId);

  const moveSubproject = async (id: string, status: SubprojectColumnStatus) => {
    const previous = snapshot.projectsById.get(id)?.status;
    if (!previous || previous === status) return;
    setOptimisticSubprojectStatuses((current) => new Map(current).set(id, status));
    try {
      await services.repository.setProjectStatus(id, status);
      await waitForProjectStatus(services, id, status);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not change the sub-project status.");
    } finally {
      setOptimisticSubprojectStatuses((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    }
  };

  const createSupportNote = async () => {
    const title = supportNoteTitle.trim();
    if (!title || creatingSupportNote) return;
    setCreatingSupportNote(true);
    try {
      const file = await services.repository.createProjectSupportNote(project.id, title);
      setSupportNoteTitle("");
      setNewSupportNotePath(file.path);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not create the support note.");
    } finally {
      setCreatingSupportNote(false);
    }
  };

  return (
    <div class="dg-view dg-project-detail">
      <header class="dg-view-header">
        <div class="dg-detail-heading">
          <button onClick={onBack}>← Projects</button>
          <h2>{project.title}</h2>
          <span class={`dg-status dg-status-${project.status}`}>{projectStatusLabel(project.status)}</span>
        </div>
        <div class="dg-header-actions">
          <button onClick={() => void services.openFile(project.file)}>Open note</button>
          <button onClick={() => services.editProject(project.id)}>Edit</button>
        </div>
      </header>
      <main class="dg-project-detail-content">
        <div class={`dg-project-overview-grid${hasParent ? "" : " is-single"}`}>
          <section class="dg-detail-section dg-project-outcome-panel">
            <div class="dg-detail-section-heading"><div><span class="dg-detail-eyebrow">Outcome</span><h3>Desired outcome</h3></div></div>
            {outcome ? <MarkdownText services={services} markdown={outcome} sourcePath={project.file.path} /> : <div class="dg-detail-empty">No desired outcome written yet.</div>}
          </section>
          {hasParent && <section class="dg-detail-section dg-project-parent-panel">
            {parent
              ? <div><span>Parent</span><button onClick={() => onSelect(parent.id)}>{parent.title}</button></div>
              : project.parentProjectId && <div class="dg-missing">Missing parent Project: {project.parentProjectId}</div>}
          </section>}
        </div>

        <section class="dg-detail-section dg-project-actions-panel">
          <div class="dg-detail-section-heading">
            <div><span class="dg-detail-eyebrow">Work</span><h3>Open Actions</h3></div>
            <div class="dg-detail-section-actions">
              <span class="dg-detail-count">{open.length}</span>
              <button onClick={() => services.importActions(project.id)}>Import…</button>
              <button class="mod-cta" onClick={() => services.createAction(project.id)}>New Action</button>
            </div>
          </div>
          <ActionRows actions={open} services={services} allowProjectConversion />
        </section>

        {completed.length > 0 && <section class="dg-detail-section dg-completed-actions-panel">
          <button class="dg-disclosure" onClick={() => setShowCompleted(!showCompleted)}>
            <span>{showCompleted ? "▾" : "▸"} Completed Actions</span><span class="dg-detail-count">{completed.length}</span>
          </button>
          {showCompleted && <ActionRows actions={completed} services={services} allowProjectConversion />}
        </section>}

        <section class="dg-detail-section dg-subprojects-panel">
          <div class="dg-detail-section-heading">
            <div><h3>Sub-projects</h3></div>
            <div class="dg-detail-section-actions">
              <span class="dg-detail-count">{children.length}</span>
              <button class="mod-cta" onClick={() => services.createProject(false, project.id)}>New sub-project</button>
            </div>
          </div>
          <div class="dg-subproject-columns">
            <SubprojectColumn status="active" projects={activeChildren} onSelect={onSelect} onMove={moveSubproject} />
            <SubprojectColumn status="backlog" projects={backlogChildren} onSelect={onSelect} onMove={moveSubproject} />
            <SubprojectColumn status="completed" projects={completedChildren} onSelect={onSelect} onMove={moveSubproject} />
          </div>
          {otherChildren.length > 0 && <div class="dg-subproject-other">
            <span>Other statuses</span>
            <div>{otherChildren.map((child) => <button key={child.id} onClick={() => onSelect(child.id)}><span>{child.title}</span><small>{projectStatusLabel(child.status)}</small></button>)}</div>
          </div>}
        </section>

        <ProjectDiary services={services} project={project} />

        <section class="dg-detail-section dg-support-panel">
          <div class="dg-detail-section-heading"><div><span class="dg-detail-eyebrow">Files</span><h3>Project Support Material</h3></div><span class="dg-detail-count">{support.length}</span></div>
          <div class="dg-support-note-create">
            <input
              value={supportNoteTitle}
              placeholder="Note title…"
              aria-label="New support note title"
              disabled={creatingSupportNote}
              onInput={(event: Event) => setSupportNoteTitle((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createSupportNote();
                }
              }}
            />
            <button class="mod-cta" disabled={!supportNoteTitle.trim() || creatingSupportNote} onClick={() => void createSupportNote()}>Create note</button>
          </div>
          <div class="dg-support-notes">
            {supportNotes.map((file) => <SupportNote
              key={file.path}
              services={services}
              projectId={project.id}
              file={file}
              label={supportFileLabel(file, project.supportPath)}
              startEditing={file.path === newSupportNotePath}
            />)}
            {supportImages.map((file) => <SupportImage
              key={file.path}
              services={services}
              file={file}
              label={supportFileLabel(file, project.supportPath)}
            />)}
          </div>
          {supportAttachments.length > 0 && <div class="dg-support-attachments">
            <span>Other files</span>
            <div>{supportAttachments.map((file) => <button key={file.path} onClick={() => void services.openFile(file)}>{supportFileLabel(file, project.supportPath)}</button>)}</div>
          </div>}
          {support.length === 0 && <span class="dg-support-empty">No support material yet.</span>}
        </section>
      </main>
    </div>
  );
}

function ProjectDiary({ services, project }: { services: GtdServices; project: Project }) {
  const [entries, setEntries] = useState<DiaryEntry[] | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void services.repository.readProjectDiary(project)
      .then((value) => { if (active) setEntries(value); })
      .catch(() => { if (active) setEntries([]); });
    return () => { active = false; };
  }, [project.file.stat.mtime, project.file.path]);

  const addEntry = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      const entry = await services.repository.addProjectDiaryEntry(project.id, text);
      setEntries((current) => [entry, ...(current ?? [])]);
      setDraft("");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not add the Diary entry.");
    } finally {
      setSaving(false);
    }
  };

  return <section class="dg-detail-section dg-project-diary-panel">
    <div class="dg-detail-section-heading">
      <div><span class="dg-detail-eyebrow">Log</span><h3>Diary</h3></div>
      <span class="dg-detail-count">{entries?.length ?? 0}</span>
    </div>
    <div class="dg-diary-add">
      <textarea
        value={draft}
        rows={3}
        aria-label="New Diary entry"
        placeholder="Observation or decision… (⌘/Ctrl+Enter to add)"
        onInput={(event: Event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(event: KeyboardEvent) => {
          // Enter stays a line break so pasted formatting survives.
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          void addEntry();
        }}
      />
      <button class="mod-cta" disabled={!draft.trim() || saving} onClick={() => void addEntry()}>Add entry</button>
    </div>
    <div class="dg-diary-list">
      {entries === null
        ? <span class="dg-muted">Loading…</span>
        : entries.length
          ? entries.map((entry, index) => <div key={`${entry.timestamp ?? ""}-${index}`}><span>{entry.timestamp}</span><p>{entry.text}</p></div>)
          : <span class="dg-muted">No entries yet.</span>}
    </div>
  </section>;
}

function SupportImage({ services, file, label: imageLabel }: {
  services: GtdServices;
  file: TFile;
  label: string;
}) {
  const [open, setOpen] = useState(true);
  const [failed, setFailed] = useState(false);
  return <article class={`dg-support-note dg-support-image${open ? " is-open" : ""}`}>
    <header>
      <button class="dg-support-note-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span title={imageLabel}>{imageLabel}</span>
      </button>
      <div><button onClick={() => void services.openFile(file)}>Open</button></div>
    </header>
    {open && <div class="dg-support-note-body dg-support-image-body">
      {failed
        ? <span class="dg-muted">Could not display this image.</span>
        : <img
          src={services.app.vault.getResourcePath(file)}
          alt={file.basename}
          loading="lazy"
          onError={() => setFailed(true)}
        />}
    </div>}
  </article>;
}

function SupportNote({ services, projectId, file, label: noteLabel, startEditing }: {
  services: GtdServices;
  projectId: string;
  file: TFile;
  label: string;
  startEditing: boolean;
}) {
  const [open, setOpen] = useState(startEditing);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async (): Promise<string | null> => {
    setLoading(true);
    try {
      const body = await services.repository.readProjectSupportNote(projectId, file.path);
      setContent(body);
      setDraft(body);
      return body;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not read the support note.");
      return null;
    } finally {
      setLoading(false);
    }
  };

  const beginEditing = async () => {
    setOpen(true);
    const body = await load();
    if (body !== null) setEditing(true);
  };

  useEffect(() => {
    if (startEditing) void beginEditing();
  }, [file.path, startEditing]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !editing) void load();
  };

  const save = async () => {
    setSaving(true);
    try {
      await services.repository.updateProjectSupportNote(projectId, file.path, draft);
      setContent(draft.trimEnd());
      setEditing(false);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not save the support note.");
    } finally {
      setSaving(false);
    }
  };

  return <article class={`dg-support-note${open ? " is-open" : ""}`}>
    <header>
      <button class="dg-support-note-toggle" onClick={toggle} aria-expanded={open}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span title={noteLabel}>{noteLabel}</span>
      </button>
      <div>
        <button onClick={() => void services.openFile(file)}>Open</button>
        <button onClick={() => void beginEditing()}>Edit</button>
      </div>
    </header>
    {open && <div class="dg-support-note-body">
      {loading && content === null
        ? <span class="dg-muted">Loading…</span>
        : editing
          ? <>
            <textarea value={draft} aria-label={`Edit ${noteLabel}`} onInput={(event: Event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)} />
            <div class="dg-support-note-edit-actions">
              <button disabled={saving} onClick={() => { setDraft(content ?? ""); setEditing(false); }}>Cancel</button>
              <button class="mod-cta" disabled={saving} onClick={() => void save()}>Save note</button>
            </div>
          </>
          : content
            ? <MarkdownText services={services} markdown={content} sourcePath={file.path} />
            : <span class="dg-muted">This note is empty.</span>}
    </div>}
  </article>;
}

function isEditableSupportNote(services: GtdServices, file: TFile): boolean {
  if (file.extension !== "md") return false;
  const type = services.app.metadataCache.getFileCache(file)?.frontmatter?.type;
  return type !== "gtd-action" && type !== "gtd-project" && type !== "gtd-inbox-item";
}

function isSupportImage(file: TFile): boolean {
  return IMAGE_EXTENSIONS.has(file.extension.toLocaleLowerCase());
}

function supportFileLabel(file: TFile, supportPath?: string): string {
  return supportPath && file.path.startsWith(`${supportPath}/`)
    ? file.path.slice(supportPath.length + 1)
    : file.name;
}

function SubprojectColumn({ status, projects, onSelect, onMove }: {
  status: SubprojectColumnStatus;
  projects: Project[];
  onSelect: (id: string) => void;
  onMove: (id: string, status: SubprojectColumnStatus) => Promise<void>;
}) {
  const columnTitle = SUBPROJECT_COLUMN_LABELS[status];
  return <div
    class="dg-subproject-column"
    data-subproject-column={status}
    onDragOver={(event: DragEvent) => event.preventDefault()}
    onDrop={(event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer?.getData("text/dragonglass-subproject");
      if (id) void onMove(id, status);
    }}
  >
    <header><strong>{columnTitle}</strong><span>{projects.length}</span></header>
    <div class="dg-subproject-list">
      {projects.map((child) => <article
        class="dg-subproject-card"
        key={child.id}
        draggable={!Platform.isMobile}
        onDragStart={(event: DragEvent) => event.dataTransfer?.setData("text/dragonglass-subproject", child.id)}
      >
        <button class="dg-subproject-title" title={child.title} onClick={() => onSelect(child.id)}>{child.title}</button>
      </article>)}
      {projects.length === 0 && <div class="dg-subproject-empty">No {columnTitle.toLocaleLowerCase()} sub-projects.</div>}
    </div>
  </div>;
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
