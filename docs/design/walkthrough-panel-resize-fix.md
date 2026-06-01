# PR Walkthrough panel-resize controls — design

Status: implemented.
Scope: make the in-app PR walkthrough side panel use the **same** resize logic
as the HTML preview panel (no walkthrough-specific special-casing), and remove
the panel-level resize chrome from the standalone `/walkthrough` pop-out route.

## Guiding principle

**The in-app walkthrough panel must use the SAME resize logic as the HTML
preview panel.** It renders the same unified toolbar (fullscreen / collapse),
honors `state.previewPanelFullscreen` and the per-session collapse key
identically, and **never auto-enters fullscreen** — fullscreen is only ever
entered by an explicit user action (toolbar button or keyboard shortcut).

Why this matters: the dead controls were never a missing-feature problem. The
shared preview-panel plumbing already rendered the toolbar and bound the
keyboard shortcuts for walkthrough tabs. The controls were inert only because a
layer of walkthrough-specific logic kept overriding the shared state. Deleting
that layer — rather than adding parallel walkthrough resize code — is what makes
the panel behave like the preview panel, and it keeps a single resize code path
instead of two that can drift.

## Background — the wrong first attempt (PR #677)

PR #677 assumed the dead controls lived on the standalone `/walkthrough` pop-out
route and "fixed" it by *adding* a panel-level control bar there (fullscreen /
collapse / expand) plus a route-aware `workspaceSessionId()`. That was wrong on
two counts:

1. **Wrong surface.** The user's dead controls were in the **in-app side panel**
   (a walkthrough opened inside a connected session, split with chat), on a
   **ready/finished** walkthrough — a surface #677 never touched.
2. **The standalone additions are conceptually meaningless.** A popped-out new
   tab IS the whole browser window — there is no chat pane beside it — so
   "fullscreen", "collapse", and "expand" do nothing useful there.

## Root cause (in-app)

The in-app unified toolbar already *rendered* the fullscreen/collapse buttons
for walkthrough tabs. The controls were dead purely because of
walkthrough-specific logic layered on top of the shared preview-panel plumbing:

1. **`suppressFullscreenForLiveWalkthrough`** (`render.ts`) force-reset
   `state.previewPanelFullscreen = false` on every render for any walkthrough
   whose host session was alive — so the fullscreen button bounced straight back
   and looked dead.
2. **`isLiveSessionHostedWalkthroughActive`** (`render.ts`) was the predicate
   driving that suppression.
3. **`fullscreenOnReady`** auto-fullscreen plumbing
   (`render.ts` + `pr-walkthrough.ts`) made the panel jump to fullscreen on its
   own when a walkthrough became ready — the opposite of "user-initiated".

## The fix — remove the special-casing

### `src/app/render.ts`
- Removed `isLiveSessionHostedWalkthroughActive()` and
  `suppressFullscreenForLiveWalkthrough`. The fullscreen render branch now uses
  the same condition as the preview panel:
  `desktop && state.previewPanelFullscreen && (fullscreenTab?.kind === "preview" || fullscreenTab?.kind === "walkthrough")`.
- Removed the auto-fullscreen-on-ready block in `walkthroughPanelContent`.
- `standaloneWalkthroughPanel()` no longer renders any panel-level
  fullscreen/collapse/expand chrome and no longer reads
  `previewPanelFullscreen` / the collapse flag. It just renders
  `walkthroughPanelContent(tab)` filling the window. The tab-resolution /
  restore logic (and the component's own internal rail toggle) are unchanged.
- `workspaceSessionId()` keeps its `route.view === "walkthrough"` branch — it is
  still needed so `walkthroughPanelContent`'s lazy payload restore keys off the
  route's walkthrough session id on the standalone route (where
  `activeSessionId()` is `undefined`).

### `src/app/pr-walkthrough.ts`
- Removed all `fullscreenOnReady` plumbing (the option, the per-tab state field,
  and the `previewPanelFullscreen = true` writes) from
  `upsertPrWalkthroughJobPanel`, `launchPrWalkthroughAgent`, and
  `restorePrWalkthroughJobForSession`.
- Removed `keepLiveWalkthroughPanelPromptable`, `isLiveSessionHostedWalkthrough`,
  and `isStandaloneWalkthroughRoute` — once the special-casing is gone, a ready
  walkthrough simply selects its tab (`setActivePanelTabIdForSession`) and never
  forces fullscreen or wipes the collapse key.

### `src/app/main.ts`
- `hasActiveWalkthroughPanel()` stays (the in-app keyboard shortcuts gate on it),
  but its standalone-route branch was removed — the standalone route has no
  panel-level resize controls, so it no longer needs special detection.

## Behaviour matrix

| Surface | Panel-level resize controls |
|---|---|
| In-app side panel (split with chat) | Fullscreen + collapse work via the unified toolbar and the keyboard shortcuts (`toggle-sidebar` = Ctrl+[, `toggle-preview` = Ctrl+], `toggle-fullscreen-preview` = Ctrl+#), identical to the HTML preview panel. Starts in split view; fullscreen only on user action; state persists across reload. |
| Popped-out standalone `/walkthrough` | None — the walkthrough fills the window. The component's internal rail toggle still works. |

### The internal rail toggle is a different control

The walkthrough component's own review-rail collapse/expand button
(`data-testid="pr-walkthrough-rail-toggle"` / `.rail-toggle`, using
`PanelLeftClose`/`PanelLeftOpen`, in
`src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts`) is **not** part of the
panel-level window chrome. It collapses the review rail *inside* the walkthrough,
not the window-level panel, so it is present and functional on **both** surfaces.
This goal only removed the panel-level fullscreen/collapse/expand chrome from the
standalone route; the rail toggle was never touched.

## Tests

- `tests/e2e/ui/pr-walkthrough-panel.spec.ts`
  - "in-app ready walkthrough panel resize controls are user-driven" — the
    reproducing test: no auto-fullscreen on ready, fullscreen/collapse buttons
    and `Ctrl+]` operate on the panel, state persists across reload.
  - "fullscreen toolbar control enters fullscreen on live child walkthroughs
    (user-initiated)" — updated from the old "keeps live child in split"
    expectation.
  - "standalone ready walkthrough has no panel-level resize chrome but keeps its
    internal rail toggle" — inverted from #677's standalone-controls test.
- `tests/e2e/ui/pr-walkthrough-real.spec.ts` — the live-walkthrough fullscreen
  click now enters fullscreen (then returns to split for the rest of the flow).
- `tests/e2e/ui/preview-fullscreen-controls.spec.ts` — unchanged; the HTML
  preview panel behaviour is not touched.
