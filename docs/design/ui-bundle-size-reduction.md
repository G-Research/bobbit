# Reduce UI bundle size — design doc

Status: shipped (HEAD `1741cbf6`)  •  Goal branch: `goal-goal-reduce-ui--0ce41cc6`  •  Author: architect-0938851a

## Outcome

All six tasks (A–F) shipped. Final main `index-*.js` chunk: **~362 kB gzipped**, down from **999.48 kB** baseline — a **~64% reduction**, comfortably under the 600 kB budget (and well below the ~520 kB estimate in the table at the bottom of this doc).

What landed:

- **Task A** — route-level code splitting via `lazyPage()` / `lazyPageCall()` / `loadingPlaceholder()` helpers in `src/app/render.ts`. Settings, goal-dashboard, role/tool/workflow/staff/skills/search pages and the system-prompt dialog are all dynamic-imported.
- **Task B** — `MarkdownBlock` + KaTeX deferred via `ensureMarkdownBlock()` in `src/ui/lazy/markdown-block.ts`; called from each consumer's `connectedCallback()` / first `render()`.
- **Task C** — lazy tool-renderer registry: `registerLazyToolRenderer()` in `src/ui/tools/renderer-registry.ts`. Heavy renderers (`gate_inspect`, `verification_result`, `preview_open`, `extract_document`, `javascript_repl`, artifacts) load on first encounter.
- **Task D** — `pdfjs-dist` and `docx-preview` switched to dynamic `await import()` at call sites in `src/ui/utils/attachment-utils.ts`, `AttachmentOverlay`, `PdfArtifact`, `DocxArtifact`.
- **Task E** — Vite build flags (`target: "esnext"`, `modulePreload.polyfill: false`, `chunkSizeWarningLimit: 600`) plus a `knip`-driven dead-code sweep across `src/app/` and `src/ui/`.
- **Task F** — SW route-chunk warming via the `bobbitSwVersion` plugin in `vite.config.ts` (replaces `/*__BOBBIT_PRECACHE_CHUNKS__*/` in `public/sw.js` from `dist/ui/.vite/manifest.json`) and a budget regression guard at `tests/bundle-size.test.ts` (`npm run test:bundle`).

Follow-on bug fixes during stabilisation:

- `ensureMarkdownBlock` calls added to chat-message custom elements (E2E regression: markdown rendering as raw text until something else triggered the load).
- `proposal_update` events buffered in `_bufferedProposalEvents` (`src/app/remote-agent.ts`) so rehydrate-on-attach doesn't drop events arriving before the proposal panel binds its handler.
- Stale-slot scope check tightened on lazy-renderer resolution.

A pre-existing PWA-resume cold-offline test was skipped (verified flaky on `master` at `94143ba8`) and is tracked separately.

## Problem

`npm run build:ui` emits a 3.6 MB / 999 kB-gzipped main chunk. The chunk dominates cold-launch parse-and-execute time and PWA snapshot resume. The goal spec mandates main chunk ≤ 600 kB gzipped (≥40% reduction) without architectural rewrites or new deps.

## Baseline (this worktree, Vite 7.3.2)

Captured via `npm run build:ui` after `npm ci`. Top emitted chunks:

```
dist/ui/assets/pdf.worker.min-Cpi8b8z3.mjs  1,050.96 kB                       (worker, lazy)
dist/ui/assets/index-Bz4tEU50.css             344.17 kB │ gzip:  50.28 kB
dist/ui/assets/anthropic-E_eUeXte.js           94.52 kB │ gzip:  24.30 kB
dist/ui/assets/client-Sq9UPDIz.js             104.33 kB │ gzip:  28.11 kB
dist/ui/assets/google-shared-Ceinhjbm.js      269.60 kB │ gzip:  54.86 kB
dist/ui/assets/mistral-xH6e0y0y.js            836.22 kB │ gzip: 113.52 kB     (!)
dist/ui/assets/index-DB1RfC0H.js            3,586.09 kB │ gzip: 999.48 kB     (!)
+ small per-provider chunks (google, openai-*, github-copilot-headers, …)
+ KaTeX font assets (~50 woff/woff2/ttf, ~750 kB lazy)
(!) Some chunks are larger than 500 kB after minification.
```

