# Hindsight pack — external mode (EP G2 / G2.1 + G2.2)

Status: design / implementation blueprint. Scope is the **external-URL** Hindsight memory pack:
a REST client, an in-process stub harness, the lifecycle provider, pack routes + config surface,
bank/tag derivation, dormancy, and built-in-band registration (dormant). Managed Docker runtime,
Postgres, volumes, deployment-mode selection, the explicit agent tools, and the native panel were
**out of scope** of this blueprint (G2.3 / G3 / G4) and shipped later: the managed runtime in P3,
the native panel in P4, and the agent tools `hindsight_recall/retain/reflect` in **P5** (see
[hindsight-memory.md → Agent tools](../hindsight-memory.md#agent-tools)).

> Authority notes. This folds the impl-plan's **G2.1 + G2.2** ([extension-platform-implementation-plan.md
> §G2](extension-platform-implementation-plan.md)) and applies two owner overrides recorded for
> this goal:
> 1. **One shared, tag-scoped bank** (default id `bobbit`), configurable — *not* the impl-plan's
>    per-project `bobbit-proj-<id>`/`bobbit-global` fan-out sketch. Cross-bank search is impossible
>    in Hindsight, so a single bank + tags is correct, and multiple Bobbit instances pointed at one
>    Hindsight SHARE the `bobbit` bank by default. Authoritative rationale:
>    [agent-memory.md §3](agent-memory.md). (Bobbit reconciles the EP design docs separately.)
> 2. **External mode only** here. The managed runtime is G3.
>
> Provider lifecycle hooks (`sessionSetup/beforePrompt/afterTurn/beforeCompact/sessionShutdown`),
> the Lifecycle Hub, `ContextBlock` shape, host-side fencing, the prompt-sections / context-trace
> inspectors, and most loader/activation plumbing are delivered by **G1** (the base branch
> `goal/per-turn-provi-7f764705`, PR #788). This pack consumes those seams and adds the small
> host-side G1.x amendments listed in §1.3 for config-gated provider activation, flat provider
> config, and provider store access. See [extension-platform.md §5–§6, §11](extension-platform.md).

---

## 1. Owned files & build outputs

Most pack/test files are new. Existing-file edits are explicitly listed here because several are
shared extension-platform seams and must be serialized carefully with adjacent EP work.

### 1.1 Pack-owned files

| Source | Built output | Purpose |
|---|---|---|
| `market-packs/hindsight/src/hindsight-client.ts` | `market-packs/hindsight/lib/hindsight-client.mjs` | REST client (typed errors, timeouts, path/body mapping). |
| `market-packs/hindsight/src/provider.ts` | `market-packs/hindsight/lib/provider.mjs` | Lifecycle provider (`export default {…}`), worker tier. |
| `market-packs/hindsight/src/routes.ts` | `market-packs/hindsight/lib/routes.mjs` | Pack routes `status/recall/retain/reflect/banks/config`. |
| `market-packs/hindsight/pack.yaml` | — (served as-is) | Manifest, `schema: 2`. |
| `market-packs/hindsight/providers/memory.yaml` | — | Provider contribution + `config` surface. |
| `tests/e2e/hindsight-stub.mjs` | — | In-process stub Hindsight (reused by later goals). |
| `tests/hindsight-client.test.ts` | — | Unit: client round-trips, errors, timeouts, auth, paths. |
| `tests/hindsight-provider.test.ts` | — | Unit: dormancy, tag taxonomy, scope filter, retry queue, block shape. |
| `tests/e2e/hindsight-external.spec.ts` | — | API E2E against the stub. |
| `tests/manual-integration/hindsight-external.test.ts` | — | Real local Hindsight round-trip. |

### 1.2 Build wiring

Append entries, never reorder — file-conflict hotspot, serialize merges in goal order:

- `scripts/build-market-packs.mjs` `PACKS`: add a `hindsight` entry bundling the three server
  modules `platform: "node"`, each `lib/*.mjs` (`hindsight-client`, `provider`, `routes`). These
  are hand-authored TS compiled to confined-worker Node ESM — the same `platform:"node"` treatment
  pr-walkthrough's `yaml-to-cards` gets, NOT the browser/panel path. (Panel/tools are G2.3.)
- `scripts/copy-builtin-packs.mjs` `FIRST_PARTY_PACKS`: add `"hindsight"` so the pack ships in the
  built-in band (dormant).

### 1.3 Host-side G1.x amendments required by this pack

| File | Change | Rationale |
|---|---|---|
| `src/server/agent/pack-contributions.ts` | Resolve provider `config` schema entries to flat default values (`default`, or `undefined` for optional) instead of passing raw schema descriptors verbatim; preserve schema metadata for route validation if needed. | Provider dormancy and defaults require `ctx.config.mode === "external"`, not `{ type, default }`. |
| `src/server/extension-host/pack-contribution-registry.ts` (or the central provider listing path) | Apply config-gated provider activation: a provider with `activation.requiresConfig: [externalUrl]` is omitted from `listProviders(projectId)` until the effective flat config has a non-empty `externalUrl`; DisabledRefs still wins. | True dormant install: no active provider, no provider bridge injection, no per-turn gateway hook calls, and no Hindsight/network work until configured. |
| `src/server/agent/lifecycle-hub.ts` | Thread provider pack identity/effective config to dispatch; construct a provider-scoped `ServerHostApi` for provider invocations only when needed; pass it to `ModuleHost.invoke`. | Gives provider hooks the same pack-scoped store routes use, without raw transport or cross-pack access. |
| `src/server/extension-host/module-host-worker.ts` / `module-host-bootstrap.ts` | Serialize provider contexts with proxied `ctx.host.store` and `capabilities.store === true`; keep `callRoute:false`, `session:false`, `agents:false`. Do not clone the live host into worker data. | Durable retry queue/diagnostics require pack store from stateless provider workers; the parent remains the capability authority. |
| `src/server/extension-host/server-host-api.ts` | If needed, add a constructor option/capability mask so provider host APIs can expose only `store` while route/action hosts keep their existing capabilities. | Security-sensitive least-privilege seam for provider hooks. |
| `tests/pack-providers-loader.test.ts` / `tests/pack-contributions.test.ts` | Assert flat config defaults, store-over-yaml overrides, and config-gated provider omission when `externalUrl` is absent. | Pins the central dormant/activation invariants before pack code. |
| `tests/e2e/provider-session-setup.spec.ts` / provider bridge coverage | Assert an unconfigured built-in Hindsight provider does not inject the provider bridge or per-turn hook route, while a configured provider does. | Pins true zero-overhead dormant install. |

Pack layout (this goal):

```
market-packs/hindsight/
  pack.yaml                  # schema 2; contents.providers: [memory]; routes
  providers/memory.yaml      # kind: memory; lifecycle hooks; config surface
  src/hindsight-client.ts    # → lib/hindsight-client.mjs
  src/provider.ts            # → lib/provider.mjs
  src/routes.ts              # → lib/routes.mjs
```

---

## 2. `pack.yaml` (schema 2) & provider contribution

```yaml
# market-packs/hindsight/pack.yaml
schema: 2
name: hindsight
description: >-
  Persistent agent memory backed by Hindsight (recall/retain/reflect over a shared,
  tag-scoped bank). Default-disabled until Marketplace setup enables/configures it. See docs/design/agent-memory.md.
version: 1.0.0
contents:
  roles: []
  tools: []                 # explicit hindsight_* tools land in G2.3
  skills: []
  entrypoints: []           # panel + deep link land in G2.3
  providers: [memory]       # → providers/memory.yaml
  hooks: []
  mcp: []
  pi-extensions: []
  runtimes: []              # managed runtime lands in G3
  workflows: []
provides: []
requires: []
routes:
  module: lib/routes.mjs
  names: [status, recall, retain, reflect, banks, config]
```

```yaml
# market-packs/hindsight/providers/memory.yaml
id: memory
kind: memory
module: ../lib/provider.mjs
hooks: [sessionSetup, beforePrompt, afterTurn, beforeCompact, sessionShutdown, goalCompleted]
budget: { maxTokens: 1200, timeoutMs: 1500 }
defaultEnabled: true        # provider default once the pack itself is enabled/configured
config:
  mode:        { type: enum, values: [external, managed], default: external }  # managed reserved for G3
  externalUrl: { type: string, optional: true }
  apiKey:      { type: secret, optional: true }
  bank:        { type: string, default: bobbit }
  namespace:   { type: string, default: default }
  recallScope: { type: enum, values: [project, all], default: all }
  autoRecall:  { type: boolean, default: true }
  autoRetain:  { type: boolean, default: true }
  recallBudget:{ type: number, default: 1200 }
  timeoutMs:   { type: number, default: 1500 }
activation:
  requiresConfig: [externalUrl]  # host omits the provider entirely until configured
```

Loaded via the **pack-contributions path** (`pack-contributions.ts`-style loader into the
`PackContributionRegistry`, keyed `(packId, contributionId)`), per impl-plan §0.2 — NOT a new
`EntityType`. The provider runs on the Extension Host worker tier exactly like the `provider-demo`
fixture. Per-entity activation still respects `DisabledRefs.providers` / `pack_activation`, but
Hindsight also declares pack-level `defaultDisabled: true` and provider-level activation gates. On
fresh installs the pack-level overlay disables all contributions; after setup enables/configures the
pack, `activation.requiresConfig: [externalUrl]` (or managed-mode `activeWhenConfig` in the current
pack) keeps the provider omitted until the effective config/runtime is usable. This is what prevents
bridge injection and per-turn hook calls before opt-in.

---

## 3. `HindsightClient` (`src/hindsight-client.ts`)

### 3.1 Interface (implement exactly)

```ts
export interface HindsightClient {
  health(): Promise<{ ok: boolean }>;
  ensureBank(bank: string): Promise<void>;                 // PUT …/banks/{bank}
  recall(
    bank: string,
    query: string,
    opts?: {
      maxTokens?: number;
      tags?: Record<string, string>;
      tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
    },
  ): Promise<{ memories: { text: string; score?: number; id?: string }[] }>;
  retain(
    bank: string,
    content: string,
    opts?: { tags?: Record<string, string>; sync?: boolean },
  ): Promise<void>;                                         // POST …/memories
  reflect(bank: string, prompt: string): Promise<{ text: string }>;
  listBanks(): Promise<{ banks: string[] }>;
}

export function createClient(cfg: {
  baseUrl: string;
  apiKey?: string;
  namespace?: string;   // default "default"
  timeoutMs?: number;   // default 1500
}): HindsightClient;
```

### 3.2 Error behaviour

```ts
export class HindsightError extends Error {
  kind: "timeout" | "http" | "network";
  status?: number;     // present for kind:"http"
}
```

- Every method wraps its `fetch` in an `AbortController` armed with `cfg.timeoutMs` (default
  **1500 ms**). Abort ⇒ `HindsightError{ kind:"timeout" }`, thrown **within budget** (the test
  asserts elapsed ≤ a small margin over `timeoutMs`).
- Non-2xx ⇒ `HindsightError{ kind:"http", status }`.
- DNS/connection refused/socket error ⇒ `HindsightError{ kind:"network" }`.
- The client never swallows errors — dormancy and skip-on-failure are the **provider's** job
  (§5), so the client surface stays a thin, faithful mapping.

### 3.3 Path construction

Base path template: `${baseUrl}/v1/${namespace}/banks/${bank}/…`; `namespace` defaults to
`default`; `bank` is the caller-supplied id (the provider passes the configured `bank`, default
`bobbit`). `baseUrl` is trimmed of any trailing `/`. Bank ids and namespace are URL-path-segment
encoded.

| Method | HTTP | Path |
|---|---|---|
| `health` | GET | `/health` (no namespace/bank prefix) |
| `ensureBank` | PUT | `/v1/{ns}/banks/{bank}` |
| `recall` | POST | `/v1/{ns}/banks/{bank}/memories/recall` |
| `retain` | POST | `/v1/{ns}/banks/{bank}/memories` |
| `reflect` | POST | `/v1/{ns}/banks/{bank}/reflect` |
| `listBanks` | GET | `/v1/{ns}/banks` |

Default port for external URLs is `8888` (documented; the user supplies the full `baseUrl`).

### 3.4 Headers

- `Content-Type: application/json` on POST/PUT.
- API key header **only when `cfg.apiKey` is set**. Hindsight reads an optional `authorization`
  header; the client sends `Authorization: Bearer <apiKey>`. When unset, no auth header is sent
  (pinned by a unit test on both branches).

### 3.5 Body mapping (verified against `openapi.json`, Hindsight 0.8.x)

**`ensureBank` → `create_or_update_bank`** — PUT body is a `CreateBankRequest`; all fields
auto-fill, so the client sends a minimal `{}` (idempotent create-or-update). Call it once before
the first retain so the bank exists.

**`recall` → `recall_memories`** — request `RecallRequest`:
```jsonc
{ "query": "<query>", "max_tokens": <maxTokens ?? recallBudget>,
  "tags": ["project:abc", "kind:turn"],          // flattened from opts.tags (see §7)
  "tags_match": "<tagsMatch ?? 'any'>" }
```
Response `RecallResponse` has `results: RecallResult[]` (each `{ id, text, type?, … }`). Map to
`{ memories: results.map(r => ({ text: r.text, id: r.id, score: r.score })) }`. `RecallResult`
has no guaranteed `score` field in 0.8.x, so `score` is mapped as `undefined` when absent — the
contract types it optional. `tags`/`tags_match` are omitted from the body when `opts.tags` is
empty.

**`retain` → `retain_memories`** — request `RetainRequest` with **item-level** tags:
```jsonc
{ "items": [ { "content": "<content>", "tags": ["project:abc", "goal:g1", "kind:turn"] } ],
  "async": <!sync> }
```
`opts.sync` maps to `async = !sync` (Hindsight's `async` defaults to `false` = synchronous). The
provider calls `retain` async (`sync:false`/`async:true`) on `afterTurn` and synchronous
(`sync:true`/`async:false`) on `beforeCompact`. Response (`RetainResponse`) is ignored beyond the
2xx check (extraction is async; progress is trackable via `…/operations`, not needed here).

**`reflect` → `reflect`** — request `ReflectRequest` `{ "query": "<prompt>" }`; response
`ReflectResponse` `{ text }`. Map straight through.

**`listBanks` → `list_banks`** — GET; response `BankListResponse` `{ banks: BankListItem[] }`.
Map each item to its bank id ⇒ `{ banks: string[] }`.

---

## 4. Stub harness (`tests/e2e/hindsight-stub.mjs`)

In-process `http.createServer`, reused by every later goal:

```ts
startHindsightStub({ port?: 0 }): Promise<{
  url: string;
  calls: RecordedCall[];                          // { method, path, bank, namespace, body }
  setHealthy(ok: boolean): void;                  // false ⇒ /health 503 and ops 503
  seedMemories(bank: string, mem: { text: string; id?: string; score?: number; tags?: string[] }[]): void;
  retained(bank?: string): { content: string; tags: string[]; async: boolean }[];
  close(): Promise<void>;
}>
```

- Canned JSON for the six client operations matching the `openapi.json` response shapes.
- Records every call (method, path, parsed bank + namespace, body) for assertions.
- `recall` returns seeded memories for the requested bank, filtered by the request's `tags` +
  `tags_match` so scope-filter tests are real.
- `retain` records `{ content, tags, async }` per item (assert bank + tag taxonomy).
- `setHealthy(false)` flips `/health` to 503 and fails recall/retain with 503 so the provider's
  skip/queue paths are exercised; `setHealthy(true)` restores.
- Deterministic, no network. Port 0 ⇒ ephemeral.

---

## 5. Provider (`src/provider.ts`, `export default {…}`)

Runs on the worker tier. Reads merged config from `ctx.config`; durable pack KV is accessed via
proxied `ctx.host.store` after the host-side addendum in §1.3. Provider workers are per-hook and
stateless, so the provider constructs a client per hook from config; any durable state (retry
queue, last error, optional bank-ensured marker) lives in `ctx.host.store`, never module globals.

### 5.1 Dormancy gate (the central invariant)

Before any hook does work it evaluates **`isActive(ctx)`**: external mode requires a non-empty
`externalUrl`, while managed modes require a host-injected running runtime. If not active, **every
hook returns immediately**: `sessionSetup`/`beforePrompt` ⇒ `{ blocks: [] }`;
`afterTurn`/`beforeCompact`/`sessionShutdown`/`goalCompleted` ⇒ no-op. This is a defensive
backstop. The primary dormant guarantee is earlier in the host: `defaultDisabled: true` disables all
pack contributions on a fresh unconfigured install, and provider activation gates keep the provider
omitted until setup/config makes it usable. No client is constructed, no Hindsight network is
touched, and spawn args/prompt text stay at the no-pack
baseline until configured (§9.5).

Health is treated as a runtime condition layered on top of activation: when active but the client
reports unhealthy/times out, recalls skip (non-fatal) and retains queue (§8); the pack stays
"configured" and the `status` route reports `unhealthy`.

### 5.2 Hooks

| Hook | Behaviour |
|---|---|
| `sessionSetup` | If `autoRecall`: `recall(bank, ctx.prompt /* goal/task spec */, { maxTokens: recallBudget, tags, tagsMatch })`. Map results → `ContextBlock[]` titled **"Relevant memory"**, `authority:"memory"`. On error/timeout ⇒ `{ blocks: [] }` + diagnostic. |
| `beforePrompt` | If `autoRecall`: `recall(bank, ctx.prompt /* user turn */, …)` under a deadline = provider `timeoutMs`; skip on timeout (non-fatal). Same block mapping. |
| `afterTurn` | If `autoRetain`: build a compact turn summary (user text + final assistant text, capped ~2000 chars), `retain(bank, summary, { tags, sync:false })` **async** (fire-and-forget). On failure, push `{ content, tags, ts }` onto the retry queue (§8). Also drains one queue head per call. |
| `beforeCompact` | If `autoRetain`: `retain(bank, <about-to-be-lost span summary>, { tags, sync:true })` — synchronous so the memory lands before context is dropped. Failure ⇒ queue. |
| `sessionShutdown` | Best-effort **one-pass** queue drain. No throw. |

### 5.3 Block shape & fencing

The provider returns `ContextBlock[]` only — **fencing is the host's job** (G1.2 `fenceBlock`),
and `providerId` is set by the Hub. Each block:

```ts
{
  id: "memory:<n>",          // local id; Hub namespaces to "<providerId>:<id>"
  title: "Relevant memory",
  authority: "memory",
  priority: 50,
  reason: `Recall for: ${truncate(query)}`,
  content: memories.map(m => `- ${m.text}`).join("\n"),
}
```

Budget (`maxTokens`/`recallBudget`) is enforced host-side by priority-ordered truncation; the
provider passes `max_tokens` to recall to bound the upstream payload too. Empty recall ⇒ no block.

### 5.4 Config read

The provider reads only `ctx.config` for configuration (already merged — see §8.3). It never reads
config keys from the pack store directly; the loader resolves schema defaults and overlays
persisted store config so `ctx.config` is the one source of truth. `apiKey` arrives resolved
(secret) in `ctx.config`. The provider may use `ctx.host.store` only for operational state such as
the retain queue and diagnostics.

---

## 6. Pack routes (`src/routes.ts`)

`export const routes = { … }`, executed in the confined worker; `ctx.host.store.{get,put,list}`
is pack-scoped (server-derived packId; cross-pack reads rejected). Config and the retry queue live
in this same pack-scoped store. Routes already receive this capability; providers receive the same
pack-scoped store via §1.3, so `status.queueDepth` observes the same queue that hook failures append
to.

| Route | Verb (logical) | Contract |
|---|---|---|
| `config` | get/set | GET returns the merged effective config (secrets redacted to a boolean `apiKeySet`). SET validates against the `providers/memory.yaml` `config` schema and persists to the pack store under a per-scope key; `apiKey` written via the secret mechanism, never echoed. Returns the new effective config. |
| `status` | get | `{ configured, mode, healthy, bank, namespace, recallScope, autoRecall, autoRetain, queueDepth, lastError? }`. `healthy` is a fresh `client.health()` when configured (short timeout), else `false`. `queueDepth` = retry-queue length. |
| `recall` | post | `{ query, scope? }` → resolves bank+tags (§7), calls `client.recall`, returns `{ memories }`. Manual/diagnostic surface (panel uses it in G2.3). |
| `retain` | post | `{ content, tags?, sync? }` → `client.retain` with merged auto-tags. Returns `{ ok }`. |
| `reflect` | post | `{ prompt }` → `client.reflect` → `{ text }`. |
| `banks` | get | `client.listBanks()` → `{ banks }` (diagnostic; the pack uses one bank). |

All routes respect dormancy: when not configured they return a structured `{ configured:false }`
shape (or `{ memories: [] }` / `{ banks: [] }`) rather than erroring, so the panel and tests get
a clean dormant signal.

---

## 7. Bank & tag taxonomy

- **Bank**: single shared bank, id from `config.bank` (default **`bobbit`**). Namespace from
  `config.namespace` (default **`default`**). Because provider workers are stateless per hook, the
  provider calls the idempotent `client.ensureBank(bank)` before each retain path (or uses a
  best-effort `ctx.host.store` marker as an optimization only). Correctness never depends on
  in-memory "once per session" state.
- **Auto-tags on retain** (the agent never hand-tags): `project:<projectId>`, `goal:<goalId>`,
  `agent:<roleName>`, `session:<sessionId>`, `kind:turn` (for `afterTurn`) / `kind:compaction`
  (for `beforeCompact`). Tags are derived from `ctx` (projectId, goalId, roleName, sessionId).
  Flattened to Hindsight's `string[]` item tags as `"<key>:<value>"`.
- **Recall scope** (`config.recallScope`, default **`all`**):
  - `all` ⇒ recall across the whole `bobbit` bank with **no project tag filter** (the
    cross-project value prop: "have we solved this anywhere before?" is one native query).
  - `project` ⇒ add a `project:<projectId>` tag filter (`tags_match: "any"`; `any_strict` is the
    knob to exclude untagged, left default-`any` so untagged org-wide memories still surface).
  The project-scope filter is applied **only when configured**; the default never narrows.
- This supersedes the impl-plan's per-project/global bank fan-out: one bank, tag filters, no
  `Promise.allSettled` multi-bank merge. Rationale + verified Hindsight facts (banks isolated,
  cross-bank search unsupported, tags are the filter): [agent-memory.md §3](agent-memory.md).

---

## 8. Retry queue, diagnostics & config merge

### 8.1 Queue semantics

- Backed by provider-accessible `ctx.host.store` under a single pack-scoped key (e.g.
  `retain-queue`), an array of `{ content, tags, ts }`. This requires and tests the provider
  store-capability addendum in §1.3; an in-memory queue is explicitly insufficient because provider
  workers terminate after every hook invocation.
- On any retain failure (network/timeout/http) the entry is **appended**.
- **Cap 100**: when appending would exceed 100, **drop the oldest** (FIFO eviction).
- **Drain**: each `afterTurn` drains the **queue head** (one entry) by retrying its retain before
  doing the turn's own retain; success removes it, failure leaves it (and the turn's own failure,
  if any, re-appends at the tail). `sessionShutdown` does one best-effort full pass.
- Depth is surfaced via the `status` route (`queueDepth`) and reflected in the panel (G2.3).

### 8.2 Diagnostics

Recall skips, retain failures, health flips, and queue evictions are recorded as **non-fatal
diagnostics** through the Hub's context-trace channel (`GET /api/sessions/:id/context-trace`,
G1.2) and summarised by the `status` route (`lastError`, `queueDepth`). The session is never
blocked or failed by any Hindsight condition.

