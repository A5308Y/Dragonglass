/**
 * Planning a Project the GTD way (David Allen's Natural Planning Model): its purpose, the desired
 * outcome, ideas, then each idea organised into a Next Action, a Sub-project (possibly after another
 * one), a Someday sub-project, or dropped. What follows from that is plain Dragonglass data; the
 * branches still without a Next Action are found by the existing review check afterwards.
 */

export const PLAN_KINDS = ["action", "subproject", "someday", "drop"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

/** One idea and what to make of it. `after` is `""`, `idea:<index>` or `project:<id>`. */
export interface PlanItem {
  title: string;
  kind: PlanKind;
  context: string;
  after: string;
}

export interface ProjectPlan {
  projectId: string;
  purpose: string;
  desiredOutcome: string;
  items: PlanItem[];
}

/** A Sub-project to create, and what it waits for: an idea created earlier in this plan, or an existing Project. */
export interface PlannedSubproject {
  index: number;
  title: string;
  someday: boolean;
  afterIdea?: number;
  afterProjectId?: string;
}

export interface PlannedSteps {
  /** In creation order: a Sub-project always after the one it waits for. */
  subprojects: PlannedSubproject[];
  actions: Array<{ title: string; context: string }>;
  dropped: string[];
}

/**
 * Checks the decisions and orders them. Throws with a message for the dialog when an Action has no
 * context or a Sub-project waits for something that isn't a Sub-project of this plan or the tree.
 */
export function plannedSteps(items: readonly PlanItem[], treeProjectIds: ReadonlySet<string>): PlannedSteps {
  const kept = items.map((item) => ({ ...item, title: item.title.trim(), context: item.context.trim() }));
  const subprojects: PlannedSubproject[] = [];
  const actions: Array<{ title: string; context: string }> = [];
  const dropped: string[] = [];
  kept.forEach((item, index) => {
    if (!item.title) return;
    if (item.kind === "drop") {
      dropped.push(item.title);
    } else if (item.kind === "action") {
      if (!item.context) throw new Error(`“${item.title}” needs a context to be a Next Action.`);
      actions.push({ title: item.title, context: item.context });
    } else {
      const planned: PlannedSubproject = { index, title: item.title, someday: item.kind === "someday" };
      if (item.after.startsWith("idea:")) {
        const other = Number(item.after.slice(5));
        const target = kept[other];
        if (!Number.isInteger(other) || other === index || !target?.title || (target.kind !== "subproject" && target.kind !== "someday")) {
          throw new Error(`“${item.title}” waits for something that isn't a Sub-project of this plan.`);
        }
        planned.afterIdea = other;
      } else if (item.after.startsWith("project:")) {
        const projectId = item.after.slice(8);
        if (!treeProjectIds.has(projectId)) throw new Error(`“${item.title}” waits for a Project outside this one.`);
        planned.afterProjectId = projectId;
      }
      subprojects.push(planned);
    }
  });
  return { subprojects: orderByWaiting(subprojects), actions, dropped };
}

/** Sub-projects so that each comes after the one it waits for; a cycle is refused. */
function orderByWaiting(subprojects: readonly PlannedSubproject[]): PlannedSubproject[] {
  const byIndex = new Map(subprojects.map((planned) => [planned.index, planned]));
  const ordered: PlannedSubproject[] = [];
  const done = new Set<number>();
  const visiting = new Set<number>();
  const visit = (planned: PlannedSubproject) => {
    if (done.has(planned.index)) return;
    if (visiting.has(planned.index)) throw new Error(`“${planned.title}” waits for itself through other Sub-projects.`);
    visiting.add(planned.index);
    const before = planned.afterIdea === undefined ? undefined : byIndex.get(planned.afterIdea);
    if (before) visit(before);
    visiting.delete(planned.index);
    done.add(planned.index);
    ordered.push(planned);
  };
  for (const planned of subprojects) visit(planned);
  return ordered;
}

/** The Diary entry a plan leaves, so its decisions, and the ideas it dropped, stay with the Project. */
export function planDiaryEntry(steps: PlannedSteps): string {
  const list = (label: string, titles: readonly string[]) => (titles.length ? [`${label}: ${titles.join("; ")}`] : []);
  const lines = [
    ...list("Next Actions", steps.actions.map((action) => action.title)),
    ...list("Sub-projects", steps.subprojects.filter((planned) => !planned.someday).map((planned) => planned.title)),
    ...list("Someday", steps.subprojects.filter((planned) => planned.someday).map((planned) => planned.title)),
    ...list("Dropped ideas", steps.dropped),
  ];
  return ["Planned the Project.", ...lines].join("\n");
}

/** Ideas typed one per line, as a list of ideas; bullets and numbering are taken off. */
export function ideasFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").trim())
    .filter(Boolean);
}
