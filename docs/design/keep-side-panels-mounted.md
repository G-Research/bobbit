# Keep side panels mounted (hidden, not destroyed) — selected design

Status: selected. Supersedes the two exploration documents
`keep-side-panels-mounted-option-a.md` (basis of this design) and
`keep-side-panels-mounted-option-b.md` (rejected — see §7).

## Revision log

| Rev | Root cause | Reported by | Resolution |
|---|---|---|---|
| 2 | Mobile cross-session retention scoped out, contradicting "must hold for the mobile slider" | Both reviewers (corroborated) | §3.7 rewritten: per-session tracks, append-only, one visible, hidden tracks inert; visual order via CSS `order` so no DOM move; session-scoped projection inputs; shared retention owner. |
| 2 | Liveness reconciled *after* the branch deciding whether the workspace exists — one frame of empty hidden workspace with the split 50% rule | Comparative design review | §3.4/§4.1: a single render-local snapshot, `hasLiveRetainedPanes` derived from `slots.length`, raw-state `hasRetainedPanes()` removed. |
| 2 | `collapsed && fullscreen` could emit a restore button and hide the workspace in fullscreen | Gap analysis | §3.3: all collapse behaviour derived once from the single persisted `sizeMode` enum; invariant owner named. |
| 3 | **Regression introduced by rev 2's widened branch**: no visibility/layout contract when the selected session has no active content tab, or when a retained pack host coexists with an active non-pack tab. An empty `flex-1` host steals width from a non-pack pane; a retained foreign slot made the workspace occupy the split layout (chat at 50%) instead of plain-chat geometry; a persisted `fullscreen` mode with no active tab hid the chat pane behind an empty workspace. | Gap analysis | §3.1a introduces one explicit derived-flag contract (`hasActiveContentTab`, `fullscreen`, `workspaceCollapsed`, `workspaceHidden`, `workspaceOccupiesSplitLayout`, `showPackHost`) used consistently by §3.1–§3.4; the pack host is permanently present but layout-hidden unless the active tab is a pack tab. Acceptance 3a/3b and 5a added. |
| 4 | **The session-loading frame is a third mode-swapping call site.** `mainArea()` returned a standalone `bobbit-loader` template while `state.connectingSessionId` was set, and on mobile `renderApp`'s *top-level* shell branch is additionally keyed off connectedness (`if (desktop) … else if (connected) … else …`). An ordinary first switch to a not-yet-cached session therefore committed a different template and detached every retained pane — defeating the headline session-switch criterion on both viewports. | Spec-and-regression conformance + integrated implementation review (corroborated) | §3.2a: the retention snapshot is hoisted to `renderApp` scope and computed once **before** the shell branch and the loader gate, and one `panelShell(...)` call site per viewport is shared by the steady state, the connecting frame and the final frame, with the loader rendered in the incoming chat position. |
| 4 | `workspaceCollapsed` omitted `hasActiveContentTab`, so a tabless session with a stored `collapsed` mode emitted a restore rail that consumed width and could not reveal anything. | Integrated implementation review | §3.1a: `workspaceCollapsed = !fullscreen && hasActiveContentTab && mode === "collapsed"`. |
| 4 | A cross-project session switch replaces the global pack-panel registry ("last project wins"), so a retained foreign pane is either closed or re-projected with the *other* project's module. | Integrated implementation review | §4.2a: cross-project liveness is fenced without changing the `{sessionKey, tabId}` retention key; retaining across projects still requires a registry redesign. |
| 5 | The §4.2a scope guard required **both** project ids to be truthy, but `GatewaySession.projectId` is optional and an unscoped session's panels register under `headquarters`. So for a legacy/unscoped session the check was skipped entirely, and another project's same-key module could be invoked with that session's params and bound session id — a cross-project data-exposure path that exists only because retention keeps a pane that used to be destroyed. | Security review | §4.2a: the owning session's project is **canonicalised** (`projectId \|\| HEADQUARTERS_PROJECT_ID`, matching the registration path) before the comparison, and any *known* registered scope that differs prunes the pane in the same render. Unknown scope still does not prune. |
| 6 | **§4.2's teardown premise was factually wrong.** It claimed archive/terminate removes the session from `state.gatewaySessions`; `team-archived-bucket.ts` documents that a terminated session can *remain* there (and appear in both collections). Membership-only liveness therefore kept a terminal session's panel alive — breaching the goal's explicit archive/terminate teardown requirement. | Spec-and-regression conformance | §4.2: liveness now rejects a terminal owner via the app's existing `isArchivedSessionActionSource`. Acceptance 6a added. |
| 6 | The mobile active track mounts **every** content tab of the selected session, but retention only observed the *active* pack key — so an open-but-inactive pack pane with a live iframe was destroyed on a session switch even well **under** the cap. The feature retained less than the slider already had mounted. | Spec-and-regression conformance | §4.1: `retainedPanePlan` gains an `observedKeys` input, appended after `activeKey` in the given order and granted **no** recency of its own, supplied only for the connected non-transition non-popout mobile active track. Acceptance 12a added. |
| 7 | The registry-scope check alone could not tear down a cross-project source pane on the first target render because pack reconciliation is asynchronous and the registry could still describe the source project. | Validation review | §4.2a composes a synchronous selected-target project fence with the registry-scope fence. The target fence prunes before first paint; the registry fence continues to protect later registry changes. Same-project switches retain, and Headquarters canonicalization applies to both comparisons. |
| 7 | Treating the retention limit as a cap on the whole mobile track would hide valid current-session tabs. | Validation review | §3.7/§4.1 distinguish the bounded retained/hidden plan from the active mobile track, which renders every live current-session content tab even beyond the plan limit. |

### 3.2a The session-loading frame must not swap the shell

Collapse/expand and split↔fullscreen are not the only mode-swapping call sites. Two
more were found during implementation, and both destroyed retained panes:

1. **`mainArea()`'s instant-loader gate.** `if (state.creatingSession || state.connectingSessionId) return html\`…bobbit-loader…\`` runs before everything else. The ordinary first switch to a session that is not in `sessionCache` goes through it: `selectSession()` clears `state.remoteAgent` / `state.chatPanel`, the slow path sets `connectingSessionId`, and the resulting render commits the loader as the **whole** main area.
2. **The mobile top-level shell branch.** `renderApp` chooses between the mobile connected shell and the mobile disconnected shell on connectedness, so mid-connect the mobile shell swaps wholesale and everything below `#app-main` is rebuilt regardless of what `mainArea()` returns.

Rules:

- The retention snapshot is computed **once per render in `renderApp` scope**, before the
  shell branch and before the loader gate. It is no longer gated on `connected`: a
  momentarily null `state.remoteAgent` must not discard outgoing slots. The *active key*
  is still gated — there is no active key mid-transition, on a config route, or on the
  popout route.
