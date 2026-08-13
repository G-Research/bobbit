# Claude transcript and usage fidelity

## Decision

The Claude Agent SDK is the authority for its conversation and for each completed
root-turn result. Bobbit is the authority for the durable, user-visible projection
of that truth: its idempotency ledger, cumulative usage/cost view, context
high-water marks, transcript sidecars, WebSocket snapshots, and recovery state.
The browser is a consumer only. It must never reconstruct missing cost, usage,
compaction, or audit truth from visible messages.

This design completes the runtime boundary introduced by the existing SDK bridge.
It does not replace Pi's JSONL protocol, create a second Claude conversation
store, treat a child SDK subagent as a Bobbit session, or turn the SDK's
notional `total_cost_usd` into a subscription invoice.

## Audited starting point

The current bridge is selected only by `claude-agent-sdk/<model>` through
`src/server/agent/session-runtime.ts::resolveSessionRuntime`; `anthropic/*`
continues to select Pi. The bridge starts one long-lived `Query` in
`src/server/agent/claude-agent-sdk-bridge.ts::ClaudeAgentSdkBridge.startInternal`,
passes its opaque UUID as `options.resume`, and uses the official
`getSessionInfo` / `getSessionMessages` API through
`claude-agent-sdk-session-access.ts` for history.

Useful existing seams are:

| Concern | Current owner / seam | Fidelity gap to close |
| --- | --- | --- |
| SDK event normalization | `claude-sdk-event-translator.ts::translateClaudeSdkEvent` | Its terminal drain emits `agent_end` but drops root `result.usage`, `total_cost_usd`, result identity, model usage, and context fields; no authoritative root-result usage record or idempotency key survives. |
| Live event lifecycle | `ClaudeAgentSdkBridge.consume` | It correctly partitions child frames and resets only after a root `agent_end`, but currently exposes no separately owned result-usage observation or canonical SDK compaction marker/refresh. |
| Cost mutation | `session-manager.ts::trackCostFromEvent`, `cost-tracker.ts::CostTracker.recordUsage` | It ignores `agent_end` and instead adds every completed assistant `message_end` with a numeric cost. That admits repeated translated usage and child assistant/subagent rows and has no durable source-result de-duplication. |
| Cost persistence/hydration | `CostTracker`, `SessionManager.getSessionCostUpdate`, `withSessionCostInState`, `ws/handler.ts` | `session-costs.json` stores only aggregate counters. It has no per-model totals, cost basis, source-result ledger, or context high-water mark. |
| Live/archive snapshots | `ClaudeAgentSdkBridge.getMessages`, `SessionManager.getMessagesSnapshotBase`, `getArchivedMessages`, `claude-agent-sdk-history-adapter.ts::adaptSdkSessionMessages` | The official history path preserves `uuid`, `parent_tool_use_id`, and `parent_agent_id`, but live `canonicalizeToolNames()` and the history adapter use different paths, so raw `mcp__bobbit__*` names can reappear after reload; unavailable archived history is swallowed as `[]`. |
| Transcript tool/API | `server.ts` `GET /api/sessions/:id/transcript`, `transcript-reader.ts` | The route requires `agentSessionFile` and consequently treats an SDK conversation as unavailable rather than using the SDK authority. Restore also has Pi `agentSessionFile` eligibility paths that must branch on SDK runtime plus resume UUID before an empty SDK field can strand queued work. |
| Transport contract | `ws/protocol.ts`, `ws/handler.ts`, `SessionManager.getSessionCostUpdate` | The current wire cost snapshot is aggregate-only; it lacks the durable by-model/context/basis contract that reload and a UI consumer need. UI rendering is deliberately out of scope (G10b). |
| SDK compaction | bridge `PreCompact` hook and `SessionManager.refreshAfterCompaction` | SDK compaction is provider-owned and manual SDK compaction is correctly unsupported; `PreCompact` emits no canonical start/end markers or snapshot refresh, and there is no durable server-side checkpoint or post-compaction usage/context projection. |

