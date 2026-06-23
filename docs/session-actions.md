# Unified Session Actions

Unified session actions keep every per-session command behind one canonical model so the sidebar row menu, the open-session desktop header, and the open-session mobile header do not drift. The sidebar action set is the baseline, and the header renders the same descriptors both as direct buttons and through the same hamburger popover component.

This feature sits in the browser app shell. It does not change session REST semantics; actions call the existing session, staff, routing, clipboard, prompt-inspector, refresh, fork, window-opening, and pack launcher helpers.

## Canonical model

`src/app/session-actions.ts` owns the canonical session action descriptors. Surfaces should call `buildSessionActions()` and adapt the returned descriptors to their own DOM instead of rebuilding labels, visibility, icons, or handlers.

The descriptor is intentionally small and renderer-agnostic:

- `id` — stable action id, used by tests and future contribution plumbing.
- `label` / `title` — user-facing text and tooltip text.
- `icon` — render hint for the current Lit UI.
- `priority` — canonical ordering.
- `tone` — default or danger styling.
- `quick` — whether the action may appear as an always-nearby quick button.
- `visible` — optional availability gate.
- `run(event)` — action handler.
- `trailingToggle` — optional control rendered at the row edge, currently used by Fork.

`SessionActionId` covers the built-ins, but descriptors allow string ids so extension-contributed session actions can flow through the same builder/adapter path. Pack `session-menu` launchers also flow through this shared model, so extension launch actions render consistently in the sidebar row menu and chat header menu instead of adding surface-specific buttons. Built-ins keep the priority order below; contributed actions are appended by their descriptor priority.

## Built-in order

Actions are sorted by `priority`. The canonical order is:

1. `modify` — `Modify` or `Edit staff`
2. `terminate` — `Terminate` or `End team`
3. `refresh-agent`
4. `fork`
5. `copy-link`
6. `view-system-prompt`
7. `open-new-window`

Staff and team-lead labels are derived in `buildSessionActions()` so all surfaces show the same wording. Team leads use `End team` and hide `fork`; staff-backed sessions use `Edit staff` and route to staff settings.

## Surface behavior

### Sidebar rows

`src/app/render-helpers.ts` adapts `buildSessionActions()` into `SidebarActionItem`s. Quick actions remain as row buttons for actions marked `quick`, while the hamburger menu exposes the full canonical set for desktop session rows.

The sidebar still uses `SidebarActionsPopover` for positioning, roving keyboard focus, dismissal, and the Fork trailing toggle. Opening a session-row menu resets Fork's `New worktree` toggle to checked so repeated menu opens start from the safe default.

### Desktop open-session header

`src/app/render.ts` builds the same canonical descriptors for the active session. On desktop it renders the highest-priority actions directly, then shows a `Session actions` hamburger when the header width budget leaves any remaining actions for the popover.

Direct buttons are chosen from the start of the canonical order. Actions with trailing controls, such as Fork, are kept in the popover so their control can be rendered and operated consistently.

The responsive direct-action limit is width based:

- `< 760px` — one direct action, but this path is normally superseded by mobile rendering.
- `< 980px` — two direct actions.
- `< 1180px` — three direct actions.
- `>= 1180px` — four direct actions.

The hamburger does **not** open only the overflow subset. It opens a `SidebarActionsPopover` populated with the complete canonical session action list in priority order, including any direct buttons that were already visible and any pack-contributed `session-menu` actions. This keeps the hamburger as the full command menu while the direct buttons remain shortcuts.

### Mobile open-session header

Mobile session view keeps the back button and truncated session title visible, renders the quick session actions as icon-only direct buttons, and exposes a `Session actions` hamburger button on the right.

Opening that menu shows the full canonical session action set for the active session, including actions that are not practical as separate mobile header buttons. The visible quick buttons are still part of the header DOM so they can participate in shared-element animation. This is distinct from mobile sidebar/landing rows, where the sidebar hamburger remains suppressed.

## Header shared-element animation

The header hamburger uses the same `SidebarActionsPopover` component and FLIP helper pipeline as sidebar menus, but with a header-specific source capture:

1. Before opening, the header captures every currently visible direct header action button for the active session, not just actions marked `quick`.
2. The popover mounts with the complete canonical action list.
3. Matching source buttons animate into the icon position of their popover rows by stable action id.
4. While the popover is open, the source buttons stay mounted but are hidden from view, pointer interaction, and keyboard focus so the FLIP source geometry remains stable without leaving duplicate interactive controls.
5. Closing the popover restores the direct buttons appropriate for the current viewport. When source and target rects are still available, the popover can run the reverse close animation; otherwise it falls back to normal cleanup.

This is intentionally broader than sidebar row capture. Sidebar session and goal menus remain quick-action-source driven: only `[data-sidebar-action-quick="true"]` row buttons should be captured as sidebar FLIP sources. Do not broaden sidebar capture to all menu rows to match the header; the header uses its own capture path because constrained desktop headers can show direct non-quick actions such as `Refresh agent`.

Reduced-motion handling is owned by `SidebarActionsPopover`: when `prefers-reduced-motion: reduce` matches, shared-element and slide animations are skipped while focus, dismissal, and action behavior stay the same.

## Fork trailing toggle

Fork carries a trailing `New worktree` toggle through `trailingToggle`:

- The default is checked each time a session actions menu opens.
- Clicking or keyboard-activating the toggle flips it without running Fork and without closing the popover.
- Running the Fork row posts the current value as `{ newWorktree: true | false }`.
- Checked means create a fresh worktree; unchecked means reuse the source worktree.

The popover renders the toggle with `role="menuitemcheckbox"` and `aria-checked`. Tests cover focus, `Space`/`Enter` behavior on the toggle, and that toggling does not fire the Fork request.

## Session links and routing

Session `Copy link`, canonical `Open in new window`, and session-row middle-click actions use path-style URLs:

```text
/session/<sessionId>
```

`sessionPathDeepLink(sessionId)` returns an absolute URL in the browser, for example:

```text
https://localhost:3001/session/abc123
```

The server's SPA fallback serves the app shell for `/session/<id>`. On load, `routing.ts` parses the path as a session route. Once the client has switched into the session, the route is canonicalized back to the internal hash form:

```text
/#/session/<sessionId>
```

Hash routes remain the internal navigation format used by `setHashRoute()`. If a URL contains both a path-style session id and a conflicting hash session route, the hash route wins and the client does not canonicalize to the path id.

Goal links still use hash routes (`/#/goal/<goalId>`). The path-style behavior described here is specific to copied/opened session links.

## Verification coverage

Relevant coverage lives in:

- `tests/e2e/ui/session-actions.spec.ts` — canonical id parity/order, staff/team labels and visibility, desktop and mobile header hamburgers opening the full action list, FLIP sources for all visible direct header buttons, hidden/non-interactive direct buttons while open, restoration on close, Fork toggle accessibility, and header action reachability.
- `tests/e2e/ui/copy-session-link.spec.ts` — path-style copy URL, direct `/session/<id>` load, hash canonicalization, reload behavior, and hash precedence.
- `tests/e2e/ui/open-session-new-window.spec.ts` — path-style open-in-new-window behavior and middle-click no-navigation regression coverage.
- `tests/ui-fixtures/sidebar-actions-menu-fixture.spec.ts` — sidebar menu ordering/title contract in a fast browser fixture.
- `tests/sidebar-actions-flip.test.ts` — popover FLIP layout helper unit coverage.

For session-action UI work, run the focused browser specs above plus `npm run check` and `npm run test:unit` before broader E2E validation.
