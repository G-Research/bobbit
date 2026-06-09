# D1 — artifacts-as-pack: built-in deletion plan

**Status:** full per-type parity + E2E landed; deletion is a **separate, staged PR**
that is now demonstrably ready (acceptance #1 allows "deletion PR demonstrably
ready"). The only residual is a tracked, non-blocking cold-`#/ext` deep-link infra
gap (§3). This doc is that ready-to-execute plan.

Source of truth: `docs/design/extension-host-phase2.md` §10 (Slice D1). The
litmus pack now ships as a first-class installable market pack at the repo-root
design-specified location `market-packs/artifacts/` (pack.yaml +
`tools/artifact_demo/...`), NOT as a test fixture. Parity is proven by
`tests/e2e/ui/artifacts-pack.spec.ts`, which registers `market-packs/` as a
local-dir marketplace source and installs the `artifacts` pack.

## 1. What the litmus already proves (in CI, green)

`tests/e2e/ui/artifacts-pack.spec.ts` drives the artifacts built-in re-expressed
as an installable market pack using ONLY public Phase-2 contributions + the Host
API, and asserts behavioral parity for the load-bearing surfaces:

| Built-in surface | Re-expressed as | Proven by the E2E |
|---|---|---|
| inline artifact pill (`ArtifactPill.ts` + `artifacts-tool-renderer.ts`) | `renderer:` (pre-built ESM, `rendererKind:"pack"`) | pill mounts in a live session; **no store write on mount** (control §5 v) |
| viewer (`ArtifactElement.ts` + per-type components) | `panels:` `artifacts.viewer` via `host.ui.openPanel` | panel mounts on pill click + on deep-link |
| persist/restore by id (`persistPreviewArtifact`/`restorePreviewArtifact`, `src/server/preview/artifacts.ts`) | `stores:` via `host.store.put(id,payload)` / `host.store.get(id)` (pack-namespaced) | content rehydrates from the store; **persists across reload**; viewer reads it back |
| deep-link to a viewer by id | `entrypoints:` `kind:"route"` (`routeId:"artifacts"`) → `host.ui.navigate({route,params})` → `#/ext/artifacts?artifactId=…` | navigate→route→panel→store chain (after a reload); registry-driven, no baked URL |
| install/uninstall lifecycle | marketplace install + reconcile | uninstall drops the renderer pill, the `artifacts.viewer` panel tab, and the deep-link route from the live UI without a reload |

## 2. Files to delete in the staged deletion PR

The pack has reached **full** parity (all artifact TYPES, not just a text payload
— see §3). The staged deletion PR removes the bespoke built-in paths:

- `src/ui/tools/artifacts/` — the whole directory:
  `ArtifactPill.ts`, `artifacts-tool-renderer.ts`, `ArtifactElement.ts`,
  `artifacts.ts`, `Console.ts`, and the per-type components
  (`HtmlArtifact.ts`, `MarkdownArtifact.ts`, `SvgArtifact.ts`, `PdfArtifact.ts`,
  `DocxArtifact.ts`, `ImageArtifact.ts`, `TextArtifact.ts`, `GenericArtifact.ts`),
  plus `index.ts`.
- `src/server/preview/artifacts.ts` — the `persistPreviewArtifact` /
  `restorePreviewArtifact` / `readPreviewArtifact` capture-and-restore machinery
  (replaced by `host.store.*`). Keep `src/server/preview/mount.ts` (live mount is
  orthogonal to artifact persistence).
- Any built-in renderer-registry registration of the `artifacts` tool renderer
  and the bespoke `/api/preview/artifacts/:id/restore` route + its callers.
- The built-in `artifacts` tool YAML/provider is replaced by the shipped market
  pack now living at the repo root: `market-packs/artifacts/` (`pack.yaml` +
  `tools/artifact_demo/{artifact_demo.yaml,ArtifactRenderer.js,ArtifactViewerPanel.js}`).
  This is the same directory the litmus E2E installs from — the deletion PR
  removes the bespoke built-in paths above and lets this shipped pack own the
  surface.

**Before deleting:** port the existing artifact unit tests
(`rg "artifacts" tests/`) to drive the pack renderer/panel instead of the
built-in classes, and keep them green alongside the built-in until the cutover
commit (parity-proven). The built-in's own tests stay green in THIS PR — nothing
is deleted here.

## 3. Parity status (achieved) + the one tracked residual

Full behavioral parity has **shipped**: the pack is no longer a single-text-payload
litmus. The shipped `market-packs/artifacts/` viewer ports every per-type component
and the existing tests prove it — see `tests/e2e/ui/artifacts-pack.spec.ts` (per-type
E2E) and `tests/artifacts-pack-viewer.test.ts` (node).

1. **All artifact types — DONE.** The pack viewer renders HTML (sandboxed
   `allow-scripts` iframe + postMessage console capture), Markdown (rendered HTML,
   not raw source), SVG (a no-script `sandbox=""` iframe — never inlined into the
   main DOM), images, code (real `highlight.js`), PDF (real `pdfjs-dist` page
   rasterisation), and DOCX (real `docx-preview`). The HTML `sandbox` is preserved
   (theme-tokens-only; no unsandboxed iframe). The vendored libraries are
   esbuild-bundled into the pack at publish time.
2. **Persisted pack-panel tab module reload — DONE.** A persisted `kind:"pack"`
   side-panel tab now re-mounts on reload: `renderPackPanelContent` auto-loads the
   registered-but-not-yet-loaded panel module and rehydrates it from the persisted
   store (proven by the "reload with the viewer panel tab already open" E2E),
   instead of staying stuck on "Loading…".
3. **Session-less cold deep-link rehydration — the one remaining residual (tracked,
   not a parity blocker).** A COLD reload directly on `#/ext/<routeId>` restores no
   session, and `host.store` reads authorize against the header-bound session, so a
   session-less cold deep-link cannot rehydrate from the store (the boot normalizes
   the hash back to `#/`). The **reload-surviving** deep-link path IS proven
   (session-route reload + a post-reload navigate). Closing the cold-`#/ext` case
   needs the ext-route boot path to establish/restore a session context (or a
   session-independent read scope for pack stores) — tracked for the C1/boot owner,
   and it does not block the deletion.

## 4. Infra gaps this slice had to CLOSE to land the litmus

These were blocking and are fixed in this PR (noted here + in the task summary so
the relevant slice owners can take ownership / refactor):

- **Panels received no Host API (design §2a.2).** `pack-panels.ts` handed the
  panel factory only `{ html, nothing, renderHeader }`, so a panel could not call
  `host.store.*` at all — the entire `panels:`+`stores:` integration was inert for
  real packs. Fixed: `renderPackPanelContent` now builds a session-bound host via
  an injected factory (`setPanelHostFactory`, self-registered from `host-api.ts`
  to avoid an import cycle) and passes it to `panel.render(params, host)`.
- **Cascade/market-pack load path dropped `storeIds`/`panels`.**
  `builtin-config.ts::toolInfoFrom` (the path INSTALLED packs resolve through)
  emitted `rendererKind`/`routeNames`/`entrypoints` but omitted `storeIds` and
  `panels`, so an installed pack's store/panel declarations never reached the
  client (panel registration silently vanished). Fixed: `toolInfoFrom` now mirrors
  `tool-manager.ts::contributionFields`.
- **`__bobbitReconcilePackRenderers` E2E hook deduped panels/entrypoints.** The
  hook force-registered renderers but used the dedupe-guarded
  `reconcilePack{Panels,Entrypoints}ForProject`, which SKIP an unchanged project —
  so an uninstall (same projectId) did not drop the panel/route from the live UI.
  Fixed: the hook now force-registers panels + entrypoints from fresh metadata,
  mirroring the marketplace mutation path (`marketplace-page.ts`).