The installed/pinned package is `@anthropic-ai/claude-agent-sdk@0.3.222`
(`package.json` and `package-lock.json`). The published declaration for that pin,
not a guessed CLI shape, remains the source for the exact `SDKResultMessage`,
`usage`, `modelUsage`, and initialization/auth fields.

## Ownership and invariants

### Source-of-truth boundaries

1. **Claude SDK** owns the conversation, official session existence, finalized
   session messages, the root `result` frame, and its usage/model-usage values.
   `getSessionInfo({ dir: cwd })` distinguishes an empty conversation from a
   missing one; `getSessionMessages({ dir: cwd })` supplies visible history.
2. **`ClaudeAgentSdkBridge`** owns one query generation, its event order,
   translator state, locally observed root-result identity, and a bounded
   sanitized diagnostic channel. It does not update `SessionStore`, mutate a
   cost aggregate, or own an alternate transcript database.
3. **`SessionManager`** owns which canonical bridge generation may publish an
   observation, recovery fencing, the durable prompt/steer queue, and the one
   call into the usage ledger. Detached/replaced bridges cannot persist or
   broadcast a late result.
4. **The project `CostTracker` (expanded into a session usage ledger)** owns
   durable idempotency, aggregate totals, per-model aggregates, context
   high-water data, and cost-basis state. This is the only source for REST and
   WebSocket cumulative usage/cost hydration.
5. **The server-side transcript projection** owns Bobbit view transforms
   (trusted author metadata, tool-result redaction/truncation, ordering stamps,
   and compaction checkpoints). It adapts SDK messages; it never replays UI
   rows into the provider or invents missing SDK messages.
6. **Client consumers** render server snapshots. They may retain a live
   streaming preview but must replace it with a server snapshot and must not add
   visible-message usage into cumulative totals. G10b owns their implementation.

### Non-negotiable invariants

- One authoritative root SDK result is accepted **at most once** per Bobbit
  session, including replay, reconnect, bridge replacement, gateway restart,
  compaction refresh, and duplicate terminal frames.
- Child `parent_tool_use_id` partitions are auditable transcript attribution,
  not independent session/cost accounts. Child message usage never creates a
  second root ledger record.
- All cumulative fields are monotonic except an explicitly reported
  `currentContextTokens`; high-water values never decrease because a transcript
  compacted or a page reloaded.
- A cost basis is explicit. A Claude subscription result's SDK dollar value is
  **notional usage**, not evidence of a billed API charge. Unknown cost is
  represented as unknown, never changed to `$0`.
- A failed/absent SDK source is a structured unavailable result, never an empty
  successful history, a new query without `resume`, Pi JSONL fallback, or a
  hung readiness/prompt operation.
- Pi's existing message-end plus compaction-end accounting, JSONL reader,
  compaction sidecar, and provider behavior remain byte-for-byte equivalent
  outside the new runtime branch.

## Authoritative usage record and exactly-once accounting

### Record normalisation

Add a pure SDK-only normalizer next to
`src/server/agent/claude-sdk-event-translator.ts`, for example
`normalizeClaudeSdkRootResultUsage(input)`. It accepts only a root
`type: "result"` frame from the pinned declaration and returns no record for a
child partition, a non-final stream frame, malformed values, or an unidentifiable
result. It preserves source values rather than calculating a cost from model
pricing:

```ts
interface ClaudeSdkUsageRecord {
  source: "claude-agent-sdk-result";
  sourceResultId: string;       // SDK session UUID + result UUID; never a content hash
  sdkSessionId: string;
  modelUsage: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    notionalCostUsd?: number;
    contextWindow?: number;
    maxOutputTokens?: number;
    contextTokens?: number;
  }>;
  total: { inputTokens: number; outputTokens: number; cacheReadTokens: number;
           cacheWriteTokens: number; notionalCostUsd?: number };
  costBasis: "subscription-notional" | "api-notional" | "unknown";
}
```

