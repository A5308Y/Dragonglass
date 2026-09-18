# Dragonglass GTD

Dragonglass GTD is a file-first GTD board for Obsidian. Every Project and Action is an ordinary Markdown file; the plugin keeps only a disposable in-memory index and view configuration.

## Development installation

Requires Obsidian 1.13 or newer. Development uses Node.js 24 LTS (pinned in `mise.toml`); Node.js 22.12 or newer is the supported tooling minimum.

1. Run `mise install`.
2. Run `mise exec -- npm install` and `mise exec -- npm run build`.
3. Create `.obsidian/plugins/dragonglass-gtd` in a dedicated test vault.
4. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
5. Reload Obsidian and enable **Dragonglass GTD** under Community plugins.

Do not first develop or test file-writing plugins against your only copy of an important vault.

## Files are the database

New files use these default destinations:

```text
GTD/Actions/
GTD/Projects/
Projects/<project title>/
```

The first two paths and the default Action status are configurable. Existing entities are discovered anywhere in the vault by their `type` property, so moving or renaming a file does not break it.

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

A Project has `type`, ULID `id`, `title`, `status`, `created`, and optional `area`, `reviewed`, `completed`, and `support_path`. Normal notes, PDFs, and other files can live beneath that support path.

## Commands

- **GTD: Open Action Board**
- **GTD: Open Projects**
- **GTD: New Action**
- **GTD: Quick Capture Action**
- **GTD: New Project**

Assign any command to an Obsidian hotkey. Quick Capture asks only for a title and immediately creates an Inbox Action.

## Board behavior

The default board groups by status. It supports Project, status, context, energy, availability, and due-soon filters; Project/context/energy grouping; created/due/title/Project sorting; title and Project search; and named saved views.

On desktop, drag an Action between status columns. On mobile, or whenever drag-and-drop is inconvenient, open the card's menu to change its status, Project, or context. A failed write rolls the optimistic card move back and displays an Obsidian Notice.

Keyboard navigation inside the board uses Up/Down to move between cards, Enter to open the Markdown file, and `D` to mark the focused Action done.

Marking an Action done writes `status: done` and an ISO completion timestamp. Reopening through the quick action sets `status: next` and clears `completed`. Dates never change statuses automatically.

## Projects

The Projects view displays open and Next Action counts, review dates, and warnings for active Projects with no open or Next Actions. Project detail reads the Desired outcome from the Project note, resolves its live Actions, and lists ordinary files beneath `support_path`; it does not duplicate Action data into the Project note.

## Bases

Ready-to-copy examples are in [GTD Actions.base](examples/GTD%20Actions.base) and [GTD Projects.base](examples/GTD%20Projects.base). They contain views for:

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

This version intentionally excludes AI integration, Obsidian Tasks migration, bulk migration, recurring Actions, manual card ranking, body full-text indexing, and a dedicated diagnostics view.
