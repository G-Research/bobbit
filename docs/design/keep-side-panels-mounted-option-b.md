# Keep side panels mounted — Option B: imperative panel-host stack

Design exploration only. One candidate approach, not a decision. Written against
`goal/keep-side-pane-7e03c726` at the current HEAD of this worktree.

Option A (assigned to another agent) is "sprinkle visibility toggles through the
existing lit templates". This option is deliberately different: it puts the
lifetime of a panel's DOM under an explicit imperative owner and reduces the
number of side-panel layout templates instead of adding conditionals to them.

---

## 1. The constraint that decides the design

Two facts, both verifiable in the current code, narrow the solution space much
harder than the goal spec implies.

**(a) An iframe reloads on detach, so "keep the element alive" is not enough —
the element must never leave the document, and never change parent.**

The codebase already contains the "cache the element in state" pattern:
`state.chatPanel` (`src/app/state.ts:442`) is a live `ChatPanel` element
instance interpolated straight into templates (`render.ts:3400`,
`render.ts:3418`). lit inserts that node, and on teardown removes it while the
instance survives in `state`, so the next render re-inserts the *same* element.
That preserves element identity across every template swap.

It does **not** solve this goal. Re-insertion is a detach followed by an attach,
and the HTML spec resets a nested browsing context when its iframe is removed
from the document; every engine re-navigates. So the acceptance criterion
"`src` is not reassigned and the framed app does not reload" cannot be met by
any scheme that moves or re-inserts the subtree. `lit`'s `repeat()` has the same
problem: on reorder it *moves* DOM nodes.

Therefore the invariant this design enforces by construction is:

> A panel host element is created once, appended once, and thereafter only
> toggled between `hidden` and visible. It is never moved, never re-inserted,
> and it is removed exactly once — when the panel is genuinely torn down.

**(b) The side panel is rendered from three different template shapes today, so
the mode change itself is a teardown.**

`mainArea()` (`render.ts:3304`) has three distinct desktop branches for a
session that has panels:

| Mode | Code | Template shape |
|---|---|---|
| fullscreen | `render.ts:3386-3392` | wrapper + `renderSidePanelWorkspace("fullscreen")`, **no chat pane** |
| split | `render.ts:3395-3402` | split layout + chat pane + `renderSidePanelWorkspace("split")` |
| collapsed | `render.ts:3401` | split layout + chat pane + `sidePanelRestoreButton()` |

lit reconciles a `ChildPart` by template identity, so collapse→expand and
split→fullscreen are both full teardowns of the workspace subtree. Any cache
anchored *inside* that subtree dies with it.

Consequence: this design does not just add a cache. It first **collapses those
three branches into one mode-parameterised template**, which is what gives the
host stack a stable DOM position, and is a net reduction in branch count. The
cache then only has to handle the session and tab dimensions.

The rejected alternative from the goal spec (hoist to a fixed-position element
on `document.body` tracked by a `ResizeObserver` placeholder) is a *different*
way to get a stable position: it buys stability across arbitrary route changes
at the cost of fighting dialogs, the mobile slider, fullscreen and pane
resizing. This design stays in the normal flex flow, is sized by exactly the CSS
rules that size the panel today (`app.css:1145-1177`), has no fixed
positioning, no `ResizeObserver`, no z-index negotiation, and dies with the
workspace. The only imperative part is child *creation and visibility* — never
*position*.

---

## 2. Shape of the approach

One long-lived container element ("the host stack") rendered by lit as a
childless, binding-free element inside the workspace template. An imperative
registry owns per-`{sessionKey, tabId}` host `<div>`s inside it, each of which is
its own independent lit render root.

```
side-panel-workspace                       (lit template — reused across modes)
├── tab strip …                             (lit)
└── div[data-panel-host-stack]              (lit renders it; lit never touches its children)
    ├── div[data-panel-host][key="sess-a␀pack:vscode:…"]        ← visible
    ├── div[data-panel-host][key="sess-b␀pack:vscode:…"] hidden ← retained, frozen
    └── div[data-panel-host][key="sess-a␀preview:entry:x"] hidden
```