The implementation must use the exact field names/types in SDK `0.3.222`.
`modelUsage` must be retained even where its sum differs from a result-level
total; the result-level total is the root-turn aggregate and the model map is
the attribution view. Missing fields remain absent/unknown rather than being
inferred from a model catalogue. The record's model key is the exact SDK model
identity, namespaced in Bobbit only at the presentation boundary (for example,
`claude-agent-sdk/<sdk-model>`), so aliases are not silently merged.

The existing translator may carry the normalized record on a typed,
non-rendering `claudeSdk` event annotation, or the bridge may emit a distinct
internal observation into the same manager-owned listener. It must not create a
synthetic assistant message solely to carry accounting data. The root `result`
frame, not assistant `message_end`, is the only SDK accounting trigger.

### Durable ledger protocol

Extend `src/server/agent/cost-tracker.ts`; do not bolt de-duplication onto the
browser or an in-memory bridge set. The tracker should expose a narrow operation
such as:

```ts
recordAuthoritativeUsage(sessionId, record, goalId?): {
  applied: boolean;             // false when sourceResultId is already durable
  snapshot: SessionUsageSnapshot;
}
```

Persist an append-only, crash-safe applied-result ledger keyed by
`(sessionId, sourceResultId)` alongside the cumulative session snapshot. It may
be an atomically compacted `session-usage.json` plus journal, or a versioned
append log and snapshot; the critical property is that **the idempotency key is
durable before a duplicate can be accepted after restart**. A bounded in-memory
set may be a fast path only. Do not use text, token counts, timestamps, or a
message index as the key: equal turns are legal and compaction changes indexes.

In one atomic logical mutation, an unseen record must:

1. write/retain its source-result identity;
2. add root totals exactly once;
3. add each source-model bucket exactly once;
4. update per-model and session context high-water marks with `max`; and
5. persist the resulting basis state and aggregate snapshot.

If the process dies before that mutation commits, a replay may apply it once. If
it dies after it commits, replay must return `applied: false`. A result without a
stable source ID is diagnostics-only and does not change cumulative totals.

`SessionManager.trackCostFromEvent` becomes runtime-dispatched:

- **Pi:** retain its current completed-assistant and completed-compaction event
  rules unchanged.
- **Claude SDK:** consume only the canonical root result record, call the
  tracker once, and broadcast only the returned cumulative snapshot. It must
  ignore assistant `message_end`, stream updates, child partitions, snapshot
  replay, and `agent_end` without an authoritative usage annotation.

Bridge replacements already use lifecycle-generation fencing. Apply the same
fence before the tracker call and before `cost_update`; a late detached query
may be logged but cannot mutate current session data.

## Usage, model, context, and cost-basis persistence

Replace the narrow `SessionCost` wire/persistence shape with an additive
`SessionUsageSnapshot`. Retain the legacy five counters for REST compatibility
and add the following fields:

```ts
interface SessionUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number | null;            // billed amount only when actually known
  notionalCostUsd: number | null;      // SDK result estimate; never an invoice
  costBasis: "api-billed" | "api-notional" | "subscription-notional" | "unknown";
  byModel: Record<string, ModelUsageSnapshot>;
  context: {
    currentTokens: number | null;
    currentModel: string | null;
    highWaterTokens: number | null;
    highWaterModel: string | null;
    byModel: Record<string, { contextWindow: number | null;
                              currentTokens: number | null;
                              highWaterTokens: number | null }>;
  };
}
```

`totalCost` must remain a number only for a source that establishes an actual
billable amount. For normal local Claude subscription discovery through the
closed bridge environment, publish `costBasis: "subscription-notional"`,
`totalCost: null`, and any SDK `total_cost_usd` only as `notionalCostUsd`.
The UI labels that value as estimated/notional subscription usage; it must not
render it as a billed dollar total. A real API-key/provider mode, if the
runtime is ever explicitly supported, must make an observed, server-owned basis
transition and retain the earlier bucket/basis rather than rewriting history.

