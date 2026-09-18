import { access, copyFile, mkdir } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const vaultConfigDirectory = new URL("Test Vault/.obsidian/", projectRoot);
const pluginDirectory = new URL("plugins/dragonglass-gtd/", vaultConfigDirectory);
const artifacts = ["main.js", "manifest.json", "styles.css"];

try {
  await access(vaultConfigDirectory);
} catch {
  console.log("Test Vault not found; skipping local plugin deployment.");
  process.exit(0);
}

await mkdir(pluginDirectory, { recursive: true });
await Promise.all(
  artifacts.map((artifact) =>
    copyFile(new URL(artifact, projectRoot), new URL(artifact, pluginDirectory)),
  ),
);

console.log(`Updated Dragonglass GTD in Test Vault (${artifacts.join(", ")}).`);
