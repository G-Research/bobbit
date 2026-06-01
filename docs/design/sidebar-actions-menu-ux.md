# Sidebar Actions Menu UX

> Superseded by design-doc Revision 2.1 — see docs/sidebar-actions-menu.md for the authoritative shipped behavior.

## Decision summary

Add a unified row actions menu without removing the current fast path:

- Desktop keeps the existing hover strip exactly where it is today, then appends a right-most hamburger trigger.
- Mobile suppresses the hamburger in v1 because the inline action buttons are already always visible; adding another target would duplicate choices in the narrowest surface.
- The popover is a compact menu anchored to the hamburger and modeled after `ProjectPickerPopover`: light-DOM Lit component, `data-popover-open` while mounted/open, document-level outside-click/Escape listeners, focus restoration to the trigger.
- Existing hover actions remain directly clickable and use the same handlers as before. The hamburger is additive discovery, not a replacement.
- Existing hover icons visually “move into” the menu with a FLIP/shared-element animation; menu-only actions fade/slide in.

## Desktop row composition

### Session row

Current hover strip order remains:

1. Modify / Edit staff
2. Terminate / End team
3. Actions menu hamburger

The hamburger is the right-most button. It uses the same square button footprint as the other hover icons, with `aria-haspopup="menu"`, `aria-expanded`, and label `Session actions`.

Recommended desktop visual treatment:

- Keep the current gradient shield over the row timestamp.
- Use `gap: 0` between icon buttons to preserve today’s density.
- Hamburger uses neutral hover treatment, not destructive styling.
- If the row is active, hover strip still appears over the active background with the same gradient behavior.

Session menu rows:

| Row | Availability | Source |
|---|---|---|
| Modify | Live non-staff session | Existing pencil handler |
| Edit staff | Live staff-backed session | Existing staff edit route handler |
| Terminate | Live non-team-lead session | Existing terminate handler |
| End team | Live team lead | Existing team termination handler |
| Copy link | All live sessions | New clipboard action |
| Fork | Standalone live sessions only, per `canForkSidebarSession` | New fork action |

`Fork` is offered **only on standalone session rows** and only when `canForkSidebarSession(session)` is true — not terminated, not archived, not read-only, not non-interactive, not a child session, no role, and not part of a team (`!teamGoalId && !teamLeadSessionId`). It is therefore not present on team-lead rows, delegate/child rows, or team-member rows. The server independently rejects unsupported sources with `422`, so the client availability rule and the server guard agree.

The Fork menu row carries an inline `role="menuitemcheckbox"` **"New worktree"** control at its right edge, default checked. Clicking the checkbox toggles it **without** firing Fork or closing the popover (Space toggles when the row is highlighted); activating the rest of the row forks using the current checkbox state. Fork is popover-only (`quick: false`).

For archived sessions, v1 does not add the hamburger unless implementation finds it trivial. If added, only include `Copy link` and any existing safe archived action; never expose terminate or fork.

### Goal row

Current hover strip order remains (Re-attempt is intentionally **not** a hover quick action — it is popover-only, `quick: false`):

1. Archive, when `!goal.archived`
2. Goal dashboard
3. Actions menu hamburger

Goal menu rows:

| Row | Availability | Source |
|---|---|---|
| Re-attempt | `!hasActiveSession`; popover-only (`quick: false`) | Existing re-attempt handler (`startReattempt(goal.id)`) |
| Archive | `!goal.archived` | Existing archive handler |
| Goal dashboard | Always | Existing dashboard route handler |
| Copy link | Always | New clipboard action |
| Open on GitHub | Only when the goal-row PR badge is visible | New external-link action |

`Open on GitHub` is shown **only when the goal-row PR badge is visible** — a PR exists in `state.prStatusCache` and, for workflow goals, the gate summary is fully passed (`gs.passed === gs.total`, `gs.total > 0`) — and a `pr.url` is present. It uses the same state-coloured PR/merge icon as the goal row (shared `resolveGoalPrBadge` helper) and opens `pr.url`. There is no client-visible branch-fallback menu item.

For archived goals, v1 may omit the hamburger. If included, menu should contain `Goal dashboard`, `Copy link`, and `Open on GitHub` when the PR badge shows; never show `Archive`.

## Menu layout

Use a single component, conceptually `<sidebar-actions-popover>`.

Structure:

- Container: `role="menu"`, labelled by the hamburger trigger.
- Row: `button role="menuitem"`, icon slot, label, optional secondary hint.
- Minimum row height: about `2.25em`; horizontal padding about `0.75em`.
- Font: inherit from sidebar and size in `em`, so `--sidebar-font-scale` continues to scale the menu.
- Width: compact but label-safe, about `14rem` with a max of available viewport width.
- Destructive rows retain destructive hover/icon color only for `Terminate`, `End team`, and `Archive`.
- Menu-only rows (`Copy link`, `Open on GitHub`, `Fork`, and popover-only `Re-attempt`) appear after the existing hover-strip actions so users first recognize what moved.

Row text:

