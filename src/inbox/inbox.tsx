import { Notice } from "obsidian";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { InboxItem, InboxProcessingInput, Project } from "../domain/types";
import { inboxPrimaryDisposition, inboxProcessingPrefill, type InboxPrimaryDisposition } from "../domain/inbox-processing";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
import { isVaultAudio } from "../ui/audio";
import { FuzzyField } from "../ui/fuzzy-field";
import { useGtdSnapshot } from "../ui/hooks";
import type { GtdServices } from "../ui/services";

export function InboxView({ services, initialProcessing = false }: { services: GtdServices; initialProcessing?: boolean }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [search, setSearch] = useState("");
  const [processing, setProcessing] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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

  // Entering from the command palette: start the session once the Inbox has something to process.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!initialProcessing || autoStarted.current || !allItems.length) return;
    autoStarted.current = true;
    startProcessing();
  }, [initialProcessing, allItems.length]);

  const deleteItem = async (item: InboxItem) => {
    if (deletingId) return;
    setDeletingId(item.id);
    try {
      await services.repository.trashInboxItem(item);
      new Notice(`Deleted “${item.title}”.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not delete the Inbox Item.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div class={`dg-view dg-inbox-view${processing ? " is-processing" : ""}`}>
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
                <div class="dg-inbox-row-actions">
                  <button class="mod-cta" disabled={deletingId === item.id} onClick={() => startProcessing(item.id)}>Process</button>
                  <button class="mod-warning" disabled={deletingId === item.id} onClick={() => void deleteItem(item)}>Delete</button>
                </div>
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
  const [work, setWork] = useState(false);
  const [someday, setSomeday] = useState(false);
  const [fileOriginal, setFileOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const projectLabels = useMemo(() => projectBreadcrumbs(projects), [projects]);

  useEffect(() => {
    let cancelled = false;
    const prefill = item ? inboxProcessingPrefill(item.title) : "";
    setBody("");
    setProjectQuery(prefill);
    setProjectId("");
    setDesiredOutcome("");
    setNextAction(prefill);
    setContext("");
    setWork(false);
    setSomeday(false);
    setFileOriginal(false);
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
    work,
    fileOriginal,
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
  const primary = inboxPrimaryDisposition({
    someday,
    fileOriginal,
    projectName,
    projectExists: Boolean(selectedProject),
    nextAction,
    context,
  });

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
          <button onClick={() => void services.openFile(item.file)}>{item.file.extension === "md" ? "Open note" : "Open file"}</button>
        </div>
        {isVaultAudio(item.file)
          // A voice capture is the note, so play it here instead of telling the reader to open the file.
          ? <InboxAudio src={services.app.vault.getResourcePath(item.file)} />
          : <div class={`dg-inbox-preview${body ? "" : " is-empty"}`}>{body || "No additional notes."}</div>}
        <label class="dg-processing-toggle dg-inbox-file-toggle">
          <span>File with Project</span>
          <input type="checkbox" checked={fileOriginal} onChange={(event: Event) => setFileOriginal((event.currentTarget as HTMLInputElement).checked)} />
          <small>{someday
            // Nothing absorbs a parked capture's content, so say plainly that it is discarded.
            ? "Keeps this capture as Project support material. Otherwise it goes to Obsidian's trash once the Project exists."
            : item.file.extension === "md"
              ? "Keeps this note as reference and creates a separate Action. Otherwise the note itself becomes the Action."
              : "Keeps this file as support material, or in General Reference with no Project. Otherwise it goes to Obsidian's trash once processed."}</small>
        </label>
      </section>

      <section class="dg-processing-form" aria-label="Clarify Inbox Item">
        <div class="dg-processing-grid">
          <ProcessingField label="Project" wide hint={projectQuery.trim() && !selectedProject ? `A new ${someday ? "Someday/Maybe" : "Active"} Project will be created when needed.` : "Optional. Select an existing Project or type a new name."}>
            <FuzzyField
              value={projectQuery}
              placeholder="Search or name a Project…"
              options={projects.map((project) => ({ id: project.id, label: projectLabels.get(project.id) ?? project.title, aliases: [project.title], ...(project.area ? { meta: project.area } : {}) }))}
              onChange={(value) => {
                setProjectQuery(value);
                if (value !== selectedProjectLabel) setProjectId("");
              }}
              onChoose={(option) => {
                setProjectQuery(option.label);
                setProjectId(option.id);
              }}
            />
            <label class="dg-processing-inline-toggle" title="Parks the Project instead of activating it. An existing Project is moved to Someday/Maybe; without one, this Item's title names it.">
              <input type="checkbox" checked={someday} onChange={(event: Event) => setSomeday((event.currentTarget as HTMLInputElement).checked)} />
              <span>Someday/Maybe</span>
            </label>
          </ProcessingField>

          <ProcessingField label="Project Vision" wide hint="Applied when a Project is selected or created.">
            <textarea value={desiredOutcome} placeholder="What will be true when this Project is complete?" onInput={(event: Event) => setDesiredOutcome((event.currentTarget as HTMLTextAreaElement).value)} />
          </ProcessingField>

          <ProcessingField label="Next Action" hint="Required with a context for Action-producing dispositions.">
            <input value={nextAction} placeholder="What is the next physical Action?" onInput={(event: Event) => setNextAction((event.currentTarget as HTMLInputElement).value)} />
          </ProcessingField>

          <ProcessingField
            label="Context"
            hint={context.trim() && !contexts.some((value) => value.toLocaleLowerCase() === context.trim().toLocaleLowerCase()) ? "This new context will be stored on the Action." : "Required when creating a Next Action."}
            adornment={<label class="dg-processing-inline-toggle" title="Marks the Action as work, independent of its context.">
              <input type="checkbox" checked={work} onChange={(event: Event) => setWork((event.currentTarget as HTMLInputElement).checked)} />
              <span>Work</span>
            </label>}
          >
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
        <button
          class="mod-cta"
          title={primary.label}
          disabled={!primary.ready || busy}
          onClick={() => void run(
            () => processInbox(services, primary.operation, item, input()),
            processedMessage(primary.operation, projectName),
          )}
        >{primary.label}</button>
        <button class="mod-warning" disabled={busy} onClick={() => void run(() => services.repository.trashInboxItem(item), "Inbox Item deleted.")}>Delete</button>
      </section>

      {seconds === 0 && <div class="dg-warning">Two minutes elapsed. Make the smallest clear decision and keep moving.</div>}
    </div>
  );
}

function processInbox(
  services: GtdServices,
  operation: InboxPrimaryDisposition["operation"],
  item: InboxItem,
  input: InboxProcessingInput,
): Promise<void> {
  if (operation === "someday") return services.repository.processInboxAsSomedayProject(item, input);
  if (operation === "file") return services.repository.processInboxAsReference(item, input);
  return services.repository.processInboxAsNextAction(item, input);
}

function processedMessage(operation: InboxPrimaryDisposition["operation"], projectName: string): string {
  if (operation === "someday") return "Filed as a Someday/Maybe Project.";
  if (operation === "file") return projectName ? "Filed with Project." : "Filed as General Reference.";
  return "Next Action created.";
}

function InboxAudio({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  // Dropping the element does not reliably stop playback, so pause before moving to the next Item.
  useEffect(() => {
    const element = ref.current;
    return () => element?.pause();
  }, [src]);
  return <audio ref={ref} class="dg-inbox-audio" controls preload="metadata" src={src} />;
}

function ProcessingField({ label, hint, wide = false, adornment, children }: {
  label: string;
  hint: string;
  wide?: boolean;
  /** Sits on the label's own line. A nested control rules out wrapping the field in a label. */
  adornment?: ComponentChildren;
  children: ComponentChildren;
}) {
  return <div class={`dg-processing-field${wide ? " is-wide" : ""}`}>
    <div class="dg-processing-field-heading"><span>{label}</span>{adornment}</div>
    {children}
    <small>{hint}</small>
  </div>;
}

function compareInboxItems(left: InboxItem, right: InboxItem): number {
  const created = left.created.localeCompare(right.created);
  return created === 0 ? left.id.localeCompare(right.id) : created;
}

function formatTimer(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
