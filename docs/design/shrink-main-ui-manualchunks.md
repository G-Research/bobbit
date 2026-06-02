# Shrink main UI bundle — `manualChunks` app-seam split

Status: shipped (HEAD `11278c43`)  •  Goal branch: `goal/shrink-main-ui-14713901`  •  Date: 2026-06-02

Third pass in the UI bundle-shrink narrative, after
[`ui-bundle-size-reduction.md`](./ui-bundle-size-reduction.md) (route
splitting, lazy MarkdownBlock/renderers/pdfjs) and
[`shrink-initial-bundle.md`](./shrink-initial-bundle.md) (lazy pi-ai
catalog, highlight.js core, qrcode/jszip, vendor `manualChunks`).

## What & why

The entry chunk had crept back to **638.39 KB raw**, tripping the
`tests/bundle-size.test.ts` raw-size guard (assertion #3, which pins
Vite's `chunkSizeWarningLimit: 600`) and re-emitting the
`(!) Some chunks are larger than 600 kB after minification.` warning.

This was a **packaging** problem, not a code-size problem: the entry
chunk had become the app-shell **strongly-connected component (SCC)** —
`render.ts` ↔ `sidebar.ts` ↔ `AgentInterface.ts` ↔ `session-manager.ts`
↔ `remote-agent.ts` and friends all import each other, so Rollup
cannot split them by reachability and collapses the whole cycle into
one chunk. Lazy-loading any single module does nothing while the cycle
is intact — its earliest static importer drags it back into entry.

The fix peels stable **app seams** out of that chunk with four new
`build.rollupOptions.output.manualChunks` rules in `vite.config.ts`,
joining the three app-seam rules (`app-message-reducer`,
`app-panel-workspace`, `app-routing`) and the vendor rules already
there:

| New chunk | Modules pinned |
|---|---|
| `app-session-runtime` | `src/app/session-manager.ts`, `src/app/remote-agent.ts` |
| `app-pr-walkthrough` | `src/app/pr-walkthrough.ts` |
| `app-review` | `src/app/review-sources.ts`, `src/app/preview-panel.ts`, `src/ui/components/review/{ReviewPane,AnnotationStore}.ts` |
| `app-inbox` | `src/ui/inbox/{InboxPanel,AddToInboxDialog,InboxEntry}.ts` |

### Why `manualChunks`, not lazy-loading

These modules are part of the eager import graph — the app needs them
on first paint, and several sit inside the import cycle, so there is no
clean "load on user action / route boundary" seam to defer them behind.
`manualChunks` carves them into separate hashed files **without
changing the import graph**: the entry chunk still statically imports
them, `modulePreload` covers the extra requests, and the browser
fetches them in parallel. This is a **packaging / caching change, not
lazy deferral** — there is no behavioral change, no new `ensure*`
upgrade seam, and no flash-of-unupgraded-element risk.

## Result (as of this pass)

| Chunk | Before | After |
|---|---|---|
| Entry `index-*.js` | 638.39 KB raw | **32.50 KB raw** |
| `app-session-runtime-*.js` (the SCC) | (in entry) | **560.45 KB raw / 149.93 KB gz** |

The entry chunk now holds little more than the bootstrap glue; the
app-shell SCC lives in `app-session-runtime`, comfortably under both
the 600 KB raw guard and the 200 KB-gz per-chunk guard. Don't treat
these byte counts as eternal truth — the regression guard
(`npm run test:bundle`) is the spec; re-run it after any UI change to
get current numbers.

## The floor: ~560 KB raw without a source refactor

`app-session-runtime` is the SCC itself, so it **cannot be split
finer** by `manualChunks` alone. Attempting to peel its members into
separate chunks makes Rollup emit a `Circular chunk` warning and fold
them back together, because each member statically imports the others.
Going below ~560 KB raw therefore requires a **source-level cycle
refactor** (break the `render`/`sidebar`/`AgentInterface`/`session`
import cycle so the pieces become independently reachable) — out of
scope for a packaging-only pass. Until then, ~560 KB raw is the floor,
and the 600 KB raw budget leaves only modest headroom: a future
regression that grows the SCC will trip the guard, and the answer at
that point is the refactor, not raising the budget.

## Verification

- `npm run test:bundle` — builds the UI then runs
  `tests/bundle-size.test.ts`; all three budget assertions pass (entry
  ≤ 250 KB gz, per-chunk ≤ 200 KB gz, no non-worker chunk > 600 KB
  raw).
- `npm run build:ui` emits no chunk-size warning.
- No functional change: `npm run check`, `npm run test:unit`,
  `npm run test:e2e` stay green; the lazy-widget upgrade paths are
  untouched.

## See also

- [`docs/perf/bundle-profile.md`](../perf/bundle-profile.md) — how to
  profile the bundle and find the next offender; the app-seam
  `manualChunks` rule is the lever this pass used.
- `tests/bundle-size.test.ts` — the regression guard and its
  budget-bump policy.
- `vite.config.ts` — `build.rollupOptions.output.manualChunks`, where
  the app-seam and vendor rules live.