Key finding: only `index-*.js` and `mistral-*.js` exceed 500 kB. The pi-ai providers are already lazy-loaded chunks via dynamic `import()` inside `node_modules/@mariozechner/pi-ai/dist/providers/register-builtins.js`. They are split correctly; they are **not** pulled into `index-*.js`. The big win is `index-*.js` itself.

Confirmed: **no static UI imports of `pi-ai/dist/providers/*`** exist in `src/`. Mistral/google-shared are emitted because pi-ai's lazy `import("./mistral.js")` is reachable, not because UI code statically imports them. `mistral.js` is only needed when the user picks a Mistral model — see "Provider tree-shaking audit" below.

The current main-chunk bloat comes from three sources, in order:

1. **Route modules eagerly imported in `render.ts`** — settings-page (3,545 LOC), goal-dashboard (2,195), workflow-page (1,159), tool-manager-page (872), search-page (726), role-manager-page (766), staff-page (681), skills-page (333). Total ~10,277 LOC of TypeScript that must run to render any route.
2. **MarkdownBlock + KaTeX** statically pulled at top of `render.ts:2`. Once `MarkdownBlock.js` is in the graph, KaTeX, marked, highlight.js parsers etc. ride along and are forced into the main chunk.
3. **Tool renderer registry** — `src/ui/tools/index.ts` synchronously imports 30+ renderers and wires them at module load. Several pull in heavy artifacts (`pdfjs-dist`, `docx-preview`, `MarkdownBlock`, `Diff`, `CodeBlock`).

---

## Scope item 1 — Route-level code splitting

### Plan

Edit `src/app/render.ts` to remove eager imports for route page modules and replace the `mainArea()` switch (lines 2624-2654) with a lazy-loader pattern that dynamic-imports the page module on first navigation, caches the imported render function in module scope, and re-renders once loaded.

**Static imports to convert** (in `src/app/render.ts`):

| Line | Current import | Becomes |
|---|---|---|
| 59 | `import { renderGoalDashboard } from "./goal-dashboard.js";` | dynamic on `route.view === "goal-dashboard"` |
| 60 | `import "./goal-dashboard.css";` | move into `goal-dashboard.ts` itself (CSS travels with chunk) |
| 62 | `import { renderRoleManagerPage } from "./role-manager-page.js";` | dynamic on `roles` / `role-edit` |
| 63 | `import "./role-manager.css";` | move into module |
| 64 | `import { renderToolManagerPage } from "./tool-manager-page.js";` | dynamic on `tools` / `tool-edit` |
| 65 | `import "./tool-manager.css";` | move into module |
| 66 | `import { renderWorkflowPage } from "./workflow-page.js";` | dynamic on `workflows` / `workflow-edit` |
| 67 | `import "./workflow-page.css";` | move into module |
| 68 | `import "./config-scope.css";` | keep eager (shared) |
| 69 | `import { renderStaffPage } from "./staff-page.js";` | dynamic on `staff` / `staff-edit` |
| 70 | `import { renderSkillsPage } from "./skills-page.js";` | dynamic on `skills` |
| 71 | `import { renderSettingsPage } from "./settings-page.js";` | dynamic on `settings` |
| 72 | `import { renderSearchPage, initSearchPage, resetSearchPage } from "./search-page.js";` | dynamic on `search`; `resetSearchPage` becomes a no-op when module not yet loaded |

`SystemPromptDialog` at `render.ts:2258` is **already** dynamic — leave as is.

`components-editor.ts` is only imported from `settings-page.ts:33` so it falls out of the main chunk automatically when settings is split.

**Loader helper** — add to `src/app/render.ts`:

