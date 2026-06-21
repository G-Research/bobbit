# Hindsight memory v2 integration brief and design

Source brief copied from `/tmp/hindsight-integration-brief.md` on 2026-06-20, then reconciled against:

- Current pack: `market-packs/hindsight/` (`src/hindsight-client.ts`, `src/provider.ts`, `src/routes.ts`, `src/shared.ts`, `providers/memory.yaml`, `tools/hindsight/*`).
- Current tests: `tests/hindsight-*.test.ts`, `tests/e2e/hindsight-*.spec.ts`, and `tests/e2e/hindsight-stub.mjs`.
- Live Hindsight data plane: `http://127.0.0.1:9177/openapi.json`, version `0.8.3`, plus non-mutating probes against bank `hermes`.

This document is the implementation design for the Hindsight memory v2 work. It intentionally names files, functions, and test additions, but does not implement code.

## Executive summary

The brief is directionally right, but several high-leverage pieces are already present in Bobbit and a few API details need correction:

- Already shipped in the pack: lifecycle hooks, REST client, route-owned tools, dormancy/config gating, retry queue, shared-bank tag scoping, per-project config overlays, retain batching (`retainEveryNTurns` default 5), mission PATCHing, observation-biased recall `types`, and recall query clamping/400 soft-skip.
- `include.chunks` is **default-disabled** in Hindsight 0.8.3. Bobbit currently sends no `include`, and the live schema says chunks are only returned when `include.chunks` is `{}`. The token win is therefore not "turn chunks off"; it is a regression guard plus stronger use of `types`/`fact_types` to prefer consolidated observations.
- Live OpenAPI paths use `/v1/default/banks/{bank_id}/...`. Bobbit's client already supports a configurable namespace by formatting `/v1/${namespace}/banks/${bank}`; that remains compatible with the operator's `default` namespace.
- Retain event time is named `timestamp`, not `event_date`.
- `observation_scopes` is not a flat `['project:<repo>']` array. The live schema accepts either a mode string (`per_tag`, `combined`, `all_combinations`, `shared`) or an array of tag-set arrays. For a project scope, Bobbit should send `observation_scopes: [['project:<projectId>']]`.
- Directives are first-class endpoints (`GET/POST /directives`, `GET/PATCH/DELETE /directives/{id}`), not bank-config fields. Because `hermes` is shared and the live schema does not prove request-tag-scoped directive application, Bobbit must not enable bank-wide coding-agent directives by default; use Bobbit-prefixed/tagged directives only behind an explicit opt-in or keep the behavior per-request.
- Mental-model creation is asynchronous: `POST /mental-models` returns `{ mental_model_id?, operation_id }`; content is read later from `GET /mental-models/{id}`. Create-or-get must be idempotent across parallel sessions: `GET -> POST -> on 409/duplicate GET` and pending async operation is `empty`, not `failed`.

The recommended implementation order is: client/API surface expansion, mental-model sessionSetup path, retain metadata/outcome digest, structured reflect, curation + health-gated drain, then docs/tests/build outputs.

## Live API verification notes

### Non-mutating probes performed

- `GET /openapi.json`: `openapi: 3.1.0`, `info.version: 0.8.3`.
- `GET /v1/default/banks/hermes/config`: confirmed retain mode `concise`, observations enabled, `recall_max_tokens=4096`, `recall_include_chunks=true`, `max_observations_per_scope=-1`, fixed recall budgets low/mid/high = 100/300/1000, and mission overrides present.
- `GET /v1/default/banks/hermes/mental-models`: `items: []` at probe time.
- `GET /v1/default/banks/hermes/observations/scopes?limit=3`: returned populated scope records like `{ tags: [...], count }`.
- `GET /v1/default/banks/hermes/operations?limit=3&offset=0`: returned `total`, `limit`, `offset`, and operation rows with `id`, `task_type`, `items_count`, `document_id`, `created_at`, `updated_at`, `status`, `error_message`, `retry_count`, `next_retry_at`, `progress`.
- `GET /v1/default/banks/hermes/directives`: `items: []` at probe time.
- `POST /v1/default/banks/hermes/memories/recall` with a no-result tag filter: response had only `results` when no `include` was sent, confirming no chunks field is returned by default for that call.

No real memories or mental models were written during verification.

### Verified request/response shapes Bobbit should use

#### Recall: `POST /v1/default/banks/{bank_id}/memories/recall`

Request schema `RecallRequest`:

```json
{
  "query": "string",
  "types": ["world", "experience", "observation"],
  "budget": "low|mid|high",
  "max_tokens": 4096,
  "trace": false,
  "query_timestamp": "ISO datetime string",
  "include": {
    "entities": { "max_tokens": 500 },
    "chunks": null,
    "source_facts": null
  },
  "tags": ["project:<id>", "bobbit"],
  "tags_match": "any|all|any_strict|all_strict|exact",
  "tag_groups": []
}
```

Important defaults/corrections:

- `types` default is world + experience; Bobbit already overrides to `['observation', 'world', 'experience']` through `CONFIG_DEFAULTS.recallTypes`.
- `include` default is `{}` but `IncludeOptions.chunks.default` is `null`; schema description: "Include raw chunks. Set to `{}` to enable, `null` to disable (default: disabled)."
- `include.entities` defaults to enabled; Bobbit's client currently ignores response-level `entities`, which is fine for agent blocks.
- `tags_match:any` includes untagged/global memories. This matches Bobbit's current `PROJECT_RECALL_TAGS_MATCH` design.

Response schema `RecallResponse`:

