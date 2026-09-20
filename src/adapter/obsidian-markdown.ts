import { Component, Keymap, MarkdownRenderer, type App } from "obsidian";

let currentApp: App | null = null;

/** Registers the small DOM boundary Elm uses for Obsidian-native Markdown rendering. */
export function registerObsidianMarkdown(app: App): void {
  currentApp = app;
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
        if (anchor.hasClass("internal-link")) {
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
