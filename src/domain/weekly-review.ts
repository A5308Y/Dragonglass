import { projectReviewQueue } from "./project-review";
import type { GtdSnapshot } from "./types";
import { addLocalDays, localDate, parseDateOnly } from "../utils/date";

/** Friday, as `Date.getDay()` counts: the Weekly Review's default day. */
export const DEFAULT_WEEKLY_REVIEW_DAY = 5;

export interface WeeklyReviewSettings {
  /** The weekday the review falls due, as `Date.getDay()` counts: 0 is Sunday. */
  weeklyReviewDay: number;
  /** The day the last weekly review was finished, or `""` before the first one. */
  lastWeeklyReview: string;
}

/**
 * The first day of the review week `today` belongs to: the latest review weekday on
 * or before it. A tree reviewed on or after that day counts as reviewed this week, so
 * a review started on Friday can be finished on Saturday.
 */
export function reviewWeekStart(today: string, reviewDay: number): string {
  const date = parseDateOnly(today);
  if (!date) return today;
  return addLocalDays(today, -((date.getDay() - reviewDay + 7) % 7));
}

/**
 * Whether this week's review is still to be done: it has not been finished since the
 * week began, and some active Project tree has not been reviewed in it. A Project
 * created after the review was finished waits for next week instead of reopening it.
 */
export function weeklyReviewDue(snapshot: GtdSnapshot, settings: WeeklyReviewSettings, today = localDate()): boolean {
  const since = reviewWeekStart(today, settings.weeklyReviewDay);
  if (settings.lastWeeklyReview && settings.lastWeeklyReview >= since) return false;
  return projectReviewQueue(snapshot, since).length > 0;
}

/**
 * Whether the week's review has just been finished and should be recorded: it is not
 * recorded yet, and no Project tree is left to review this week.
 */
export function weeklyReviewFinished(snapshot: GtdSnapshot, settings: WeeklyReviewSettings, today = localDate()): boolean {
  const since = reviewWeekStart(today, settings.weeklyReviewDay);
  if (settings.lastWeeklyReview && settings.lastWeeklyReview >= since) return false;
  return projectReviewQueue(snapshot, since).length === 0;
}
