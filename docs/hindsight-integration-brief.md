# Hindsight memory v2 implementation brief

This document records the final Hindsight memory v2 implementation state. It supersedes the earlier design-only brief that was copied from `/tmp/hindsight-integration-brief.md`; the implementation has been reconciled against `market-packs/hindsight/`, current tests, and Hindsight 0.8.3 API shapes observed at `http://127.0.0.1:9177`.

Scope is pure memory mechanics. UI and surface work is documented separately.

## Executive summary

Hindsight memory v2 extends the existing built-in `hindsight` pack rather than adding a second memory path. The pack now:

- injects a per-project mental model at `sessionSetup` when available, and falls back to the previous raw session-start recall when it is absent, pending, skipped, or failed;
- keeps recall observation-biased, sends `query_timestamp` by default, and preserves the Hindsight 0.8.3 chunks-off default by not sending `include.chunks` from normal recall paths;
- forwards structured reflect options (`response_schema`, `fact_types`, budgets, `exclude_mental_models`) and surfaces `structuredOutput` through the route/tool;
- emits a replaceable goal/PR outcome digest through a `goalCompleted` lifecycle hook, with a stable `document_id`, `update_mode: "replace"`, task/gate/PR summaries, entities, metadata, and project observation scopes;
- forwards advanced retain fields (`document_id`, `update_mode`, `entities`, `timestamp`, `observation_scopes`, `metadata`) and preserves them through the retry queue;
- keeps bank-wide directive writes disabled by default for shared banks, with explicit opt-in support and a per-request reflect instruction fallback;
- health-gates and bounds retain queue drains so recovery does not burst into an unhealthy daemon;
- adds reversible invalidation through a minimal route/tool that patches memory state instead of deleting data.

## Verified Hindsight 0.8.3 API mapping

Bobbit's REST client targets `/v1/{namespace}/banks/{bank}/...`, defaulting to namespace `default`. Current implementation maps these Hindsight 0.8.3 fields:

### Recall: `POST /memories/recall`

Request fields used by Bobbit:

- `query`
- `max_tokens` from `recallBudget`
- `types` from `recallTypes`, default `['observation', 'world', 'experience']`
- `tags` and `tags_match` from the shared `recallTagFilter()` helper
- `query_timestamp` when `recallQueryTimestampEnabled` is true or the route receives an explicit timestamp
- optional `budget`, `trace`, and `include` only when a direct caller explicitly passes them to the client

Normal provider and route recall intentionally omit `include`. In Hindsight 0.8.3, `include.chunks` is disabled by default and chunks are only requested by setting `include.chunks` to `{}`. The v2 tests pin that ordinary recall bodies contain no default `include.chunks`.

### Reflect: `POST /reflect`

Bobbit forwards:

- `query`
- `tags` / `tags_match`
- `response_schema` from route/tool `responseSchema`
- `fact_types` from route/tool `factTypes`
- `budget`, `max_tokens`, `exclude_mental_models`, and `exclude_mental_model_ids` when supplied

The client returns `{ text, structuredOutput? }`, mapping Hindsight `structured_output` to camel case. The tool displays `structuredOutput` as JSON and also exposes it under `details.structuredOutput`.

### Retain: `POST /memories`

Bobbit writes item-level fields:

- `content`
- `tags`
- `document_id`
- `update_mode`
- `entities`
- `timestamp`
- `observation_scopes`
- `metadata`

Request-level `async` is `!sync`: routine and outcome retains are async; compaction safety retains are synchronous. Event time is `timestamp`, not `event_date`. Project observation scope is nested as `[["project:<projectId>"]]`, not a flat tag list.

### Mental models

Bobbit uses:

- `GET /mental-models/{id}`
- `POST /mental-models`
- `POST /mental-models/{id}/refresh`
- supporting list/update/clear/history client methods for parity and tests

Create uses a stable id `bobbit-<sanitized-projectId>`, tags `project:<id>`, `bobbit`, and `kind:mental-model`, and a trigger that prefers the configured fact types, excludes mental models, applies strict project tags, and does not request chunks. Creation is async, so a newly created model can be `empty` until Hindsight finishes the operation.

### Directives, health, operations, curation

