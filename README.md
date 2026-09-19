# Dragonglass GTD

Dragonglass GTD is a file-first GTD board for Obsidian. Projects and Actions are ordinary Markdown files, while the Inbox accepts any normal vault file; the plugin keeps only a disposable in-memory index and view configuration.

## Development installation

Requires Obsidian 1.13 or newer. Development uses Node.js 24 LTS (pinned in `mise.toml`); Node.js 22.12 or newer is the supported tooling minimum.

1. Run `mise install`.
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
Project Support Material/<project title>/
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
status: next
project_id: 01K5ABCDEF1234567890123456
project: "[[GTD/Projects/Replace heating system|Replace heating system]]"
context: computer
energy: medium
due: 2026-09-23
defer_until:
created: 2026-09-18
completed:
```

`project_id` is authoritative. The `project` link is only a human- and Bases-friendly convenience.

A Project has `type`, ULID `id`, `title`, `status`, `created`, and optional `area`, `reviewed`, `completed`, `image`, and `support_path`. The `image` value is a vault-relative image path selected in the Project editor; when absent, the configured default Project image is used. Supported Project statuses are `active`, `backlog`, `someday`, `completed`, and `cancelled`; the UI labels `someday` as Someday/Maybe. Normal notes, PDFs, and other files can live beneath that support path.

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
- **GTD: Open Project** (fuzzy Project picker; Cmd/Ctrl+K by default)
- **GTD: Start Project Review**
- **GTD: Open Brainstorm**
- **GTD: Quick Capture Inbox Item**
- **GTD: New Action**
- **GTD: New Project**

Assign any command to an Obsidian hotkey. Quick Capture asks only for a title and immediately creates an Inbox Item. New Action provides a lightweight Title, fuzzy Project, fuzzy Context, and Status form. It is also available from the Actions header, Projects header, each Project card menu, and Project detail; Project-specific entry points preselect that Project.

## Board behavior

The default board groups by status. It supports Project, status, context, energy, availability, and due-soon filters; Project/context/energy grouping; created/due/title/Project sorting; title and Project search; and named saved views.

On desktop, drag an Action between status columns. On mobile, or whenever drag-and-drop is inconvenient, open the card's menu to change its status, Project, or context. A failed write rolls the optimistic card move back and displays an Obsidian Notice.

Keyboard navigation inside the board uses Up/Down to move between cards and `D` to mark the focused Action done.

Marking an Action done writes `status: done` and an ISO completion timestamp. Reopening through the quick action sets `status: next` and clears `completed`. Dates never change statuses automatically.

## Projects

The Projects board has Active, Backlog, Someday/Maybe, and Completed columns. Its Columns control hides or restores individual columns and remembers that choice; at least one column remains visible. Projects move between columns by desktop drag-and-drop or the card menu on touch devices. Project `waiting` is not a supported status; legacy Projects using it are migrated to `active`. Cards display the Project image, hierarchy breadcrumbs, open and Next Action counts, review dates, and warnings for active Projects with no open or Next Actions. Project detail shows a larger version of the image, links its parent and immediate sub-projects, reads the Desired outcome from the Project note, and resolves its live Actions without duplicating Action data into the Project note. Markdown files beneath `support_path` have collapsible previews and inline editing; new support notes can be created directly from Project Details. Other support files remain normal openable vault files.

Deleting a Project from its card menu moves its Project note, directly linked Action files, and complete configured support-material folder to Obsidian's trash. A Project with sub-projects cannot be deleted until those children are moved or deleted. Dragonglass also refuses deletion when the support folder contains unrelated GTD entities.

When an Action is edited from Project Details, it can be converted into an Active sub-project of its selected Project. The Action title becomes the Project title, its Markdown body is retained in Project Notes, and the original Action is moved to Obsidian's trash only after the new Project is created.

## Processing, review, and brainstorming

**Process Inbox** works through indexed Inbox Item files in capture order, with a two-minute decision timer and session progress. The inline form resolves an existing Project by fuzzy selection or exact title, creates an Active Project for an unmatched name when needed, and accepts existing or new Context values. Creating a Next Action transforms the Inbox Item into a `gtd-action`. Filing removes Dragonglass entity metadata and leaves the original Markdown note intact in Project support material or General Reference; an optional Next Action is a separate Action file. Someday/Maybe creates or updates the selected Project with its vision, files the source note as support material, and creates the supplied Next Action.

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
- The plugin uses no network service, external database, Node API, Electron API, telemetry, or custom synchronization.

## Scope

This version intentionally excludes AI integration, Obsidian Tasks migration, bulk migration, recurring Actions, manual card ranking, body full-text indexing, and a dedicated diagnostics view. The old `gtd-processor` Express server, embedded checkbox-task storage, floating-actions file, and review-session JSON are not part of Dragonglass.
