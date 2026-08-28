# Keep side panels mounted — Option A (minimal composition of existing render machinery)

Design exploration only. No production code changed by this document.

Goal: `goal/keep-side-pane-7e03c726` — side-panel content must stay **mounted but
hidden** across collapse/expand, session switch and tab switch, so a pack panel's
`<iframe>` (`vscode-panel`) keeps running instead of re-navigating.

Option A brief: reuse what already exists (lit `repeat`, the existing
`renderSidePanelWorkspace` chrome, `panel-workspace.ts` accessors, the pack-panel
uninstall reconcile) and add the smallest possible amount of new state.

---

## 1. Root cause, in lit terms

`renderApp()` re-renders the whole app shell into one container each frame. lit
reuses DOM at a `ChildPart` **only when the committed value is a `TemplateResult`
whose `strings` array is the same object** as last commit (i.e. the same
`html\`\`` call site). Anything else clears the part and rebuilds.

Every one of the reported symptoms is that rule firing:

| Transition | Code | Why the subtree dies |
| --- | --- | --- |
| collapse / expand | `render.ts:3395-3401` `${collapsed ? sidePanelRestoreButton() : renderSidePanelWorkspace("split")}` | two different call sites at one part → clear + rebuild |
| split ↔ fullscreen | `render.ts:3383-3392` vs `3396-3403` — two separate `return html\`…\`` branches of `mainArea()` | different top-level template → whole main area rebuilt |
| session switch to a session **with** panel tabs | same branch, but content is `${unifiedPanelContent(activeTab)}` (`render.ts:3287`) — one pane at one part | same call site, so the iframe **element** survives but its `src` expression is re-committed → re-navigation, and the other session's panel is gone |
| session switch to a session **without** panel tabs | `if (connected && hasUnifiedPanel())` (`render.ts:3380`) falls through to the plain-chat branch (`3421`) | branch change → whole panel subtree removed |
| tab switch | `renderSidePanelWorkspace` renders only the active tab (`3287`) | non-active tab has no DOM at all |
| mobile session switch | `${panes.map(...)}` (`render.ts:3415`) is index-keyed | pane 1's element is reused for a different session's tab → `src` reassigned |

## 2. The hard constraint that shapes everything

An `<iframe>` reloads when it is removed from the document and re-inserted — and
also when it is **moved** with `appendChild`/`insertBefore`, because a move is a
remove + insert. `Node.moveBefore()` (atomic move, preserves iframe state) is
Chrome 133+ only, so it cannot be relied on.

Therefore:

> A retained pane must occupy **one DOM position for its entire lifetime**. Its
> ancestor chain must be stable across every transition we want to survive, and
> retained siblings must never be reordered.

Two consequences that drive the design:

- There is no "portal" escape: the pane cannot be hoisted to `document.body` (the
  goal already rejects that) nor moved between the split layout and the fullscreen
  layout. The **layout must be made stable**, not the pane made movable.
- The retained set is rendered in **append-only insertion order** and the visible
  pane is chosen purely by CSS (`display:none` on the others). `repeat` reorders
  DOM nodes when key order changes, which would move — and thus reload — an
  iframe. Insertion order must never depend on tab order, active tab, or LRU
  recency.

## 3. Shape of the change

### 3.1 One stable pane host inside the existing workspace

`renderSidePanelWorkspace` keeps its current chrome (tab strip, overflow menu,
measurements, action buttons — untouched). Its single content expression
(`render.ts:3287`) becomes two sibling parts:

```ts
// inside the workspace <div data-panel-workspace="content"> …
${activeTab && activeTab.kind !== "pack" ? unifiedPanelContent(activeTab) : ""}
${retain ? retainedPackPaneHost(activeTab) : (activeTab?.kind === "pack" ? unifiedPanelContent(activeTab) : "")}
```

- Non-pack panes (preview, review, proposal, inbox) keep **exactly** today's DOM
  shape and position — no extra wrapper, no behavioural change (§3.5 explains
  why they are excluded from retention in v1).
