import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

export function buildElm(production = false) {
  mkdirSync(".generated", { recursive: true });
  const env = { ...process.env, ELM_HOME: resolve(".elm-home") };
  const version = spawnSync("elm", ["--version"], { encoding: "utf8", env });
  if (version.status !== 0 || version.stdout.trim() !== "0.19.2") {
    throw new Error("Dragonglass requires elm 0.19.2 on PATH.");
  }
  const args = ["make", "src/elm/ActionBoard.elm", "--output=.generated/elm.js"];
  if (production) args.push("--optimize");
  const result = spawnSync("elm", args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);

  const compiled = readFileSync(".generated/elm.js", "utf8");
  writeFileSync(
    ".generated/elm-runtime.js",
    `const scope = {};\n(function () {\n${compiled}\n}).call(scope);\nexport const Elm = scope.Elm;\n`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  buildElm(process.argv.includes("--optimize"));
}
