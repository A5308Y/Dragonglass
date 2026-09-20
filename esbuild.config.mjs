import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";
import { watch } from "node:fs";
import { buildElm } from "./scripts/build-elm.mjs";

const production = process.argv[2] === "production";
buildElm(production);
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@lezer/common", ...builtinModules],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  let timer;
  watch("src/elm", { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      buildElm(false);
      void context.rebuild();
    }, 80);
  });
}
