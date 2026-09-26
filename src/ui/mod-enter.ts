import { Scope, type ItemView } from "obsidian";

/** What Elm listens to for ⌘/Ctrl+Enter; see `Ui.onModEnter`. */
export const MOD_ENTER_EVENT = "dg-mod-enter";

/**
 * Delivers ⌘/Ctrl+Enter inside a view to the field that has focus.
 *
 * Obsidian binds Mod+Enter globally ("Open link under cursor in new tab") and its
 * keymap takes the key press before it reaches the page, so a field listening for
 * keydown never sees ⌘+Enter on a Mac. The view's own scope claims the chord
 * first. Ctrl+Enter on a Mac is not Mod and arrives as an ordinary key press, so a
 * listener on the view covers it; a press the scope already took is marked handled
 * and skipped there, so no chord is delivered twice.
 */
export function routeModEnter(view: ItemView): void {
  const scope = new Scope(view.app.scope);
  scope.register(["Mod"], "Enter", (evt) => {
    if (!(evt.target instanceof HTMLElement) || !view.contentEl.contains(evt.target)) return;
    evt.target.dispatchEvent(new CustomEvent(MOD_ENTER_EVENT, { bubbles: true }));
    return false;
  });
  view.scope = scope;
  view.registerDomEvent(view.contentEl, "keydown", (evt) => {
    if (evt.key !== "Enter" || !(evt.ctrlKey || evt.metaKey) || evt.defaultPrevented) return;
    evt.preventDefault();
    evt.target?.dispatchEvent(new CustomEvent(MOD_ENTER_EVENT, { bubbles: true }));
  });
}
