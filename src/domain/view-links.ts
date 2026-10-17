/**
 * Links that open a Dragonglass view, such as `obsidian://dragonglass?view=inbox`, or
 * capture to the Inbox: `obsidian://dragonglass?capture` opens Quick Capture, and
 * `obsidian://dragonglass?capture=Call%20the%20dentist` files the text at once, so an
 * iOS Shortcut (Action Button, widget, Siri) can capture without opening anything first.
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
export function parseViewLink(url: string): { view: string; capture?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  // `obsidian://dragonglass?…` parses with the action as the host; allow a trailing slash too.
  const action = (parsed.host || parsed.pathname.replace(/^\/+/, "")).replace(/\/+$/, "").toLowerCase();
  if (parsed.protocol !== "obsidian:" || action !== VIEW_LINK_ACTION) return null;
  const capture = parsed.searchParams.get("capture");
  return { view: parsed.searchParams.get("view") ?? "", ...(capture === null ? {} : { capture }) };
}

/** What a capture link asks for: the Quick Capture dialog, or an Item filed straight away. */
export type CaptureRequest = { kind: "dialog" } | { kind: "file"; title: string; details: string };

/** How long a captured title may be; longer text is kept whole in the Item's notes. */
export const CAPTURE_TITLE_LENGTH = 100;

/**
 * Reads a link's `capture` value: none (`undefined`) is no capture; an empty one opens
 * the dialog (Obsidian hands a bare `?capture` over as `""` or `"true"`); any other text
 * is filed. Its first line is the title, cut at a word when long, with the whole text
 * kept below whenever the title doesn't hold all of it.
 */
export function captureRequest(value: string | undefined): CaptureRequest | null {
  if (value === undefined) return null;
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text || text === "true") return { kind: "dialog" };
  const [firstLine = ""] = text.split("\n");
  const line = firstLine.replace(/\s+/g, " ").trim();
  if (line.length <= CAPTURE_TITLE_LENGTH) {
    return { kind: "file", title: line, details: text.slice(firstLine.length).trim() };
  }
  const cut = line.slice(0, CAPTURE_TITLE_LENGTH - 1);
  const atWord = cut.lastIndexOf(" ") > CAPTURE_TITLE_LENGTH / 2 ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
  return { kind: "file", title: `${atWord.trimEnd()}…`, details: text };
}

export function viewLink(name: ViewLinkName): string {
  return `obsidian://${VIEW_LINK_ACTION}?view=${name}`;
}