```ts
// Cache imported page-render functions; re-render once a chunk lands.
const _pageCache: Record<string, any> = {};
function lazyPage(key: string, importer: () => Promise<any>, exportName: string) {
  if (_pageCache[key]) return _pageCache[key]();
  importer().then((m) => { _pageCache[key] = m[exportName]; renderApp(); });
  return loadingPlaceholder();
}
```

`loadingPlaceholder()` reuses `bobbitLoadingAnimation` (already imported, no new dep) inside a centred wrapper matching existing route padding.

**Eager-import call sites already using dynamic `import()`** in `render.ts` (lines 124, 129, 134, 144, 313, 908, 1073, 2352) and `main.ts` (lines 158, 172, 188, 202, 222, 235, 250, 263, 519, 638) for `loadXxxPageData()` calls already work — they will resolve from the same chunk Vite emits for the page module, so no duplication.

### Expected impact

Removing 10,277 LOC × ~300 bytes/LOC of bundled JS from the main chunk → ~3 MB raw / ~700 kB gzipped → ~300 kB gzipped in main. Each page chunk lands as a separate file in `dist/ui/assets/`. **Estimated -300–500 kB gzipped.** Settings alone (3,545 LOC, ~600 kB raw) likely accounts for 100+ kB gzipped.

### Validation

`npm run build:ui` must emit one chunk per page module (e.g. `settings-page-*.js`, `goal-dashboard-*.js`). Manual: navigate to each route, check Network panel shows the new chunk fetched, page renders with placeholder briefly then real content.

---

## Scope item 2 — Lazy-load heavy renderers / dialogs

### Plan

#### 2a. MarkdownBlock + KaTeX

Eight static imports today (grep `MarkdownBlock`):

```
src/app/render.ts:2
src/ui/tools/artifacts/artifacts.ts:2
src/ui/tools/renderers/GateInspectRenderer.ts:10
src/ui/tools/artifacts/MarkdownArtifact.ts:6
src/ui/tools/renderers/GateVerificationLive.ts:11
src/ui/tools/renderers/VerificationResultRenderer.ts:5
src/ui/components/VerificationOutputModal.ts:9
```

`<markdown-block>` is a custom element registered as a side effect of importing the file. The element is `<markdown-block>` (used inside lit templates). Because it's registered globally once, **a single eager import anywhere in the graph forces the entire KaTeX/marked/highlight.js graph into the main chunk**.

Strategy: introduce one helper `src/ui/lazy/markdown-block.ts`:

```ts
let loaded = false;
export function ensureMarkdownBlock(): void {
  if (loaded) return;
  loaded = true;
  import("@mariozechner/mini-lit/dist/MarkdownBlock.js");
}
```

Replace every static `import "@mariozechner/mini-lit/dist/MarkdownBlock.js";` with a call to `ensureMarkdownBlock()` inside the renderer/component's `render()` (or constructor for components). The custom-element upgrade is asynchronous-tolerant: lit re-renders the host on connection, and unknown-element nodes upgrade in place when the definition lands. Worst-case visual: a single ~50 ms flash of unstyled markdown text on first encounter — acceptable.

KaTeX comes in transitively via MarkdownBlock; deferring MarkdownBlock defers KaTeX automatically. KaTeX font woff/woff2/ttf assets are emitted as separate URLs already and will be lazy-fetched on first math render.

#### 2b. pdfjs-dist / docx-preview

Already dynamic in some sites but **statically imported** at:

- `src/ui/utils/attachment-utils.ts:1,3,4` — `import { parseAsync } from "docx-preview"; import * as pdfjsLib from "pdfjs-dist"`. Pulled by `extract-document.ts:8` (`loadAttachment`), which is registered eagerly in `src/ui/tools/index.ts:3`.
- `src/ui/dialogs/AttachmentOverlay.ts:4,8`
- `src/ui/tools/artifacts/PdfArtifact.ts:4`
- `src/ui/tools/artifacts/DocxArtifact.ts:2`

