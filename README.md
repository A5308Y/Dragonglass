# Dragonglass GTD

Dragonglass GTD is a file-first GTD board for Obsidian. Projects and Actions are ordinary Markdown files, while the Inbox accepts any normal vault file; the plugin keeps only a disposable in-memory index and view configuration.

## Development installation

Requires Obsidian 1.13 or newer. Development uses Node.js 24 LTS (pinned in `mise.toml`) and Elm 0.19.2; Node.js 22.12 or newer is the supported tooling minimum. The build checks the Elm compiler version before compiling the Elm surfaces.

1. Run `mise install`; both Node and Elm are pinned by `mise.toml`.
2. Run `mise exec -- npm install` and `mise exec -- npm run build`.
3. Create `.obsidian/plugins/dragonglass-gtd` in a dedicated test vault.
4. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
5. Reload Obsidian and enable **Dragonglass GTD** under Community plugins.

Do not first develop or test file-writing plugins against your only copy of an important vault.

### Repository test vault

The repository includes `Test Vault`. Running `mise exec -- npm run build` produces the production bundle and automatically copies `main.js`, `manifest.json`, and `styles.css` into `Test Vault/.obsidian/plugins/dragonglass-gtd`. Reload Obsidian after building to load the new code.

To deploy every build into additional local vaults, copy `.dragonglass-vaults.example.json` to `.dragonglass-vaults.json` and replace the example with absolute vault paths:

```json
{
  "vaults": [
    "/Users/you/Documents/Main Vault"
  ]
}
```

The local configuration is ignored by Git. Each build copies real plugin files into every configured vault's `.obsidian/plugins/dragonglass-gtd` directory, so Obsidian Sync can carry the plugin to mobile. After the first build, enable **Dragonglass GTD** in that vault; after later builds, reload Obsidian to load the update. `mise exec -- npm run deploy:vaults` redeploys existing build artifacts without rebuilding.

## Files are the database

New files use these default destinations:

```text
GTD/Inbox/
GTD/Actions/
GTD/Projects/
Project Support Material/<root project>/<sub-project>/
General Reference/
```

The Inbox, Action, Project, and Reference destinations, default Action status, and default Project image are configurable. Existing entities are discovered anywhere in the vault by their `type` property, so moving or renaming a file does not break it. Every file beneath the configured Inbox directory is indexed as an Inbox Item even when it has no frontmatter or is not Markdown.

Quick Capture creates an Inbox Item, not an Action:

```yaml
type: gtd-inbox-item
id: 01K5INBOX1234567890123456
title: Look into heating options
created: 2026-09-18
```

Inbox Items have no status. Processing a captured Dragonglass note transforms that Markdown file into an Action, moves it to the Actions directory, and preserves its stable ID and note body. A plain Markdown file dropped into Inbox receives a new ULID when converted. Binary files cannot become Markdown Actions, so Dragonglass creates the Action separately and preserves the source file in Project Support Material or General Reference. The original capture date is retained as `captured`; the Action receives its own `created` date. `inbox` is not a valid Action status.

Supported Action statuses are `next`, `waiting`, `scheduled`, `done`, and `cancelled`. Someday/Maybe is represented by a Project status, never an Action status. Legacy Actions with `status: someday` are migrated to `next` when the plugin starts.

The processing view puts Project, Project Vision, Next Action, and Context fields above four immediate dispositions. Project and Context support fuzzy matching while still accepting new names. A decision either creates a Next Action, files the source note as Project support or General Reference (optionally also creating a Next Action), creates a Someday/Maybe Project with support material and a Next Action, or sends the source note to Obsidian's trash. There is no Skip action and no follow-up modal after choosing a disposition.

For compatibility, legacy files with `type: gtd-action` and `status: inbox` appear in the dedicated Inbox view rather than on the Action board. Processing them rewrites them into the current Action format.

An Action contains clean YAML such as:

```yaml
type: gtd-action
id: 01K5XYZABC1234567890123456
title: Compare heat pump installers
status: scheduled
project_id: 01K5ABCDEF1234567890123456
project: "[[GTD/Projects/Replace heating system|Replace heating system]]"
context: computer
energy: medium
due: 2026-09-23
defer_until:
waiting_since:
scheduled_start: 2026-09-22T12:00:00.000Z
duration_minutes: 45
created: 2026-09-18
completed:
```

`project_id` is authoritative. The `project` link is only a human- and Bases-friendly convenience.

Scheduled Actions use `scheduled_start` as an absolute RFC3339 timestamp and `duration_minutes` as a positive whole number. `due` remains a deadline rather than a calendar time. Moving an Action to Scheduled asks for these values when they are missing.

Waiting Actions always carry a `waiting_since` date and may omit `context`; every other Action status requires one. Moving an Action to Waiting stamps today unless the editor supplies another date, re-editing a Waiting Action keeps the date it is already waiting since, and leaving Waiting clears it so no date outlives the wait it recorded. The Action editor shows the field only while the status is Waiting, and both the board card and the Action row read `Waiting since <date>`. Actions that were already Waiting before the field existed are stamped with the date Dragonglass first loaded the vault after this change.

A Project has `type`, ULID `id`, `title`, `status`, `created`, and optional `area`, `reviewed`, `activate_at`, `completed`, `image`, `tags`, `order`, `blocked_by_project_ids`, and `support_path`. The `image` value is a vault-relative image path selected in the Project editor; when absent, the configured default Project image is used. `tags` supplies custom board filters, `order` persists board priority, and `blocked_by_project_ids` records stable-ID dependencies. Supported Project statuses are `active`, `backlog`, `someday`, `completed`, and `cancelled`; the UI labels `someday` as Someday/Maybe. A Someday/Maybe Project can carry an `activate_at` date; Dragonglass adds that date to its calendar feed and changes the Project to Active when the day arrives. Normal notes, PDFs, and other files can live beneath that support path. Generated support folders mirror the full Project hierarchy, for example `Project Support Material/Dragonglass/Project Board`.

Sub-projects use the same Project files and add an optional stable-ID relationship:

```yaml
parent_project_id: 01K5ABCDEF1234567890123456
parent_project: "[[GTD/Projects/Replace heating system|Replace heating system]]"
```

`parent_project_id` is authoritative; the wiki-link is a convenience. Project pickers fuzzy-search and display the complete hierarchy as `Project > Sub-project > Sub-sub-project`. The Project editor can change or clear a parent, and Project cards and details provide quick sub-project creation. Cycles are rejected and malformed manual relationships appear in diagnostics.

## Commands

- **GTD: Open Action Board**
- **GTD: Open Inbox**
- **GTD: Open Projects**
- **GTD: Open Project** (fuzzy Project picker; Cmd/Ctrl+Shift+O by default)
- **GTD: Start Project Review**
- **GTD: Open Brainstorm**
- **GTD: Open Feeds**
- **GTD: Fetch Feeds**
- **GTD: Import Email**
- **GTD: Quick Capture Inbox Item**
- **GTD: New Action**
- **GTD: New Project**

Assign any command to an Obsidian hotkey. A plugin's default hotkey is only a suggestion: when it collides with a command that already owns that chord, Obsidian flags the conflict in Settings → Hotkeys and the binding does nothing. Check there after install if a default appears not to fire. Quick Capture asks only for a title and immediately creates an Inbox Item. New Action provides a lightweight Title, fuzzy Project, fuzzy Context, and Status form. It is also available from the Actions header, Projects header, each Project card menu, and Project detail; Project-specific entry points preselect that Project.

## Board behavior

The default board groups by status. It supports Project, status, context, energy, availability, and due-soon filters; Project/context/energy grouping; created/due/title/Project sorting; title and Project search; and named saved views.

