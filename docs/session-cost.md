# Session usage and cost

Bobbit persists a server-owned usage projection for each session. This projection
survives compaction, reconnects, and gateway restarts, so a compacted visible
transcript is never used as an accounting ledger.

The projection is intentionally additive. Existing Pi session accounting remains
unchanged; the Claude Agent SDK runtime adds root-result accounting, per-model
attribution, context measurements, and an explicit cost basis. UI rendering is
owned separately by G10b. These fields let clients render an authoritative
snapshot without deriving totals from chat rows.

## Snapshot contract

When usage exists, `/api/sessions/:id/cost`, `state.serverCost`, and the
WebSocket `cost_update.cost` payload use the same `SessionUsageSnapshot` shape:

```ts
{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number | null;
  totalCost: number | null;
  notionalCostUsd: number | null;
  costBasis: "api-billed" | "api-notional" | "subscription-notional" | "unknown";
  costBasisHistory: Array<"api-billed" | "api-notional" | "subscription-notional" | "unknown">;
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    notionalCostUsd: number | null;
    contextWindow: number | null;
    maxOutputTokens: number | null;
  }>;
  context: {
    currentTokens: number | null;
    currentModel: string | null;
    highWaterTokens: number | null;
    highWaterModel: string | null;
    byModel: Record<string, {
      contextWindow: number | null;
      currentTokens: number | null;
      highWaterTokens: number | null;
    }>;
  };
}
```

The legacy token counters remain available for existing clients. `byModel`,
context, and basis fields are additive. A session with no recorded usage has no
server snapshot; Bobbit does not create a zero-valued record merely because a
session was opened.

`currentTokens` is the most recent authoritative occupancy reported for a model
on an SDK root result. `highWaterTokens` is the maximum reported occupancy and
never decreases after compaction, reconnect, or reload. Bobbit does not infer
context from visible messages, or fill an SDK context window from Pi model
heuristics.

## Cost meaning

`totalCost` represents a billed amount only when the runtime has established
one. `null` means it is unknown or not applicable, not zero.

The closed Claude Agent SDK environment currently discovers local subscription
usage. Its `total_cost_usd` is exposed only as `notionalCostUsd` with
`costBasis: "subscription-notional"` and `totalCost: null`. It is an SDK usage
estimate, never an invoice. If a supported runtime establishes a different
basis, Bobbit persists that basis and preserves `costBasisHistory`; it does not
rewrite earlier subscription-notional usage as billed cost. An unavailable basis
is `"unknown"`, not a fabricated dollar value.

Pi continues its existing completed-assistant and completed-compaction
accounting. Its persisted values retain the legacy `api-billed` projection and
are not routed through the SDK root-result ledger.

## Claude SDK exactly-once ledger

For an SDK session, only a finalized **root** SDK `result` is an accounting
source. Streaming frames, assistant `message_end` events, child partitions,
snapshot replay, and lifecycle-only events do not change cumulative usage.

The server normalizes the result into an internal record keyed by the opaque
SDK session/result identity. `CostTracker` atomically persists that source ID
with the aggregate counters, per-model buckets, context high-water marks, and
basis state. A duplicate source ID is a no-op before and after restart. The
applied-ID ledger is private persistence: IDs are not exposed as a REST or
WebSocket accounting field.

This separation matters because identical text, token counts, and timestamps
can represent separate turns, while a retried terminal event can represent the
same turn. Only the SDK result identity makes replay safe. Child SDK agents are
audit-attributed to the root session, not separate session or cost accounts.

## Hydration and compaction ordering

`SessionManager` resolves the persisted snapshot for live, dormant, and archived
sessions. It sends the same snapshot through both hydration paths:

- `cost_update` on attach, `get_state`, `get_messages`, resume recovery, and
  compaction refresh;
- `state.serverCost` whenever a state snapshot is sent.

After either runtime compacts, `refreshAfterCompaction()` sends the usage
snapshot before the compacted message snapshot, then sends state. Reload is
therefore a snapshot recovery, not a recount of the shorter transcript.

For Claude SDK compaction, the SDK owns the actual history change. On its
`PreCompact` hook Bobbit stores an SDK-specific pending checkpoint with the
normalized official pre-compaction rows. It completes the checkpoint only after
official history changes, retains the pre-history for
`/api/sessions/:id/transcript/before-compaction`, and reconciles a pending
checkpoint after restart. It never treats an SDK compaction as Pi JSONL
compaction or invents a completion from `PreCompact` alone.

## API and implementation map

- `GET /api/sessions/:id/cost` returns the same persisted projection or `404`
  when no usage record exists.
- `GET /api/sessions/:id/cost/breakdown` and goal/task cost endpoints retain
  their existing aggregation contracts; consumers should preserve `null` cost
  semantics rather than coercing them to zero.
- `cost_update` and `state.serverCost` are the live/reload transport contract.
  G10b owns how a client labels or renders billed versus notional values.

| Concern | Primary module |
| --- | --- |
| Durable usage, basis, model/context projection, and private SDK result ledger | `src/server/agent/cost-tracker.ts` |
| Runtime-specific recording and cost/state hydration | `src/server/agent/session-manager.ts` |
| WebSocket snapshot types | `src/server/ws/protocol.ts` |
| Cost REST routes | `src/server/server.ts` |
| SDK result normalization | `src/server/agent/claude-sdk-event-translator.ts` |
| SDK compaction checkpoint | `src/server/agent/claude-sdk-compaction-checkpoint.ts` |

See [Claude Agent SDK sessions](claude-agent-sdk-sessions.md) for the SDK
transcript, recovery, and tool-projection contract.

## Regression coverage

- `tests2/core/cost-tracker.test.ts` covers durable de-duplication, model
  buckets, basis, and context high-water persistence.
- `tests2/core/claude-sdk-event-translator.test.ts` covers root-result-only SDK
  normalization and excludes child/malformed results.
- `tests2/integration/cost-update-cache-hit.test.ts` covers additive usage
  transport and hydration.
- `tests/e2e/claude-agent-sdk-session-restart.spec.ts` exercises the
  deterministic SDK parent demonstration across tool use, a workflow gate,
  compaction, restart, reload, duplicate result replay, unavailable-provider
  failure, and a co-resident Pi control session.