The initialization/auth observation is the only place allowed to declare the
basis. It must be sanitized to a category (for example `subscription`, `api`,
or `unknown`); credential material, auth paths, and raw SDK initialization
payloads never enter state, transcript, diagnostics, or persistence. A
transition is broadcast through the same server snapshot and persisted in the
ledger. The current closed `buildClaudeAgentSdkEnv()` policy continues to block
API/cloud credential inheritance; this goal does not add an implicit API-key
fallback.

`context.currentTokens` is updated only from an explicit authoritative SDK
usage/model-usage field. It is not calculated by summing transcript rows.
`highWaterTokens` is the maximum of all reported current values and survives
compaction/reload. A model's declared `contextWindow` and `maxOutputTokens` are
also recorded per model when supplied by the SDK result/capability source;
`contextWindow` is not filled with Pi's family inference for an SDK session.

Update these boundaries together:

- `src/server/agent/cost-tracker.ts` owns schema migration, load/save, ledger
  de-duplication, and aggregate projection.
- `src/server/agent/session-manager.ts::{getSessionCost,withSessionCostInState,
  getSessionCostUpdate,trackCostFromEvent}` own resolution and hydration.
- `src/server/ws/protocol.ts::SessionCostSnapshot` and `cost_update` receive
  additive fields; older clients remain able to read the legacy counters.
- `src/server/server.ts` cost endpoints return this same projection rather than
  a separately recomputed by-model total.
- `src/app/remote-agent.ts` receives/stores the whole server snapshot; it never
  merges message usage into it. This is a transport-consumer requirement, not a
  rendering change in this goal.
- G10b owns UI rendering. This goal publishes the additive server contract
  (`cost_update`, `state.serverCost`, and cost REST responses) for basis,
  notional/billed totals, by-model usage, and current/high-water context. UI
  must be able to render those values without reading visible assistant rows.

## Transcript, tools, and subagent auditability

### One projection for all reads

Use the official SDK history helper and
`adaptSdkSessionMessages()` for every SDK transcript consumer:

- live `ClaudeAgentSdkBridge.getMessages()`;
- `SessionManager.getMessagesSnapshotBase()`;
- `SessionManager.getArchivedMessages()`;
- `GET /api/sessions/:id/transcript` and `read_session`;
- tool-content identity reads where the requested SDK message/tool block exists.

The REST transcript reader needs a runtime-aware source adapter rather than an
`agentSessionFile` precondition. Add a normalized-message reader path in
`src/server/agent/transcript-reader.ts` (or an SDK-specific adapter composed by
`server.ts`) that preserves its existing pagination, regex, verbose, author,
and tool-result-redaction contract. Pi stays on `sessionFileRead` JSONL. SDK
reads call `readSdkSessionInfo` then `readSdkSessionMessages` using persisted
`cwd`, normalize through the one history adapter, and return the same envelope.

The server's `buildVisibleMessageSnapshot` remains a view transformation only.
It may stamp `_order`, apply trusted author metadata, merge sidecars, and bound
large tool payloads for transport. It must preserve stable SDK `uuid` as the
row identity, tool-use IDs, `parentToolUseId`, and `parentAgentId`. Do not use
rendered position to resolve tool content; SDK messages can be compacted and
synthetic rows can be inserted.

Move the existing `ClaudeAgentSdkBridge.canonicalizeToolNames()` logic behind
one server-side shared resolver supplied by
`claude-agent-sdk-tool-surface.ts::normalizeClaudeSdkMcpToolName`. Apply that
resolver to both live translated events and
`claude-agent-sdk-history-adapter.ts::adaptSdkSessionMessages`. A historical
`mcp__bobbit__read` must project to exactly the same canonical `read` identity
as its live event; unknown/foreign raw names remain unowned. No browser-side
name repair is permitted.

