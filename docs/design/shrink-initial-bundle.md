# Shrink Initial Bundle — design doc

Status: shipped (HEAD `ed850b65`)  •  Goal branch: `goal/shrink-ini-cf48655b`  •  Author: team-lead

> **Follow-up:** a later pass —
> [`shrink-main-ui-manualchunks.md`](./shrink-main-ui-manualchunks.md)
> (HEAD `11278c43`) — peeled the app-shell SCC (`session-manager`,
> `remote-agent`, PR-walkthrough, review, inbox) out of the entry chunk
> with four more app-seam `manualChunks` rules after it crept back over
> the 600 KB raw budget. Packaging-only; no lazy deferral.

## Outcome

All planned tasks shipped. `npm run build:ui` now emits **no chunk-size
warnings** at the existing `chunkSizeWarningLimit: 600`. Both target
chunks dropped well below budget; the bundle-size regression guard
(`tests/bundle-size.test.ts`) was tightened to pin the new ceiling.

| Chunk | Before | After | Reduction |
|---|---|---|---|
| Entry `index-*.js` | 1,525 kB raw / 360 kB gz | **582 kB raw / 150 kB gz** | −62 % raw / −58 % gz |
| Artifacts (lazy) `index-*.js` | 1,063 kB raw / 339 kB gz | **151 kB raw / 44 kB gz** | −86 % raw / −87 % gz |

What landed:

- **Task A** — `@earendil-works/pi-ai`'s `models.generated.js` catalog
  (~553 kB) lazy-loaded via `src/app/pi-ai-lazy.ts`. Eager value imports
  of `streamSimple` / `getModel` are now dynamic; type-only imports were
  left untouched. The catalog now loads only when the model picker or
  first-message stream needs it.
- **Task B** — `src/ui/tools/highlight-core.ts` replaces every direct
  `import hljs from "highlight.js"` call site. It pulls
  `highlight.js/lib/core` plus 10 eager grammars (`javascript`,
  `typescript`, `python`, `bash`, `json`, `yaml`, `xml`, `css`,
  `markdown`, `sql`) and a static `LAZY_GRAMMARS` map of ~47 long-tail
  languages that load on demand. `html` is aliased to `xml`; `.bat` /
  `.cmd` route to the `dos` grammar.
- **Task C** — `qrcode` (~81 kB) lazy-loaded inside the
  mobile-pairing dialog handler in `src/app/dialogs.ts`.
- **Task D** — `jszip` (~98 kB) lazy-loaded inside the pptx-processing
  path in `src/ui/utils/attachment-utils.ts`.
- **Task F** — `manualChunks` vendor split in `vite.config.ts`
  (`typebox`, `marked`, `mini-lit`, `lucide`, `lit`, `annotorious`).
  This is the originally-optional vendor-split task; we ran it because
  Tasks A–D alone didn't leave enough head-room. F also absorbed the
  follow-on lazy-loading of 25+ element / dialog / widget modules via
  `src/app/{dialogs-lazy,lazy-review,lazy-widgets,proposal-panels-lazy}.ts`,
  and switched many heavy renderers in the tool-renderer registry to
  `registerLazyToolRenderer`. `src/ui/index.ts` re-exports were
  converted to type-only where possible so the barrel no longer pulls
  heavy modules into the entry graph.
- **Task G** *(added during implementation)* — the proposal-panels
  slab (2,121 LOC) was extracted from `src/app/render.ts` into
  `src/app/proposal-panels.ts` + `src/app/proposal-panels-lazy.ts`.
  Task F alone still tripped the 600 kB raw warning; G is the final
  shave that clears it.
- **Bundle-profile tooling** — `vite.profile.config.ts` (new) +
  `rollup-plugin-visualizer` devDep. Workflow documented in
  [`docs/perf/bundle-profile.md`](../perf/bundle-profile.md).