- Directives are first-class `/directives` resources. Bobbit treats them as potentially bank-wide and keeps writes disabled unless explicitly opted in.
- Queue drain health uses `GET /health`; optional LLM gating uses `POST /health/llm`.
- Operations support is exposed through client methods for diagnostics/retry workflows.
- Reversible invalidation uses `PATCH /memories/{id}` with `{ state: "invalidated", reason }`. The agent tool does not expose destructive delete.

## Current pack behavior by feature

### 1. Per-project mental model at `sessionSetup`

`sessionSetup` first tries `doMentalModel()` when `autoRecall` and `mentalModelEnabled` are true and the session has a project id.

States:

| State | Meaning | `sessionSetup` behavior |
|---|---|---|
| `injected` | Hindsight returned non-empty model content or a usable `reflect_response.text`. | Inject one `Project memory model` context block (`authority: memory`, priority above raw recall) and make zero raw recall calls for that hook. |
| `empty` | The model is absent, newly created, or pending async generation. | Fall back to normal session-start recall. |
| `skipped` | Auto recall/model config is off, there is no project id, or the client lacks mental-model support. | Fall back to normal session-start recall. |
| `failed` | Mental-model API failed. | Record diagnostics and fall back to normal session-start recall. |

Refresh is opportunistic. If the model is stale or the `mentalModelRefreshEveryMs` cadence has elapsed, Bobbit calls `refreshMentalModel()` best-effort and does not wait for Hindsight's async operation to finish. Fresh model content is still injected even if refresh fails.

Why: one curated project-state block avoids broad session-start recall when prior work exists, while preserving cold-start behavior when the model is not ready.

### 2. Observation-biased recall, timestamp anchoring, chunks-off guard

Recall remains tag-scoped to the shared bank:

- `project` scope adds the current project tag and uses `tagsMatch` (default `any`, meaning project + global/untagged memories while excluding other projects).
- Extra tags narrow project-scope reads with strict all-tags semantics.
- `all` scope searches the configured bank without a fabricated project tag.

Recall quality and token controls:

- `recallTypes` defaults to `['observation', 'world', 'experience']`, biasing toward consolidated observations while preserving useful facts and experiences.
- `recallQueryTimestampEnabled` defaults to true and sends the current ISO `query_timestamp` from provider recall. The route accepts an explicit `queryTimestamp` override or `false`/`null` to omit it.
- Normal provider/route recall sends no `include`, so `include.chunks` stays disabled under Hindsight 0.8.3 defaults.
- `clampRecallQuery()` enforces a token-safe character ceiling before the API call; a defensive 400 "Query too long" classifier soft-skips recall and clears sticky errors.

### 3. Structured reflect

The `reflect` route and `hindsight_reflect` tool accept:

- `responseSchema` → `response_schema`
- `factTypes` → `fact_types`
- `excludeMentalModels` → `exclude_mental_models`
- `budget` and `maxTokens`

The route returns `{ configured, text, structuredOutput? }`. If Hindsight rejects a schema or returns no structured output, Bobbit falls back to the text response.

When bank directives are disabled, the route prepends Bobbit's per-request coding-agent reflection instruction. This keeps agent-facing behavior consistent without mutating a shared Hindsight bank.

### 4. `goalCompleted` outcome digests

The server dispatches a non-fatal `goalCompleted` lifecycle hook after team completion succeeds. Dispatch is collapsed in memory for concurrent completions and guarded by a persisted marker keyed like `goalCompleted:<goalId>:<headSha>` under the goal state directory. If no active provider declares `goalCompleted`, no marker is burned.

The completion context includes best-effort project and workflow details:

- goal id, project id, branch, merge target, root/parent goal ids, worktree/cwd, team lead session id, completion timestamp, and head SHA;
- cached PR number/state/url/head SHA when available;
- gate summaries (`gateId`, name, status, signal count, latest commit SHA, metadata/content);
- task summaries (`id`, title, type, state, branch, head SHA, result summary);
- touched files from task summaries and Git name-only probes.

The Hindsight provider retains one async outcome digest with:

- `document_id: "outcome:<goalId>"`
- `update_mode: "replace"`
- `tags` including `kind:outcome`, `bobbit:true`, project, goal, and PR when known
- file/component entities when known
- `timestamp` from completion time
- project `observation_scopes` as `[["project:<projectId>"]]`
- metadata such as `headSha`, branch, merge target, and PR URL