- Pack panes move one level down, into the retention host:

```ts
const retainedPackPaneHost = (activeTab: UnifiedContentTab | null) => {
  const slots = retainedPanePlan({                      // pure, new module (§4)
    activeKey: activeTab?.kind === "pack" ? panePaneKey(workspaceSessionId(), activeTab.id) : undefined,
    resolve: resolveLivePackPane,                       // liveness + tab lookup (§4.2)
  });
  return html`
    <div class="side-panel-pane-host flex-1 flex flex-col min-h-0" data-panel-pane-host="true">
      ${repeat(slots, (s) => s.key, (s) => html`
        <div
          class="side-panel-pane-slot flex-1 flex-col min-h-0"
          data-panel-pane-key=${s.key}
          data-panel-tab-id=${s.tab.id}
          data-panel-pane-hidden=${s.hidden ? "true" : "false"}
          style=${s.hidden ? "display:none" : "display:flex"}
          ?hidden=${s.hidden}
          ?inert=${s.hidden}
          aria-hidden=${s.hidden ? "true" : nothing}
        >${packPanelContent(s.tab)}</div>
      `)}
    </div>`;
};
```

`repeat` is **already imported** in `render.ts:7` and already used for the tab
strip; keyed reconciliation is the existing, well-exercised mechanism for
"same list, elements keep identity".

`keyed()` is deliberately **not** used: `keyed` forces teardown when the key
changes, which is the opposite of what we need. `cache()` is also wrong — it
detaches the DOM from the document while inactive, which reloads iframes.

### 3.2 Collapse / expand — unconditional workspace

```ts
const collapsed = isSidePanelCollapsed();
return html`
  ${reconnectBanner()}
  ${staffInboxOpenAffordance()}
  <div class="goal-split-layout side-panel-split-layout flex-1 flex min-h-0 overflow-hidden">
    <div class="${collapsed ? "flex-1" : "goal-chat-panel side-panel-chat-pane flex-1"} min-w-0 flex flex-col">…chat…</div>
    ${collapsed ? sidePanelRestoreButton() : ""}
    ${renderSidePanelWorkspace("split", { hidden: collapsed })}
  </div>`;
```

- The workspace is now **always** at the third position → its template instance,
  and therefore the pane host and every retained pane, survives collapse.
- The restore button stays **conditional**. It holds no state, and
  `tests2/browser/fixtures/preview-panel.spec.ts:168` asserts
  `getByTestId("side-panel-restore")` has *count* 0 in fullscreen — an
  always-rendered-but-hidden button would break that. Rendering/removing it is a
  separate part from the workspace, so it cannot disturb the panes.
- Collapsed layout parity: the chat pane keeps `flex-1` without
  `side-panel-chat-pane`, so the 50/50 rule
  (`app.css:1148-1159 .side-panel-split-layout > .side-panel-chat-pane{flex:0 0 50%}`)
  does not apply, and the hidden workspace contributes no width — chat is full
  width exactly as today.

### 3.3 Split ↔ fullscreen — collapse two branches into one

The desktop `fullscreen` branch (`render.ts:3383-3392`) is replaced by the same
template with two expression changes, so switching mode is an attribute/class
update rather than a rebuild:

```ts
const fullscreen = desktop && mode === "fullscreen";
<div class="${fullscreen ? "" : "goal-split-layout side-panel-split-layout"} flex-1 flex min-h-0 overflow-hidden">
  <div class="…chat classes…" style=${fullscreen ? "display:none" : ""} ?hidden=${fullscreen} ?inert=${fullscreen}>…chat…</div>
  ${collapsed ? sidePanelRestoreButton() : ""}
  ${renderSidePanelWorkspace(mode, { hidden: collapsed })}
</div>
```