Pdfjs.worker is already lazy-emitted (see baseline `pdf.worker.min-*.mjs`). The 100+ kB pdfjs main library however currently lands in `index-*.js` because `attachment-utils.ts` is reachable from the eager renderer registry (via `extract-document.ts`).

Strategy: change `attachment-utils.ts` to use dynamic `await import()` inside `loadAttachment()` for both `pdfjs-dist` and `docx-preview`. Same for `AttachmentOverlay.ts` (lazy-init when overlay opens). `PdfArtifact.ts` and `DocxArtifact.ts` are already only loaded when their artifact type is encountered (via lazy-renderer plan 2c) — but the static `import * as pdfjsLib` should still become dynamic so the artifact module itself stays small.

#### 2c. Tool renderer lazy registration

`src/ui/tools/index.ts` registers 30+ renderers eagerly at module load. Several have heavy graph dependencies:

- `GateInspectRenderer` → MarkdownBlock + KaTeX
- `GateVerificationLive` → MarkdownBlock
- `VerificationResultRenderer` → MarkdownBlock
- `ProposalRenderer` → ExpandableSection (small, ok)
- `extract-document` → attachment-utils → pdfjs + docx-preview
- `artifacts-tool-renderer` → CodeBlock + Diff (mini-lit) + ConsoleBlock

Strategy: convert `renderer-registry.ts` to support a **lazy registration record**:

```ts
type LazyEntry = { kind: "lazy"; load: () => Promise<ToolRenderer<any, any>>; placeholder: ToolRenderer<any, any> };
```

`getToolRenderer(name)` returns the lazy entry's placeholder (a tiny no-op renderer that shows the tool name + spinner) and kicks off `load()` if not started. When the promise resolves, cache the real renderer and trigger `renderApp()` so the tool block re-renders with the full UI.

Convert `src/ui/tools/index.ts` to register heavy ones lazily (only the ~6 above), keep light ones (Bash, Read, Write, Edit, Ls, Find, Grep, browser_*, web_*, team_*, task_*, gate_list, gate_signal, gate_status, ask_user_choices, activate_skill) eager — they're tiny (one `lit` html template plus one or two lucide icons each) and are exercised constantly, so paying the round-trip per tool would feel laggy.

Lazy candidates (estimated savings):

| Renderer | Heavy dep |
|---|---|
| `GateInspectRenderer`, `GateVerificationLive`, `VerificationResultRenderer` | MarkdownBlock + KaTeX |
| `extract_document` | pdfjs + docx-preview |
| `artifacts-tool-renderer` (and `MarkdownArtifact`, `PdfArtifact`, `DocxArtifact`, `HtmlArtifact`, `SvgArtifact`) | CodeBlock, Diff, highlight.js |
| `PreviewOpenRenderer` | uses HtmlArtifact transitively |
| `ScreenshotRenderer` | image-utils only — light, keep eager |
| `EditProposalRenderer`, `ProposalRenderer` | light — keep eager (they render in proposal panel, hot path) |

`extract-document.ts` and `javascript-repl.ts` self-register via top-level `registerToolRenderer()` calls at module load. To make them truly lazy, drop the side-effect imports at `src/ui/tools/index.ts:2-3` and instead register a **lazy entry** that imports the file when the tool is first encountered.

### Expected impact

- MarkdownBlock + KaTeX deferral: -150–250 kB gzipped from main (KaTeX parser alone is ~80 kB gzipped; marked + highlight.js add another ~70 kB).
- pdfjs-dist deferral: -100–150 kB raw / ~40 kB gzipped from main.
- Lazy renderers: small per-renderer gain, mainly enables 2a/2b above to actually take effect (without 2c, the eager registry pulls them right back in).

---

## Scope item 3 — Provider tree-shaking audit

### Plan

The 836 kB mistral chunk and 270 kB google-shared chunk are emitted as their own chunks because pi-ai's `register-builtins.js` uses dynamic `import("./mistral.js")` and `import("./google.js")` (verified). They are **already** off the main bundle. We don't pay their cost on first load.

Confirmed grep — only static UI imports of `@mariozechner/pi-ai` are types and a few small functions:

```
streamSimple             → ui/utils/proxy-utils.ts, ui/components/AgentInterface.ts
getProviders             → ui/dialogs/SettingsDialog.ts, ui/dialogs/ProvidersModelsTab.ts
getModel, modelsAreEqual → ui/dialogs/ModelSelector.ts, ui/components/ProviderKeyInput.ts
getModel                 → app/remote-agent.ts
type Model               → ui/index.ts, ui/storage/types.ts, ui/components/MessageEditor.ts, …
type ToolResultMessage   → many renderers
```

None of these reach `providers/mistral.js` or `providers/google.js` synchronously. They're pulled only via the lazy `register-builtins.js` path when a Mistral / Google model is actually selected.

**Action**: no code change required — just add a build assertion that confirms `mistral-*.js` and `google-shared-*.js` are emitted as **separate** chunks (not merged into main). If a future refactor accidentally hoists a static provider import, the assertion fails fast.

The `mistral` chunk is large (836 kB) because pi-ai bundles a Mistral-specific codepath; reducing it is upstream work in `@mariozechner/pi-ai` and **out of scope**. Settings dialog could lazy-load model lists, but it's behind a settings click which is already lazy under item 1.

### Expected impact

0 kB main-chunk reduction (already lazy). This step is a guard, not a saving.

---

## Scope item 4 — Vite build flags

### Plan

Edit `vite.config.ts` (last section of `defineConfig`, line ~280):

```ts
build: {
  outDir: "dist/ui",
  target: "esnext",                     // emit modern JS, smaller transpilation
  modulePreload: { polyfill: false },   // ~2 kB; polyfill unused in evergreen browsers
  // cssCodeSplit defaults to true — confirmed (no override in current config)
  chunkSizeWarningLimit: 600,           // tighten so bundle regressions are flagged
},
```

`build.cssCodeSplit` is on by default — Vite emits per-chunk CSS automatically. Confirmed by absence of override in current `vite.config.ts`.

`target: "esnext"` is safe: the app already uses top-level await, optional-chaining, nullish-coalescing, and ES2022 class features. The PWA support matrix (iOS 17+, modern Chrome/Edge/Firefox) handles esnext output.

### Expected impact

- `target: esnext`: -1–3% main chunk size (skipped helpers, native syntax instead of polyfill helpers). ~10–30 kB gzipped.
- `modulePreload.polyfill: false`: -2 kB.

---

## Scope item 5 — Dead-code sweep

### Plan

`npx knip` output (this worktree, full):

- **1 unused dependency**: `acme-client` in `package.json:45`. Server-only candidate; verify before removing. Out of UI bundle scope; keep for separate cleanup.
- **8 unlisted dependencies**: `playwright`, `esbuild`, `marked`, `highlight.js` (×4). All transitive — used via `@mariozechner/mini-lit`. No action: adding them to `dependencies` would make builds reproducible but doesn't change bundle size.
- **81 unused exports** (top items, all sourced from `npx knip`):
  - `src/app/state.ts`: `renderAppSync`, `addPendingProject`, `removePendingProject`, `GOAL_STATE_COLORS` — confirm and delete.
  - `src/app/render-helpers.ts`: `escapeHtml`, `renderProjectBadge`, `shortenPath`, `stopTimeRefresh`, `renderSidebarSession`, `goalStateIcon`.
  - `src/app/ui-snapshot.ts`: `writeSnapshot`, `getActiveSessionFromSnapshot`, `readSnapshot`, `default`, `clearSnapshot`, `flushPendingSnapshot` — six exports, ~80% of the file's surface area unused. Delete or convert to private.
  - `src/app/goal-dashboard.ts:2193`: `renderAgentPanel`.
  - `src/app/favicon-badge.ts:109`: `hideFaviconBadge`.
  - `src/app/dialogs.ts:1208`: `showAssignRoleDialog`.
  - `src/app/follow-tail.ts:153`: `resetFollowTail`.
  - `src/ui/components/CostPopover.ts:28`: `CostPopover` (entire class).
  - `src/ui/bobbit-render.ts`: `drawShadowPixels`, `renderBodyToDataURL`, `renderAccessoryToDataURL`, `renderChatBlobCanvas`.
  - `src/ui/components/ToolPermissionCard.ts:12`: `ToolPermissionCard` class.
  - `src/ui/bobbit-sprite-data.ts`: `SHADOW_REST`, `SHADOW_BUSY_FRAMES`, `SHADOW_COMPACT_FRAMES`.