- Prefer verbs users already saw in tooltips: `Modify`, `Edit staff`, `Terminate`, `End team`, `Re-attempt`, `Archive`, `Goal dashboard`.
- New action labels: `Copy link`, `Open on GitHub`, `Fork`.
- Avoid ellipses unless an action always opens a follow-up dialog.

## Clipboard and URL decisions

Use canonical hash routes because `src/app/routing.ts` maps:

- Session: `#/session/<id>`
- Goal dashboard: `#/goal/<id>`

Copy the absolute URL so it works outside the current tab:

```ts
const url = `${location.origin}${location.pathname}#/session/${session.id}`;
const goalUrl = `${location.origin}${location.pathname}#/goal/${goal.id}`;
```

Action behavior:

1. Try `navigator.clipboard.writeText(url)`.
2. On rejection (e.g. insecure `http://` context), fall back to a legacy `<textarea>` + `document.execCommand("copy")` path so the link still copies.
3. Flash a `Link copied` toast via the same `showHeaderToast` mechanism the session header uses (`data-testid="header-toast"`; a standalone toast is mounted when no session header is present).

The sidebar copy path does **not** use the `CopyLinkFallbackDialog` modal. The copy-link menu icon is the lucide `Link` icon (matching the session header's copy affordance), not a copy icon.

## Open on GitHub decision

`Open on GitHub` mirrors the goal-row PR badge — it is shown **only when the badge is visible**:

1. A PR exists in `state.prStatusCache.get(goal.id)` with a `pr.url`.
2. For workflow goals, the gate summary is fully passed (`gs.passed === gs.total`, `gs.total > 0`).
3. Otherwise the row is hidden.

It uses the **same state-coloured PR/merge SVG** as the goal row via the shared `resolveGoalPrBadge` helper (MERGED `#a87fd4`, CLOSED/CHANGES_REQUESTED `#c47070`, APPROVED/default `#6bc485`, REVIEW_REQUIRED `#d4a04a`) and opens `pr.url` in a new tab with `noopener` semantics. There is **no** client-visible branch-fallback menu item. The `GET /api/goals/:id/github-link` endpoint (server-side, `execFile`-based, sanitized) still exists but no longer gates this menu item.

## Fork session decision

The session menu action is **Fork** (id `fork`), not "Duplicate session". It clones the source session's conversation history — like the archived **Continue** flow — copying the `.jsonl` transcript plus the tool-content and proposal dirs, and spawns the new session with `preExistingAgentSessionFile`. The new title is `Fork: <source title>` (never "Copy of"); the source is never mutated.

UX behavior:

1. Activating the Fork row (anywhere except the inline checkbox) forks using the current "New worktree" state, closes the menu, and connects to the new session.
2. Clicking the inline `role="menuitemcheckbox"` "New worktree" control toggles it **without** firing Fork or closing the popover (Space toggles when the row is highlighted). It defaults to checked.
3. On failure, show a toast with a short reason.

Endpoint:

```http
POST /api/sessions/:id/fork
```

Request body `{ newWorktree?: boolean }`, default `true`:

- `true` → create a fresh worktree/branch (or a plain project-root session when the project is not a git repo).
- `false` → **reuse the source session's existing worktree** (new session `cwd` = source `worktreePath`, same repo/branch; no new worktree registered — the two live sessions intentionally share the tree).

The fork preserves `projectId`, `cwd`, `goalId`, `assistantType`, `staffId`, `role`, `accessory`, `sandboxed`, `modelProvider`/`modelId`, `reattemptGoalId`, and `taskId`. The server rejects unsupported sources (archived/terminated/delegate/first-class-child/read-only/team/team-lead) with `422`, matching the client `canForkSidebarSession` availability rule.

## Shared-element / FLIP animation

### Intent

The animation teaches that the menu contains the same actions users already know. It should feel like the hover strip opens into a labelled list, not like a second unrelated control.

### Open sequence

1. On hamburger pointer/keyboard activation, collect the hover-strip action elements before mounting the popover:
   - stable action id: `modify`, `terminate` (session/team-lead), `archive`, `dashboard` (goal) — i.e. only `quick: true` actions. `reattempt` is popover-only and is not part of the shared-element FLIP.
   - icon node or button bounding rect via `getBoundingClientRect()`
2. Mount the popover with final menu rows rendered.
3. After render, collect final icon rects inside matching menu rows.
4. For each matching action:
   - create a temporary floating clone of the icon at the start rect, fixed-positioned in the viewport.
   - hide or visually reserve the final icon until the animation finishes.
   - animate clone transform from start rect to final rect using translate/scale.
5. Fade/slide the popover container from slightly offset and transparent to settled.
6. Fade/slide menu-only rows in after a short delay so they appear as additions.
7. Remove clones and unhide final icons at completion.

Recommended timing:

- Container: 120–160 ms ease-out.
- Shared icons: 170–220 ms `cubic-bezier(.2,.8,.2,1)`.
- Menu-only rows: 100–140 ms, delayed 40–70 ms.

### Reverse / close sequence

Close is animated when dismissed by hamburger toggle, outside click, Escape, route change, or item selection.

1. Mark popover as closing but keep it mounted.
2. Capture current menu icon rects.
3. Capture destination hover-strip rects if the source row still exists and the viewport is desktop.
4. Animate matching clones from menu icon rects back to strip rects.
5. Fade/slide the container out.
6. If the source row no longer exists, the route changed, or layout changed too much, skip reverse FLIP and just fade out.
7. Unmount only after animations settle or are canceled.

### Interruptibility

- Store an `AbortController` or monotonically increasing animation token per popover open.
- Any new open/close request cancels existing animations, removes floating clones, clears hidden-icon styles, and proceeds from the current DOM state.
- Clicking the hamburger while opening reverses to close; clicking it while closing reopens from a fresh measurement pass.
- Never leave clones in `document.body`; cleanup runs in `finally` and `disconnectedCallback`.

### Reduced motion

If `matchMedia("(prefers-reduced-motion: reduce)").matches`:

- Do not create floating clones.
- Do not translate icons.
- Open/close with a simple opacity change of 80–100 ms, or no animation if implementation simplicity wins.
- Menu-only rows appear immediately.
- Keyboard focus behavior is identical to full-motion mode.

## Anchoring and flipping

Use the hamburger as `anchorEl`.

Desktop placement:

- Primary: below the trigger, right-aligned to the trigger’s right edge.
- Offset: `4px` below the row.
- Horizontal collision: clamp to `8px` viewport padding.
- Vertical collision: if `anchor.bottom + menuHeight + 8 > viewportHeight`, place above the row using `anchor.top - menuHeight - 4`.
- If neither above nor below fully fits, choose the side with more space and constrain `max-height` with internal scrolling.

Implementation detail: measure the popover after first render with visibility hidden or an offscreen initial style, compute final position, then reveal/animate. This avoids a visible jump.

## Dismissal

Dismiss on:

- Outside pointer down, including another sidebar row.
- Escape.
- Route/hash change.
- Selecting an enabled menu row.
- Clicking the hamburger trigger again.
- Sidebar collapse/unmount.

Do not dismiss when pointer-down occurs inside the popover or on the anchor during the same toggle event. Stop propagation from menu rows so row navigation does not fire behind the menu.

Focus restoration:

- On close without navigation, return focus to the hamburger.
- On item selection that opens a dialog, let the dialog own focus.
- On route change/session connection, do not force focus back to an unmounted trigger.

## Keyboard navigation

Trigger:

- `Tab` reaches the hamburger like the other row buttons.
- `Enter` or `Space` opens/closes the menu.
- `ArrowDown` from the focused trigger opens the menu and focuses the first enabled item.
- `ArrowUp` from the focused trigger opens the menu and focuses the last enabled item.

Menu:

- Roving focus among enabled `menuitem` buttons.
- `ArrowDown` / `ArrowUp` wraps.
- `Home` / `End` jump to first/last enabled item.
- `Enter` / `Space` invokes the focused item.
- `Escape` closes and restores focus to trigger.
- `Tab` closes and lets normal browser tab order continue; do not trap focus because this is a popover menu, not a modal dialog.

Interaction with sidebar keyboard nav:

- While the menu is open, document-level sidebar shortcuts should no-op via existing modal/popover detection. The popover must expose `[data-popover-open]` only while open/closing.
- Menu arrow keys call `preventDefault()` and `stopPropagation()` so they do not trigger sidebar row navigation.

## Mobile decision

Suppress the hamburger on mobile in v1.

Rationale:

- Mobile rows already show inline actions persistently, so the discovery problem is desktop-specific.
- Adding a hamburger would create redundant targets and increase accidental taps in a dense row.
- Copy link / Fork / GitHub are intentionally desktop-only in v1 and should be covered by a mobile acceptance test so this is not mistaken for a regression.

Mobile acceptance criteria for this goal:

- Below 640 px, no hamburger trigger is rendered.
- Existing inline quick actions remain visible and directly clickable.
- Menu-only actions are not exposed on mobile in v1.

If product later needs parity, use a bottom sheet instead of an anchored popover below 640 px. The sheet should list the same rows with larger touch targets and no FLIP animation.

## Accessibility checklist

- Hamburger has `aria-label`, `aria-haspopup="menu"`, and live `aria-expanded`.
- Popover has `role="menu"`; rows have `role="menuitem"`.
- Icon-only hover buttons keep existing `title` and must also gain `aria-label` where missing.
- Visible focus ring uses existing focus/ring tokens.
- Destructive actions are not conveyed by color alone: label text is explicit.
- Menu width and row heights scale with the sidebar font scale through inherited/em sizing.
- Reduced motion path is equivalent, not feature-reduced.

## Prototype

See [`sidebar-actions-menu-prototype.html`](./sidebar-actions-menu-prototype.html) for an interactive mock showing:

- Hover strip with right-most hamburger.
- Anchored popover for session and goal rows.
- FLIP-style icon movement into the menu.
- Reverse animation on close.
- Reduced-motion toggle.
- Keyboard operation for trigger and menu rows.