```json
{
  "results": [
    {
      "id": "string",
      "text": "string",
      "type": "world|experience|observation|null",
      "entities": ["string"],
      "context": "string|null",
      "occurred_start": "string|null",
      "occurred_end": "string|null",
      "mentioned_at": "string|null",
      "document_id": "string|null",
      "metadata": { "key": "value" },
      "chunk_id": "string|null",
      "tags": ["string"],
      "source_fact_ids": ["string"]
    }
  ],
  "trace": null,
  "entities": null,
  "chunks": null,
  "source_facts": null
}
```

Bobbit currently maps `results[].text/id/score` to `RecallMemory`. `score` is not in the live schema dump but is tolerated by the stub/current client.

#### Reflect: `POST /v1/default/banks/{bank_id}/reflect`

Request schema `ReflectRequest`:

```json
{
  "query": "string",
  "budget": "low|mid|high",
  "context": "deprecated string|null",
  "max_tokens": 4096,
  "include": {
    "facts": null,
    "tool_calls": null
  },
  "response_schema": { "type": "object", "properties": {} },
  "tags": ["project:<id>"],
  "tags_match": "any|all|any_strict|all_strict|exact",
  "tag_groups": [],
  "fact_types": ["world", "experience", "observation"],
  "exclude_mental_models": false,
  "exclude_mental_model_ids": ["id"]
}
```

Response schema `ReflectResponse`:

```json
{
  "text": "markdown string",
  "based_on": null,
  "structured_output": null,
  "usage": null,
  "trace": null
}
```

Structured reflect is verified by schema: when `response_schema` is provided, `structured_output` is populated according to that schema.

#### Retain: `POST /v1/default/banks/{bank_id}/memories`

Request schema `RetainRequest`:

```json
{
  "items": [
    {
      "content": "string",
      "timestamp": "ISO datetime string",
      "context": "string|null",
      "metadata": { "key": "value" },
      "document_id": "string|null",
      "entities": [{ "text": "string", "type": "string|null" }],
      "tags": ["project:<id>", "goal:<id>", "bobbit", "kind:outcome"],
      "observation_scopes": [["project:<id>"]],
      "strategy": "string|null",
      "update_mode": "replace|append|null"
    }
  ],
  "async": true,
  "document_tags": null
}
```

Corrections:

- Use `timestamp` for event time. Do not introduce an `event_date` field.
- For project-scoped consolidation, send `observation_scopes: [['project:<projectId>']]` or a documented mode string. Do not send a flat `['project:<projectId>']` array.
- Use item-level `tags`; `document_tags` is deprecated.
- `async` defaults to false upstream; Bobbit already sends `async: !sync`.

Response schema `RetainResponse`:

```json
{
  "success": true,
  "bank_id": "hermes",
  "items_count": 1,
  "async": true,
  "operation_id": "string|null",
  "operation_ids": ["string"],
  "usage": null
}
```

#### Mental models

Paths:

- `GET /v1/default/banks/{bank_id}/mental-models`
- `POST /v1/default/banks/{bank_id}/mental-models`
- `GET/PATCH/DELETE /v1/default/banks/{bank_id}/mental-models/{mental_model_id}`
- `POST /v1/default/banks/{bank_id}/mental-models/{mental_model_id}/refresh`
- `POST /v1/default/banks/{bank_id}/mental-models/{mental_model_id}/clear`
- `GET /v1/default/banks/{bank_id}/mental-models/{mental_model_id}/history`

Create request `CreateMentalModelRequest`:

```json
{
  "id": "bobbit-<projectId>",
  "name": "Bobbit project state: <projectId>",
  "source_query": "Current project state, key decisions, open threads, and recent outcomes for project <projectId>.",
  "tags": ["project:<projectId>", "bobbit", "kind:mental-model"],
  "max_tokens": 1200,
  "trigger": {
    "mode": "full|delta",
    "refresh_after_consolidation": false,
    "fact_types": ["observation", "world", "experience"],
    "exclude_mental_models": true,
    "exclude_mental_model_ids": [],
    "tags_match": "all_strict",
    "tag_groups": null,
    "include_chunks": false,
    "recall_max_tokens": 1200,
    "recall_chunks_max_tokens": null
  }
}
```

Create response `CreateMentalModelResponse`:

```json
{
  "mental_model_id": "bobbit-<projectId>|null",
  "operation_id": "string"
}
```

Read response `MentalModelResponse`:

```json
{
  "id": "string",
  "bank_id": "string",
  "name": "string",
  "source_query": "string|null",
  "content": "markdown|null",
  "tags": ["string"],
  "max_tokens": 1200,
  "trigger": { },
  "last_refreshed_at": "string|null",
  "created_at": "string|null",
  "reflect_response": { },
  "is_stale": true
}
```

Design consequence: `ensureMentalModel` must treat creation as asynchronous and may not assume content exists immediately after `POST`. The sessionSetup injection path should `GET`, create/refresh if absent/stale/cadence due, and only inject when `content` is non-empty.

#### Bank config and directives

Bank config:

- `GET/PATCH/DELETE /v1/default/banks/{bank_id}/config`.
- `PATCH` body is `{ "updates": { ... } }`.
- Live config confirms current Bobbit missions are already applied as bank overrides.

Directives:

- `GET/POST /v1/default/banks/{bank_id}/directives`
- `GET/PATCH/DELETE /v1/default/banks/{bank_id}/directives/{directive_id}`

Create directive request:

```json
{
  "name": "bobbit-coding-agent-recall",
  "content": "Prefer recent durable engineering decisions; cite source facts when available; answer for a coding agent.",
  "priority": 50,
  "is_active": true,
  "tags": ["bobbit"]
}
```

Directive response includes `id`, `bank_id`, `name`, `content`, `priority`, `is_active`, `tags`, `created_at`, and `updated_at`.

#### Health and operations

