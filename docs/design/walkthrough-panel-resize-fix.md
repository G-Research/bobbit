# PR Walkthrough panel-resize controls — verified root-cause analysis

Status: investigation complete (no production code changed in this task).
Scope: diagnose why the PR walkthrough panel's fullscreen, collapse, and
keyboard-shortcut affordances are all non-functional, and pin the exact
reproduction surface for the follow-up reproducing test + fix.

## TL;DR

All three sizing affordances die **at once on the standalone `/walkthrough`
route** because that route is rendered by a *different code path*
(`standaloneWalkthroughPanel()`) than the in-app unified panel:

1. **Fullscreen / collapse buttons are never rendered** on the standalone
   route — `standaloneWalkthroughPanel()` returns only the walkthrough body
   and omits the resize toolbar entirely, and it does not honor
   `state.previewPanelFullscreen` / the collapse flag.
2. **Keyboard shortcuts no-op** on the standalone route — the shortcut gate
   `hasActiveWalkthroughPanel()` and the collapse localStorage key both key off
   the bare `activeSessionId()`, which is `undefined` on the standalone route
   (no session is connected). The panel tab, however, lives under
   `route.walkthroughSessionId`. The two session keys diverge, so detection
   resolves to the `__no-session__` bucket, finds no walkthrough tab, and every
   shortcut falls through to a no-op.

