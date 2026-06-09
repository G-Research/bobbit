# PR-Walkthrough-as-Pack — staged deletion plan (Extension Host Phase 2, D2)

Status: **STAGED, not executed.** The bespoke built-in PR-walkthrough remains in
place and all its existing tests stay green. This document records the exact paths
a parity-proven deletion PR would remove once the pack has shipped and burned in.

**SUPERSEDED (Phase-2 §C3.4 + §D2.3):** the earliest revision of this doc claimed
live changeset recompute was NOT pack-expressible because the confined worker had
zero ambient access. That is reversed: pack server code is trusted (tool/MCP tier),
so `node:child_process`/`node:fs` are AMBIENT (no declaration needed) and the pack
`bundle` route recomputes the REAL changeset LIVE in the resource-isolated worker.
The remaining carve-out (GitHub export) is a scope boundary; the LLM-synthesis split
is a pack DESIGN CHOICE (keep `bundle` deterministic), not a credential limitation.

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
| Changeset/diff bundle endpoint | `src/server/pr-walkthrough/routes.ts` (`handlePrWalkthroughApiRoute`) | `routes:` → `routes.mjs` (`bundle` LIVE git recompute + `publish` persist), reached via `host.callRoute`, using ambient `child_process`/`fs` |
| Persisted job/changeset state | `src/server/pr-walkthrough/walkthrough-store.ts` | `stores:` → `host.store.*` (pack-namespaced) |
| Launcher + SPA deep-link | composer/git-widget launch + the `"walkthrough"` `RouteView` in `src/app/routing.ts` (its union entry + `getRouteFromHash` case) | `entrypoints:` (composer-slash + **git-widget-button** + command-palette launchers + `kind:"route"` `routeId:"pr-walkthrough"`) → `host.ui.navigate`/`openPanel`, `#/ext/pr-walkthrough?jobId=…` |
| Submitted YAML read | bespoke transcript access | `host.session.readToolCall(submit_pr_walkthrough_yaml)` |

The mandatory E2E `tests/e2e/ui/pr-walkthrough-pack.spec.ts` exercises the full
chain end-to-end (install → **git-widget-button** launcher launches panel →
`bundle` recomputes the **REAL changeset LIVE via `git`** in the confined worker
over a freshly-`git init`'d repo → real diff block renders → publish LLM-enhanced
cards via the pack's own `publish` route → reload re-reads the SAME persisted cards
(stable `persistedAt`) → uninstall reconciles). The diff is computed live (NOT a
hand-seeded `provider:"fixture"` bundle); only the LLM-enhanced cards are persisted
(the submit-time credential seam). Acceptance criterion 1 ("built-in ships as an
installable pack with behavioral parity; bespoke paths deleted OR deletion PR
ready") is satisfied by this pack + E2E + this plan, with only the credential/scope
carve-outs below.

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