On desktop, drag an Action between status columns. On mobile, or whenever drag-and-drop is inconvenient, open the card's menu to change its status, Project, or context. A failed write rolls the optimistic card move back and displays an Obsidian Notice.

Keyboard navigation inside the board uses Up/Down to move between cards and `D` to mark the focused Action done.

Marking an Action done writes `status: done` and an ISO completion timestamp. Reopening through the quick action sets `status: next` and clears `completed`. Action dates never change Action statuses automatically.

## Feeds

Feeds are an optional RSS and Atom reader whose only job is to decide what deserves the Inbox. It is off by default; enable it in settings, then subscribe from the Feeds view or the settings tab.

A Feed Item is not a vault file. It is a row in one JSON store until you keep it, and keeping it creates an ordinary Inbox Item that goes through the normal Inbox Processing Workflow unchanged. That split is the whole point: the Inbox clarifies one capture at a time against a two-minute budget because everything in it was put there deliberately, while a feed sends far more than it is owed and most of it earns one verdict. Routing feed Items into the Inbox directly would make Inbox zero meaningless, and a "mark all as read" would mean hundreds of files in Obsidian's trash.

Because nothing is written until an Item is kept, discarding is cheap and reversible. **Undo** in the Feeds header puts the last discard back in full.

The list is the surface rather than a way into a processor. Items are grouped by feed in collapsible sections, each with a count and its own **Discard** button; a search box filters titles, authors, and summaries. Clicking an Item's title expands its summary in place; **Open** opens the article in a browser. A feed is renamed or unsubscribed from the settings tab, which lists every subscription whether or not it currently has unread Items.

Two dispositions, both immediate. **Keep** sends one Item straight to the Inbox — no marking, no confirmation, no follow-up modal — to be clarified there later by the ordinary Inbox Processing Workflow. Everything else is noise a feed sent that you did not ask for, so discarding is deliberately coarser: a feed's **Discard** button clears every Item currently shown in that feed, and the toolbar's **Discard all** clears every Item in every open section at once, which is the global "mark all as read". Both buttons state exactly how many Items they cover and are disabled once there is nothing left to discard; collapsing a feed protects it from **Discard all** without needing to keep anything in it.

Rows are keyboard-operable, which is where a list-heavy triage pass actually gets fast. Up and Down move between rows, Enter expands one, `K` keeps it, `O` opens its article, `C` opens its discussion page, and `S` discards its whole section. Focus lands on whichever row takes the place of one that leaves.

A row's **Comments** button opens the discussion page a feed names separately from its article — RSS's `<comments>` element or Atom's `rel="replies"` link. Hacker News's feed is the common example: its `<link>` is the linked article, and `<comments>` is the Hacker News thread. The button only appears when a feed actually provides one, and a kept Item's note records it alongside its source link.

Subscriptions and triage state live in a single JSON file in the vault, `GTD/feeds.json` by default, so which Items you have already swept travels with ordinary vault sync rather than with plugin settings. Each feed remembers the keys it has resolved, capped so the file cannot grow without bound; a feed that keeps serving the same window therefore does not refill a list you have already swept. The file is disposable in the sense that a lost one costs only unread Items, but deleting it does forget what was discarded.

Fetching is a direct request to each feed's server, on start-up and on a configurable interval of at least five minutes. Feed documents are parsed into plain values and never into DOM nodes, so nothing a feed publishes becomes markup: summaries are flattened to text, only `http` and `https` links are kept, and text written into a kept Item's note has wikilinks, embeds, and tags escaped so a feed cannot add itself to your graph.

## Email

Email import is an optional IMAP mirror: chosen mailboxes are drained into the Inbox, and every message it accepts becomes an ordinary Inbox Item that goes through the normal Inbox Processing Workflow. It is off by default, takes one account per IMAP server, and is configured entirely in settings.

There is no mail reader here and there is not meant to be one. Your mail client already triages better than anything Dragonglass would build, and it can do the thing IMAP cannot: reply. So importing is the only decision Dragonglass makes about a message — after that it is a capture like any other.