- `GET /health` is the lightweight reachability probe Bobbit already wraps in `client.health()`.
- `POST /v1/default/banks/{bank_id}/health/llm` returns `{ bank_id, operations }`, where operations are `retain`, `consolidation`, and `reflect` with `ok`, `status`, and `latency_ms`.
- `GET /v1/default/banks/{bank_id}/operations` returns `OperationsListResponse` with `operations[]` rows.
- `GET /operations/{operation_id}`, `POST /operations/{operation_id}/retry`, and `DELETE /operations/{operation_id}` are available for operation management.

#### Reversible curation

`PATCH /v1/default/banks/{bank_id}/memories/{memory_id}` accepts:

```json
{
  "text": "string|null",
  "context": "string|null",
  "occurred_start": "ISO|null",
  "occurred_end": "ISO|null",
  "fact_type": "world|experience|null",
  "entities": ["string"],
  "state": "invalidated",
  "reason": "why this memory is stale/incorrect"
}
```

`GET /memories/{memory_id}/history` returns the curation history. `DELETE /memories/{memory_id}/observations` clears derived observations.

## Current Bobbit pack behavior

### Client (`market-packs/hindsight/src/hindsight-client.ts`)

Current methods:

- `health()` → `GET /health`, swallows all failures into `{ ok:false }`.
- `ensureBank(bank)` → `PUT /v1/{namespace}/banks/{bank}`.
- `recall(bank, query, opts)` → `POST /memories/recall` with `query`, optional `max_tokens`, optional flattened `tags`, `tags_match`, and optional `types`.
- `retain(bank, content, opts)` → `POST /memories` with `items:[{ content, tags }]`, `async: !opts.sync`.
- `reflect(bank, prompt, opts)` → `POST /reflect` with `query`, optional flattened `tags`, `tags_match`; returns `{ text }`.
- `listBanks()` and `updateBankConfig()`.

Already correct/pinned:

- Timeout/error semantics are pinned by `tests/hindsight-client.test.ts`.
- Auth header is only sent when `apiKey` is configured.
- `types` forwarding is already tested.
- Client does not currently expose mental models, directives, `query_timestamp`, `budget`, retain `document_id`/`update_mode`/`entities`/`timestamp`/`observation_scopes`, structured reflect, curation, `health/llm`, operations, or observation scopes.

### Shared config/helpers (`market-packs/hindsight/src/shared.ts`)

Already present:

- `RecallType` and `RECALL_TYPES = ['observation', 'world', 'experience']`.
- `CONFIG_DEFAULTS.recallScope = 'project'`, `tagsMatch = 'any'`, `retainEveryNTurns = 5`, `retainMaxDelayMs = 1800000`, `retainOverlapTurns = 2`, `recallBudget = 1200`, `recallTypes = RECALL_TYPES`.
- `recallTagFilter()` is the single source of truth for project/global tag semantics.
- `clampRecallQuery()` avoids Hindsight's 500-token recall-query 400.
- `applyBankMission()` idempotently PATCHes bank missions and caches a signature.
- Durable per-session pending retain buffer and FIFO retry queue.
- Per-project overlays are limited to memory-quality keys.

Gaps:

- No mental-model config or store keys.
- No directive config/idempotency store keys.
- No health-gated queue drain settings.
- No retain metadata types in `HindsightClientLike`/`QueueEntry`.
- No query timestamp toggle.
- No outcome-digest helper types.

### Provider (`market-packs/hindsight/src/provider.ts`)

Already present:

- Hooks: `sessionSetup`, `beforePrompt`, `afterTurn`, `beforeCompact`, `sessionShutdown`.
- Dormancy gate via `isActive`.
- `sessionSetup` and `beforePrompt` both call `doRecall()` and inject a `Relevant memory` block if memories are returned.
- `afterTurn` batches turn summaries and flushes every N turns or max delay.
- `beforeCompact` synchronously flushes pending turns and compaction span.
- `sessionShutdown` flushes pending turns and drains the whole retry queue best-effort.
- Retains auto-tags `kind`, `project`, `goal`, `agent`, `session`.

Gaps:

- No mental-model injection path at `sessionSetup`.
- No cadence-bounded mental model refresh.
- Retain does not send entities, document IDs, update modes, timestamps, or observation scopes.
- Queue drains do not health-gate or batch-limit beyond head/all distinction.
- No outcome digest trigger.

### Routes/tools (`market-packs/hindsight/src/routes.ts`, `tools/hindsight/*`)

Already present:

- Routes: `config`, `status`, `recall`, `retain`, `reflect`, `banks`.
- Agent tools: `hindsight_recall`, `hindsight_retain`, `hindsight_reflect` route through surface-token protected pack routes.
- `recall` and `reflect` route scoping use `recallTagFilter`; optional `tags` narrow project-scope queries using `all_strict`.
- Manual retain enforces `kind:manual`.

Gaps:

- `reflect` does not accept `responseSchema`, `factTypes`, `excludeMentalModels`, or return `structured_output`.
- `retain` does not accept advanced metadata.
- No `hindsight_retain_outcome` or `hindsight_invalidate` tool.
- No route for directives/mental-model status. UI surfaces are a non-goal; route coverage can stay minimal unless needed for tools/tests.

### Stub/tests

The shared stub currently supports health, bank list, ensure bank, config PATCH, recall, retain, and reflect. It does not support mental models, directives, operations, `health/llm`, observation scopes, curation, structured reflect, or retain replacement by `document_id`.

Current tests already pin:

- Dormancy/unconfigured behavior.
- Client paths, auth, timeout, errors, mission PATCH, `types` forwarding.
- Project/global tag semantics and optional tag narrowing.
- Query clamping and 400 soft-skip.
- Retain batching and queue replay into original bank/namespace.
- Managed runtime status gating.
- Agent tools route through pack routes.
- Config route round trips for current memory-quality settings.

