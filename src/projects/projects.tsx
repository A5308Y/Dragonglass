import { Component, Keymap, MarkdownRenderer, Menu, Notice, Platform, type TFile } from "obsidian";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Action, Project, ProjectStatus } from "../domain/types";
import type { DiaryEntry } from "../utils/markdown";
import { activeDescendantCounts, projectBreadcrumbs } from "../domain/project-hierarchy";
import {
  activeProjectBlockers,
  compareProjectPriority,
  normalizeProjectTags,
  projectActionIssue,
  projectPlacementsAfterMove,
  type ProjectPlacement,
} from "../domain/project-board";
import { ActionRows } from "../ui/action-rows";
import { confirmDeleteProject, confirmDeleteProjects } from "../ui/delete-project";
import { useGtdSnapshot } from "../ui/hooks";
import { isVaultImage, resolveVaultImage } from "../ui/image-input";
import { BatchProjectParentModal, BatchProjectTagsModal, ProjectDependenciesModal } from "../ui/modals";
import type { GtdServices } from "../ui/services";

const BOARD_COLUMNS = ["active", "backlog", "someday", "completed"] as const satisfies readonly ProjectStatus[];
type ProjectBoardStatus = (typeof BOARD_COLUMNS)[number];
const PRIMARY_SUBPROJECT_COLUMNS = ["active", "backlog"] as const satisfies readonly ProjectStatus[];
const SECONDARY_SUBPROJECT_COLUMNS = ["someday", "completed"] as const satisfies readonly ProjectStatus[];
const SUBPROJECT_COLUMNS = [...PRIMARY_SUBPROJECT_COLUMNS, ...SECONDARY_SUBPROJECT_COLUMNS] as const;
type SubprojectColumnStatus = (typeof SUBPROJECT_COLUMNS)[number];
const SUBPROJECT_COLUMN_LABELS: Record<SubprojectColumnStatus, string> = { active: "Active", backlog: "Backlog", someday: "Someday/Maybe", completed: "Done" };

