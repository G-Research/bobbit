# Unified Session Actions

Unified session actions keep every per-session command behind one canonical model so the sidebar row menu, the open-session desktop header, and the open-session mobile header do not drift. The sidebar action set is the baseline, and the header renders the same descriptors both as direct buttons and through the same hamburger popover component.

This feature sits in the browser app shell. Canonicalizing the pre-existing session actions does not change their REST semantics; those actions call the established session, staff, routing, clipboard, prompt-inspector, refresh, fork, window-opening, and pack launcher helpers. Historic prompt actions extend the existing fork endpoint with a durable `entryId` so the server can apply a transcript boundary.

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

## Live built-in order

Actions are sorted by `priority`. The live-session canonical order is:

1. `modify` — `Modify` or `Edit staff`
2. `terminate` — `Terminate` or `End team`
3. `refresh-agent`
4. `fork`
5. `copy-link`
6. `view-system-prompt`
7. `open-new-window`

Staff and team-lead labels are derived in `buildSessionActions()` so all surfaces show the same wording. Team leads use `End team` and hide `fork`; staff-backed sessions use `Edit staff` and route to staff settings.

## Archived session actions

Archived sessions use `buildArchivedSessionActions()` instead of `buildSessionActions()`. This keeps read-only archived contexts on a separate built-in-only descriptor source: active-session controls and pack-provided `session-menu` launchers are never appended to archived menus.

Archived actions appear in the same two places users already look for live session commands:

- **Archived sidebar rows** — `renderArchivedSessionRow()` renders the `Session actions` hamburger on archived rows, including nested archived delegate rows. On desktop the trigger appears in the row action cluster; on mobile/touch it remains visible with the row metadata. The trigger and menu handlers prevent default activation and stop propagation so clicking the hamburger does not open or select the archived row.
- **Open archived session header** — `renderHeaderSessionActions()` switches to archived descriptors when the open session is archived/read-only. Desktop and mobile both expose the `Session actions` hamburger in the top-right session action area. The archived header forces the overflow trigger to stay available, so the full archived-safe menu is reachable even when desktop direct action shortcuts are also visible.

Archived menus contain only these built-in actions, in this order:

1. `continue-archived` — `Continue in new session`, hidden unless the session is eligible.
2. `copy-link` — `Copy link` for the path-style `/session/<sessionId>` URL.
3. `view-system-prompt` — `View system prompt` for the archived session id.
4. `open-new-window` — `Open in new window` using the same path-style session URL.

`Continue in new session` uses `canContinueArchivedSession()` for client-side visibility. It is shown only for archived/read-only sources that are not goal sessions, delegates, child/delegate rows, team sessions, team leads, or non-interactive sessions, and whose `projectId` still resolves to a registered project. The client applies those common archived/project checks and Pi transcript fields (`agentSessionFile` when supplied, and `transcriptAvailable` not `false`); it cannot validate an opaque SDK identity or source. Ineligible sessions hide Continue rather than rendering a disabled item, while the other read-only actions remain available.

Running Continue opens the confirm-only `ContinueSessionChooser`, then posts an empty JSON body to `POST /api/sessions/:id/continue`. After confirmation, the server validates an SDK source's tuple and UUID, then its official source: invalid metadata returns `422 RUNTIME_CONTINUE_UNSUPPORTED`, and an unavailable source returns the opaque `503 SDK_SESSION_UNAVAILABLE` category. Only after that preflight does SDK Continue create a fresh Bobbit wrapper around the same opaque UUID. The action intentionally does **not** call the live `/api/sessions/:id/fork` endpoint: Pi Continue clones the archived `.jsonl` transcript into a fresh session slot and rehydrates through `switch_session`. See [REST API — Continue-Archived endpoint](rest-api.md#continue-archived-endpoint), [Internals — Continue-Archived sessions](internals.md#continue-archived-sessions), and [Claude Agent SDK sessions](claude-agent-sdk-sessions.md).

Archived menus deliberately exclude:

- `Modify`, `Edit staff`, and rename-style actions.
- `Terminate` / `End team`.
- `Refresh agent`.
- Live `Fork`.
- Extension-provided `session-menu` launchers.
- Any destructive, project-mutating, or live-runtime control action.

The exclusion is intentional. Archived sessions are read-only records; their old worktree, sandbox, process, branch, or goal/team state may no longer exist or may be unsafe to mutate. Extension launchers are also live-session entrypoints: they run pack code against a bound active session context and may spawn agents or mutate pack/runtime state. Keeping archived menus built-in-only prevents those live capabilities from leaking into archived records while preserving safe navigation, inspection, and lossless continuation.

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

## Historic prompt actions

Historic prompt actions apply the session Fork lifecycle at a durable transcript boundary instead of cloning the entire conversation. They live on message rows rather than in `buildSessionActions()`, but they mount the same `SidebarActionsPopover` used by session headers and sidebar rows. Reusing that component keeps row sizing, icons, typography, hover/focus states, positioning, focus movement, trailing-toggle behavior, dismissal, and reduced-motion handling aligned across desktop and mobile.

### Eligible prompt rows

An eligible prompt has one compact, always-visible `Actions for prompt` overflow button beside the user bubble on both desktop and mobile. There is no hover-only desktop action and no long-press alternative.

The browser fails closed unless all of these are true:

- the source passes the same live-fork rules as session-level Fork: live, interactive, writable, and not archived, terminated, delegated/child, or team-owned;
- the row is an ordinary accountable `user` or `user-with-attachments` prompt, not an assistant or tool-result-only row;
- the row is settled server data rather than synthetic, optimistic, permission, or pending UI state;
- it carries a bounded `entryId` with Bobbit's `_entryIdSource: "pi-transcript"` provenance.

