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

> **Current scope.** The pack supports external and generic managed-runtime endpoint selection,
> project-scoped recall, and durable lifecycle retention. It does **not** add settings UI, memory
> or reflect panels, final agent-facing Hindsight tools, or a Hindsight-private broad-recall grant.
> See [Non-goals](#non-goals).

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
| `autoRecall` | boolean | `true` | When false, the recall hooks contribute no blocks. |
| `autoRetain` | boolean | `true` | When false, the retain hooks store nothing. |
| `recallBudget` | number | `1200` | Token budget passed as `max_tokens` to recall (bounds the upstream payload; host-side budgeting still applies). |
| `timeoutMs` | number | `1500` | Per-request REST timeout; lifecycle work also honors the host deadline. |
| `retainEveryNTurns` | number | `1` | Flush a durable turn batch after this many primary turns. |
| `retainMaxDelayMs` | number | `60000` | Flush a durable turn batch once its oldest primary turn reaches this age. |

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
is unsupported — you can only recall within a single bank. Bobbit uses **one bank + tags** to avoid
bank fan-out while retaining a strict project boundary at recall time. Tags express scope without
turning the bank topology into authorization. Full rationale: [docs/design/hindsight-pack-external.md §7](design/hindsight-pack-external.md).

**Authoritative tags and scope.** The provider derives rich identity only from immutable
`scopeContext`; compatibility flat fields are never a fallback. It flattens the authoritative scope
and lifecycle event
to Hindsight's `string[]` item tags as `"<key>:<value>"`:

| Tag | Source | Notes |
|---|---|---|
| `project:<projectId>` | `scopeContext.project.id` | Required for normal retain and recall. |
| `goal:<goalId>` | `scopeContext.goal.id` | Added when the host can resolve the leaf goal. |
| `agent:<role>` | `scopeContext.role` | Retained observation provenance. |
| `session:<sessionId>` | lifecycle event | Retained observation provenance. |
| `kind:turn`, `kind:compaction`, or `kind:outcome` | lifecycle event | Identifies normal batches, pre-compaction saves, and goal-completion outcomes. |

Recall is always narrow: it uses strict conjunction over the authoritative project tag and, when
available, the authoritative goal tag. Missing project scope returns no memory and does not create
a client or issue a remote request. Route bodies and flat compatibility fields cannot select another
project or broaden the filter.

Broad `all` recall is not an ordinary configuration or route option. It can exist only when the
central EP-6 capability contract is present and grants `memory.read.all` for that invocation; this
pack does not create a private grant path. Without that central grant, broad recall fails closed.

The provider calls the idempotent `client.ensureBank(bank)` before each retain path, so
correctness never depends on once-per-session in-memory state (provider workers are per-hook and
stateless).

## Provider lifecycle and durability

The provider implements the ordinary [Lifecycle Hub](lifecycle-hub.md) hooks plus host-originated
`goalCompleted`. It runs on the Extension Host worker tier, reads merged config from `ctx.config`,
and keeps durable operational state in the pack-scoped `ctx.host.store`. The host owns the absolute
lifecycle deadline and cancellation signal; the worker must not extend either. This keeps a late
store transition from claiming that work completed after the host stopped waiting.

| Hook | Behaviour |
|---|---|
| `sessionSetup` | Requests bounded stranded-record recovery, then, if `autoRecall`, recalls against the startup prompt and returns a **Relevant memory** context block. |
| `beforePrompt` | If `autoRecall`, recalls against the current prompt. The block is delivered as hidden `bobbit:dynamic-context`, not appended to `systemPrompt`. |
| `afterTurn` | Drains at most one retry head, then appends a bounded turn summary to a durable batch. A batch flushes on its configured count or age threshold. |
| `beforeCompact` | Retains a bounded summary of the about-to-be-lost span before compaction, using the same remote-or-durable-queue outcome. |
| `sessionShutdown` | Makes one best-effort pass over this project's retry queue. |
| `goalCompleted` | Retains a bounded host-built goal outcome (goal fields, then task/gate summaries) tagged `kind:outcome`. This event is dispatched only by the host completion lifecycle. |

A flush retains the exact durable primary-turn prefix. Only a successful remote retain or a
confirmed durable queue append permits the provider to advance that pending record; a failed
advance intentionally leaves duplicate-eligible work rather than losing a concurrently appended
suffix. Pending records, queue entries, and document ids carry a versioned canonical identity plus
the captured project/goal/session/role and bank/namespace target. The encoding makes identifiers
opaque and ensures a list prefix is only a candidate selector, never authorization.

The recall hooks return `ContextBlock[]` only — **fencing and `providerId` are the host's job**
(see [Lifecycle Hub → fencing](lifecycle-hub.md#fencing)). Each block is titled "Relevant memory",
`authority: "memory"`, `priority: 50`, with `content` a bulleted list of recalled memory text. An
empty recall produces no block.

### Retry queue, stranded records, and diagnostics

Retries are project-partitioned and preserve their original scope, tags, bank, namespace, and
document id. A replay reconstructs its target from the record rather than from the session that
happens to drain it. This prevents a changed configuration or a different project session from
retaining private material into the wrong bank or namespace.

A failed remote retain is recoverable only after a durable queue append. If both operations fail,
no retry exists and the provider reports `HINDSIGHT_RETAIN_QUEUE_PERSISTENCE_FAILED`; it must not
report success.

- **Unknown is not empty** — unreadable or malformed durable queue/pending data is quarantined:
  it is not overwritten, drained, or replayed. Queue unavailability is diagnosable as
  `HINDSIGHT_QUEUE_UNAVAILABLE`.
- **Fenced removal** — a remotely replayed entry is removed only after the shortened queue commits.
  A failed removal reports `HINDSIGHT_QUEUE_DRAIN_PERSISTENCE_FAILED`; a later replay may duplicate
  the remote retain but cannot silently lose the record.
- **Stranded sweep** — `sessionSetup` can claim a durable, project-partitioned lease. The sweep uses
  an injected clock, never overlaps a live lease, and reclaims only an expired one. It checkpoints
  a candidate only after its pending record advanced durably, and records completion only after the
  whole pass reaches a durable terminal point. Deadline, abort, read, validation, or mutation
  failure leaves the record retryable rather than advancing the cadence.

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
| `status` | Reports configuration, endpoint health, and safe queue/error diagnostics. It does not turn unknown durable state into an empty queue. |
| `recall` | `{ query }` → recalls only under the authoritative route `scopeContext`; missing scope returns no memories and makes no remote call. Request data cannot choose a broader scope. |
| `retain` | `{ content, tags?, sync? }` → `ensureBank` + `client.retain` with route-derived project/goal tags; caller tags cannot replace those scope tags. |
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
| `tests2/core/hindsight-provider.test.ts` | unit | Endpoint guard, scope-only recall, batched retain, project-partitioned retry, diagnostic redaction, and bounded outcome payloads. |
| `tests2/core/hindsight-memory-completion.test.ts` | unit | Canonical identity/prefix separation, injected-clock sweep cadence and lease behavior, deadline/checkpoint fencing, and scope-preserving stranded replay. |
| `tests2/core/lifecycle-delivery-foundation.test.ts` | unit | Concurrent lifecycle single-flight, durable completion markers, deadline behavior, and retryable failures without false duplicate success. |
| `tests2/core/hindsight-service-runtime.test.ts` | unit | Descriptor schema, `runtimeMode`, mode-free client endpoint selection, read-only provider context, inactive managed reads, and runtime-secret separation. |
| `tests2/integration/hindsight-external.test.ts` | integration | External endpoint hooks, retain/recall, and bounded unhealthy degradation. |
| `tests2/integration/hindsight-memory-completion.test.ts` | integration | Host-to-worker authoritative scope, no remote call on missing scope, completion marker/queue behavior, and isolation of foreign or malformed stranded records. |
| `tests2/integration/hindsight-runtime-context.test.ts` | integration | Lifecycle Hub injection of a mode-free runtime context and ordinary-session usability when it is unavailable. |
| `tests2/integration/service-runtime-docker.test.ts` | E2E | The same fixture across local, Docker, and Compose adapters, including dynamic loopback endpoints, retained storage, bounded degradation, and cleanup. |
| `tests/manual-integration/hindsight-external.test.ts` | manual | Real local Hindsight round-trip. |

The shared in-process stub `tests/e2e/hindsight-stub.mjs` (`startHindsightStub`) backs the
automated tests deterministically — no network. It records every call, serves seeded memories
filtered by request tags, records retained items, and `setHealthy(false)` flips `/health` to 503 so
the provider's skip/queue paths are exercised.

For a durability, scope, or completion regression, start with the three focused core tests above
and `tests2/integration/hindsight-memory-completion.test.ts`. They distinguish an intentionally
retryable record from an incorrect success marker, checkpoint, or cross-project remote call.

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

- Settings, status, memory, reflect, or admin UI; memory/reflect panels; and final agent, MCP, or
  other Hindsight tool entry points.
- Creating EP-6, `memory.read.all`, or any Hindsight-private broad-recall authorization path.
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