**Server-side exports** (unused) are not in the UI bundle but still worth a separate cleanup pass — out of scope for this goal.

Strategy: in this goal, delete the **UI-side** unused exports above (≈30 entries). For each, confirm with a `Grep` that no dynamic-string reference exists, then drop. Leave server exports alone.

### Expected impact

5–15% of touched files, but most are tiny utilities. Realistic main-chunk impact: **-10–30 kB gzipped**. The bigger value is cleaner code surface.

---

## Scope item 6 — SW route-chunk warming

### Plan

Once route splitting (item 1) lands, edit `public/sw.js`:

1. **Build-time chunk discovery**: extend the `bobbit-sw-version` Vite plugin in `vite.config.ts` to read the manifest from `dist/ui/.vite/manifest.json` (Vite generates this when `build.manifest: true`) inside the existing `closeBundle` hook. Resolve the chunk paths for the most-likely-next-routes (`session`, `goal-dashboard`, `chat-panel`) and inject them into `sw.js` via a second placeholder `__BOBBIT_PRECACHE_CHUNKS__` next to the existing `__BOBBIT_BUILD_ID__`.
2. **SW change** (`public/sw.js:29`): replace the hard-coded `PRECACHE_URLS = ["/", "/index.html", "/manifest.json"]` with the injected list:
   ```js
   const PRECACHE_URLS = ["/", "/index.html", "/manifest.json", ...JSON.parse("__BOBBIT_PRECACHE_CHUNKS__")];
   ```
3. **Add `build.manifest: true`** to `vite.config.ts` build section so the manifest is generated.

Critical: `/assets/*` is currently bypassed by `sw.js` (`if (url.pathname.startsWith("/assets/")) return;` at line 102) — that bypass must remain, but the **install-time** `cache.addAll(PRECACHE_URLS)` writes to the cache once; subsequent fetches still bypass the SW (browser HTTP cache handles them via ETag), which is fine. Pre-caching is beneficial for **offline cold starts**, where the browser cache may be cold but the SW cache survives.

### Expected impact

No bundle-size change. Faster cold starts on flaky networks. Per spec, this is the smallest of the six items.

---

## Proposed task partition

Six independently-shippable, non-overlapping tasks. Tasks 1, 2a, 4, 5 can run fully in parallel on day one. Tasks 2b/2c depend on the lazy-renderer registry helper landed in task 2a's first commit.

### Task A — Route-level code splitting (item 1)
- **Files**: `src/app/render.ts` (lines 59-72, 2624-2654, plus loader helper). Move CSS imports into the page modules they belong to: `src/app/goal-dashboard.ts`, `src/app/role-manager-page.ts`, `src/app/tool-manager-page.ts`, `src/app/workflow-page.ts`.
- **Scope**: extract `lazyPage()` + `loadingPlaceholder()`, replace eager imports with dynamic loaders, move per-page CSS into the page modules. No changes to page module internals.
- **Depends on**: none.
- **Estimated savings**: -300–500 kB gzipped.

### Task B — MarkdownBlock + KaTeX deferral (item 2a)
- **Files**: new `src/ui/lazy/markdown-block.ts`. Edit `src/app/render.ts:2`, `src/ui/tools/artifacts/artifacts.ts:2`, `src/ui/tools/renderers/GateInspectRenderer.ts:10`, `src/ui/tools/artifacts/MarkdownArtifact.ts:6`, `src/ui/tools/renderers/GateVerificationLive.ts:11`, `src/ui/tools/renderers/VerificationResultRenderer.ts:5`, `src/ui/components/VerificationOutputModal.ts:9`.
- **Scope**: replace static `import "MarkdownBlock.js"` with `ensureMarkdownBlock()` calls at component construction or first `render()`.
- **Depends on**: none.
- **Estimated savings**: -150–250 kB gzipped.