Why dropping the two layout classes in fullscreen is sufficient (no new CSS):
`app.css:1148-1159` scopes the 50 % rules to
`.side-panel-split-layout > .side-panel-chat-pane` and
`.side-panel-split-layout > .side-panel-workspace`; without the parent class
neither matches, and the workspace's own `flex-1 flex flex-col` fills the row.
`border-l` is already keyed off `mode === "split"` inside
`renderSidePanelWorkspace` (`render.ts:3220`). The composer is inside
`state.chatPanel`, so hiding the chat pane hides it — the documented fullscreen
behaviour (`docs/side-panel-workspace.md` "Shared shell and controls") is
preserved.

**Display gotcha (the #1 implementation trap):** the chat pane and pane slots
carry Tailwind `flex`, whose `display:flex` beats the UA `[hidden]{display:none}`
rule. `?hidden` alone does **not** hide them. Every hide site must set inline
`style="display:none"` *and* `hidden` *and* `inert` (§5).

### 3.4 Session switch — retained siblings, and one branch condition widened

With §3.1–§3.3 in place, a switch between two sessions that both have panel tabs
already works: the workspace template instance is reused, and the pane host holds
both sessions' panes as keyed siblings with only the active one visible.

The remaining hole is switching to a session with **no** panel tabs, which today
leaves the `hasUnifiedPanel()` branch entirely. Fix:

```ts
if (connected && (hasUnifiedPanel() || hasRetainedPanes())) { … }
```

and inside that branch, to keep pixel parity with the plain-chat branch it now
also serves:

```ts
${hasUnifiedPanel() ? "" : renderArchivedBanner()}
```

`renderSidePanelWorkspace` must therefore no longer early-return `""` when there
is no active content tab (`render.ts:3212`); instead it renders the workspace
element with `hidden: true` and skips the chrome (`activeTab ? strip : ""`), so
`sidePanelActionButtons`/`sidePanelWindowControls` are never called with `null`.

### 3.5 Which panes are retained: `kind === "pack"` only (v1)

Retention is **not** opt-in for packs (no pack-facing API), but it is limited to
pack panes for a concrete reason: the other pane kinds are not safe to mount
twice, because their content functions read *global* active state instead of
taking the tab:

- `htmlPreviewContent()` (`render.ts:2869`) takes no tab argument — it derives
  entry/artifact/mtime from `activeSidePanelTabIdForSession(...)` and the
  `state.previewPanel*` mirrors, and the module singletons
  `mountedPreviewTabId` / `previewRestoreInFlight` (`render.ts:1185-1186`) assume
  one mounted preview. A hidden second preview pane would render the *active*
  session's preview into a foreign-session slot.
- `reviewPaneContent` / `inboxPaneContent` are gated on the global
  `state.reviewPanelOpen` / `state.inboxPanelOpen` booleans
  (`render.ts:3178-3181`).

`packPanelContent` is already fully tab-scoped: it derives `{packId, panelId,
params}` from the tab and threads the tab's own `source.sessionId` as
`boundSessionId` into `renderPackPanelContent` (`render.ts:3141-3172`,
`pack-panels.ts:562`), precisely so a pane can render for a session that is not
selected. That makes pack panes the only kind that is correct when hidden and
foreign today.

Extending later is a follow-up with a clear prerequisite: give
`htmlPreviewContent(tab)` / review / inbox tab-scoped signatures, then add their
kinds to the allowlist. Naming it here keeps the allowlist an explicit, testable
constant rather than a scattered condition.

`renderPackPanelContent` stays the single projection chokepoint — this change is
purely about the lifetime of the element that wraps its output.

### 3.6 Tab switch

Falls out for free (requirement 3): both tabs' panes are retained siblings in the
same host, and switching only flips `hidden`. No extra code. Tab **reorder**
(SortableJS) also becomes reload-free for pack panes, because pane order is
insertion order and no longer follows tab order.

### 3.7 Mobile slider

Two parts, and one deliberate scope-out.

- **Within a session, mobile already keeps every pane mounted**: the track renders
  `unifiedMobilePanes()` (`render.ts:1840`, `3405-3418`) and switching tabs is a
  CSS transform. Requirement 3 is already satisfied there; requirement 1 does not
  apply (mobile has no collapsed/split ladder in the track).
- **Recommended small fix**: change `${panes.map(...)}` to
  `${repeat(panes, (t) => t.id, ...)}`. Today's index-keyed map reassigns pane 1's
  iframe `src` when a tab is closed or the session changes; keying by tab id at
  least stops content bleeding between tabs.
- **Scoped out: cross-session retention on mobile.** The track's position depends
  on DOM order (`unifiedSlideX(index, count)` → `translateX(-index*100/count)`),
  so the current session's panes must be contiguous and in tab order. Retained
  foreign panes can only be appended at the tail; returning to that session would
  require *moving* the pane back into position, which reloads the iframe — the
  exact thing we are preventing. Making this work needs per-pane absolute
  positioning instead of a single track transform (a materially larger change), or
  `Node.moveBefore()` (Chrome-only). Desktop↔mobile viewport switches tear
  everything down anyway, because `render.ts:3450+` commits two different
  top-level templates.

### 3.8 Popout / deep link

`route.view === "session" && route.panelTabId` (`render.ts:3346-3366`) calls
`renderSidePanelWorkspace("fullscreen", { retain: false })`. `retain:false`
renders only the validated active tab's content inline (today's behaviour), so
the route can never surface a cached pane for a tab it did not validate, and two
live copies of one pane key can never exist in different DOM trees.

