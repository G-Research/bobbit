# Sidebar Actions Menu UX

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
| Duplicate session | Live non-archived sessions | New duplicate action |

For archived sessions, v1 does not add the hamburger unless implementation finds it trivial. If added, only include `Copy link` and any existing safe archived action; do not expose terminate/duplicate.

### Goal row

Current hover strip order remains:

1. Re-attempt, when `!hasActiveSession`
2. Archive, when `!goal.archived`
3. Goal dashboard
4. Actions menu hamburger

Goal menu rows:

| Row | Availability | Source |
|---|---|---|
| Re-attempt | `!hasActiveSession` | Existing re-attempt handler |
| Archive | `!goal.archived` | Existing archive handler |
| Goal dashboard | Always | Existing dashboard route handler |
| Copy link | Always | New clipboard action |
| Open on GitHub | Only when a GitHub URL can be resolved | New external-link action |

For archived goals, v1 may omit the hamburger. If included, menu should contain `Goal dashboard`, `Copy link`, and `Open on GitHub` when resolvable; never show `Archive`.

## Menu layout

Use a single component, conceptually `<sidebar-actions-popover>`.

Structure:

- Container: `role="menu"`, labelled by the hamburger trigger.
- Row: `button role="menuitem"`, icon slot, label, optional secondary hint.
- Minimum row height: about `2.25em`; horizontal padding about `0.75em`.
- Font: inherit from sidebar and size in `em`, so `--sidebar-font-scale` continues to scale the menu.
- Width: compact but label-safe, about `14rem` with a max of available viewport width.
- Destructive rows retain destructive hover/icon color only for `Terminate`, `End team`, and `Archive`.
- Menu-only rows (`Copy link`, `Open on GitHub`, `Duplicate session`) appear after the existing hover-strip actions so users first recognize what moved.

Row text:

- Prefer verbs users already saw in tooltips: `Modify`, `Edit staff`, `Terminate`, `End team`, `Re-attempt`, `Archive`, `Goal dashboard`.
- New action labels: `Copy link`, `Open on GitHub`, `Duplicate session`.
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
2. On success, show the existing header toast: `Link copied`.
3. On rejection, lazy-load and show `CopyLinkFallbackDialog.show(url)`.

The existing fallback dialog title says “Copy session link”; implementation should either make the title generic or accept a label parameter before using it for goals.

## Open on GitHub decision

Resolve target in this order:

1. If `state.prStatusCache.get(goal.id)?.url` exists, open that PR URL.
2. Else, if the goal has a branch and the project has a GitHub origin, open the branch view: `https://github.com/<owner>/<repo>/tree/<encoded-branch>`.
3. Hide the row if neither URL is available.

The menu row opens in a new tab with `target="_blank"` / `noopener` semantics. If a PR cache entry exists but has no URL, prefer branch view over showing a disabled item.

## Duplicate session decision

Expose `Duplicate session` only after the implementation has a reliable create/fork path. UX behavior:

1. Clicking closes the menu immediately.
2. Row enters an optimistic app-level “creating session” affordance if one already exists; otherwise rely on the normal session creation row/status.
3. On success, connect to the new session and title it `Copy of <source title>` unless server returns a generated title.
4. On failure, show a toast with a short reason.

Recommended API shape if needed:

```http
POST /api/sessions/:id/duplicate
```

The duplicate should carry project, goal, staff/spec context, role/accessory, model selection, sandbox/worktree policy, and initial prompt/spec context. It should not clone the live transcript unless product explicitly wants “continue from here”; that is a different mental model from duplicate.

## Shared-element / FLIP animation

### Intent

The animation teaches that the menu contains the same actions users already know. It should feel like the hover strip opens into a labelled list, not like a second unrelated control.

### Open sequence

1. On hamburger pointer/keyboard activation, collect the hover-strip action elements before mounting the popover:
   - stable action id: `modify`, `terminate`, `reattempt`, `archive`, `dashboard`
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
- Copy link / duplicate / GitHub can wait for a mobile-specific overflow pass if users ask for those actions on mobile.

If product later needs parity, use a bottom sheet instead of an anchored popover below 640 px. The sheet should list the same rows with larger touch targets and no FLIP animation.

## Accessibility checklist

- Hamburger has `aria-label`, `aria-haspopup="menu"`, and live `aria-expanded`.
- Popover has `role="menu"`; rows have `role="menuitem"`.
- Icon-only hover buttons keep existing `title` and should also gain `aria-label` where missing.
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