Why lit cannot tear a host down: the stack element is a *static* element of the
workspace template with no expressions inside it. It lives in the cloned
template fragment; its children are not inside any `ChildPart`, so lit's part
bookkeeping has no marker comments there and never clears, moves, or diffs
them. This is the same guarantee that makes `unsafeHTML`-into-a-`ref()`ed-element
and third-party widget mounting work; here it is used deliberately and the
manager owns cleanup itself (lit will not clean up for us).

Content is committed with a *second* lit root per host: `render(value, hostEl)`.
lit supports many independent roots; each host gets its own `TemplateInstance`
and part tree with no relationship to the app root's. Re-rendering the same
template into the same root updates in place, and an `AttributePart` only calls
`setAttribute` when the committed value actually changes — which is precisely why
`src` is not reassigned on reveal.

The value rendered is exactly `unifiedPanelContent(tab)`. Nothing about pack
panels moves: `renderPackPanelContent` (`pack-panels.ts:562`) remains the single
projection chokepoint, reached through the unchanged `packPanelContent(tab)`
(`render.ts:3146`). There is no pack-facing API change and `vscode-panel` needs
no edit.

---

## 3. Files, symbols, signatures

### 3.1 New module — `src/app/side-panel-host-stack.ts` (~130 lines)

```ts
/** Retained hidden hosts besides the visible one. */
export const PANEL_HOST_RETENTION = 3;

/** `${sessionKey}\u0000${tabId}` — sessionKey is panelWorkspaceSessionKey(...). */
export type PanelHostKey = string;
export function panelHostKey(sessionKey: string, tabId: string): PanelHostKey;

export interface PanelHostSyncInput {
  /** The stack element lit rendered this pass; null ⇒ no workspace on screen. */
  stack: HTMLElement | null;
  /** Key to show, or null when collapsed / nothing active. */
  visible: { sessionKey: string; tabId: string } | null;
  /** Every key that is still legitimately open. Anything else is destroyed. */
  liveKeys: ReadonlySet<PanelHostKey>;
  /** Content projection for a key. Called only for the visible host. */
  renderContent: (sessionKey: string, tabId: string) => unknown;
  retain?: number;
}

/** Idempotent post-render reconcile. Returns the visible host, for tests. */
export function syncPanelHosts(input: PanelHostSyncInput): HTMLElement | null;

/** Test/teardown helper: destroy every host and clear the registry. */
export function resetPanelHosts(): void;

/** Test introspection only. */
export function panelHostKeysForTest(): PanelHostKey[];
```

Internal state — one map and one counter, nothing else:

```ts
interface PanelHostEntry {
  key: PanelHostKey;
  sessionKey: string;
  tabId: string;
  el: HTMLDivElement;   // created once, appended once, never moved
  seq: number;          // LRU stamp
}
const hosts = new Map<PanelHostKey, PanelHostEntry>();
let seq = 0;
```

`syncPanelHosts` algorithm, in order:

1. **Stack lost.** If `stack` is null, or any entry's `el.parentElement !== stack`
   (lit tore the workspace down, or the shell flipped desktop↔mobile), destroy
   those entries and return. Detecting it here needs no `MutationObserver`.
2. **Purge dead keys.** Destroy every entry whose key is not in `liveKeys`. This
   is the tab-close / pack-uninstall / session-gone path.
3. **Ensure the visible host.** If `visible` is non-null and in `liveKeys`,
   create its host if missing (`document.createElement("div")`, set
   `data-panel-host`, `data-panel-host-key`, `class="side-panel-host"`, append),
   bump `seq`, `render(renderContent(...), el)`, then unhide.
   Creation happens **only** for the requested visible key, which is derived from
   workspace state — never from the cache. A cached subtree therefore cannot
   resurrect a panel.
