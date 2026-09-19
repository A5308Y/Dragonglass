const INVALID_FILENAME = /[\\/:*?"<>|\[\]#^]/g;

export function normalizeVaultPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

export function safeName(title: string, fallback = "Untitled"): string {
  const result = title
    .replace(INVALID_FILENAME, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return result || fallback;
}

/** The folder names this plugin generates for a Project, in the order it tries them. */
export function generatedFolderNames(title: string, id: string): [string, string] {
  const clean = safeName(title);
  return [clean, `${clean} - ${id.slice(-4)}`];
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

export function isPathInDirectory(path: string, directory: string): boolean {
  const normalizedPath = normalizeVaultPath(path).toLocaleLowerCase();
  const normalizedDirectory = normalizeVaultPath(directory).toLocaleLowerCase();
  return Boolean(normalizedDirectory && normalizedPath.startsWith(`${normalizedDirectory}/`));
}

export function rawInboxId(path: string): string {
  let hash = 2_166_136_261;
  for (const character of normalizeVaultPath(path)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `RAW-${(hash >>> 0).toString(36).toUpperCase().padStart(7, "0")}`;
}
