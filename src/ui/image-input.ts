import { AbstractInputSuggest, App, prepareFuzzySearch, Setting, type TFile } from "obsidian";

export const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

export function isVaultImage(file: TFile): boolean {
  return IMAGE_EXTENSIONS.has(file.extension.toLocaleLowerCase());
}

export function resolveVaultImage(app: App, path: string, sourcePath: string): TFile | null {
  const reference = path.trim();
  const file = reference
    ? app.vault.getFileByPath(reference) ?? app.metadataCache.getFirstLinkpathDest(reference, sourcePath)
    : null;
  return file && isVaultImage(file) ? file : null;
}

export function addImagePathSetting(
  container: HTMLElement,
  app: App,
  value: string,
  onChange: (value: string) => void,
  registerSuggest?: (suggest: { close(): void }) => void,
  options: { name?: string; description?: string } = {},
): void {
  const files = app.vault.getFiles().filter(isVaultImage).sort((left, right) => left.path.localeCompare(right.path));
  new Setting(container)
    .setName(options.name ?? "Main image")
    .setDesc(options.description ?? "Optional. Select an image from the vault.")
    .addText((text) => {
      text.setValue(value).setPlaceholder("Images/project.jpg").onChange(onChange);
      const suggest = new ImageInputSuggest(app, text.inputEl, files, onChange);
      registerSuggest?.(suggest);
    });
}

class ImageInputSuggest extends AbstractInputSuggest<TFile> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly files: readonly TFile[],
    private readonly choose: (path: string) => void,
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  protected getSuggestions(query: string): TFile[] {
    const trimmed = query.trim();
    if (!trimmed) return this.files.slice(0, this.limit);
    const matches = prepareFuzzySearch(trimmed);
    return this.files.filter((file) => matches(file.path) !== null).slice(0, this.limit);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.setValue(file.path);
    this.choose(file.path);
    this.close();
  }
}