## Implementation design by feature

### 1. Per-project mental model injected at `sessionSetup`

Goal: inject one living project-state document at session start, ahead of raw recall, with no turn blocking when absent/unhealthy.

Files/functions:

- `market-packs/hindsight/src/hindsight-client.ts`
  - Add types `MentalModelTrigger`, `MentalModel`, `CreateMentalModelOptions`.
  - Add methods:
    - `getMentalModel(bank, id): Promise<MentalModel | null>`; map 404 to `null`, other non-2xx to `HindsightError`.
    - `listMentalModels(bank): Promise<{ items: MentalModel[] }>`.
    - `createMentalModel(bank, opts): Promise<{ mentalModelId?: string; operationId: string }>`.
    - `updateMentalModel(bank, id, patch): Promise<MentalModel>`.
    - `refreshMentalModel(bank, id): Promise<{ operationId?: string }>`.
  - Use exact live paths under `/mental-models`.
- `market-packs/hindsight/src/shared.ts`
  - Add config defaults/schema parsing:
    - `mentalModelEnabled: true`.
    - `mentalModelMaxTokens: 1000` or `1200` (must fit provider budget).
    - `mentalModelRefreshEveryMs: 86_400_000` default.
    - `mentalModelRecallMaxTokens: 1200`.
  - Add store keys:
    - `MENTAL_MODEL_REFRESH_PREFIX = 'mental-model-refresh:'` storing `{ lastAttemptAt, lastSuccessAt, operationId? }` per namespace/bank/project.
  - Add helpers:
    - `mentalModelId(projectId): string` sanitize to lowercase kebab and prefix `bobbit-`.
    - `mentalModelTags(projectId): string[]` = `['project:<id>', 'bobbit', 'kind:mental-model']`.
    - `shouldRefreshMentalModel(store, cfg, projectId, now)`.
- `market-packs/hindsight/src/provider.ts`
  - Add `doMentalModel(ctx, cfg)` called only from `sessionSetup`, before `doRecall`.
  - Make the control contract explicit: `doMentalModel` returns `{ state: 'injected' | 'empty' | 'skipped' | 'failed'; blocks: ContextBlock[] }`.
  - Flow:
    1. Require `cfg.mentalModelEnabled`, active data plane, and real `projectId`; otherwise return `skipped`.
    2. `GET /mental-models/{id}`.
    3. If 404/null, `POST /mental-models` with stable id. If create succeeds with only an async `operation_id`, return `empty`. If create returns 409/duplicate/in-flight, immediately `GET` again and return `injected` if content now exists, otherwise `empty`.
    4. If content exists, return `injected` with one block:
       - `id: 'memory:mental-model:<projectId>'`
       - `title: 'Project memory model'`
       - `authority: 'memory'`
       - `priority: 60` (above current raw recall priority 50)
       - `reason: 'Hindsight mental model for project <id>'`
    5. If cadence due or `model.is_stale`, call `refreshMentalModel` best-effort and update refresh store. Do not await operation completion.
    6. On real endpoint failure, return `failed` and record diagnostics without throwing.
  - `sessionSetup` must branch on the return state: when `state === 'injected'`, return only the mental-model block and make **zero** raw `doRecall` calls; when `empty`, `skipped`, or `failed`, call the existing raw sessionSetup recall fallback. `beforePrompt` keeps targeted recall.
- `market-packs/hindsight/providers/memory.yaml`
  - Add config keys mirroring `CONFIG_DEFAULTS`.
- Build output: rebuild `market-packs/hindsight/lib/provider.mjs`, `lib/routes.mjs`, `lib/hindsight-client.mjs` in the implementation branch.

Fallback:

- Missing endpoint/404/empty content/unhealthy → no error to agent; current sessionSetup raw recall remains.
- Creation/refresh failures are diagnostics-only via existing `recordError`, but should not create sticky noise for expected 404/create races if content is simply absent.

Tests to add/extend:

- `tests/e2e/hindsight-stub.mjs`: support mental model CRUD/refresh and async operation IDs.
- `tests/hindsight-client.test.ts`: mental-model methods hit exact paths and parse create/read responses.
- `tests/hindsight-provider.test.ts`:
  - `sessionSetup` injects mental model block above raw recall and, when `state === 'injected'`, asserts the stub/client saw **zero** `/memories/recall` calls for sessionSetup.
  - Absent model triggers create and falls back to raw recall.
  - Parallel sessionSetup create race: two stable-id create attempts produce at most one model, 409/duplicate is treated as `empty`/follow-up `GET`, not noisy failure.
  - Refresh is cadence bounded and updates store key.
  - Endpoint failure never blocks the hook.
- `tests/e2e/hindsight-external.spec.ts`: configured provider with seeded stub mental model injects `Project memory model`.

### 2. Goal/PR outcome digests

Goal: retain one concise, replaceable outcome digest per goal/PR so completed work is discoverable without replaying turns.

Preferred implementation: add an owned completion lifecycle signal plus keep a manual route/tool fallback. The runtime-owned signal is required for the product guarantee that every completed goal/PR emits one replaceable digest.

Files/functions:

- `market-packs/hindsight/src/hindsight-client.ts`
  - Extend `RetainOptions`:
    - `documentId?: string`
    - `updateMode?: 'replace' | 'append'`
    - `entities?: Array<{ text: string; type?: string }>`
    - `timestamp?: string`
    - `observationScopes?: string | string[][]`
    - `metadata?: Record<string, string>`
  - Map to item fields `document_id`, `update_mode`, `entities`, `timestamp`, `observation_scopes`, `metadata`.
