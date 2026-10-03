/**
 * Planning a Project (David Allen's Natural Planning Model): its purpose, desired outcome and ideas
 * come from a Brainstorm session on the Project; organising them happens on the Project page.
 *
 * The ideas still to organise live in an ordinary note in the Project's support folder, marked
 * `dragonglass: plan` in its frontmatter, as a task list: an open box is an idea not yet decided,
 * a ticked one has become an Action, a Sub-project or Someday, or was let go. So the state of a plan
 * is plain Markdown anyone can read or fix by hand.
 */

/** The frontmatter key and value that mark a plan note. */
export const PLAN_NOTE_KEY = "dragonglass";
export const PLAN_NOTE_VALUE = "plan";

/** Ideas typed one per line, as a list of ideas; bullets, numbering and task boxes are taken off. */
export function ideasFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, "").trim())
    .filter(Boolean);
}

/** The body of a new plan note: a heading, the date and every idea as an open box. */
export function planNoteBody(title: string, date: string, ideas: readonly string[]): string {
  return [`# ${title}`, "", `*${date}*`, "", "## Ideas", "", ...ideas.map((idea) => `- [ ] ${idea}`), ""].join("\n");
}

/** The ideas of a plan note still to organise: its open boxes, in order. */
export function openPlanIdeas(content: string): string[] {
  return [...content.matchAll(/^[ \t]*[-*+] \[ \][ \t]+(.+?)[ \t]*$/gm)].map((match) => match[1]!);
}

/** Ticks the first open box carrying exactly this idea; the note is returned unchanged when there is none. */
export function tickPlanIdea(content: string, idea: string): string {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => {
    const match = /^([ \t]*[-*+]) \[ \][ \t]+(.+?)[ \t]*\r?$/.exec(line);
    return match?.[2] === idea;
  });
  if (index < 0) return content;
  lines[index] = lines[index]!.replace("[ ]", "[x]");
  return lines.join("\n");
}