**Nothing that is already in a mailbox is ever imported.** The first sync of a mailbox records where to start and imports none of it, so connecting an account with four thousand messages in it produces four thousand Inbox Items exactly never. Only mail arriving afterwards comes in. **Import backlog**, per account, is the deliberate way to ask for the existing mail if you do want it.

Three guards sit behind that, in the order they bite. A mailbox is baselined on first contact, as above. A watermark then records the point below which everything has been considered, so an ordinary import asks the server about new mail only. And a per-import limit — fifty by default — caps how many messages become Inbox Items at once, so someone bulk-moving five hundred messages into your inbox costs you fifty Items and a note that the rest are waiting. Messages are also recognised by their `Message-ID`, so a mailbox whose UIDs the server has renumbered does not import itself again, and two devices syncing the same mailbox do not both import it.

Point it at `INBOX`, not at Gmail's `[Gmail]/All Mail` or a provider's Archive. Those hold every message you have ever received regardless of whether your inbox is empty, and mirroring one is how an import turns into a flood. **Test** lists the mailboxes exactly as your server spells them, which matters: a German account calls its drafts `Entwürfe`, and IMAP sends that over the wire as `Entw&APw-rfe`.

Set **Move imported mail to** — `Archive`, say — and importing drains your mail inbox as it goes, leaving one queue instead of two. The message moves only after its Inbox Item exists, and messages are never deleted: where a server has no `MOVE`, Dragonglass copies and flags rather than expunging. Left empty, the import is strictly read-only and your mail client sees nothing change.

Reading is read-only regardless: mailboxes are opened with `EXAMINE` and bodies fetched with `BODY.PEEK`, so importing never marks your mail as read. Only the part of a message that carries text is fetched, not its attachments, and a note records the sender, the date, the mailbox, and the `Message-ID` — which is the way back to the original once it has been archived, and is searchable on Gmail as `rfc822msgid:`.

Use a provider-issued **app password**, never your account password. It is revocable, it is scoped to mail, and it is stored as plain text in the plugin's data file — which is also why account credentials are kept out of the vault file the watermarks live in, since that one syncs between devices. Only implicit TLS on port 993 is offered, certificate validation cannot be switched off, and cleartext IMAP on 143 is corrected rather than used.

Everything a sender wrote is treated as hostile. Bodies are flattened to text and never rendered as markup, remote images are never loaded, and wikilinks, embeds, and tags are escaped on the way into a note so that a subject line cannot add itself to your Project graph.

Importing needs the desktop app: Obsidian on mobile cannot open an IMAP connection at all. That costs less than it sounds like — imported messages are ordinary Inbox Items, so they reach your phone through vault sync, and the sync watermarks travel with them so no device re-imports what another already took.

## Google Calendar

Google Calendar integration is an optional one-way mirror for Scheduled Actions and scheduled Project activations. It uses a user-owned Apps Script bridge and a dedicated calendar, so Dragonglass never stores a Google OAuth refresh token. Configure the bridge using [the setup guide](integrations/google-calendar/README.md), then enter its deployment URL and shared secret in plugin settings.

Each valid Scheduled Action becomes a busy calendar event containing its title, Project breadcrumb, Context, and an Obsidian deep link. A Project activation becomes an all-day event with its Project breadcrumb and deep link. Every managed event carries an alarm, replacing the calendar's default reminders: one hour before the start for an Action with a time of day, and 09:00 the preceding day for an all-day event.

A Scheduled Action need not have a time of day. Writing `scheduled_start` as a plain date, which the **All day** toggle in the Action editor does, makes the Action an all-day event on that date and drops its duration, since a whole day has no length to reserve. Google measures an all-day event's alarm back from midnight on its date, so the 09:00-the-day-before alarm is sent as 900 minutes. Actions with a time of day still require a positive `duration_minutes`.