### 8.3 Loader/store config merge

The provider must receive a **flat** config object that is **store-over-yaml-defaults**:

1. The loader first resolves each `providers/memory.yaml` config schema entry to its `.default`
   value (or `undefined` for optional fields), producing values such as `mode: "external"`,
   `bank: "bobbit"`, `namespace: "default"`, `autoRecall: true`, and `timeoutMs: 1500` — not raw
   `{ type, default }` schema objects.
2. The `config` route persists validated overrides to the pack store.
3. The loader overlays persisted store config over the flat defaults before constructing
   `ctx.config`.
4. The default-disabled pack overlay disables all contributions on fresh unconfigured installs;
   after setup enables/configures the pack, provider activation filters evaluate the effective flat
   config/runtime before bridge injection.

If G1.1 currently exposes only static yaml, both the default-resolution step and the store-config
overlay are added **in the loader path, not the provider** (so every provider benefits and
`ctx.config` stays the single source of truth). Add loader-level tests asserting provider
`ctx.config` receives flat resolved values and unconfigured providers are filtered out.

---

## 9. Test plan (author FIRST; RED → GREEN)

### 9.1 Unit — `tests/hindsight-client.test.ts` (vs stub)
- Five ops + `ensureBank` round-trip with correct paths/bodies (assert via stub `calls`).
- Timeout ⇒ `HindsightError{ kind:"timeout" }` thrown **within budget**.
- 500 ⇒ `HindsightError{ kind:"http", status:500 }`; connection refused ⇒ `{ kind:"network" }`.
- Auth header present **only** when `apiKey` set (both branches).
- Namespace path-building (default `default`; custom namespace changes the path).
- `recall` maps `results` → `memories`; `retain` sends item-level tags + `async:!sync`.

