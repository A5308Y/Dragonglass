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
- The running screen shows the session tree's Support Material (its Project and the Active
  sub-projects below, as for its Actions), one folded block per Project. The panels are
  `Gtd.Support`, shared with the Project page's Support tab, and the host side is
  `src/adapter/project-detail.ts`, shared too: change both views there, not in one of them.
  A file is listed under the Project whose support folder holds it most deeply
  (`projectSupportFiles`), so a nested sub-project's folder isn't shown twice.
- A time-tracking sync should: read finished sessions from the service's store,
  convert each with `toTimeEntry` (key = session id, stable across re-syncs),
  and record what it sent in `session.external[<integration>] = { id, syncedAt }`
  so a re-run updates rather than duplicates. `parsePomodoroStore` keeps
  `external` links and `mergePomodoroStores` merges them between devices.
- mite is the first such sync: rules in `src/domain/mite.ts`, sending in
  `src/pomodoro/mite-sync.ts`. One entry per session; a completed session adds the
  break minutes (setting), a stopped one doesn't. The mite project is set per
  Dragonglass Project in the settings and inherited by sub-projects; sessions of
  Projects without one are never sent. The sync only creates entries (POST): it never
  updates or deletes anything in mite, and removing a mapping leaves sent entries alone. The API key is
  in Obsidian's secret storage (`app.secretStorage`, per device); settings hold only
  the secret's name. New integrations with credentials should do the same.
- Mail app passwords are in secret storage too (`MailPasswords`, id
  `dragonglass-mail-<account id>`). `settings.mail.passwords` only holds old copies
  that each device migrates on start; never write new passwords there.
  The Google Calendar shared secret works the same way (`CalendarSecret`).

## Checklists

- Every note in the checklists folder (setting `checklists.directory`) is a checklist:
  its task lines are the items, everything else is shown as written between them
  (rendered by Obsidian, so links work). The note is the template and is never written;
  a run keeps its marks (done, skipped, open) in `GTD/checklists.json`. Don't add
  anything that writes ticks into the note or copies it per run.
- Rules are in `src/domain/checklist.ts` (tested in `tests/checklist.test.ts`); the
  service is `src/checklists/checklist-service.ts`. Items are keyed by their text (a
  duplicate gets `#2`), so editing the note mid-run is fine; marks on removed items are
  kept and shown as such.
- A checklist is not a Project and not a set of Actions. Don't turn items into Actions;
  what a run turns up is captured to the Inbox (`captureFromChecklist`).
- One daily checklist (setting `checklists.daily`) puts a dot on the Checklists ribbon
  icon until a run of it is finished that day. No daily Action, no calendar entry.
- A Pomodoro can be spent on a checklist run instead of a Project: the session has
  `checklist: { runId, path }`, an empty `projectId`, and the checklist's title as
  `projectTitle`. Checklist sessions are never sent to mite and never go to a Diary.
- Checklists should stay short (`SHORT_CHECKLIST_ITEMS`); the view says so past that,
  and after a run names items skipped in each of the last three runs.

## JSON stores shared between devices

- `GTD/feeds.json`, `GTD/mail.json`, `GTD/pomodoros.json` and `GTD/checklists.json` are written by every
  device through `SyncedJsonFile` (`src/state/synced-json-file.ts`): each write is a
  three-way merge of the file as last seen, this device's copy and the file now, and a
  change from sync is merged into the copy in memory. Never write these files directly.
- The merges are pure (`mergeFeedStores`, `mergeMailStores`, `mergePomodoroStores`,
  `mergeChecklistStores`, tested in `tests/synced-stores.test.ts`): resolved and handled keys only grow, except
  where this device deliberately took them back (Undo, reopening a mail backlog).
  A new field in a store needs a rule there too, or one device's value silently wins.

## Checking this device's copy

- The vault syncs through iCloud, which can leave a device showing an old state. "Check this
  device's copy" (`src/ui/check-device-copy.ts`, rules in `src/domain/device-copy.ts`) reads every
  note on the device and names what differs from what Obsidian shows: stale cached properties, files
  Obsidian missed or lists but are gone, iCloud placeholders (`.<name>.icloud`), and the newest change
  that did arrive. It shows what it finds rather than fixing it quietly.
- Notes whose cached properties are wrong are read from the file by the index
  (`GtdIndex.useFileProperties`) until Obsidian reads them again.

## Building and deploying

- `npm run build` type-checks, compiles Elm, bundles `main.js` and deploys to
  the configured vaults.
- `npm run deploy:vaults` only copies the existing `main.js`, `manifest.json`
  and `styles.css`; it does not build.
- `npm test` runs the vitest suite.

## Elm views that keep time

- Elm can't stop a program: when a view's tab closes, its program keeps running unseen,
  and any `Time.every` goes on ticking and redrawing until Obsidian quits. So each host
  sends `{ type: "closed" }` in `destroy()`, and each view with a timer checks
  `Host.isClosing` in its `GotHost` branch, sets `closed`, and returns `Sub.none` from
  `subscriptions` once closed. A new view with a timer must do the same.
- Don't empty a view's `contentEl` in `onClose`: Elm renders into it, and the redraw that
  "closed" (or a last tick) queues then fails on the missing nodes. A failed Elm draw
  retries on every animation frame, so one such error floods the console for good.
  Obsidian removes the tab's DOM itself.

## Index updates and speed

- `GtdIndex.getSnapshot()` is current as soon as a vault event is read, but listeners are
  told once per burst (40 ms after the last change, at most 250 ms late). Code that has
  to see its own write must read `getSnapshot()` or wait for a listener; don't assume a
  listener call per event.