Leaving Scheduled or deleting the Action removes its managed event. Calendar-side changes are overwritten by the next reconciliation; unrelated calendar events are never touched. Sync runs after local index changes, at startup, every five minutes, and through **Sync now** in settings. The bridge URL and shared secret are stored as plain text in the plugin data file.

## Projects

The Projects board has Active, Backlog, Someday/Maybe, and Completed columns. Its Columns control hides or restores individual columns and remembers that choice; at least one column remains visible. Projects move between columns by desktop drag-and-drop or the card menu on touch devices. Project `waiting` is not a supported status; legacy Projects using it are migrated to `active`. The Active column header shows an issue count derived from the warnings on its visible Project cards. Cards display the Project image, tags, hierarchy breadcrumbs, counts of open Actions, Active sub-projects at any depth, and support-material files, review or scheduled-activation dates, and warnings for active Projects with no open or Next Actions. A Next, Scheduled, or Waiting Action satisfies the Next Action warning. Board-card file counts attribute each file to its deepest owning Project, so nested files never inflate an ancestor's count. Project detail is intentionally broader: its support-material overview shows every file and folder in the full subtree, including empty organizational folders and nested sub-project material. New notes and relative folder paths such as `Archive/2025` can be created there directly. Project detail also shows a larger version of the image and provides a complete board for immediate sub-projects. A sub-project's header carries a second back button, left of ← Projects, that walks one level up the hierarchy, so a deep tree can be climbed without returning to the board. That board supports status changes, persistent priority ordering, multi-tag filtering, cycle-checked `blocked by` relationships, and list import for immediate children; checked imported items become Done and hashtags become Project tags. Completed or cancelled blockers are treated as satisfied. Project detail reads the Desired outcome from the Project note and edits it in place: Edit swaps the rendered Markdown for a textarea, ⌘/Ctrl+Enter saves, Escape cancels, and a reload triggered by the save never overwrites text still being typed. The Project editor modal no longer carries the field. Project detail also resolves live Actions without duplicating Action data into the Project note. Markdown support files have collapsible previews and inline editing, images have previews, and other files remain normal openable vault files.

The Select control turns the board into a batch editor. Cards gain a checkbox, card clicks toggle selection instead of opening the Project, and dragging is suspended. Select all shown picks every card the current search and column filters leave visible, while the selection itself survives changing that search, so several passes can build one batch. Selected Projects can be tagged, re-parented, or deleted together. Adding tags keeps the tags a Project already carries and skips Projects that have them all. Setting a parent excludes the selection and its descendants from the search and rejects any move that would create a hierarchy cycle; clearing the field makes the selection top-level. Batch edits are written one Project at a time, so a single failure neither abandons the rest nor hides its reason.

Deleting a Project from its card menu moves its Project note, directly linked Action files, and complete configured support-material folder to Obsidian's trash. A Project with sub-projects cannot be deleted until those children are moved or deleted; a batch delete satisfies that itself by deleting deepest sub-projects first, and keeps any Project whose children stay behind. Batch deletion confirms once, listing what goes to the trash. Dragonglass also refuses deletion when the support folder contains unrelated GTD entities.

When an Action is edited from Project Details, it can be converted into an Active sub-project of its selected Project. The Action title becomes the Project title, its Markdown body is retained in Project Notes, and the original Action is moved to Obsidian's trash only after the new Project is created.

## Processing, review, and brainstorming

**Process Inbox** works through indexed Inbox Item files in capture order, with a two-minute decision timer and session progress. An Inbox Item that is an audio file — a voice memo dropped in from a recording device — gets inline transport controls in place of the note preview, so it can be played and paused without opening it in a separate view. The inline form resolves an existing Project by fuzzy selection or exact title, creates an Active Project for an unmatched name when needed, and accepts existing or new Context values.