## 4. Where the cache lives

### 4.1 New module `src/app/panel-pane-retention.ts` (~70 lines, pure, no DOM)

`render.ts` is already 3555 lines and its module state (`mountedPreviewTabId`,
`mobileSelectedPaneIndex`, `panelTabVisibleCapacity`) is not unit-testable. The
retention policy is the one genuinely new piece of logic, so it goes in its own
module so `tests2/core` can drive it with plain objects.

```ts
/** Retained hidden panes, excluding the active one. Active + 2 hidden. */
export const PANEL_PANE_RETENTION_LIMIT = 3;

/** `${sessionKey}\u0000${tabId}` — sessionKey from panelWorkspaceSessionKey(). */
export function panePaneKey(sessionKey: string, tabId: string): string;
export function parsePanePaneKey(key: string): { sessionKey: string; tabId: string } | undefined;

export interface RetainedPaneSlot<T> { key: string; tab: T; hidden: boolean }

/**
 * Touch `activeKey`, drop keys whose pane is no longer live, evict beyond the
 * limit (least-recently-active first, never the active key), and return the
 * surviving slots in STABLE INSERTION ORDER.
 */
export function retainedPanePlan<T>(input: {
  activeKey?: string;
  resolve: (key: string) => T | undefined;   // liveness + tab lookup; undefined ⇒ evict
  limit?: number;
}): RetainedPaneSlot<T>[];

export function hasRetainedPanes(): boolean;      // drives the widened branch (§3.4)
export function resetPanelPaneRetention(): void;   // tests / viewport teardown
```

Internal state: `order: string[]` (append-only; insertion order = DOM order) and
`lastActiveAt: Map<string, number>` (recency, used only for eviction choice).
Evicting a middle entry removes exactly that keyed `repeat` item and does not move
its siblings.

### 4.2 Liveness is derived, never authoritative

`resolve` in `render.ts`:

```ts
const resolveLivePackPane = (key: string): UnifiedContentTab | undefined => {
  const parsed = parsePanePaneKey(key);
  if (!parsed) return undefined;
  const { sessionKey, tabId } = parsed;
  // session must still be a live (non-archived) session
  if (sessionKey !== PANEL_WORKSPACE_NO_SESSION_KEY
      && !state.gatewaySessions.some((s) => s.id === sessionKey)) return undefined;
  // tab must still be open for that session — read-only, no normalisation
  const tab = panelTabsForSession(state, sessionKey).find((t) => t.id === tabId);
  return tab && tab.kind === "pack" ? (tab as UnifiedContentTab) : undefined;
};
```

