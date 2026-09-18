import { Notice } from "obsidian";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { InboxItem } from "../domain/types";
import { useGtdSnapshot } from "../ui/hooks";
import { CreateProjectFromInboxModal, FileInboxItemWithProjectModal } from "../ui/modals";
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
          onSkip={() => setCursor((current) => allItems.length ? (current + 1) % allItems.length : 0)}
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
  onSkip,
}: {
  services: GtdServices;
  items: readonly InboxItem[];
  cursor: number;
  sessionTotal: number;
  onSkip: () => void;
}) {
  const item = items.length ? items[cursor % items.length] : undefined;
  const [body, setBody] = useState("");
  const [seconds, setSeconds] = useState(120);

  useEffect(() => {
    let cancelled = false;
    setBody("");
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
  const run = async (operation: () => Promise<void>, message: string) => {
    try {
      await operation();
      new Notice(message);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "The Inbox operation failed.");
    }
  };

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

      <section class="dg-processor-actions">
        <button class="mod-cta" onClick={() => services.processInboxItem(item)}>Create Action</button>
        <button onClick={() => new CreateProjectFromInboxModal(services, item, "active").open()}>Create Project</button>
        <button onClick={() => new CreateProjectFromInboxModal(services, item, "someday").open()}>Someday/Maybe Project</button>
        <button onClick={() => new FileInboxItemWithProjectModal(services, item).open()}>File with Project</button>
        <button onClick={() => void run(() => services.repository.fileInboxItemAsReference(item.id), "Filed as reference.")}>Reference</button>
        <button onClick={onSkip}>Skip</button>
        <button class="mod-warning" onClick={() => {
          if (window.confirm(`Move “${item.title}” to Obsidian's trash?`)) void run(() => services.repository.trashInboxItem(item.id), "Moved to trash.");
        }}>Trash</button>
      </section>

      {seconds === 0 && <div class="dg-warning">Two minutes elapsed. Make the smallest clear decision and keep moving.</div>}
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