An unmatched name may also be a path into the hierarchy. Typing `Heating > Heat pump` creates `Heat pump` as a sub-project of an existing `Heating`, using the same breadcrumb format the Project picker already displays; the field's hint names the parent it resolved. The prefix matches a full breadcrumb, or a bare title when only one Project carries it. Only the segment after the final separator is ever created, so an unresolvable prefix such as `Nonsense > Heat pump` stays part of the title rather than silently creating a parent you did not ask for.

Two checkboxes shape the disposition, and a single primary button follows them, each sitting with the thing it governs. **Someday/Maybe**, below the Project name, parks the Project rather than activating it: an existing Project moves to Someday/Maybe, and without one the Item's own title names the new Project. **File with Project**, below the Inbox Item itself, decides what becomes of the capture. Left off, the capture is consumed — a Markdown Inbox Item is rewritten into the `gtd-action` itself, and any other captured file, a voice memo or a photo, is moved to Obsidian's trash once its Action exists. A parked capture has nothing to absorb it, so leaving filing off there discards it outright. Switched on, the capture survives as reference material in Project support material or General Reference with its Dragonglass metadata removed, any Next Action becomes a separate Action file, and the Next Action itself becomes optional, which is how a capture is filed as pure reference. Both checkboxes start off for each Item, as does the Work toggle, which sits on the Context field's own label line since it only ever marks the Action it creates.

**Project Review** presents each active Project hierarchy as one combined review item instead of reviewing its sub-projects one by one. It shows the whole Project tree, aggregates and labels Actions and support-file counts across all descendants, and requires every active member of the tree to have a Next Action before continuing. The inline Action capture can target any Project in the tree through fuzzy search. Marking the tree reviewed records the date on every active member. The root Project's `## Desired outcome` and `## Diary` remain the focus of the review. Review progress is session-only and disposable; there is no review-session database or JSON file.

**Brainstorm** chooses among open Actions whose title contains `brainstorm`, provides a five-minute timer and an offline random-word prompt bank, and edits the related Project's Desired outcome. Saving completes the source Action and writes a normal Markdown note into the Project's support folder. If the Action has no Project, the result becomes a new Inbox Item. When no matching Action exists, a standalone session can be started from a typed topic and its result is captured to the Inbox. The workflow deliberately makes no network requests for inspiration images.

Actions captured during Project Review pass through the same Inbox Item-to-Action transformation as normal processing and retain a `captured` date; the plugin has no separate “floating actions” store.

## Bases

Ready-to-copy examples are in [GTD Inbox.base](examples/GTD%20Inbox.base), [GTD Actions.base](examples/GTD%20Actions.base), and [GTD Projects.base](examples/GTD%20Projects.base). They contain views for:

- Inbox Items
- All Actions
- Next Actions
- Actions by Project
- Waiting
- Due Soon
- Active Projects
- Projects without Next Actions

The last view uses `file.backlinks` and the convenience `project` wiki-link. Obsidian documents backlink formulas as comparatively expensive and not always immediately refreshed, so use the plugin's Projects view for authoritative live counts.

## Data safety

- Frontmatter changes use Obsidian's file APIs and preserve unknown properties and note bodies.
- Stable IDs, not filenames, define identity and relationships.
- Duplicate IDs and malformed GTD metadata are not silently mutated.
- The in-memory index can always be rebuilt from Markdown files.
- The plugin uses no external database, Electron API, telemetry, or custom synchronization.
- Network access is confined to the three optional integrations you configure yourself: the Google Calendar bridge, Feeds, and Email. All three are off by default, and none sends vault content anywhere a feed, your mail server, or your own Apps Script deployment does not already require.
- Email import is the one feature that uses a Node API, because IMAP needs a TLS socket and Obsidian's own API offers no way to open one. It is reached for lazily and only on desktop, so mobile is unaffected rather than broken.

## Scope

This version intentionally excludes AI integration, Obsidian Tasks migration, bulk migration, recurring Actions, manual card ranking, body full-text indexing, and a dedicated diagnostics view. The old `gtd-processor` Express server, embedded checkbox-task storage, floating-actions file, and review-session JSON are not part of Dragonglass.
