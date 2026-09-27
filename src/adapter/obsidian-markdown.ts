import { Component, Keymap, MarkdownRenderer, type App } from "obsidian";
import { parseViewLink } from "../domain/view-links";

let currentApp: App | null = null;
let currentOpenView: ((view: string) => void) | null = null;

/**
 * Registers the small DOM boundary Elm uses for Obsidian-native Markdown rendering.
 * The plugin does this once on load, so every view can render Markdown whichever opens
 * first. `openView` opens the view a Dragonglass link names (see `src/domain/view-links.ts`).
 */
export function registerObsidianMarkdown(app: App, openView: (view: string) => void): void {
  currentApp = app;
  currentOpenView = openView;
  if (customElements.get("dg-markdown")) return;

  customElements.define("dg-markdown", class extends HTMLElement {
    static get observedAttributes(): string[] { return ["data-markdown", "data-source-path"]; }

    private component: Component | null = null;
    private renderVersion = 0;

    connectedCallback(): void { this.renderMarkdown(); }
    disconnectedCallback(): void { this.unload(); }
    attributeChangedCallback(): void { if (this.isConnected) this.renderMarkdown(); }

    private renderMarkdown(): void {
      const app = currentApp;
      if (!app) return;
      const version = ++this.renderVersion;
      this.unload();
      this.replaceChildren();
      const component = new Component();
      component.load();
      this.component = component;
      const sourcePath = this.getAttribute("data-source-path") ?? "";
      component.registerDomEvent(this, "click", (event) => {
        const target = event.target as Element | null;
        const anchor = target?.closest("a") as HTMLAnchorElement | null;
        if (!anchor || !this.contains(anchor)) return;
        const viewLink = parseViewLink(anchor.getAttr("href") ?? "");
        if (viewLink && currentOpenView) {
          event.preventDefault();
          currentOpenView(viewLink.view);
        } else if (anchor.hasClass("internal-link")) {
          const linktext = anchor.dataset.href ?? anchor.getAttr("href");
          if (!linktext) return;
          event.preventDefault();
          void app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(event));
        } else if (anchor.hasClass("external-link")) {
          const href = anchor.getAttr("href");
          if (!href) return;
          event.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      });
      void MarkdownRenderer.render(app, this.getAttribute("data-markdown") ?? "", this, sourcePath, component)
        .catch(() => {
          if (version === this.renderVersion) this.setText("Could not render this Markdown.");
        });
    }

    private unload(): void {
      this.component?.unload();
      this.component = null;
    }
  });
}
