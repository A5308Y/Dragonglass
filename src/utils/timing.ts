/**
 * An optional timing log in Obsidian's developer console (setting "Log timings"), to
 * see where a slow click spends its time: the command itself, the index update that
 * follows the write, each view taking in the new data, and the views drawing it.
 * Off, it costs one boolean check per measured step.
 */

let enabled = false;

export function setTimingLog(on: boolean): void {
  enabled = on;
}

export function timingLog(): boolean {
  return enabled;
}

export function logTiming(what: string, milliseconds: number, detail = ""): void {
  if (!enabled) return;
  console.log(`[Dragonglass] ${what}: ${Math.round(milliseconds)} ms${detail ? ` · ${detail}` : ""}`);
}

/** Runs `work` and logs how long it took, including an awaited result. */
export async function timed<T>(what: string, work: () => Promise<T>): Promise<T> {
  if (!enabled) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    logTiming(what, performance.now() - start);
  }
}
