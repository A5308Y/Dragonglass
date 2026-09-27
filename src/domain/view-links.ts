/**
 * Links that open a Dragonglass view, such as `obsidian://dragonglass?view=inbox`.
 *
 * Obsidian hands `obsidian://dragonglass` links to the plugin, so they work in any note
 * and from outside Obsidian; the views' own Markdown recognises them too, so a checklist
 * item can say "[Process the Inbox](obsidian://dragonglass?view=inbox)".
 */

export const VIEW_LINK_ACTION = "dragonglass";

export const VIEW_LINK_NAMES = [
  "inbox",
  "board",
  "projects",
  "review",
  "someday",
  "brainstorm",
  "pomodoro",
  "feeds",
  "checklists",
] as const;

export type ViewLinkName = (typeof VIEW_LINK_NAMES)[number];

export function isViewLinkName(value: unknown): value is ViewLinkName {
  return typeof value === "string" && (VIEW_LINK_NAMES as readonly string[]).includes(value);
}

/** The view a link's `view` parameter names, however it is capitalised, or `null`. */
export function viewLinkName(value: unknown): ViewLinkName | null {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isViewLinkName(name) ? name : null;
}

/**
 * Whether a URL is a Dragonglass link, and the `view` it asks for (`""` when it names
 * none). Other `obsidian://` links and web links give `null`.
 */
export function parseViewLink(url: string): { view: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  // `obsidian://dragonglass?…` parses with the action as the host; allow a trailing slash too.
  const action = (parsed.host || parsed.pathname.replace(/^\/+/, "")).replace(/\/+$/, "").toLowerCase();
  if (parsed.protocol !== "obsidian:" || action !== VIEW_LINK_ACTION) return null;
  return { view: parsed.searchParams.get("view") ?? "" };
}

export function viewLink(name: ViewLinkName): string {
  return `obsidian://${VIEW_LINK_ACTION}?view=${name}`;
}
