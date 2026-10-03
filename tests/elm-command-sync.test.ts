import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACE_COMMANDS } from "../src/adapter/protocol";

/**
 * The Elm encoders and the TypeScript allow-lists are written by hand on both
 * sides of the port. These tests read the Elm sources so the two cannot drift:
 * every command a surface module can build must be one its host accepts, and
 * every command a host accepts must be one the surface can actually send.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const baseSource = read("src/elm/Gtd/Command.elm");

/**
 * Maps each `Gtd.Command` constructor to the wire name its encoder writes: the
 * first string literal after its case branch, whether passed to `object` or to a
 * helper such as `reviewCommand`.
 */
function wireNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of baseSource.matchAll(/^ {8}([A-Z]\w*)\b[^\n]*->\n\s+[a-z]\w* "([a-z-]+)"/gm)) {
    names.set(match[1]!, match[2]!);
  }
  return names;
}

/** Every constructor of `Gtd.Command.Command`. */
function constructors(): string[] {
  const body = /^type Command\n([\s\S]*?)\n\n/m.exec(baseSource)?.[1] ?? "";
  return [...body.matchAll(/^ {4}[=|] ([A-Z]\w*)/gm)].map((match) => match[1]!);
}

/** The wire names a surface's `Gtd.Command.*` module can produce, through the `Base.` constructors it uses. */
function surfaceWireNames(module: string, names: Map<string, string>): string[] {
  const used = new Set<string>();
  for (const match of read(`src/elm/Gtd/Command/${module}.elm`).matchAll(/\bBase\.([A-Z]\w*)/g)) {
    const name = names.get(match[1]!);
    if (name) used.add(name);
  }
  return [...used].sort();
}

const SURFACES = {
  actionBoard: "ActionBoard",
  projects: "Projects",
  inbox: "Inbox",
  feeds: "Feeds",
  projectReview: "ProjectReview",
  brainstorm: "Brainstorm",
  modals: "Modals",
  somedayReview: "SomedayReview",
  pomodoro: "Pomodoro",
  checklists: "Checklists",
  planProject: "PlanProject",
} as const satisfies Record<keyof typeof SURFACE_COMMANDS, string>;

describe("Elm and TypeScript command lists", () => {
  const names = wireNames();

  it("reads a wire name for every constructor of Gtd.Command", () => {
    // A pattern that silently stopped matching would make the checks below vacuous.
    const all = constructors();
    expect(all.length).toBeGreaterThan(60);
    expect(all.filter((constructor) => !names.has(constructor))).toEqual([]);
    expect(names.get("SetProjectStatus")).toBe("set-project-status");
  });

  for (const [surface, module] of Object.entries(SURFACES) as [keyof typeof SURFACES, string][]) {
    it(`agree for the ${module} surface`, () => {
      expect(surfaceWireNames(module, names)).toEqual([...SURFACE_COMMANDS[surface]].sort());
    });
  }
});
