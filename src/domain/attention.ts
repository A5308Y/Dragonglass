import { projectActionIssue } from "./project-board";
import { isAllDaySchedule } from "./schedule";
import type { Action, GtdSnapshot } from "./types";
import { addLocalDays, localDate } from "../utils/date";

/** How long a top-level Project may go unreviewed before the Project Review asks for it. */
export const REVIEW_INTERVAL_DAYS = 7;

/** Which views have something waiting to be done, for the dots on their ribbon icons. */
export interface Attention {
  /** Inbox Items still to process. */
  inbox: boolean;
  /** Overdue Actions, Waiting Actions due for follow-up, and Calendar Actions dated today or earlier. */
  board: boolean;
  /** Active Projects with an issue, such as no open Action. */
  projects: boolean;
  /** Active top-level Projects not reviewed in the last week. */
  review: boolean;
  /** Unread feed Items. */
  feeds: boolean;
}

export function attention(snapshot: GtdSnapshot, unreadFeedItems: number, today = localDate()): Attention {
  const lastReviewDue = addLocalDays(today, -REVIEW_INTERVAL_DAYS);
  return {
    inbox: snapshot.inboxItems.length > 0,
    board: snapshot.actions.some((action) => actionNeedsAttention(action, today)),
    projects: snapshot.projects.some((project) =>
      project.status === "active" && projectActionIssue(project, snapshot.projects, snapshot.actions) !== null),
    review: snapshot.projects.some((project) =>
      project.status === "active" && !project.parentProjectId && (!project.reviewed || project.reviewed <= lastReviewDue)),
    feeds: unreadFeedItems > 0,
  };
}

/**
 * An Action that needs attention today: overdue, a Waiting Action due for follow-up,
 * or a Calendar Action dated today or earlier. `needsAttention` in `ActionBoard.elm`
 * marks cards and counts columns by the same rule; change both together.
 */
export function actionNeedsAttention(action: Action, today = localDate()): boolean {
  if (action.status === "done" || action.status === "cancelled") return false;
  if (action.due && action.due < today) return true;
  if (action.status === "waiting" && action.followUp && action.followUp <= today) return true;
  if (action.status === "scheduled" && action.scheduledStart) return scheduledDay(action.scheduledStart) <= today;
  return false;
}

/** The local day a Calendar Action falls on: the date itself, or the day of its start time. */
function scheduledDay(scheduledStart: string): string {
  return isAllDaySchedule(scheduledStart) ? scheduledStart : localDate(new Date(scheduledStart));
}