There is a **second, latent fault** in the in-app unified panel: the
`isLiveSessionHostedWalkthroughActive()` predicate's fallback clause
(`source?.sessionId === activeId`) classifies *any* walkthrough viewed in its
owning session as "live", so fullscreen is suppressed even for a **terminated
(done) walkthrough child** that is not actually live. This is masked for *idle*
children (correctly kept split per constraint #3) but bites a terminated child
that has not yet moved into `state.archivedSessions`.

The unifying root cause matches the goal hypothesis: **panel-tab detection uses
`panelWorkspaceSessionKey(activeSessionId())` / `workspaceSessionId()`, but the
resize controls, the collapse localStorage key, and the live-detection
predicate use the bare `activeSessionId()` (or `source.sessionId === activeId`).
When those session keys diverge — exactly what happens on the standalone route
and for a not-yet-archived terminated child — the controls read/write the wrong
key (or short-circuit), making every affordance a silent no-op.**

## Reproduction evidence (verified in a real browser)

A temporary Playwright spec drove the live `gateway-harness` build, injected a
`status: "ready"` walkthrough tab into the active session's panel state, varied
the host-session classification, clicked the fullscreen control, and observed
whether the app entered fullscreen (`.preview-fullscreen-prompt` present). The
spec was removed after capturing results; numbers below are the observed output.

### In-app unified panel — fullscreen button present, click result

| Case | host `childKind` | host `status` | `source.sessionId` vs active | Fullscreen button | Entered fullscreen on click |
|------|------------------|---------------|------------------------------|-------------------|-----------------------------|
| A | (none / regular) | idle | **same** | visible | **no** |
| B | pr-walkthrough | idle (live) | same | visible | no *(intended — constraint #3)* |
| C | pr-walkthrough | **terminated** | same | visible | **no — BUG** |
| D | (none / regular) | idle | **different** | visible | **yes** |
| E | pr-walkthrough | idle, `gs.archived=true` | same | visible | no |
| F (collapse) | regular | idle | same | collapse visible | **collapsed = yes** |

Reading: fullscreen is suppressed **iff `source.sessionId === activeSessionId()`**
(A/B/C/E suppressed; only D, where the owner differs from the viewer, enters
fullscreen). Collapse (F) works in a static in-app scenario. Case E shows the
`archived` guard checks `state.archivedSessions`, *not* the gateway session's
own `archived`/`status`, so a terminated-but-not-archived child stays
"live"-classified.

### Standalone `/walkthrough` route

Navigated to `#/walkthrough?session=<sid>&tab=walkthrough:<id>` with the tab
seeded in `localStorage`:

```
standaloneVisible=true  panelVisible=true
fullscreenButtons=0  collapseButtons=0  expandButtons=0
state.selectedSessionId=null  remoteAgent.gatewaySessionId=null
panelWorkspaceActive["__no-session__"]=""   panelTabsBySession keys=["<sid>"]
```

The walkthrough renders, but **no resize controls exist**, and the shortcut
detection bucket (`__no-session__`) does not contain the tab (it lives under
`<sid>`). This is all three affordances dead simultaneously — the shared-root
symptom described in the goal.

## Code map (file:line)

### Standalone route (primary surface)

- `src/app/render.ts` `mainArea()` early-returns the standalone route before the
  unified-panel layout that owns the resize controls:
  - `if (route.view === "walkthrough") return standaloneWalkthroughPanel();` (~L2398).
- `src/app/render.ts` `standaloneWalkthroughPanel()` (~L2274–2308):
  - Looks up the tab with `const sid = route.walkthroughSessionId || workspaceSessionId();`
    (correct — uses the route's walkthrough session id), then returns only
    `walkthroughPanelContent(tab)` wrapped in a div. **No fullscreen/collapse
    toolbar, and no `previewPanelFullscreen` / `isPreviewCollapsed()` branch.**
- `src/app/render.ts` standalone topbar (~L2511–2526) renders just the Bobbit
  mark + `<theme-toggle>` — no resize controls.

### Shortcut detection + collapse key (session-key divergence)

- `src/app/main.ts` `hasActiveWalkthroughPanel()` (~L77–79):
  `panelWorkspaceSessionKey(activeSessionId())` → `__no-session__` on the
  standalone route, where the tab is stored under `route.walkthroughSessionId`.
- `src/app/main.ts` shortcut handlers gate on `hasActiveWalkthroughPanel()` and
  read/write `bobbit-preview-collapsed-${activeSessionId()}`:
  - `toggle-sidebar` (~L585–595), `toggle-preview` (~L646–663),
    `toggle-fullscreen-preview` (~L666–690).
- `src/app/render.ts` collapse key + reader use the same bare id:
  - `previewCollapseKey = () => `bobbit-preview-collapsed-${activeSessionId()}`` (~L1969),
    `isPreviewCollapsed()`, `togglePreviewCollapse()` (~L1970–1975).
- `src/app/state.ts` `activeSessionId()` (~L740–749) returns `undefined` when no
  session is connected (the standalone route sets `selectedSessionId = null` and
  disconnects — `src/app/main.ts` ~L200, ~L471).

### In-app fullscreen suppression (secondary, latent)

- `src/app/render.ts` `isLiveSessionHostedWalkthroughActive()` (~L2226–2237):
  - First clause correctly catches a live child:
    `session?.childKind === "pr-walkthrough" && !session.archived && status !== "terminated" && status !== "archived"`.
  - **Over-broad fallback:** `return !archived && tab?.kind === "walkthrough"
    && activeId.length > 0 && source?.sessionId === activeId;` — true for *every*
    walkthrough viewed in its owner session. `archived` here is
    `state.archivedSessions.some(...)`, so a terminated child still listed in
    `gatewaySessions` (not yet archived) is misclassified as live.
- `src/app/render.ts` fullscreen render gate (~L2437–2439):
  `suppressFullscreenForLiveWalkthrough = isLiveSessionHostedWalkthroughActive(fullscreenTab) && kind === "walkthrough"`
  → force-resets `state.previewPanelFullscreen = false`.

## Why "all three at once" ⇒ shared cause

The standalone route is a single render branch that bypasses the unified panel.
Because it neither renders the toolbar nor honors the fullscreen/collapse state,
and because the shortcut/collapse plumbing reads a session key
(`activeSessionId()` → empty) that never matches the key the tab is stored under
(`route.walkthroughSessionId`), fullscreen + collapse + shortcuts are all
simultaneously inert. A single reconciliation — make the standalone route honor
the same fullscreen/collapse state and toolbar, and key detection/collapse off
the route's walkthrough session id (or `workspaceSessionId()`), not bare
`activeSessionId()` — fixes all three.

## Proposed fix direction (for the implementation task — not done here)

1. **Single source of truth for the session key.** Drive the collapse
   localStorage key and `hasActiveWalkthroughPanel()`/`canFullscreen` from the
   same key used for the panel-tab lookup (`workspaceSessionId()` /
   `route.walkthroughSessionId`), not bare `activeSessionId()`. On the standalone
   route, `activeSessionId()` is `undefined`; the walkthrough session id must be
   sourced from the route.
2. **Standalone route honors resize state.** `standaloneWalkthroughPanel()` (or
   its caller) should render the fullscreen/collapse toolbar and branch on the
   fullscreen/collapse flags, the same way `unifiedPreviewPanel()` /
   `mainArea()` do for the in-app panel.
3. **Tighten in-app live detection.** Replace the over-broad
   `source?.sessionId === activeId` fallback so it only treats a walkthrough as
   "live" when its host session is genuinely live (e.g. reuse
   `isLiveSessionHostedWalkthrough(state, source.sessionId)`, and treat
   terminated/archived sessions — by `gatewaySessions` status *and*
   `archivedSessions` — as not-live), so a terminated/ready walkthrough child
   can be fullscreened.

## Constraints to preserve (pinned by existing tests — do NOT regress)

- Live child-session walkthroughs must stay in split/promptable view and must
  NOT enter fullscreen (chat prompt visible):
  - `tests/e2e/ui/pr-walkthrough-panel.spec.ts` — "fullscreen toolbar control
    keeps live child walkthroughs in split promptable view" (~L1114).
  - `tests/e2e/ui/pr-walkthrough-real.spec.ts` (~L462–467).
- Standalone preview panel fullscreen/collapse behavior unchanged:
  `tests/e2e/ui/preview-fullscreen-controls.spec.ts`.
- Standalone route still renders the walkthrough in wide/split chrome:
  `tests/e2e/ui/pr-walkthrough-panel.spec.ts` — "open-in-new-tab toolbar control
  renders the same walkthrough in a standalone wide route".

## Proposed reproducing test (for the tester / reproducing-test gate)

Add a browser E2E in `tests/e2e/ui/pr-walkthrough-panel.spec.ts` (reuse
`setupWalkthrough` + the `open-in-new-tab` flow to reach the standalone route,
or seed `localStorage` and navigate to `#/walkthrough?session=<sid>&tab=<id>`).
Assert, on the standalone (ready) walkthrough:

1. A fullscreen control is present and clicking it enters fullscreen
   (`.preview-fullscreen-prompt` / fullscreen root visible).
2. A collapse control is present and collapses the panel (expand control
   appears), and the collapsed state persists across reload.
3. At least one keyboard shortcut (`toggle-fullscreen-preview` Ctrl+#, or
   `toggle-preview` Ctrl+]) operates on the walkthrough panel.
4. Guard: a *live* child-session walkthrough stays in split view (does not enter
   fullscreen) — re-asserts constraint #3.

**Suggested run command** (browser project only):

```
node scripts/run-playwright-e2e.mjs pr-walkthrough-panel --project=browser --workers=1
```

(or, full E2E: `npm run test:e2e`.)

**Expected failure on master (before fix), error pattern regex** — any of:

```
(pr-walkthrough-fullscreen.*not.*visible|preview-fullscreen-prompt.*(hidden|not visible|0)|Expected.*visible.*received.*hidden|toBeVisible)
```

On the standalone route specifically, the fullscreen/collapse locators resolve
to **count 0** (controls absent), so an `expect(locator).toBeVisible()` /
`toHaveCount(1)` assertion fails on master and passes after the fix.

## Notes / verification method

- Reproduction was run against a real build via
  `node scripts/run-playwright-e2e.mjs ... --project=browser`. `node_modules`
  were installed in this worktree to build; `package-lock.json` left unchanged.
- No production `.ts` files were modified by this investigation task.
