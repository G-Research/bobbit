# Loader unification design spike

Status: design only. No product code moved.

Context: `EXTENSION-SEAM-AUDIT.md` flagged "P2 loader unification" as possible but design-first. This spike inventories the current loading mechanisms and decides whether they should collapse to one shared seam.

Verified against `origin/aj-current` in the `fable/d6-loader-spike` worktree. `rg "import\(" src/` currently finds 90 files and 449 dynamic-import matches; most are not the same abstraction.

## Recommendation

Do not unify all loaders into one generic loader seam.

The common syntax is incidental: most mechanisms happen to use `import()`, but their contracts differ in ways that are load-bearing:

- UI custom-element loaders rely on browser custom-element upgrade timing and Lit property preservation.
- Tool renderer loading is a registry problem: it owns placeholders, failure renderers, generation fencing, pack override/restore behavior, and `TOOL_RENDER_REQUESTED_EVENT` repaint.
- Pack browser modules are trusted extension bytes fetched through bearer-only serving endpoints, then imported through Blob URLs with `/* @vite-ignore */`.
- Server extension-host module loading is an isolation and confinement seam. It must keep the parent gateway from importing pack code and must route through `ModuleHost.invoke` plus `confinement-loader.ts`.
- `PackResolver` and `PackContributionRegistry` share pack ordering, but they resolve different shapes: global name shadowing for roles/tools/skills vs. packId-scoped contribution collapse for panels/entrypoints/providers/channels/runtimes/mcp.
- Provider SDK, highlight grammar, dialog, review, and route-page imports are bundle-splitting boundaries with feature-local UX and error semantics.

The only consolidation worth pursuing later is narrow cleanup inside an existing family, not a cross-family abstraction. The pack-only question is already analyzed in `docs/design/pack-loader-unification.md`: do not move pack contributions onto `PackResolver`; instead, prefer `PackContributionRegistry.getRawPack()` / `getPack()` over ad-hoc `loadPackContributions()` reads when a future cleanup lane touches those call sites.

## Inventory

Call-site count means live `src/` usage found by `rg`, excluding the helper's own export unless noted.

