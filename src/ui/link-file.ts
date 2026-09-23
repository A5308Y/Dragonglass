import { FuzzySuggestModal, type App, type FuzzyMatch, type TFile } from "obsidian";

/** Fuzzy-searches the vault for a file to link to a Project. */
export class LinkFileModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly files: readonly TFile[], private readonly choose: (file: TFile) => void) {
    super(app);
    this.limit = 50;
    this.setPlaceholder("Search files to link…");
  }

  getItems(): TFile[] {
    return [...this.files];
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    const file = match.item;
    el.createDiv({ text: file.extension === "md" ? file.basename : file.name });
    el.createDiv({ cls: "dg-project-suggestion-meta", text: file.parent?.path && file.parent.path !== "/" ? file.parent.path : "Vault root" });
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}
