# PR-Walkthrough-as-Pack — deletion plan (Extension Host Phase 2, D2)

Status: **EXECUTED (merged on `goal/built-in-first-313bf443`).** The bespoke
built-in PR-walkthrough viewer is deleted; `pr-walkthrough` now ships as a built-in
first-party pack and is the **sole provider** of the viewer / route / store /
deep-link surface (see [`built-in-first-party-packs.md`](./built-in-first-party-packs.md)
and [docs/marketplace.md](../marketplace.md#built-in-first-party-packs)). This
document records the plan; the **"What was executed"** box immediately below maps
the plan onto what actually shipped (the body's older "would remove / not executed"
framing is retained for the rationale, but is now historical).

> ## What was executed
>
> **Deleted** (the built-in viewer/feature surfaces the pack now provides):
> - The client viewer: `src/ui/components/pr-walkthrough/`, `src/app/pr-walkthrough.ts`
>   (+ lazy loader), the `render.ts` / `panel-workspace.ts` walkthrough wiring, and
>   the `"walkthrough"` `RouteView` in `routing.ts` (the generic `ext` route replaces it).
> - The **viewer-feed** server routes (`GET /api/pr-walkthrough/jobs/:id`,
>   `/session/:id`, `/:id`) the deleted client consumed.
> - The UI launch wiring (the git-widget "PR Walkthrough" button →
>   `open-pr-walkthrough` → `launchPrWalkthroughAgent` → `POST /api/pr-walkthrough/launch`).
>
> **Retained** (the §8.5 agent-side carve-out — genuine agent capabilities, NOT
> built-in UI surfaces): the agent tools `submit_pr_walkthrough_yaml` /
> `read_pr_walkthrough_bundle` / `readonly_bash`, `WalkthroughAgentManager` and its
> `submitYaml` / `readBundle` routes + `/launch` + `/resolve` + `/export/*`, and the
> load-bearing modules `walkthrough-store.ts`, `git-changeset.ts`, `diff-parser.ts`.
> (An earlier revision of this doc proposed deleting `walkthrough-store.ts` +
> `git-changeset.ts` + `diff-parser.ts`; that was corrected — they are imported by
> the kept agent toolchain. The pack re-expresses the changeset/diff logic
> independently in its own `lib/routes.mjs`.)
>
> **Moved / extracted** (the one thing that left the agent-only side): the YAML→cards
> synthesis (`validatePrWalkthroughYaml` + `mapYamlToWalkthroughPayload` +
> `DiffReferenceMapper` + helpers) was extracted to a pure shared module
> `src/shared/pr-walkthrough/yaml-to-cards.ts`, re-exported so the agent side stays
> unchanged, and **bundled into the pack** (`build:packs` → `lib/yaml-to-cards.mjs`).
> One source of truth, used by both the agent path and the pack `publish` route.
>
> **Launch re-expression:** the deleted git-widget button spawned a *new child
> walkthrough agent* (privilege-minting → not pack-expressible). The pack instead
> drives the **current** session's agent via a gesture-gated `host.session.postMessage`
> "Run PR walkthrough" action in the panel. So "sole provider" holds for the
> migrated viewer + contribution + user-facing launch-gesture surface; the agent
> lifecycle (`/launch` et al.) is the explicit carve-out, kept agent-side.
>
> **SUPERSEDED:** "privilege-minting → not pack-expressible" no longer holds.
> Child-agent launch is now pack-expressible via the shipped ambient `host.agents`
> capability (sandbox-inherited child agents through `OrchestrationCore`). Migrating
> this pack onto `host.agents` — a real read-only child reviewer replacing the
> `postMessage` gesture — is a separate follow-up goal. See
> [docs/orchestration.md](../orchestration.md) and
> [docs/marketplace.md](../marketplace.md).

This document originally recorded the exact paths a parity-proven deletion PR would
remove once the pack had shipped and burned in; that deletion has now been executed.

**SUPERSEDED (Phase-2 §C3.4 + §D2.3):** the earliest revision of this doc claimed
live changeset recompute was NOT pack-expressible because the confined worker had
zero ambient access. That is reversed: pack server code is trusted (tool/MCP tier),
so `node:child_process`/`node:fs` are AMBIENT (no declaration needed) and the pack
`bundle` route recomputes the REAL changeset LIVE in the resource-isolated worker.
The remaining carve-out (GitHub export) is a scope boundary; the LLM-synthesis split
is a pack DESIGN CHOICE (keep `bundle` deterministic), not a credential limitation.

## What proves parity

> **Reconciled to the shipped model.** This section originally described the
> litmus path — register `market-packs/` as a local-dir marketplace source,
> *install* `pr-walkthrough`, later *uninstall*. **That is not how it ships.**
> `pr-walkthrough` is now a **built-in first-party pack** resolved **in place**
> active-by-default via the built-in first-party band in `buildPackList()`
> (`builtinFirstPartyPackEntries()`) — **no manual install**, and it cannot be
> uninstalled, only **disabled** via the activation toggles. It is a **no-tools /
> UI-only** pack (`pack.yaml` + `panels/` + `entrypoints/` + `lib/`), not a
> `tools/`-bearing pack. See
> [built-in-first-party-packs.md](./built-in-first-party-packs.md) and
> [docs/marketplace.md § Built-in (first-party) packs](../marketplace.md#built-in-first-party-packs).
> The parity table below stays accurate (it maps bespoke surfaces → pack
> re-expression); only the install/uninstall framing is historical.

The pack ships at the repo-root design-specified location
`market-packs/pr-walkthrough/` (NOT as a test fixture) and is built by
`npm run build:packs`. It re-expresses the feature using ONLY public
contributions + the durable Host API:

| Surface | Bespoke origin | Pack re-expression |
|---|---|---|
| Viewer panel | `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts` | `panels:` → `panel.js` (lazy ESM, host lit toolkit) — changeset header, phase **nav rail**, diff blocks, suggested comments |
| Changeset/diff bundle endpoint | `src/server/pr-walkthrough/routes.ts` (`handlePrWalkthroughApiRoute`) | `routes:` → `routes.mjs` (`bundle` LIVE git recompute + `publish` persist), reached via `host.callRoute`, using ambient `child_process`/`fs` |
| Persisted job/changeset state | `src/server/pr-walkthrough/walkthrough-store.ts` | `stores:` → `host.store.*` (pack-namespaced) |
| Launcher + SPA deep-link | composer/git-widget launch + the `"walkthrough"` `RouteView` in `src/app/routing.ts` (its union entry + `getRouteFromHash` case) | `entrypoints:` (composer-slash + **git-widget-button** + command-palette launchers + `kind:"route"` `routeId:"pr-walkthrough"`) → `host.ui.navigate`/`openPanel`, `#/ext/pr-walkthrough?jobId=…` |
| Submitted YAML read | bespoke transcript access | `host.session.readToolCall(submit_pr_walkthrough_yaml)` |

The mandatory E2E `tests/e2e/ui/pr-walkthrough-pack.spec.ts` exercises the full
chain end-to-end (the pack resolves active-by-default via the built-in band →
**git-widget-button** launcher opens the panel at `#/ext/pr-walkthrough` →
`bundle` recomputes the **REAL changeset LIVE via `git`** in the confined worker
over a freshly-`git init`'d repo → real diff block renders → publish LLM-enhanced
cards via the pack's own `publish` route → reload re-reads the SAME persisted cards
(stable `persistedAt`) → disabling the pack from the Market built-in section
removes the launcher/deep-link and the feature degrades to an empty state). The
diff is computed live (NOT a hand-seeded `provider:"fixture"` bundle); only the
LLM-enhanced cards are persisted (the submit-time credential seam). The bespoke
viewer/route/store/deep-link surfaces are deleted (the pack is the sole provider),
with only the credential/scope carve-outs below kept agent-side.

## Live changeset recompute IS now pack-expressible (Phase-2 §C3.4 + §D2.3)

**The pack route recomputes the bundle at request time, exactly like the bespoke
route.** `src/server/pr-walkthrough/routes.ts` (`handlePrWalkthroughApiRoute`) turns
a `baseSha…headSha` ref into changeset + diff blocks + cards by shelling out to
`git` via `execFile`, parsing the unified diff, and assembling the changeset. The
pack `bundle` route (`market-packs/pr-walkthrough/.../routes.mjs`) re-expresses that
**verbatim** — `git diff`/`rev-parse`/`--name-status`/`--shortstat` + the same
`parseUnifiedDiff`/`applyNameStatus`/`parseShortstat`/`synthesizeFallbackCards`
logic — and runs it **LIVE in the confined C3 worker**.

This is possible because pack server code is trusted (tool/MCP tier, Phase-2 §9
C3.4): `node:child_process` + `node:fs` are AMBIENT with no declaration, and the
worker's `process.cwd()` is the server-derived session working dir (the bootstrap
overrides `process.cwd` for tool parity, since worker threads can't `chdir`). Any
spawned `git` child is SIGKILLed on terminate-on-timeout (resource isolation). Net
effect: a pack route recomputes a walkthrough for a PR **created AFTER install** —
and the worker is strictly SAFER than the bespoke route (which runs git in-process,
uncapped and unkillable).

**The synthesis split (a pack DESIGN CHOICE, not a credential boundary — §D2.3):** a
trusted pack has full ambient env/network and *could* run its own inference, but
keeping `bundle` deterministic means **LLM card synthesis is kept agent-tool-side**
rather than re-derived in the route. The split:

| Data | Where it comes from | Credentials? |
|---|---|---|
| base/head SHA, file list, `DiffBlock[]` | COMPUTED live in the worker via ambient `git`/`fs` | none (git binary via PATH) |
| structural fallback cards | COMPUTED live in the worker (`synthesizeFallbackCards`) | none |
| LLM-enhanced cards | READ from `host.store` (written by the submit-time agent tool, keyed by changeset id) | model creds used at submit time, in the AGENT (a design choice — `bundle` stays deterministic) |
| GitHub review export | stays agent-tool / built-in (network + GitHub auth) | not in the worker |

So `routes.mjs::bundle` is a LIVE git/diff computer for the changeset + a STORE
reader for the LLM cards (it prefers stored cards when present, else returns the
deterministic in-worker fallback walkthrough — a correct non-LLM result), and
`routes.mjs::publish` is the submit-time persistence seam (writes LLM cards keyed by
changeset id + a job pointer; `persistedAt` stamped once → stable across reloads,
the store-rehydration parity proof).

**What stays agent-tool/built-in (design-choice / scope carve-outs, NOT a recompute
limitation):**

- **LLM card synthesis** — a trusted pack could run its own inference (it has full
  ambient env/network), but PR-walkthrough keeps synthesis agent-tool-side at submit
  time so the live `bundle` route stays deterministic (read from the store, above).
  A future **host-provided synthesis route** (`completeModelText` run IN THE PARENT
  behind the same authorized proxy as `store`/`session`, with gateway-mediated model
  selection) is documented as the follow-up, NOT required for D2 parity (the
  submit-time path covers every authored walkthrough, and the live route always
  returns a correct structural walkthrough).
- **GitHub review export/submit** (`/export/preview`, `/export/submit`) and GitHub
  PR resolution — need the github-adapter (network + GitHub credentials). This
  surface is out of scope for the viewer pack and stays agent-tool/built-in.

## Files the deletion PR removes (once parity is signed off in production)

Remove ONLY after the pack has shipped to the default market and a full
PR-walkthrough QA pass on the pack is green:

- **Client UI** — `src/ui/components/pr-walkthrough/` (entire dir:
  `PrWalkthroughPanel.ts`, `types.ts`, `fixtures.ts`, `index.ts`), plus
  `src/app/pr-walkthrough.ts` and its wiring in `src/app/render.ts`
  (`packPanelContent`/`walkthroughPanelContent` walkthrough branches),
  `src/app/panel-workspace.ts` (the `kind:"walkthrough"` tab), and the
  `"walkthrough"` `RouteView` in `src/app/routing.ts` (the `#/walkthrough`
  `getRouteFromHash`/`setHashRoute` cases plus the `walkthrough` entry in the
  `RouteView` union). The generic `ext` route + `pack-entrypoints` deep-link
  registry replace it.
- **Server routes/dispatch** — `src/server/pr-walkthrough/routes.ts`
  (`handlePrWalkthroughApiRoute`) and its `server.ts` wiring (the module import and
  the `handlePrWalkthroughApiRoute(...)` dispatch call in `handleApiRoute`). The
  pack `routes.mjs`
  module + the `/api/ext/route/*` endpoint replace the bespoke
  `/api/pr-walkthrough/*` + `/api/internal/pr-walkthrough/*` routes — **for the
  changeset-recompute (LIVE git) + persist + read surface**. Only the
  network/credential routes (GitHub PR resolution + `/export/*`) stay agent-side
  (see the credential carve-outs above).
- **Server store** — `src/server/pr-walkthrough/walkthrough-store.ts` (the
  schema-versioned file persistence) is replaced by `host.store.*`.
- **Tool defs** — `defaults/tools/pr-walkthrough/` (`submit.yaml`,
  `read_pr_walkthrough_bundle.yaml`, `readonly_bash.yaml`, `extension.ts`) move into
  the pack as appropriate. NOTE: the agent-facing `submit_pr_walkthrough_yaml` /
  `read_pr_walkthrough_bundle` tools that DRIVE a walkthrough (agent side) are a
  larger migration than the VIEWER litmus covers — see "Out of scope" below.

Supporting server modules split by capability. The **structural** changeset/diff
logic (`git-changeset.ts`, `diff-parser.ts`) is now RE-EXPRESSED LIVE in the pack
`routes.mjs` (ambient `child_process`/`fs`), so the `bundle` route no longer depends
on the bespoke route to compute a changeset. The modules that do **network + GitHub
+ model-backed** work (`github-adapter.ts`, `card-synthesis.ts`, `export-mapper.ts`)
and the agent lifecycle (`walkthrough-agent-manager.ts`,
`walkthrough-analysis-bundle.ts`, `walkthrough-yaml-schema.ts`) stay **agent-tool
work** (the `submit_pr_walkthrough_yaml` pipeline): keeping LLM synthesis + GitHub
export agent-side is a design choice (§D2.3 split), persisted to the pack store via
`publish` and read back by `bundle`.

## Out of scope for the D2 litmus (do NOT delete yet)

The litmus proves the **viewer + persistence + deep-link + entrypoint + session-read**
surface — i.e. the parts the four reserved keys + Host API cover. It does NOT
re-implement, and the deletion PR must NOT prematurely remove:

- The **agent-driving tools** `submit_pr_walkthrough_yaml` / `read_pr_walkthrough_bundle`
  / `readonly_bash` and their `WalkthroughAgentManager` lifecycle (launch, sandbox
  scope, GitHub adapter, model-backed card synthesis). The git/fs work the live
  recompute needs is now done IN the pack worker (ambient `child_process`/`fs`); what
  stays agent-side is the **network + model-backed** work (GitHub PR resolution +
  export, LLM card synthesis) — a pack design choice, not a worker limitation (§D2.3). The litmus
  pack computes the structural changeset LIVE and reads LLM cards the agent persisted
  via `publish`, plus the submit tool call read-only.
- The standalone `/walkthrough` deep-link page until the `ext` route fully replaces it
  for embedded + standalone use.

These are tracked as a separate "PR-walkthrough agent-side migration" goal; the D2
deletion PR is scoped to the viewer/route/store/deep-link surface above.