4. **Hide the rest.** Every other entry: `hidden = true`, `inert = true`,
   `aria-hidden = "true"`. Hidden hosts are **not** re-rendered.
5. **Trim to retention.** While `hosts.size > retain + 1`, destroy the lowest
   `seq` entry that is not the visible one.

`destroy(entry)` = `render(nothing, entry.el)` then `entry.el.remove()` then
`hosts.delete(key)`. Clearing the host's own lit root before removal is what
makes eviction indistinguishable from today's teardown: lit disconnects its
parts exactly as it does when the workspace template is torn down.

### 3.2 `src/app/render.ts`

**a. Emit the stack instead of inlining content** — in `renderSidePanelWorkspace`
(`render.ts:3209`), replace the trailing `${unifiedPanelContent(activeTab)}`
(`render.ts:3287`) with:

```html
<div class="side-panel-host-stack flex-1 min-h-0 flex flex-col" data-panel-host-stack></div>
```

Note this element carries the flex classes the content used to carry, so the
visible host inherits the same box as today.

**b. Fold the three desktop modes into one template.** Replace `render.ts:3386-3402`
with a single branch:

```ts
const mode = sidePanelSizeMode();               // "collapsed" | "split" | "fullscreen"
return html`
  ${reconnectBanner()}
  ${staffInboxOpenAffordance()}
  <div class="goal-split-layout side-panel-split-layout flex-1 flex min-h-0 overflow-hidden"
       data-side-panel-layout-mode=${mode}>
    <div class="goal-chat-panel side-panel-chat-pane flex-1 min-w-0 flex flex-col"
         ?hidden=${mode === "fullscreen"}>
      ${renderGoalPausedBannerIfNeeded(activeSession)}${state.chatPanel}
    </div>
    ${renderSidePanelWorkspace(mode)}
    ${mode === "collapsed" ? sidePanelRestoreButton() : ""}
  </div>
`;
```

and inside `renderSidePanelWorkspace`, `?hidden=${mode === "collapsed"}` on the
`.side-panel-workspace` root (`render.ts:3218`), which already carries
`data-side-panel-mode`.

Layout consequences, all CSS, in `src/app/app.css` beside the existing
`.side-panel-split-layout` rules (`app.css:1145`):

- `[data-panel-host][hidden], .side-panel-workspace[hidden], .side-panel-chat-pane[hidden] { display: none !important; }`
  — necessary because `hidden`'s UA `display:none` loses to the `flex`/`flex-1`
  utility classes already on those elements.
- collapsed: workspace `display:none` contributes zero width, chat pane keeps
  `flex-1`, restore button unchanged ⇒ byte-identical collapsed layout. The
  current collapsed branch swaps the chat pane's class from
  `goal-chat-panel side-panel-chat-pane flex-1` to bare `flex-1`; keep that as a
  mode-conditional class so the collapsed box model is not perturbed.
- fullscreen: chat pane `display:none`, workspace keeps `flex-1`; the split-only
  `border-l` stays mode-conditional as it is now.

`state.chatPanel` being rendered-but-hidden in fullscreen (rather than dropped)
is a deliberate behaviour change and the most likely thing to trip an existing
pinning test — see §7.

**c. Drive the sync from the existing post-render hook.** `renderApp()` already
ends with an imperative pass (`ensurePanelSortable(tabBar)` at `render.ts:3553`,
`ensurePanelTabOverflowObserver(...)` after it) that runs for all three shells.
Append:

```ts
syncSidePanelHosts();      // new module-local helper in render.ts
```

where

```ts
function syncSidePanelHosts(): void {
  const stack = document.querySelector<HTMLElement>("[data-panel-host-stack]");
  syncPanelHosts({
    stack,
    visible: currentVisiblePanelHostTarget(),   // null when collapsed
    liveKeys: livePanelHostKeys(),
    renderContent: (sessionKey, tabId) => {
      const tab = findPanelTab(panelTabsForSession(state, sessionKey), tabId);
      return tab ? unifiedPanelContent(tab) : nothing;
    },
  });
}
```

