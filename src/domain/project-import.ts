/** One sub-project parsed from a pasted markdown list. */
export interface ImportedSubproject {
  title: string;
  tags: string[];
  done: boolean;
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CHECKBOX = /^\[([ xX])\]\s*/;
// A tag starts a word, so URL fragments such as `docs#setup` remain intact.
const TAG = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_\-/]*)/gu;

/**
 * Parses plain lines or a Markdown checklist into immediate sub-projects.
 * Checked items become completed Projects and hashtags become Project tags.
 */
export function parseSubprojectList(text: string): ImportedSubproject[] {
  const projects: ImportedSubproject[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const withoutMarker = rawLine.replace(LIST_MARKER, "").trim();
    if (!withoutMarker) continue;
    const checkbox = CHECKBOX.exec(withoutMarker);
    const body = checkbox ? withoutMarker.slice(checkbox[0].length) : withoutMarker;
    const tags: string[] = [];
    const title = body.replace(TAG, (_match, lead: string, tag: string) => {
      tags.push(tag);
      return lead ? " " : "";
    }).replace(/\s+/g, " ").trim();
    if (!title) continue;
    projects.push({ title, tags, done: checkbox?.[1]?.toLocaleLowerCase() === "x" });
  }
  return projects;
}
