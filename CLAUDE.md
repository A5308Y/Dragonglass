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

## No tooltips; accessible names as hidden text

- Don't use `title` attributes or Obsidian's `setTooltip`: the user finds the
  hover tooltips annoying. Put needed information in visible text instead.
- Don't use `aria-label` either: Obsidian shows a black hover tooltip for every
  element that has one. Give accessible names with the helpers in `Gtd.Ui`:
  - icon-only buttons: `button [ ... ] (Ui.iconLabel "•••" "Actions for …")`
  - controls without a visible label: `Ui.labelled "Name" (input [ ... ] [])`
    (in `Modals.elm` the control helpers take the name and do this)
  - groups: `aria-labelledby` pointing at a `Ui.srOnly`-style hidden span with an id
  - otherwise a real `label [ for id ]`.
- Focus rings use `outline` (see the end of `styles.css`). `.dg-flat-button`
  removes the box-shadow Obsidian uses for its own ring, so a flat button without
  the shared `:focus-visible` outline has no focus indicator at all.
- A focusable row or card with single-key shortcuts must ignore keys whose
  target is one of its buttons (check `target.id`, as `onRowKey` / `onCardKey`
  do), or Enter on a child button also fires the row's shortcut.
- Don't signal state by colour alone (e.g. overdue dates carry "⚠").
- Use Obsidian's font-size variables; the smallest is `--font-ui-smaller`.
- `.dg-labelled` is `display: contents`, so a CSS rule written as
  `parent > input` must also allow `parent > .dg-labelled > input`.

## ⌘/Ctrl+Enter

Obsidian binds Mod+Enter globally, and its keymap takes ⌘+Enter before an Elm
keydown handler sees it, so a keydown-based chord only works with Ctrl on a Mac.
Use `Ui.onModEnter msg` (it listens for the `dg-mod-enter` event) and call
`routeModEnter(this)` from `src/ui/mod-enter.ts` in the view's constructor.

## Destructive actions: Undo first, dialogs for the rest

- A reversible single change (deleting one Inbox Item or Action, cancelling a
  Project) happens immediately and offers Undo: `showUndoNotice` /
  `trashWithUndo` in `src/ui/undo.ts`. Elm-only state (e.g. Brainstorm text) keeps
  its own set-aside copy with an Undo bar.
- Anything irreversible or touching many files (deleting Projects, settings that
  forget data) asks first with `confirmDialog` from `src/ui/confirm.ts`.
- Don't use `window.confirm`.

## Pomodoro and time tracking

- Session rules live in `src/domain/pomodoro.ts` (tested in
  `tests/pomodoro.test.ts`); `src/pomodoro/pomodoro-service.ts` owns the running
  session, the time-up notice and the status bar, so a session survives closing
  the view. `Pomodoro.elm` only renders and counts down from the times it is sent.
- The log is `GTD/pomodoros.json` (setting `pomodoro.storePath`).
- A time-tracking sync should: read finished sessions from the service's store,
  convert each with `toTimeEntry` (key = session id, stable across re-syncs),
  and record what it sent in `session.external[<integration>] = { id, syncedAt }`
  so a re-run updates rather than duplicates. `parsePomodoroStore` already keeps
  `external` links, and nothing else writes them.

## Building and deploying

- `npm run build` type-checks, compiles Elm, bundles `main.js` and deploys to
  the configured vaults.
- `npm run deploy:vaults` only copies the existing `main.js`, `manifest.json`
  and `styles.css`; it does not build.
- `npm test` runs the vitest suite.

## Project trees

- An Active Project's parent, and every Project above it, is Active too. The rule
  lives in `src/domain/project-tree.ts` and `GtdRepository.updateProject` /
  `createProjectRecord` enforce it: activating activates the Projects above,
  parking or cancelling a Project with Active sub-projects is refused, and
  completing is refused while any sub-project is Active or in the Backlog.
- Status changes from views go through `setProjectStatus` / `moveProject` in
  `src/ui/project-moves.ts`, which ask before reopening a finished parent
  (`reopenAncestors`) and offer one Undo for the cascade. Undo writes with
  `restoring`, which skips the rules to put the earlier state back exactly.
- Writes that nobody was asked about report instead: creating an Active
  sub-project calls `repository.onParentsActivated` (a notice from `main.ts`), and
  scheduled activation reopens finished parents and names them in its notice.
- Active Projects below an inactive one ("stranded") count as parked for the
  missing-Action rule and show up as index issues until fixed by hand.

## Agent delegation

- `agent/` holds the sandbox (compose file, runner, proxy); `agent/README.md` explains it.
  `src/agent/agent-service.ts` builds run folders outside the vault, starts runs
  detached with `docker compose run -d`, and reads everything back from the folders and
  `docker ps`, so runs survive Obsidian restarts. Scope, brief, status and costs are
  pure functions in `src/domain/delegation.ts` (tested in `tests/delegation.test.ts`).
- The scope is the Project, every Project below it, their Actions, their Project
  Material and each Project's `linked_files`, one hop. Widening it is a deliberate change.
  The Waiting Actions of earlier runs are left out: they are bookkeeping, and an agent
  took them for its task list.
- A local model (`agent/runner-local`, our own loop against LM Studio) may instead read
  the whole vault, but only offline: the proxy then passes nothing but the model route.
  The rule is "the more it sees, the less it can reach"; Claude runs never get the vault.
- Deleting a run removes its folder (after asking; it has no trash) but appends it to
  `deleted-runs.jsonl` in the runs folder, so its cost still counts and its Waiting
  Action stays out of later runs' material.
- Local runs are queued: only one holds the local model at a time (starting, working or
  waiting for an answer); the scan starts the oldest queued run once it is free. A queued
  run builds its environment and reads its keys only when it launches.
- Each run creates a Waiting Action in the delegated Project ("Agent: …"), renamed to
  "Agent asks: …" with a follow-up of today while a question is open, and done when the
  run ends. Its id lives in the run's `host.json`; once someone changes it by hand
  (not Waiting any more, or deleted), the service leaves it alone.
- The API key stays in the macOS Keychain and is read only when a run starts; never
  put it in settings, which sync with the vault. Results come back only as new files,
  and a note carrying a Project's or Action's frontmatter (agents copy it from the
  material) is imported without it (`withoutEntityFrontmatter`), or it would clash with
  the original's id.

## Ranking cards

- Board order is an integer rank (`order` on Projects, `priority` on Actions).
  `ranksForOrder` in `src/domain/ranking.ts` keeps every rank that still fits and
  gives moved cards a rank between their neighbours, so a drop writes one file.
- `src/elm/Gtd/Ranking.elm` is a step-for-step copy: the Projects view and the
  Actions board use it to show a drop before the host writes it and to recognise
  the confirming snapshot.
  Change both together, or dropped cards flicker until the next snapshot.
