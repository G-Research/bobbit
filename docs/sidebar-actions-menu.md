# Sidebar Actions Menu

The Sidebar Actions Menu makes row actions discoverable without removing the fast hover buttons that experienced users already rely on. It applies to live session rows, team-lead rows, and goal rows in the desktop sidebar.

The feature lives at the seam between the app shell (`src/app/` row rendering and route helpers), Lit UI components (`src/ui/components/SidebarActionsPopover.ts`), and gateway REST endpoints for duplicate-session and GitHub-link resolution. API details are also listed in [REST API](rest-api.md).

## Desktop behavior

On desktop, each supported sidebar row keeps its existing hover-revealed action strip. The new hamburger trigger is appended as the right-most button in that strip.

- Hovering the row reveals the existing quick-action icons plus the hamburger.
- Focusing a quick action also reveals the strip via `:focus-within`, so the hamburger is reachable by keyboard tab order even without pointer hover.
- The hamburger is a menu button with `aria-haspopup="menu"`, synchronized `aria-expanded`, and an entity-specific label (`Session actions` or `Goal actions`).
- Opening the menu does not reparent the quick buttons. Their direct click behavior remains the same; the hamburger is additive.

The popover rows use the same action model as the quick buttons. This keeps labels, icons, destructive tone, and click handlers in one place.

## Keyboard behavior

The hamburger supports:

- `Enter` / `Space` — open the menu through normal button activation.
- `ArrowDown` / `ArrowUp` — open the menu and focus the menu list.

The menu supports roving focus:

- `ArrowDown` / `ArrowUp` — move between rows, wrapping at the ends.
- `Home` / `End` — jump to first or last row.
- `Enter` / `Space` — run the highlighted action.
- `Escape` — close and restore focus to the trigger when possible.
- `Tab` — exits the menu instead of trapping focus.

Menu key events stop propagation so they do not race the sidebar's global `Ctrl+↑` / `Ctrl+↓` navigation described in [Sidebar keyboard navigation](sidebar-keyboard-navigation.md).

## Mobile v1 behavior

Mobile suppresses the hamburger entirely. Existing inline quick actions stay visible and clickable in mobile rows.

Menu-only actions are intentionally desktop-only in v1:

- Session `Copy link`
- Session `Duplicate session`
- Goal `Copy link`
- Goal `Open on GitHub`

This avoids adding a redundant dense tap target on mobile, where the quick actions are already always visible. Browser E2E pins this as intentional behavior rather than a regression.

## Session actions

### Live session rows

| Action | Placement | Availability | Behavior |
|---|---|---|---|
| `Modify` | Quick + menu | Plain live session | Opens the existing rename dialog. |
| `Edit staff` | Quick + menu | Staff-backed live session | Navigates to that staff page. |
| `Terminate` | Quick + menu | Plain live session | Opens the existing terminate confirmation. |
| `End team` | Quick + menu | Team-lead session | Opens the existing team-end confirmation with goal context. |
| `Copy link` | Menu only | Live session / team-lead row | Copies an absolute hash route for the session. |
| `Duplicate session` | Menu only | Plain live, non-archived, non-child, non-team, non-read-only sessions | Calls the duplicate-session endpoint and connects to the new session. |

Archived sessions and unsupported live session kinds do not expose `Duplicate session`. The server also enforces this with `422` responses so clients cannot bypass UI availability checks.

### Copy link and fallback

Session copy uses the canonical hash route:

```text
${location.origin}${location.pathname}${location.search}#/session/<sessionId>
```

The client first calls `navigator.clipboard.writeText`. If clipboard access is unavailable or rejected, it lazy-loads `copy-link-fallback-dialog` with the title `Copy session link` and a preselected readonly input containing the URL.

### Duplicate session endpoint

`POST /api/sessions/:id/duplicate` creates a new session from persisted source-session context. It duplicates context, not history.

The endpoint preserves the project/task/goal/session configuration needed for the new session to behave like a fresh fork:

- project id and cwd/worktree context
- goal id and reattempt goal id
- task id
- assistant type
- staff id, role, accessory, role prompt, and staff pinned memory when applicable
- sandbox setting and allowed tools
- selected model provider/model id

It does not copy transcript JSONL, tool content, read state, proposal drafts, or other historical UI state. The new title is generated as `Copy of <source title>`.