export function ProjectsView({ services, initialProjectId = null }: { services: GtdServices; initialProjectId?: string | null }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId);
  const [returnProjectId, setReturnProjectId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Map<string, ProjectStatus>>(new Map());
  const [search, setSearch] = useState("");
  const [showSubprojects, setShowSubprojects] = useState(true);
  const [showImages, setShowImages] = useState(() => services.getSettings().showProjectBoardImages);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const boardRef = useRef<HTMLDivElement>(null);
  const [visibleColumns, setVisibleColumns] = useState<ProjectBoardStatus[]>(() => {
    const configured = services.getSettings().projectBoardColumns;
    const valid = configured.filter((status): status is ProjectBoardStatus => BOARD_COLUMNS.includes(status as ProjectBoardStatus));
    return valid.length ? valid : [...BOARD_COLUMNS];
  });
  useEffect(() => setSelectedId(initialProjectId), [initialProjectId]);
  const selected = selectedId ? snapshot.projectsById.get(selectedId) : undefined;

  useEffect(() => {
    if (selected || !returnProjectId) return;
    const frame = window.requestAnimationFrame(() => {
      const card = [...(boardRef.current?.querySelectorAll<HTMLElement>("[data-project-card]") ?? [])]
        .find((candidate) => candidate.dataset.projectCard === returnProjectId);
      card?.scrollIntoView({ block: "center", inline: "center" });
      setReturnProjectId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected, returnProjectId]);

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

  // The vault, not the index, owns support material, but every vault change rebuilds the snapshot.
  const supportFileCounts = useMemo(() => services.repository.supportFileCounts(), [snapshot]);

  const projects = useMemo(() => snapshot.projects.map((project) => {
    const status = optimistic.get(project.id);
    return status ? { ...project, status } : project;
  }), [snapshot, optimistic]);
  const breadcrumbs = useMemo(() => projectBreadcrumbs(projects), [projects]);
  // Read from the optimistic list so a card's count follows a sub-project drag straight away.
  const activeSubprojectCounts = useMemo(() => activeDescendantCounts(projects), [projects]);
  const searchQuery = search.trim().toLocaleLowerCase();

  const columnProjects = useMemo(() => {
    const matchesSearch = (project: Project) => !searchQuery || [
      project.title,
      breadcrumbs.get(project.id) ?? "",
      project.area ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(searchQuery));
    const result = new Map<ProjectBoardStatus, Project[]>(BOARD_COLUMNS.map((status) => [status, []]));
    for (const project of projects) {
      const column = projectColumn(project.status);
      if (!column || !visibleColumns.includes(column)) continue;
      if (!matchesSearch(project) || (!showSubprojects && project.parentProjectId)) continue;
      result.get(column)!.push(project);
    }
    for (const column of result.values()) {
      column.sort((a, b) => (breadcrumbs.get(a.id) ?? a.title).localeCompare(breadcrumbs.get(b.id) ?? b.title));
    }
    return result;
  }, [projects, breadcrumbs, searchQuery, visibleColumns, showSubprojects]);

  // Selections survive searching and column changes, but never a deleted Project.
  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => snapshot.projectsById.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [snapshot]);

  if (selected) return <ProjectDetail services={services} project={selected} onBack={() => {
    setReturnProjectId(selected.id);
    setSelectedId(null);
  }} onSelect={setSelectedId} />;

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

  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const changeSelecting = (active: boolean) => {
    setSelecting(active);
    if (!active) setSelectedIds(new Set());
  };

  const batchIds = [...selectedIds];
  const clearSelection = () => setSelectedIds(new Set());
  const deleteSelected = async () => {
    if (await confirmDeleteProjects(services, batchIds)) clearSelection();
  };

  const changeVisibleColumns = async (columns: ProjectBoardStatus[]) => {
    if (!columns.length) return;
    const previous = visibleColumns;
    setVisibleColumns(columns);
    try {
      await services.saveSettings({ ...services.getSettings(), projectBoardColumns: columns }, false);
    } catch (error) {
      setVisibleColumns(previous);
      new Notice(error instanceof Error ? error.message : "Could not save the Project board columns.");
    }
  };

  const changeShowImages = async (visible: boolean) => {
    const previous = showImages;
    setShowImages(visible);
    try {
      await services.saveSettings({ ...services.getSettings(), showProjectBoardImages: visible }, false);
    } catch (error) {
      setShowImages(previous);
      new Notice(error instanceof Error ? error.message : "Could not save the Project board image preference.");
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
        <button class={columnsOpen ? "is-active" : ""} onClick={() => setColumnsOpen(!columnsOpen)}>Columns</button>
        <button class={selecting ? "is-active" : ""} aria-pressed={selecting} onClick={() => changeSelecting(!selecting)}>Select</button>
        <label class="dg-toolbar-toggle" title="Show project images on board cards">
          <input
            type="checkbox"
            checked={showImages}
            onChange={(event: Event) => void changeShowImages((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>Images</span>
        </label>
        <label class="dg-toolbar-toggle" title="Show sub-projects on the board">
          <input
            type="checkbox"
            checked={showSubprojects}
            onChange={(event: Event) => setShowSubprojects((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>Sub-projects</span>
        </label>
      </div>
      {columnsOpen && <ProjectColumnPicker visible={visibleColumns} onChange={(columns) => void changeVisibleColumns(columns)} />}
      {selecting && <ProjectBatchBar
        count={batchIds.length}
        onSelectAll={() => setSelectedIds(new Set([...columnProjects.values()].flat().map((project) => project.id)))}
        onClear={clearSelection}
        onAddTags={() => new BatchProjectTagsModal(services, batchIds, clearSelection).open()}
        onSetParent={() => new BatchProjectParentModal(services, batchIds, clearSelection).open()}
        onDelete={() => void deleteSelected()}
      />}
      <div ref={boardRef} class="dg-board dg-project-board" role="list">
        {BOARD_COLUMNS.filter((status) => visibleColumns.includes(status)).map((status) => {
          const column = columnProjects.get(status) ?? [];
          const issueCount = status === "active"
            ? column.filter((project) => projectActionIssue(project, actionsByProject.get(project.id) ?? []) !== null).length
            : null;
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
              <header class="dg-column-header">
                <span>{projectStatusLabel(status)}</span>
                <span class="dg-project-column-counts">
                  <span title="Projects in column">{column.length}</span>
                  {issueCount !== null && <span class="dg-project-column-health" title="Active Projects with Action issues">{issueCount} issues</span>}
                </span>
              </header>
              <div class="dg-card-list">
                {column.map((project) => (
                  <ProjectCard
                    key={`${project.id}-${project.file.path}`}
                    project={project}
                    actions={actionsByProject.get(project.id) ?? []}
                    services={services}
                    showImage={showImages}
                    breadcrumb={breadcrumbs.get(project.id) ?? project.title}
                    subprojects={activeSubprojectCounts.get(project.id) ?? 0}
                    supportFiles={supportFileCounts.get(project.id) ?? 0}
                    selecting={selecting}
                    selected={selectedIds.has(project.id)}
                    onToggleSelected={() => toggleSelected(project.id)}
                    onOpen={() => setSelectedId(project.id)}
                    onMove={moveProject}
                    onCreateSubproject={() => services.createProject(false, project.id)}
                  />
                ))}
                {column.length === 0 && <div class="dg-empty-row">No {projectStatusLabel(status).toLocaleLowerCase()} Projects.</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ProjectBatchBar({ count, onSelectAll, onClear, onAddTags, onSetParent, onDelete }: {
  count: number;
  onSelectAll: () => void;
  onClear: () => void;
  onAddTags: () => void;
  onSetParent: () => void;
  onDelete: () => void;
}) {
  return <div class="dg-panel dg-batch-bar" role="toolbar" aria-label="Batch Project actions">
    <span class="dg-batch-count"><strong>{count}</strong> selected</span>
    <button disabled={!count} onClick={onAddTags}>Add tag…</button>
    <button disabled={!count} onClick={onSetParent}>Set parent…</button>
    <button class="dg-batch-delete" disabled={!count} onClick={onDelete}>Delete…</button>
    <span class="dg-batch-spacer" />
    <button onClick={onSelectAll}>Select all shown</button>
    <button disabled={!count} onClick={onClear}>Clear</button>
  </div>;
}

function ProjectColumnPicker({ visible, onChange }: {
  visible: readonly ProjectBoardStatus[];
  onChange: (columns: ProjectBoardStatus[]) => void;
}) {
  const selected = new Set(visible);
  return <div class="dg-panel dg-column-picker">{BOARD_COLUMNS.map((status) => {
    const checked = selected.has(status);
    return <label key={status}>
      <input
        type="checkbox"
        checked={checked}
        disabled={checked && selected.size === 1}
        onChange={() => {
          if (checked) selected.delete(status);
          else selected.add(status);
          onChange(BOARD_COLUMNS.filter((candidate) => selected.has(candidate)));
        }}
      />
      {projectStatusLabel(status)}
    </label>;
  })}</div>;
}

function ProjectCard({
  project,
  actions,
  services,
  showImage,
  breadcrumb,
  subprojects,
  supportFiles,
  selecting,
  selected,
  onToggleSelected,
  onOpen,
  onMove,
  onCreateSubproject,
}: {
  key?: string;
  project: Project;
  actions: Action[];
  services: GtdServices;
  showImage: boolean;
  breadcrumb: string;
  subprojects: number;
  supportFiles: number;
  selecting: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
  onMove: (id: string, status: ProjectBoardStatus) => Promise<void>;
  onCreateSubproject: () => void;
}) {
  const open = actions.filter((action) => action.status !== "done" && action.status !== "cancelled").length;
  const actionIssue = projectActionIssue(project, actions);
  const image = showImage ? projectImageFile(services, project) : null;
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
      class={`dg-card dg-project-card${selecting ? " is-selectable" : ""}${selecting && selected ? " is-selected" : ""}`}
      role="listitem"
      data-project-card={project.id}
      tabIndex={0}
      draggable={!Platform.isMobile && !selecting}
      onDragStart={(event: DragEvent) => event.dataTransfer?.setData("text/dragonglass-project", project.id)}
      onClick={() => { if (selecting) onToggleSelected(); }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter" && !(selecting && event.key === " ")) return;
        event.preventDefault();
        if (selecting) onToggleSelected();
        else onOpen();
      }}
    >
      {image && <div class="dg-project-card-image"><img src={services.app.vault.getResourcePath(image)} alt="" loading="lazy" /></div>}
      <div class="dg-card-title-row">
        {selecting && <input
          class="dg-batch-checkbox"
          type="checkbox"
          checked={selected}
          aria-label={`Select ${project.title}`}
          onClick={(event: MouseEvent) => event.stopPropagation()}
          onChange={onToggleSelected}
        />}
        <button class="dg-card-title" title={breadcrumb} onClick={() => { if (!selecting) onOpen(); }}>{project.title}</button>
        <button class="dg-icon-button" aria-label={`Actions for ${project.title}`} onClick={openMenu}>•••</button>
      </div>
      {breadcrumb !== project.title && <div class="dg-project-lineage" title={breadcrumb}>{breadcrumb}</div>}
      {project.area && <div class="dg-project-area">{project.area}</div>}
      {Boolean(project.tags?.length) && <div class="dg-project-tags">{project.tags!.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
      <div class="dg-project-metrics">
        <span title="Open Actions"><strong>{open}</strong> open</span>
        <span title="Active sub-projects, at any depth"><strong>{subprojects}</strong> sub</span>
        <span title="Project support material files"><strong>{supportFiles}</strong> files</span>
      </div>
      {project.reviewed && <div class="dg-project-reviewed">Reviewed {project.reviewed}</div>}
      {project.status === "someday" && project.activateAt && <div class="dg-project-reviewed">Activates {project.activateAt}</div>}
      {actionIssue && <div class="dg-project-health">{actionIssue}</div>}
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

function waitForProjectPlacements(services: GtdServices, placements: ReadonlyMap<string, ProjectPlacement>): Promise<void> {
  const matches = () => {
    const projectsById = services.repository.index.getSnapshot().projectsById;
    return [...placements].every(([id, placement]) => {
      const project = projectsById.get(id);
      return project?.status === placement.status && project.order === placement.order;
    });
  };
  if (matches()) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {};
    const timeout = window.setTimeout(() => { unsubscribe(); resolve(); }, 1_500);
    unsubscribe = services.repository.index.subscribe(() => {
      if (!matches()) return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

function ProjectDetail({ services, project, onBack, onSelect }: { services: GtdServices; project: Project; onBack: () => void; onSelect: (id: string) => void }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showSecondarySubprojects, setShowSecondarySubprojects] = useState(false);
  const [optimisticSubprojectPlacements, setOptimisticSubprojectPlacements] = useState<Map<string, ProjectPlacement & { operation: number }>>(new Map());
  const optimisticSubprojectPlacementsRef = useRef(optimisticSubprojectPlacements);
  const nextPlacementOperation = useRef(0);
  const [subprojectTagFilters, setSubprojectTagFilters] = useState<string[]>([]);
  const [supportNoteTitle, setSupportNoteTitle] = useState("");
  const [creatingSupportNote, setCreatingSupportNote] = useState(false);
  const [newSupportNotePath, setNewSupportNotePath] = useState("");
  const [supportFolderPath, setSupportFolderPath] = useState("");
  const [creatingSupportFolder, setCreatingSupportFolder] = useState(false);
  const image = projectImageFile(services, project);
  useEffect(() => {
    setSubprojectTagFilters([]);
    setShowSecondarySubprojects(false);
    optimisticSubprojectPlacementsRef.current = new Map();
    setOptimisticSubprojectPlacements(new Map());
  }, [project.id]);
  const all = snapshot.actions.filter((action) => action.projectId === project.id);
  const open = all.filter((action) => action.status !== "done" && action.status !== "cancelled");
  const completed = all.filter((action) => action.status === "done");
  const support = services.repository.supportFiles(project);
  const supportFolders = services.repository.supportFolders(project);
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
      const placement = optimisticSubprojectPlacements.get(child.id);
      return placement ? { ...child, status: placement.status, order: placement.order } : child;
    })
    .sort(compareProjectPriority);
  const availableSubprojectTags = normalizeProjectTags(children.flatMap((child) => child.tags ?? []));
  const availableSubprojectTagKey = availableSubprojectTags.join("\0");
  useEffect(() => {
    setSubprojectTagFilters((current) => current.filter((tag) => availableSubprojectTags.includes(tag)));
  }, [project.id, availableSubprojectTagKey]);
  const visibleChildren = subprojectTagFilters.length
    ? children.filter((child) => subprojectTagFilters.every((tag) =>
      child.tags?.some((candidate) => candidate.toLocaleLowerCase() === tag.toLocaleLowerCase())
    ))
    : children;
  const childrenByStatus = new Map(SUBPROJECT_COLUMNS.map((status) => [status, visibleChildren.filter((child) => child.status === status)]));
  const secondarySubprojectCount = SECONDARY_SUBPROJECT_COLUMNS.reduce(
    (count, status) => count + (childrenByStatus.get(status)?.length ?? 0),
    0,
  );
  const otherChildren = visibleChildren.filter((child) => !SUBPROJECT_COLUMNS.includes(child.status as SubprojectColumnStatus));

  const moveSubproject = async (id: string, status: SubprojectColumnStatus, beforeId?: string) => {
    const currentChildren = snapshot.projects
      .filter((candidate) => candidate.parentProjectId === project.id)
      .map((child) => {
        const placement = optimisticSubprojectPlacementsRef.current.get(child.id);
        return placement ? { ...child, status: placement.status, order: placement.order } : child;
      });
    const placements = projectPlacementsAfterMove(currentChildren, id, status, beforeId);
    if (!placements.size) return;
    const operation = ++nextPlacementOperation.current;
    for (const [projectId, placement] of placements) {
      optimisticSubprojectPlacementsRef.current.set(projectId, { ...placement, operation });
    }
    setOptimisticSubprojectPlacements(new Map(optimisticSubprojectPlacementsRef.current));
    try {
      await Promise.all([...placements].map(([projectId, placement]) =>
        services.repository.updateProject(projectId, placement)
      ));
      await waitForProjectPlacements(services, placements);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not reorder the sub-projects.");
    } finally {
      for (const projectId of placements.keys()) {
        if (optimisticSubprojectPlacementsRef.current.get(projectId)?.operation === operation) {
          optimisticSubprojectPlacementsRef.current.delete(projectId);
        }
      }
      setOptimisticSubprojectPlacements(new Map(optimisticSubprojectPlacementsRef.current));
    }
  };

  const moveSubprojectPriority = (id: string, direction: -1 | 1) => {
    const child = children.find((candidate) => candidate.id === id);
    if (!child || !SUBPROJECT_COLUMNS.includes(child.status as SubprojectColumnStatus)) return;
    const status = child.status as SubprojectColumnStatus;
    const column = children.filter((candidate) => candidate.status === status).sort(compareProjectPriority);
    const index = column.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    const beforeId = direction < 0 ? column[index - 1]?.id : column[index + 2]?.id;
    if ((direction < 0 && index === 0) || (direction > 0 && index === column.length - 1)) return;
    void moveSubproject(id, status, beforeId);
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

  const createSupportFolder = async () => {
    const path = supportFolderPath.trim();
    if (!path || creatingSupportFolder) return;
    setCreatingSupportFolder(true);
    try {
      await services.repository.createProjectSupportFolder(project.id, path);
      setSupportFolderPath("");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not create the support folder.");
    } finally {
      setCreatingSupportFolder(false);
    }
  };

  return (
    <div class="dg-view dg-project-detail">
      <header class="dg-view-header">
        <div class="dg-detail-heading">
          {parent && <button
            class="dg-parent-back"
            title={`Back to ${parent.title}`}
            onClick={() => onSelect(parent.id)}
          >← {parent.title}</button>}
          {!parent && project.parentProjectId && <span class="dg-missing">Missing parent Project: {project.parentProjectId}</span>}
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
        {image && <div class="dg-project-main-image"><img src={services.app.vault.getResourcePath(image)} alt={`Main image for ${project.title}`} /></div>}
        <ProjectOutcome services={services} project={project} />

        <section class="dg-detail-section dg-project-actions-panel">
          <div class="dg-detail-section-heading">
            <div><span class="dg-detail-eyebrow">Work</span><h3>Open Actions</h3></div>
            <div class="dg-detail-section-actions">
              <span class="dg-detail-count">{open.length}</span>
              <button onClick={() => services.importActions(project.id)}>Import…</button>
              <button class="mod-cta" onClick={() => services.createAction(project.id)}>New Action</button>
            </div>
          </div>
          <ActionRows actions={open} services={services} allowProjectConversion linkTitles={false} />
        </section>

        {completed.length > 0 && <section class="dg-detail-section dg-completed-actions-panel">
          <button class="dg-disclosure" onClick={() => setShowCompleted(!showCompleted)}>
            <span>{showCompleted ? "▾" : "▸"} Completed Actions</span><span class="dg-detail-count">{completed.length}</span>
          </button>
          {showCompleted && <ActionRows actions={completed} services={services} allowProjectConversion linkTitles={false} />}
        </section>}

        <section class="dg-detail-section dg-subprojects-panel">
          <div class="dg-detail-section-heading">
            <div><span class="dg-detail-eyebrow">Board</span><h3>Sub-projects</h3></div>
            <div class="dg-detail-section-actions">
              <span class="dg-detail-count">{visibleChildren.length}{visibleChildren.length !== children.length ? `/${children.length}` : ""}</span>
              <button onClick={() => services.importSubprojects(project.id)}>Import…</button>
              <button class="mod-cta" onClick={() => services.createProject(false, project.id)}>New sub-project</button>
            </div>
          </div>
          {availableSubprojectTags.length > 0 && <div class="dg-subproject-toolbar">
            <span>Filter by tag</span>
            {availableSubprojectTags.map((tag) => <button
              key={tag}
              class={subprojectTagFilters.includes(tag) ? "is-active" : ""}
              onClick={() => setSubprojectTagFilters((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])}
            >#{tag}</button>)}
            {subprojectTagFilters.length > 0 && <button onClick={() => setSubprojectTagFilters([])}>Clear</button>}
          </div>}
          <div class="dg-subproject-columns dg-subproject-columns-primary">
            {PRIMARY_SUBPROJECT_COLUMNS.map((status) => <SubprojectColumn
              key={status}
              status={status}
              projects={childrenByStatus.get(status) ?? []}
              projectsById={snapshot.projectsById}
              services={services}
              onSelect={onSelect}
              onMove={moveSubproject}
              onMovePriority={moveSubprojectPriority}
            />)}
          </div>
          <div class={`dg-subproject-secondary${showSecondarySubprojects ? " is-open" : ""}`}>
            <button
              class="dg-disclosure dg-subproject-secondary-toggle"
              aria-expanded={showSecondarySubprojects}
              onClick={() => setShowSecondarySubprojects((current) => !current)}
            >
              <span>{showSecondarySubprojects ? "▾" : "▸"} Someday/Maybe and Done</span>
              <span class="dg-detail-count">{secondarySubprojectCount}</span>
            </button>
            {showSecondarySubprojects && <div class="dg-subproject-columns dg-subproject-columns-secondary">
              {SECONDARY_SUBPROJECT_COLUMNS.map((status) => <SubprojectColumn
                key={status}
                status={status}
                projects={childrenByStatus.get(status) ?? []}
                projectsById={snapshot.projectsById}
                services={services}
                onSelect={onSelect}
                onMove={moveSubproject}
                onMovePriority={moveSubprojectPriority}
              />)}
            </div>}
          </div>
          {otherChildren.length > 0 && <div class="dg-subproject-other">
            <span>Other statuses</span>
            <div>{otherChildren.map((child) => <button key={child.id} onClick={() => onSelect(child.id)}><span>{child.title}</span><small>{projectStatusLabel(child.status)}</small></button>)}</div>
          </div>}
        </section>

        <ProjectDiary services={services} project={project} />

        <section class="dg-detail-section dg-support-panel">
          <div class="dg-detail-section-heading">
            <div><span class="dg-detail-eyebrow">Files</span><h3>Project Support Material</h3></div>
            <span class="dg-detail-count">{support.length} files · {supportFolders.length} folders</span>
          </div>
          <div class="dg-support-create">
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
            <div class="dg-support-folder-create">
              <input
                value={supportFolderPath}
                placeholder="Folder name or path…"
                aria-label="New support folder path"
                disabled={creatingSupportFolder}
                onInput={(event: Event) => setSupportFolderPath((event.currentTarget as HTMLInputElement).value)}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createSupportFolder();
                  }
                }}
              />
              <button disabled={!supportFolderPath.trim() || creatingSupportFolder} onClick={() => void createSupportFolder()}>Create folder</button>
            </div>
          </div>
          {supportFolders.length > 0 && <div class="dg-support-folders">
            <span>Folders</span>
            <div>{supportFolders.map((path) => <span key={path} title={path}>📁 {supportPathLabel(path, project.supportPath)}</span>)}</div>
          </div>}
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
          {support.length === 0 && supportFolders.length === 0 && <span class="dg-support-empty">No support material yet.</span>}
        </section>
      </main>
    </div>
  );
}

/**
 * Submits a multi-line field on Cmd/Ctrl+Enter.
 *
 * Plain Enter stays a line break so pasted formatting survives, and a key this field has
 * consumed stops here rather than reaching Obsidian's global hotkeys as well.
 */
function submitOnModEnter(event: KeyboardEvent, submit: () => void): void {
  // An IME uses Enter to confirm a candidate; that keystroke is not a submission.
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  submit();
}

function ProjectOutcome({ services, project }: { services: GtdServices; project: Project }) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const editingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  editingRef.current = editing;

  useEffect(() => {
    let active = true;
    void services.repository.readDesiredOutcome(project)
      .then((value) => {
        if (!active) return;
        setOutcome(value);
        // Saving touches the note, so re-reading it must not overwrite what is still being typed.
        if (!editingRef.current) setDraft(value);
      })
      .catch(() => { if (active) setOutcome(""); });
    return () => { active = false; };
  }, [project.file.stat.mtime, project.file.path]);

  useEffect(() => setEditing(false), [project.id]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const beginEditing = () => {
    setDraft(outcome ?? "");
    setEditing(true);
  };
  const cancel = () => {
    setDraft(outcome ?? "");
    setEditing(false);
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = draft.trim();
      await services.repository.setDesiredOutcome(project.id, saved);
      setOutcome(saved);
      setEditing(false);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not save the Desired outcome.");
    } finally {
      setSaving(false);
    }
  };

  return <section class="dg-detail-section dg-project-outcome-panel">
    <div class="dg-detail-section-heading">
      <div><span class="dg-detail-eyebrow">Outcome</span><h3>Desired outcome</h3></div>
      {!editing && outcome !== null && <div class="dg-detail-section-actions">
        <button onClick={beginEditing}>{outcome ? "Edit" : "Write outcome"}</button>
      </div>}
    </div>
    {outcome === null
      ? <span class="dg-muted">Loading…</span>
      : editing
        ? <div class="dg-outcome-edit">
          <textarea
            ref={inputRef}
            class="dg-outcome-input"
            value={draft}
            rows={5}
            aria-label={`Desired outcome for ${project.title}`}
            placeholder="What will be true when this Project is complete? (⌘/Ctrl+Enter to save)"
            onInput={(event: Event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
                return;
              }
              submitOnModEnter(event, () => void save());
            }}
          />
          <div class="dg-outcome-edit-actions">
            <button disabled={saving} onClick={cancel}>Cancel</button>
            <button class="mod-cta" disabled={saving} onClick={() => void save()}>Save outcome</button>
          </div>
        </div>
        : outcome
          ? <MarkdownText services={services} markdown={outcome} sourcePath={project.file.path} />
          : <div class="dg-detail-empty">No desired outcome written yet.</div>}
  </section>;
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
        onKeyDown={(event: KeyboardEvent) => submitOnModEnter(event, () => void addEntry())}
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
  return isVaultImage(file);
}

function projectImageFile(services: GtdServices, project: Project): TFile | null {
  const path = project.image ?? services.getSettings().defaultProjectImage;
  return resolveVaultImage(services.app, path, project.file.path);
}

function supportFileLabel(file: TFile, supportPath?: string): string {
  return supportPath && file.path.startsWith(`${supportPath}/`)
    ? file.path.slice(supportPath.length + 1)
    : file.name;
}

function supportPathLabel(path: string, supportPath?: string): string {
  return supportPath && path.startsWith(`${supportPath}/`)
    ? path.slice(supportPath.length + 1)
    : path;
}

function SubprojectColumn({ status, projects, projectsById, services, onSelect, onMove, onMovePriority }: {
  status: SubprojectColumnStatus;
  projects: Project[];
  projectsById: ReadonlyMap<string, Project>;
  services: GtdServices;
  onSelect: (id: string) => void;
  onMove: (id: string, status: SubprojectColumnStatus, beforeId?: string) => Promise<void>;
  onMovePriority: (id: string, direction: -1 | 1) => void;
}) {
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const columnTitle = SUBPROJECT_COLUMN_LABELS[status];
  const insertionIndexAtCard = (event: DragEvent, index: number): number => {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? index : index + 1;
  };
  return <div
    class="dg-subproject-column"
    data-subproject-column={status}
    onDragOver={(event: DragEvent) => {
      event.preventDefault();
      if (!(event.target as Element | null)?.closest?.(".dg-subproject-card")) setDropIndex(projects.length);
    }}
    onDragLeave={(event: DragEvent) => {
      const nextTarget = event.relatedTarget as Node | null;
      if (!nextTarget || !(event.currentTarget as HTMLElement).contains(nextTarget)) setDropIndex(null);
    }}
    onDrop={(event: DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer?.getData("text/dragonglass-subproject");
      const beforeId = projects[dropIndex ?? projects.length]?.id;
      setDropIndex(null);
      if (id) void onMove(id, status, beforeId);
    }}
  >
    <header><strong>{columnTitle}</strong><span>{projects.length}</span></header>
    <div class="dg-subproject-list">
      {projects.map((child, index) => {
        const blockers = activeProjectBlockers(child, projectsById);
        const openMenu = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const menu = new Menu();
          for (const targetStatus of SUBPROJECT_COLUMNS) {
            menu.addItem((item) => item
              .setTitle(`${targetStatus === child.status ? "✓ " : ""}${SUBPROJECT_COLUMN_LABELS[targetStatus]}`)
              .setDisabled(targetStatus === child.status)
              .onClick(() => void onMove(child.id, targetStatus)));
          }
          menu.addSeparator();
          menu.addItem((item) => item.setTitle("Move up").setDisabled(index === 0).onClick(() => onMovePriority(child.id, -1)));
          menu.addItem((item) => item.setTitle("Move down").setDisabled(index === projects.length - 1).onClick(() => onMovePriority(child.id, 1)));
          menu.addSeparator();
          menu.addItem((item) => item.setTitle("Blocked by…").onClick(() => new ProjectDependenciesModal(services, child).open()));
          menu.addItem((item) => item.setTitle("Edit…").onClick(() => services.editProject(child.id)));
          menu.addItem((item) => item.setTitle("Open note").onClick(() => void services.openFile(child.file)));
          menu.addItem((item) => item.setTitle("New Action…").onClick(() => services.createAction(child.id)));
          menu.addItem((item) => item.setTitle("New sub-project…").onClick(() => services.createProject(false, child.id)));
          menu.addSeparator();
          menu.addItem((item) => item
            .setTitle("Delete Project…")
            .setIcon("trash-2")
            .setWarning(true)
            .onClick(() => void confirmDeleteProject(services, child.id)));
          menu.showAtMouseEvent(event);
        };
        return <article
          class={`dg-subproject-card${blockers.length ? " is-blocked" : ""}${dropIndex === index ? " is-drop-before" : ""}`}
          key={child.id}
          data-subproject-card={child.id}
          draggable={!Platform.isMobile}
          onDragStart={(event: DragEvent) => {
            event.dataTransfer?.setData("text/dragonglass-subproject", child.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDropIndex(null)}
          onDragOver={(event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            setDropIndex(insertionIndexAtCard(event, index));
          }}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const id = event.dataTransfer?.getData("text/dragonglass-subproject");
            const insertionIndex = insertionIndexAtCard(event, index);
            const beforeId = projects[insertionIndex]?.id;
            setDropIndex(null);
            if (id) void onMove(id, status, beforeId);
          }}
        >
          <div class="dg-subproject-card-heading">
            <button class="dg-subproject-title" title={child.title} onClick={() => onSelect(child.id)}>{child.title}</button>
            <button class="dg-icon-button" aria-label={`Options for ${child.title}`} onClick={openMenu}>•••</button>
          </div>
          {Boolean(child.tags?.length) && <div class="dg-project-tags">{child.tags!.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
          {blockers.length > 0 && <div class="dg-subproject-blocked" title={blockers.map((blocker) => blocker.title).join(", ")}>
            Blocked by {blockers.length === 1 ? blockers[0]!.title : `${blockers.length} Projects`}
          </div>}
        </article>;
      })}
      {dropIndex === projects.length && <div class="dg-subproject-drop-line" aria-hidden="true" />}
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
    const container = ref.current;
    const component = new Component();
    component.load();
    container.empty();
    component.registerDomEvent(container, "click", (event) => {
      const target = event.target as Node | null;
      const anchor = ((target as Element | null)?.closest?.("a") ?? target?.parentElement?.closest("a")) as HTMLAnchorElement | null;
      if (!anchor || !container.contains(anchor)) return;
      if (anchor.hasClass("internal-link")) {
        const linktext = anchor.dataset.href ?? anchor.getAttr("href");
        if (!linktext) return;
        event.preventDefault();
        void services.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event));
        return;
      }
      if (anchor.hasClass("external-link")) {
        const href = anchor.getAttr("href");
        if (!href) return;
        event.preventDefault();
        anchor.win.open(href, "_blank", "noopener,noreferrer");
      }
    });
    void MarkdownRenderer.render(services.app, markdown, container, sourcePath, component);
    return () => component.unload();
  }, [markdown, sourcePath]);
  return <div class="dg-outcome markdown-rendered" ref={ref} />;
}