`unifiedPanelContent` is currently a closure inside `renderApp`
(`render.ts:3176`); it and its helpers (`htmlPreviewContent`, `reviewPaneContent`,
`inboxPaneContent`, `proposalPanelContent`, `packPanelContent`) close over
`activeSession`, `desktop`, and other per-render locals. Two options:

- **B1 (recommended):** pass the closure through as `renderContent` from inside
  `renderApp`, i.e. do the `syncPanelHosts` call at the bottom of `renderApp`
  where the closures are in scope, rather than in a top-level function. Zero
  refactor of the content functions.
- **B2:** lift the content dispatch out of `renderApp` into module scope. Larger,
  touches five render helpers, and buys nothing for this goal. Not recommended.

`currentVisiblePanelHostTarget()` = `null` when `sidePanelSizeMode() === "collapsed"`
or `activeSidePanelContentTab()` (`render.ts:3195`) is null; otherwise
`{ sessionKey: workspaceSessionId(), tabId: activeTab.id }`.

`livePanelHostKeys()` = for each session key currently in `hosts` **plus** the
active session key: `panelContentTabs(panelTabsForSession(state, sessionKey))`,
filtered so a `pack` tab is dropped when its pack is no longer registered, then
`panelHostKey(sessionKey, tab.id)`. A session whose workspace has vanished from
`state.sidePanelWorkspaceBySession` yields nothing ⇒ all its hosts destroyed.

**d. Deep-link / popout route is excluded.** The `route.panelTabId` branch
(`render.ts:3365`) keeps calling `renderSidePanelWorkspace("fullscreen")`, but
that path must not participate in the cache — the spec says it renders an
already-open workspace tab and must not invent one from a cached subtree. Since
that branch renders its own workspace instance, its stack element is a different
node; step 1 of the algorithm sees `parentElement !== stack` and destroys the old
hosts, so the deep-link route behaves exactly as today (fresh mount). Explicitly
asserted in tests so nobody "fixes" it later.

### 3.3 `src/app/pack-panels.ts` — one new exported predicate

```ts
/** True when `{packId, panelId}` is still a registered contribution. */
export function isPackPanelRegistered(packId: string, panelId: string): boolean {
  return panels.has(panelKey(packId, panelId));
}
```

Three lines, reads existing state, no new state owner. Needed because uninstall
reconcile closes the tab through `closeSidePanelTab`, which is an async server
round-trip (`pack-panels.ts:removePackPanelTab`). In that window the tab is still
"live", and a *hidden* host would keep showing stale DOM because hidden hosts are
not re-rendered. The predicate makes the disable/uninstall teardown immediate and
synchronous, and keeps working with the existing reconcile rather than replacing
it. (The visible host is safe without it — `renderPackPanelContent` already
returns `nothing` for an unregistered panel.)

### 3.4 CSS — `src/app/app.css`

The `[hidden]` overrides above, `.side-panel-host-stack { display:flex; flex-direction:column; flex:1; min-height:0; }`,
`.side-panel-host { display:flex; flex-direction:column; flex:1; min-height:0; }`,
and the mobile-side no-op check against `app.css:731-735`
(`[data-mobile-header] .side-panel-pane[data-panel-tab-id]`) — mobile is
untouched, see §5.

---

## 4. Inertness

- `hidden = true` (the IDL attribute, i.e. the content attribute) plus the
  `display:none !important` rule above. `display:none` alone already removes the
  subtree from the accessibility tree, from focus order, and from
  `:focus-visible` reachability, and it is the mechanism the constraints
  mandate. No opacity, no off-screen positioning.
- `inert = true` and `aria-hidden = "true"` as belt-and-braces. Both are
  redundant under `display:none`; they exist so that a future variant (e.g. a
  spike outcome that forces `content-visibility` instead — see §8) cannot
  silently become focusable.
