import { useMemo, useState } from "preact/hooks";
import type { InboxItem } from "../domain/types";
import { useGtdSnapshot } from "../ui/hooks";
import type { GtdServices } from "../ui/services";

export function InboxView({ services }: { services: GtdServices }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [search, setSearch] = useState("");
  const items = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return [...snapshot.inboxItems]
      .filter((item) => !needle || item.title.toLocaleLowerCase().includes(needle))
      .sort(compareInboxItems);
  }, [snapshot, search]);

  return (
    <div class="dg-view dg-inbox-view">
      <header class="dg-view-header">
        <div>
          <h2>Inbox</h2>
          <span class="dg-count">{snapshot.inboxItems.length}</span>
        </div>
        <div class="dg-header-actions">
          <button class="mod-cta" onClick={services.quickCapture}>Capture</button>
        </div>
      </header>

      {snapshot.issues.length > 0 && (
        <div class="dg-warning" title={snapshot.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}>
          {snapshot.issues.length} GTD file{snapshot.issues.length === 1 ? " has" : "s have"} metadata problems.
        </div>
      )}

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
            <button class="mod-cta" onClick={() => services.processInboxItem(item)}>Process into Action</button>
          </article>
        ))}
        {items.length === 0 && <div class="dg-empty-row">{search ? "No Inbox Items match this search." : "Inbox zero."}</div>}
      </div>
    </div>
  );
}

function compareInboxItems(left: InboxItem, right: InboxItem): number {
  const created = left.created.localeCompare(right.created);
  return created === 0 ? right.id.localeCompare(left.id) : -created;
}
