import { Notice, prepareFuzzySearch } from "obsidian";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { InboxItem, InboxProcessingInput, Project } from "../domain/types";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
import { useGtdSnapshot } from "../ui/hooks";
import type { GtdServices } from "../ui/services";

export function InboxView({ services }: { services: GtdServices }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [search, setSearch] = useState("");
  const [processing, setProcessing] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const allItems = useMemo(() => [...snapshot.inboxItems].sort(compareInboxItems), [snapshot]);
  const items = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return allItems.filter((item) => !needle || item.title.toLocaleLowerCase().includes(needle));
  }, [allItems, search]);
  const contexts = useMemo(
    () => [...new Set(snapshot.actions.map((action) => action.context).filter((value): value is string => Boolean(value)))].sort(),
    [snapshot],
  );

  const startProcessing = (itemId?: string) => {
    const index = itemId ? allItems.findIndex((item) => item.id === itemId) : 0;
    setCursor(Math.max(0, index));
    setSessionTotal(allItems.length);
    setProcessing(true);
  };

  return (
    <div class="dg-view dg-inbox-view">
      <header class="dg-view-header">
        <div>
          <h2>{processing ? "Process Inbox" : "Inbox"}</h2>
          <span class="dg-count">{snapshot.inboxItems.length}</span>
        </div>
        <div class="dg-header-actions">
          {processing
            ? <button onClick={() => setProcessing(false)}>List</button>
            : <button disabled={!allItems.length} onClick={() => startProcessing()}>Process Inbox</button>}
          <button class="mod-cta" onClick={services.quickCapture}>Capture</button>
        </div>
      </header>

      {snapshot.issues.length > 0 && (
        <div class="dg-warning" title={snapshot.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}>
          {snapshot.issues.length} GTD file{snapshot.issues.length === 1 ? " has" : "s have"} metadata problems.
        </div>
      )}

      {processing ? (
        <InboxProcessor
          services={services}
          items={allItems}
          cursor={cursor}
          sessionTotal={sessionTotal}
          projects={snapshot.projects}
          contexts={contexts}
        />
      ) : (
        <>
          <div class="dg-toolbar dg-inbox-toolbar">
            <input
              type="search"
              placeholder="Search Inbox"
              value={search}
              onInput={(event: Event) => setSearch((event.currentTarget as HTMLInputElement).value)}
            />
          </div>

          <div class="dg-inbox-list" role="list" aria-label="Inbox Items">
            {items.map((item) => (
              <article class="dg-inbox-row" role="listitem" key={`${item.id}-${item.file.path}`}>
                <div class="dg-inbox-item-main">
                  <button class="dg-project-title" onClick={() => void services.openFile(item.file)}>{item.title}</button>
                  <span class="dg-inbox-meta">
                    {item.created}
                    {item.legacyAction && " · Legacy Inbox Action"}
                  </span>
                </div>
                <button class="mod-cta" onClick={() => startProcessing(item.id)}>Process</button>
              </article>
            ))}
            {items.length === 0 && <div class="dg-empty-row">{search ? "No Inbox Items match this search." : "Inbox zero."}</div>}
          </div>
        </>
      )}
    </div>
  );
}