- Nothing else is needed: `display:none` also suspends rendering and animation
  inside the framed document while keeping the document, its scripts, and its
  state alive.

---

## 5. Mobile slider and fullscreen

**Mobile: deliberately out of scope, and the reason is structural.**
`mobilePaneContent` (`render.ts:3298`) renders `unifiedPanelContent(tab)` for
*every* open tab into a horizontal track (`render.ts:3414-3417`); tab switching
is a CSS `translateX`, not a DOM change. So the tab dimension is already
mounted-and-kept on mobile, and there is no collapsed mode on mobile at all. The
only dimension left is session switch. Retro-fitting the host stack there means
one stack per pane (panes are positional, and pane *count* changes with the tab
set), i.e. N stacks and a pane-index↔key mapping — a lot of new surface for the
one remaining dimension. Recommendation: leave mobile exactly as it is, note it
in the design doc, and revisit only if a mobile iframe panel ships.

One thing the plan must *not* break: a desktop↔mobile viewport flip renders a
different top-level template into the same container, so every host dies. That is
today's behaviour and step 1 of the algorithm handles it cleanly (destroy, don't
leak). Called out so it is not mistaken for a regression.

**Fullscreen: in scope, and it is the reason for the single-template
restructure.** Split↔fullscreen is a very common action and today it is a full
teardown. Folding the modes into one template makes it a class change, so a
fullscreen toggle keeps the same host and the same iframe. Cost: the chat pane
becomes rendered-but-hidden in fullscreen instead of absent.

---

## 6. Defect-surface accounting

Honest ledger. New things:

| # | New surface | Kind | Notes |
|---|---|---|---|
| 1 | `src/app/side-panel-host-stack.ts` | module | ~130 lines, no dependencies beyond `lit` |
| 2 | `hosts: Map<key, entry>` + `seq` | **state owner** | the one genuinely new state owner |
| 3 | `syncPanelHosts` | transformation | `(visible, liveKeys, retain) → DOM mutations` |
| 4 | `syncPanelHosts` / `resetPanelHosts` / `panelHostKeysForTest` | internal API | app-internal only; no pack-facing change |
| 5 | `isPackPanelRegistered` | exported predicate | 3 lines over existing `panels` map |
| 6 | `[data-panel-host-stack]`, `[data-panel-host][data-panel-host-key]` | DOM contract | now load-bearing; must be pinned by a test |
| 7 | N extra lit render roots | abstraction | one per retained host; **leaks if eviction forgets `render(nothing, el)`** |
| 8 | `PANEL_HOST_RETENTION` | policy constant | with the LRU comparison |
| 9 | mode classes + `[hidden]` overrides | CSS | `!important` needed to beat utility classes |
| 10 | hidden hosts are **frozen** (not re-rendered) | behaviour change | a hidden panel's async `renderApp()` repaints only on reveal |
| 11 | chat pane rendered-but-hidden in fullscreen | behaviour change | transcript DOM now stays mounted in fullscreen |

Removed / reduced:

- desktop `mainArea()` side-panel branches: **3 → 1**.
- `renderSidePanelWorkspace` no longer has a per-mode template identity.
- hidden panels stop consuming render time on every `renderApp()` (today they
  either don't exist or, under a `repeat()`-style fix, would re-render on every
  pass).

**Versus a template-toggle approach.** Toggling `?hidden` in the existing
templates is strictly cheaper for collapse/expand and needs no new module — and
it needs the *same* single-template restructure to work at all, so that part is
not an Option-B tax. Where the two diverge is the session dimension: holding two
sessions' subtrees simultaneously inside a lit template means `repeat()` keyed by
`{sessionId, tabId}`, and that has three problems this design does not:
`repeat()` **moves DOM nodes** when the key order changes (LRU reordering would
re-navigate the iframe — exactly the bug); every retained item re-renders on
every pass; and the retention policy ends up expressed as an array slice inside a
template. So the honest summary is: Option B costs one module, one state owner
and two behaviour changes, and buys explicit never-move lifetime, explicit
eviction, zero render cost for hidden panels, and one stable DOM position for all
three desktop modes.

