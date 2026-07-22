# Bundle profile workflow

How to diagnose a UI bundle-size regression — find the bloat, attribute it
to a file or dep, and pick the cheapest fix.

## Quick start

```bash
npx vite build -c vite.profile.config.ts
# Then open bundle-stats.html in a browser.
```

This produces two artifacts (regenerated on every run; both are
gitignored):

- **`bundle-stats.html`** — interactive treemap. Each rectangle's area is
  proportional to the gzipped size of a file inside a chunk. Hover for
  the exact bytes; click to zoom in.
- **`bundle-stats.json`** — raw tree, scriptable. Use it from the CLI
  when you want to grep or run your own aggregation.

The config extends `vite.config.ts` with `rollup-plugin-visualizer` and
nothing else — same chunking, same minification, same `manualChunks`
strategy — so its output is a faithful read of what `npm run build:ui`
ships.

## Reading the treemap

You're usually looking for the answer to one of four questions.

**1. What's in the entry chunk?**
Open the treemap, click into the chunk named `index-*.js` that is also
listed as `(entry)` in the `npm run build:ui` log. Each rectangle is a
single source file in that chunk. The biggest rectangle in the entry
chunk is the next thing to lazy-load.

**2. Which dep is dragging in unexpected weight?**
Open the treemap, find the `node_modules/<dep>` rectangle. If it's in
the entry chunk and you didn't expect it, you've found a static-import
boundary that should be dynamic. Grep `src/` for `from "<dep>"` to find
the offender. Browser code must not use runtime static or dynamic bare
imports from `@earendil-works/pi-ai`; use server-backed APIs or narrow
browser-safe Pi package-exported API/provider subpaths instead.

**3. Why didn't my lazy-loading shrink the entry chunk?**
Rollup hoists a module into its earliest static importer. If the
entry chunk still has `Foo.js` after you converted its eager `import`
to `await import()`, somebody else still imports it statically. Check
the build output — Rollup prints `(!) Foo.js is dynamically imported by
... but also statically imported by ...` with the full set of importers.
Each one that should be lazy needs the same treatment.

**4. Did pinning a vendor chunk actually carve it out?**
Look for the matching `vendor-*` rectangle. If `vendor-typebox-*.js` is
present, the chunk is split correctly. If `typebox` shows up inside the
entry chunk too, the split fired but Rollup also duplicated the dep
into entry because something there imports it directly — usually safe
to ignore (the entry copy is the working copy at runtime; the vendor
chunk is just stable across deploys).

## CLI workflow

For scripted comparisons across builds:

```bash
npx vite build -c vite.profile.config.ts
node -e "const d=require('./bundle-stats.json'); /* your aggregation */"
```

The JSON shape is documented in
[rollup-plugin-visualizer's README](https://github.com/btd/rollup-plugin-visualizer).

## Regression guards

Build-size and build-warning checks live in the repo:

1. **`chunkSizeWarningLimit: 600`** in `vite.config.ts` — Vite prints
   `(!) Some chunks are larger than 600 kB after minification.` if any
   chunk crosses 600 KB raw. The build still succeeds, so this is
   advisory.
2. **`npm run test:bundle`** (`tests/bundle-size.test.ts`) — fails the
   build if the entry chunk exceeds 250 KB gzipped, any non-worker
   chunk exceeds 200 KB gzipped, or any non-worker chunk exceeds
   600 KB raw. Pinned thresholds, raise only after a measured win.
3. **`tests2/core/clean-build-warnings-regression.test.ts`** and `tests2/core/pi-ai-browser-boundary.test.ts` — pin warning
   classes that are easy to miss in green builds: no browser runtime
   bare imports from `@earendil-works/pi-ai`, Pi `0.81.1` streaming imports limited to package-exported API/provider subpaths, no misleading dynamic
   import of modules already statically imported, and quiet expected
   primary-branch fallback logging for temp test repos.
4. **The eye test** — when a chunk size jumps, re-run the profiler and
   look at the new rectangle. Usually a one-line `import()` fix.

## When to grow a chunk vs lazy-load

Cheap-to-add-back-statically (~< 5 KB gz):
prefer eager. Lazy-loading something this small costs more in promise
plumbing and one-shot fetch overhead than it saves.

Mid-size (5–30 KB gz):
lazy-load it only if there's a clean call site behind a user action
or a route boundary that already lazy-loads (a settings page, a
mobile-pairing dialog, an attachment preview). Don't introduce a
new ad-hoc `ensure*` wrapper just for 10 KB.

Heavy (> 30 KB gz):
almost always worth lazy-loading. Look for a natural boundary — a
custom element registered on first use, a feature behind a click,
a route that not every user visits.

Don't touch (already lazy):
provider SDK chunks pi-ai emits (`mistral-*.js`, `google-shared-*.js`,
etc.) — they're already on a dynamic-import boundary inside the
package and only load when the user selects that provider.

## When lazy-loading can't help (the SCC case)

Sometimes the biggest rectangle in the entry chunk is not one
heavy module but a **cycle** of app-shell modules that import each
other (`render` ↔ `sidebar` ↔ `AgentInterface` ↔ `session-manager`
↔ `remote-agent`, …). Rollup cannot split a strongly-connected
component by reachability, so it collapses the whole cycle into one
chunk. Converting any single member to `await import()` does nothing —
its earliest static importer drags it right back in.

The lever here is **app-seam `manualChunks`**: pin stable members (or
whole feature seams like PR-walkthrough, review, inbox) into named
chunks in `build.rollupOptions.output.manualChunks`. This is a
packaging change, not lazy deferral — the modules stay in the eager
import graph and `modulePreload` covers the extra parallel requests, so
there is no behavioral change. It shrinks the entry chunk without
touching source.

The floor is the SCC itself: you cannot split a cycle finer than its
members (Rollup emits a `Circular chunk` warning and folds them back
together). Going below that requires a source-level refactor to break
the import cycle. If a named eager seam such as `app-review` grows back
toward the 600 KB raw limit, first peel cycle-free leaf modules into
small eager chunks; do not raise the budget just to silence Vite. See
[`docs/design/shrink-main-ui-manualchunks.md`](../design/shrink-main-ui-manualchunks.md).

## Adding a per-language chunk emission

`src/ui/tools/highlight-core.ts` uses a static `LAZY_GRAMMARS` map so
Vite emits one chunk per `highlight.js` grammar. To add a new
long-tail language, add a literal entry:

```ts
elixir: () => import("highlight.js/lib/languages/elixir"),
```

Bare-specifier `import()` template literals (e.g. `` import(`.../${lang}`) ``)
look tidier but Vite cannot statically resolve them across node_modules,
so the chunks are never emitted and the runtime call 404s. Always use
a literal specifier per entry.

## See also

- `vite.profile.config.ts` — the profile entry point. Header comment
  has the one-liner usage.
- `tests/bundle-size.test.ts` — the budget regression test.
- `docs/design/shrink-initial-bundle.md` — the design doc that landed
  the current set of lazy-load boundaries.
- `docs/design/ui-bundle-size-reduction.md` — the earlier reduction
  pass that introduced route splitting, lazy MarkdownBlock, etc.
- `docs/design/shrink-main-ui-manualchunks.md` — the app-seam
  `manualChunks` pass that split the app-shell SCC out of the entry
  chunk (the lever in "When lazy-loading can't help" above).
- `docs/dev-workflow.md` — cross-linked from the dev-workflow guide.
