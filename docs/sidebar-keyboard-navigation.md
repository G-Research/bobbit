# Sidebar keyboard navigation

`Ctrl+↑` / `Ctrl+↓` walk every row currently rendered in the sidebar, in
top-to-bottom DOM order with wrap-around. Each step **immediately** opens the
matching destination — there is no Enter key. `Ctrl+→` / `Ctrl+←` are a
keyboard equivalent of clicking the chevron on a group header: they expand or
collapse the active row without moving the cursor.

The feature lives in [`src/app/sidebar-nav.ts`](../src/app/sidebar-nav.ts); the
shortcuts are registered in `src/app/main.ts` (ids `prev-session`,
`next-session`, `sidebar-expand`, `sidebar-collapse`).

## Shortcut table

| Shortcut | Action |
|---|---|
| `Ctrl+↓` | Move active row to next visible sidebar row, wrap at end, auto-open destination. |
| `Ctrl+↑` | Move active row to previous visible sidebar row, wrap at top, auto-open destination. |
| `Ctrl+→` | If the active row is a collapsed group header, expand it. No-op on leaves or already-expanded groups. Cursor stays put. |
| `Ctrl+←` | If the active row is an expanded group header, collapse it. No-op on leaves or already-collapsed groups. Cursor stays put. |

All four are registered with `allowInInput: true`, so they work even while
focus is in a text field (the standard exclusions in `MessageEditor`,
`cwd-combobox`, etc. continue to apply).

### What each row auto-opens

| Row kind | `data-nav-id` prefix | `Ctrl+↑/↓` opens |
|---|---|---|
| Session (live or archived, under goal / ungrouped / staff) | `session:<sessionId>` | The session — `connectToSession(id, true)` |
| Goal header (live or archived) | `goal:<goalId>` | Goal dashboard — `#/goal/<goalId>` |
| Project header | `project:<projectId>` | Project settings — `#/settings/<projectId>/general` |
| Staff section header | `staff-header:<projectId>` | Staff list page — `#/staff` |
| Ungrouped "Sessions" header | `ungrouped-header:<projectId>` | Splash / landing — `#/` |
| Archived section header | `archived-header:<projectId>` | Splash / landing — `#/` |

Rapid key presses are **not** debounced — every step switches the route. This
is deliberate: holding `Ctrl+↓` should feel like scrubbing through the
sidebar.

## The active-row contract

There is one "active row" concept in the sidebar — the row that drives the
main pane. It is rendered with the same highlight CSS that previously marked
only active sessions, extended to every row kind via a `data-nav-active="true"`
attribute on the rendered element.

### How the active row is derived

`getActiveNavId()` in `sidebar-nav.ts` returns the `data-nav-id` of the active
row, computed from:

1. The current hash route (`getRouteFromHash()`):
   - `#/session/<id>` → `session:<id>`
   - `#/goal/<id>` → `goal:<id>`
   - `#/settings/<projectId>/<tab>` → `project:<projectId>`
2. `state.selectedSessionId` as a fallback.
3. A thin override field, `state.keyboardNavActiveId`, that wins
   unconditionally when set. Staleness is bounded by the `hashchange`
   listener (see below), so trusting it without an extra URL check is safe.

### Why the override exists

The original design called for "no new state — derive purely from route +
selected session". This works for sessions, goals, and projects because their
routes carry the row's id. It does **not** work for header kinds:

- All ungrouped headers route to `#/`.
- All archived headers route to `#/`.
- The staff header always routes to `#/staff` regardless of which project.

Without an override, navigating onto any header would highlight every header
of the same kind. `state.keyboardNavActiveId` is the minimal pragmatic
deviation: it stores the most recently keyboard-touched `data-nav-id` and is
trusted unconditionally while set. The override is **cleared automatically**
by a `hashchange` listener (`installKeyboardNavOverrideClearListener`)
whenever the URL changes to something that does not correspond to it —
clicking another row, opening settings, etc. — so it never goes stale.

**Why trust the override unconditionally?** Session navigation goes through
an async dynamic import + `connectToSession`, so during the ~200 ms
attach the override is set but the hash has not yet committed. The earlier
"only trust if hash matches" guard caused `getActiveNavId()` to fall back
to the cold start during attach, which made `openForNavItem` re-fire with
the same id and silently dropped 3–4 of every 6 rapid Ctrl+↓ keystrokes.
Pinned by `tests/rapid-keystroke-nav.spec.ts`.