### Tools and constrained SDK children

`claude-agent-sdk-tool-surface.ts` remains the single owner for SDK raw-to-
canonical Bobbit tool normalization. `claude-sdk-tool-dispatcher.ts` remains the
Bobbit execution seam. The SDK transcript contains the authoritative parent
`Agent` tool call/result and tool blocks; Bobbit's live event stream preserves
canonical names for renderers and raw names only in bounded diagnostics.

The existing translator partition (`parent_tool_use_id`) and
`parentAgentId` must reach both live events and history projection. A child
terminal drains only its partition and cannot yield a root usage record,
`agent_end`, session, task, worktree, or separate cost account. The bounded
subagent audit rows from `ClaudeSdkToolSurface.subagentPolicy` remain metadata
only; they must correlate session ID, root Agent tool-use ID, child ID/type,
partition, outcome, and duration without prompts, response bodies, arguments,
paths, credentials, or private SDK transcript paths.

Persist only this **minimal runtime audit projection** when it is needed to make
reload/REST transcript attribution durable: stable root/session/tool/child IDs,
type, outcome, and timestamps/duration. Do not redesign the policy audit sink,
change grants, or broaden retention in this slice; that sink may overlap the
policy owner's scope and requires explicit coordination. If the existing sink
cannot durably retain this minimal projection, record the gap and hand it to
that owner rather than inventing a parallel policy database.

## Compaction, resume, and reload

The SDK owns compaction. Bobbit continues to reject manual SDK `compact()` and
uses `PreCompact` only to dispatch the existing `beforeCompact` hook. This goal
adds fidelity around that provider-owned transition rather than fabricating Pi
compaction events.

1. When the bridge receives `PreCompact`, it must call a
   `SessionManager`-owned SDK-compaction coordinator, which persists a pending
   checkpoint and reads official history before the provider changes it. The
   coordinator emits one canonical server `compaction_start` marker and persists
   normalized pre-compaction rows in a dedicated SDK sidecar keyed by session
   ID and stable checkpoint ID. This is a server artifact, not a browser cache
   and not a Pi JSONL file.
2. On the next authoritative SDK compaction/result/history observation, the
   coordinator resolves that checkpoint once, captures the post-compaction
   official snapshot, emits one canonical completion marker, and invokes
   `refreshAfterCompaction()`. If the SDK supplies no completion marker, keep
   the checkpoint pending and let only the server-side official-history
   comparison resolve it; never manufacture a completed transition just because
   `PreCompact` fired.
3. `refreshAfterCompaction()` remains ordered: durable usage snapshot first,
   then transformed messages, then state. For SDK it must use the official
   history source and server context projection. No client-side row scan may
   amend high-water totals.
4. On gateway restart, restore uses the stored UUID as `resume`; after the
   bridge is canonical, hydrate its durable usage/context snapshot and fetch
   current official history. An incomplete compaction checkpoint is reconciled
   idempotently from the SDK source/sidecar. The old bridge's buffered events
   cannot reapply usage.
5. On WebSocket reconnect/reload, `cost_update` and `state.serverCost` carry
   the same persisted usage snapshot before `messages`. `RemoteAgent` replaces
   transcript state with the server snapshot and displays the persisted context
   fields. A `resume_gap` is therefore a snapshot recovery, not a cost replay.

Use a new SDK-specific checkpoint module rather than extending Pi's
`compaction-sidecar.ts` with guessed Pi entry IDs. The shared visible-snapshot
and REST presentation code may be reused, but the provenance must remain
explicitly SDK-owned.

## Failure semantics