- One `panelShell({ activeTab, retainedSlots, chatContent, transition })` call site per
  viewport serves the steady state, the connecting frame and the final frame. The loading
  affordance is passed in as `chatContent`, occupying the incoming chat position; the
  workspace, host and slots keep their sibling positions.
- Mid-transition the incoming session's active tab is treated as **absent**, so §3.1a's
  no-active-tab geometry applies (chat full width, no `side-panel-chat-pane`, workspace
  hidden). `state.chatPanel` is null then, so the outgoing chat panel cannot leak into the
  incoming session.
- **The incoming session keeps its own already-retained panes mid-transition.** A
  chat-only incoming track is wrong for the return leg: switching *back* to A makes A the
  incoming session, so a chat-only track would drop A's own retained pane for that frame
  and reload its iframe.
- The mobile tab bar is suppressed mid-transition so the incoming session's tabs are not
  claimed early.
- When **nothing** is retained, the bare `data-testid="bobbit-loader"` main area is
  unchanged — the "responsive within one render frame" intent of that gate is preserved.

Moving the snapshot earlier is necessary but **not sufficient**: an alternate loader
template still removes the host. The shell must be the same call site.


## 1. Problem and root cause, in lit terms

`renderApp()` re-renders the whole shell into one container. lit reuses DOM at a
`ChildPart` only when the committed value is a `TemplateResult` from the **same
`html``` call site**; anything else clears the part and rebuilds the subtree.
Every reported symptom is that rule firing:

| Transition | Code | Why the subtree dies |
|---|---|---|
| collapse / expand | `render.ts:3395-3401` — `${collapsed ? sidePanelRestoreButton() : renderSidePanelWorkspace("split")}` | two call sites at one part → clear + rebuild |
| split ↔ fullscreen | `render.ts:3383-3392` vs `3396-3403` — two separate `return html` branches of `mainArea()` | different top-level template → main area rebuilt |
| session switch (target **has** panel tabs) | `${unifiedPanelContent(activeTab)}` (`render.ts:3287`) — one pane at one part | element survives but `src` is re-committed → re-navigation; other session's panel gone |
| session switch (target has **no** panel tabs) | `if (connected && hasUnifiedPanel())` (`render.ts:3380`) falls through to plain-chat (`:3421`) | branch change → whole panel subtree removed |
| tab switch | only the active tab is rendered (`:3287`) | non-active tab has no DOM |
| mobile session switch | `${panes.map(...)}` (`render.ts:3415`) is index-keyed over the **selected session's** panes | pane N reused for a different session's tab → `src` reassigned; foreign session's panes removed entirely |

## 2. The hard constraint that shapes everything

An `<iframe>` reloads when removed and re-inserted, **and also when moved**
(`appendChild`/`insertBefore` = remove + insert). `Node.moveBefore()` is Chrome
133+ only, so it cannot be relied on.

> A retained pane must occupy **one DOM position for its entire lifetime**. Its
> ancestor chain must be stable across every transition we want to survive, and
> retained siblings must never be reordered.

Consequences that drive every decision below:

- **No portal.** The pane is not hoisted to `document.body` (explicitly rejected
  by the goal) and is never moved between the split and fullscreen layouts, nor
  between the mobile slider and anywhere else. **The layout is made stable, not
  the pane movable.**
- **DOM order is append-only.** Retained panes render in insertion order, which
  must never depend on tab order, active tab, or LRU recency. Where a *visual*
  order different from DOM order is required (the mobile slider), it is expressed
  with CSS `order` on a flex container — a paint-order change that moves no node.
- `keyed()` is wrong (forces teardown on key change); `cache()` is wrong
  (detaches DOM from the document → iframe reload).

## 3. The change

### 3.1a The visibility and layout contract (single source for §3.1–§3.4)

Keeping a subtree **in the DOM** and letting it **occupy layout** are two different
decisions. Rev 2 conflated them, so these flags are derived once, before any
composition, and every downstream template uses them verbatim:

```ts
const mode = sidePanelSizeMode();                 // single persisted enum, §3.3
const hasActiveContentTab = activeTab !== undefined;

// Fullscreen is meaningful only when the selected session has content to show.
const fullscreen = desktop && hasActiveContentTab && mode === "fullscreen";
const workspaceCollapsed = !fullscreen && hasActiveContentTab && mode === "collapsed";

// Retained foreign panes keep the workspace in the DOM, but never occupy layout.
const workspaceHidden = workspaceCollapsed || !hasActiveContentTab;
const workspaceOccupiesSplitLayout = !fullscreen && !workspaceHidden;

// The pack host is permanently present while retention is enabled, and visible
// only when the active tab is itself a pack tab.
const showPackHost = activeTab?.kind === "pack";
```

Rules that follow, and that the rest of this document obeys:

- `showWorkspace = hasUnifiedPanel() || hasLiveRetainedPanes` (§3.4) decides only
  whether the containing subtree stays in the DOM. **A retained foreign slot never
  makes the selected session's workspace visible or space-occupying.**
- The chat pane receives `side-panel-chat-pane` (and therefore the 50% rule) only
  when `workspaceOccupiesSplitLayout` is true — not merely when not collapsed.
- The workspace's inline `display:none` / `hidden` / `inert` state is driven by
  `workspaceHidden`.
- When `mode === "fullscreen"` but there is no active content tab, the old
  plain-chat outcome is preserved: the chat pane is **not** hidden and no empty
  fullscreen workspace is presented.
- `retainedSlots.length` must **never** be used to conditionally remove an
  already-retained host — that would detach the iframe. An empty host is hidden,
  not removed.

### 3.1 One stable pane host inside the existing desktop workspace

`renderSidePanelWorkspace` keeps its current chrome (tab strip, overflow menu,
measurements, action buttons — untouched). Its single content expression
(`render.ts:3287`) becomes two sibling parts: non-pack panes keep **exactly**
today's DOM shape and position; pack panes move one level down into a retention
host:

```ts
${hasActiveContentTab && activeTab.kind !== "pack" ? unifiedPanelContent(activeTab) : ""}
${retainAllowed ? retainedPackPaneHost(retainedSlots, showPackHost) : (showPackHost ? unifiedPanelContent(activeTab) : "")}
```

The host is emitted whenever retention is enabled — **including when `retainedSlots`
is empty and when the active tab is not a pack tab** — because removing it would
detach retained iframes. It is hidden instead, with the same contract as a hidden
slot, so an empty host never participates in flex layout and never steals width
from an active non-pack pane:

```ts
const retainedPackPaneHost = (slots: RetainedPaneSlot<UnifiedContentTab>[], showPackHost: boolean) => html`
  <div class="side-panel-pane-host flex-1 flex flex-col min-h-0" data-panel-pane-host="true"
       style=${showPackHost ? "display:flex" : "display:none"}
       ?hidden=${!showPackHost} ?inert=${!showPackHost}
       aria-hidden=${showPackHost ? nothing : "true"}>
    ${repeat(slots, (s) => s.key, (s) => html`
      <div class="side-panel-pane-slot flex-1 flex-col min-h-0"
           data-panel-pane-key=${s.key}
           data-panel-tab-id=${s.tab.id}
           data-panel-pane-hidden=${s.hidden ? "true" : "false"}
           style=${s.hidden ? "display:none" : "display:flex"}
           ?hidden=${s.hidden} ?inert=${s.hidden}
           aria-hidden=${s.hidden ? "true" : nothing}
      >${packPanelContent(s.tab)}</div>`)}
  </div>`;
```

`repeat` is already imported (`render.ts:7`) and already used for the tab strip.
Because the key sequence is append-only, `repeat` never reorders — and removing a
middle item removes exactly that keyed part without moving its siblings. The
`slots` array is the render-local snapshot from §4, never recomputed here.

### 3.2 Collapse / expand — unconditional workspace

The workspace is always emitted at a fixed position in the split layout, so its
template instance — and every retained pane — survives collapse:

```ts
<div class="goal-split-layout side-panel-split-layout flex-1 flex min-h-0 overflow-hidden">
  <div class="${workspaceOccupiesSplitLayout ? "goal-chat-panel side-panel-chat-pane flex-1" : "flex-1"} min-w-0 flex flex-col">…chat…</div>
  ${workspaceCollapsed ? sidePanelRestoreButton() : ""}
  ${renderSidePanelWorkspace(mode, { hidden: workspaceHidden, retainedSlots, showPackHost })}
</div>
```

The restore button stays **conditional on split-mode collapse** (`workspaceCollapsed`,
§3.1a/§3.3) — it holds no state, and `tests2/browser/fixtures/preview-panel.spec.ts:168`
asserts `side-panel-restore` has count 0 in fullscreen. It is a separate part from
the workspace, so rendering or removing it cannot disturb the panes.

Collapsed layout parity: the chat pane keeps `flex-1` **without**
`side-panel-chat-pane`, so the 50/50 rule
(`app.css:1148-1159 .side-panel-split-layout > .side-panel-chat-pane { flex: 0 0 50% }`)
does not match, and the hidden workspace contributes no width — chat is full width
exactly as today.

### 3.3 Split ↔ fullscreen — fold two branches into one, with a mode-derived flag

Size mode is a **single persisted per-session enum**
(`SidePanelSizeMode = "collapsed" | "split" | "fullscreen"`,
`side-panel-workspace.ts:23`, stored at `:53`, read at `:987`, written only by
`setSidePanelSizeMode` at `:866`). The three states are therefore mutually
exclusive by construction, and that store is the sole invariant owner. Even so,
all collapse behaviour is derived from `mode` in one place, so no template can
ever emit a collapsed *and* fullscreen combination:

```ts
// flags from §3.1a — note fullscreen also requires hasActiveContentTab
<div class="${fullscreen ? "" : "goal-split-layout side-panel-split-layout"} flex-1 flex min-h-0 overflow-hidden">
  <div class="${workspaceOccupiesSplitLayout ? "goal-chat-panel side-panel-chat-pane flex-1" : "flex-1"} min-w-0 flex flex-col"
       style=${fullscreen ? "display:none" : ""} ?hidden=${fullscreen} ?inert=${fullscreen}>…chat…</div>
  ${workspaceCollapsed ? sidePanelRestoreButton() : ""}
  ${renderSidePanelWorkspace(mode, { hidden: workspaceHidden, retainedSlots, showPackHost })}
</div>
```

Fullscreen explicitly ignores any retained split-collapse preference: the
workspace is visible, the chat pane is hidden, and no restore button is rendered.
But fullscreen requires `hasActiveContentTab`, so a session whose stored mode is
`fullscreen` and which has no active content tab keeps today's plain-chat outcome
(chat visible and full width, workspace hidden) rather than an empty fullscreen
main area.

No new CSS needed: `app.css:1148-1159` scopes the 50% rules to
`.side-panel-split-layout > …`; without the parent class neither matches and the
workspace's own `flex-1 flex flex-col` fills the row. `border-l` is already keyed
off `mode === "split"` (`render.ts:3220`). The composer lives inside
`state.chatPanel`, so hiding the chat pane preserves documented fullscreen
behaviour (`docs/side-panel-workspace.md`).

**Display gotcha — the #1 implementation trap:** the chat pane and pane slots
carry Tailwind `flex`, whose `display:flex` beats the UA `[hidden] { display:none }`
rule. `?hidden` alone does **not** hide them. Every hide site must set inline
`style="display:none"` *and* `hidden` *and* `inert`.

### 3.4 Session switch — one render-local liveness snapshot, then the branch

With 3.1–3.3, switching between two sessions that both have panel tabs already
works: the workspace template instance is reused and the host holds both sessions'
panes as keyed siblings with only the active one visible.

Two things must be true for the remaining cases, and **the order matters**:

1. **Liveness is reconciled exactly once per render, before the shell decides
   which branch to take.** A raw-state `hasRetainedPanes()` predicate would be
   wrong: on the render caused by closing the last retained tab, an uninstall
   reconcile, or the source session becoming terminal or disappearing, a state-only
   predicate is still true, the shell enters the workspace branch, and only then
   does pruning empty the host — leaving one frame of empty hidden workspace with
   the split 50% rule still applied to the chat pane. Teardown must be
   indistinguishable from today's in a *single* render.

   ```ts
   // once, at the common render entry, before any branch decision
   const retainedSlots = retainAllowed
     ? retainedPanePlan({ activeKey, resolve: resolveLivePackPane })   // resolve → prune → touch → evict
     : [];
   const hasLiveRetainedPanes = retainedSlots.length > 0;
   const showWorkspace = hasUnifiedPanel() || hasLiveRetainedPanes;
   ```

   `retainedPanePlan` is the only mutator of retention state and is called **at
   most once per render**. The resulting `retainedSlots` array is threaded into
   `renderSidePanelWorkspace` / `retainedPackPaneHost` / the mobile track. There
   is no separate `hasRetainedPanes()` raw-state predicate.

2. **The branch condition is widened** so a session with no panel tabs does not
   drop the whole panel subtree:

   ```ts
   if (connected && showWorkspace) { … }
   ${hasUnifiedPanel() ? "" : renderArchivedBanner()}   // pixel parity with the plain-chat branch
   ```

`renderSidePanelWorkspace` must therefore no longer early-return `""` when there
is no active content tab (`render.ts:3212`); it renders the workspace element with
`hidden: workspaceHidden` — which is `true` in exactly this case by §3.1a — and
skips the chrome (`activeTab ? strip : ""`), so `sidePanelActionButtons` /
`sidePanelWindowControls` are never called with `null`. Because
`workspaceOccupiesSplitLayout` is false, the chat pane does not receive
`side-panel-chat-pane`, so the 50% rule does not apply and the geometry is the
plain-chat geometry in that same render.

