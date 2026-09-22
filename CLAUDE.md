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

## Accessibility conventions

- Every form control needs a name. In `Modals.elm` the control helpers
  (`textInput`, `dateInput`, `toggle`, `statusSelect`) take the row name as their
  first argument and set `aria-label`; elsewhere use `label [ for id ]`.
- Icon-only buttons ("•••", "×", "▸") need an `aria-label`.
- Focus rings use `outline` (see the end of `styles.css`). `.dg-flat-button`
  removes the box-shadow Obsidian uses for its own ring, so a flat button without
  the shared `:focus-visible` outline has no focus indicator at all.
- A focusable row or card with single-key shortcuts must ignore keys whose
  target is one of its buttons (check `target.id`, as `onRowKey` / `onCardKey`
  do), or Enter on a child button also fires the row's shortcut.
- Don't signal state by colour alone (e.g. overdue dates carry "⚠" and a title).
- Use Obsidian's font-size variables; the smallest is `--font-ui-smaller`.

## Destructive actions: Undo first, dialogs for the rest

- A reversible single change (deleting one Inbox Item or Action, cancelling a
  Project) happens immediately and offers Undo: `showUndoNotice` /
  `trashWithUndo` in `src/ui/undo.ts`. Elm-only state (e.g. Brainstorm text) keeps
  its own set-aside copy with an Undo bar.
- Anything irreversible or touching many files (deleting Projects, settings that
  forget data) asks first with `confirmDialog` from `src/ui/confirm.ts`.
- Don't use `window.confirm`.

## Building and deploying

- `npm run build` type-checks, compiles Elm, bundles `main.js` and deploys to
  the configured vaults.
- `npm run deploy:vaults` only copies the existing `main.js`, `manifest.json`
  and `styles.css`; it does not build.
- `npm test` runs the vitest suite.