- **Bundle-size regression guard** — `tests/bundle-size.test.ts`
  budgets tightened: entry ≤ 250 KB gz, per-chunk ≤ 200 KB gz, no
  non-worker chunk > 600 KB raw (pins Vite's `chunkSizeWarningLimit:
  600`). Run with `npm run test:bundle`.

Follow-on type and test fixes that landed during verification:

- `src/server/agent/aigw-manager.ts` — type-only adaptation to
  pi-ai `0.75.5`'s `OAuth` + `AnthropicMessagesCompat` API changes
  (the catalog dynamic-import landed during the same window as a
  pi-ai bump). Restored `onDeviceCode` callback after the
  `0.75.5` type re-flip.
- `tests/baseline/*` — sleep-baseline ratchets for
  `pill-overflow-promotion.spec.ts` (existing flake unmasked by
  faster startup; not introduced by this goal).
- `src/ui/components/BgProcessPill.ts` — eager-registered so the
  pill-overflow E2E doesn't race with a lazy-load chunk fetch.
- `src/app/render.ts` — re-export shim for `setSelectedWorkflowId`
  after Task G moved it into `proposal-panels-lazy.ts`.
- `src/ui/tools/highlight-core.ts` — `import.meta.glob` replaced
  with an explicit static `LAZY_GRAMMARS` map because Vite cannot
  statically resolve glob template literals across `node_modules`,
  so the per-language chunks were never emitted (see
  `docs/perf/bundle-profile.md` → "Adding a per-language chunk
  emission").

Acceptance criteria (all met):

| Acceptance criterion | Target | Result |
|---|---|---|
| `npm run build` chunk-size warnings | zero at `chunkSizeWarningLimit: 600` | zero |
| Entry chunk | < 700 kB raw / < 200 kB gz | 582 kB raw / 150 kB gz |
| Artifacts chunk | < 250 kB raw / < 80 kB gz | 151 kB raw / 44 kB gz |
| `npm run test:unit` + `npm run test:e2e` | pass | pass |
| `tests/bundle-size.test.ts` budget guard | tightened, passes | 250/200/600 KB enforced |

## Original problem & plan (for reference)

The rest of this document is the original design as written before the
work landed. Numbers and file paths reflect the pre-shipped baseline.

`npm run build:ui` emitted two chunks that tripped Vite's
`chunkSizeWarningLimit: 600` (raw kB after minification):

| Chunk | Raw | Gzipped | When paid |
|---|---|---|---|
| `index-*.js` (entry) | **1,525 kB** | 360 kB | Every cold load |
| `index-*.js` (artifacts route, lazy) | **1,063 kB** | 339 kB | First artifact view |

This goal targeted:

| Acceptance criterion | Target |
|---|---|
| `npm run build` emits **zero** chunk-size warnings at `chunkSizeWarningLimit: 600` | hard |
| Entry chunk | < 700 kB raw / < 200 kB gz |
| Artifacts chunk | < 250 kB raw / < 80 kB gz |
| `npm run test:unit` + `npm run test:e2e` | pass |
| Existing `tests/bundle-size.test.ts` budget guard | passes (already does — tighten) |

Profiling (`rollup-plugin-visualizer`) attributed the bloat to a small,
specific set of imports. Each one had a known, mechanical fix. The
catalog below sources its numbers from the goal-spec profile run.

## Why now, and why these five fixes

The previous bundle-reduction goal (see
[`docs/design/ui-bundle-size-reduction.md`](./ui-bundle-size-reduction.md))
shipped route splitting, lazy MarkdownBlock, lazy renderers, and lazy
pdfjs/docx. That dropped the main chunk from 999 kB gz → ~362 kB gz.

What remains is **three accidental statically-imported giants**, all of
which are needed only on cold paths (model picker, artifact viewing,
mobile pairing, attachment export):

- **`pi-ai/models.generated.js`** (~553 kB raw / ~80 kB gz) — bare
  `@earendil-works/pi-ai` re-exports `./models.js`, which has a
  module-init side effect that materialises a Map from the 553 kB
  generated catalog. Any static `import { ... } from "@earendil-works/pi-ai"`
  pulls it in, even type-only consumers if mixed with a value import.
- **`highlight.js` full grammar catalog** (~900 kB raw / ~250 kB gz of the
  artifacts chunk) — five files use the default `import hljs from "highlight.js"`
  which registers ~195 languages. `@mariozechner/mini-lit/CodeBlock`
  already does the right thing (`highlight.js/lib/core` + 8 explicit
  languages) — we mirror that.
- **`qrcode`** (~81 kB raw / ~20 kB gz) — only used by mobile-pairing
  dialog in `src/app/dialogs.ts:8`.
- **`jszip`** (~98 kB raw / ~30 kB gz) — only used in
  `src/ui/utils/attachment-utils.ts:1` (export-as-zip path).

A fifth optional task (`manualChunks` vendor split) doesn't shrink
totals but pins stable deps into their own hashed chunk for
cache-friendliness across deploys. Defer if 1–4 alone clear the budget.

## Baseline + profile

Profiling already exists at `vite.profile.config.ts` (per goal spec).
Each task confirms its impact via:

```bash
npx vite build -c vite.profile.config.ts
# → bundle-stats.html (treemap, sortable)
npm run build:ui 2>&1 | tail -20
# → chunk sizes + warnings
npm run test:bundle
# → assertion pass/fail
```

If `vite.profile.config.ts` does not exist in the worktree (the spec
implies it does; the implementer should verify), recreate it from
`vite.config.ts` with `rollup-plugin-visualizer` wired into
`build.rollupOptions.plugins`. Commit the config so future
regressions reproduce easily.

The "before" snapshot is the current `master` HEAD (`a7185c25`).
Capture `bundle-stats.html` *before* any task lands, save chunk sizes
in the PR body, then re-capture after each task for an apples-to-apples
delta. Acceptance criterion #6 in the goal spec mandates documenting
the profile workflow under `docs/` — Task E covers that.

---

## Task A — Lazy-load pi-ai's catalog (largest single win)

### Problem

`@earendil-works/pi-ai`'s `dist/index.js` does
`export * from "./models.js"`, and `models.js` has top-level code
populating `modelRegistry` from `models.generated.js`. The package has
no `"sideEffects": false` field, so Vite cannot tree-shake the
side-effecting module init. Any static value import from the bare
specifier therefore drags the 553 kB catalog into whatever chunk the
importer ends up in.

Eager value-importers in the current main entry graph (from
`grep "from ['\"]@earendil-works/pi-ai['\"]"` on `src/`):

| File | Value imports | Reachable on cold start? |
|---|---|---|
| `src/ui/utils/proxy-utils.ts` | `streamSimple` | yes (chat hot path) |
| `src/ui/components/AgentInterface.ts` | `streamSimple` | yes |
| `src/app/remote-agent.ts` | `getModel` (one literal call site) | yes |
| `src/ui/tools/artifacts/artifacts.ts` | `StringEnum, Type` (from typebox via pi-ai re-export) | yes (registered at module load) |
| `src/ui/components/ProviderKeyInput.ts` | `getModel, complete, Context` | only when settings opens (already lazy via route split) |
| `src/ui/dialogs/SettingsDialog.ts`, `ProvidersModelsTab.ts`, `ModelSelector.ts` | `getProviders, getModel, modelsAreEqual` | only when settings opens |
| `src/server/**` | server-only, not in UI bundle | n/a |

The settings-side files are already lazy via the route-split work; they
do not contribute to the entry chunk. The first four files do.

### Fix

Two surgical changes to the eager entry graph; one cosmetic one:

1. **`src/ui/tools/artifacts/artifacts.ts`** — replace
   `import { StringEnum, Type } from "@earendil-works/pi-ai"` with
   `import { StringEnum, Type } from "typebox"`. Verify with
   `cat node_modules/@earendil-works/pi-ai/dist/index.js` that pi-ai
   re-exports `Type` from `"typebox"` (already confirmed). `typebox` is
   already a transitive dep — no new dependency, and we bypass pi-ai's
   side-effectful index entirely from this file.

2. **`src/app/remote-agent.ts`** — the single call `getModel("anthropic", "claude-opus-4-6")`
   at line 459 is used to seed a default config. Two options, pick the
   cleaner one during implementation:
   - **Inline a constant**: replace `getModel("anthropic", "claude-opus-4-6")`
     with a hard-coded `Model` literal (just the fields the call site uses
     — `provider`, `id`, baseline cost, etc.). Drop the static import.
   - **Behind a lazy wrapper**: extract a `defaultOpusContext()` helper
     into a new file `src/app/pi-ai-lazy.ts` that
     `await import("@earendil-works/pi-ai")` on demand, and convert this
     call site to async. Lower risk than hard-coding model details.

   Prefer **lazy wrapper** — it keeps a single source of truth and
   gracefully picks up future pi-ai catalog updates.

3. **`src/ui/utils/proxy-utils.ts`** + **`src/ui/components/AgentInterface.ts`** —
   replace the `streamSimple` value import with a lazy wrapper:

   ```ts
   // src/app/pi-ai-lazy.ts
   let _pi: Promise<typeof import("@earendil-works/pi-ai")> | null = null;
   export function loadPiAi(): Promise<typeof import("@earendil-works/pi-ai")> {
     return (_pi ??= import("@earendil-works/pi-ai"));
   }
   ```

   In `proxy-utils.ts::createStreamFn`, replace
   `return streamSimple(model, context, options)` with:

   ```ts
   const { streamSimple } = await loadPiAi();
   return streamSimple(model, context, options);
   ```

   `createStreamFn` already returns an async function — no signature
   change. The pi-ai chunk loads on **first message stream**, which is
   already a network round-trip — the dynamic import cost is in the
   noise.

   In `AgentInterface.ts:841`, the test
   `if (this.session.streamFn === streamSimple)` exists to detect "is
   this the default streamFn?". Replace with a sentinel: mark the
   default streamFn via a `Symbol` or `(fn as any).__isDefault = true`
   flag at construction time, and check that flag here. No async impact
   — the comparison runs at component init.

4. **Type imports stay static.** `import type { ... } from "@earendil-works/pi-ai"`
   is erased by `tsc` and never reaches Vite. The dozens of
   `import type { ToolResultMessage } from "@earendil-works/pi-ai"` lines
   across renderers are fine.

### Files modified

- new: `src/app/pi-ai-lazy.ts` (≤30 LOC)
- edit: `src/ui/tools/artifacts/artifacts.ts` (one-line import swap)
- edit: `src/app/remote-agent.ts` (~10 LOC change at line 459)
- edit: `src/ui/utils/proxy-utils.ts` (~5 LOC inside `createStreamFn`)
- edit: `src/ui/components/AgentInterface.ts` (drop value import, swap
  identity check to flag-based)

### Validation

- `npm run check` — types must resolve without the static import.
- `npm run build:ui` — entry chunk no longer contains
  `models.generated.js`. Confirm via `bundle-stats.html`: search for
  "models.generated" — it should now appear only inside a `pi-ai-*.js`
  side chunk (or `chunk-*.js` named after the dynamic import group).
- `npm run test:e2e` — chat flow still works. Existing E2E coverage of
  message streaming is enough; no new test needed.
- Manual: send a message in dev, verify the response streams correctly.
  On first message after cold reload, observe one extra fetch for the
  pi-ai chunk in DevTools network panel — expected.

### Expected impact

Entry chunk: **1,525 kB → ~970 kB raw**, **360 kB → ~280 kB gz**.

---

## Task B — Fix highlight.js full-grammar imports (artifacts chunk)

### Problem

Five files do `import hljs from "highlight.js"`. The default export
includes every grammar (~195 languages, ~900 kB raw). This dominates the
artifacts route chunk, which is already lazy but still trips the budget
on first artifact view.

Audited via `grep -rn "hljs\." src/ui/tools/artifacts/ src/ui/tools/renderers/`:

| File | Languages used at call sites |
|---|---|
| `src/ui/tools/artifacts/TextArtifact.ts:130` | dynamic (file extension at runtime) |
| `src/ui/tools/artifacts/SvgArtifact.ts:65` | `xml` |
| `src/ui/tools/artifacts/HtmlArtifact.ts:235` | `html` (alias of `xml`) |
| `src/ui/tools/artifacts/MarkdownArtifact.ts:70` | `markdown` |
| `src/ui/tools/renderers/WriteRenderer.ts` | dynamic (file extension) |
| `src/ui/tools/renderers/HtmlRenderer.ts` | (uses hljs only via comment; verify before changing) |

`@mariozechner/mini-lit/dist/CodeBlock.js` already does the right thing
— `highlight.js/lib/core` + 8 explicit languages registered. **Mirror
this pattern.**

### Fix

Introduce a shared registry helper at `src/ui/tools/highlight-core.ts`:

```ts
import hljs from "highlight.js/lib/core";

// Eager set: covers ~95 % of Bobbit session content (what the agent
// itself writes most often). Each grammar is small (1–3 kB gzipped).
import javascript from "highlight.js/lib/languages/javascript.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import python     from "highlight.js/lib/languages/python.js";
import bash       from "highlight.js/lib/languages/bash.js";
import json       from "highlight.js/lib/languages/json.js";
import yaml       from "highlight.js/lib/languages/yaml.js";
import xml        from "highlight.js/lib/languages/xml.js";  // also covers html, svg
import css        from "highlight.js/lib/languages/css.js";
import markdown   from "highlight.js/lib/languages/markdown.js";
import sql        from "highlight.js/lib/languages/sql.js";

const EAGER: Record<string, unknown> = {
  javascript, typescript, python, bash, json, yaml,
  xml, css, markdown, sql,
};
for (const [name, mod] of Object.entries(EAGER)) {
  hljs.registerLanguage(name, (mod as any).default ?? mod);
}
// Aliases — hljs.getLanguage("html") should resolve to xml grammar.
hljs.registerAliases(["html"], { languageName: "xml" });

export { hljs };

/**
 * Lazy-load a long-tail language grammar. Subsequent calls are no-ops
 * once the language is registered. Returns true if available, false if
 * the grammar doesn't exist in highlight.js (caller should fall back to
 * unhighlighted text).
 */
export async function ensureLanguage(lang: string): Promise<boolean> {
  if (hljs.getLanguage(lang)) return true;
  try {
    const mod = await import(`highlight.js/lib/languages/${lang}.js`);
    hljs.registerLanguage(lang, mod.default);
    return true;
  } catch {
    return false;
  }
}
```

In each consumer, swap `import hljs from "highlight.js"` for
`import { hljs, ensureLanguage } from "../highlight-core.js"` (path
adjusted per file).

For **static-language** sites (SvgArtifact = `xml`, HtmlArtifact =
`xml`/`html`, MarkdownArtifact = `markdown`): no further change — the
eager set already includes their language. Highlighting is fully sync.

For **dynamic-language** sites (TextArtifact, WriteRenderer): wrap
`hljs.highlight()` in a small async helper:

```ts
async function highlightWithLazyGrammar(content: string, lang: string): Promise<string> {
  const ok = await ensureLanguage(lang);
  return ok
    ? hljs.highlight(content, { language: lang, ignoreIllegals: true }).value
    : escapeHtml(content);
}
```

First render of e.g. a `.rs` file shows unhighlighted text (escape
properly so `<` doesn't break the DOM), then the component re-renders
once the grammar chunk loads. Vite emits one tiny chunk per language
(typically 1–4 kB gzipped). Cached after first load.

### Files modified

- new: `src/ui/tools/highlight-core.ts` (~50 LOC)
- edit: `src/ui/tools/artifacts/TextArtifact.ts`
- edit: `src/ui/tools/artifacts/SvgArtifact.ts`
- edit: `src/ui/tools/artifacts/HtmlArtifact.ts`
- edit: `src/ui/tools/artifacts/MarkdownArtifact.ts`
- edit: `src/ui/tools/renderers/WriteRenderer.ts`
- edit: `src/ui/tools/renderers/HtmlRenderer.ts` (only if it actually
  calls `hljs.highlight` — initial grep shows only a comment; verify
  before editing)

### Validation

- `npm run check` — types resolve.
- `npm run build:ui` — artifacts chunk drops to ≤ 250 kB raw / ≤ 80 kB
  gz. Confirm via `bundle-stats.html` that the chunk no longer contains
  `highlight.js/lib/languages/<long-tail>`.
- Chat-message code blocks in regular conversation still highlight
  (handled by `mini-lit`'s own `CodeBlock`, unaffected by this change).
- New unit test or E2E:
  - extend `tests/e2e/ui/artifacts.spec.ts` (or analogue) to assert a
    `.ts` artifact has `hljs-keyword` spans in the rendered HTML (sync
    eager path), and a `.rs` artifact eventually has them after a
    short await (lazy path). Pattern: `await expect(locator).toContainText(...)`.
- Manual smoke covering `.ts`, `.py`, `.json`, `.md`, `.html`, `.svg`,
  `.rs`.

### Expected impact

Artifacts chunk: **1,063 kB → ~150 kB raw**, **339 kB → ~50–60 kB gz**.

---

## Task C — Lazy-load `qrcode`

### Problem

`src/app/dialogs.ts:8` does `import QRCode from "qrcode"` at module
top. `dialogs.ts` itself is in the eager entry graph (other dialog
helpers are exported and called from `main.ts`/`api.ts`), so the 81 kB
`qrcode` bundle rides along even though `QRCode.toDataURL` is only
called inside the mobile-pairing share dialog.

Confirmed by `grep -n "QRCode\|qrcode" src/app/dialogs.ts`:
- Line 8: import
- Lines 808, 809: only call sites, both inside one function

### Fix

Replace the top-level static import with a dynamic import inside the
single function that uses it:

```ts
// inside the showMobilePairingDialog (or equivalent) function:
const { default: QRCode } = await import("qrcode");
const [mobileQr, caQr] = await Promise.all([
  QRCode.toDataURL(mobileUrl, { width: 280, margin: 2, color: { dark: "#000000", light: "#ffffff" } }),
  QRCode.toDataURL(caCertUrl, { width: 280, margin: 2, color: { dark: "#000000", light: "#ffffff" } }),
]);
```

The function is already inside a click handler — adding one `await` is
trivial. Display a tiny spinner during the ~20 ms qrcode chunk fetch on
first open.

### Files modified

- edit: `src/app/dialogs.ts` (drop import line 8, dynamic-import inside
  the function around lines 808–809)

### Validation

- `npm run check`.
- `npm run build:ui` — `qrcode-*.js` emitted as separate chunk.
- Manual: open mobile-pairing dialog, QR codes still render.

### Expected impact

Entry chunk: **−81 kB raw**, **−20 kB gz**.

---

## Task D — Lazy-load `jszip`

### Problem

`src/ui/utils/attachment-utils.ts:1` does `import JSZip from "jszip"`.
The file is statically pulled into the entry graph because other
attachment helpers in it are used by core attachment handling. JSZip
itself is only needed when loading a `.zip` attachment (line 363:
`JSZip.loadAsync(arrayBuffer)`).

### Fix

Same pattern as Task C — dynamic-import inside the single call site:

```ts
// inside loadZipAttachment (or equivalent):
const { default: JSZip } = await import("jszip");
const zip = await JSZip.loadAsync(arrayBuffer);
```

### Files modified

- edit: `src/ui/utils/attachment-utils.ts` (drop import line 1,
  dynamic-import inside the zip-handling function around line 363)

### Validation

- `npm run check`.
- `npm run build:ui` — `jszip-*.js` emitted as separate chunk.
- Manual: drag a `.zip` into the chat (or any path that triggers
  `JSZip.loadAsync`); confirm it still extracts and lists entries.

### Expected impact

Entry chunk: **−98 kB raw**, **−30 kB gz**.

---

## Task E — Bundle-profile docs + budget tightening

### Problem

Acceptance criterion #6: the next regression must be easy to diagnose.
Today the profile config is implicit; the bundle-size test exists but
its budget is loose enough that all four of these fixes could regress
without it failing.

### Fix

1. **Document the profile workflow** in `docs/perf/bundle-profile.md`
   (new): how to run `npx vite build -c vite.profile.config.ts`, how to
   interpret `bundle-stats.html`, where to look for the next-biggest
   offender. Cross-link from `docs/dev-workflow.md`.
2. **Confirm `vite.profile.config.ts` is committed.** If absent in the
   worktree, add it (extend `vite.config.ts` with the `visualizer`
   plugin from `rollup-plugin-visualizer`).
3. **Tighten `tests/bundle-size.test.ts` budgets** post-implementation:
   - Main entry: lower from 600 kB gz → **250 kB gz** (with 50 kB head-
     room over expected ~200 kB gz post-shrink).
   - Per-chunk (non-worker): lower from 500 kB gz → **120 kB gz**.
   - Document the bump-policy in the test file's header comment:
     "raise these only after a measured wins-vs-costs trade-off".
4. **Add a raw-size guard** to the test so the Vite warning at
   `chunkSizeWarningLimit: 600` (raw kB) can't be re-violated silently:
   no chunk > 600 kB raw except the pdf worker.

### Files modified

- new: `docs/perf/bundle-profile.md`
- edit: `tests/bundle-size.test.ts` (lower budgets, add raw-size guard)
- maybe: `vite.profile.config.ts` (add if missing)
- maybe: `docs/dev-workflow.md` (cross-link)

### Validation

- `npm run test:bundle` passes after all four other tasks land.
- Running it locally **without** the other fixes should fail loudly,
  proving the guard works.

### Expected impact

No bundle-size change. Diagnostic + regression-prevention only.

---

## Task F — *Optional* vendor split via `manualChunks`

Only run this task if Tasks A–D don't already get the entry chunk under
the threshold with ≥50 kB of head-room.

### Fix

In `vite.config.ts`, add a `build.rollupOptions.output.manualChunks`
function that groups stable deps into a single `vendor-*.js` chunk:

```ts
output: {
  manualChunks: (id) => {
    if (!id.includes("node_modules")) return;
    if (id.includes("typebox")) return "vendor-typebox";
    if (id.includes("marked"))  return "vendor-marked";
    if (id.includes("mini-lit")) return "vendor-mini-lit";
    if (id.includes("lucide"))  return "vendor-lucide";
    // Everything else stays in the default chunking strategy.
  },
}
```

### Why optional

Doesn't shrink totals — moves bytes around. Win is **cache stability**:
returning users only redownload the (small, frequently-changing) app
chunk, not the (large, stable) vendor chunk. This is a real
iteration-cycle win for an actively-developed app, but doesn't help
acceptance criteria 1–5 directly.

### Validation

- `npm run build:ui` — `vendor-*.js` chunks appear; entry chunk loses
  the corresponding bytes; total raw size of all chunks stays roughly
  the same.

---

## Parallelization + dependency graph

```
Task A (pi-ai)       ─┐
Task B (highlight.js)─┼─→ Task E (docs + tightened budget) ─→ done
Task C (qrcode)      ─┤
Task D (jszip)       ─┘
```

All of A, B, C, D touch **disjoint files** and can run fully in
parallel:

| Task | Files (exclusive) |
|---|---|
| A | `src/app/pi-ai-lazy.ts` (new), `src/app/remote-agent.ts`, `src/ui/utils/proxy-utils.ts`, `src/ui/components/AgentInterface.ts`, `src/ui/tools/artifacts/artifacts.ts` |
| B | `src/ui/tools/highlight-core.ts` (new), `src/ui/tools/artifacts/{Text,Svg,Html,Markdown}Artifact.ts`, `src/ui/tools/renderers/{Write,Html}Renderer.ts` |
| C | `src/app/dialogs.ts` (one function only — single hunk) |
| D | `src/ui/utils/attachment-utils.ts` (one function only — single hunk) |
| E | `docs/perf/bundle-profile.md` (new), `tests/bundle-size.test.ts`, maybe `vite.profile.config.ts`, maybe `docs/dev-workflow.md` |

No two tasks edit the same file. Spawn A–D simultaneously; spawn E
after the others merge so its tightened budgets reflect the actual
post-shrink sizes.

## Validation plan (whole goal)

```bash
npm run check                # types
npm run test:unit            # incl. bundle-size.test.ts (after build:ui)
npm run test:e2e             # chat streaming, settings, artifacts
npm run build                # → no chunk-size warnings
npx vite build -c vite.profile.config.ts && open bundle-stats.html
```

Manual smoke covers the artifact happy paths called out in acceptance
criterion 5: `.ts`, `.py`, `.json`, `.md`, `.html`, `.svg` highlight on
first render; `.rs` shows unhighlighted briefly, then highlights once
the grammar chunk arrives.

## Risk notes

- **Pi-ai dynamic-import async-ification**: making `streamSimple` lazy
  means the very first network request to start a chat pays one extra
  micro-task to fetch the pi-ai chunk. The pi-ai chunk is large (~80 kB
  gz including catalog) and arrives before the first user message ever
  hits the wire, so this should not be user-perceptible. Validate with
  the existing chat E2E.
- **Highlight.js lazy long-tail UX**: a `.rs` artifact will flash
  unhighlighted for ~50 ms on first view (then re-highlight when the
  grammar chunk arrives). Acceptance criterion #5 explicitly accepts
  this trade-off. Make sure the unhighlighted-text fallback escapes
  HTML correctly — a naive `innerHTML = content` would XSS on
  artifact content.
- **No upstream pi-ai change.** We avoid touching the package and
  rely solely on dynamic-import boundaries — the package can update
  without us needing to re-coordinate.
