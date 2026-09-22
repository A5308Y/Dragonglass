# Dragonglass — notes for agents

## Styling: flat buttons use `.dg-flat-button`

Obsidian paints every `<button>` with a gray surface, border and shadow through
`button:not(.clickable-icon)`. That selector outranks a single-class rule like
`.dg-foo { background: transparent; }`, so the reset silently does nothing and
the button shows a gray background. This bug was fixed on several views, one at a
time, before the reset was centralised; don't reintroduce it.

Any button that should look like text, a link or an icon (titles, disclosures,
collapse toggles, row actions, picker options) gets the shared class in Elm:

```elm
button [ class "dg-foo dg-flat-button", onClick ... ] [ ... ]
```

- Don't repeat `background`/`border`/`box-shadow` resets in the component rule;
  `.dg-flat-button` carries them with the `!important` they need.
- A hover or selected background on a flat button must use `!important` *and* a
  more specific selector than the class, e.g.
  `.dg-foo:hover { background: var(--background-modifier-hover) !important; }`.
- Buttons meant to look like buttons (`mod-cta`, toolbar buttons, the decision
  buttons in reviews) keep Obsidian's surface and don't get the class.

## Building and deploying

- `npm run build` type-checks, compiles Elm, bundles `main.js` and deploys to
  the configured vaults.
- `npm run deploy:vaults` only copies the existing `main.js`, `manifest.json`
  and `styles.css`; it does not build.
- `npm test` runs the vitest suite.