---

## 7. Testability

Named tests the test engineer should add, by tier.

**`tests2/dom/side-panel-host-stack.test.ts` (vitest, happy-dom)** — the manager
in isolation, no app render. `renderContent` returns
`` html`<iframe src=${url}></iframe>` ``, so identity and attribute assertions
are exact:

- create with visible `A` → one `[data-panel-host]`, not hidden;
- sync visible `B` → `A.hidden === true`, `A.inert === true`,
  `A.getAttribute("aria-hidden") === "true"`, `A.isConnected === true`;
- sync visible `A` again → **same element instance** (`===` against the captured
  reference) and **same `<iframe>` node**; spy `HTMLIFrameElement.prototype.setAttribute`
  and assert **zero** `src` calls during the reveal;
- `renderContent` call count: called once per reveal, never for a hidden key;
- `liveKeys` without `A` → `A.isConnected === false` and the key is gone;
- 5 keys with `retain: 3` → oldest-by-`seq` destroyed, visible never destroyed;
- `stack: null`, and stack replaced by a different element → all hosts destroyed
  (the deep-link / shell-flip path).

**`tests2/dom/side-panel-keeps-panel-mounted.test.ts` (vitest, happy-dom)** —
real `renderApp()`. Use a **preview** tab, not a pack tab: `htmlPreviewContent()`
(`render.ts:2869`) renders a real `<iframe src>` from app code, whereas a pack
panel needs a Blob-URL ESM import that happy-dom cannot execute (documented in
`tests2/dom/pack-panels-reconcile.test.ts`'s PUNTED note). Assertions:

- collapse (`setSidePanelSizeMode("collapsed")` + render) → the iframe node is
  still `isConnected`, the host is `hidden`, `document.querySelector(".side-panel-workspace")`
  is hidden, and the restore button is present;
- expand → **same iframe node**, `src` unchanged, `setAttribute` spy sees no `src`
  write;
- switch session and back → same iframe node;
- split→fullscreen→split → same iframe node;
- close the tab → iframe gone;
- collapsed geometry: chat pane still carries the full-width class, workspace has
  `display:none`.

**`tests2/browser/fixtures/side-panel-mounted-panels.spec.ts` (Playwright)** —
the only tier where a real pack panel module loads, so the only place the
`vscode-panel`-shaped case is real:

- stamp `iframe.dataset.probe = crypto.randomUUID()` on first sight; after
  collapse/expand and after a session round-trip, re-read it — unchanged proves
  same element, and a counter incremented from inside the framed document's
  `load` handler staying at 1 proves no re-navigation;
- keyboard inertness: `Tab` from the composer never lands inside a hidden host
  (`document.activeElement.closest("[data-panel-host][hidden]") === null`);
- a11y: `page.accessibility.snapshot()` contains no node from the hidden host;
- retention: open panels in 5 sessions, return to the first → it re-mounts (proves
  eviction happened and is indistinguishable from a cold mount);
- disable the owning pack from the marketplace UI → host destroyed without a
  reload.

**Existing pinning tests to keep green** (these are the ones the restructure is
most likely to break, and they are the reason the restructure is the risky half,
not the cache):

- `tests2/browser/fixtures/side-panel-tabs.spec.ts` — tab strip + visibility
  filtering; it already filters on computed `display`/`visibility`
  (`side-panel-tabs.spec.ts:41-46`), so a hidden workspace must not leak tab
  pills into `visiblePanelTabs()`.
- the daily-tier fullscreen geometry spec (`getBoundingClientRect` on the
  fullscreen side panel, `tests-map.json:9202`) — directly exercises the
  fullscreen branch being folded, and the rendered-but-hidden chat pane.
- `tests2/dom/pack-panels-reconcile.test.ts` — uninstall drops the tab; must still
  pass with `isPackPanelRegistered` added.
- `tests2/browser/e2e/extension-panel-ux.spec.ts`, `tests2/browser/e2e/pr-walkthrough-pack.spec.ts`
  — real pack panels through the shared shell.

---

## 8. Risks and what a bounded spike resolves

1. **Does a real VS Code for the web survive `display:none` and relayout on
   reveal?** Highest risk in the whole design. The document stays alive, but its
   viewport is 0×0 while hidden and Monaco/workbench code caches measurements. It
   may come back mis-laid-out until something kicks a resize. Mitigations, in
   order of preference: rely on the framed app's own `ResizeObserver` (VS Code
   uses one); if that is insufficient, the reveal path is the natural place for a
   one-shot nudge, but anything we dispatch into the frame is a new coupling we
   do not want. **Spike:** a standalone page with a VS Code-web iframe, toggled
   `display:none` for 60 s, ×5 — confirm no reload, confirm correct relayout,
   confirm editor state and terminal survive. ~1-2 h. If it fails, the whole
   "hidden" strategy needs re-evaluation (and the `display:none` constraint in
   the goal spec becomes a question for the user), so run this spike **first**.