- Every listener run redraws every open view, so work done per change must stay cheap
  (e.g. `projectSupportFileCounts` walks each file's folders, not every Project), and a
  write should be one file operation where it can: new Actions are written directly
  (`createAction`), not as an Inbox Item that is then converted.

## Planning a Project

- "Plan…" (Project page header and menus) starts a Brainstorm session on the Project (`ProjectSession` in
  `Brainstorm.elm`, `GtdBrainstormView.plan`): Purpose, Desired outcome and ideas, with the timer, prompts,
  partner and Support Material as usual. Don't build a separate planning UI; the Brainstorm view is it.
- Saving (`saveProjectBrainstorm`) writes `## Purpose` (before `## Desired outcome`, `setProjectPurpose`)
  and the outcome into the Project note, and the ideas as open boxes into a plan note in its support
  folder, marked `dragonglass: plan` in its frontmatter. Then the Project page opens.
- Organising is the Project page: "Ideas to organise" lists the open boxes (`planIdeas`), each one click
  from an Action or Sub-project (the usual dialogs, prefilled; the box is ticked once saved), a Someday
  Sub-project, or ✓. Everything else (order, blockers, Next Actions) is the page as it is. The plan's state
  is that Markdown task list, so it can be fixed by hand. Rules: `src/domain/project-plan.ts`, tested in
  `tests/project-plan.test.ts`.
- Brainstorming an Action in a Project shows and saves the Purpose too.

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
- An ended run leaves an Inbox Item (`runReportInboxItem`; setting `agent.reportToInbox`):
  the report's start is escaped like mail and quoted, since agents copy text from the web.
- Deleting a run removes its folder (after asking; it has no trash) but appends it to
  `deleted-runs.jsonl` in the runs folder, so its cost still counts and its Waiting
  Action stays out of later runs' material.
- The Brainstorm view's local partner is not a run: `src/brainstorm/local-partner.ts` asks
  the local model server directly (rules in `src/domain/brainstorm-partner.ts`), with only
  the session's topic, desired outcome and ideas, and only a server on this Mac
  (`localChatEndpoint` refuses other hosts). Give it more to read, or a remote server, and
  it needs the sandbox like the runs do.
- Local runs have three harnesses behind the same contract: our loop (`agent/runner-local`),
  smolagents' CodeAgent (`agent/runner-smol`) and Qwen-Agent (`agent/runner-qwen`), both
  pinned. `run.json` records `harness`; `localHarnessService` picks the compose service.
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

## Code runs

- The `lamdera` runtime hands a Project's idea to the coding agent, a separate repository
  (`lithic-coding-agent`). Dragonglass only writes the run folder and starts that agent's `task`
  service (`--profile dragonglass`, its own env file, so its own Compose project, sign-ins and checkouts);
  `AgentService.delegateCode` / `launch`. Never `compose down` that project: its Linear daemon may run there.
- The agent owns Git: Codex only edits files; the runner formats, commits, runs `lamdera check --force`
  before every push, merges the base branch, pushes without force and opens the PR. Don't move any of
  that into Dragonglass or the brief.
- The brief is the Project's own words (`codeTaskBrief`), no vault files. The repository is a name from the
  agent's `repositories.yml`, mapped per Project in the settings and inherited by sub-projects
  (`nearestMapped`); the agent resolves it from its config, never from task text.
- `codeTaskIdentifier` is stable per Project, so every run on it shares the branch and PR; "Follow up…"
  continues with the earlier runs as the conversation. A successful run leaves a "Review PR" Next Action
  (its id in the run's `host.json` as `reviewActionId`).
- Update runs (`mode: "update"` in `run.json`, `AgentService.updateCode`) only merge the base branch into the
  Project's open PR, with one Codex attempt at a conflict or failing checks, then check and push; no Waiting
  Action, no new Review Action, an Inbox report only on failure. They start from "Update branch" on the newest
  run whose Review Action is open (`updatableCodeRunId`), and automatically: once a Review Action is done,
  the other Projects on that repository with an open one get one each (`projectsToUpdate`, `settleReviews`).
  All code runs share one lane, so updates queue behind the run under way.
- Repositories have a stack in the agent's `repositories.yml`: `lamdera` (`lamdera check --force`,
  Evergreen, preview) or `commands` (its `checks` argument lists, optional `format`, no preview; e.g.
  Obsidian plugins). The checks live in that file, not in the repository or the brief, so the agent
  can't weaken its own gate. A new kind of repository is a new stack there (`Stacks` in the Ruby
  agent), not a second agent. The runtime id stays `lamdera` and the settings key `agent.lamdera`,
  so stored runs and settings keep working; user-facing text says "code"/"Code repositories".

## Ranking cards

- Board order is an integer rank (`order` on Projects, `priority` on Actions).
  `ranksForOrder` in `src/domain/ranking.ts` keeps every rank that still fits and
  gives moved cards a rank between their neighbours, so a drop writes one file.
- `src/elm/Gtd/Ranking.elm` is a step-for-step copy: the Projects view and the
  Actions board use it to show a drop before the host writes it and to recognise
  the confirming snapshot.
  Change both together, or dropped cards flicker until the next snapshot.

## Agent runtimes

- `AgentRuntime` is `claude` | `local` | `codex`; parse stored runs with
  `agentRuntime()` so a new runtime isn't read back as Claude. The compose
  service per runtime is chosen in `AgentService.launch`.
- Local and Codex runs are lanes of one run each (`laneBusy`); more wait queued.
- Only Claude runs have a budget; only local runs may read the whole vault, and
  then offline.
- The Codex container holds the user's ChatGPT sign-in (`codexHome()`, mounted
  as `/codex`). The user accepted that risk; keep it out of settings and logs,
  and never mount the user's own `~/.codex`.
