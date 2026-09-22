import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    dir: "./tests",
  },
  resolve: {
    alias: {
      // The real package is types-only, so a service that imports it cannot load
      // under Vitest. The stub supplies the handful of runtime helpers tests reach.
      obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url)),
    },
  },
});
