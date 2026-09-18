import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localConfigurationPath = join(projectRoot, ".dragonglass-vaults.json");
const artifacts = ["main.js", "manifest.json", "styles.css"];
const vaults = [{ name: "Test Vault", path: join(projectRoot, "Test Vault"), optional: true }];
const testVaultOnly = process.argv.includes("--test-vault-only");

if (!testVaultOnly) {
  try {
    const configuration = JSON.parse(await readFile(localConfigurationPath, "utf8"));
    if (!Array.isArray(configuration.vaults) || !configuration.vaults.every((path) => typeof path === "string" && path.trim())) {
      throw new Error("'vaults' must be an array of non-empty vault paths.");
    }
    for (const configuredPath of configuration.vaults) {
      const path = isAbsolute(configuredPath) ? configuredPath : resolve(projectRoot, configuredPath);
      vaults.push({ name: path, path, optional: false });
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw new Error(`Could not read .dragonglass-vaults.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const deployed = new Set();
for (const vault of vaults) {
  const vaultPath = resolve(vault.path);
  if (deployed.has(vaultPath)) continue;
  deployed.add(vaultPath);

  const vaultConfigDirectory = join(vaultPath, ".obsidian");
  try {
    await access(vaultConfigDirectory);
  } catch {
    if (vault.optional) {
      console.log(`${vault.name} not found; skipping local plugin deployment.`);
      continue;
    }
    throw new Error(`Configured Obsidian vault does not contain .obsidian: ${vaultPath}`);
  }

  const pluginDirectory = join(vaultConfigDirectory, "plugins", "dragonglass-gtd");
  await mkdir(pluginDirectory, { recursive: true });
  for (const artifact of artifacts) {
    await copyFile(join(projectRoot, artifact), join(pluginDirectory, artifact));
  }
  console.log(`Updated Dragonglass GTD in ${vault.name} (${artifacts.join(", ")}).`);
}