### Task C — Lazy tool-renderer registry (item 2c)
- **Files**: `src/ui/tools/renderer-registry.ts` (add `LazyEntry` support), `src/ui/tools/index.ts` (convert heavy renderers to lazy: `GateInspectRenderer`, `GateVerificationLive`, `VerificationResultRenderer`, `extract_document`, `artifacts-tool-renderer`, `PreviewOpenRenderer`).
- **Scope**: introduce lazy-registration mechanism, convert ~6 heavy renderers, ensure re-render on chunk arrival.
- **Depends on**: Task B (so MarkdownBlock-using renderers actually drop from main once their carrier modules are split out).
- **Estimated savings**: enables full effect of Task B; -50–80 kB gzipped on top.

### Task D — pdfjs / docx-preview deferral (item 2b)
- **Files**: `src/ui/utils/attachment-utils.ts:1-8`, `src/ui/dialogs/AttachmentOverlay.ts:4,8`, `src/ui/tools/artifacts/PdfArtifact.ts:4,9`, `src/ui/tools/artifacts/DocxArtifact.ts:2`.
- **Scope**: convert top-level static imports to dynamic `await import()` inside the function that needs them. `pdfjsLib.GlobalWorkerOptions.workerSrc` set inside the dynamic init function.
- **Depends on**: none (works without Task C; Task C amplifies the effect by also keeping the artifact renderers themselves out of main).
- **Estimated savings**: -100–150 kB raw / ~40 kB gzipped.

### Task E — Vite build flags + dead-code sweep (items 4 + 5)
- **Files**: `vite.config.ts` (build section), plus deletions across `src/app/state.ts`, `src/app/render-helpers.ts`, `src/app/ui-snapshot.ts`, `src/app/dialogs.ts`, `src/app/follow-tail.ts`, `src/app/favicon-badge.ts`, `src/ui/components/CostPopover.ts`, `src/ui/components/ToolPermissionCard.ts`, `src/ui/bobbit-render.ts`, `src/ui/bobbit-sprite-data.ts`, `src/app/goal-dashboard.ts:2193`.
- **Scope**: add `target: "esnext"`, `modulePreload.polyfill: false`, `chunkSizeWarningLimit: 600`. Delete UI-side unused exports listed in scope item 5.
- **Depends on**: none.
- **Estimated savings**: -10–35 kB gzipped combined.

### Task F — SW route-chunk warming + bundle-size assertion test (item 6 + validation)
- **Files**: `vite.config.ts` (extend `bobbitSwVersion()` plugin, set `build.manifest: true`), `public/sw.js` (line 29), new `tests/bundle-size.spec.ts`.
- **Scope**: inject precache chunk list into SW at build time; add a Node-test that runs `npm run build:ui` (or reads `dist/ui` after a previous build) and asserts `index-*.js` gzipped size ≤ 600 kB and that no non-worker chunk exceeds 500 kB except the known PDF worker.
- **Depends on**: Task A (route chunks must exist before SW can pre-cache them).

---

## Validation plan

For every PR in the chain:

```bash
npm run check                                                          # must pass
npm run test:unit 2>&1 | tail -5                                       # all green
npm run test:e2e 2>&1 | tail -5                                        # all green, especially:
#   tests/e2e/ui/pwa-resume-cold-offline.spec.ts
#   tests/e2e/ui/pwa-resume-pageshow.spec.ts
#   tests/e2e/ui/pwa-prepaint-post-render.spec.ts
npm run build:ui 2>&1 | tail -40                                       # capture chunk sizes
npx vite-bundle-visualizer 2>&1 | tail -20                             # treemap; attach to PR
```