### 9.2 Unit — `tests/hindsight-provider.test.ts`
- **Dormancy**: no `externalUrl` ⇒ every hook is a no-op / `{ blocks: [] }` and constructs no
  client (assert zero stub calls).
- **Auto-tag taxonomy** on retain: `project/goal/agent/session/kind` all present and correct.
- **`recallScope`**: `project` ⇒ `project:<id>` tag filter sent; `all` ⇒ no project filter.
- **Provider store capability + retry queue**: provider hooks receive proxied `ctx.host.store`
  with `capabilities.store === true`; failure enqueues durably; cap 100 drops oldest; later
  `afterTurn` drains head; `sessionShutdown` one-pass drain; `status.queueDepth` reads the same
  pack-store key.
- **Block shape**: `authority:"memory"`, title, reason, content formatting; empty recall ⇒ no
  block.

### 9.3 API E2E — `tests/e2e/hindsight-external.spec.ts`
Provider-demo-style: stub loaded via `BOBBIT_BUILTIN_PACKS_DIR`; the `config` route sets
`externalUrl` to the stub.
- `sessionSetup` + `beforePrompt` blocks appear (prompt-sections / context-trace).
- A turn ⇒ retain recorded on the stub with bank `bobbit` + correct tags.
- `setHealthy(false)` ⇒ session unaffected + diagnostic in trace + `status` reports unhealthy.
- Recovery (`setHealthy(true)`) ⇒ queued retain flushes (stub records it).
- Per-project pack disable (`pack_activation`) ⇒ no injection.
- Config persists across reload.

