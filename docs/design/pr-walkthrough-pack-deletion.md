# PR-Walkthrough-as-Pack — staged deletion plan (Extension Host Phase 2, D2)

Status: **STAGED, not executed.** The bespoke built-in PR-walkthrough remains in
place and all its existing tests stay green. This document records the exact paths
a parity-proven deletion PR would remove once the pack has shipped and burned in,
**and** the one built-in behaviour that is intentionally NOT pack-expressible under
the Phase-2 security model (§ "The live-recompute architectural constraint").

## What proves parity

The litmus pack now ships as a first-class installable market pack at the
repo-root design-specified location `market-packs/pr-walkthrough/` (`pack.yaml` +
`tools/pr-walkthrough/{pr_walkthrough.yaml,panel.js,routes.mjs}`), NOT as a test
fixture. The mandatory E2E registers `market-packs/` as a local-dir marketplace
source and installs the `pr-walkthrough` pack. It re-expresses the feature using
ONLY public contributions + the durable Host API:

| Surface | Bespoke origin | Pack re-expression |
|---|---|---|
| Viewer panel | `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts` | `panels:` → `panel.js` (lazy ESM, host lit toolkit) — changeset header, phase **nav rail**, diff blocks, suggested comments |
| Changeset/diff bundle endpoint | `src/server/pr-walkthrough/routes.ts` (`handlePrWalkthroughApiRoute`) | `routes:` → `routes.mjs` (`bundle` READ + `publish` persist), reached via `host.callRoute` |
| Persisted job/changeset state | `src/server/pr-walkthrough/walkthrough-store.ts` | `stores:` → `host.store.*` (pack-namespaced) |
| Launcher + SPA deep-link | composer/git-widget launch + `routing.ts` `"walkthrough"` route (`routing.ts:5`/`:47`) | `entrypoints:` (composer-slash + **git-widget-button** + command-palette launchers + `kind:"route"` `routeId:"pr-walkthrough"`) → `host.ui.navigate`/`openPanel`, `#/ext/pr-walkthrough?jobId=…` |
| Submitted YAML read | bespoke transcript access | `host.session.readToolCall(submit_pr_walkthrough_yaml)` |