Older durable prompts remain actionable while a later optimistic or in-flight prompt is present. At `agent_start`, Bobbit refreshes the authoritative transcript cursor projection so the current row becomes eligible during the turn. A final refresh remains as a fallback if persistence lags. The server repeats source, cursor, user-role, and active-branch validation; browser provenance never grants authority by itself.

### Menu and keyboard behavior

The prompt menu has exactly two rows, in order:

1. **Fork before this point**, with the explanation in the row tooltip and a trailing **New worktree** toggle.
2. **Copy prompt**.

`MessageList` owns at most one prompt menu and body-mounts the canonical popover against the row trigger. Opening another row replaces the previous menu. Escape and outside-pointer dismissal restore trigger focus; Tab and route changes dismiss through the existing popover behavior. Arrow keys, Home/End, Enter/Space, responsive viewport clamping, and pointer/touch handling are inherited from the shared component.

The **Fork before this point** row tooltip says exactly:

> The new session will include the conversation up to, but not including, this prompt.

Hover or focus reveals the explanation. Click/tap, Enter, or Space pins/toggles it so the same content is available on touch and by keyboard. Interacting with help neither selects Fork, changes the worktree toggle, nor dismisses the menu.

### History worktree toggle

The prompt menu's **New worktree** toggle is independent of the session-level Fork toggle:

- it resets to off every time a prompt menu opens;
- off means borrow the source session's exact live cwd/worktree and branch;
- on means use the established fresh worktree/branch lifecycle;
- click/tap or keyboard activation updates `aria-checked` and the accessible on/off label without selecting Fork or closing the menu;
- selecting the Fork row sends the current value with the durable prompt cursor.

Borrowing is intentionally different from owning. The new session is writable but receives no worktree teardown coordinates and is marked as a borrower, so its termination or recovery cannot remove, repair, or recreate the shared tree. For sandbox reuse, ownership is flattened to the final non-borrowing session so a fork of a borrower cannot become a teardown authority. No reset, cleanup, stash, registration, or source-agent unwind occurs. See [REST API — Fork session endpoint](rest-api.md#fork-session-endpoint) for the authoritative boundary and serialized lifecycle contract.

### Copy prompt

**Copy prompt** captures the row's original user-visible text when the menu opens; it never copies rendered DOM text. String content is copied unchanged, while structured content contributes only text blocks in source order. This preserves line breaks and the typed `/skill` and `@path` forms restored by transcript projection while excluding model-expanded skill/file content, private author prefixes, author chrome, attachment data and filenames, timestamps, and action labels.

Attachment prompts therefore copy only their textual prompt. A textless attachment prompt still permits Fork when it has a valid cursor, but Copy reports failure rather than copying attachment metadata. Clipboard success shows `Prompt copied`; unavailable or rejected clipboard writes show `Couldn't copy prompt`.

### Fork request, feedback, and navigation

Selecting **Fork before this point** sends only `{ entryId, newWorktree }` to the existing `POST /api/sessions/:id/fork` endpoint. It never sends a rendered message array/index and never prefills or resends the selected prompt. Prompt controls are disabled while the local/global session-creation guard is active, and the server independently reserves identical in-flight history requests.

On success, the initiating client refreshes sessions and connects to the returned session as an existing session so retained history is fetched before navigation settles. Other clients remain on the live source. The destination ends immediately before the selected prompt; the source stays listed and unchanged. On validation, clipboard, launch, or connection failure, the initiating client stays on the source and shows the existing toast or connection-error feedback.

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

- `tests2/dom/prompt-history-actions.test.ts` — durable-row eligibility, desktop/mobile parity, canonical menu behavior, help/toggle accessibility, exact prompt copy, clipboard feedback, focus, dismissal, and duplicate suppression.
- `tests2/integration/history-fork-api.test.ts` and `tests2/core/history-fork-transcript.test.ts` — authoritative cursor validation, exact cut, source immutability, context/sidecar filtering, worktree ownership, failure cleanup, and concurrent reservations.
- `tests2/browser/journeys/history-fork-prompt-actions.journey.spec.ts` — desktop/touch prompt actions, help/copy/error feedback, both worktree modes, reload, source preservation, and destination transcript boundary.
- `tests/e2e/ui/session-actions.spec.ts` — canonical id parity/order, staff/team labels and visibility, desktop and mobile header hamburgers opening the full action list, FLIP sources for all visible direct header buttons, hidden/non-interactive direct buttons while open, restoration on close, Fork toggle accessibility, and header action reachability.
- `tests/e2e/ui/archived-session-actions.spec.ts` — archived sidebar and header menus on desktop/mobile, eligible and ineligible Continue visibility, exclusion of live/destructive/launcher actions, copy link, open-in-new-window, and row-selection preservation.
- `tests/e2e/ui/copy-session-link.spec.ts` — path-style copy URL, direct `/session/<id>` load, hash canonicalization, reload behavior, and hash precedence.
- `tests/e2e/ui/open-session-new-window.spec.ts` — path-style open-in-new-window behavior and middle-click no-navigation regression coverage.
- `tests/ui-fixtures/sidebar-actions-menu-fixture.spec.ts` — sidebar menu ordering/title contract in a fast browser fixture.
- `tests/sidebar-actions-flip.test.ts` — popover FLIP layout helper unit coverage.

For session-action UI work, run the focused browser specs above plus `npm run check` and `npm run test:unit` before broader E2E validation.
