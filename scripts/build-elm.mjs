import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

export function buildElm(production = false) {
  const entryPoints = ["src/elm/ActionBoard.elm", "src/elm/Inbox.elm", "src/elm/Projects.elm", "src/elm/ProjectReview.elm", "src/elm/SomedayReview.elm", "src/elm/Brainstorm.elm", "src/elm/Modals.elm", "src/elm/Feeds.elm"];
  assertUniquePorts(entryPoints);
  mkdirSync(".generated", { recursive: true });
  const env = { ...process.env, ELM_HOME: resolve(".elm-home") };
  const version = spawnSync("elm", ["--version"], { encoding: "utf8", env });
  if (version.status !== 0 || version.stdout.trim() !== "0.19.2") {
    throw new Error("Dragonglass requires elm 0.19.2 on PATH.");
  }
  const args = ["make", ...entryPoints, "--output=.generated/elm.js"];
  if (production) args.push("--optimize");
  const result = spawnSync("elm", args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);

  const compiled = readFileSync(".generated/elm.js", "utf8");
  writeFileSync(
    ".generated/elm-runtime.js",
    `const scope = {};\n(function () {\n${compiled}\n}).call(scope);\nexport const Elm = scope.Elm;\n`,
  );
}

function assertUniquePorts(entryPoints) {
  const owners = new Map();
  for (const path of entryPoints) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/^port\s+([a-z][A-Za-z0-9_]*)\s*:/gm)) {
      const name = match[1];
      const previous = owners.get(name);
      if (previous) throw new Error(`Elm port '${name}' is declared by both ${previous} and ${path}. Port names must be unique across compiled entry points.`);
      owners.set(name, path);
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  buildElm(process.argv.includes("--optimize"));
}