### 3.5 Retention scope: `kind === "pack"` only (v1)

Not opt-in for packs (no pack-facing API change), but limited to pack panes for a
concrete correctness reason: the other pane kinds read **global** active state
rather than taking the tab, so they are unsafe to mount twice.

- `htmlPreviewContent()` (`render.ts:2869`) takes no tab argument — it derives
  entry/artifact/mtime from `activeSidePanelTabIdForSession(...)` and the
  `state.previewPanel*` mirrors, and module singletons `mountedPreviewTabId` /
  `previewRestoreInFlight` (`render.ts:1185-1186`) assume one mounted preview.
- `reviewPaneContent` / `inboxPaneContent` are gated on the global
  `state.reviewPanelOpen` / `state.inboxPanelOpen` booleans (`render.ts:3178-3181`).

`packPanelContent` is already fully tab-scoped: it derives `{packId, panelId,
params}` from the tab and threads the tab's own `source.sessionId` as
`boundSessionId` into `renderPackPanelContent` (`render.ts:3141-3172`,
`pack-panels.ts:562`) precisely so a pane can render for a non-selected session.
`renderPackPanelContent` remains the single projection chokepoint — this change is
purely about the lifetime of the element wrapping its output.

Extending to other kinds is a follow-up with a named prerequisite (tab-scoped
`htmlPreviewContent(tab)` / review / inbox signatures), so the allowlist is an
explicit, testable constant rather than a scattered condition.

### 3.6 Tab switch

Falls out for free: both tabs' panes are retained siblings in one host; switching
flips `hidden`. Tab **reorder** (SortableJS) also becomes reload-free for pack
panes, because pane DOM order is insertion order and no longer follows tab order.

### 3.7 Mobile slider — per-session tracks

Mobile is **in scope for both dimensions**. Today the mobile shell renders one
horizontal track containing the selected session's panes:

```ts
const panes = unifiedMobilePanes();                        // chat pane + unifiedPanelTabs()
const count = panes.length, curIdx = unifiedMobilePaneIndex();
<div class="side-panel-slider__track" style="display:flex;width:${count*100}%;transform:translateX(${unifiedSlideX(curIdx,count)}%);">
  ${panes.map(tab => html`<div style="width:${100/count}%;…">${mobilePaneContent(tab)}</div>`)}
</div>
```

Tab switching is already a CSS transform, so the **tab** dimension is already
mounted-and-kept within a session. The **session** dimension is not: the iterable
only ever contains the selected session's panes, so A → B removes A's panes and
B → A rebuilds them.

The design is a **per-session track**, which is the only shape that keeps each
pane's ancestor chain intact:

```ts
<div class="side-panel-slider preview-slider flex-1 min-h-0" style="overflow:hidden;position:relative;">
  ${repeat(trackKeys, (k) => k, (k) => mobileSessionTrack(k))}
</div>
```

- `trackKeys` is **append-only** in first-seen order: the active session key plus
  every session key still present in `retainedSlots` (§4). A track is created once
  per session key and never moved.
- Exactly one track is visible — the active session's. Every other track carries
  the same inertness contract as a hidden desktop slot (§5): inline
  `display:none`, `hidden`, `inert`, `aria-hidden="true"`.
- **Each track computes its own geometry from its own tabs.** The active track's
  panes are `mobileSessionPanes(sessionKey)` = the mobile chat pane plus that
  session's content tabs, `count`/`width`/`translateX` exactly as today. A hidden
  foreign track contains **only its retained pack panes** — never the chat pane,
  because `state.chatPanel` is a single element instance that can exist in one
  place — and its transform is irrelevant while hidden.
- **Within a track, pane DOM order is append-only insertion order; visual order is
  CSS `order`.** The track is already `display:flex`, so each pane slot gets
  `style="order:<visualIndex>"` where `visualIndex` is its position in the
  session's current pane list (chat pane = 0). `order` changes paint position
  without moving a node, so a tab reorder, a tab close, or a pack pane that was
  created before the chat pane all lay out correctly with zero DOM moves. The
  slide transform continues to use the **visual** index and that track's own pane
  count, so `unifiedSlideX(curIdx, count)` is unchanged.
- **Session-scoped inputs, not globals.** `unifiedMobilePanes()` (`render.ts:1840`)
  and `mobilePaneContent` (`render.ts:3298`) are refactored to take an explicit
  `{ sessionKey, tabs, activeTabId }` rather than deriving from the selected
  session. Foreign tabs must be read with `panelTabsForSession`
  (`panel-workspace.ts:434`) — **never** `unifiedPanelTabs()`, which normalises and
  writes back. `unifiedMobilePaneIndex()` and the module state it owns
  (`mobileSelectedPaneIndex`, `mobileSelectedSideTabId`, `render.ts:1187`,
  `:1845-1859`) keep their current meaning and apply to the **active** track only.
- **Drag handlers bind to the visible track.** The touch/pointer handlers that
  write `track.style.transform` directly (`render.ts:1890-1980`) must select
  `[data-mobile-pane-track][data-mobile-track-active="true"]`, and their `count`
  must be the active track's pane count. A hidden track is never dragged.
- **The widened branch applies on mobile too** (§3.4), and mobile agrees with
  desktop about the no-active-tab case: A stays mounted, hidden and inert, while
  the selected session B shows its plain chat. In that case B's active track holds
  exactly one pane (chat) at `width:100%` with `translateX(0)` — structurally the
  same DOM the slider already produces for pane 0 of a panel-having session. Size
  mode does not apply on mobile, so the `fullscreen`/`workspaceCollapsed` flags of
  §3.1a are desktop-only. This chat-only track must be pixel-identical to today's
  bare-chat branch and must not change mobile scroll-tracking setup; both are
  pinned by tests (§10). **Mid-transition (§3.2a) the active track is chat pane
  plus that session's already-retained panes** — not chat-only, which would drop the
  incoming session's own pane on the return leg.
- **The mobile top-level shell branch is itself connectedness-keyed** and must be
  held stable while panes are retained — see §3.2a. Fixing only `mainArea()` leaves
  mobile broken.
- `app.css:733-735` (`[data-mobile-header] .side-panel-pane[data-panel-tab-id]`
  top padding) keys off the pane element, which is unchanged.

Retention policy is **shared with desktop**: one owner, one `{sessionKey, tabId}`
key space, one LRU limit (§4). The limit bounds panes carried by the retention
plan, including hidden foreign tracks; it does **not** truncate the active mobile
track, which continues to render every live content tab for the selected session.
Keys are viewport-independent and contain no project component. A desktop↔mobile
viewport flip still commits different top-level templates and therefore tears all
DOM down — today's behaviour; the shell calls `resetPanelPaneRetention()` on the
flip so the policy state cannot describe DOM that no longer exists.