This is the guarantee that the cache can never resurrect a dead panel, and it
costs no new lifecycle hooks:

| Teardown trigger | Existing mechanism | Result |
| --- | --- | --- |
| user closes the tab | `closeSidePanelTab` (`side-panel-workspace.ts:787`) removes it from the server-authoritative workspace | `resolve` → `undefined` → slot removed next render |
| pack uninstalled / precedence change | `registerPackPanels` reconcile → `invalidatePanel` + `removePackPanelTab` (`pack-panels.ts:225-240`, `:472`) closes the tab in every session | same |
| pack disabled | marketplace mutation re-drives contributions with `invalidateLoaded`, same reconcile path | same |
| session archived / terminated | the session leaves `state.gatewaySessions` (moves to `state.archivedSessions`) | same |
| retention cap exceeded | `retainedPanePlan` eviction | `repeat` removes that item — byte-identical to today's teardown (lit removes the nodes; nothing else runs) |

Second line of defence, already in place: `renderPackPanelContent` returns
`nothing` when `{packId, panelId}` is not in the registry
(`pack-panels.ts:589-590`), so even a hypothetically stale slot renders empty.

Note `panelTabsForSession` (`panel-workspace.ts:434`) is the read-only accessor;
`unifiedPanelTabs()` must **not** be used for foreign sessions because it
normalises and writes back (`setPanelTabsForSession` + `ensureUnifiedActiveTab`).

### 4.3 Optional: freeze hidden panes with `guard`

Hidden panes are re-projected on every `renderApp()`. For a pack panel that is a
pure `render(params, host)` returning the same iframe template, so it is cheap and
correct — but it is avoidable with lit's existing `guard` directive
(`lit/directives/guard.js`, lit 3.3.1, no new dependency):

```ts
${guard(s.hidden ? [s.key, "frozen"] : [s.key, renderSeq], () => packPanelContent(s.tab))}
```

Deps stop changing once hidden, so lit skips the commit entirely and the DOM
freezes; becoming visible changes the deps and re-renders. Recommendation: ship
without `guard` first (one fewer concept), add it only if profiling shows hidden
panes costing measurable render time. Uniform wrapping matters if adopted —
switching a part between a directive result and a raw template risks a teardown.

## 5. Inertness of hidden panes

Each hidden slot gets all three, belt-and-braces:

- inline `style="display:none"` — the only reliable hide, because Tailwind `flex`
  outranks UA `[hidden]`. `display:none` alone already removes the subtree from
  layout, the tab order, and the accessibility tree, and pauses focus/`:focus`
  handling.
- `hidden` attribute — declares intent, and keeps it hidden if a future
  stylesheet touches `display`.
- `inert` — blocks focus and hit-testing even if some descendant CSS resurrects
  display (Chrome 102+, Safari 15.5+, Firefox 112+).
- `aria-hidden="true"` for redundancy against AT that walks a display-none-but-
  positioned subtree (present via `nothing` on visible slots so the attribute is
  removed, not set to `"false"`).

An `<iframe>` inside `display:none` keeps its document, JS timers and WebSockets
alive (it is not unloaded), which is exactly the retention we want; rAF and some
media are throttled/paused, which is desirable for a hidden panel.

## 6. Defect-surface accounting

New:

1. **One state owner** — `panel-pane-retention.ts` (`order`, `lastActiveAt`).
   Unavoidable: the LRU *is* the new state. Pure, no DOM, unit-testable.
2. **One transformation** — `retainedPanePlan()` (touch → drop dead → evict →
   stable order).
3. **One derivation** — `resolveLivePackPane()` in `render.ts`, composed from the
   existing `panelTabsForSession` + `state.gatewaySessions`.
4. **One DOM level** — `.side-panel-pane-host` / `.side-panel-pane-slot`, only
   around **pack** panes.
5. **Two option flags** on an existing internal function —
   `renderSidePanelWorkspace(mode, { hidden, retain })`.
