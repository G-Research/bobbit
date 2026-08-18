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

> **Scope of this release (Extension Platform G2.1 + G2.2).** Only **external mode** ships — you
> point the pack at a Hindsight URL you already run. The managed Docker/Postgres runtime, the
> explicit `hindsight_recall/retain/reflect` agent tools, the native memory panel, the reflect UI,
> and cross-engine dedupe are **out of scope** here — see [Non-goals](#non-goals).

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

Open **Market → Installed** in the project that should use Hindsight, then expand the Hindsight
Memory provider's project settings. Save at least `externalUrl`, the base URL of your Hindsight
service (the usual Hindsight port is `8888`). The provider then activates for that project and
starts recalling and retaining. Configure every project separately; Market's project context never
falls back to another selected project.

### Configuration keys

The config surface is a generic [project extension settings](extension-settings.md) declaration
in the Hindsight provider. Defaults and non-secret overrides are project-local; `apiKey` is a
write-only project secret. The provider receives the resulting effective configuration through
`ctx.config`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `externalUrl` | string (optional) | — | Base URL of your running Hindsight. **Empty ⇒ dormant.** This is the required configuration gate. |
| `apiKey` | secret (optional) | — | Bearer token. Sent as `Authorization: Bearer <apiKey>` only when stored. Market and the API reveal only whether it is set. |
| `bank` | string | `bobbit` | The shared memory bank id (see [Bank & tag taxonomy](#bank--tag-taxonomy)). |
| `namespace` | string | `default` | Hindsight namespace path segment. |
| `recallScope` | enum `project` \| `all` | `all` | `all` recalls across the whole bank; `project` adds a `project:<id>` tag filter. |
| `autoRecall` | boolean | `true` | When false, recall hooks contribute no blocks. |
| `autoRetain` | boolean | `true` | When false, retain hooks store nothing. |
| `recallBudget` | number | `1200` | Token budget passed as `max_tokens` to recall. |
| `timeoutMs` | number | `1500` | Per-request abort budget for the REST client. |

The generic settings API validates values, provides an explicit secret removal action, and uses a
revisioned save. A project can also disable the Hindsight provider without deleting its settings;
that project then makes no provider calls while another configured project remains unaffected.

### Legacy fallback boundary

Older Hindsight installs can have a provider configuration in the pack-scoped legacy store. It is
considered only until a project gets its own Hindsight settings target. Once the project row
exists—even if an override is cleared—the legacy value cannot return, and generic settings never
write the old record. Legacy configuration never supplies a secret across projects. This makes the
migration compatible without weakening project isolation.

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

Project settings and secret writes are gateway-owned; pack routes cannot read the project's
current configuration or use it as a second configuration API. This prevents an old route client
from bypassing revision checks or project isolation. The remaining Hindsight routes are
read-only migration and queue diagnostics reached through `host.callRoute(<name>)`.

| Route | Contract |
|---|---|
| `config` | `GET` only. Returns a deprecation marker, project-settings guidance, and whether a legacy fallback is available/configured. It never returns legacy values or a secret; non-GET requests return `HINDSIGHT_PROJECT_SETTINGS_REQUIRED`. |
| `status` | Returns queue and safe error-presence diagnostics plus legacy-fallback health information. It does not read current project settings. |
| `recall`, `retain`, `reflect`, `banks` | Return `HINDSIGHT_PROJECT_SETTINGS_REQUIRED` with project-scoped Market guidance. They intentionally do not fall back to global legacy credentials. |

Use Market or the [project extension settings API](extension-settings.md#http-api) to configure
Hindsight. The provider runtime—not these pack routes—receives the effective project settings.

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

- Explicit agent tools `hindsight_recall/retain/reflect`, the native memory panel, and entry
  points — **G2.3**.
- Managed Docker runtime + Postgres + `~/.hindsight` bind-mount + deployment-mode selection
  (`mode: managed`) — **G3**.
- Mental-models / reflect UI / cross-engine dedupe / cost surfacing — **G4**.

## See also

- [Lifecycle Hub](lifecycle-hub.md) — the seam that runs the provider's hooks and fences its
  blocks.
- [Marketplace → built-in first-party packs](marketplace.md#built-in-first-party-packs) and
  [provider contributions](marketplace.md#provider-contributions-providersidyaml).
- [docs/design/hindsight-pack-external.md](design/hindsight-pack-external.md) — implementation
  blueprint (REST body mapping, host seams, full test plan, and the bank-topology rationale in §7).