### 3.8 Popout / deep link

`route.view === "session" && route.panelTabId` (`render.ts:3346-3366`) calls
`renderSidePanelWorkspace("fullscreen", { retain: false })`. With `retain:false`
the render-local snapshot is empty (§3.4), so only the validated active tab's
content renders inline (today's behaviour): the route can never surface a cached
pane for a tab it did not validate, never instantiates the retention host or the
mobile per-session tracks, and two live copies of one pane key can never exist in
different DOM trees.

## 4. Where the cache lives

### 4.1 New module `src/app/panel-pane-retention.ts` (~70 lines, pure, no DOM)

`render.ts` is already 3555 lines and its module state is not unit-testable, so
the one genuinely new piece of logic gets its own module drivable from
`tests2/core` with plain objects.

```ts
/** Maximum retained-plan slots; the active mobile track is outside this bound. */
export const PANEL_PANE_RETENTION_LIMIT = 3;

/** `${sessionKey}\u0000${tabId}` — sessionKey from panelWorkspaceSessionKey(). */
export function panePaneKey(sessionKey: string, tabId: string): string;
export function parsePanePaneKey(key: string): { sessionKey: string; tabId: string } | undefined;

export interface RetainedPaneSlot<T> {
  key: string;
  sessionKey: string;
  tab: T;
  hidden: boolean;
}

/**
 * Append `activeKey`, then `observedKeys` in caller order; resolve and prune dead
 * keys; touch only `activeKey`; then evict beyond the limit
 * (least-recently-active first, never the active key). Returns surviving slots in
 * STABLE INSERTION ORDER. The ONLY mutator of retention state, called at most
 * once per render (§3.4).
 */
export function retainedPanePlan<T>(input: {
  activeKey?: string;
  observedKeys?: readonly string[];
  resolve: (key: string) => T | undefined;   // liveness + tab lookup; undefined ⇒ evict
  limit?: number;
}): RetainedPaneSlot<T>[];

export function resetPanelPaneRetention(): void;   // tests / desktop↔mobile viewport flip
```

Internal state: `order: string[]` (append-only; insertion order = DOM order) and
`lastActiveAt: Map<string, number>` (recency, used only to choose an eviction
victim). `observedKeys` describes panes the caller already mounted — currently the
inactive pack tabs in the selected mobile track. New observed keys append after
`activeKey` in the supplied order, but observation never grants recency; only
activation does. This preserves append-only DOM identity while making an
observed-but-never-active pane the first eviction candidate. Evicting a middle
entry removes exactly that keyed `repeat` item and does not move its siblings.

`PANEL_PANE_RETENTION_LIMIT` bounds this plan's retained slots, not all panes in
the selected mobile track. That track renders all of its live current-session tabs
for slider correctness; only the subset carried into hidden/foreign retention is
bounded.

There is deliberately **no** `hasRetainedPanes()` raw-state predicate — callers
derive `hasLiveRetainedPanes` from `retainedPanePlan(...).length` (§3.4), so
liveness can never lag the branch decision.

### 4.2 Liveness is derived, never authoritative

```ts
const resolveLivePackPane = (key: string): UnifiedContentTab | undefined => {
  const parsed = parsePanePaneKey(key);
  if (!parsed) return undefined;
  const { sessionKey, tabId } = parsed;
  const noSession = sessionKey === PANEL_WORKSPACE_NO_SESSION_KEY;
  const ownerSession = noSession ? undefined : state.gatewaySessions.find((s) => s.id === sessionKey);

  // A terminal session can remain in gatewaySessions and can also be present in
  // archivedSessions. Collection membership is therefore not the lifecycle test.
  if (!noSession && (!ownerSession || isArchivedSessionActionSource(ownerSession))) return undefined;

  const tab = panelTabsForSession(state, sessionKey).find((t) => t.id === tabId);
  if (!tab || tab.kind !== "pack") return undefined;

  // Project liveness has two independent fences; see §4.2a.
  const ownerProjectId = ownerSession?.projectId || HEADQUARTERS_PROJECT_ID;
  const selectedSession = state.selectedSessionId
    ? state.gatewaySessions.find((s) => s.id === state.selectedSessionId)
      ?? state.archivedSessions.find((s) => s.id === state.selectedSessionId)
    : undefined;
  const selectedProjectId = selectedSession
    ? selectedSession.projectId || HEADQUARTERS_PROJECT_ID
    : undefined;
  if (selectedProjectId !== undefined && selectedProjectId !== ownerProjectId) return undefined;

  const ref = packPanelRefFromTabId(tab.id);
  const registeredProjectId = ref ? packPanelProjectId(ref.packId, ref.panelId) : undefined;
  if (registeredProjectId !== undefined && registeredProjectId !== ownerProjectId) return undefined;
  return tab as UnifiedContentTab;
};
```

This is the guarantee that the cache can never resurrect a dead panel, and it adds
no new lifecycle hooks:

| Teardown trigger | Existing mechanism | Result |
|---|---|---|
| user closes the tab | `closeSidePanelTab` (`side-panel-workspace.ts:787`) removes it from the server-authoritative workspace | `resolve` → `undefined` → slot pruned in the **same** render, before the branch decision |
| pack uninstalled / precedence change | `registerPackPanels` reconcile → `invalidatePanel` + `removePackPanelTab` (`pack-panels.ts:225-240`, `:472`) closes the tab in every session | same |
| pack disabled | marketplace mutation re-drives contributions with `invalidateLoaded`, same reconcile path | same |
| session archived / terminated | `isArchivedSessionActionSource(ownerSession)` rejects `archived: true`, `status: "archived"`, and `status: "terminated"`, even if the record remains in one or both session collections | slot pruned in the same render |
| retention cap exceeded | `retainedPanePlan` evicts a retained/hidden slot | `repeat` removes that item; the selected mobile track still renders all live current-session tabs |
| desktop↔mobile viewport flip | `resetPanelPaneRetention()` on the shell flip | all DOM torn down (today's behaviour), policy state cleared |
| session switched to another **project** | synchronous selected-target fence plus registered-project scope fence (§4.2a) | source pane pruned on the first target render; a foreign registered module is also rejected later |

### 4.2a Cross-project teardown uses two fences (deliberate limitation)

The retention key remains `${sessionKey}\u0000${tabId}`. Project does **not** belong
in that key: same-project session switches need to resolve to stable sibling keys,
and changing the retention identity would obscure rather than enforce the pack
registry's actual scope.

The registry is a single global "last requested project wins" map keyed by
`{packId, panelId}`. A canonical session switch requests registration for the target
session's project asynchronously. That creates two distinct times at which liveness
must be safe:

1. **Selected-target project fence — synchronous selection time.** Session selection
   updates `state.selectedSessionId` before rendering. Retention resolves that id from
   the live or archived session collection and compares the known target's effective
   project with each retained owner. A cross-project source pane is pruned immediately,
   even while the registry still describes the source project; a same-project source
   pane passes and remains mounted. If the selected id is not in either collection yet,
   its project is unknown and this fence does not prune, which avoids treating an
   incompletely hydrated new or restored session as Headquarters.
2. **Registry-scope fence — projection time.** If the current registration has a
   known project, it must match the retained owner's effective project. This blocks
   a later reconcile, precedence change, or registry replacement from projecting a
   foreign project's module into an old retained slot.

The first fence is necessary because the registry fence alone is temporarily stale:
on the first render after A(project A) → B(project B), the asynchronous B reconcile
may not have completed, so A's registration still matches A's pane and cannot prove
that the selected destination changed. The selected-target fence closes that first-
render gap. The second fence remains necessary because registry state can change
after selection and is the authority for the module that would actually be invoked.

All comparisons of **known** sessions use the same effective-project rule as
registration and the server: a missing or empty `projectId` canonicalises to
`HEADQUARTERS_PROJECT_ID`. That applies to the pane owner and selected target,
including the sessionless workspace sentinel. Canonicalization is load-bearing:
raw optional-id comparison would exclude unscoped or legacy Headquarters sessions
from cross-project teardown.

An unknown registered scope does not fail the registry-scope fence because
`packPanelProjectId()` cannot distinguish an unregistered panel from a global/no-
project registration. Pruning on that ambiguity would destroy an active pane during
the post-reload window before contributions reconcile. The synchronous selected-
target fence still handles known cross-project navigation, while a genuine uninstall
uses the existing reconcile path to close the tab.

Consequences: same-project session switches retain panes; cross-project switches
tear source panes down on the first target render; and a foreign project's module
cannot later project into a retained slot.

**Retaining panes *across* projects is out of scope.** It requires re-keying
registrations, loaded modules, in-flight loads and generation state by
`{projectId, packId, panelId}` and threading a bound project through the render path —
a redesign of the pack-panel registry. Cross-project switching destroyed panels
before this feature, so this limitation is not introduced by retention.

Second line of defence, already in place: `renderPackPanelContent` returns
`nothing` when `{packId, panelId}` is not in the registry (`pack-panels.ts:589-590`).
Because hidden panes are **re-projected on every render** in v1 (no freezing), the
async window inside `removePackPanelTab` cannot leave stale DOM on screen — so no
new registry predicate is needed.

### 4.3 Deferred: freezing hidden panes with `guard`

Hidden panes re-project on every `renderApp()`. For a pack panel that is a pure
`render(params, host)` returning the same iframe template, so it is cheap and
correct. `guard` (`lit/directives/guard.js`, no new dependency) is the escape hatch
if profiling shows cost; **not** shipped in v1 (one fewer concept, and
re-projection is what closes the uninstall race above).

### 4.4 Interaction with marketplace pack hot reload (dev only)

`invalidatePackPanelModules(packId, token)` (`pack-panels.ts`) sets a per-key
development reload token and calls `invalidatePanel(key)`, which drops
`loadedPanels` / `inFlight` and bumps the load generation; the Vite
`bobbit:pack-rebuilt` handler then calls `renderApp()`. Because hidden panes are
**re-projected every render** (§4.3), both visible and hidden retained panes miss
`loadedPanels` on that next render and lazily re-import the fresh bytes.

Two consequences worth stating so neither is later mistaken for a defect:

- A hidden retained pane can **never** keep projecting pre-rebuild bytes — the
  freeze that `guard` would have introduced is exactly what would have broken this,
  which is a second reason §4.3 stays deferred.
- A dev hot reload **does** destroy the retained iframe for the rebuilt pack's
  panes, hidden ones included, and remounts them from the new module. That is
  correct — new bytes are the entire point — and it is dev-only: no production path
  calls `invalidatePackPanelModules`. None of the acceptance criteria (collapse /
  expand, tab switch, session switch, the size-mode ladder) are affected.

Hot reload does not touch the `panels` registry itself, so `packPanelProjectId`
still reports the last registration's project and the §4.2a scope rules are
unchanged.

## 5. Inertness of hidden panes and hidden mobile tracks

Each hidden slot and each hidden mobile session track gets all four,
belt-and-braces:

- inline `style="display:none"` — the only reliable hide (Tailwind `flex` outranks
  UA `[hidden]`). `display:none` alone already removes the subtree from layout, tab
  order and the accessibility tree.
- `hidden` attribute — declares intent, survives future stylesheet churn.
- `inert` — blocks focus and hit-testing even if some descendant CSS resurrects
  display.
- `aria-hidden="true"` — redundancy for AT; emitted via `nothing` on visible slots
  so the attribute is **removed**, never set to `"false"`.

An `<iframe>` inside `display:none` keeps its document, timers and sockets alive
(it is not unloaded) — exactly the retention we want; rAF and some media are
throttled, which is desirable for a hidden panel.

## 6. Defect-surface accounting

New:
1. **One state owner** — `panel-pane-retention.ts` (`order`, `lastActiveAt`),
   shared by desktop and mobile. The LRU *is* the new state. Pure, no DOM,
   unit-testable.
2. **One transformation** — `retainedPanePlan()` (resolve → prune → touch → evict
   → stable order), called at most once per render.
3. **One derivation** — `resolveLivePackPane()`, composed from existing tab state,
   terminal-session classification, synchronously selected target scope, and pack
   registration scope.
4. **One DOM level on desktop** — `.side-panel-pane-host` / `.side-panel-pane-slot`,
   only around pack panes.
5. **One DOM level on mobile** — per-session track wrappers inside the existing
   slider, plus `order` on existing pane slots. No new slider, no new transform
   mechanism.
5a. **One derived-flag contract** (§3.1a): `hasActiveContentTab`, `fullscreen`,
   `workspaceCollapsed`, `workspaceHidden`, `workspaceOccupiesSplitLayout`,
   `showPackHost` — six locals computed once per render, replacing ad-hoc
   conditions scattered across the templates.
6. **Session-scoped signatures** for `unifiedMobilePanes()` / `mobilePaneContent`
   (parameters replacing global reads) — a narrowing, not a new abstraction.
7. **Three option flags** on an existing internal function —
   `renderSidePanelWorkspace(mode, { hidden, retainedSlots, showPackHost })`.
8. **One widened branch condition** — `hasUnifiedPanel() || hasLiveRetainedPanes`,
   applied identically on desktop and mobile, plus one parity conditional
   (`renderArchivedBanner`).
9. **One retention allowlist** — `kind === "pack"` in v1.
10. **One derived flag** — `workspaceCollapsed = !fullscreen && mode === "collapsed"`
   (part of the §3.1a contract).

Removed / simplified:
- the `collapsed ? restore : workspace` ternary becomes two independent parts;
- the desktop `fullscreen` branch of `mainArea()` disappears (folded into the split
  template) — one fewer top-level layout template to keep in sync;
- `renderSidePanelWorkspace`'s `if (!activeTab) return ""` early-return goes away;
- the mobile index-keyed `panes.map` is replaced by keyed tracks, removing the
  existing index-rebinding bug where pane N's iframe `src` is reassigned when a tab
  closes or the session changes.

Not added: no pack-facing API change (`vscode-panel` unchanged), no server field,
no persistence, no new registry in `pack-panels.ts`, no `MutationObserver` /
`ResizeObserver`, no portal, no DOM move, no new npm dependency, **no imperative
DOM owner outside lit and no second lit render root**.

Existing machinery reused, with its protecting tests:

| Reused | Where | Protected by |
|---|---|---|
| `repeat` keyed reconciliation | `render.ts:7`, tab strip `:3227` | `tests2/browser/fixtures/preview-panel.spec.ts` |
| workspace chrome, `data-panel-workspace="content"`, `data-side-panel-mode` | `render.ts:3209` | `preview-panel.spec.ts:83-124` |
| slider track + `unifiedSlideX` + drag handlers | `render.ts:1874-1980`, `:3405-3418` | existing mobile slider specs |
| `packPanelContent` → `renderPackPanelContent(packId, panelId, params, boundSessionId)` | `render.ts:3146`, `pack-panels.ts:562` | `tests2/dom/pack-panels-reconcile.test.ts`, `tests2/browser/e2e/extension-panel-ux.spec.ts`, `pr-walkthrough-pack.spec.ts`, `file-explorer-pack.spec.ts` |
| uninstall reconcile (`registerPackPanels` → `removePackPanelTab`) | `pack-panels.ts:225-240` | `pack-panels-reconcile.test.ts:182` |
| `panelWorkspaceSessionKey`, `panelTabsForSession`, `panelContentTabs`, `activePanelTabIdForSession` | `panel-workspace.ts:414/434/943/506` | `tests2/core/side-panel-workspace-store.test.ts`, `tests2/dom/side-panel-workspace-review-normalize.test.ts` |
| single persisted `sizeMode` enum | `side-panel-workspace.ts:23/53/866/987` | `preview-panel.spec.ts` mode ladder |
| tab-strip measurement (`syncPanelTabOverflowCapacity`) | `render.ts:1294` | already bails on `width <= 0`; the host now persists across collapse so `ensurePanelTabOverflowObserver` stops re-attaching — strictly less churn |

## 7. Why Option B was rejected

Option B (imperative panel-host stack: a binding-free container whose children are
created imperatively, each its own lit render root, synced from a post-render pass)
was rejected. Its core criticism of this design — that `repeat()` **moves** DOM
nodes and would therefore re-navigate an iframe — is real but fully answered by
making the key sequence append-only and independent of tab order and LRU recency;
removal of a middle keyed item moves no siblings, and visual reordering is done
with CSS `order`. Both options need the same single-template restructure, so that
is not a differentiator.

What B costs beyond this design: a DOM subtree lit does not know about (it must
detect "stack lost" itself via `parentElement` checks), N extra lit render roots
that leak if eviction forgets `render(nothing, el)`, a load-bearing imperative DOM
contract, a new post-render sync ordering hazard, plus two behaviour changes this
design avoids (hidden panes frozen, and the chat pane rendered-but-hidden in
fullscreen requiring `follow-tail.ts` scroll re-validation). It also missed the
no-panel-tabs session branch, where its stack dies with the workspace.

What B buys: zero render cost for hidden panes. Deferred here to the existing
`guard` directive if profiling justifies it; re-projection is currently
load-bearing for the uninstall race (§4.2).

Retained from B: the `display:none` relayout risk for heavyweight framed apps
(§8.2) and keeping the retention limit a single named constant.

## 8. Risks and open uncertainties

1. **Layout parity of the folded fullscreen branch** (§3.3) is the biggest desktop
   regression risk — the only change touching the visible split/fullscreen DOM
   shape. `preview-panel.spec.ts` already pins the mode ladder and control order by
   *visibility*, not existence. Documented fallback if it proves fragile: keep the
   two branches and accept an iframe reload on split↔fullscreen; collapse/expand
   and session switch still work.
2. **Relayout of a heavyweight framed app on reveal.** `display:none` does not
   unload the iframe, but its viewport is 0×0 while hidden and Monaco caches
   measurements. VS Code web uses its own `ResizeObserver`, which should recover on
   reveal; nothing is dispatched into the frame in v1. Verify in the browser spec.
3. **Memory**: retained hidden VS Code iframes consume real memory.
   `PANEL_PANE_RETENTION_LIMIT` is the tunable bound for retained-plan slots, and
   eviction must be observable in the browser spec. The active mobile track may
   exceed that bound because all of its live current-session tabs must remain
   available to the slider; switching away carries only bounded survivors.
4. **Mobile slider parity** is the biggest mobile regression risk: per-session
   tracks change the slider's child structure, and the drag handlers now select the
   active track. Existing slider behaviour (drag threshold, snap, transform values)
   must be unchanged for the active session, and the chat-only track case (§3.7)
   must be pixel-identical to today's bare-chat branch.
5. **Foreign-session host binding**: hidden panes render with their own
   `boundSessionId`, already the contract (`pack-panels.ts:530-560`). A pack that
   (against contract) reads `state.selectedSessionId` instead of injected
   `__sessionId` renders with the wrong session while hidden. `vscode-panel` caches
   its URL per session, so it is fine — worth a note in
   `docs/extension-host-authoring.md`.
6. **Structural CSS**: one grep found only
   `[data-panel-workspace="content"] > div:first-child > div:last-child` (the tab
   strip) in `preview-panel.spec.ts`; the new host is appended *after* the strip.
   Re-check pack-owned CSS during implementation.

## 9. Acceptance criteria (testable)

Desktop:
1. Collapse then expand: the panel's `<iframe>` is the **same element instance**
   and a `MutationObserver` on `attributes: ["src"]` records **zero** `src`
   mutations.
2. Session A → B → A (both with pack panes): both slots present throughout, exactly
   one visible, element identity preserved for both, zero `src` mutations.
3. Session A → B where B has **no** panel tabs: A's slot remains in the DOM and
   hidden; chat pane is full width and visible; workspace computes `display:none`;
   the chat pane does **not** carry `side-panel-chat-pane`. Asserted after exactly
   one render.
3c. **Cold** switch A → B where B is not in `sessionCache`: on the connecting frame
   (`connectingSessionId = B`, outgoing `remoteAgent`/`chatPanel` cleared) A's iframe
   is still connected, hidden and identical with zero `src` mutations; the loading
   affordance is visible in the incoming chat position; and the same holds on the
   return leg, where A is itself the connecting session and keeps its own retained
   pane. Holds on desktop and mobile (§3.2a).
3d. Cold switch with **nothing** retained still renders the bare
   `[data-testid="bobbit-loader"]` as the whole main area.
3e. A(pack) → B(no panel tabs, stored `sizeMode: "collapsed"`) → A: no
   `[data-testid="side-panel-restore"]` rail, chat at full row width, A's iframe alive.
3f. Session switched to a different **project**: A's pane is pruned on the first
   target render while B's asynchronous pack reconcile is still pending, no stale DOM
   remains, and B's module is never projected into A's slot (§4.2a). This holds for an
   **unscoped** known owner or target, whose effective project is Headquarters. A same-
   project switch retains the pane. An unknown selected target or unknown panel
   registration scope does not by itself prune.
3a. Same as 3 but B's stored size mode is `fullscreen`: identical outcome — chat
   visible and full width, no empty fullscreen workspace, no hidden chat pane.
3b. Active tab switches from a pack tab to a non-pack tab (preview/review/inbox)
   in the same session: the non-pack content keeps its prior full panel width, the
   retained pack host computes `display:none` and is `hidden`/`inert`, and the pack
   pane's iframe keeps its element identity with zero `src` mutations. Switching
   back reveals the same iframe.
4. Tab switch between two pack tabs: both iframes retained, zero `src` mutations.
5. Split → fullscreen → split: same iframe element, zero `src` mutations, chat pane
   hidden in fullscreen, `data-side-panel-mode="fullscreen"` on the workspace, and
   **no** `[data-testid="side-panel-restore"]` in fullscreen even when the stored
   mode was previously `collapsed`.
5a. A retained foreign slot never makes the selected session's workspace visible
   or space-occupying: with retention non-empty and the selected session having no
   active content tab, `[data-panel-pane-host]` and the workspace are present but
   `display:none`.
6. Teardown, each in a **single** render: `closeSidePanelTab(tabId)` → slot gone;
   `registerPackPanels([], projectId)` (uninstall) → slot gone; the owner satisfies
   `isArchivedSessionActionSource` → slot gone even if its record remains in one or both
   session collections; adding retained candidates beyond
   `PANEL_PANE_RETENTION_LIMIT` → the least-recently-active retained slot removed and
   its iframe detached. In each case, if no live retained pane remains and the selected
   session has no panel tabs, the shell immediately shows the plain-chat geometry and
   archived-banner behaviour — no second render required.
6a. A terminal owner still present in `state.gatewaySessions` also tears down, for each
   of `status: "terminated"`, `status: "archived"` and `archived: true`, and when the
   session is in **both** `gatewaySessions` and `archivedSessions`. A live owner that is
   neither archived nor terminated must **not** be pruned (guards over-pruning). Holds
   on desktop and mobile.
7. Inertness: every `[data-panel-pane-hidden="true"]` slot has computed
   `display: none`, `hidden`, `inert`, `aria-hidden="true"`; `Tab` from the composer
   never lands inside a hidden slot; the browser a11y snapshot contains no node from
   a hidden slot.
8. Popout route `#/session/<sid>/panel/<tabId>` renders exactly one pane, no
   retention host (`[data-panel-pane-host]` absent) and no per-session mobile
   tracks, and never surfaces a cached pane for a closed tab.
9. Collapsed layout and visible-panel layout are pixel-unchanged (chat pane bounding
   box equals container width when collapsed; restore button in its current
   position).

Mobile (viewport at mobile width):
10. Session A(pack) → B(pack) → A: A's iframe is the same object, zero `src`
    mutations, exactly one visible track, hidden foreign track inert.
11. Session A(pack) → B(no panel tabs) → A: same, and B's shell is pixel-identical
    to today's bare-chat rendering with mobile scroll tracking still initialised.
12. Within-session tab switch and tab reorder: zero `src` mutations, pane DOM order
    unchanged, visual order follows tab order via `order`, slide transform matches
    `unifiedSlideX(visualIndex, count)` for the active track.
12a. An **open-but-inactive** pack pane in the active track survives a session
    round-trip when it survives the retained-plan cap: same iframe object, still
    connected in the hidden track, zero `src` mutations — including when the active tab
    is a *non-pack* tab, so only `observedKeys` can retain it. The active track itself
    still shows every live current-session tab when its count exceeds the cap.
13. Mobile teardown: close, pack disable/uninstall, session archive/terminate, and
    LRU eviction each destroy the slot while its track is hidden.

Real-browser (only tier that can prove no re-navigation):
14. A framed document's own load counter stays at 1 across collapse/expand, tab
    switch, desktop session round-trip, split↔fullscreen, **and** the mobile session
    round-trip — and returns to 2 after eviction/close, so the test fails if
    retention silently retains forever.

## 10. Test plan by tier

- **`tests2/core/panel-pane-retention.test.ts`** (pure): insertion order stable
  while the active key moves back and forth; a key whose `resolve` returns
  `undefined` is dropped and, if reopened, is re-added as a **new** key at the tail
  (never resurrected in its old position); eviction picks least-recently-active and
  never the active key; the plan is the only state mutator and is idempotent for a
  given input; `resetPanelPaneRetention()` clears everything.
- **`tests2/dom/side-panel-pane-retention.test.ts`** (happy-dom, drives
  `renderApp` at desktop width): criteria 1–9, including 3a, 3b, 3c–3f and 5a. Use
  `MutationObserver` on `src` for the zero-mutation assertions, and drive **exactly
  one** render after each terminal liveness event for criteria 3, 3a and 6.
- **`tests2/dom/mobile-pane-retention.test.ts`** (happy-dom, mobile width):
  criteria 10–13, including the chat-only-track parity check and `order` values.
- **`tests2/browser/fixtures/side-panel-pane-retention.spec.ts`** (Playwright):
  criterion 14 plus keyboard/a11y inertness, collapsed-layout geometry, and the
  mobile session round-trip at a mobile viewport. Registered in
  `tests2/tests-map.json`.
- **Existing suites that must stay green unchanged**: `preview-panel.spec.ts`,
  `side-panel-tabs.spec.ts`, `extension-panel-ux.spec.ts`,
  `file-explorer-pack.spec.ts`, `pr-walkthrough-pack.spec.ts`,
  `pack-panels-reconcile.test.ts`, `dynamic-panel-workspace-fixture.spec.ts`,
  `large-review-reopen.journey.spec.ts`, `review-groups.journey.spec.ts`,
  `staff-inbox.spec.ts`, and the existing mobile slider specs. Register every new
  test in `tests2/tests-map.json`.
