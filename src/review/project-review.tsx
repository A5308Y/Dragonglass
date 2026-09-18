import { Notice } from "obsidian";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Action, GtdSnapshot, Project } from "../domain/types";
import type { DiaryEntry } from "../utils/markdown";
import { localDate } from "../utils/date";
import { useGtdSnapshot } from "../ui/hooks";
import type { GtdServices } from "../ui/services";

const DIARY_EMOJIS = [
  ["👍", "no progress, but looks good"],
  ["🌱", "slow progress"],
  ["🛠️", "progress"],
  ["🚀", "great progress"],
  ["😰", "fear"],
  ["😴", "indifference"],
  ["😖", "stuck"],
] as const;

export function ProjectReview({ services }: { services: GtdServices }) {
  const snapshot = useGtdSnapshot(services.repository.index);
  const [queue, setQueue] = useState<string[]>(() => reviewQueue(snapshot));
  const [total] = useState(queue.length);
  const project = queue.length ? snapshot.projectsById.get(queue[0]!) : undefined;
  const [desiredOutcome, setDesiredOutcome] = useState("");
  const [diary, setDiary] = useState<DiaryEntry[]>([]);
  const [diaryInput, setDiaryInput] = useState("");
  const [actionTitle, setActionTitle] = useState("");
  const [context, setContext] = useState("");
  const [saving, setSaving] = useState(false);
  const timers = useReviewTimers(total, project?.id);

  const projectActions = useMemo(
    () => project ? snapshot.actions.filter((action) => action.projectId === project.id) : [],
    [snapshot, project?.id],
  );
  const openActions = projectActions.filter((action) => action.status !== "done" && action.status !== "cancelled");
  const nextActions = openActions.filter((action) => action.status === "next");
  const doneActions = projectActions.filter((action) => action.status === "done");
  const contexts = [...new Set(snapshot.actions.map((action) => action.context).filter((value): value is string => Boolean(value)))].sort();

  useEffect(() => {
    let cancelled = false;
    setDesiredOutcome("");
    setDiary([]);
    setDiaryInput("");
    setActionTitle("");
    setContext("");
    if (project) {
      void Promise.all([
        services.repository.readDesiredOutcome(project),
        services.repository.readProjectDiary(project),
      ]).then(([outcome, entries]) => {
        if (!cancelled) {
          setDesiredOutcome(outcome);
          setDiary(entries);
        }
      });
    }
    return () => { cancelled = true; };
  }, [project?.id]);

  if (!project) {
    return (
      <div class="dg-view dg-review-view">
        <header class="dg-view-header"><div><h2>Project Review</h2></div></header>
        <div class="dg-workflow-complete"><span>✅</span><h3>Review complete</h3><p>{total ? `All ${total} Projects were reviewed.` : "No Projects need review today."}</p></div>
      </div>
    );
  }

  const completeAction = async (action: Action) => {
    try {
      await services.repository.setActionStatus(action.id, "done");
    } catch (error) {
      new Notice(message(error));
    }
  };

  const addAction = async () => {
    const title = actionTitle.trim();
    if (!title) return;
    setSaving(true);
    try {
      await services.repository.createClarifiedAction({
        title,
        status: "next",
        projectId: project.id,
        ...(context.trim() ? { context: context.trim() } : {}),
      });
      setActionTitle("");
      setContext("");
      new Notice("Next Action created from a captured Inbox Item.");
    } catch (error) {
      new Notice(message(error));
    } finally {
      setSaving(false);
    }
  };

  const addDiary = async (text: string) => {
    if (!text.trim()) return;
    try {
      const entry = await services.repository.addProjectDiaryEntry(project.id, text);
      setDiary((current) => [entry, ...current]);
      setDiaryInput("");
    } catch (error) {
      new Notice(message(error));
    }
  };

  const nextProject = async () => {
    try {
      await services.repository.setDesiredOutcome(project.id, desiredOutcome);
      await services.repository.markProjectReviewed(project.id);
      setQueue((current) => current.slice(1));
    } catch (error) {
      new Notice(message(error));
    }
  };

  return (
    <div class="dg-view dg-review-view">
      <header class="dg-view-header dg-review-header">
        <div class="dg-review-title">
          <span class="dg-review-eyebrow">Guided workflow</span>
          <h2>Project Review</h2>
        </div>
        <div class="dg-review-timers">
          <div><span>Session</span><strong>{formatTimer(timers.session)}</strong></div>
          <div class={timers.project <= 30 ? "is-overdue" : ""}><span>Project budget</span><strong>{formatTimer(timers.project)}</strong></div>
        </div>
      </header>
      <div class="dg-progress-track"><span style={{ width: `${total ? (total - queue.length) / total * 100 : 100}%` }} /></div>

      <div class="dg-review-content">
        <section class="dg-review-hero">
          <div class="dg-review-hero-copy">
            <span class="dg-review-eyebrow">Project {total - queue.length + 1} of {total}</span>
            <button class="dg-project-title" onClick={() => void services.openFile(project.file)}>{project.title}</button>
            <div class="dg-review-project-meta">
              <span class="dg-status">{project.area || project.status}</span>
              <span>{openActions.length} open</span>
              <span>{nextActions.length} next</span>
            </div>
          </div>
          {!nextActions.length && <span class="dg-no-next">No Next Action</span>}
        </section>

        <section class="dg-review-grid">
          <div class="dg-review-panel dg-review-outcome-panel">
            <div class="dg-review-panel-heading">
              <span class="dg-review-panel-icon">◎</span>
              <div><h3>Desired outcome</h3><p>Reconnect with what done looks like.</p></div>
            </div>
            <textarea value={desiredOutcome} placeholder="What will be true when this Project is complete?" onInput={(event: Event) => setDesiredOutcome((event.currentTarget as HTMLTextAreaElement).value)} />
            <div class="dg-review-panel-footer"><span>Markdown is written to the Project note.</span><button onClick={() => void services.repository.setDesiredOutcome(project.id, desiredOutcome).then(() => new Notice("Desired outcome saved."), (error) => new Notice(message(error)))}>Save outcome</button></div>
          </div>

          <div class="dg-review-panel dg-review-pulse-panel">
            <div class="dg-review-panel-heading">
              <span class="dg-review-panel-icon">◌</span>
              <div><h3>Project pulse</h3><p>Capture the current texture of the work.</p></div>
            </div>
            <div class="dg-emoji-row">{DIARY_EMOJIS.map(([emoji, label]) => <button title={label} aria-label={label} onClick={() => void addDiary(`${emoji} ${label}`)}><span>{emoji}</span></button>)}</div>
            <div class="dg-inline-form">
              <input value={diaryInput} placeholder="Write a diary entry…" onInput={(event: Event) => setDiaryInput((event.currentTarget as HTMLInputElement).value)} onKeyDown={(event: KeyboardEvent) => { if (event.key === "Enter") void addDiary(diaryInput); }} />
              <button disabled={!diaryInput.trim()} onClick={() => void addDiary(diaryInput)}>Add</button>
            </div>
          </div>
        </section>

        <section class="dg-review-panel dg-review-actions-panel">
          <div class="dg-review-panel-heading dg-review-panel-heading-row">
            <span class="dg-review-panel-icon">→</span>
            <div><h3>Open Actions</h3><p>Confirm that the next visible step is concrete.</p></div>
            <span class="dg-review-count">{openActions.length}</span>
          </div>
          <div class="dg-review-actions">
            {openActions.map((action) => <label key={action.id}><input type="checkbox" onChange={() => void completeAction(action)} /><button onClick={() => void services.openFile(action.file)}>{action.title}</button><span>{action.status}{action.context ? ` · @${action.context}` : ""}</span></label>)}
            {!openActions.length && <div class="dg-empty-row">No open Actions.</div>}
          </div>
          <div class="dg-action-capture">
            <input value={actionTitle} placeholder="Define the next physical Action…" onInput={(event: Event) => setActionTitle((event.currentTarget as HTMLInputElement).value)} onKeyDown={(event: KeyboardEvent) => { if (event.key === "Enter") void addAction(); }} />
            <input list="dg-review-contexts" value={context} placeholder="Context" onInput={(event: Event) => setContext((event.currentTarget as HTMLInputElement).value)} />
            <datalist id="dg-review-contexts">{contexts.map((value) => <option value={value} />)}</datalist>
            <button class="mod-cta" disabled={!actionTitle.trim() || saving} onClick={() => void addAction()}>Add Next Action</button>
          </div>
        </section>

        <section class="dg-review-grid">
          <div class="dg-review-panel dg-review-diary-panel">
            <div class="dg-review-panel-heading dg-review-panel-heading-row">
              <span class="dg-review-panel-icon">≡</span>
              <div><h3>Diary</h3><p>Recent observations and decisions.</p></div>
              <span class="dg-review-count">{diary.length}</span>
            </div>
            <div class="dg-diary-list">{diary.map((entry, index) => <div key={`${entry.timestamp}-${index}`}><span>{entry.timestamp}</span><p>{entry.text}</p></div>)}{!diary.length && <span class="dg-muted">No entries yet.</span>}</div>
          </div>
          <div class="dg-review-panel dg-review-stats">
            <div class="dg-review-panel-heading">
              <span class="dg-review-panel-icon">◇</span>
              <div><h3>Project material</h3><p>A quick inventory before moving on.</p></div>
            </div>
            <div class="dg-review-stat-grid">
              <div><strong>{doneActions.length}</strong><span>completed Action{doneActions.length === 1 ? "" : "s"}</span></div>
              <div><strong>{services.repository.supportFiles(project).length}</strong><span>support file{services.repository.supportFiles(project).length === 1 ? "" : "s"}</span></div>
            </div>
          </div>
        </section>

        <div class="dg-workflow-footer">
          <div><strong>Ready to move on?</strong><span>The Desired outcome is saved automatically.</span></div>
          <div class="dg-review-footer-actions">
            <button onClick={() => setQueue((current) => current.length > 1 ? [...current.slice(1), current[0]!] : current)}>Review later</button>
            <button class="mod-cta" onClick={() => void nextProject()}>Mark reviewed and continue →</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function reviewQueue(snapshot: GtdSnapshot): string[] {
  const today = localDate();
  return snapshot.projects
    .filter((project) => project.status === "active" && project.reviewed !== today)
    .sort((left, right) => {
      const leftHasNext = snapshot.actions.some((action) => action.projectId === left.id && action.status === "next");
      const rightHasNext = snapshot.actions.some((action) => action.projectId === right.id && action.status === "next");
      if (leftHasNext !== rightHasNext) return leftHasNext ? 1 : -1;
      return left.title.localeCompare(right.title);
    })
    .map((project: Project) => project.id);
}

function useReviewTimers(total: number, projectId?: string): { session: number; project: number } {
  const [session, setSession] = useState(0);
  const [project, setProject] = useState(total ? Math.floor(3600 / total) : 0);
  useEffect(() => {
    const timer = window.setInterval(() => setSession((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setProject(total ? Math.floor(3600 / total) : 0);
    const timer = window.setInterval(() => setProject((value) => value - 1), 1000);
    return () => window.clearInterval(timer);
  }, [projectId]);
  return { session, project };
}

function formatTimer(seconds: number): string {
  const sign = seconds < 0 ? "−" : "";
  const absolute = Math.abs(seconds);
  return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The Project review operation failed.";
}