- `market-packs/hindsight/src/shared.ts`
  - Add helper `projectObservationScopes(projectId): string[][]` → `[[`project:${projectId}`]]`.
  - Add helper `outcomeTags(ctx, extra)` with `kind:outcome`, `project`, `goal`, `pr`, `bobbit`.
  - Add `buildOutcomeDigest(ctx)` that accepts an explicit completion payload and produces concise content, stable document id, tags, entities, timestamp, and observation scopes.
- `src/server/agent/lifecycle-hub.ts`, `src/server/agent/pack-contributions.ts`, and the team-completion path in `src/server/server.ts` / `src/server/agent/team-manager.ts`
  - Add a minimal provider hook `goalCompleted` dispatched once after all gates pass and the goal is being marked complete (for child goals, after `ready-to-merge` passes and before/archive-complete reconciliation is finalized; for root goals, after PR/ready-to-merge checks pass and before `team_complete` returns success).
  - Idempotency boundary: persist a stable completion event marker keyed `goalCompleted:<goalId>:<headSha>` (or equivalent goal-store metadata) before/with dispatch. Repeated or concurrent `team_complete` calls for the same goal/head reuse the same event id and do not dispatch a second provider call; provider failures do not clear the completion marker, but enqueue the outcome digest under stable `document_id:'outcome:<goalId>'` for retry/repair. If HEAD changes before completion, a new marker/head may emit a replacement digest.
  - Hook context should include `goalId`, `projectId`, `branch`, `mergeTarget`, PR number if known, passed gate summaries, and best-effort touched files from `git diff --name-only <base>...HEAD` when available. If files/PR cannot be determined, omit those fields rather than blocking completion.
  - Dispatch is best-effort and must never fail `team_complete`; Hindsight failures enqueue or log diagnostics.
- `market-packs/hindsight/src/provider.ts`
  - Implement `goalCompleted(ctx)` by calling the shared outcome builder and `client.retain(..., { documentId:'outcome:<goalId>', updateMode:'replace', entities, timestamp, observationScopes, sync:false })`.
- `market-packs/hindsight/src/routes.ts`
  - Add route `retain_outcome` or extend `retain` with a constrained `kind: 'outcome'` path. Prefer a dedicated route for validation.
  - Body: `{ content, goalId?, pr?, files?, components?, decisions?, tags?, timestamp? }`.
  - Build `document_id: outcome:<goalId>` or `outcome:pr:<pr>`.
  - Send `update_mode: 'replace'`, `async: true`, project observation scopes, entities from files/components.
- `market-packs/hindsight/tools/hindsight/extension.ts`
  - Register `hindsight_retain_outcome` as the explicit fallback tool.
- `market-packs/hindsight/tools/hindsight/hindsight_retain_outcome.yaml`
  - New tool descriptor.
- `market-packs/hindsight/pack.yaml`
  - Ensure the `hindsight` tool group includes the new tool descriptor.

Fallback:

- `hindsight_retain_outcome` remains available for manual repair/re-emission and for older runtimes without `goalCompleted`, but it is not the primary completion path.
- If Hindsight is unhealthy, the provider hook/route returns a nonfatal result and should enqueue the digest using the same durable queue semantics as auto-retain when store access is available.

Tests:

- Stub retain must store full item fields and implement `document_id` + `update_mode:'replace'` replacement semantics.
- `tests/hindsight-client.test.ts`: retain forwards document ID, update mode, timestamp, entities, observation scopes.
- `tests/hindsight-provider.test.ts`: `goalCompleted` emits one async retain with stable `document_id`, `kind:outcome`, project/goal/PR tags, entities, timestamp, and observation scopes; a second dispatch replaces the same document id in the stub.
- `tests/lifecycle-hub.test.ts` or a focused server/team-manager test: `team_complete`/child completion dispatches `goalCompleted` once and does not fail completion when the provider errors; repeated/concurrent completion attempts for the same goal/head do not dispatch twice; retry/repair uses stable document id.
- `tests/hindsight-tool-execute.test.ts`: outcome helper builds stable id/tags/entities.
- `tests/e2e/hindsight-agent-tools.spec.ts`: `hindsight_retain_outcome` routes to retain with `kind:outcome`, `document_id`, replacement semantics.

### 3. Observation-biased recall + chunks-off guard

Goal: keep agent recall on consolidated observations and prevent accidental raw chunk payloads.

Current state:

- `CONFIG_DEFAULTS.recallTypes` already defaults to `['observation', 'world', 'experience']`.
- Provider and route both pass `types: cfg.recallTypes`.
- Client sends no `include`, and chunks are default-disabled in 0.8.3.

Work:

- Keep current `recallTypes` config and tests.
- Add an explicit regression test that recall request bodies do **not** include `include.chunks` unless a future explicit source-fetch feature requests it.
- Optionally add `include?: { chunks?: null | { max_tokens?: number }; entities?: null | { max_tokens?: number }; source_facts?: null | { ... } }` to `RecallOptions`, but default call sites should omit `include` entirely.
- For reflect, add `factTypes` support and default schema/config to use observations first where appropriate.

Files:

- `market-packs/hindsight/src/hindsight-client.ts`: optional `include`, `budget`, `queryTimestamp` fields on `RecallOptions`; do not send `include` by default.
- `market-packs/hindsight/src/provider.ts` and `routes.ts`: preserve current `types` forwarding.

Tests:

- `tests/hindsight-client.test.ts`: no `include` field by default; if `include` is added explicitly, it maps exactly.
- `tests/hindsight-provider.test.ts`: provider/route recall bodies have `types` and no `include.chunks`.
- `tests/e2e/hindsight-external.spec.ts`: captured stub recall calls have no `include?.chunks`.

### 4. Structured reflect (`response_schema`)

Goal: allow `hindsight_reflect` to return compact structured JSON without prose parsing.

Files/functions:

- `market-packs/hindsight/src/hindsight-client.ts`
  - Extend `ReflectOptions`:
    - `responseSchema?: Record<string, unknown>`
    - `factTypes?: RecallType[]`
    - `budget?: 'low' | 'mid' | 'high'`
    - `maxTokens?: number`
    - `excludeMentalModels?: boolean`
  - Return `{ text: string; structuredOutput?: unknown }` from `reflect`.
  - Map `response_schema`, `fact_types`, `budget`, `max_tokens`, `exclude_mental_models`.
- `market-packs/hindsight/src/routes.ts`
  - `reflect` route accepts `responseSchema`, `factTypes`, `excludeMentalModels` from body.
  - Return `{ configured, text, structuredOutput }`.
- `market-packs/hindsight/tools/hindsight/extension.ts`
  - Add optional `responseSchema` parameter to `hindsight_reflect`.
  - Tool output: if `structuredOutput` exists, display a fenced JSON block or compact JSON text and include it in `details.structuredOutput`.
- `market-packs/hindsight/tools/hindsight/hindsight_reflect.yaml`
  - Document `responseSchema`.

Fallback:

- If endpoint rejects schema or returns no `structured_output`, return current text behavior.

Tests:

- Stub reflect returns `structured_output` when request has `response_schema`.
- Client test verifies request/response mapping.
- Route/tool tests verify parameter passes through and tool surfaces structured output.

### 5. `observation_scopes` per project on retain

Goal: make Hindsight's observation consolidation produce project-scoped observations.

Files/functions:

- `market-packs/hindsight/src/shared.ts`
  - `observationScopesForProject(projectId?: string): string[][] | undefined`.
  - Return `[[`project:${projectId}`]]` only for a real project id.
- `market-packs/hindsight/src/provider.ts`
  - Auto-retain paths (`retainWithQueue`, `flushPending`, queue replay) pass `observationScopes` when project id exists.
  - Queue entries must store `observationScopes` so replay is faithful to original context.
- `market-packs/hindsight/src/routes.ts`
  - Manual retain remains conservative; outcome digest should always pass project observation scope.

Fallback:

- If no project id, omit `observation_scopes` and let bank defaults apply.
- If live API rejects scopes, catch like other retain failures and enqueue with diagnostics.

Tests:

- Client retain mapping test.
- Provider auto-retain test: retained item carries `observation_scopes: [["project:p1"]]`.
- Queue replay test: scope survives queue serialization/replay.
- Stub `retained()` helper should expose full retained item fields.

### 6. `entities` on retain

Goal: associate file/component entities with retained outcomes and any hook context that supplies touched files.

Files/functions:

- `market-packs/hindsight/src/shared.ts`
  - Add `EntityInput` type `{ text: string; type?: string }`.
  - Add `entitiesFromContext(ctx)` reading future-safe optional fields like `ctx.files`, `ctx.touchedFiles`, `ctx.components` defensively. Do not invent host fields; only use them if present.
  - Add `entitiesFromOutcomeBody(body)` for the new outcome route/tool.
- `market-packs/hindsight/src/provider.ts`
  - Pass entities on auto-retain only when hook context provides them.
- `market-packs/hindsight/src/routes.ts`
  - Outcome digest maps files to `{ text:file, type:'file' }`, components to `{ text:component, type:'component' }`.

Fallback:

- Omit `entities` when none are known.

Tests:

- Client retain forwards entities.
- Outcome route/tool converts files/components to entities.
- Provider test with synthetic context fields confirms entities pass through without requiring those fields in production.

### 7. `query_timestamp` anchoring

Goal: anchor relative-time recalls to the session/turn time for "recently" queries.

Files/functions:

- `market-packs/hindsight/src/shared.ts`
  - Config keys:
    - `recallQueryTimestampEnabled: true`.
    - Optional `queryTimestampMode: 'now'` can be deferred; initial implementation just sends current ISO time when enabled.
- `market-packs/hindsight/src/hindsight-client.ts`
  - Add `queryTimestamp?: string` to `RecallOptions`; map to `query_timestamp`.
- `market-packs/hindsight/src/provider.ts`
  - In `doRecall`, pass `queryTimestamp: new Date().toISOString()` when config enabled.
- `market-packs/hindsight/src/routes.ts`
  - Route accepts optional `queryTimestamp` body override for agent tools/API; default to enabled now if omitted.

Fallback:

- If disabled or invalid timestamp, omit field.

Tests:

- Client maps field to `query_timestamp`.
- Provider/route tests assert field exists when enabled and is omitted when disabled.

### 8. Directives (answer/recall behavior)

Goal: apply Bobbit-specific reflect/recall behavior without contaminating the shared `hermes` bank: prefer recent durable facts, cite source facts when included, answer for a coding agent, avoid transient turn noise.

Verified API:

- Use `/directives`, not bank config.
- Create request requires `name` and `content`; supports `priority`, `is_active`, and `tags`.
- The live OpenAPI does **not** show a per-request directive selector or prove that directive `tags` restrict application to matching tagged recall/reflect calls. Treat directives as potentially bank-wide unless a live behavior probe proves otherwise.

Files/functions:

- `market-packs/hindsight/src/hindsight-client.ts`
  - Add `listDirectives`, `createDirective`, `updateDirective`, maybe `deleteDirective` only if needed.
