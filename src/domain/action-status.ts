import type { ActionStatus } from "./types";
import { localDate } from "../utils/date";

/**
 * Resolves the `waiting_since` date an Action should carry for a status.
 *
 * A Waiting Action always has one: an explicitly supplied date wins, then the date it is
 * already waiting since, and failing both it starts waiting today. Every other status has
 * none, so a date never outlives the wait it recorded.
 */
export function waitingSinceFor(
  status: ActionStatus,
  current?: string,
  requested?: string,
  today = localDate(),
): string | null {
  if (status !== "waiting") return null;
  return requested?.trim() || current?.trim() || today;
}
