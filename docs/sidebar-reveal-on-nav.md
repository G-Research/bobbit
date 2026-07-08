# Sidebar reveal on nav

When the app navigates to a session or goal route, the sidebar must show the
target row: expand any collapsed ancestors so the row is rendered, then scroll
it into view. This applies both to initial deep-links (pasting or opening
`#/session/<id>` / `#/goal/<id>`) and to in-app route changes (clicking,
keyboard-nav landings, browser back/forward).

## Why this exists

The plumbing for both halves already existed, but nothing bridged *route
navigation* to *sidebar reveal*:

- Ancestor goals were auto-expanded only when new sessions arrived over the
  WebSocket (`src/app/api.ts`), not when the user navigated to an existing one.
- Keyboard navigation (`Ctrl+↑/↓`) opened rows but is a separate concern — it
  moves an in-sidebar cursor, it does not react to arbitrary route changes.
- No code scrolled the sidebar to the active row on navigation at all.

The consequence: deep-linking to a session nested inside a collapsed project or
goal, or clicking a goal whose row is scrolled off-screen, left the user staring
at a sidebar that gave no visual anchor for where they now were. Reveal-on-nav
closes that gap by treating route navigation as the trigger and driving the two
existing subsystems (the [tree expansion state](sidebar-tree-state.md) and the
DOM row layout) from it.

The feature is deliberately **UI-only** and lives in
[`src/app/sidebar-reveal.ts`](../src/app/sidebar-reveal.ts). It is invoked from
route handling (`handleHashChange` and cold-start boot in
[`src/app/main.ts`](../src/app/main.ts)), never bolted onto keyboard nav, so the
two navigation models stay independent.

## What it does

Given a session or goal route, `revealSidebarTargetForRoute(route)`:

1. Resolves the target's canonical [sidebar-tree key](sidebar-tree-state.md#canonical-keys)
   (`session:<id>` → `{ kind: "session", sessionId }`; goal / goal-dashboard →
   `{ kind: "goal", goalId }`). Non-session/goal routes are a no-op.
2. Looks the node up in the tree model and walks its `parentKey` chain,
   expanding each ancestor so the target row will render. For a session this
   covers its project, the relevant section header (ungrouped sessions / staff /
   archived), any parent-session child groups, and every ancestor goal in the
   nesting chain. For a goal it covers the project and the full `parentGoalId`
   chain up to the top-level goal.
3. Scrolls the target row into view once it exists in the DOM.

## Design decisions (the WHY)

### Ephemeral, non-destructive expansion

Reveal expands ancestors only through
`expandSidebarTreeNode(key, { explicit: false })`. This is the *safe automatic*
path in [`sidebar-tree-state.ts`](../src/app/sidebar-tree-state.ts): it
early-returns when the node already has a stored preference and when the node's
default is already expanded, and it never writes to
`bobbit-sidebar-tree-state:v1`.