- `market-packs/hindsight/src/shared.ts`
  - Config keys:
    - `directivesEnabled: false` by default for the shared `hermes` bank.
    - `directiveApplyMode: 'disabled' | 'bank-wide-explicit-opt-in' | 'scoped-if-supported'`, default `'disabled'`.
    - `directiveSetVersion: 'bobbit-v1'`.
    - `directives: [{ name:'bobbit-coding-agent-recall', content, priority, tags:['bobbit'] }]` default list.
  - Store signature key `DIRECTIVES_APPLIED_PREFIX` per namespace/bank.
  - `applyDirectives(store, client, cfg)` that no-ops unless explicitly enabled, lists existing directives, only creates/PATCHes Bobbit-prefixed stable names, attaches `bobbit`/project tags, and caches signature.
  - Add a per-request fallback instruction helper for `reflect` queries when bank directives are disabled, so Bobbit tool behavior improves without mutating shared bank state.
- `market-packs/hindsight/src/provider.ts`
  - Call `applyDirectives` next to `applyBankMission` only when directive mode is explicitly enabled; best-effort and non-blocking for turns.
- `market-packs/hindsight/src/routes.ts`
  - `reflect` should prepend/attach the Bobbit coding-agent instruction per request when bank directives are disabled.
  - `status` can expose directive mode/applied diagnostics if useful, but no UI work is required.

Fallback:

- Endpoint missing/403/5xx → record diagnostic only; recall/retain/reflect proceed.
- If scoped directive semantics cannot be verified, keep bank directive application disabled and rely on per-request reflect instructions. Do not create bank-wide active coding-agent directives in shared `hermes` by default.

Tests:

- Stub directive endpoints.
- Unit: default config makes zero directive POST/PATCH calls; explicit opt-in applies Bobbit-prefixed directives once per signature and re-applies on config change; non-Bobbit directives are never modified; provider failure is non-fatal.
- Route/tool test: with bank directives disabled, reflect still includes the per-request coding-agent instruction; untagged/non-Bobbit route contexts are unaffected.
- If a future live/stub scoped-directive mode is added, tests must prove non-Bobbit/untagged recall/reflect calls do not receive Bobbit directive behavior before enabling it by default.

### 9. Health-gated / throttled retain

Goal: avoid bursting queued retains when Hindsight is unhealthy or under load.

Current state:

- `drainQueueHead` replays one entry before `afterTurn`.
- `drainQueueAll` attempts every queued entry at `sessionShutdown`.
- `QUEUE_CAP=100` prevents unbounded growth.

Work:

- Add config:
  - `retainQueueDrainMaxPerHook: 1` (default preserves current head drain).
  - `retainQueueShutdownMax: 10` or similar bounded default instead of unbounded all.
  - `retainQueueHealthGate: true`.
  - `retainQueueLlmHealthGate: false` by default; enable only if operator wants LLM probe overhead.
  - `retainQueueBatchPauseMs` optional only if hook runtime permits; avoid sleeps in normal hooks.
- `market-packs/hindsight/src/hindsight-client.ts`
  - Add `llmHealth(bank): Promise<BankLlmHealthResponse>` and `listOperations(bank, opts?)`.
- `market-packs/hindsight/src/provider.ts`
  - Before any queue drain, call `client.health()` when health gate enabled. If unhealthy, leave queue untouched and record a lightweight diagnostic.
  - Optional LLM probe: call `health/llm` and require `retain.ok` for queued retain drain; do not do this per turn by default because it can add overhead.
  - Replace `drainQueueAll` with bounded drain count. Session shutdown should not burst 100 entries.
  - Always use `async:true` for queued retains (`sync:false`) except compaction-specific direct retain already handled.

Fallback:

- If health endpoint fails, defer drain; never drop queue.
- Current direct retain for the active turn can still attempt and enqueue on failure.

Tests:

- Provider test: unhealthy `client.health()` causes drain to skip with no retain calls.
- Provider test: shutdown drains at most configured max.
- Client test: `llmHealth` path and response mapping.
- Stub: operations + health/llm endpoints.

### 10. Reversible curation

Goal: let agents invalidate known-stale memories without permanent deletion.

Files/functions:

- `market-packs/hindsight/src/hindsight-client.ts`
  - Add `invalidateMemory(bank, id, reason): Promise<void>` using `PATCH /memories/{id}` body `{ state:'invalidated', reason }`.
  - Optional `getMemoryHistory(bank, id)` for future revert workflows.
- `market-packs/hindsight/src/routes.ts`
  - Add route `invalidate` with body `{ id, reason }`.
  - Require non-empty id and reason.
- `market-packs/hindsight/tools/hindsight/extension.ts`
  - Register `hindsight_invalidate`.
- `market-packs/hindsight/tools/hindsight/hindsight_invalidate.yaml`
  - New descriptor. Keep it minimal: `id`, `reason`.

Fallback:

- No delete route in agent tool; invalidation only. Revert remains direct API/manual via history for now.

Tests:

- Stub supports patching memory state and excludes invalidated memories from recall.
- Client test validates exact PATCH body.
- Route/tool tests validate success and input errors.
- E2E tool test: invalidate then recall no longer returns seeded memory.

## File-level change plan

Implementation should touch these production files plus generated lib outputs and tests. Most changes stay in the Hindsight pack; the outcome-digest guarantee also needs a small server lifecycle hook.

- `src/server/agent/lifecycle-hub.ts`
- `src/server/agent/pack-contributions.ts`
- `src/server/server.ts` and/or `src/server/agent/team-manager.ts` for the `goalCompleted` dispatch point
- `market-packs/hindsight/src/hindsight-client.ts`
- `market-packs/hindsight/src/shared.ts`
- `market-packs/hindsight/src/provider.ts`
- `market-packs/hindsight/src/routes.ts`
- `market-packs/hindsight/providers/memory.yaml`
- `market-packs/hindsight/tools/hindsight/extension.ts`
- New tool descriptors:
  - `market-packs/hindsight/tools/hindsight/hindsight_retain_outcome.yaml`
  - `market-packs/hindsight/tools/hindsight/hindsight_invalidate.yaml`
