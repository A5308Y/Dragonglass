import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const entries = ["src/elm/ActionBoard.elm", "src/elm/Inbox.elm", "src/elm/Projects.elm", "src/elm/ProjectReview.elm", "src/elm/Brainstorm.elm"];

describe("compiled Elm entry points", () => {
  it("use globally unique port names", () => {
    const owners = new Map<string, string>();
    for (const path of entries) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/^port\s+([a-z][A-Za-z0-9_]*)\s*:/gm)) {
        const name = match[1]!;
        expect(owners.get(name), `port '${name}' is also declared by ${owners.get(name)}`).toBeUndefined();
        owners.set(name, path);
      }
    }
    expect([...owners.keys()].sort()).toEqual(["brainstormFromHost", "brainstormToHost", "fromHost", "inboxFromHost", "inboxToHost", "projectsFromHost", "projectsToHost", "reviewFromHost", "reviewToHost", "toHost"]);
  });
});