2. **Memory of N retained heavyweight panels.** Three retained VS Code instances
   is likely hundreds of MB. `PANEL_HOST_RETENTION = 3` may be too generous;
   the spike should measure and may argue for 1 (active + previous).
3. **The single-template restructure vs the fullscreen geometry test.** Whether
   the CSS for collapsed and fullscreen can be reproduced exactly with classes
   plus `hidden`, with no 1px drift. **Spike:** prototype just the `mainArea()`
   restructure with the content still inlined (no cache at all) and run the
   fullscreen geometry spec plus `side-panel-tabs.spec.ts`. ~1-2 h. This is
   independently valuable — it is a prerequisite for *any* option, including A.
4. **Rendered-but-hidden chat pane in fullscreen.** `state.chatPanel` is a live
   `AgentInterface`-bearing element; keeping it in a `display:none` container
   means its scroll anchoring / follow-tail (`src/app/follow-tail.ts`) and
   mobile scroll tracking see a zero-height box. Needs a check that entering and
   leaving fullscreen does not scramble the transcript scroll position. Fallback:
   keep dropping the chat pane in fullscreen (accept that split↔fullscreen still
   reloads the panel) — this degrades gracefully and is a one-line decision.
5. **Frozen hidden hosts and pack expectations.** A pack whose async work
   completes while hidden will not repaint until reveal. Strictly better than
   today (where it was destroyed), but it is a semantic worth writing into
   `docs/extension-host-authoring.md` so pack authors do not depend on
   `renderApp()` repainting a hidden panel.
6. **Eviction leak.** Forgetting `render(nothing, el)` before `el.remove()` leaks
   the host's lit root and any listeners the content registered. Pinned by the
   manager unit test asserting `isConnected === false` *and* that a re-created
   host for the same key gets a fresh iframe.
7. **`!important` in the `[hidden]` rules** is a smell forced by utility classes
   on the same elements. Acceptable and localised, but it means any future
   `display:` utility on those elements silently loses — worth a comment in
   `app.css`.

---

## 9. Suggested sequencing

1. Spike (1) — `display:none` + VS Code web. Gate on it.
2. Spike (3) — `mainArea()` single-template restructure, cache-free, existing
   tests green. Land it as its own commit: it is a branch-count reduction that
   stands on its own and already fixes collapse/expand and split↔fullscreen for
   *iframes in the active session*.
3. Add `side-panel-host-stack.ts` + the stack element + the post-render sync, with
   `PANEL_HOST_RETENTION = 1` (active + previous) to keep the first landing
   conservative.
4. Add `isPackPanelRegistered` and the live-key filtering.
5. Raise retention only if the memory measurement from spike (1) supports it.