function InboxProcessor({
  services,
  items,
  cursor,
  sessionTotal,
  projects,
  contexts,
}: {
  services: GtdServices;
  items: readonly InboxItem[];
  cursor: number;
  sessionTotal: number;
  projects: readonly Project[];
  contexts: readonly string[];
}) {
  const item = items.length ? items[cursor % items.length] : undefined;
  const [body, setBody] = useState("");
  const [seconds, setSeconds] = useState(120);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [desiredOutcome, setDesiredOutcome] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const projectLabels = useMemo(() => projectBreadcrumbs(projects), [projects]);

  useEffect(() => {
    let cancelled = false;
    setBody("");
    setProjectQuery("");
    setProjectId("");
    setDesiredOutcome("");
    setNextAction("");
    setContext("");
    setBusy(false);
    if (item) void services.repository.readInboxBody(item).then((value) => { if (!cancelled) setBody(value); });
    return () => { cancelled = true; };
  }, [item?.id]);

  useEffect(() => {
    setSeconds(120);
    const timer = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [item?.id]);

  if (!item) {
    return <div class="dg-workflow-complete"><span>🎉</span><h3>Inbox zero</h3><p>Everything captured has been clarified.</p></div>;
  }

  const processed = Math.max(0, sessionTotal - items.length);
  const input = (): InboxProcessingInput => ({
    ...(projectId ? { projectId } : {}),
    ...(projectQuery.trim() ? { projectTitle: projectQuery.trim() } : {}),
    ...(desiredOutcome.trim() ? { desiredOutcome: desiredOutcome.trim() } : {}),
    ...(nextAction.trim() ? { nextAction: nextAction.trim() } : {}),
    ...(context.trim() ? { context: context.trim() } : {}),
  });
  const run = async (operation: () => Promise<void>, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      new Notice(message);
    } catch (error) {
      setBusy(false);
      new Notice(error instanceof Error ? error.message : "The Inbox operation failed.");
    }
  };
  const selectedProject = projectId
    ? projects.find((project) => project.id === projectId)
    : projects.find((project) => {
      const query = projectQuery.trim().toLocaleLowerCase();
      return project.title.toLocaleLowerCase() === query || projectLabels.get(project.id)?.toLocaleLowerCase() === query;
    });
  const selectedProjectLabel = selectedProject ? projectLabels.get(selectedProject.id) ?? selectedProject.title : "";
  const projectName = selectedProject?.title ?? projectQuery.trim();
  const actionLabel = selectedProject
    ? `Create Next Action in ${selectedProject.title}`
    : projectName
      ? "Create Project + Next Action"
      : "Create Next Action";
  const referenceLabel = projectName
    ? `File with ${projectName}${nextAction.trim() ? " + Next Action" : ""}`
    : `File as General Reference${nextAction.trim() ? " + Next Action" : ""}`;
  const somedayLabel = selectedProject ? `Move ${selectedProject.title} to Someday/Maybe` : "Create Someday/Maybe Project";
  const actionReady = Boolean(nextAction.trim() && context.trim());
  const referenceReady = Boolean(!nextAction.trim() || context.trim());

  return (
    <div class="dg-processor">
      <div class="dg-workflow-progress">
        <span>{processed} / {sessionTotal} processed</span>
        <span class={seconds === 0 ? "is-overdue" : ""}>{formatTimer(seconds)}</span>
      </div>
      <div class="dg-progress-track"><span style={{ width: `${sessionTotal ? processed / sessionTotal * 100 : 0}%` }} /></div>

      <section class="dg-processor-card">
        <div class="dg-processor-heading">
          <div>
            <h3>{item.title}</h3>
            <span>{item.created}{item.legacyAction ? " · Legacy Inbox Action" : ""}</span>
          </div>
          <button onClick={() => void services.openFile(item.file)}>Open note</button>
        </div>
        <div class={`dg-inbox-preview${body ? "" : " is-empty"}`}>{body || "No additional notes."}</div>
      </section>

      <section class="dg-processing-form" aria-label="Clarify Inbox Item">
        <div class="dg-processing-grid">
          <ProcessingField label="Project" wide hint={projectQuery.trim() && !selectedProject ? "A new Active Project will be created when needed." : "Optional. Select an existing Project or type a new name."}>
            <FuzzyField
              value={projectQuery}
              placeholder="Search or name a Project…"
              options={projects.map((project) => ({ id: project.id, label: projectLabels.get(project.id) ?? project.title, ...(project.area ? { meta: project.area } : {}) }))}
              onChange={(value) => {
                setProjectQuery(value);
                if (value !== selectedProjectLabel) setProjectId("");
              }}
              onChoose={(option) => {
                setProjectQuery(option.label);
                setProjectId(option.id);
              }}
            />
          </ProcessingField>

          <ProcessingField label="Project Vision" wide hint="Applied when a Project is selected or created.">
            <textarea value={desiredOutcome} placeholder="What will be true when this Project is complete?" onInput={(event: Event) => setDesiredOutcome((event.currentTarget as HTMLTextAreaElement).value)} />
          </ProcessingField>

          <ProcessingField label="Next Action" hint="Required with a context for Action-producing dispositions.">
            <input value={nextAction} placeholder="What is the next physical Action?" onInput={(event: Event) => setNextAction((event.currentTarget as HTMLInputElement).value)} />
          </ProcessingField>

          <ProcessingField label="Context" hint={context.trim() && !contexts.some((value) => value.toLocaleLowerCase() === context.trim().toLocaleLowerCase()) ? "This new context will be stored on the Action." : "Required when creating a Next Action."}>
            <FuzzyField
              value={context}
              placeholder="Search or name a context…"
              options={contexts.map((value) => ({ id: value, label: value }))}
              onChange={setContext}
              onChoose={(option) => setContext(option.label)}
            />
          </ProcessingField>
        </div>
      </section>

      <section class="dg-processor-actions">
        <button class="mod-cta" title={actionLabel} disabled={!actionReady || busy} onClick={() => void run(() => services.repository.processInboxAsNextAction(item.id, input()), "Next Action created.")}>{actionLabel}</button>
        <button title={referenceLabel} disabled={!referenceReady || busy} onClick={() => void run(() => services.repository.processInboxAsReference(item.id, input()), projectName ? "Filed with Project." : "Filed as General Reference.")}>{referenceLabel}</button>
        <button title={somedayLabel} disabled={!actionReady || busy} onClick={() => void run(() => services.repository.processInboxAsSomedayProject(item.id, input()), "Filed as a Someday/Maybe Project.")}>{somedayLabel}</button>
        <button class="mod-warning" disabled={busy} onClick={() => void run(() => services.repository.trashInboxItem(item.id), "Inbox Item deleted.")}>Delete</button>
      </section>

      {seconds === 0 && <div class="dg-warning">Two minutes elapsed. Make the smallest clear decision and keep moving.</div>}
    </div>
  );
}

