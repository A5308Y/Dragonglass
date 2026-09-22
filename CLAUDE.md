# Dragonglass — notes for agents

## Styling: flat buttons need `!important` resets

Obsidian paints every `<button>` with a gray surface, border and shadow through
`button:not(.clickable-icon)`. That selector outranks a single-class rule like
`.dg-foo { background: transparent; }`, so the reset silently does nothing and
the button shows a gray background. This has been "fixed" on several views
already; don't reintroduce it.

Any button that should look like text or a link (titles, disclosures, collapse
toggles, inline links) must be reset like this:

```css
.dg-foo {
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}
.dg-foo:hover { background: var(--background-modifier-hover) !important; } /* only if it should highlight */
```

The shared hover rule near the end of `styles.css`
(`.dg-view button:not(:disabled):not(.is-active):hover`) also only yields to
`!important`. Buttons that are meant to look like buttons (for example
`mod-cta` or the plain toolbar buttons) keep Obsidian's surface and need no
reset.

## Building and deploying

- `npm run build` type-checks, compiles Elm, bundles `main.js` and deploys to
  the configured vaults.
- `npm run deploy:vaults` only copies the existing `main.js`, `manifest.json`
  and `styles.css`; it does not build.
- `npm test` runs the vitest suite.
