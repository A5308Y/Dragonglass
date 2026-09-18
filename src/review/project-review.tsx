import { Notice } from "obsidian";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Project } from "../domain/types";
import { projectBreadcrumbs } from "../domain/project-hierarchy";
import { activeProjectsWithoutNextAction, projectReviewMembers, projectReviewQueue, projectsBlockingReview } from "../domain/project-review";
import { ActionRows } from "../ui/action-rows";
import { FuzzyField } from "../ui/fuzzy-field";
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
  const [queue, setQueue] = useState<string[]>(() => projectReviewQueue(snapshot, localDate()));
  const [total] = useState(queue.length);
  const project = queue.length ? snapshot.projectsById.get(queue[0]!) : undefined;
  const [desiredOutcome, setDesiredOutcome] = useState("");
  const [diary, setDiary] = useState<DiaryEntry[]>([]);
  const [diaryInput, setDiaryInput] = useState("");
  const [actionTitle, setActionTitle] = useState("");
  const [actionProjectId, setActionProjectId] = useState("");
  const [actionProjectQuery, setActionProjectQuery] = useState("");
  const [context, setContext] = useState("");
  const [saving, setSaving] = useState(false);
  const timers = useReviewTimers(total, project?.id);

  const reviewProjects = useMemo(() => project ? projectReviewMembers(project, snapshot.projects) : [], [snapshot, project?.id]);
  const reviewProjectIds = useMemo(() => new Set(reviewProjects.map((candidate) => candidate.id)), [reviewProjects]);
  const reviewProjectLabels = useMemo(() => projectBreadcrumbs(snapshot.projects), [snapshot]);
  const activeReviewProjects = reviewProjects.filter((candidate) => candidate.status === "active");
  const subprojects = reviewProjects.filter((candidate) => candidate.id !== project?.id);
  const projectActions = useMemo(
    () => snapshot.actions.filter((action) => action.projectId && reviewProjectIds.has(action.projectId)),
    [snapshot, reviewProjectIds],
  );
  const openActions = projectActions.filter((action) => action.status !== "done" && action.status !== "cancelled");
  const nextActions = openActions.filter((action) => action.status === "next");
  const doneActions = projectActions.filter((action) => action.status === "done");
  const missingNextProjects = activeProjectsWithoutNextAction(reviewProjects, projectActions);
  const blockingProjects = project ? projectsBlockingReview(project, reviewProjects, projectActions) : [];
  const needsNextAction = blockingProjects.length > 0;
  const supportFileCount = reviewProjects.reduce((total, candidate) => total + services.repository.supportFiles(candidate).length, 0);
  const contexts = [...new Set(snapshot.actions.map((action) => action.context).filter((value): value is string => Boolean(value)))].sort();

  useEffect(() => {
    let cancelled = false;
    setDesiredOutcome("");
    setDiary([]);
    setDiaryInput("");
    setActionTitle("");
    const defaultActionProject = blockingProjects[0] ?? missingNextProjects[0] ?? project;
    setActionProjectId(defaultActionProject?.id ?? "");
    setActionProjectQuery(defaultActionProject ? reviewProjectLabels.get(defaultActionProject.id) ?? defaultActionProject.title : "");
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
        <div class="dg-workflow-complete"><span>✅</span><h3>Review complete</h3><p>{total ? `All ${total} Project trees were reviewed.` : "No Projects need review today."}</p></div>
      </div>
    );
  }

  const addAction = async () => {
    const title = actionTitle.trim();
    if (!title) return;
    setSaving(true);
    try {
      const targetProject = reviewProjects.find((candidate) => candidate.id === actionProjectId);
      if (!targetProject) throw new Error("Select a Project for the Next Action.");
      await services.repository.createClarifiedAction({
        title,
        status: "next",
        projectId: targetProject.id,
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
    if (needsNextAction) {
      new Notice("Add a Next Action or move this Project to Someday/Maybe before continuing.");
      return;
    }
    setSaving(true);
    try {
      await services.repository.setDesiredOutcome(project.id, desiredOutcome);
      for (const candidate of activeReviewProjects) await services.repository.markProjectReviewed(candidate.id);
      setQueue((current) => current.slice(1));
    } catch (error) {
      new Notice(message(error));
    } finally {
      setSaving(false);
    }
  };

  const moveToSomeday = async () => {
    setSaving(true);
    try {
      await services.repository.setDesiredOutcome(project.id, desiredOutcome);
      await services.repository.updateProject(project.id, { status: "someday", reviewed: localDate() });
      for (const candidate of activeReviewProjects) {
        if (candidate.id !== project.id) await services.repository.markProjectReviewed(candidate.id);
      }
      setQueue((current) => current.slice(1));
      new Notice(`Moved “${project.title}” to Someday/Maybe.`);
    } catch (error) {
      new Notice(message(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteProject = async () => {
    const children = snapshot.projects.filter((candidate) => candidate.parentProjectId === project.id);
    if (children.length) {
      new Notice(`Move or delete ${children.length} sub-project${children.length === 1 ? "" : "s"} first.`);
      return;
    }
    const linkedActions = projectActions.filter((action) => action.projectId === project.id).length;
    const supportFiles = services.repository.supportFiles(project).length;
    const supportDescription = project.supportPath
      ? `${supportFiles} support file${supportFiles === 1 ? "" : "s"} in “${project.supportPath}”`
      : "no configured support folder";
    if (!window.confirm(
      `Delete “${project.title}”?\n\nThis moves the Project note, ${linkedActions} directly linked Action${linkedActions === 1 ? "" : "s"}, and ${supportDescription} to Obsidian's trash.`,
    )) return;

    setSaving(true);
    try {
      await services.repository.trashProject(project.id);
      setQueue((current) => current.slice(1));
      new Notice(`Deleted Project, ${linkedActions} Action${linkedActions === 1 ? "" : "s"}, and its support material.`);
    } catch (error) {
      new Notice(message(error));
    } finally {
      setSaving(false);
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
            <span class="dg-review-eyebrow">Project tree {total - queue.length + 1} of {total}</span>
            <button class="dg-project-title" onClick={() => void services.openFile(project.file)}>{project.title}</button>
            <div class="dg-review-project-meta">
              <span class="dg-status">{project.area || projectStatusLabel(project.status)}</span>
              <span>{reviewProjects.length} Project{reviewProjects.length === 1 ? "" : "s"}</span>
              <span>{openActions.length} open</span>
              <span>{nextActions.length} next</span>
            </div>
          </div>
          {needsNextAction && <span class="dg-no-next">{blockingProjects.length} without Next Action</span>}
        </section>

        {subprojects.length > 0 && <section class="dg-review-panel dg-review-tree-panel">
          <div class="dg-review-panel-heading dg-review-panel-heading-row">
            <span class="dg-review-panel-icon">⌘</span>
            <div><h3>Project tree</h3><p>Reviewed together as one outcome hierarchy.</p></div>
            <span class="dg-review-count">{subprojects.length}</span>
          </div>
          <div class="dg-review-tree-list">
            {subprojects.map((candidate) => {
              const actions = projectActions.filter((action) => action.projectId === candidate.id && action.status !== "done" && action.status !== "cancelled");
              const next = actions.filter((action) => action.status === "next").length;
              const missing = candidate.status === "active" && next === 0;
              return <div key={candidate.id}>
                <button title={reviewProjectLabels.get(candidate.id)} onClick={() => void services.openFile(candidate.file)}>{reviewProjectLabel(candidate, project, snapshot.projectsById)}</button>
                <span>{projectStatusLabel(candidate.status)}</span>
                <span>{actions.length} open · {next} next</span>
                {missing && <strong>No Next Action</strong>}
              </div>;
            })}
          </div>
        </section>}

        <section class="dg-review-grid">
          <div class="dg-review-panel dg-review-outcome-panel">
            <div class="dg-review-panel-heading">
              <span class="dg-review-panel-icon">◎</span>
              <div><h3>Desired outcome</h3><p>Reconnect with what done looks like.</p></div>
            </div>
            <textarea value={desiredOutcome} placeholder="What will be true when this Project is complete?" onInput={(event: Event) => setDesiredOutcome((event.currentTarget as HTMLTextAreaElement).value)} />
          </div>

          <div class="dg-review-panel dg-review-pulse-panel">
            <div class="dg-review-panel-heading">
              <span class="dg-review-panel-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
              </span>
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
          <ActionRows actions={openActions} services={services} projectLabels={reviewProjectLabels} />
          <div class="dg-action-capture">
            <input value={actionTitle} placeholder="Define the next physical Action…" onInput={(event: Event) => setActionTitle((event.currentTarget as HTMLInputElement).value)} onKeyDown={(event: KeyboardEvent) => { if (event.key === "Enter") void addAction(); }} />
            <FuzzyField
              value={actionProjectQuery}
              placeholder="Project"
              options={reviewProjects.map((candidate) => ({ id: candidate.id, label: reviewProjectLabels.get(candidate.id) ?? candidate.title, meta: candidate.status }))}
              onChange={(value) => {
                setActionProjectQuery(value);
                const match = reviewProjects.find((candidate) => (reviewProjectLabels.get(candidate.id) ?? candidate.title) === value);
                setActionProjectId(match?.id ?? "");
              }}
              onChoose={(option) => {
                setActionProjectId(option.id);
                setActionProjectQuery(option.label);
              }}
            />
            <FuzzyField
              value={context}
              placeholder="Context"
              options={contexts.map((value) => ({ id: value, label: value }))}
              onChange={setContext}
              onChoose={(option) => setContext(option.label)}
            />
            <button class="mod-cta" disabled={!actionTitle.trim() || !actionProjectId || saving} onClick={() => void addAction()}>Add Next Action</button>
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
              <div><strong>{supportFileCount}</strong><span>support file{supportFileCount === 1 ? "" : "s"}</span></div>
            </div>
          </div>
        </section>

        <div class="dg-workflow-footer">
          <div>
            <strong>{needsNextAction ? `${blockingProjects.length} active Project${blockingProjects.length === 1 ? " needs" : "s need"} a Next Action.` : "Ready to move on?"}</strong>
            {needsNextAction && <span>Add the missing Next Actions above or move the root Project to Someday/Maybe.</span>}
          </div>
          <div class="dg-review-footer-actions">
            <button class="mod-warning" disabled={saving} onClick={() => void deleteProject()}>Delete Project</button>
            <button disabled={saving} onClick={() => void moveToSomeday()}>Move to Someday/Maybe</button>
            <button
              class="mod-cta"
              disabled={saving || needsNextAction}
              title={needsNextAction ? "Every active sub-project needs a Next Action." : undefined}
              onClick={() => void nextProject()}
            >Mark reviewed and continue →</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function reviewProjectLabel(project: Project, root: Project, projectsById: ReadonlyMap<string, Project>): string {
  if (project.id === root.id) return project.title;
  const titles: string[] = [];
  const seen = new Set<string>();
  let current: Project | undefined = project;
  while (current && current.id !== root.id && !seen.has(current.id)) {
    seen.add(current.id);
    titles.unshift(current.title);
    current = current.parentProjectId ? projectsById.get(current.parentProjectId) : undefined;
  }
  return titles.join(" > ") || project.title;
}

function projectStatusLabel(status: Project["status"]): string {
  if (status === "someday") return "Someday/Maybe";
  return status.charAt(0).toUpperCase() + status.slice(1);
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
