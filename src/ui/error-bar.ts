import { ItemView, Notice, type App } from "obsidian";
import { describeErrors, errorDetails, isOwnError, recordError, type ErrorReport } from "../domain/error-report";

/** At most this often the bars are redrawn, as a failing redraw can throw every frame. */
const RENDER_DELAY_MS = 500;

/**
 * Shows uncaught errors from Dragonglass's code in a bar above every open Dragonglass
 * view, with a notice the first time each one happens, instead of only in the console.
 *
 * The bar sits in the view's container before `contentEl`, never inside it: Elm owns
 * `contentEl`, and a node added there breaks its next redraw.
 */
export class ErrorBar {
  private reports: ErrorReport[] = [];
  private noticed = new Set<string>();
  private renderTimer: number | null = null;

  constructor(
    private readonly app: App,
    private readonly pluginId: string,
    private readonly viewTypes: readonly string[],
  ) {}

  /** For `window`'s `error` event. */
  onError = (event: ErrorEvent): void => {
    const error = event.error as unknown;
    this.report(error instanceof Error ? error.message : event.message, error instanceof Error ? error.stack ?? "" : "", event.filename ?? "");
  };

  /** For `window`'s `unhandledrejection` event. */
  onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason as unknown;
    if (reason instanceof Error) this.report(reason.message, reason.stack ?? "", "");
  };

  /** Shows the bar in views opened after the error, too. */
  onLayoutChange = (): void => {
    if (this.reports.length) this.scheduleRender();
  };

  stop(): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.reports = [];
    this.render();
  }

  private report(message: string, stack: string, filename: string): void {
    try {
      if (!isOwnError(this.pluginId, filename, stack)) return;
      this.reports = recordError(this.reports, message || "Unknown error", stack, new Date().toISOString());
      const [latest] = this.reports;
      if (latest && !this.noticed.has(latest.signature)) {
        this.noticed.add(latest.signature);
        new Notice(`⚠ Dragonglass hit an unexpected error: ${latest.message}`, 10_000);
      }
      this.scheduleRender();
    } catch {
      // Reporting must never become a second error.
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, RENDER_DELAY_MS);
  }

  private render(): void {
    const text = describeErrors(this.reports);
    for (const type of this.viewTypes) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        if (!(view instanceof ItemView)) continue;
        const existing = view.containerEl.querySelector<HTMLElement>(":scope > .dg-error-bar");
        if (!text) {
          existing?.remove();
          continue;
        }
        const bar = existing ?? this.createBar(view);
        bar.querySelector(".dg-error-bar-text")?.setText(text);
      }
    }
  }

  private createBar(view: ItemView): HTMLElement {
    const bar = createDiv({ cls: "dg-error-bar dg-button-scope", attr: { role: "alert" } });
    bar.createSpan({ cls: "dg-error-bar-icon", text: "⚠" });
    bar.createSpan({ cls: "dg-error-bar-text" });
    const actions = bar.createDiv({ cls: "dg-error-bar-actions" });
    actions.createEl("button", { text: "Copy details" }).addEventListener("click", () => {
      void navigator.clipboard.writeText(errorDetails(this.reports)).then(
        () => new Notice("Copied the error details."),
        () => new Notice("Could not copy the error details."),
      );
    });
    actions.createEl("button", { text: "Dismiss" }).addEventListener("click", () => {
      // New errors show the bar again, and a new kind of error its notice.
      this.reports = [];
      this.render();
    });
    view.containerEl.insertBefore(bar, view.contentEl);
    return bar;
  }
}
