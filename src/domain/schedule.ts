/** Minutes before a Scheduled Action with a time of day that its calendar alarm fires. */
export const SCHEDULE_REMINDER_MINUTES = 60;

/** The hour on the preceding day at which an all-day Action's alarm fires. */
export const ALL_DAY_REMINDER_HOUR = 9;

/** Google counts an all-day alarm back from midnight on the start date, not from 24 hours earlier. */
export const ALL_DAY_REMINDER_MINUTES = (24 - ALL_DAY_REMINDER_HOUR) * 60;

export type ActionSchedule =
  | { kind: "all-day"; date: string }
  | { kind: "timed"; start: string; durationMinutes: number };

/** A `scheduled_start` written as a plain date means the Action has no time of day. */
export function isAllDaySchedule(scheduledStart: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(scheduledStart);
}

/**
 * Resolves the schedule an Action carries, or undefined when its schedule is incomplete.
 * An all-day Action needs only its date; a timed one also needs a positive duration.
 */
export function actionSchedule(scheduledStart?: string, durationMinutes?: number): ActionSchedule | undefined {
  if (!scheduledStart) return undefined;
  if (isAllDaySchedule(scheduledStart)) return { kind: "all-day", date: scheduledStart };
  if (Number.isNaN(Date.parse(scheduledStart))) return undefined;
  if (durationMinutes === undefined || !Number.isInteger(durationMinutes) || durationMinutes <= 0) return undefined;
  return { kind: "timed", start: scheduledStart, durationMinutes };
}

/** Minutes before its start that a schedule's calendar alarm fires. */
export function scheduleReminderMinutes(schedule: ActionSchedule): number {
  return schedule.kind === "all-day" ? ALL_DAY_REMINDER_MINUTES : SCHEDULE_REMINDER_MINUTES;
}