| Condition | Required behavior |
| --- | --- |
| SDK package/load/auth/provider unavailable, invalid initialization UUID, or readiness timeout | `ClaudeAgentSdkUnavailableError` settles `start`, `waitForReady`, and pending prompt delivery; no retry loop hangs and no Pi fallback begins. |
| Persisted SDK UUID invalid or official `getSessionInfo` absent | Restore leaves a dormant terminated session with sanitized `SDK_SESSION_UNAVAILABLE`, retaining queues/in-flight steers. Continue fails before destination allocation. |
| Official history unavailable | Live/archive snapshot and transcript route return a structured SDK-unavailable error, not `[]`, empty success, or a synthetic transcript. |
| Root result lacks stable identity/valid usage | Render/lifecycle may continue; emit bounded sanitized diagnostics; do not mutate totals. |
| Duplicate result/replay/replacement event | Durable ledger returns `applied:false`; totals, by-model counters, context high-water, and `cost_update` do not advance. |
| Cost/auth basis cannot be established | Persist and display `unknown`; never label a notional value billed or use a zero dollar total. |
| SDK compaction interrupted | Preserve pending checkpoint and prior durable usage; reconcile on later official history/resume. Never delete pre-compaction audit material merely because the browser reloaded. |
| Docker sandbox SDK request | Preserve the existing fail-closed unsupported-runtime error before host-local SDK query construction. |

## Implementation partition

| Slice | Files/symbols | Scope |
| --- | --- | --- |
| A — typed root result | `claude-sdk-event-translator.ts`, `claude-agent-sdk-bridge.ts::consume` | Normalize only root result usage/model/basis metadata, preserve partition semantics, and expose an internal canonical observation with a stable SDK result ID. |
| B — durable usage ledger | `cost-tracker.ts`, `session-manager.ts::trackCostFromEvent` and hydration helpers | Add idempotent persistence, migration, basis/by-model/context projection, and runtime-dispatched accounting. Keep the Pi branch unchanged. |
| C — server transport | `ws/protocol.ts`, `ws/handler.ts`, `server.ts` cost routes, `remote-agent.ts` state ingestion | Publish/store the additive server-owned usage/context/basis contract. G10b owns all rendering; this slice provides observability, not UI. |
| D — transcript/audit | `claude-agent-sdk-session-access.ts`, `claude-agent-sdk-history-adapter.ts`, `claude-agent-sdk-tool-surface.ts`, `transcript-reader.ts`, `server.ts` transcript/tool-content routes, `visible-message-snapshot.ts` | Make official SDK history available to live, archived, REST, and tool readers; use one canonical raw-name resolver and retain only the minimal runtime audit projection. |
| E — compaction/recovery | new `claude-sdk-compaction-checkpoint.ts`, bridge PreCompact composition, `SessionManager.refreshAfterCompaction`, restore/replacement eligibility paths | Persist/reconcile SDK checkpoints, emit canonical markers/refresh, and branch recovery by runtime plus resume UUID rather than Pi `agentSessionFile`. |

Do the slices in A → B → C/D → E order. C and D may proceed in parallel after
B's wire shape is fixed. Each slice must add the regression test that prevents
its own failure mode; do not weaken existing Pi or SDK lifecycle tests to make a
new result format pass.

## Focused test and parent demonstration plan

### Bounded deterministic test plan

Keep coverage in existing suites where feasible; use the current fake Query and
session-access seams rather than creating a new fixture subsystem.