| Mechanism | Call sites count | Load trigger | Failure mode | Chunk impact |
|---|---:|---|---|---|
| `src/ui/lazy/*` custom-element loaders (`ensureMessageEditor`, `ensureTransparencyPanel`, `ensureMarkdownBlock`, `ensureDiffBlock`, `ensureGateVerificationLive`, plus `children-mutation-approval` and `children-goal-state-pill`) | 28 direct source uses: 21 `ensureMarkdownBlock`, 5 other `ensure*`, 1 child approval import, 1 child-state `remote-agent` import | First render/connection of a component that emits the custom element or needs a rare dependency | Mostly non-fatal delayed upgrade. Newer `message-editor.ts` and `transparency-panel.ts` reset `loaded = false` and warn on rejection; older loaders may leave raw text/unknown elements until another path loads the chunk | Defers heavy element graphs: Markdown/KaTeX/highlight, message editor attachments/slash/voice UI, gate live markdown/ANSI, diff block, transparency panel |
| `src/app/lazy-widgets.ts` component loaders | 12 source uses across shell, dashboard, message list, attachment tile, session actions, and `AskUserChoicesRenderer` | Component is likely to appear, often before rendering the tag; `loadAttachmentOverlay` is awaited because callers need `.open(...)` | Promise rejection propagates only for awaited callers; fire-and-forget custom elements can remain unknown if the chunk fails | Keeps medium-weight widgets and overlay code off the cold app shell |
| `src/ui/tools/renderer-registry.ts` lazy renderer registry, including `TOOL_RENDER_REQUESTED_EVENT` | 32 registration call sites in `src/ui/tools/index.ts` covering 45 logical tool names; 1 pack renderer registration loop in `src/app/pack-renderers.ts`; 2 mounted listener classes (`Messages.ts`, `ToolGroup.ts`) | First `getToolRenderer(toolName)` for a pending lazy renderer, or metadata reconciliation for pack renderers | Placeholder while loading; rejection installs `makeLoadFailureRenderer`; generation fence drops stale resolves after unregister/re-register; repaint via `TOOL_RENDERER_LOADED_EVENT` and `TOOL_RENDER_REQUESTED_EVENT` | Splits rare/heavy tool renderers and pack renderers away from the entry chunk while preserving stable tool-card layout |
| Pack browser module loaders (`src/app/pack-renderers.ts`, `src/app/pack-panels.ts`) | 2 Blob import sites using `import(/* @vite-ignore */ objUrl)` | Active project contribution metadata registers pack renderers/panels; actual bytes load on first renderer/panel use | HTTP errors reject to registry/panel error handling; generation guard prevents stale project/uninstall results from writing cache; Blob URL is revoked | Runtime-loaded trusted extension bytes are outside Vite's static chunk graph; pack-authored dependencies are bundled into the served pack module |
| Route/page lazy loading in `src/app/render.ts` and adjacent navigation preloads | 10 `lazyPage` / `lazyPageCall` calls for 9 route modules plus many click/route prefetch imports in `main.ts`, `sidebar.ts`, and `render.ts` | Hash route render, config navigation, or explicit preload before route switch | `lazyPage()` logs and currently leaves the loading placeholder if the chunk fails; `docs/debugging.md` documents this exact symptom | Keeps infrequently visited app pages out of the initial route, but route modules still participate in normal Vite chunking |
| App feature wrappers (`dialogs-lazy.ts`, `proposal-panels-lazy.ts`, `lazy-review.ts`, `review-sources-lazy.ts`, `pi-ai-lazy.ts`, `highlight-core.ts`) | `dialogs-lazy` wraps 1 heavy module; `proposal-panels-lazy` wraps 1 heavy module; `lazy-review` imports 2 review components; `review-sources-lazy` wraps 1 module; `pi-ai-lazy` has 8 provider SDK imports; `highlight-core` has 51 grammar imports | User opens a dialog/proposal/review source, browser streaming selects a provider, or code highlighting needs a long-tail grammar | Each wrapper owns feature-specific behavior: proposal panels store `_loadError` and retry UI; pi-ai throws per API; highlight falls back to plain text when no grammar exists | Primary bundle-size pressure relief; this is exactly the kind of boundary `docs/perf/bundle-profile.md` recommends preserving |
| Server extension-host confinement loader (`src/server/extension-host/confinement-loader.ts`, installed by `module-host-bootstrap.ts`) | 1 hook installation path: `configureConfinement(...)` plus `registerHooks({ resolve: confinementResolve })`; invoked by `ModuleHost.invoke` through action/route/channel module hosts | Worker bootstrap before importing pack server modules | Throws `[confinement] ...` errors when a resolved `file:` URL escapes the validated pack root or the path guard is missing | No browser chunk impact. It protects gateway stability by keeping the pack module graph inside the pack root while the worker provides resource/crash isolation |
| Extension-host action/route module loading (`ActionDispatcher`, `RouteDispatcher`, `ModuleHost`) | 2 dispatcher seams call `moduleHost.invoke(...)`; channel handlers use `WorkerChannelModuleHost` | Pack renderer/panel/entrypoint calls `host.invokeAction`, `host.callRoute`, or channels | HTTP-shaped `ActionError`/route errors, timeout, concurrency/rate-limit rejection, worker termination; parent never imports pack code | Server runtime loading only; no UI chunk impact |
| Pack entity loading (`PackResolver`, `buildPackList`, `defaultLoaders`) | 2 production resolver call sites: `config-cascade.ts` for roles/tools and `slash-skills.ts` for skills; `buildPackList()` is the shared ordered pack-list source | REST/config/skill resolution paths ask for roles, tools, or slash skills | Parser tolerance is warn/drop; higher-priority same-name entities shadow lower-priority entities with `shadows[]` retained | No browser chunk impact; this is data resolution, not module loading |
| Pack contribution loading (`loadPackContributions`, `PackContributionRegistry`) | 2 registry-owned calls plus 6 direct production reads in `server.ts`, `marketplace-routes.ts`, `marketplace-install.ts`, and `builtin-pack-defaults.ts` | Contribution registry build, raw pack reads, marketplace/detail/install/runtime catalogue paths | Malformed files warn/drop; specific intra-pack collisions throw `PackContributionError` and reject the pack contribution load; registry applies activation filtering and duplicate routeId conflict handling | No browser chunk impact until a contribution points to pack browser/server modules |
| Other `rg "import\(" src/` results | Remaining file-local imports across 90 files total / 449 matches | Optional dependencies, route helpers, auth/TLS, test-friendly server modules, artifacts, one-off UI actions | Local to each caller | Mixed; many are not chunk-policy seams and should not be normalized just because they use `import()` |

## Shared vs. incidental

Genuinely shared:

- Memoized load state appears in several UI loaders to avoid duplicate imports.
- Browser-side lazy boundaries all rely on Vite recognizing fixed `import()` specifiers, except pack Blob imports which intentionally use `/* @vite-ignore */`.
- Custom elements tolerate asynchronous definition: unknown tags upgrade after the chunk registers them, and Lit property bindings survive that upgrade.
- Pack resolution uses one ordered pack list: `buildPackList()` underlies both `PackResolver` and contribution enumeration.
- Pack-contributed executable modules use path containment helpers before execution or serving.

Incidentally similar:

