# D1 — artifacts-as-pack: built-in deletion plan

**Status:** parity *fixture* + E2E landed; deletion is a **separate, staged PR**
gated on the gaps below (acceptance #1 allows "deletion PR demonstrably ready").
This doc is that ready-to-execute plan.

Source of truth: `docs/design/extension-host-phase2.md` §10 (Slice D1). Litmus
artifact: `tests/fixtures/market-sources/artifacts-src/artifacts/` +
`tests/e2e/ui/artifacts-pack.spec.ts`.

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

Once the §3 gaps close and the pack reaches **full** parity (all artifact TYPES,
not just the litmus's text payload), the bespoke built-in paths are removed:

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
  pack (the litmus fixture is the template; a shipped pack lives under
  `defaults/.../market-packs/artifacts/` per §10 D1.1).

**Before deleting:** port the existing artifact unit tests
(`rg "artifacts" tests/`) to drive the pack renderer/panel instead of the
built-in classes, and keep them green alongside the built-in until the cutover
commit (parity-proven). The built-in's own tests stay green in THIS PR — nothing
is deleted here.

## 3. Gaps that MUST close before the deletion PR (full parity)

The litmus deliberately re-expresses a **single text payload** to prove the
chain. Full parity (and the deletion) additionally requires:

1. **All artifact types.** The pack viewer renders `payload.content` as text. The
   built-in renders HTML (sandboxed iframe), Markdown, SVG, PDF, DOCX, images,
   console logs. The shipped pack panel must port the per-type components,
   preserving the **iframe `sandbox`** for HTML (theme-tokens-only; no
   unsandboxed iframe — the litmus introduces none).
2. **Session-less cold deep-link rehydration (infra gap — C1 owner).** A COLD
   reload directly on `#/ext/<routeId>` restores no session, and `host.store`
   reads authorize against the header-bound session, so a session-less cold
   deep-link cannot rehydrate from the store (the boot normalizes the hash back
   to `#/`). The litmus proves reload-survival via a session-route reload + a
   post-reload navigate instead. Closing this needs the ext-route boot path to
   establish/restore a session context (or a session-independent read scope for
   pack stores). Tracked for C1/boot, not D1.
3. **Persisted pack-panel tab module reload (infra gap — B4 owner).** A persisted
   `kind:"pack"` side-panel tab is restored visually on reload but its lazy
   module is not re-loaded by the render layer (`renderPackPanelContent` is pure
   and never kicks off `loadPanelModule`). The litmus re-opens via the pill/route
   (which calls `openPackPanel`) rather than relying on tab auto-restore. A
   restore hook that calls `openPackPanel` for persisted pack tabs on boot closes
   this.

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