## DOM-driven order — single source of truth

`getVisibleNavOrder()` reads the rendered sidebar:

```ts
document.querySelector(".sidebar-edge")
        .querySelectorAll("[data-nav-id]");
```

…and returns the ids in document order. This is deliberate. The sidebar's
visibility rules are non-trivial — they depend on `state.searchQuery`,
`state.showArchived`, per-project expansion state for projects, goals, the
ungrouped section, the staff section, and the archived section. Re-deriving
that order in a separate model helper would mean keeping two implementations
in sync forever.

Because the order is read from the DOM, keyboard navigation **automatically**
respects:

- Search filtering — only filtered-visible rows are in the cycle.
- Archived view toggle — archived rows enter/leave the cycle as
  `state.showArchived` flips.
- Every collapse state — `isProjectExpanded`, `expandedGoals`,
  `isUngroupedExpanded`, `isStaffExpanded`, `isArchivedSectionExpanded`.

The single source of truth is whatever the user can see.

### The `data-nav-id` tagging contract

Every selectable sidebar row carries `data-nav-id="<kind>:<id>"` where
`<kind>` is one of:

```
project | goal | session | ungrouped-header | staff-header | archived-header
```

Emission sites:

- `src/app/sidebar.ts` — project headers, ungrouped header, staff header,
  staff session rows.
- `src/app/render-helpers.ts` — goal headers, sessions under goals, archived
  rows, top-level session rows, archived section header.

Tests (and any future tooling) can rely on this contract: see
[`tests/e2e/ui/sidebar-keyboard-nav.spec.ts`](../tests/e2e/ui/sidebar-keyboard-nav.spec.ts)
for the 8-case coverage of the full behavior table.

## Edge cases

- **Cold start (no active row yet)** — first `Ctrl+↓` selects the first
  visible row; first `Ctrl+↑` selects the last. The shortcut always does
  something useful, even on a fresh load or after the active session was
  deleted.
- **Active row deleted / no longer in the cycle** — same fallback: next
  press picks the first or last visible row.
- **Empty sidebar** — all four shortcuts are no-ops.
- **`Ctrl+→` / `Ctrl+←` on a leaf** — no-op. Cursor never moves; route
  never changes.
- **`Ctrl+→` on an already-expanded group, `Ctrl+←` on an already-collapsed
  group** — no-op.
- **Wrap-around** — `Ctrl+↑/↓` only. `Ctrl+←/→` never move the cursor, so
  there is nothing to wrap.

## Relationship to mouse behavior

Keyboard navigation is a shortcut to the same destinations the dedicated
buttons already provide. Mouse behavior is unchanged:

- Clicking a project / goal / staff / ungrouped / archived header (or its
  chevron) still expands or collapses it. It does **not** route.
- Goal dashboards, project settings, and staff lists are still reached via
  their existing dedicated buttons (gear icon, dashboard button, etc.).

`Ctrl+↑/↓` is the keyboard equivalent of clicking a body row; `Ctrl+←/→` is
the keyboard equivalent of clicking a chevron. Nothing about mouse
interactions was changed by this feature.

## Internals — file map

- [`src/app/sidebar-nav.ts`](../src/app/sidebar-nav.ts) — `parseNavId`,
  `navIdFor`, `navIdToHash`, `getActiveNavId`, `getVisibleNavOrder`,
  `openForNavItem`, `navigateSidebar`, `expandActiveSidebarItem`,
  `setNavItemExpanded`, `installKeyboardNavOverrideClearListener`.
- [`src/app/main.ts`](../src/app/main.ts) — shortcut registrations under
  ids `prev-session`, `next-session`, `sidebar-expand`, `sidebar-collapse`.
- [`src/app/sidebar.ts`](../src/app/sidebar.ts),
  [`src/app/render-helpers.ts`](../src/app/render-helpers.ts) —
  `data-nav-id` emission on every selectable row and active highlight
  extension.
- [`src/app/state.ts`](../src/app/state.ts) — `keyboardNavActiveId`
  override field.
- [`tests/e2e/ui/sidebar-keyboard-nav.spec.ts`](../tests/e2e/ui/sidebar-keyboard-nav.spec.ts)
  — full contract coverage.