6. **One widened branch condition** — `hasUnifiedPanel() || hasRetainedPanes()`,
   plus one parity conditional (`renderArchivedBanner`).
7. **One retention allowlist constant** — `kind === "pack"` in v1.

Removed / simplified (net branch count barely moves):

- the `collapsed ? restore : workspace` ternary becomes two independent parts;
- the desktop `fullscreen` branch of `mainArea()` disappears (folded into the
  split template) — one fewer top-level layout template to keep in sync;
- `renderSidePanelWorkspace`'s `if (!activeTab) return ""` early-return goes away.

Not added: no new pack-facing API (`vscode-panel` unchanged), no new server field,
no new persistence, no new registry in `pack-panels.ts`, no `MutationObserver`/
`ResizeObserver`, no portal, no CSS rules, no new npm dependency.

Existing machinery reused, with its protecting tests:

| Reused | Where | Protected by |
| --- | --- | --- |
| `repeat` keyed reconciliation | already `render.ts:7`, tab strip `:3227` | `tests2/browser/fixtures/preview-panel.spec.ts` (tab strip, overflow, drag) |
| `renderSidePanelWorkspace` chrome, `data-panel-workspace="content"`, `data-side-panel-mode` | `render.ts:3209` | `preview-panel.spec.ts:83-124` (`visibleSidePanelSizeMode`, `sidePanelControlTitles`) |
| `packPanelContent` → `renderPackPanelContent(packId, panelId, params, boundSessionId)` | `render.ts:3146`, `pack-panels.ts:562` | `tests2/dom/pack-panels-reconcile.test.ts`, `tests2/browser/e2e/extension-panel-ux.spec.ts`, `pr-walkthrough-pack.spec.ts`, `file-explorer-pack.spec.ts` |
| uninstall reconcile (`registerPackPanels` → `removePackPanelTab`) | `pack-panels.ts:225-240` | `pack-panels-reconcile.test.ts:182` ("uninstall reconcile drops the panel") |
| `panelWorkspaceSessionKey`, `panelTabsForSession`, `panelContentTabs`, `activePanelTabIdForSession` | `panel-workspace.ts:414/434/943/506` | `tests2/core/side-panel-workspace-store.test.ts`, `tests2/dom/side-panel-workspace-review-normalize.test.ts` |
| tab-strip measurement (`syncPanelTabOverflowCapacity`) | `render.ts:1294` | already bails on `width <= 0`, so a hidden strip keeps its last capacity; the host node now *persists* across collapse, so `ensurePanelTabOverflowObserver` stops re-attaching — strictly less churn |

## 7. Focused tests the test engineer should add

**`tests2/core/panel-pane-retention.test.ts`** (pure, no DOM)
- insertion order is stable while the active key moves back and forth;
- a key whose `resolve` returns `undefined` is dropped and does not come back
  after the tab "reopens" only in LRU memory (it must be re-added as a *new* key
  at the tail, never resurrected in its old position);
- eviction picks the least-recently-active key and never the active one;
- `hasRetainedPanes()` reflects live panes only.

**`tests2/dom/side-panel-pane-retention.test.ts`** (happy-dom, drives `renderApp`)
- collapse → expand: `document.querySelector('[data-panel-pane-key="…"] iframe')`
  is the **same element instance** before and after (hold a reference), and its
  `src` attribute string is unchanged; use a `MutationObserver` on
  `attributes: ["src"]` to assert **zero** `src` mutations across the transition;
- session A → B → A with pack panes in both: both slots present throughout, exactly
  one visible, element identity preserved for both, zero `src` mutations;
- session A → B where B has no panel tabs: A's slot still in the DOM and hidden,
  chat pane full width, workspace `display:none`;
- tab switch between two pack tabs: both iframes retained, zero `src` mutations;
- split → fullscreen → split: same iframe element, zero `src` mutations, chat pane
  hidden in fullscreen and `data-side-panel-mode="fullscreen"` on the workspace;