Goal-bound duplicates are created through the same goal-aware creation path so goal context is preserved. If the source goal is still `todo`, the server advances it to `in-progress`, matching normal goal-session creation semantics.

The client helper posts to the endpoint, refreshes the session list, and connects to the returned session id.

## Goal actions

| Action | Placement | Availability | Behavior |
|---|---|---|---|
| `Re-attempt` | Quick + menu | Goal has no active session | Starts the existing re-attempt flow. |
| `Archive` | Quick + menu | Goal is not archived | Runs the existing archive/delete-goal handler. |
| `Goal dashboard` | Quick + menu | Live goal row | Navigates to `#/goal/<goalId>`. |
| `Copy link` | Menu only | Live goal row | Copies an absolute hash route for the goal. |
| `Open on GitHub` | Menu only | A PR URL or GitHub branch URL can be resolved | Opens the PR or branch view in a new tab with `noopener` semantics. |

Goal copy uses the canonical hash route:

```text
${location.origin}${location.pathname}${location.search}#/goal/<goalId>
```

Clipboard failure opens the same fallback dialog with the title `Copy goal link`.

## GitHub link resolution

`Open on GitHub` is shown only when the app can resolve a safe URL.

Client behavior:

1. Use `state.prStatusCache.get(goal.id)?.url` immediately when present.
2. Otherwise, when the goal menu opens, lazy-fetch `GET /api/goals/:id/github-link`.
3. Cache positive responses briefly and negative responses for a shorter period, so no-remote states can refresh after a remote/branch appears.
4. Refresh the open popover when an async fetch makes `Open on GitHub` newly available.

Server behavior:

1. Look up the goal across project contexts.
2. Return a stored PR URL from `PrStatusStore` if one exists.
3. Otherwise run the PR-status lookup for the goal branch through `execFile` argument arrays, not shell command strings.
4. If no PR exists, require a goal branch and resolve `origin` with `git remote get-url origin` through `execFile`.
5. Strip embedded credentials, parse only GitHub HTTPS/HTTP/SSH/scp-style remotes, and construct a branch tree URL with encoded owner, repo, and branch segments.
6. Return unavailable for missing goals, goals without branches, missing remotes, or non-GitHub remotes.

The important trust boundary is that the browser never constructs GitHub branch URLs from raw remotes. The server owns remote parsing and sanitization.

## Popover lifecycle, cleanup, and animation

`sidebar-actions-popover` is a light-DOM Lit component modeled after the project picker popover so global modal detection sees `data-popover-open` while it is open or closing.

Dismissal paths:

- outside pointer down
- `Escape`
- route/hash change or browser history navigation
- selecting a menu item
- clicking the same hamburger again
- opening another sidebar actions menu
- component unmount/disconnect

The popover is fixed-positioned relative to the trigger. It right-aligns below the trigger by default, clamps to viewport padding, flips above when there is more room above than below, and constrains max height so the menu remains scrollable.

Opening uses a FLIP-style shared-element animation:

1. The sidebar captures quick-action button rects before mounting the popover.
2. The popover measures matching menu icon rects after render.
3. Matching quick-action icons animate from their source strip positions into their menu positions.
4. Menu-only rows fade/slide in after the shared icons, making the new actions discoverable.

Closing runs the reverse animation when the source and target rects are still available. If layout/route changes removed the source row, close falls back to a fade-only path. All animations are cancelable and are cleaned up on close and `disconnectedCallback`.

When `prefers-reduced-motion: reduce` matches, FLIP and slide animations are skipped. Focus, dismissal, and action behavior remain identical.

## Tests to run

For changes to this feature, run the focused coverage first:

```bash
npx tsx --import ./tests/helpers/css-stub-loader.mjs --test --test-force-exit tests/sidebar-actions-flip.test.ts tests/sidebar-actions-server.test.ts
npm run test:e2e -- tests/e2e/sidebar-actions-server.spec.ts tests/e2e/ui/sidebar-actions-menu.spec.ts
```

Then run the broader validation expected for UI + server changes:

```bash
npm run check
npm run test:unit
npm run test:e2e
```

The focused browser suite covers desktop hover/focus hamburger visibility, direct quick-action regressions, menu contents, copy success/fallback, duplicate session navigation/context preservation, GitHub PR/branch/no-remote states, dismissal cleanup, reduced motion, and mobile v1 hamburger suppression.
