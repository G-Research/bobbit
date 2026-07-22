# Sidebar Actions Menu

The Sidebar Actions Menu makes row actions discoverable without removing the fast hover buttons that experienced users already rely on. It applies to live session rows, team-lead rows, and goal rows in the desktop sidebar.

The feature lives at the seam between the app shell (`src/app/` row rendering and route helpers), Lit UI components (`src/ui/components/SidebarActionsPopover.ts`), and gateway REST endpoints for fork-session and GitHub-link resolution. Session rows consume the shared model in `src/app/session-actions.ts`; see [Unified Session Actions](session-actions.md) for cross-surface header/sidebar behavior. API details are also listed in [REST API](rest-api.md).

## Desktop behavior

On desktop, each supported sidebar row keeps its existing hover-revealed action strip. The new hamburger trigger is appended as the right-most button in that strip.

- Hovering the row reveals the existing quick-action icons plus the hamburger.
- Focusing a quick action also reveals the strip via `:focus-within`, so the hamburger is reachable by keyboard tab order even without pointer hover.
- The hamburger is a menu button with `aria-haspopup="menu"`, synchronized `aria-expanded`, and an entity-specific label (`Session actions` or `Goal actions`).
- Opening the menu does not reparent the quick buttons. Their direct click behavior remains the same; the hamburger is additive.
- While the menu is open, the hamburger trigger stays visible — only the quick-action buttons fade out (they animate into the menu via the FLIP transition below).
- The action strip is a zero-footprint absolute sibling, so a row's idle activity-time keeps its original flush-right resting position whether or not the strip is revealed. The strip remains keyboard-focusable.

The popover rows use the same action model as the quick buttons. This keeps labels, icons, destructive tone, and click handlers in one place. Menu items are ordered so the right-most hover button maps to the top menu row.

The popover is themed to match `ProjectPickerPopover` (8px radius, soft drop shadow, ~13px type honoring `--sidebar-font-scale`, `6px 10px` rows with `4px` radius, and `var(--accent)` hover background).

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

## Mobile sidebar-row behavior

Mobile landing/sidebar rows suppress the sidebar hamburger. Existing inline quick actions stay visible and clickable in mobile rows.

Menu-only sidebar-row actions remain desktop-only in the mobile landing list:

- Session `Copy link`
- Session `Open in new window`
- Session `Refresh agent`
- Session `Fork`
- Session `View System Prompt`
- Goal `Copy link`
- Goal `Open on GitHub`

