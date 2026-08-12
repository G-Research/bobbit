# Session manager sidebar mock

Interactive design mock for the alternate sidebar views. The normative implementation contract is [Session Manager Sidebar Views](../../session-manager-sidebar-views.md).

- **By Project** — the existing project and goal tree.
- **By Status** — mutually exclusive Pinned, Unread, and Read sections, sorted by latest activity.
- Per-view filters, with **Show teams** available only in By Status and disabled by default.
- Shared production search behavior and canonical session rows, Bobbit sprites, actions, and menus.

Run from the repository root:

```bash
npx vite --config docs/design/mockups/session-manager/vite.config.mts
```

Build the mock:

```bash
npx vite build --config docs/design/mockups/session-manager/vite.config.mts
```

The build output is generated under `.bobbit-qa/session-manager-dist` and is intentionally not committed.