- `ensureMarkdownBlock()` and `registerLazyToolRenderer()` both call `import()`, but one is a custom-element upgrade trigger while the other mutates a renderer registry with placeholders, failures, stale-load fencing, and repaint events.
- `lazyPage()` and `proposal-panels-lazy.ts` both return placeholders, but only proposal panels store chunk-load errors and expose retry/reload UI.
- Pack renderers/panels and normal route chunks both end up as ESM in the browser, but pack modules are fetched as trusted extension bytes through authenticated endpoints and are deliberately outside Vite's static graph.
- `confinement-loader.ts` is named "loader", but it is not a bundle loader. It is a Node `resolve` hook for module-import containment inside the extension-host worker.
- `PackResolver` loaders and `pack-contributions.ts` loaders both parse pack contents, but their merge keys differ. Roles/tools/skills are global-name entities; pack contributions are pack-scoped surfaces with routeId and activation rules.

## Risks

Bundle-size budget interactions:

- `tests/bundle-size.test.ts` pins entry <= 250 KB gzipped, every non-worker chunk <= 200 KB gzipped, and every non-worker chunk <= 600 KB raw. `docs/perf/bundle-profile.md` says to lazy-load behind natural user/action/route/custom-element boundaries and not add ad-hoc wrappers for small modules.
- A generic loader helper can accidentally import feature types, placeholders, logging helpers, or UI components and pull those dependencies into the entry chunk. Loader helper modules must remain dependency-free when they sit on cold-path imports.
- The 600 KB raw guard especially argues against merging lazy seams into a central module that statically references all potential targets.

Custom-element upgrade timing:

- UI loaders that emit unknown custom-element tags depend on asynchronous upgrade. A unified helper must not require awaiting before render, or it will alter first-paint behavior.
- Failure semantics are intentionally uneven today. For markdown, a brief raw/unstyled display is acceptable; for message editor and transparency panel, the newest pattern resets `loaded` after rejection so a later render can retry.
- Any future common helper for custom elements must preserve "fire and forget, dependency-free, retry on rejection only where intended" instead of imposing a registry-style placeholder/error contract.

Confinement and extension-host boundaries:

- `docs/design/extension-host.md` and `docs/design/extension-host-phase2.md` treat worker isolation as resource/crash isolation plus loader hygiene, not a security sandbox against trusted pack code.
- Server pack modules must continue to load only inside `ModuleHost.invoke`; the parent gateway should only resolve, validate, cache URLs, and pass them to the worker.
- `confinement-loader.ts` must stay in the worker bootstrap order: session-dir module wraps first, path guard imported and injected next, then `registerHooks({ resolve })`, then pack module import. A generic server loader that imports `node:fs` too early can break that order.

## Decision Details

Do not build a cross-cutting `loadModule()` / `ensureLoaded()` platform abstraction.

For UI custom elements, the most I would accept later is a tiny browser-only helper local to `src/ui/lazy/`, for example:

```ts
function ensureOnce(load: () => Promise<unknown>, onError?: (err: unknown) => void): void
```

But that is not recommended as part of this spike. It risks hiding the useful policy differences between the newer retryable loaders (`message-editor.ts`, `transparency-panel.ts`) and older "load once, tolerate upgrade lag" loaders. If it is ever done, the first slice should be only `message-editor.ts` and `transparency-panel.ts`, because they already share the same retry-on-rejection shape. Pins would need to cover: first call imports once, concurrent calls do not duplicate, rejection resets the loaded flag, and a later call retries. That is a UI cleanup, not loader unification.

For pack loading, keep the existing split:

- `PackResolver`: roles/tools/skills global-name shadowing.
- `PackContributionRegistry`: packId-scoped contributions, activation filtering, raw-vs-filtered reads, and contribution-specific hard conflicts.
- `ModuleHost` plus `confinement-loader.ts`: executable server modules.
- Pack renderer/panel Blob imports: trusted browser extension modules.

If a future cleanup lane wants a small first slice, use the one already identified in `docs/design/pack-loader-unification.md`: replace one direct `loadPackContributions()` production read with `PackContributionRegistry.getRawPack()` or `getPack()`, with a parity test for the exact raw or filtered behavior. That should land as ordinary maintenance, not as phase 1 of a broad unification.

## Closure Criteria

Close the audit's P2 loader-unification item as "evaluated, not pursued."

The stable rule for future work:

- New global-name, shadowable pack entities belong in `PackResolver`.
- New pack-scoped extension surfaces belong in `pack-contributions.ts` plus `PackContributionRegistry`.
- New custom-element lazy UI should follow the small dependency-free `src/ui/lazy/*` pattern and document whether rejection is retryable.
- New tool renderers should use `registerLazyToolRenderer()` when they need placeholder/failure/repaint semantics.
- New trusted pack browser modules should continue through the authenticated pack serving endpoints and Blob import path.
- New trusted pack server modules must continue through `ModuleHost.invoke` and the confinement hook.