Provider failures never fail goal completion. If retain fails and a store is available, the digest is queued with all advanced fields preserved so replay writes the same replaceable document. The `hindsight_retain_outcome` route/tool remains a manual repair path and uses the same stable document id and replace semantics for goal or PR digests.

### 5. Advanced retain fields, entities, and observation scopes

The client and provider now forward advanced retain metadata. Automatic turn and compaction retains include:

- project observation scopes when a project id exists;
- file/component entities only when the hook context provides them;
- an item-level `timestamp`;
- existing auto-tags for kind/project/goal/agent/session.

The durable retry queue stores the original bank, namespace, tags, document id, update mode, entities, timestamp, observation scopes, and metadata. Replay uses the original target bank/namespace, not the next hook's effective config, so queued writes cannot drift across project overrides.

Manual `hindsight_retain` stays conservative: it writes content plus manual/project tags and does not expose the full metadata surface. Outcome metadata uses the dedicated `retain_outcome` route/tool.

### 6. Directive behavior

Directive writes are deliberately off by default:

- `directivesEnabled: false`
- `directiveApplyMode: "disabled"`

Why: the common `hermes` bank is shared, and Hindsight 0.8.3 does not prove that directive tags safely scope directive application per request. Bobbit therefore avoids installing active bank-wide coding-agent directives unless an operator explicitly opts in.

When enabled, Bobbit:

- lists existing directives;
- creates or updates only stable `bobbit-` prefixed directives;
- attaches the `bobbit` tag;
- caches a signature per namespace/bank so it does not rewrite identical directives every hook;
- treats failures as diagnostics only.

When disabled, `reflect` still gets Bobbit-specific behavior through a per-request instruction prefix. Callers can suppress that prefix with `bobbitInstruction: false` in the route body.

### 7. Health-gated bounded retain queue

Failed retain calls enter a durable FIFO queue capped at 100 entries. Queue drains are now gated and bounded:

- `retainQueueHealthGate` defaults true and requires `client.health().ok !== false` before any drain.
- `retainQueueLlmHealthGate` defaults false; when enabled, `/health/llm` must not report failed operation health.
- `retainQueueDrainMaxPerHook` defaults 1 for `afterTurn` drain.
- `retainQueueShutdownMax` defaults 10, replacing unbounded shutdown bursts.
- `retainQueueBatchPauseMs` is reserved for future paced drains; normal hooks avoid sleeps.

If health probing fails, the queue is left untouched and a non-fatal diagnostic is recorded. Direct active-turn retain attempts can still run and enqueue on failure.

### 8. Reversible invalidation

The `invalidate` route and `hindsight_invalidate` tool require a memory `id` and non-empty `reason`. They call `client.invalidateMemory(bank, id, reason)`, which sends:

```json
{ "state": "invalidated", "reason": "..." }
```

This retires stale or incorrect memories without deleting history. Revert/history workflows remain direct Hindsight API operations.

## Configuration keys and operational defaults

The source of truth is `market-packs/hindsight/providers/memory.yaml`, mirrored by `CONFIG_DEFAULTS` in `market-packs/hindsight/src/shared.ts`.

| Key | Default | Notes |
|---|---:|---|
| `recallTypes` | `['observation','world','experience']` | Observation-biased recall. |
| `recallQueryTimestampEnabled` | `true` | Send current ISO `query_timestamp` unless disabled or explicitly omitted by route body. |
| `mentalModelEnabled` | `true` | Try mental-model injection at `sessionSetup`. |
| `mentalModelMaxTokens` | `1000` | Model content budget. |
| `mentalModelRefreshEveryMs` | `86400000` | Best-effort refresh cadence; `0` disables cadence-based refresh in the provider implementation. |
| `mentalModelRecallMaxTokens` | `1200` | Trigger recall budget for model generation support. |
| `directivesEnabled` | `false` | No bank-wide directive writes by default. |
| `directiveApplyMode` | `disabled` | Explicit opt-in required for bank directive writes. |
| `directiveSetVersion` | `bobbit-v1` | Part of the idempotency signature. |
| `directives` | Bobbit coding-agent directive | Written only when directive application is enabled. |
| `retainQueueDrainMaxPerHook` | `1` | Max queued entries retried during `afterTurn`. |
| `retainQueueShutdownMax` | `10` | Max queued entries retried during `sessionShutdown`. |
| `retainQueueHealthGate` | `true` | Gate queue drains on `/health`. |
| `retainQueueLlmHealthGate` | `false` | Optional `/health/llm` gate. |
| `retainQueueBatchPauseMs` | `0` | Reserved pacing knob; no sleep by default. |