- Generated outputs from pack build:
  - `market-packs/hindsight/lib/hindsight-client.mjs`
  - `market-packs/hindsight/lib/provider.mjs`
  - `market-packs/hindsight/lib/routes.mjs`
- Tests:
  - `tests/e2e/hindsight-stub.mjs`
  - `tests/hindsight-client.test.ts`
  - `tests/hindsight-provider.test.ts`
  - `tests/hindsight-tool-execute.test.ts`
  - `tests/e2e/hindsight-external.spec.ts`
  - `tests/e2e/hindsight-agent-tools.spec.ts`
  - `tests/e2e/hindsight-config-write.spec.ts` for new config keys if surfaced through config route
  - `tests/lifecycle-hub.test.ts` or a focused team-completion test for `goalCompleted` dispatch

No UI work is required for this goal.

## Before/after cost model

### Current pack baseline

- Session start: `sessionSetup` may run one raw recall and inject up to `recallBudget=1200` tokens in one `Relevant memory` block.
- Each user turn: `beforePrompt` may run one raw recall and inject up to `1200` tokens.
- Recall payload: already observation-biased (`types=['observation','world','experience']`) and already sends no `include.chunks`.
- Retain: routine extraction is batched, default one retain per 5 turns (80% fewer extraction calls than per-turn retain), with up to 2 overlap turns carried into next batch.
- Compaction: `beforeCompact` is batch-exempt and synchronous by design.
- Queue drain: one queued entry before a turn, unbounded best-effort at shutdown.

### Target after v2

- Session start with mental model available: one `GET /mental-models/{id}` and one injected project model block capped at ~1000-1200 tokens; explicit `doMentalModel.state === 'injected'` suppresses broad raw sessionSetup recall for that hook. Refresh is cadence-bounded and async via operation IDs.
- Session start without model/content: falls back to current raw recall; no regression.
- Each user turn: `beforePrompt` targeted recall remains, still observation-biased and chunk-free. Future tuning can lower `recallBudget`, but that is not required for this goal.
- Retain: routine extraction remains one call per 5 turns. Outcome digest adds one async replace retain per goal/PR, which is low frequency and high value.
- Queue drain: bounded and health-gated, reducing daemon starvation risk.
- Structured reflect: for schema-driven queries, agents consume one compact JSON object instead of prose plus parsing/retry turns.

### Net impact

Expected net reduction is from fewer rediscovery turns and a cheaper session-start memory path, not from chunk toggling:

- Injected start-of-session tokens: current worst case ~1200 raw recall tokens; target ~1000-1200 curated mental-model tokens, often replacing many raw facts with one synthesized document. If the model is tuned to 900-1000 tokens, the direct prompt-token reduction is ~15-25% for sessionSetup memory.
- Recall quality: observation/fact-type bias keeps per-turn recall high-signal; chunks remain absent by default.
- Retain calls: remains 1 per 5 routine turns; the owned `goalCompleted` hook adds exactly one async replace retain per completed goal/PR (plus manual repair re-emits when needed). This should reduce future search/recall calls by making completed work discoverable in one outcome memory.
- Wall-clock: mental model `GET` is cheaper than a fresh broad recall/reflect; refresh is async and cadence-bound.

### Measurement/reporting required in PR

Implementation PR/test output must report concrete counters so the cost claim is auditable:

- `sessionSetupRawRecallCount`: baseline/current vs model-injected path; expected zero when model state is `injected`.
- `mentalModelGetCount`, `mentalModelCreateCount`, `mentalModelRefreshCount`, and refresh cadence decisions.
- Injected memory token estimate: raw recall block characters/tokens vs mental-model block characters/tokens using the same estimator currently used for context blocks or a documented `chars/4` estimate.
- Recall request audit: `types` present and no default `include.chunks`.
- Retain frequency: routine retain calls per N turns, one outcome retain per completed goal/head, and bounded queue-drain counts.
- Structured reflect path: whether `structured_output` was returned for schema calls.

## Operator environment recommendations

Do not change operator-owned daemon configuration from Bobbit. Document/recommend only:

- Keep local reranker enabled. The operator's deployment reports a local cross-encoder reranker.
- Consider `HINDSIGHT_API_SEMANTIC_MIN_SIMILARITY` around `0.2-0.3` to drop weak semantic matches without suppressing useful recall.
- Consider `HINDSIGHT_API_RECALL_STRATEGY_BOOSTS` values that boost entity/graph signals and recent temporal signals for code work.
- Keep `recall_include_chunks=true` in bank/server config if the dashboard/operator wants chunks available; Bobbit agent recall still does not request chunks because per-request `include.chunks` defaults disabled.
- Keep fixed recall budgets low/mid/high = 100/300/1000 unless evidence shows recall degradation.
- Apply launchd/environment changes in the operator's `local.hindsight-dashboard` plist so the data-plane daemon inherits them; never write them from the pack.

## Acceptance mapping

- Design doc reconciled to pack and Hindsight 0.8.3: this document.
- Per-project mental model: implement client methods, provider `sessionSetup` injection, cadence store, tests.
- Outcome digest: implement advanced retain fields, owned `goalCompleted` provider hook dispatch, dedicated route/tool fallback, replacement/idempotency tests.
- Observation-biased/chunks guard: preserve current `types`, add no-chunks regression tests.
- Structured reflect: add `response_schema` pass-through and `structured_output` route/tool surfacing.
- Observation scopes/entities/query timestamp/directives: add config, client mappings, provider/route wiring, and tests; keep bank-wide directives disabled by default unless scoped semantics are verified.
- Health-gated retain: add health/LLM operations client support, bounded queue drain, tests.
- Reversible curation: add `hindsight_invalidate`, client/route/tool/stub tests.
- Token/cost model: documented above.
