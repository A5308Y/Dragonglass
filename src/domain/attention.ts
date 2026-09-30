import { projectActionIssue } from "./project-board";
import { isAllDaySchedule } from "./schedule";
import type { Action, GtdSnapshot } from "./types";
import { localDate } from "../utils/date";
import { weeklyReviewDue, type WeeklyReviewSettings } from "./weekly-review";

/** Which views have something waiting to be done, for the dots on their ribbon icons. */
export interface Attention {
  /** Inbox Items still to process. */
  inbox: boolean;
  /** Overdue Actions, Waiting Actions due for follow-up, and Calendar Actions left open from an earlier day. */
  board: boolean;
  /** Active Projects with an issue, such as no open Action. */
  projects: boolean;
  /** This week's review is due and not finished yet (see `weeklyReviewDue`). */
  review: boolean;
  /** Unread feed Items. */
  feeds: boolean;
  /** The daily checklist has no finished run today. */
  checklists: boolean;
}

export function attention(
  snapshot: GtdSnapshot,
  unreadFeedItems: number,
  review: WeeklyReviewSettings,
  today = localDate(),
  dailyChecklistDue = false,
): Attention {
  return {
    inbox: snapshot.inboxItems.length > 0,
    board: snapshot.actions.some((action) => actionNeedsAttention(action, today)),
    projects: projectsWithIssues(snapshot) > 0,
    review: weeklyReviewDue(snapshot, review, today),
    feeds: unreadFeedItems > 0,
    checklists: dailyChecklistDue,
  };
}

/**
 * How many Active Projects have an issue, such as no open Action anywhere in their
 * tree: the Projects view's "Issues only", which the Inbox points to once it is empty.
 */
export function projectsWithIssues(snapshot: GtdSnapshot): number {
  return snapshot.projects.filter((project) =>
    project.status === "active" && projectActionIssue(project, snapshot.projects, snapshot.actions) !== null).length;
}

/**
 * An Action that needs attention today: overdue, a Waiting Action due for follow-up,
 * or a Calendar Action from an earlier day that was never ticked off. Today's Calendar
 * Actions don't count: the board lists them above its columns anyway, and they are
 * not late. `needsAttention` in `ActionBoard.elm` marks cards and counts columns by
 * the same rule; change both together.
 */
export function actionNeedsAttention(action: Action, today = localDate()): boolean {
  if (action.status === "done" || action.status === "cancelled") return false;
  if (action.due && action.due < today) return true;
  if (action.status === "waiting" && action.followUp && action.followUp <= today) return true;
  if (action.status === "scheduled" && action.scheduledStart) return scheduledDay(action.scheduledStart) < today;
  return false;
}

/** The local day a Calendar Action falls on: the date itself, or the day of its start time. */
function scheduledDay(scheduledStart: string): string {
  return isAllDaySchedule(scheduledStart) ? scheduledStart : localDate(new Date(scheduledStart));
}
