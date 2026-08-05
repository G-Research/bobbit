# Hindsight memory pack

Bobbit ships a built-in [first-party pack](marketplace.md#built-in-first-party-packs) named
**`hindsight`** that gives agents persistent, cross-session **memory** backed by a Hindsight
memory/recall service. The service can be an operator-supplied external endpoint or a ready
instance of Bobbit's generic service runtime. It is the first production
[lifecycle provider](lifecycle-hub.md): instead of every session starting cold, the provider
**recalls** relevant past memories into the prompt and **retains** a compact summary of each turn,
so knowledge accrues across goals, sessions, and (optionally) projects.

The provider receives only an endpoint and read-only runtime state. It never receives a runner,
Docker client, port allocator, or lifecycle controls. Consequently, its Hindsight client has the
same contract for external, local, Docker, and Compose deployments. See the focused
[Hindsight reference pack](managed-runtimes.md#hindsight-reference-pack) for the generic-runtime
boundary. The previous external-only design remains a [historical reference](design/hindsight-pack-external.md)
for REST mapping and bank topology, not the current runtime contract.

> **Current scope.** The pack supports external and generic managed-runtime endpoint selection.
> Explicit `hindsight_recall`/`retain`/`reflect` agent tools, native memory and reflect UI, and
> cross-engine dedupe remain deferred — see [Non-goals](#non-goals).

## Installed but inert until an endpoint is usable

The pack is in the built-in band and its provider declares `runtime: hindsight`. On a fresh install
it remains inert: hooks construct no client and make no Hindsight request until `isActive(cfg,
runtime)` can resolve a usable endpoint.

- With `runtimeMode: external`, activity requires a non-empty `externalUrl`.
- With `runtimeMode: local`, `docker`, or `compose`, selecting the mode only identifies the
  generic adapter. It does not start, allocate, or probe a service. The provider remains inert
  until an authorized, explicit generic-supervisor start has completed and injected a
  `state: "ready"` runtime context with an endpoint.
- A stopped, starting, degraded, blocked, or unavailable managed runtime has no usable endpoint.
  Every hook returns its normal empty/no-op result and constructs no client or network request.

**Why this boundary matters.** Memory is only useful with a reachable backing store, while provider
and read paths must stay safe and bounded. Requiring an external URL or a ready injected endpoint
prevents accidental service starts, avoids network work before operator intent, and leaves the
session usable when the service is down.

Like any first-party pack, you can also fully **disable** it from the Market UI; disabling is the
only opt-out (there is no uninstall for built-in packs). See
[built-in first-party packs](marketplace.md#built-in-first-party-packs).

## Selecting an endpoint

Set provider configuration through its existing configuration surface. There are two endpoint
sources:

- **External:** keep `runtimeMode: external` and set `externalUrl` to the Hindsight base URL
  (the upstream default port is `8888`). The provider uses that URL directly.
- **Managed:** select `local`, `docker`, or `compose`. That selection is passed to the generic
  runtime settings adapter; it does not expose a Hindsight-specific launcher. An owning host
  surface must authorize and explicitly start the runtime. Only the resulting ready runtime
  context enables recall and retain.

### Configuration keys

The config surface is declared in `market-packs/hindsight/providers/memory.yaml` and mirrored as
flat defaults in `market-packs/hindsight/src/shared.ts` (`CONFIG_DEFAULTS`). Store overrides are
overlaid on these defaults by the loader, so `ctx.config` is the single source of truth the
provider reads.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `runtimeMode` | enum `external` \| `local` \| `docker` \| `compose` | `external` | `external` uses `externalUrl`; the managed values select only a generic runtime adapter and need a ready injected endpoint. |
| `externalUrl` | string (optional) | — | Base URL for an external Hindsight deployment. It is required only when `runtimeMode` is `external`; an empty value leaves that mode inert. |
| `apiKey` | secret (optional) | — | External Hindsight bearer authorization. Sent as `Authorization: Bearer <apiKey>` only when set; reads expose only `apiKeySet`. |
| `dataDir` | string | `${stateDir}/service-data/hindsight` | Declared managed-runtime storage setting. The generic runtime owns preservation and any purge policy. |
| `bank` | string | `bobbit` | The shared memory bank id (see [Bank & tag taxonomy](#bank--tag-taxonomy)). |
| `namespace` | string | `default` | Hindsight namespace path segment. |
| `recallScope` | enum `project` \| `all` | `all` | `all` recalls across the whole bank (cross-project); `project` adds a `project:<id>` tag filter. |
| `autoRecall` | boolean | `true` | When false, the recall hooks contribute no blocks. |
| `autoRetain` | boolean | `true` | When false, the retain hooks store nothing. |
| `recallBudget` | number | `1200` | Token budget passed as `max_tokens` to recall (bounds the upstream payload; host-side budgeting still applies). |
| `timeoutMs` | number | `1500` | Per-request abort budget for the REST client. |

The configuration route validates provider overrides before persisting; an empty string clears
an optional `externalUrl` or `apiKey`, and numeric keys must be positive. `llmApiKey` is
intentionally absent: it is a runtime-owned write-only secret resolved only for an authorized
managed start, never ordinary provider configuration.

### Durable configuration availability

A proven absent provider configuration starts from schema defaults; a valid stored object overlays
those defaults. An unreadable or malformed stored config remains unavailable rather than falling
back to defaults, so a write cannot overwrite a snapshot that was not safely read. A valid default
configuration is still inert in external mode without `externalUrl`, and a valid managed selection
is still inert without a ready runtime endpoint. See [durable store reads in the Extension Host
guide](extension-host-authoring.md#durable-reads-distinguish-absence-from-an-unknown-value) for the
shared store contract and recovery behavior.

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
all durable state in the pack-scoped `ctx.host.store`. Every Hindsight condition is **non-fatal**
to the main turn: recalls skip, and a failed retain attempts a durable retry entry. That failure is
recoverable only after the queue snapshot is persisted; a compound retain-and-queue persistence
failure emits a fixed lifecycle diagnostic while the main turn remains available.

| Hook | Behaviour |
|---|---|
| `sessionSetup` | If `autoRecall`: recall against the goal/task spec (`ctx.prompt`) and inject the results as a **"Relevant memory"** context block (`authority: "memory"`) in the spawn-time system prompt. On error/timeout ⇒ no block + a diagnostic. |
| `beforePrompt` | If `autoRecall`: recall against the current user turn (`ctx.prompt`) under the provider `timeoutMs` deadline; skip on timeout (non-fatal). Same block mapping, delivered for that turn as a hidden `bobbit:dynamic-context` custom/user-side message rather than a `systemPrompt` append. |
| `afterTurn` | If `autoRetain`: build a compact turn summary (user + final assistant text, capped ~2000 chars) and **async** retain it (fire-and-forget). On remote failure, attempt a durable enqueue; only a persisted queue snapshot creates a retry. A compound failure reports `HINDSIGHT_RETAIN_QUEUE_PERSISTENCE_FAILED` without failing the turn. Also drains one [retry-queue](#retry-queue--diagnostics) head per call. |
| `beforeCompact` | If `autoRetain`: **synchronously** retain a summary of the about-to-be-lost span, so the memory lands before context is dropped. On remote failure, use the same durable-enqueue contract and non-fatal compound-failure diagnostic. |
| `sessionShutdown` | Best-effort **one-pass** drain of the retry queue. Never throws. |

The recall hooks return `ContextBlock[]` only — **fencing and `providerId` are the host's job**
(see [Lifecycle Hub → fencing](lifecycle-hub.md#fencing)). Each block is titled "Relevant memory",
`authority: "memory"`, `priority: 50`, with `content` a bulleted list of recalled memory text. An
empty recall produces no block.

### Retry queue & diagnostics

After a retain fails (network/timeout/HTTP), the provider attempts to append
`{ content, tags, ts }` to the durable pack-store queue (key `retain-queue`). The failure is
recoverable only when that queue snapshot persists. If the remote retain and queue persistence both
fail, no durable retry exists and the provider/lifecycle path emits the fixed, non-secret
`HINDSIGHT_RETAIN_QUEUE_PERSISTENCE_FAILED` diagnostic; the main turn still remains available.

- **Empty versus unknown** — a proven absent queue and a valid stored `[]` are available, with
  depth `0`; they are the only empty states. A read error or a present non-array queue is unknown.
  It is never replaced with `[]`, drained, or reported as having no work.
- **Retry behavior** — when the queue is unknown, `afterTurn` and `sessionShutdown` leave it intact
  and record the fixed `HINDSIGHT_QUEUE_UNAVAILABLE` condition when diagnostics can be persisted.
  A later hook retries the read. A failed remote retain still attempts enqueue, but enqueue returns
  not-durable rather than overwriting the unknown snapshot, causing the fixed retain-and-queue
  diagnostic above.
- **Cap 100** — a durable append past 100 entries drops the oldest (FIFO eviction).
- **Drain safety** — `afterTurn` retries one queue head; `sessionShutdown` makes one best-effort
  full pass. A remotely successful retry is removed only after the shortened queue snapshot
  persists. If that save fails, the durable queue remains the retry decision, the provider records
  `HINDSIGHT_QUEUE_DRAIN_PERSISTENCE_FAILED`, and a later retry may send the entry again rather
  than silently losing it.

The queue is durable (not in-memory) precisely because provider workers terminate after every hook
invocation, so an in-memory queue would lose everything between turns. Once the queue snapshot has
persisted, its retry remains valid even if the optional `last-error` write fails. Recall skips,
retain failures, queue availability, and health flips are non-fatal diagnostics through `last-error`
when it can be written and the Hub's [context-trace](lifecycle-hub.md#the-trace-store). The
`status` route makes unknown queue state explicit for operators rather than presenting it as an
empty backlog.

## Pack routes

The pack ships server routes (`market-packs/hindsight/src/routes.ts`, declared in `pack.yaml`
under `routes.names`) for diagnostics and config persistence, reached via
`host.callRoute(<name>)` and executed in the confined worker. They share the **same pack-scoped
store** as the provider, so `status` observes the provider's real queue and last error. A selected
managed runtime without a ready endpoint is configured but inactive; read routes return their
structured inactive result and do not construct a client, probe, allocate, or start a service.

| Route | Contract |
|---|---|
| `config` | GET → merged effective config with secrets redacted (`apiKey` collapsed to `apiKeySet`). SET (with body) → validate against the schema, persist overrides, return the new effective config. If the persisted snapshot is unreadable or invalid, both return `HINDSIGHT_CONFIG_UNAVAILABLE` rather than defaults or an overwrite. |
| `status` | `{ configured, runtimeMode, healthy, bank, namespace, recallScope, autoRecall, autoRetain, queueDepth, queueState, lastError? }`. `healthy` is a fresh `client.health()` probe only when an endpoint is active; otherwise it is `false` without client/network work. `queueState: "available"` has numeric `queueDepth` (including `0`); `queueState: "unavailable"` has `queueDepth: null` and a safe `queueError` diagnostic. |
| `recall` | `{ query, scope? }` → resolves bank + tags and calls `client.recall`; returns `{ memories }`. Manual/diagnostic surface. |
| `retain` | `{ content, tags?, sync? }` → `ensureBank` + `client.retain` with merged auto-tags (`kind:manual`); returns `{ ok }`. |
| `reflect` | `{ prompt }` → `client.reflect` → `{ text }`. |
| `banks` | Diagnostic: `client.listBanks()` → `{ banks }`. The pack itself uses one bank. |

## REST client

`market-packs/hindsight/src/hindsight-client.ts` is a thin, faithful mapping over the Hindsight
HTTP API (`/v1/{namespace}/banks/{bank}/…`). Body shapes are mapped per the upstream `openapi.json`
(Hindsight 0.8.x); the [historical external-mode design](design/hindsight-pack-external.md) preserves
the detailed request and response mapping. Behaviour pinned by `tests/hindsight-client.test.ts`:

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
| `tests2/core/hindsight-client.test.ts` | unit | Client round-trips, typed errors, timeout-within-budget, auth-header-only-when-set, and namespace path-building against the in-process stub. |
| `tests2/core/hindsight-provider.test.ts` | unit | Endpoint guard, tag taxonomy, `recallScope`, retry-queue retry + cap, and block shape. |
| `tests2/core/hindsight-service-runtime.test.ts` | unit | Descriptor schema, `runtimeMode`, mode-free client endpoint selection, read-only provider context, inactive managed reads, and runtime-secret separation. |
| `tests2/integration/hindsight-external.test.ts` | integration | External endpoint hooks, retain/recall, and bounded unhealthy degradation. |
| `tests2/integration/hindsight-runtime-context.test.ts` | integration | Lifecycle Hub injection of a mode-free runtime context and ordinary-session usability when it is unavailable. |
| `tests2/integration/service-runtime-docker.test.ts` | E2E | The same fixture across local, Docker, and Compose adapters, including dynamic loopback endpoints, retained storage, bounded degradation, and cleanup. |
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

- Explicit agent tools `hindsight_recall/retain/reflect`, the native memory panel, and entry
  points — **G2.3**.
- Mental-models / reflect UI / cross-engine dedupe / cost surfacing — **G4**.

## See also

- [Lifecycle Hub](lifecycle-hub.md) — the seam that runs the provider's hooks and fences its
  blocks.
- [Marketplace → built-in first-party packs](marketplace.md#built-in-first-party-packs) and
  [provider contributions](marketplace.md#provider-contributions-providersidyaml).
- [Managed service runtimes → Hindsight reference pack](managed-runtimes.md#hindsight-reference-pack)
  — current descriptor, endpoint, and managed-secret boundary.
- [Historical external-mode design](design/hindsight-pack-external.md) — retained REST mapping and
  bank-topology rationale; it does not define the current runtime contract.