Existing defaults remain important: the pack manifest declares `defaultDisabled: true` so fresh unconfigured installs have no Hindsight contributions until Marketplace setup enables/configures them; external mode still requires `externalUrl` once enabled. Existing configured installs preserve activation. `retainEveryNTurns` remains 5, `retainMaxDelayMs` remains 30 minutes, `retainOverlapTurns` remains 2, `recallBudget` remains 1200, and `timeoutMs` remains 1500 ms.

Per-project overrides are still limited to memory-quality keys (`recallScope`, `bank`, `tagsMatch`, `recallBudget`, `recallTypes`). Deployment mode, URLs, and secrets remain server-global.

## Before/after token and call cost model

Baseline before v2:

- `sessionSetup` could make one broad recall and inject up to `recallBudget` tokens, default 1200.
- `beforePrompt` made targeted recall with the same budget.
- Recall was already observation-biased and chunk-free by default.
- Routine retain was already batched: one extraction per `retainEveryNTurns` turns, default 5.
- Shutdown queue drain could attempt every queued item.

After v2:

- When a mental model is available, `sessionSetup` does one model get and injects a curated `Project memory model` block capped by `mentalModelMaxTokens` (default 1000), and does zero raw recall calls for that hook.
- When the model is missing, pending, skipped, or failed, `sessionSetup` falls back to the old raw recall path.
- Per-turn `beforePrompt` recall remains targeted, observation-biased, timestamp-anchored, and chunk-free.
- Routine retain frequency remains one call per 5 turns at defaults.
- Goal completion adds one async replace retain per completed goal/head. Re-emits replace the existing digest rather than adding duplicates.
- Queue recovery is bounded by `retainQueueDrainMaxPerHook`/`retainQueueShutdownMax` and gated on health.
- Structured reflect can return a compact JSON object, reducing prose parsing and follow-up turns for schema-driven memory queries.

Expected direct prompt-token win: session-start memory drops from up to 1200 raw recall tokens to a curated ~1000-token mental model when available, roughly 15-25% if the model stays near 900-1000 tokens. The larger expected win is fewer rediscovery turns because completed outcomes and project state are retained in stable, recallable forms.

## Validation commands

Use these after changing Hindsight memory mechanics:

```bash
npm run check
npx tsx --import ./tests/helpers/css-stub-loader.mjs --test --test-force-exit tests/hindsight-client.test.ts tests/hindsight-provider.test.ts tests/hindsight-tool-execute.test.ts tests/lifecycle-hub.test.ts tests/team-manager.test.ts
npm run test:e2e:run -- tests/e2e/hindsight-agent-tools.spec.ts tests/e2e/hindsight-external.spec.ts
```

If the test runner does not support filtering in your shell, run the full phases instead:

```bash
npm run test:unit
npm run test:e2e
```

Manual real-daemon validation remains optional and should use the manual integration target only when a local Hindsight is intentionally running:

```bash
HINDSIGHT_URL=http://localhost:9177 HINDSIGHT_BANK=bobbit-it npm run test:manual -- --grep hindsight
```

Audit points to confirm in test output or stub captured calls:

- model-injected `sessionSetup` has zero raw recall calls;
- recall bodies include `types` and `query_timestamp`, and omit `include.chunks` by default;
- structured reflect returns `structuredOutput` when `responseSchema` is supplied;
- outcome retains use `document_id: outcome:<goalId>`, `update_mode: replace`, project outcome tags, entities, metadata, and nested observation scopes;
- health-gated drains skip when `/health` is unhealthy and drain no more than configured limits;
- invalidated memories are excluded from later recall by the stub.

## Operator recommendations

Do not change operator-owned daemon configuration from Bobbit. Recommend only:

- keep the local reranker enabled when available;
- consider `HINDSIGHT_API_SEMANTIC_MIN_SIMILARITY=0.2-0.3` to reduce weak semantic matches;
- consider recall strategy boosts for entity/graph and recency signals;
- keep dashboard/server chunk availability if useful for humans, but rely on Bobbit's per-request behavior to keep agent recall chunk-free;
- apply launchd or daemon environment changes only in the operator's Hindsight service configuration, never from the pack.
