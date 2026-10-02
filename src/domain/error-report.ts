/**
 * Uncaught errors from Dragonglass's own code, grouped for the error bar above its views.
 *
 * Such errors used to show only in the developer console. A failed Elm redraw retries
 * on every animation frame, so one fault can repeat sixty times a second: repeats are
 * counted on one report rather than listed.
 */

/** How many different errors are kept; older ones drop off. */
export const ERROR_REPORT_LIMIT = 5;

export interface ErrorReport {
  /** The message and the frame it was thrown from, so repeats of one fault group together. */
  signature: string;
  message: string;
  stack: string;
  count: number;
  /** ISO times of the first and the latest occurrence. */
  first: string;
  last: string;
}

/**
 * Whether an error was thrown by this plugin's code.
 * Obsidian loads a plugin's `main.js` as `plugin:<id>`, so its frames carry that name.
 */
export function isOwnError(pluginId: string, filename: string, stack: string): boolean {
  const source = `plugin:${pluginId}`;
  return filename.startsWith(source) || stack.includes(`${source}:`);
}

export function errorSignature(message: string, stack: string): string {
  const frame = stack.split("\n").map((line) => line.trim()).find((line) => line.startsWith("at ")) ?? "";
  return `${message}\n${frame}`;
}

/** Adds an occurrence, first in the list: a repeat raises its report's count. */
export function recordError(reports: readonly ErrorReport[], message: string, stack: string, at: string): ErrorReport[] {
  const signature = errorSignature(message, stack);
  const existing = reports.find((report) => report.signature === signature);
  const next = existing
    ? { ...existing, count: existing.count + 1, last: at }
    : { signature, message, stack, count: 1, first: at, last: at };
  return [next, ...reports.filter((report) => report !== existing)].slice(0, ERROR_REPORT_LIMIT);
}

/** The bar's text: what went wrong, how often, and what usually helps. */
export function describeErrors(reports: readonly ErrorReport[]): string {
  const [latest] = reports;
  if (!latest) return "";
  const times = latest.count === 1 ? "" : ` (${latest.count} times)`;
  const others = reports.length > 1 ? ` and ${reports.length - 1} other error${reports.length === 2 ? "" : "s"}` : "";
  return `Dragonglass hit an unexpected error${times}${others}: ${latest.message}. `
    + "A view may have stopped updating. Closing and reopening it, or reloading Obsidian with ⌘R / Ctrl+R, usually helps.";
}

/** Everything known about the errors, for pasting into a bug report. */
export function errorDetails(reports: readonly ErrorReport[]): string {
  return reports
    .map((report) => [
      `${report.message} — ${report.count}×, first ${report.first}, last ${report.last}`,
      report.stack || "(no stack)",
    ].join("\n"))
    .join("\n\n");
}