interface FuzzyOption {
  id: string;
  label: string;
  meta?: string;
}

function ProcessingField({ label, hint, wide = false, children }: { label: string; hint: string; wide?: boolean; children: ComponentChildren }) {
  return <label class={`dg-processing-field${wide ? " is-wide" : ""}`}><span>{label}</span>{children}<small>{hint}</small></label>;
}

function FuzzyField({
  value,
  placeholder,
  options,
  onChange,
  onChoose,
}: {
  value: string;
  placeholder: string;
  options: readonly FuzzyOption[];
  onChange: (value: string) => void;
  onChoose: (option: FuzzyOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const suggestions = useMemo(() => {
    const query = value.trim();
    if (!query) return options.slice(0, 8);
    const fuzzy = prepareFuzzySearch(query);
    return options.filter((option) => fuzzy(`${option.label} ${option.meta ?? ""}`) !== null).slice(0, 8);
  }, [value, options]);

  return (
    <div class="dg-fuzzy-field">
      <input
        value={value}
        placeholder={placeholder}
        autocomplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 100)}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Escape") return setOpen(false);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((current) => suggestions.length ? (current + direction + suggestions.length) % suggestions.length : 0);
          }
          if (event.key === "Enter" && open && suggestions[activeIndex]) {
            event.preventDefault();
            onChoose(suggestions[activeIndex]);
            setOpen(false);
          }
        }}
        onInput={(event: Event) => {
          onChange((event.currentTarget as HTMLInputElement).value);
          setActiveIndex(0);
          setOpen(true);
        }}
      />
      {open && suggestions.length > 0 && (
        <div class="dg-fuzzy-results" role="listbox">
          {suggestions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              class={activeIndex === index ? "is-active" : ""}
              onMouseDown={(event: MouseEvent) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => { onChoose(option); setOpen(false); }}
            >
              <span>{option.label}</span>{option.meta && <small>{option.meta}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function compareInboxItems(left: InboxItem, right: InboxItem): number {
  const created = left.created.localeCompare(right.created);
  return created === 0 ? left.id.localeCompare(right.id) : created;
}

function formatTimer(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