Open-session mobile view is different: its header keeps icon-only quick actions and exposes the full canonical session action set through a `Session actions` hamburger. See [Unified Session Actions](session-actions.md#mobile-open-session-header).

## Session actions

### Live session rows

| Action | Placement | Availability | Behavior |
|---|---|---|---|
| `Modify` | Quick + menu | Plain live session | Opens **Modify Session** for title, colour, and role changes. |
| `Edit staff` | Quick + menu | Staff-backed live session | Navigates to that staff page. |
| `Terminate` | Quick + menu | Plain live session | Opens the existing terminate confirmation. |
| `End team` | Quick + menu | Team-lead session | Opens the existing team-end confirmation with goal context. |
| `Refresh agent` | Menu only | Live, interactive session / team-lead row (see [Refresh agent](#refresh-agent)) | Restarts that session's agent process without clearing its transcript. |
| `Fork` | Menu only | Forkable live session (see [Forkability policy](#forkability-policy)) | Clones the session's conversation history into a new session and connects to it. Carries an inline **New worktree** checkbox (see below). |
| `Copy link` | Menu only | Live session / team-lead row | Copies an absolute path-style route for the session. |
| `View System Prompt` | Menu only | Live session / team-lead row | Opens the System Prompt Inspector for the session. |
| `Open in new window` | Menu only | Live session / team-lead row | Opens the session's path-style deep link in a new browser window/tab (see [Open in new window](#open-in-new-window-and-middle-click)). |

Archived sessions and unsupported live session kinds do not expose `Refresh agent` or `Fork`. The server also enforces this for both actions so clients cannot bypass UI availability checks.

This table follows the canonical session action order defined in [Unified Session Actions](session-actions.md#built-in-order).

#### Session role controls

The **Create New Session** picker starts on **General** and lists the resolved
roles for the selected project. It does not offer **None**: a newly created
standard session must receive a complete role configuration from its first
spawn, rather than begin with role-less runtime state. Quick-create surfaces
that do not open this picker may omit `roleId`; the server still resolves the
project-scoped `general` role under the same contract.

**Modify Session** remains a separate role-management surface. Its role menu
still offers **None** / **Remove role**, so users can clear a role from an
existing session. Existing role-less sessions also remain role-less and may
continue to display **None**; opening or reloading them does not migrate them to
General. See [REST API — Standard session role resolution](rest-api.md#standard-session-role-resolution)
for the creation-only API semantics and role-mapping boundaries.

#### Refresh agent

`Refresh agent` is a hamburger-only action. It is intentionally not a quick hover button because it restarts the agent process and can interrupt work in progress.

The label is exactly `Refresh agent` when idle. While the request is in flight, the row is rebuilt with `Refreshing agent…`, and the client shows toast feedback for pending, success, and failure states.

Availability is intentionally conservative:

| State | UI behavior | Server behavior |
|---|---|---|
| Live, interactive session | Shows `Refresh agent`. | `POST /api/sessions/:id/restart` may restart it. |
| Inactive but live session | Shows `Refresh agent` on that row. | The explicit REST `:id` targets that exact session, not the currently open chat. |
| `busy`, `streaming`, or `isCompacting` | Shows `Refresh agent`, then asks for confirmation before interrupting. | Requires `{ "force": true }`; otherwise returns `409 SESSION_BUSY`. |
| Archived or terminated | Hidden. | Returns `404 SESSION_NOT_FOUND`. |
| Read-only or non-interactive | Hidden. | Returns `403 SESSION_NOT_RESTARTABLE`. |

On a busy, streaming, or compacting session, selecting the menu item opens a confirmation dialog. Cancel does not call the server. Confirm posts `{ "force": true }`, which lets the server interrupt and respawn the process. Idle refreshes post without force.

The sidebar action uses the REST endpoint because it can target any visible row, including sessions that are not currently open. The older active-chat path still exists: `RemoteAgent.restartAgent()` sends the WebSocket `restart_agent` command on the active session socket. Both paths call the same `SessionManager.restartAgent(sessionId)` implementation, so respawn semantics stay aligned.

A refresh preserves the session identity, transcript/history, persisted session metadata, and attached clients. The manager stops the old process, restores the persisted session through the normal restore path, reattaches existing WebSocket clients, and switches the new process back to the existing transcript file. During restore it rebuilds the session prompt, tool definitions, tool activation, MCP proxy/guard extensions, MCP-backed tool surface, MCP server configuration/auth state, and per-session environment from the current server-side managers and config.

See [REST API — Restart session agent endpoint](rest-api.md#restart-session-agent-endpoint) for the request and error contract.

#### Forkability policy

Forkability is one policy enforced in two places, and they **must agree** — otherwise the UI offers a Fork that the server rejects with `422` (or hides one the server would accept):

- **Client** — `canForkSession()` in `src/app/session-actions.ts` decides whether canonical `Fork` descriptors render in sidebar and header surfaces.
- **Server** — `isUnsupportedForkSource()` in `src/server/server.ts` is the authority; the `POST /api/sessions/:id/fork` handler calls it and returns `422` for unsupported sources.

A live session is forkable **unless** it is one of the genuinely non-forkable kinds:

| Not forkable | Why |
|---|---|
| terminated / archived | No live transcript to clone. |
| read-only / non-interactive | Not an interactive session the user can continue. |
| delegate / child (`isChildSession`) | Owned by a parent turn, not independently forkable. |
| team sessions (`teamGoalId`, `teamLeadSessionId`, `role === "team-lead"`) | Bound to a team's lifecycle. |

Everything else is forkable. In particular, **standard `role: "general"` sessions and `assistant` sessions are forkable** — `role` is *not* a blanket disqualifier. Among role-based sessions only `team-lead` is excluded; the client guard mirrors the server by checking `session.role !== "team-lead"` rather than `!session.role`.

> Historical note: an earlier client guard blocked Fork for *any* session carrying a `role` (`!session.role`). Because normal user-started sessions persist the default `role: "general"`, Fork was wrongly hidden for them even though the server's `isUnsupportedForkSource()` already permitted forking them. Aligning the client check to the server's actual policy (`role !== "team-lead"`) fixed the client/server mismatch.

The `Fork` row has a trailing `New worktree` checkbox (`role="menuitemcheckbox"`, default checked) at its right edge:

- Clicking the checkbox toggles it **without** firing the fork or closing the popover.
- Clicking the rest of the row forks using the current checkbox state.
- `Space` on the highlighted Fork row toggles the checkbox; `Enter` activates the fork. The checkbox is keyboard reachable and never dismisses the menu.
- Checked → `newWorktree: true` (fresh worktree); unchecked → `newWorktree: false` (reuse the source worktree). The default resets to checked each time the menu opens.

### Copy link and toast

Session copy uses the canonical path-style share URL:

```text
${location.origin}/session/<sessionId>
```

The `Copy link` menu item uses the lucide `Link` icon and the same `sessionPathDeepLink(sessionId)` helper as the open-session header. On select, `copySidebarLink` copies the URL and flashes a `Link copied` toast — it does **not** open a modal.

Copying is resilient to insecure contexts:

1. It first calls `navigator.clipboard.writeText`.
2. If the async clipboard API is unavailable or rejects (for example over plain `http://`), it falls back to a hidden `<textarea>` plus `document.execCommand("copy")` so the link still copies.

The toast reuses the app-shell `showHeaderToast` mechanism (`data-testid="header-toast"`), which is rendered in every top-level view. The `CopyLinkFallbackDialog` modal is no longer used by the sidebar copy path.

### Open in new window and middle-click

Bobbit is single-page — clicking a session row swaps the active session in place. `Open in new window` lets the user keep their current session open while viewing another, which is useful for comparing two sessions or watching a team-lead and a delegate side by side.

The `Open in new window` menu item uses the lucide `ExternalLink` icon and is ordered by the canonical session action model. Selecting it opens the session's path-style deep link (`/session/<id>`) in a new browser window/tab through `sessionPathDeepLink(sessionId)`:

- `src/app/session-actions.ts::openSessionInNewWindow(sessionId)` → `openExternalUrl(sessionPathDeepLink(sessionId))`.
- `openExternalUrl(url)` calls `window.open(url, "_blank", "noopener")` and nulls out `opener`, so the popup cannot reach back into the originating window.

A related **middle-click** shortcut is bound anywhere on a session row and uses the same `openSessionInNewWindow(sessionId)` helper. The row root carries an `@auxclick` handler that fires on `event.button === 1`, calls `preventDefault()` / `stopPropagation()` so the row's normal left-click navigation does **not** also run, and then opens the row's path-style deep link. The result is the same user contract: middle-clicking a row opens that session in a new window/tab *without* changing the currently active session in the current window — matching the browser-wide convention that middle-click opens links in the background.

The menu item is supplied by `buildSessionActions()` and adapted by both `buildSessionSidebarActions()` / `buildTeamLeadSidebarActions()` and the open-session header. The middle-click shortcut remains wired on the row roots in `renderSessionRow()` / `renderTeamLeadRow()`, so child/delegate rows that render through `renderSessionRow` get the shortcut too, but all open-new-window entry points share the same exported helper and URL style.

This is intentionally **mouse-only** — there is no keyboard shortcut and no entry in `shortcut-registry.ts`, so the menu label carries no `shortcutHint()`.

### Fork session endpoint

`POST /api/sessions/:id/fork` creates a new session that rehydrates from a clone of the source session's conversation history. Unlike the old duplicate flow, fork copies history — it clones the source `.jsonl` transcript plus its tool-content cache and proposal drafts, then hands the clone to the new session via `switch_session` (the same lossless mechanism as Continue-Archived).

The endpoint preserves the project/task/goal/session configuration:

- project id
- goal id and reattempt goal id
- task id
- assistant type
- staff id, role, accessory, role prompt, and staff pinned memory when applicable
- sandbox setting and allowed tools
- selected model provider/model id

The request body `{ newWorktree?: boolean }` (default `true`) controls the worktree:

- `true` — create a fresh worktree/branch off the project repo (plain project-root session when the project isn't a git repo).
- `false` — reuse the source session's existing worktree path directly, creating no new worktree (two live sessions intentionally share the tree). The fork registers no worktree metadata, so terminating either session never removes the shared worktree. When the source has no worktree, the fork reuses the project-root cwd.

The new title is `Fork: <source title>` (`markGenerated`). Goal-bound forks go through the goal-aware creation path so goal context is preserved; if the source goal is still `todo`, the server advances it to `in-progress`.

The client helper `forkSession(source, { newWorktree })` posts to the endpoint, refreshes the session list, and connects to the returned session id.

## Goal actions

| Action | Placement | Availability | Behavior |
|---|---|---|---|
| `Re-attempt` | Menu only | Goal has no active session | Starts the existing re-attempt flow. Popover-only — it is intentionally not a hover quick button. |
| `Archive` | Quick + menu | Goal is not archived | Runs the existing archive/delete-goal handler. |
| `Goal dashboard` | Quick + menu | Live goal row | Navigates to `#/goal/<goalId>`. |
| `Copy link` | Menu only | Live goal row | Copies an absolute hash route for the goal. |
| `Open on GitHub` | Menu only | Only when the goal-row PR badge is visible | Mirrors the goal-row PR badge — same state-coloured PR/merge icon — and opens the PR `url` in a new tab with `noopener` semantics. |

Goal copy uses the canonical hash route:

```text
${location.origin}${location.pathname}${location.search}#/goal/<goalId>
```

Goal copy behaves exactly like the session copy path above: it copies via `navigator.clipboard.writeText` with the `<textarea>` + `document.execCommand("copy")` fallback and flashes the `Link copied` toast. No modal is shown.

## GitHub link resolution

`Open on GitHub` mirrors the goal-row PR badge — it is shown only in exactly the cases where that badge renders, and it links to the same PR URL.

Client behavior:

1. The menu item is added only when the goal-row PR badge is visible. That badge requires a PR in `state.prStatusCache.get(goal.id)` with a `url`, and — for workflow goals — a fully-passed gate summary (`gs.passed === gs.total` with `gs.total > 0`). The shared `resolveGoalPrBadge` helper decides both the badge and the menu item, so they never diverge.
2. The menu item reuses the goal row's state-coloured PR/merge SVG icon (MERGED `#a87fd4`; CLOSED / CHANGES_REQUESTED `#c47070`; APPROVED / default `#6bc485`; REVIEW_REQUIRED `#d4a04a`).
3. Selecting it opens `pr.url` in a new tab with `noopener` semantics.

The earlier branch-fallback menu item was removed. The browser no longer constructs a branch-only `Open on GitHub` entry; if no PR badge is showing, the item simply isn't present.

The `GET /api/goals/:id/github-link` endpoint still exists (it returns a PR URL or a sanitized GitHub branch fallback, resolved through `execFile` argument arrays with no shell interpolation of branch names), but it no longer gates this menu item. The server-side resolution is documented below and in [REST API](rest-api.md#goal-github-link-endpoint).

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

The sidebar source set is deliberately quick-action-only for both session and goal rows. Header session actions use a separate capture path because their direct buttons can include non-quick actions at constrained desktop widths; see [Unified Session Actions — Header shared-element animation](session-actions.md#header-shared-element-animation). Do not broaden sidebar source capture when changing header behavior.

Closing runs the reverse animation when the source and target rects are still available. If layout/route changes removed the source row, close falls back to a fade-only path. All animations are cancelable and are cleaned up on close and `disconnectedCallback`.

When `prefers-reduced-motion: reduce` matches, FLIP and slide animations are skipped. Focus, dismissal, and action behavior remain identical.

## Tests to run

For changes to this feature, run the focused coverage first:

```bash
npx tsx --import ./tests/helpers/css-stub-loader.mjs --test --test-force-exit tests/sidebar-actions-flip.test.ts
npm run test:e2e -- tests/e2e/sidebar-actions-server.spec.ts tests/e2e/session-restart-api.spec.ts tests/e2e/ui/sidebar-actions-menu.spec.ts tests/e2e/ui/sidebar-refresh-agent.spec.ts tests/e2e/ui/session-actions.spec.ts tests/e2e/ui/copy-session-link.spec.ts tests/e2e/ui/open-session-new-window.spec.ts
```

Then run the broader validation expected for UI + server changes:

```bash
npm run check
npm run test:unit
npm run test:e2e
```

The focused browser suite covers desktop hover/focus hamburger visibility, direct quick-action regressions, menu contents, sidebar/header canonical action parity, copy success and the insecure-context `execCommand` fallback (both flashing the toast with no modal), path-style copied/opened session links, hash-route canonicalization, `Refresh agent` visibility/targeting/feedback/busy confirmation, fork navigation with the New worktree checkbox toggle (toggling without firing/closing, and posting the chosen `newWorktree` value), `Open in new window` and the middle-click row shortcut opening a session deep link via a stubbed `window.open` without swapping the active session, `Open on GitHub` mirroring the PR badge (shown with the coloured icon when the badge is visible, hidden for gated/no-PR goals), flip-above near the bottom viewport edge, dismissal cleanup, reduced motion, mobile sidebar-row hamburger suppression, and mobile open-session header hamburger coverage. The server-coupled fork behavior is covered by `tests/e2e/sidebar-actions-server.spec.ts`; the restart REST contract is covered by `tests/e2e/session-restart-api.spec.ts`.
