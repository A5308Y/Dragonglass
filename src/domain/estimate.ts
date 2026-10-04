/**
 * How long an Action is expected to take, in rough steps rather than exact minutes, so the
 * board can filter by it ("what fits into 15 minutes?"). Optional, like energy, and dropped by
 * Waiting Actions, which are someone else's to do.
 */

import { ESTIMATE_MINUTES, type Estimate } from "./types";

export function isEstimate(value: unknown): value is Estimate {
  return typeof value === "number" && (ESTIMATE_MINUTES as readonly number[]).includes(value);
}

/**
 * A number of minutes as the next step up, so a hand-written `45` reads as 60; anything over
 * the last step is that step.
 */
export function estimateStep(minutes: number): Estimate {
  return ESTIMATE_MINUTES.find((step) => minutes <= step) ?? ESTIMATE_MINUTES[ESTIMATE_MINUTES.length - 1]!;
}

export function estimateLabel(estimate: Estimate): string {
  return estimate < 60 ? `${estimate} min` : `${estimate / 60} h`;
}