| Existing test location | Table-driven cases | Required assertion |
| --- | --- | --- |
| `tests2/core/claude-sdk-event-translator.test.ts` | Pi-shaped completed assistant/compaction inputs and Claude root result, duplicate root result, child result, malformed/identity-less result, multi-model result | The normalized authoritative record is emitted only for a root SDK result; translator drain retains result identity, usage, total/notional cost, model, and context. Pi's existing message shape/lifecycle remains unchanged. |
| `tests2/core/claude-agent-sdk-bridge.test.ts` | unavailable loader, init rejection/timeout, iterator failure, result after replacement/stop | `start`, `waitForReady`, and pending input settle once with sanitized errors; no child/late frame publishes a result record or hangs a waiter. |
| existing `CostTracker` core suite (extend it; add one small sibling only if its harness cannot persist/reload) | duplicate source ID before/after reload, two equal-valued but distinct IDs, model switch, compaction, unknown → subscription-notional (and supported API) basis transition | Ledger applies each authoritative record once; per-model totals and current/high-water context survive persistence/reload and never decrease; basis is durable and never turns a notional value into billed cost. |
| `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` | canonical/replaced bridge replay, SDK source absent at start/restore, empty `agentSessionFile` with valid resume UUID | Canonical generation alone mutates the ledger; SDK restore branches by runtime plus UUID, retains queue/steers, and exposes sanitized `SDK_SESSION_UNAVAILABLE` rather than hanging. Pi recovery remains its JSONL path. |
| `tests2/integration/session-runtime-route-boundary.test.ts` plus existing transcript reader coverage | live/archived SDK history, pagination/filter/redaction, raw MCP tool history after reload, tool/subagent partition and minimal audit projection | SDK and Pi transcript envelopes conform for common rows; stable IDs and canonical Bobbit tool names survive reload; unavailable SDK history is structured failure, not empty success. |
| `tests/e2e/claude-agent-sdk-session-restart.spec.ts` | root+child usage, model switch, SDK compaction checkpoint, crash/restart/resume and WS reload | One root count; durable by-model/high-water/basis; canonical compaction markers plus snapshot refresh; transcript/tool/audit identity equality; no SDK `switch_session`; retain co-resident Pi control. |

The conformance matrix compares the **server projection**, not widgets: given the
same normalized root/user/assistant/tool rows, Pi JSONL and SDK official history
must agree on role/order/stable identity, canonical tool name, redaction, parent
partition (where present), and structured unavailable behavior. Runtime-specific
fields may differ only where declared (Pi JSONL path versus SDK UUID/source).

Register a new test only when none of the listed suites has the required seam;
register it in `tests2/tests-map.json`. Suggested focused command:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-sdk-event-translator.test.ts \
  tests2/core/claude-agent-sdk-bridge.test.ts \
  tests2/core/claude-agent-sdk-session-access.test.ts \
  tests2/integration/claude-agent-sdk-runtime-persistence.test.ts \
  tests2/integration/session-runtime-route-boundary.test.ts
npm run check
```

### Daily parent demonstration

The parent must run this deterministic daily demonstration after the focused
suite passes, using the existing production bridge fake seam for repeatability;
a real subscription smoke is additive evidence, not the daily oracle. Record
only sanitized category/version evidence, never credentials or SDK file paths.
The server observability contract is: the session state/cost endpoint and
`cost_update` expose runtime, basis, root-result aggregate, by-model totals,
current/high-water context, and minimal tool/subagent attribution; transcript
reads expose the corresponding stable rows and canonical tool names.

1. Start the Claude session and confirm persisted runtime, resume UUID, and
   `subscription-notional` (or observed alternative) basis from the server
   snapshot/endpoint.
2. Prompt it to invoke one permitted Bobbit `read` MCP tool; inspect the same
   canonical call/result through `read_session` and the transcript API.
3. Run it under the goal workflow through a real gate action; prove the
   tool/gate and minimal subagent audit projection remain associated with the
   root session.
4. Cause/observe SDK-managed compaction (not the unsupported manual command),
   then compare canonical compaction markers, server transcript IDs,
   cost/usage/basis, by-model totals, and context high-water before and after.
5. Restart/resume the wrapper and reload a browser connection. Confirm the
   transport delivers the same transcript projection, one cumulative root-result
   count, stable high-water/basis/audit values, and no Pi `switch_session` for
   the SDK session. G10b separately verifies visual rendering.
6. In a controlled unavailable-provider fixture, show start/restore/prompt
   waiters settle visibly and leave no unrelated conversation; run a co-resident
   Pi session to prove Pi creation, transcript, cost, compaction, and resume are
   unchanged.

The demonstration is evidence for runtime fidelity, not a source of truth. The
durable SDK result ledger and official session-history reader remain authoritative.
