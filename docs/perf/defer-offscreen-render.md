# `deferOffscreenRender` — defer off-screen transcript render

Default-on perf optimisation. Cuts paint cost when activating a session with a
long transcript by rendering only the bottom-tail eagerly and deferring the
rest behind an `IntersectionObserver`.

## Why

Auto-scroll-to-bottom on session activation puts the user at the *latest*
message of the transcript. On a 1280×800 desktop only ~3 messages are
visible at first paint, but the historical render path parsed and rendered
every message synchronously — including 100KB+ tool-result blobs scrolled
far above the viewport. Sidebar navigation into long sessions felt
sluggish because the browser blocked on rendering content the user could
not yet see.

## How it works

`src/ui/components/MessageList.ts` wraps each transcript message in
`<deferred-block>` (`src/ui/components/DeferredBlock.ts`):

- The last `DEFER_EAGER_TAIL = 8` messages render synchronously. This
  covers the visible viewport on a typical desktop with a small headroom
  for the next scroll-up gesture.
- Older messages render a height-preserving placeholder (cheap text
  approximation of the rendered height). The DOM is correctly-sized at
  first paint so scrollbar position is stable.
- Each placeholder observes itself with `IntersectionObserver(rootMargin:
  500px)` and swaps in the real content via `requestIdleCallback({
  timeout: 50 })` (with `setTimeout(0)` fallback) when it approaches the
  viewport. The 500px rootMargin pre-resolves blocks slightly before they
  scroll into view to hide the swap latency.

## Correctness escape hatch

Native browser-find (`Ctrl+F` / `Cmd+F` / `F3`) does not trigger
`IntersectionObserver`, so a naive deferred-render would let users search a
transcript that is mostly placeholders. A module-level keydown listener
captures those keys at the *capture* phase and calls
`DeferredBlock.forceResolveAll()` synchronously, replacing every
placeholder with the real content before the browser's find UI runs.

The same `forceResolveAll()` is exposed via `window.DeferredBlock` for
external consumers (e.g. test code that snapshots the transcript DOM).

## How to disable

Per-user opt-out:

```js
localStorage.setItem("bobbitPerfFlags", "-deferOffscreenRender");
```

Reload the page (the flag is read once at module load). The historical
synchronous render path is restored byte-for-byte.

## When to remove the flag entirely

This flag is a measurement / kill-switch artefact, not a permanent toggle.
Remove it (and the `isPerfFlagEnabled` branch in `MessageList.ts`) once we
have confidence the optimisation is correct in the field. Long-lived feature
flags accumulate configuration sprawl.

## Verification

Behaviour is pinned by:

- `tests/defer-offscreen-render.spec.ts` (7 cases) — eager path, deferred
  placeholder, IntersectionObserver promotion, `Ctrl+F` force-resolve,
  flag-off zero wrappers, flag-on eager / placeholder split, edge case
  where N messages ≤ `DEFER_EAGER_TAIL`.
- `tests/e2e/ui/transcript-fidelity.spec.ts` — the canonical correctness
  test. Asserts the live streaming DOM equals the post-refresh DOM after
  multi-cycle streaming bursts; calls `DeferredBlock.forceResolveAll()`
  before each DOM snapshot so placeholders do not mask content drift.

## Measured impact (large transcript fixture, n=5 replicates per arm)

Every ON-arm sample beats every OFF-arm sample on the headline spans —
non-overlapping replicate ranges:

- `paint.first` p95: 113.5 ms → 76.5 ms (**−37 ms / −33%**)
- `nav.session.ready` p95: 330.4 ms → 235.4 ms (**−95 ms / −29%**)
- rapid Ctrl+↓ keystroke p95: 320.3 ms → 217.9 ms (**−102 ms / −32%**)
- rapid Ctrl+↓ inter-keystroke gap p50: 109.2 ms → 41.7 ms (**crosses
  the 100 ms snappy threshold**)

The user-facing meaning is the rapid-keystroke gap p50: walking the
sidebar with held-down Ctrl+↓ now feels smooth because the main thread
frees up between keystrokes well within budget.

Detailed methodology and the postmortems for other optimisations that
*did not* clear the decision rule live on a parked follow-up branch (the
investigation evidence trail).
