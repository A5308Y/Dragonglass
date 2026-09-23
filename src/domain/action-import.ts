/** One Action parsed out of a pasted checklist line. */
export interface ImportedAction {
  title: string;
  contexts: string[];
  done: boolean;
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CHECKBOX = /^\[([ xX])\]\s*/;
// A tag starts a word, so the '#' in a URL fragment is left alone.
const TAG = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_\-/]*)/gu;

/**
 * Parses a pasted markdown checklist into Actions.
 *
 * Every `#tag` is read as a context. Lines without a list marker are accepted
 * too; blank lines and lines that hold nothing but tags are skipped.
 */
export function parseActionList(text: string): ImportedAction[] {
  const actions: ImportedAction[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const withoutMarker = rawLine.replace(LIST_MARKER, "").trim();
    if (!withoutMarker) continue;
    const checkbox = CHECKBOX.exec(withoutMarker);
    const body = checkbox ? withoutMarker.slice(checkbox[0].length) : withoutMarker;

    const contexts: string[] = [];
    const title = body.replace(TAG, (_match, lead: string, tag: string) => {
      contexts.push(tag);
      return lead ? " " : "";
    }).replace(/\s+/g, " ").trim();
    if (!title) continue;

    actions.push({ title, contexts, done: checkbox?.[1]?.toLocaleLowerCase() === "x" });
  }
  return actions;
}
