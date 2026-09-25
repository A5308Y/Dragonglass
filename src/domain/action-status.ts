import type { ActionStatus } from "./types";
import { localDate } from "../utils/date";

/**
 * Only an Action still to be executed needs an execution context: Waiting records a
 * dependency on someone or something else, and Done or Cancelled Actions are finished.
 */
export function actionRequiresContext(status: ActionStatus): boolean {
  return status === "next" || status === "scheduled";
}

/**
 * Resolves the `waiting_since` date an Action should carry for a status.
 *
 * A Waiting Action always has one: an explicitly supplied date wins, then the date it is
 * already waiting since, and failing both it starts waiting today. Every other status has
 * none, so a date never outlives the wait it recorded.
 */
/**
 * Whether an Action with this status keeps a context and an energy level. A Waiting
 * Action is someone else's to move, so where and with how much energy you would do
 * it does not apply; its values are cleared when it starts waiting.
 */
export function actionKeepsContext(status: ActionStatus): boolean {
  return status !== "waiting";
}

/**
 * Resolves the `follow_up` date an Action should carry for a status.
 *
 * Only a Waiting Action has one, and only when asked for: an explicitly supplied value
 * wins (empty clears it), otherwise it keeps the date it already has. Leaving Waiting
 * clears it, like `waiting_since`.
 */
export function followUpFor(status: ActionStatus, current?: string, requested?: string): string | null {
  if (status !== "waiting") return null;
  return (requested === undefined ? current : requested)?.trim() || null;
}

export function waitingSinceFor(
  status: ActionStatus,
  current?: string,
  requested?: string,
  today = localDate(),
): string | null {
  if (status !== "waiting") return null;
  return requested?.trim() || current?.trim() || today;
}