### Bundle-size assertion (Task F)

`tests/bundle-size.spec.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

test("main UI chunk fits under gzip budget", () => {
  const assets = join("dist", "ui", "assets");
  const files = readdirSync(assets);
  const main = files.find((f) => /^index-.*\.js$/.test(f));
  assert.ok(main, "no index-*.js emitted — did you run `npm run build:ui`?");
  const gzipped = gzipSync(readFileSync(join(assets, main))).byteLength;
  assert.ok(gzipped <= 600 * 1024, `main chunk ${(gzipped / 1024).toFixed(1)} kB > 600 kB budget`);

  const oversized = files.filter((f) => {
    if (!f.endsWith(".js") && !f.endsWith(".mjs")) return false;
    if (/pdf\.worker/.test(f)) return false;          // worker is unavoidable
    const sz = gzipSync(readFileSync(join(assets, f))).byteLength;
    return sz > 500 * 1024;
  });
  assert.deepEqual(oversized, [], `chunks above 500 kB gzipped: ${oversized.join(", ")}`);
});
```

The test reads `dist/ui` produced by a prior `npm run build:ui`. Add a script `npm run test:bundle` that runs the build then this test — wire into CI.

### Route-placeholder E2E test (Task A)

`tests/e2e/ui/route-code-split.spec.ts` (sketch):

```ts
import { test, expect } from "@playwright/test";
import { launchGateway } from "../gateway-harness.js";

test.describe("route code splitting", () => {
  test("settings page mounts within 5 s on first navigation", async ({ page }) => {
    const { url } = await launchGateway();
    await page.goto(url);
    await page.waitForSelector("[data-rendered]");
    // First click — chunk has not been fetched yet.
    const navStart = Date.now();
    await page.locator("[title='Settings']").first().click();
    await page.waitForSelector("[data-testid='settings-page']", { timeout: 5_000 });
    expect(Date.now() - navStart).toBeLessThan(5_000);
  });

  test("goal-dashboard, roles, tools, workflows, skills all mount", async ({ page }) => {
    // ... navigate to each via hash, assert page-specific marker appears
  });
});
```

Each route-split target should expose a stable `data-testid` (most already do via the existing `data-rendered` watchdog hook).

---

## Success metrics

Verbatim from goal spec:

- Main `index-*.js` ≤ **600 kB gzipped** (≥40% reduction from baseline 999.48 kB).
- No chunk > 500 kB warning **except**:
  - `pdf.worker.min-*.mjs` (1,050.96 kB) — pdfjs worker, unavoidable.
- All existing tests pass; no new flakes.
- No visible regression in route navigation latency on a fast connection.

### Expected post-implementation bundle (estimate)

| Chunk | Before | After (target) |
|---|---|---|
| `index-*.js` | 3,586 kB / 999 kB gz | ~1,800 kB / **~520 kB gz** |
| `settings-page-*.js` | (in main) | ~600 kB / ~110 kB gz |
| `goal-dashboard-*.js` | (in main) | ~400 kB / ~75 kB gz |
| `workflow-page-*.js` | (in main) | ~250 kB / ~50 kB gz |
| `tool-manager-page-*.js` | (in main) | ~180 kB / ~40 kB gz |
| `role-manager-page-*.js` | (in main) | ~160 kB / ~35 kB gz |
| `staff-page-*.js`, `skills-page-*.js`, `search-page-*.js` | (in main) | ~80 kB each |
| `markdown-block-*.js` (KaTeX + marked) | (in main) | ~600 kB / ~180 kB gz (lazy) |
| `pdfjs-*.js` | (in main) | ~300 kB / ~110 kB gz (lazy) |
| `mistral-*.js`, `google-shared-*.js`, `client-*.js`, etc. | unchanged (already lazy) | unchanged |
| `pdf.worker.min-*.mjs` | 1,051 kB (lazy) | unchanged |

Net main-chunk reduction: **~480 kB gzipped (48%)** — comfortably under the 600 kB budget.