The reason is the ephemeral contract: revealing a target must never overwrite an
explicit user *collapse*. If the user deliberately collapsed a project, deep-
linking to a session inside it should still reveal the path (because navigation
is an explicit intent), but the reveal path used here respects a stored collapse
on any node *not* on the path to the target — those nodes are simply never
touched. Using `setSidebarTreeExpanded` instead would persist a choice the user
never made and would clobber their collapse preferences on the next poll or
reload. See
[Expansion defaults and persistence](sidebar-tree-state.md#expansion-defaults-and-persistence)
for why explicit-vs-ephemeral is the mechanism that keeps user intent durable.

Only ancestors of the target are walked — the `parentKey` chain, guarded by a
`seen` set against any pathological cycle. Unrelated collapsed nodes stay
collapsed.

### Exactly once per navigation — the `revealToken`

A monotonic `revealToken` is incremented on every call to
`revealSidebarTargetForRoute`. All the deferred callbacks (see async retry
below) capture the token value at scheduling time and bail out immediately if
`revealToken` has since advanced.

The reason is that navigations can supersede each other faster than the async
retries resolve — a user clicking through several rows, or rapid keyboard nav,
fires the reveal repeatedly. Without the token, an earlier navigation's
in-flight retry could expand ancestors for a stale target or scroll to a row the
user has already navigated away from. The token guarantees that only the most
recent navigation's reveal ever completes, so the sidebar always settles on the
row the user actually landed on and never fights itself.

### Async deep-link retry

On a deep-link, the target session or goal data loads asynchronously — the row
(and often the node itself) does not exist on the first paint. Reveal handles
this with two bounded `requestAnimationFrame` polls (falling back to
`setTimeout` in non-DOM/test environments):

- **Model poll** (`attemptReveal`): rebuilds the tree model each frame until the
  target node appears in `flatByKey`, then expands the ancestor chain and calls
  `renderApp()`.
- **DOM poll** (`attemptScroll`): after the render, retries locating the row by
  `data-nav-id` until it is committed, because lit commits the DOM
  asynchronously after `renderApp`.

Both polls are bounded (`MAX_ATTEMPTS`, ~0.5 s at 60 fps). Each call site invokes
the reveal only *after* awaiting its data load (`refreshSessions` /
`loadDashboardData` / `connectToSession`), so the node is usually present on the
first attempt; the retry budget only matters for the rare case where data
streams in slightly after the reveal fires. Combined with the `revealToken`,
the retries stay bounded and still run exactly once per navigation.

### Resolve against the unfiltered tree model

Reveal walks `buildSidebarTreeModel()`, exported from
[`src/app/sidebar.ts`](../src/app/sidebar.ts), which returns the tree model
*before* the search-query goal filter is applied. `buildDesktopSidebarTree`
still applies that filter on top, so rendering is unchanged.

The reason is that ancestor resolution must keep working even when the sidebar
search box is non-empty. If reveal walked the filtered model, a goal pruned by
an active search query would have no node to expand and the target would never
be revealed. Resolving against the full model decouples "where does this row
live in the hierarchy" from "what is currently shown by search".

### `scrollIntoView({ block: "nearest" })` only

The row is scrolled with `scrollIntoView({ block: "nearest" })` — no
`smooth`/animated behavior. `block: "nearest"` scrolls only when the row is
off-screen and is a no-op when it is already visible, so navigating to an
already-visible row produces no jarring jump. Animated scroll is avoided because
it would compete with the message-pane auto-scroll (`AgentInterface`) and the
keyboard-nav override, and because reveal can fire in quick succession — smooth
scroll would produce visible thrash.

## Relationship to adjacent features

- **[Keyboard navigation](sidebar-keyboard-navigation.md)** is a separate model.
  Reveal never mutates `state.keyboardNavActiveId`, `data-nav-active`,
  `getVisibleNavOrder`, or the override-clear listener — it only reads the DOM
  (via the shared `data-nav-id` contract) and flips ephemeral expansion prefs.
  Keyboard nav moves a cursor through visible rows; reveal reacts to route
  changes. They share the `data-nav-id="<kind>:<id>"` row tagging but are
  otherwise independent.
- **[Sidebar tree state](sidebar-tree-state.md)** owns the expansion model,
  canonical keys, and the explicit-vs-ephemeral persistence contract that reveal
  relies on. Reveal is a consumer of `expandSidebarTreeNode(..., { explicit:
  false })`, the same non-destructive path `api.ts` and `createGoal()` use for
  auto-expansion.

## Internals — file map

- [`src/app/sidebar-reveal.ts`](../src/app/sidebar-reveal.ts) —
  `revealSidebarTargetForRoute` (public entry), `targetForRoute`,
  `attemptReveal`, `attemptScroll`, `navRowForId`, and the `revealToken` /
  `pending` state.
- [`src/app/main.ts`](../src/app/main.ts) — invokes the reveal from each
  session / goal / goal-dashboard branch of `handleHashChange` (including the
  already-connected early return) and from the cold-start deep-link boot block
  in `initApp`.
- [`src/app/sidebar.ts`](../src/app/sidebar.ts) — exports
  `buildSidebarTreeModel` (the pre-search-filter model); rendering via
  `buildDesktopSidebarTree` is unchanged.
- [`src/app/sidebar-tree-state.ts`](../src/app/sidebar-tree-state.ts) —
  `expandSidebarTreeNode(key, { explicit: false })`, the ephemeral expansion
  path.
- [`tests/e2e/ui/sidebar-reveal.spec.ts`](../tests/e2e/ui/sidebar-reveal.spec.ts)
  — deep-link session and sub-goal reveal, in-app off-screen scroll vs
  no-jump-when-visible, and the ephemeral-collapse contract.
