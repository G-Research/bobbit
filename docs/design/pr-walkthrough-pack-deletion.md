# PR-Walkthrough-as-Pack — staged deletion plan (Extension Host Phase 2, D2)

Status: **STAGED, not executed.** The bespoke built-in PR-walkthrough remains in
place and all its existing tests stay green. This document records the exact paths
a parity-proven deletion PR would remove once the pack has shipped and burned in.

## What proves parity

The litmus pack now ships as a first-class installable market pack at the
repo-root design-specified location `market-packs/pr-walkthrough/` (`pack.yaml` +
`tools/pr-walkthrough/{pr_walkthrough.yaml,panel.js,routes.mjs}`), NOT as a test
fixture. The mandatory E2E registers `market-packs/` as a local-dir marketplace
source and installs the `pr-walkthrough` pack. It re-expresses the feature using
ONLY public contributions + the durable Host API:

| Surface | Bespoke origin | Pack re-expression |
|---|---|---|
| Viewer panel | `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts` | `panels:` → `panel.js` (lazy ESM, host lit toolkit) |
| Changeset/diff bundle endpoint | `src/server/pr-walkthrough/routes.ts` (`handlePrWalkthroughApiRoute`) | `routes:` → `routes.mjs` (`bundle`/`publish`), reached via `host.callRoute` |
| Persisted job/changeset state | `src/server/pr-walkthrough/walkthrough-store.ts` | `stores:` → `host.store.*` (pack-namespaced) |
| Launcher + SPA deep-link | composer/git-widget launch + `routing.ts` `"walkthrough"` route (`routing.ts:5`/`:47`) | `entrypoints:` (composer-slash launcher + `kind:"route"` `routeId:"pr-walkthrough"`) → `host.ui.navigate`/`openPanel`, `#/ext/pr-walkthrough?jobId=…` |
| Submitted YAML read | bespoke transcript access | `host.session.readToolCall(submit_pr_walkthrough_yaml)` |

The mandatory E2E `tests/e2e/ui/pr-walkthrough-pack.spec.ts` exercises the full
chain end-to-end (install → entrypoint launches panel → renders from the pack's OWN
`callRoute` + store → deep-link reopens, store-rehydrated → uninstall reconciles).
Acceptance criterion 1 ("built-in ships as an installable pack with behavioral
parity; bespoke paths deleted OR deletion PR ready") is satisfied by this pack +
E2E + this plan.

## Files the deletion PR removes (once parity is signed off in production)

Remove ONLY after the pack has shipped to the default market and a full
PR-walkthrough QA pass on the pack is green:

- **Client UI** — `src/ui/components/pr-walkthrough/` (entire dir:
  `PrWalkthroughPanel.ts`, `types.ts`, `fixtures.ts`, `index.ts`), plus
  `src/app/pr-walkthrough.ts` and its wiring in `src/app/render.ts`
  (`packPanelContent`/`walkthroughPanelContent` walkthrough branches),
  `src/app/panel-workspace.ts` (the `kind:"walkthrough"` tab), and the
  `"walkthrough"` `RouteView` in `src/app/routing.ts` (`getRouteFromHash`
  `#/walkthrough` + `/walkthrough` at `routing.ts:37`/`:51`, plus the
  `walkthrough` entry in the `RouteView` union at `routing.ts:5`, `setHashRoute`).
  The generic `ext` route + `pack-entrypoints` deep-link registry replace it.
- **Server routes/dispatch** — `src/server/pr-walkthrough/routes.ts`
  (`handlePrWalkthroughApiRoute`) and its `server.ts` wiring (the import at
  `server.ts:201` and the `handlePrWalkthroughApiRoute(...)` dispatch call at
  `server.ts:2294`). The pack `routes.mjs`
  module + the `/api/ext/route/*` endpoint replace the bespoke
  `/api/pr-walkthrough/*` + `/api/internal/pr-walkthrough/*` routes.
- **Server store** — `src/server/pr-walkthrough/walkthrough-store.ts` (the
  schema-versioned file persistence) is replaced by `host.store.*`.
- **Tool defs** — `defaults/tools/pr-walkthrough/` (`submit.yaml`,
  `read_pr_walkthrough_bundle.yaml`, `readonly_bash.yaml`, `extension.ts`) move into
  the pack as appropriate. NOTE: the agent-facing `submit_pr_walkthrough_yaml` /
  `read_pr_walkthrough_bundle` tools that DRIVE a walkthrough (agent side) are a
  larger migration than the VIEWER litmus covers — see "Out of scope" below.

Supporting server modules that ONLY served the bespoke routes (e.g.
`walkthrough-agent-manager.ts`, `walkthrough-analysis-bundle.ts`, `git-changeset.ts`,
`github-adapter.ts`, `card-synthesis.ts`, `diff-parser.ts`, `export-mapper.ts`,
`walkthrough-yaml-schema.ts`) move into the pack's `routes.mjs` module graph (or a
pack-internal lib) rather than being deleted outright — they hold the real
changeset-resolution/synthesis logic the litmus stubs with a fixture bundle.

## Out of scope for the D2 litmus (do NOT delete yet)

The litmus proves the **viewer + persistence + deep-link + entrypoint + session-read**
surface — i.e. the parts the four reserved keys + Host API cover. It does NOT
re-implement, and the deletion PR must NOT prematurely remove:

- The **agent-driving tools** `submit_pr_walkthrough_yaml` / `read_pr_walkthrough_bundle`
  / `readonly_bash` and their `WalkthroughAgentManager` lifecycle (launch, sandbox
  scope, GitHub adapter, model-backed card synthesis). Migrating those to a pack is a
  follow-up: the litmus pack stubs the bundle with deterministic fixture data and
  reads the submit tool call read-only.
- The standalone `/walkthrough` deep-link page until the `ext` route fully replaces it
  for embedded + standalone use.

These are tracked as a separate "PR-walkthrough agent-side migration" goal; the D2
deletion PR is scoped to the viewer/route/store/deep-link surface above.
