/**
 * The runtime half of the `obsidian` package, for tests.
 *
 * The real package ships types and no runtime entry, because the API is supplied by
 * the app at load time. That makes anything above the pure domain — the services —
 * unloadable under Vitest without a stand-in. This is that stand-in, aliased in
 * `vitest.config.ts`, and it holds only what a test actually calls.
 *
 * Anything a test has no business reaching for throws rather than pretending: a
 * silent no-op here would look like a passing test of behaviour that never ran.
 */

/** Obsidian's own path tidying: forward slashes, no doubles, no leading or trailing slash. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0)
    .join("/");
}

export class Notice {
  constructor(public readonly message: string | DocumentFragment) {}

  hide(): void {
    // Nothing is displayed in a test, so there is nothing to hide.
  }
}

export function requestUrl(): never {
  throw new Error("A test reached the network through requestUrl. Inject a fake request instead.");
}

export const Platform = { isDesktopApp: true, isMobile: false };
