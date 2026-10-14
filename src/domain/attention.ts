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
  /** Unread feed Items left since the last feed check time (see `feedsDue`). */
  feeds: boolean;
  /** The daily checklist has no finished run today. */
  checklists: boolean;
}

export function attention(
  snapshot: GtdSnapshot,
  feedsWaiting: boolean,
  review: WeeklyReviewSettings,
  today = localDate(),
  dailyChecklistDue = false,
): Attention {
  return {
    inbox: snapshot.inboxItems.length > 0,
    board: snapshot.actions.some((action) => actionNeedsAttention(action, today)),
    projects: projectsWithIssues(snapshot) > 0,
    review: weeklyReviewDue(snapshot, review, today),
    feeds: feedsWaiting,
    checklists: dailyChecklistDue,
  };
}

/** When the feeds dot may come on, as local `HH:MM` times. */
export const DEFAULT_FEED_CHECK_TIMES = ["08:00", "16:00"];

/**
 * Feeds only ask for attention at a few check times a day: the dot comes on at a
 * check time while Items are unread, and goes off once the Feeds view has been
 * opened, staying off until the next check time however many Items arrive meanwhile.
 * `lastViewed` is when the view was last opened (ISO, `""` for never).
 */
export function feedsDue(unreadFeedItems: number, lastViewed: string, times: readonly string[], now = new Date()): boolean {
  if (unreadFeedItems === 0) return false;
  const viewed = Date.parse(lastViewed);
  return Number.isNaN(viewed) || viewed < latestFeedCheck(times, now).getTime();
}

/** The last check time at or before `now`, yesterday's if none has come yet today. */
export function latestFeedCheck(times: readonly string[], now = new Date()): Date {
  const today = feedChecksOn(times, now, 0).filter((check) => check <= now);
  return today.length ? today[today.length - 1]! : feedChecksOn(times, now, -1).at(-1)!;
}

/** The first check time after `now`, tomorrow's if today's have all passed. */
export function nextFeedCheck(times: readonly string[], now = new Date()): Date {
  return feedChecksOn(times, now, 0).find((check) => check > now) ?? feedChecksOn(times, now, 1)[0]!;
}

/** Reads check times from settings, keeping valid `HH:MM` times, sorted; the defaults if none is valid. */
export function parseFeedCheckTimes(value: unknown): string[] {
  const times = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .map((time) => (typeof time === "string" ? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(time) : null))
    .filter((match): match is RegExpExecArray => match !== null && Number(match[1]) < 24 && Number(match[2]) < 60)
    .map((match) => `${match[1]!.padStart(2, "0")}:${match[2]}`);
  return times.length ? [...new Set(times)].sort() : [...DEFAULT_FEED_CHECK_TIMES];
}

function feedChecksOn(times: readonly string[], now: Date, dayOffset: number): Date[] {
  return parseFeedCheckTimes(times).map((time) => {
    const [hours, minutes] = time.split(":").map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hours, minutes);
  });
}

/**
 * How many Project trees have an issue, such as no open Action anywhere in them: the
 * top-level Projects whose issue covers their whole tree, so a stuck sub-project counts once,
 * through the Project at its top. The Projects view's column counts follow the same rule
 * (`issueCount` in `Projects.elm`), and the Inbox points there once it is empty.
 */
export function projectsWithIssues(snapshot: GtdSnapshot): number {
  return snapshot.projects.filter((project) =>
    project.status === "active"
    && !(project.parentProjectId && snapshot.projectsById.has(project.parentProjectId))
    && projectActionIssue(project, snapshot.projects, snapshot.actions) !== null).length;
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