### 9.4 Manual integration — `tests/manual-integration/hindsight-external.test.ts`
Real local Hindsight. Env `HINDSIGHT_URL` (default `http://localhost:8888`); dedicated bank
`HINDSIGHT_BANK` (default `bobbit-it`) so it never pollutes the real `bobbit` bank.
- `ensureBank` → `retain` → poll `recall` until the memory surfaces (bounded ~30 s, tolerating
  async extraction) → assert recall returns it.
- **Skips cleanly** when `HINDSIGHT_URL` is unreachable (health probe first).

### 9.5 Dormant prompt parity (acceptance pin)
On a fresh dev install with the pack installed-but-unconfigured, the host's config-gated activation
omits the provider before session setup. The parity test asserts:

- no provider bridge extension is added to spawn args;
- no `/provider-hooks/*` gateway requests are made for Hindsight;
- assembled system-prompt text is byte-identical to the no-pack baseline;
- no Hindsight client is constructed and no external network is touched.

A separate defensive unit test calls the provider hooks directly with no `externalUrl` and asserts
`{ blocks: [] }` / no-op behavior.

---

## 10. Acceptance

- `npm run check` clean; `test:unit` + `test:e2e` green; pack builds via `build-market-packs.mjs`
  + `copy-builtin-packs.mjs`.
- Installed-but-dormant on a fresh dev install — no containers, no provider bridge injection, no
  hook-route calls, no Hindsight network until a URL is configured; disabled/unconfigured ⇒ parity
  assertions in §9.5.
- Pointing the config at a local Hindsight yields recall blocks in a real session
  (manual-integration green) and retains land in bank `bobbit`.

## 11. Non-goals (tracked elsewhere)

- Explicit agent tools `hindsight_recall/retain/reflect` — **G2.3** (shipped in **P5**; see
  [hindsight-memory.md → Agent tools](../hindsight-memory.md#agent-tools)). The **native panel +
  entrypoints** half of G2.3 shipped in **P4** — see
  [hindsight-memory.md → Native config & status panel](../hindsight-memory.md#native-config--status-panel)
  and [hindsight-panel-p4-implementation.md](hindsight-panel-p4-implementation.md).
- Managed Docker runtime + Postgres + `~/.hindsight` + deployment-mode selection — **G3** (shipped
  in **P3**; see [managed-runtimes.md](../managed-runtimes.md#p3--deployment-modes-consent--lifecycle)).
- Mental-models / reflect UI / cross-engine dedupe / cost surfacing — **G4**.