- teardown: `closeSidePanelTab(tabId)` → slot gone; simulate uninstall via
  `registerPackPanels([], projectId)` → slot gone; move the session to
  `state.archivedSessions` → slot gone; open a 4th pack pane → the
  least-recently-active slot is removed and its iframe is detached;
- inertness: every `[data-panel-pane-hidden="true"]` slot has
  `getComputedStyle().display === "none"`, `hidden`, `inert`,
  `aria-hidden="true"`, and
  `slot.querySelectorAll('a[href],button,input,select,textarea,iframe,[tabindex]')`
  yields no element whose `offsetParent`/focusability is non-null (assert
  `document.activeElement` does not land in a hidden slot after `Tab`);
- popout route: `#/session/<sid>/panel/<tabId>` renders exactly one pane and no
  retention host (`[data-panel-pane-host]` absent), and does not surface a cached
  pane for a closed tab.

**`tests2/browser/journeys/side-panel-pane-retention.journey.spec.ts`** (real
browser — the only tier that can prove an iframe did not re-navigate)
- with a pack panel whose iframe increments a counter in its own document on load
  (or a `postMessage` load beacon), assert the counter stays at 1 across:
  collapse/expand, tab switch, session switch away and back, split↔fullscreen;
- assert element identity via a marker property set on the iframe from the page
  context, and `performance.getEntriesByType("resource")` shows no second request
  for the frame URL;
- assert it returns to 2 (i.e. a real reload) after eviction/close, so the test
  can fail if retention silently retains everything forever;
- collapsed-layout regression: chat pane bounding box equals the container width
  and the restore button sits where it does today.

Existing suites that must stay green unchanged: `preview-panel.spec.ts`
(size-mode ladder, control order, fullscreen count assertions),
`extension-panel-ux.spec.ts`, `file-explorer-pack.spec.ts`,
`pr-walkthrough-pack.spec.ts`, `large-review-reopen.journey.spec.ts`,
`review-groups.journey.spec.ts`, `staff-inbox.spec.ts`.

## 8. Risks and open uncertainties

1. **Layout parity of the folded fullscreen branch** (§3.3) is the biggest
   regression risk: it is the only change that touches the visible split/fullscreen
   DOM shape. Mitigation: `preview-panel.spec.ts` already pins the mode ladder and
   control order via *visibility*, not existence. If it proves fragile, a smaller
   fallback is to keep the two branches and accept an iframe reload on
   split↔fullscreen (documented deviation) — collapse/expand and session switch,
   the reported symptoms, still work.
2. **Hidden-pane render cost** grows with retained panes (§4.3). `guard` is the
   escape hatch; the cap keeps the worst case at 3.
3. **Memory**: three live VS Code iframes is real memory. `PANEL_PANE_RETENTION_LIMIT
   = 3` is a guess; it should be a single named constant so it is trivially tuned,
   and eviction must be observable in the journey test (§7).
4. **Foreign-session host binding**: hidden panes render with their own
   `boundSessionId`, which is already the contract (`pack-panels.ts:530-560`). Any
   pack that (against contract) reads `state.selectedSessionId` instead of the
   injected `__sessionId` will now render with the wrong session while hidden.
   `vscode-panel` caches its URL per session, so it is fine; worth a note in
   `docs/extension-host-authoring.md`.
5. **`inert` support** is universal on current evergreen browsers but
   `display:none` is doing the real work, so a missing `inert` is not a
   correctness hole.
6. **Uncertain**: whether any CSS outside `app.css` targets the workspace's
   direct children by structure (`> div:nth-child(...)`). One grep found only
   `[data-panel-workspace="content"] > div:first-child > div:last-child` in
   `preview-panel.spec.ts` (the tab strip), which the new host — appended *after*
   the strip — does not disturb. Worth re-checking pack-owned CSS.
7. **Mobile cross-session retention is not delivered** (§3.7). This is a
   deliberate scope-out with a named blocker, not an oversight; it should be
   recorded in the goal outcome so nobody assumes parity.
