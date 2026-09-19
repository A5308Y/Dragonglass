import { Menu, Notice, Platform } from "obsidian";
import { useMemo, useState } from "preact/hooks";
import {
  ACTION_STATUSES,
  type Action,
  type ActionFilter,
  type ActionStatus,
  type BoardConfiguration,
  type GroupBy,
  type SavedView,
  type SortField,
} from "../domain/types";
import { projectBreadcrumb } from "../domain/project-hierarchy";
import { buildBoard, type ActionGroup } from "../state/query";
import { isOverdue, localDate } from "../utils/date";
import { useGtdSnapshot } from "../ui/hooks";
import { TextPromptModal, label } from "../ui/modals";
import type { GtdServices } from "../ui/services";

const STATUS_COLUMNS: ActionStatus[] = ["next", "waiting", "scheduled", "done"];

export function ActionBoard({ services }: { services: GtdServices }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const settings = services.getSettings();
  const baseColumns = STATUS_COLUMNS.filter((status) => status !== "done" || settings.showDoneColumn);
  const [activeId, setActiveId] = useState<string | null>(() => settings.savedViews.some((view) => view.id === settings.activeSavedViewId) ? settings.activeSavedViewId : null);
  const activeView = settings.savedViews.find((view) => view.id === activeId);
  const [configuration, setConfiguration] = useState<BoardConfiguration>(() =>
    activeView ? cloneConfiguration(activeView) : defaultConfiguration(baseColumns),
  );
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<Map<string, ActionStatus>>(new Map());

  const displaySnapshot = useMemo(() => {
    if (optimistic.size === 0) return snapshot;
    return {
      ...snapshot,
      actions: snapshot.actions.map((action) => {
        const status = optimistic.get(action.id);
        return status ? { ...action, status } : action;
      }),
    };
  }, [snapshot, optimistic]);

  const allGroups = useMemo(
    () => buildBoard(displaySnapshot, { ...configuration, visibleColumns: null }, search),
    [displaySnapshot, configuration, search],
  );
  let groups = useMemo(
    () => buildBoard(displaySnapshot, configuration, search),
    [displaySnapshot, configuration, search],
  );
  if (configuration.groupBy === "status") groups = includeEmptyStatusGroups(groups, configuration.visibleColumns ?? baseColumns);

  const selectView = (id: string) => {
    if (!id) {
      setActiveId(null);
      setConfiguration(defaultConfiguration(baseColumns));
      void persistSettings({ ...settings, activeSavedViewId: null });
      return;
    }
    const view = settings.savedViews.find((candidate) => candidate.id === id);
    if (!view) return;
    setActiveId(id);
    setConfiguration(cloneConfiguration(view));
    void persistSettings({ ...settings, activeSavedViewId: id });
  };

  const persistSettings = async (next: typeof settings) => {
    await services.saveSettings(next);
  };

  const saveView = () => {
    if (activeId) {
      const views = settings.savedViews.map((view) =>
        view.id === activeId ? { ...view, ...cloneConfiguration(configuration) } : view,
      );
      void persistSettings({ ...settings, savedViews: views, activeSavedViewId: activeId });
      new Notice("Saved view updated.");
      return;
    }
    new TextPromptModal(services.app, "Save board view", "View name", async (name) => {
      const view: SavedView = {
        id: `view-${Date.now().toString(36)}`,
        name,
        ...cloneConfiguration(configuration),
      };
      setActiveId(view.id);
      await persistSettings({ ...settings, savedViews: [...settings.savedViews, view], activeSavedViewId: view.id });
    }).open();
  };

  const saveAsView = () => {
    new TextPromptModal(services.app, "Save board view as", activeView ? `${activeView.name} copy` : "View name", async (name) => {
      const view: SavedView = {
        id: `view-${Date.now().toString(36)}`,
        name,
        ...cloneConfiguration(configuration),
      };
      setActiveId(view.id);
      await persistSettings({ ...settings, savedViews: [...settings.savedViews, view], activeSavedViewId: view.id });
    }).open();
  };

  const deleteView = async () => {
    if (!activeId) return;
    const remaining = settings.savedViews.filter((view) => view.id !== activeId);
    setActiveId(null);
    setConfiguration(defaultConfiguration(baseColumns));
    await persistSettings({ ...settings, savedViews: remaining, activeSavedViewId: null });
  };

  const moveAction = async (id: string, status: ActionStatus) => {
    const previous = snapshot.actionsById.get(id)?.status;
    if (!previous || previous === status) return;
    setOptimistic((current) => new Map(current).set(id, status));
    try {
      await services.repository.setActionStatus(id, status);
      await waitForStatus(services, id, status);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not change Action status.");
    } finally {
      setOptimistic((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div class="dg-view dg-board-view">
      <header class="dg-view-header">
        <div>
          <h2>Actions</h2>
          <span class="dg-count">{snapshot.actions.length}</span>
        </div>
        <div class="dg-header-actions">
          <button class="mod-cta" onClick={() => services.createAction()}>New Action</button>
          <button onClick={services.quickCapture}>Quick Capture</button>
          <button onClick={services.openInbox}>Open Inbox</button>
        </div>
      </header>

      {snapshot.issues.length > 0 && (
        <div class="dg-warning" title={snapshot.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}>
          {snapshot.issues.length} GTD file{snapshot.issues.length === 1 ? " has" : "s have"} metadata problems.
        </div>
      )}

      <div class="dg-toolbar">
        <select aria-label="Saved view" value={activeId ?? ""} onChange={(event: Event) => selectView((event.currentTarget as HTMLSelectElement).value)}>
          <option value="">Board</option>
          {settings.savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select>
        <input
          type="search"
          placeholder="Search Actions or Projects"
          value={search}
          onInput={(event: Event) => setSearch((event.currentTarget as HTMLInputElement).value)}
        />
        <button class={filterOpen ? "is-active" : ""} onClick={() => setFilterOpen(!filterOpen)}>Filter</button>
        <select aria-label="Group by" value={configuration.groupBy} onChange={(event: Event) => setConfiguration({ ...configuration, groupBy: (event.currentTarget as HTMLSelectElement).value as GroupBy, visibleColumns: null })}>
          <option value="status">Group: Status</option>
          <option value="project">Group: Project</option>
          <option value="context">Group: Context</option>
          <option value="energy">Group: Energy</option>
        </select>
        <select aria-label="Sort by" value={configuration.sort.field} onChange={(event: Event) => setConfiguration({ ...configuration, sort: { ...configuration.sort, field: (event.currentTarget as HTMLSelectElement).value as SortField } })}>
          <option value="created">Sort: Created</option>
          <option value="due">Sort: Due</option>
          <option value="title">Sort: Title</option>
          <option value="project">Sort: Project</option>
        </select>
        <button aria-label="Reverse sort" onClick={() => setConfiguration({ ...configuration, sort: { ...configuration.sort, direction: configuration.sort.direction === "asc" ? "desc" : "asc" } })}>
          {configuration.sort.direction === "asc" ? "↑" : "↓"}
        </button>
        <button class={columnsOpen ? "is-active" : ""} onClick={() => setColumnsOpen(!columnsOpen)}>Columns</button>
        <button onClick={saveView}>Save</button>
        <button onClick={saveAsView}>Save As</button>
        {activeId && <button aria-label="Delete saved view" onClick={() => void deleteView()}>Delete</button>}
      </div>

      {filterOpen && <FilterBuilder services={services} filters={configuration.filters} onChange={(filters) => setConfiguration({ ...configuration, filters })} />}
      {columnsOpen && <ColumnPicker snapshotGroups={allGroups} configuration={configuration} onChange={setConfiguration} />}
      <FilterChips filters={configuration.filters} snapshot={snapshot} onRemove={(index) => setConfiguration({ ...configuration, filters: configuration.filters.filter((_, candidate) => candidate !== index) })} />

      <div class="dg-board" role="list">
        {groups.map((group) => (
          <BoardColumn
            key={group.key}
            group={group}
            services={services}
            groupBy={configuration.groupBy}
            onMove={moveAction}
          />
        ))}
        {groups.length === 0 && <div class="dg-empty">No Actions match this view.</div>}
      </div>
    </div>
  );
}

function BoardColumn({ group, services, groupBy, onMove }: { key?: string; group: ActionGroup; services: GtdServices; groupBy: GroupBy; onMove: (id: string, status: ActionStatus) => Promise<void> }) {
  const canDrop = groupBy === "status" && ACTION_STATUSES.includes(group.key as ActionStatus) && group.key !== "cancelled";
  return (
    <section
      class="dg-column"
      data-column={group.key}
      onDragOver={(event: DragEvent) => { if (canDrop) event.preventDefault(); }}
      onDrop={(event: DragEvent) => {
        if (!canDrop) return;
        event.preventDefault();
        const id = event.dataTransfer?.getData("text/dragonglass-action");
        if (id) void onMove(id, group.key as ActionStatus);
      }}
    >
      <header class="dg-column-header"><span>{group.label}</span><span>{group.actions.length}</span></header>
      <div class="dg-card-list">
        {group.actions.map((action) => <ActionCard key={`${action.id}-${action.file.path}`} action={action} services={services} onMove={onMove} />)}
      </div>
    </section>
  );
}

function ActionCard({ action, services, onMove }: { key?: string; action: Action; services: GtdServices; onMove: (id: string, status: ActionStatus) => Promise<void> }) {
  const snapshot = services.repository.index.getSnapshot();
  const project = action.projectId ? snapshot.projectsById.get(action.projectId) : undefined;
  const deleteAction = async () => {
    if (!window.confirm(`Delete “${action.title}”?\n\nThis moves the Action file to Obsidian's trash.`)) return;
    try {
      await services.repository.trashAction(action.id);
      new Notice(`Deleted “${action.title}”.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not delete the Action.");
    }
  };
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    for (const status of ACTION_STATUSES) {
      menu.addItem((item) => item.setTitle(`${status === action.status ? "✓ " : ""}${label(status)}`).onClick(() => void onMove(action.id, status)));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("No project").onClick(() => void safely(services.repository.updateAction(action.id, { projectId: "" }))));
    for (const candidate of snapshot.projects
      .filter((item) => item.status !== "completed" && item.status !== "cancelled")
      .sort((a, b) => projectBreadcrumb(a, snapshot.projectsById).localeCompare(projectBreadcrumb(b, snapshot.projectsById)))) {
      menu.addItem((item) => item.setTitle(`${candidate.id === action.projectId ? "✓ " : ""}${projectBreadcrumb(candidate, snapshot.projectsById)}`).onClick(() => void safely(services.repository.updateAction(action.id, { projectId: candidate.id }))));
    }
    const contexts = [...new Set(snapshot.actions.map((item) => item.context).filter((value): value is string => Boolean(value)))].sort();
    if (contexts.length) {
      menu.addSeparator();
      for (const context of contexts) menu.addItem((item) => item.setTitle(`${context === action.context ? "✓ " : ""}@${context}`).onClick(() => void safely(services.repository.updateAction(action.id, { context }))));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Edit…").onClick(() => services.editAction(action.id)));
    menu.addItem((item) => item
      .setTitle("Delete Action…")
      .setIcon("trash-2")
      .setWarning(true)
      .onClick(() => void deleteAction()));
    menu.showAtMouseEvent(event);
  };

  return (
    <article
      class="dg-card"
      role="listitem"
      data-card={action.id}
      tabIndex={0}
      draggable={!Platform.isMobile}
      onDragStart={(event: DragEvent) => event.dataTransfer?.setData("text/dragonglass-action", action.id)}
      onKeyDown={(event: KeyboardEvent) => handleCardKey(event, action, onMove)}
    >
      <div class="dg-card-title-row">
        <span class="dg-card-title dg-action-card-title" title={action.title}>{action.title}</span>
        <button class="dg-icon-button" aria-label={`Actions for ${action.title}`} onClick={openMenu}>•••</button>
      </div>
      {action.projectId && (
        project
          ? <button class="dg-project-link" title={projectBreadcrumb(project, snapshot.projectsById)} onClick={() => services.showProjectDetail(project.id)}>{projectBreadcrumb(project, snapshot.projectsById)}</button>
          : <span class="dg-missing">Missing project</span>
      )}
      <div class="dg-card-meta">
        {action.context && <span>@{action.context}</span>}
        {action.energy && <span>{action.energy}</span>}
        {action.due && <span class={isOverdue(action.due) && action.status !== "done" ? "is-overdue" : ""}>{action.due}</span>}
      </div>
    </article>
  );
}

function FilterBuilder({ services, filters, onChange }: { services: GtdServices; filters: ActionFilter[]; onChange: (filters: ActionFilter[]) => void }) {
  const snapshot = services.repository.index.getSnapshot();
  const [field, setField] = useState("status");
  const [operator, setOperator] = useState<"in" | "notIn">("in");
  const [value, setValue] = useState("next");
  const [dueOperator, setDueOperator] = useState<"before" | "onOrBefore" | "after" | "onOrAfter" | "withinNextDays" | "isEmpty" | "isNotEmpty">("onOrBefore");
  const [dueValue, setDueValue] = useState<string>(localDate());
  const values = field === "status"
    ? ACTION_STATUSES.map((item) => ({ value: item, label: label(item) }))
    : field === "project"
      ? [{ value: "", label: "No project" }, ...snapshot.projects.map((project) => ({ value: project.id, label: projectBreadcrumb(project, snapshot.projectsById) }))]
      : [...new Set(snapshot.actions.map((action) => field === "context" ? action.context : action.energy).filter((item): item is string => Boolean(item)))].sort().map((item) => ({ value: item, label: item }));

  const changeField = (next: string) => {
    setField(next);
    if (next === "status") setValue("next");
    else setValue("");
  };
  const add = () => {
    if (field === "available") onChange([...filters, { kind: "availability", operator: "available" }]);
    else if (field === "work") onChange([...filters, { kind: "work", value: operator === "in" }]);
    else if (field === "due") onChange([...filters, {
      kind: "due",
      operator: dueOperator,
      ...(dueOperator === "isEmpty" || dueOperator === "isNotEmpty" ? {} : { value: dueOperator === "withinNextDays" ? Number(dueValue || 7) : dueValue }),
    }]);
    else onChange([...filters, { kind: "value", field: field as "status" | "project" | "context" | "energy", operator, values: [value] }]);
  };
  return (
    <div class="dg-panel dg-filter-builder">
      <select value={field} onChange={(event: Event) => changeField((event.currentTarget as HTMLSelectElement).value)}>
        <option value="status">Status</option><option value="project">Project</option><option value="context">Context</option><option value="energy">Energy</option>
        <option value="due">Due date</option><option value="available">Available now</option><option value="work">Work</option>
      </select>
      {field !== "due" && field !== "available" && <select value={operator} onChange={(event: Event) => setOperator((event.currentTarget as HTMLSelectElement).value as "in" | "notIn")}>
        <option value="in">is</option><option value="notIn">is not</option>
      </select>}
      {field !== "due" && field !== "available" && field !== "work" && <select value={value} onChange={(event: Event) => setValue((event.currentTarget as HTMLSelectElement).value)}>{values.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>}
      {field === "due" && <select value={dueOperator} onChange={(event: Event) => {
        const next = (event.currentTarget as HTMLSelectElement).value as typeof dueOperator;
        setDueOperator(next);
        if (next === "withinNextDays") setDueValue("7");
        else if (!dueValue.includes("-")) setDueValue(localDate());
      }}>
        <option value="before">before</option><option value="onOrBefore">on or before</option><option value="after">after</option><option value="onOrAfter">on or after</option>
        <option value="withinNextDays">within next days</option><option value="isEmpty">is empty</option><option value="isNotEmpty">is not empty</option>
      </select>}
      {field === "due" && dueOperator !== "isEmpty" && dueOperator !== "isNotEmpty" && <input type={dueOperator === "withinNextDays" ? "number" : "date"} min={dueOperator === "withinNextDays" ? "1" : undefined} value={dueValue} onInput={(event: Event) => setDueValue((event.currentTarget as HTMLInputElement).value)} />}
      <button class="mod-cta" onClick={add}>Add filter</button>
    </div>
  );
}

function FilterChips({ filters, snapshot, onRemove }: { filters: ActionFilter[]; snapshot: ReturnType<GtdServices["repository"]["index"]["getSnapshot"]>; onRemove: (index: number) => void }) {
  if (!filters.length) return null;
  return <div class="dg-filter-chips">{filters.map((filter, index) => <button key={index} class="dg-chip" onClick={() => onRemove(index)}>{describeFilter(filter, snapshot)} ×</button>)}</div>;
}

function ColumnPicker({ snapshotGroups, configuration, onChange }: { snapshotGroups: ActionGroup[]; configuration: BoardConfiguration; onChange: (configuration: BoardConfiguration) => void }) {
  const candidates = configuration.groupBy === "status" ? STATUS_COLUMNS : snapshotGroups.map((group) => group.key);
  const visible = new Set(configuration.visibleColumns ?? candidates);
  return <div class="dg-panel dg-column-picker">{candidates.map((key) => <label key={key}><input type="checkbox" checked={visible.has(key)} onChange={() => {
    if (visible.has(key)) visible.delete(key); else visible.add(key);
    onChange({ ...configuration, visibleColumns: [...visible] });
  }} /> {label(key || `No ${configuration.groupBy}`)}</label>)}</div>;
}

function describeFilter(filter: ActionFilter, snapshot: ReturnType<GtdServices["repository"]["index"]["getSnapshot"]>): string {
  if (filter.kind === "availability") return "Available now";
  if (filter.kind === "work") return filter.value ? "Work" : "Not work";
  if (filter.kind === "due") return filter.operator === "withinNextDays" ? `Due within ${filter.value} days` : `Due ${filter.operator}`;
  const labels = filter.values.map((value) => {
    if (filter.field !== "project") return value;
    const project = snapshot.projectsById.get(value);
    return project ? projectBreadcrumb(project, snapshot.projectsById) : "No project";
  });
  return `${label(filter.field)} ${filter.operator === "in" ? "is" : "is not"} ${labels.join(", ")}`;
}

function handleCardKey(event: KeyboardEvent, action: Action, onMove: (id: string, status: ActionStatus) => Promise<void>): void {
  if (event.key.toLocaleLowerCase() === "d") { event.preventDefault(); void onMove(action.id, "done"); return; }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const cards = [...document.querySelectorAll<HTMLElement>(".dg-board [data-card]")];
  const current = cards.indexOf(event.currentTarget as HTMLElement);
  cards[current + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
}

function includeEmptyStatusGroups(groups: ActionGroup[], visible: readonly string[]): ActionGroup[] {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  return visible.map((key) => byKey.get(key) ?? { key, label: label(key), actions: [] });
}

function defaultConfiguration(columns: readonly string[]): BoardConfiguration {
  return { filters: [], groupBy: "status", sort: { field: "created", direction: "desc" }, visibleColumns: [...columns] };
}

function cloneConfiguration(view: Pick<SavedView, "filters" | "groupBy" | "sort" | "visibleColumns">): BoardConfiguration {
  return {
    filters: view.filters.map((filter) => ({ ...filter, ...(filter.kind === "value" ? { values: [...filter.values] } : {}) })) as ActionFilter[],
    groupBy: view.groupBy,
    sort: { ...view.sort },
    visibleColumns: view.visibleColumns ? [...view.visibleColumns] : null,
  };
}

async function safely(promise: Promise<void>): Promise<void> {
  try { await promise; } catch (error) { new Notice(error instanceof Error ? error.message : "The GTD operation failed."); }
}

function waitForStatus(services: GtdServices, id: string, status: ActionStatus): Promise<void> {
  if (services.repository.index.getSnapshot().actionsById.get(id)?.status === status) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {};
    const timeout = window.setTimeout(() => { unsubscribe(); resolve(); }, 1500);
    unsubscribe = services.repository.index.subscribe(() => {
      if (services.repository.index.getSnapshot().actionsById.get(id)?.status !== status) return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}