The mandatory E2E `tests/e2e/ui/pr-walkthrough-pack.spec.ts` exercises the full
chain end-to-end (install → **git-widget-button** launcher launches panel → renders
the **REAL persisted** changeset/cards/diff blocks/suggested comments from the
pack's OWN `callRoute` + store → deep-link reopens, store-rehydrated → uninstall
reconciles). The bundle is a realistic `walkthrough-store` payload seeded through
the pack's own `publish` route (the submit-time persistence seam), **not** a
synthetic `provider:"fixture"`. Acceptance criterion 1 ("built-in ships as an
installable pack with behavioral parity; bespoke paths deleted OR deletion PR
ready") is satisfied by this pack + E2E + this plan, with the single documented
carve-out below (live recompute).

## The live-recompute architectural constraint (load-bearing finding)

**The bespoke route COMPUTES the bundle at request time and a pack route cannot.**
`src/server/pr-walkthrough/routes.ts` (`handlePrWalkthroughApiRoute`) turns a
`baseSha…headSha` / GitHub PR ref into changeset + diff blocks + cards by:

- shelling out to `git` via `execFile` (`git diff`/`rev-parse`/`--name-status`/
  `--shortstat`) — **`child_process`**;
- reading the store + dynamically importing resolver modules (`git-changeset`,
  `github-adapter`, `card-synthesis`, `walkthrough-store`) — **`fs`**;
- resolving GitHub PRs through the github-adapter — **network**;
- running LLM card synthesis (`completeModelText`) — **network + model credentials**.

Pack **server modules** (routes, actions, store handlers) run in the **C3
no-ambient-access worker** (`src/server/extension-host/module-host-worker.ts`):
empty env, module-load deny-hook, **no `child_process`/`fs`/`net`** (mandatory
acceptance #3/#4 — no privileged escape hatch). A pack route therefore **cannot
recompute a walkthrough live**, by design.

**The durable split (how parity is achieved without weakening the worker):** the
git/diff/synthesis is **agent-tool work** — `readonly_bash` /
`submit_pr_walkthrough_yaml` run with **normal agent permissions, NOT in the
confined worker**. They PRODUCE the bundle and PERSIST it at submit time. The pack
then splits cleanly:

| Concern | Bespoke | Pack (durable) |
|---|---|---|
| Compute changeset/diff/cards | `routes.ts` at GET (git/fs/net/LLM) | the agent tools at submit time (normal perms) |
| Persist the bundle | `walkthrough-store.ts` (`fs`) | `publish` route → `host.store.*` (pack-scoped) |
| Serve the bundle | `routes.ts` GET | `bundle` route → **`host.store.get` only** (no git) |
| Render | `PrWalkthroughPanel.ts` | `panel.js` via `host.callRoute("bundle", …)` |

So `routes.mjs::bundle` is **read-only** (returns exactly what `publish` persisted;
on a cache-cleared reload it returns the SAME record → stable `persistedAt`, the
store-rehydration parity proof) and `routes.mjs::publish` is the submit-time
persistence seam (re-expresses `storeWalkthrough`).

**What therefore stays agent-tool/built-in (honest carve-out, NOT an omission):**

- **Live changeset recompute on demand** — the built-in `POST /api/pr-walkthrough/resolve`
  (and GitHub PR resolution) can synthesise a brand-new walkthrough from a raw ref at
  request time. In the pack model this is by construction an agent-tool + `publish`
  flow (compute, then persist), not a viewer-callable recompute route.
- **GitHub review export/submit** (`/export/preview`, `/export/submit`) — need the
  github-adapter (network + credentials); out of scope for the viewer pack.

**The clean follow-up that would close the gap** (out of Phase-2 scope, stated
precisely): a **host-provided, capability-gated git/changeset surface** — e.g.
`host.git.changeset({ baseSha, headSha })` / `host.git.diff(...)` implemented in the
parent process and exposed to pack routes through the same authorized Host-API proxy
the worker already uses for `store`/`session`. The parent runs git; the pack never
gets ambient `child_process`. That would let a pack route request a parent-computed
changeset and re-express live recompute **without** breaching the no-ambient-access
boundary. Until then, live recompute stays agent-tool work and the pack route stays a
pure reader.

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
  `/api/pr-walkthrough/*` + `/api/internal/pr-walkthrough/*` routes — **for the
  READ/persist surface only** (see the live-recompute carve-out above).
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
`walkthrough-yaml-schema.ts`) hold the real changeset-resolution/synthesis logic.
Because that logic legitimately needs git/fs/network (which the confined pack worker
forbids), it stays **agent-tool work** (the `submit_pr_walkthrough_yaml` pipeline) —
it is NOT moved into `routes.mjs`. The pack route only persists+reads the bundle the
agent tools produce.

## Out of scope for the D2 litmus (do NOT delete yet)

The litmus proves the **viewer + persistence + deep-link + entrypoint + session-read**
surface — i.e. the parts the four reserved keys + Host API cover. It does NOT
re-implement, and the deletion PR must NOT prematurely remove:

- The **agent-driving tools** `submit_pr_walkthrough_yaml` / `read_pr_walkthrough_bundle`
  / `readonly_bash` and their `WalkthroughAgentManager` lifecycle (launch, sandbox
  scope, GitHub adapter, model-backed card synthesis). These are the privileged
  git/fs/network/LLM work that the no-ambient-access pack worker cannot host;
  migrating live recompute to a pack requires the follow-up host git/changeset
  capability described above. The litmus pack seeds a realistic persisted bundle via
  its `publish` route and reads the submit tool call read-only.
- The standalone `/walkthrough` deep-link page until the `ext` route fully replaces it
  for embedded + standalone use.

These are tracked as a separate "PR-walkthrough agent-side migration" goal; the D2
deletion PR is scoped to the viewer/route/store/deep-link surface above.
