# Hindsight memory pack (external mode)

Bobbit ships a built-in [first-party pack](marketplace.md#built-in-first-party-packs) named
**`hindsight`** that gives agents persistent, cross-session **memory** backed by a running
Hindsight instance (an external memory/recall service you host yourself). It is the first production
[lifecycle provider](lifecycle-hub.md): instead of every session starting cold, the provider
**recalls** relevant past memories into the prompt and **retains** a compact summary of each turn,
so knowledge accrues across goals, sessions, and (optionally) projects.

This page documents how the pack behaves and how to turn it on. The implementation blueprint —
exact request/response body mapping, the test plan, and the host-side seams it depends on — lives
in [docs/design/hindsight-pack-external.md](design/hindsight-pack-external.md), whose §7 also
covers the topology rationale (one shared bank, tag-scoped) summarised under
[Bank & tag taxonomy](#bank--tag-taxonomy) below.

> **Scope.** This page documents the **external mode** data plane — you point the pack at a
> Hindsight URL you already run. The **managed Docker/Postgres runtime** (deployment modes
> `managed` and `managed-external-postgres`, explicit-consent start, disable/uninstall/purge, and
> `ctx.runtime` injection) now ships as **P3** and is documented in
> [managed-runtimes.md — P3](managed-runtimes.md#p3--deployment-modes-consent--lifecycle). The
> **native config/status panel** and its launch entrypoints now ship as **P4** — see
> [Native config & status panel](#native-config--status-panel). The explicit
> `hindsight_recall/retain/reflect` agent tools, the reflect UI, and cross-engine dedupe remain
> **out of scope** — see [Non-goals](#non-goals).

## Installed but dormant by default

The pack is in the built-in band, so it is **present and active by default** on a fresh install —
but it does **nothing** until a Hindsight URL is configured. This is a hard, tested guarantee, not
a soft default:

- The provider declares `activation.requiresConfig: [externalUrl]` in
  `providers/memory.yaml`. The host omits the provider entirely from
  `listProviders(projectId)` until the effective config has a **non-empty `externalUrl`**.
- Consequently, on an unconfigured install there is **no active provider**: no provider-bridge
  pi extension is spawned, no per-turn `/provider-hooks/*` calls are made, the assembled
  system-prompt text is **byte-identical** to a no-pack baseline, and **no Hindsight network is
  touched**.
- The provider also re-checks the same gate defensively at runtime (`isActive(cfg)` in
  `market-packs/hindsight/src/shared.ts`): unless `mode === "external"` **and** `externalUrl` is a
  non-empty string, every hook returns immediately (`{ blocks: [] }` for recall hooks, a no-op for
  retain hooks) and constructs no client.

**Why dormant-by-default?** Memory is only useful if a backing store exists, and Bobbit must never
make outbound calls or change prompts for users who have not opted in. Shipping the pack dormant
means the feature is one config field away without imposing any cost — latency, network, or prompt
drift — on everyone else.

Like any first-party pack, you can also fully **disable** it from the Market UI; disabling is the
only opt-out (there is no uninstall for built-in packs). See
[built-in first-party packs](marketplace.md#built-in-first-party-packs).

## Turning it on

The user-facing way to configure the pack is the **native panel** — open **Hindsight Memory**
from the command palette or visit the deep link `#/ext/hindsight`, set at least `externalUrl`
(external mode), and Save. See [Native config & status panel](#native-config--status-panel).
Under the hood the panel writes through the `config` pack route (see [Pack routes](#pack-routes)),
so you can also drive it programmatically: set at least `externalUrl` pointing at your Hindsight
base URL (default Hindsight port is `8888`). Once the effective config has a non-empty URL, the
provider activates on the next session spawn and starts recalling and retaining.

> Earlier the only non-test way to configure the pack was seeding the pack store directly. With P4
> the panel + `config` route are the user-facing path; **store-seeding is now a test-only seam**
> (used by the E2E `seedConfig` helper), not a documented configuration mechanism.

### Configuration keys

The config surface is declared in `market-packs/hindsight/providers/memory.yaml` and mirrored as
flat defaults in `market-packs/hindsight/src/shared.ts` (`CONFIG_DEFAULTS`). Store overrides are
overlaid on these defaults by the loader, so `ctx.config` is the single source of truth the
provider reads.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | enum `external` \| `managed` \| `managed-external-postgres` | `external` | Deployment mode. `external` is documented here; the two managed modes start a Docker runtime — see [managed-runtimes.md — P3](managed-runtimes.md#p3--deployment-modes-consent--lifecycle). Only `external` activates via `externalUrl`; managed modes activate via `activeWhenConfig`. |
| `externalUrl` | string (optional) | — | Base URL of your running Hindsight (external mode). **Empty ⇒ dormant** in external mode. This is the single field that switches the external pack on. |
| `apiKey` | secret (optional) | — | Bearer token. Sent as `Authorization: Bearer <apiKey>` **only when set**; never echoed back (the `config` GET surface collapses it to a boolean `apiKeySet`). Also forms `ctx.runtime.headers` for the managed API. |
| `llmApiKey` / `externalDatabaseUrl` / `dataDir` | secret / secret / string | — / — / `~/.hindsight` | **Managed-mode only.** `llmApiKey` → `HINDSIGHT_API_LLM_API_KEY`, `externalDatabaseUrl` → `HINDSIGHT_API_DATABASE_URL` (redacted to `*Set` booleans on the GET surface), `dataDir` is the managed-Postgres bind path. See [managed-runtimes.md — P3](managed-runtimes.md#secrets--config-mapping). |
| `bank` | string | `bobbit` | The shared memory bank id (see [Bank & tag taxonomy](#bank--tag-taxonomy)). |
| `namespace` | string | `default` | Hindsight namespace path segment. |
| `recallScope` | enum `project` \| `all` | `all` | `all` recalls across the whole bank (cross-project); `project` adds a `project:<id>` tag filter. |
| `autoRecall` | boolean | `true` | When false, the recall hooks contribute no blocks. |
| `autoRetain` | boolean | `true` | When false, the retain hooks store nothing. |
| `recallBudget` | number | `1200` | Token budget passed as `max_tokens` to recall (bounds the upstream payload; host-side budgeting still applies). |
| `timeoutMs` | number | `1500` | Per-request abort budget for the REST client. |

The `config` route validates overrides against this schema before persisting; an empty string
clears an optional string (`externalUrl`/`apiKey`), and numeric keys must be positive.

## Bank & tag taxonomy

**One shared, tag-scoped bank.** All Bobbit memory lives in a single Hindsight bank, id from
`config.bank` (default **`bobbit`**) in namespace `config.namespace` (default **`default`**).
Multiple Bobbit instances pointed at one Hindsight **share** the `bobbit` bank by default; isolate
them only by configuring a different bank id.

**Why one bank instead of per-project banks?** Hindsight banks are isolated and cross-bank search
is unsupported — you can only recall within a single bank. A per-project bank fan-out would make
the headline value prop ("have we solved this anywhere before?") impossible as one native query.
So Bobbit uses **one bank + tags**: scope is expressed as recall-time tag filters, not as separate
banks. Full rationale: [docs/design/hindsight-pack-external.md §7](design/hindsight-pack-external.md).

**Auto-tags on retain.** The agent never hand-tags; the provider derives tags from the hook
context and flattens them to Hindsight's `string[]` item tags as `"<key>:<value>"`:

| Tag | Source | Notes |
|---|---|---|
| `project:<projectId>` | `ctx.projectId` | Omitted when there is no project (global/server-scope session). |
| `goal:<goalId>` | `ctx.goalId` | |
| `agent:<roleName>` | `ctx.roleName` | The contributing agent's role. |
| `session:<sessionId>` | `ctx.sessionId` | |
| `kind:turn` / `kind:compaction` | derived | `turn` for `afterTurn`, `compaction` for `beforeCompact`. The `retain` pack route tags manual writes `kind:manual`. |

**Recall scope.**

- `all` (default) — recall across the whole `bobbit` bank with **no project filter**. This is the
  cross-project value: a query like "how did we configure X?" can surface a memory from any
  project.
- `project` — add a `project:<projectId>` tag filter (`tags_match: "any"`, so untagged org-wide
  memories still surface). The filter is applied **only when configured**; the default never
  narrows.

The provider calls the idempotent `client.ensureBank(bank)` before each retain path, so
correctness never depends on once-per-session in-memory state (provider workers are per-hook and
stateless).

## Provider lifecycle behaviour

The provider implements the five [Lifecycle Hub](lifecycle-hub.md) hooks. It runs on the Extension
Host worker tier, reads merged config from `ctx.config`, builds a REST client per hook, and keeps
all durable state in the pack-scoped `ctx.host.store`. Every Hindsight condition is **non-fatal**:
a slow or unhealthy backend never blocks or fails a session — recalls skip and retains queue.

| Hook | Behaviour |
|---|---|
| `sessionSetup` | If `autoRecall`: recall against the goal/task spec (`ctx.prompt`) and inject the results as a **"Relevant memory"** context block (`authority: "memory"`). On error/timeout ⇒ no block + a diagnostic. |
| `beforePrompt` | If `autoRecall`: recall against the current user turn (`ctx.prompt`) under the provider `timeoutMs` deadline; skip on timeout (non-fatal). Same block mapping. |
| `afterTurn` | If `autoRetain`: build a compact turn summary (user + final assistant text, capped ~2000 chars) and **async** retain it (fire-and-forget). On failure, enqueue for retry. Also drains one [retry-queue](#retry-queue--diagnostics) head per call. |
| `beforeCompact` | If `autoRetain`: **synchronously** retain a summary of the about-to-be-lost span, so the memory lands before context is dropped. Failure ⇒ enqueue. |
| `sessionShutdown` | Best-effort **one-pass** drain of the retry queue. Never throws. |

The recall hooks return `ContextBlock[]` only — **fencing and `providerId` are the host's job**
(see [Lifecycle Hub → fencing](lifecycle-hub.md#fencing)). Each block is titled "Relevant memory",
`authority: "memory"`, `priority: 50`, with `content` a bulleted list of recalled memory text. An
empty recall produces no block.

### Retry queue & diagnostics

A retain that fails (network/timeout/HTTP) is **not lost**. The provider appends
`{ content, tags, ts }` to a durable queue in the pack store (key `retain-queue`):

- **Cap 100** — appending past 100 entries drops the oldest (FIFO eviction).
- **Drain on `afterTurn`** — each turn retries the **queue head** (one entry) before doing the
  turn's own retain; success removes it, failure leaves it.
- **Drain on `sessionShutdown`** — one best-effort full pass.

The queue is durable (not in-memory) precisely because provider workers terminate after every hook
invocation, so an in-memory queue would lose everything between turns. Recall skips, retain
failures, and health flips are recorded as non-fatal diagnostics (`last-error` in the store and the
Hub's [context-trace](lifecycle-hub.md#the-trace-store)), and the queue depth is surfaced by the
`status` route.

## Pack routes

The pack ships server routes (`market-packs/hindsight/src/routes.ts`, declared in `pack.yaml`
under `routes.names`) for diagnostics and config persistence, reached via
`host.callRoute(<name>)` and executed in the confined worker. They share the **same pack-scoped
store** as the provider, so `status` observes the provider's real queue and last error. When the
pack is not configured, every route returns a clean structured signal (`configured: false` / empty
list) rather than erroring.

| Route | Contract |
|---|---|
| `config` | GET → merged effective config with secrets redacted (`apiKey` collapsed to `apiKeySet`). SET (with body) → validate against the schema, persist overrides to the pack store, return the new effective config. |
| `status` | `{ configured, mode, healthy, bank, namespace, recallScope, autoRecall, autoRetain, queueDepth, lastError? }`. `healthy` is a fresh `client.health()` probe when configured (short timeout), else `false`. `queueDepth` is the retry-queue length. |
| `recall` | `{ query, scope? }` → resolves bank + tags and calls `client.recall`; returns `{ memories }`. Manual/diagnostic surface. |
| `retain` | `{ content, tags?, sync? }` → `ensureBank` + `client.retain` with merged auto-tags (`kind:manual`); returns `{ ok }`. |
| `reflect` | `{ prompt }` → `client.reflect` → `{ text }`. |
| `banks` | Diagnostic: `client.listBanks()` → `{ banks }`. The pack itself uses one bank. |

## Native config & status panel

The pack ships a **native, theme-compatible panel** (Extension Platform **P4**) that is the
user-facing configuration surface and a live status/search view. It is a pure client of the
existing P2 [pack routes](#pack-routes) through the versioned Host API — it adds **no new server
routes**, never makes a raw `fetch`, and never writes pack-store config keys directly (so the
`config` route's validation + secret redaction always apply). Source is
`market-packs/hindsight/src/panel.js`, built to `lib/HindsightPanel.js`; the panel descriptor is
`panels/hindsight-memory.yaml` (`id: hindsight.panel`). Full implementation contract:
[docs/design/hindsight-panel-p4-implementation.md](design/hindsight-panel-p4-implementation.md).

**Why a native panel?** Before P4 the only non-test way to configure the pack was seeding the
pack store directly. The panel makes configuration a one-screen task, surfaces runtime health
and the retry-queue depth where the operator can act on them, and keeps secrets write-only — the
store-seeding path is now a test-only seam.

### Entrypoints

Two entrypoints open the same **singleton** panel (one per session view), declared under
`market-packs/hindsight/entrypoints/` and listed in `pack.yaml` `contents.entrypoints`:

| Entrypoint | Kind | How to reach it |
|---|---|---|
| `hindsight-palette` | `command-palette` | A launcher labelled **Hindsight Memory**. Its target is a bare `PanelTarget` (no `action: spawn`), so it opens the panel in the **active/owner session** — there is no sub-agent, unlike the pr-walkthrough spawn launchers. |
| `hindsight-route` | `route` (`routeId: hindsight`) | Deep link **`#/ext/hindsight`**. Carries no params (`paramKeys: []`); the panel rehydrates entirely from the `config`/`status` routes on mount, so a reload or shared link restores the same view. |

### What the panel does

The panel reads and writes only through `host.callRoute` and feature-detects
`host.capabilities.callRoute` (degrading to an "unavailable on this host" message on a host that
predates the capability). Its state is cached per `params.__sessionId` so reopening or reloading
rehydrates cleanly. It never mutates config on mount — mount kicks read-only `config` GET +
`status` GET; only **Save** and **Search** write.

- **Configuration card.** Picks the deployment `mode` (`external` / `managed` /
  `managed-external-postgres`) and progressively discloses the fields relevant to that mode:
  `externalUrl` (external), `dataDir` (managed), `externalDatabaseUrl` (managed-external-postgres),
  `llmApiKey` (managed modes), plus `apiKey`, `bank`, `namespace`, `recallScope`, the
  `autoRecall`/`autoRetain` toggles, and `recallBudget`/`timeoutMs`. Save POSTs **only changed**
  keys to the `config` route; an empty optional string clears that value. Validation is the route's
  job — `{ ok: false, errors }` renders inline next to Save without mutating the panel snapshot.
- **Secrets are write-only.** The `config` GET surface returns only `*Set` booleans
  (`apiKeySet`/`externalDatabaseUrlSet`/`llmApiKeySet`), so the panel shows a "set" placeholder and
  never echoes a stored secret. An untouched secret field is omitted from the Save body (preserving
  it); an explicit clear sends `""`.
- **Runtime status card.** Driven by the `status` route. A state badge derives from
  `{ configured, healthy, mode }` — **Dormant** (not configured), **Connected** (`--positive`),
  **Unreachable** (external + unhealthy, `--negative`), or **Starting** (managed + not-yet-healthy,
  `--warning`). It shows mode/bank/namespace/recallScope/auto-toggles, the **retry-queue counter**
  (`queueDepth`), `lastError` as a muted diagnostic when present, and a **logs link** affordance
  (managed modes only — points at the marketplace runtime view; the panel never starts/stops
  Docker). A **Refresh** button re-polls `status`; while a managed mode is configured-but-not-yet
  healthy the panel runs a bounded health poll so the badge flips to Connected when the runtime
  comes up. Recent-retains data is **not** invented — P2 `status` exposes only `queueDepth` +
  `lastError`, so that is what the card shows.
- **Memory search.** A query input + scope (`all`/`project`) toggle POSTs to the `recall` route
  and renders the returned memory cards (text plus optional `score`/`id`), with loading / empty /
  dormant / error states. It never calls `retain` or `reflect`.

The panel uses only Bobbit theme tokens (`--background`, `--foreground`, `--card`, `--border`,
`--primary`, `--muted-foreground`, the `--chart-*` palette, and the `--positive`/`--negative`/
`--warning` semantic slots via `color-mix`) — no hardcoded palette. Browser coverage lives in
`tests/e2e/ui/hindsight-pack.spec.ts` (reusing the shared `tests/e2e/hindsight-stub.mjs`): open
from the palette, Save external URL + bank, stub status flips to connected, search renders seeded
memories, and persistence across reload via the `#/ext/hindsight` deep link.

## REST client

`market-packs/hindsight/src/hindsight-client.ts` is a thin, faithful mapping over the Hindsight
HTTP API (`/v1/{namespace}/banks/{bank}/…`). Body shapes are mapped per the upstream `openapi.json`
(Hindsight 0.8.x); see [the design doc §3](design/hindsight-pack-external.md) for the exact request
and response mapping. Behaviour pinned by `tests/hindsight-client.test.ts`:

- Every method arms an `AbortController` with `timeoutMs` (default 1500); an abort surfaces as
  `HindsightError{ kind: "timeout" }` thrown **within budget**.
- Non-2xx ⇒ `HindsightError{ kind: "http", status }`; DNS/connection/socket failure ⇒
  `HindsightError{ kind: "network" }`.
- The `Authorization: Bearer` header is sent **only when `apiKey` is set**.
- `health()` is the sole exception that swallows errors — it is a pure reachability probe mapping
  every failure to `{ ok: false }`. Dormancy and skip-on-failure are the **provider's** job, so the
  client surface stays a faithful mapping.

## Testing

| Test | Phase | What it pins |
|---|---|---|
| `tests/hindsight-client.test.ts` | unit | Client round-trips, typed errors, timeout-within-budget, auth-header-only-when-set, namespace path-building (vs the in-process stub). |
| `tests/hindsight-provider.test.ts` | unit | Dormancy (no URL ⇒ no client constructed), auto-tag taxonomy, `recallScope` filter, retry-queue retry + cap, block shape. |
| `tests/e2e/hindsight-external.spec.ts` | E2E | sessionSetup + beforePrompt blocks appear; a turn retains on the stub with bank `bobbit` + correct tags; unhealthy ⇒ session unaffected + diagnostic + `status` unhealthy; recovery flushes the queue; per-project disable ⇒ no injection; persists across reload. |
| `tests/manual-integration/hindsight-external.test.ts` | manual | Real local Hindsight round-trip. |

The shared in-process stub `tests/e2e/hindsight-stub.mjs` (`startHindsightStub`) backs the
automated tests deterministically — no network. It records every call, serves seeded memories
filtered by request tags, records retained items, and `setHealthy(false)` flips `/health` to 503 so
the provider's skip/queue paths are exercised.

### Manual integration against a real Hindsight

`tests/manual-integration/hindsight-external.test.ts` talks directly to a running Hindsight over
HTTP (no Bobbit gateway) and exercises `ensureBank → retain → recall`, polling up to ~30 s to
tolerate Hindsight's asynchronous fact-extraction pipeline. It **skips cleanly** (never fails) when
the health probe shows Hindsight is unreachable, so the manual suite stays green on machines
without a local Hindsight.

Environment:

| Var | Default | Purpose |
|---|---|---|
| `HINDSIGHT_URL` | `http://localhost:8888` | Base URL of the running Hindsight. |
| `HINDSIGHT_NS` | `default` | Namespace path segment. |
| `HINDSIGHT_BANK` | `bobbit-it` | **Dedicated** bank id so the test never pollutes the shared production `bobbit` bank. |
| `HINDSIGHT_API_KEY` | — | Optional bearer token; sent only when set. |

```bash
npm run build && node --import tsx --test tests/manual-integration/hindsight-external.test.ts
```

## Build & packaging

The pack is built like any [first-party pack](marketplace.md#built-in-first-party-packs): the three
server modules (`hindsight-client`, `provider`, `routes`) are hand-authored TS bundled to
confined-worker Node ESM under `lib/*.mjs` by `scripts/build-market-packs.mjs` (the `hindsight`
entry in `PACKS`, `platform: "node"`), and `scripts/copy-builtin-packs.mjs` lists `"hindsight"` in
`FIRST_PARTY_PACKS` so it ships in the built-in band. The shared `src/shared.ts` is inlined into
both `provider.mjs` and `routes.mjs`; only `lib/` ships, never `src/`.

## Non-goals

Tracked in later Extension Platform goals, **not** in this release:

- Explicit agent tools `hindsight_recall/retain/reflect` — **G2.3** (the tools; the panel + entry
  points half of G2.3 shipped in P4).
- Mental-models / reflect UI / cross-engine dedupe / cost surfacing — **G4**.

> **Now shipped (were non-goals):**
> - The **native config/status panel** + command-palette and `#/ext/hindsight` deep-link
>   entrypoints landed in **P4** — see [Native config & status panel](#native-config--status-panel).
>   Store-seeding is no longer the user-facing configuration path (test-only now).
> - The managed Docker runtime + Postgres + `~/.hindsight` bind-mount + deployment-mode selection
>   (`mode: managed` / `managed-external-postgres`) landed in **P3** — see
>   [managed-runtimes.md — P3](managed-runtimes.md#p3--deployment-modes-consent--lifecycle).

## See also

- [Lifecycle Hub](lifecycle-hub.md) — the seam that runs the provider's hooks and fences its
  blocks.
- [Marketplace → built-in first-party packs](marketplace.md#built-in-first-party-packs) and
  [provider contributions](marketplace.md#provider-contributions-providersidyaml).
- [docs/design/hindsight-pack-external.md](design/hindsight-pack-external.md) — implementation
  blueprint (REST body mapping, host seams, full test plan, and the bank-topology rationale in §7).
