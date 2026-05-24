# Session cost display

Bobbit tracks model spend per session so the footer, stats popovers, and goal/task cost views can show cumulative usage across long-running work. The important constraint is that the chat transcript is not a reliable cost ledger: compaction can replace a long visible history with a short post-compaction snapshot, while the money already spent remains real.

## Source of truth

`CostTracker` is the authoritative display source when a session has persisted cost data. It is scoped to the session's project and persists cumulative totals in the project's state directory as `session-costs.json`.

A session cost snapshot contains:

```ts
{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}
```

The client stores this snapshot as `state.serverCost`. When `state.serverCost.totalCost` is present and greater than zero, the footer cost and the context popover's **Session → Total cost** row use it. Visible assistant-message `usage.cost.total` is not used as a fallback for the dollar display, because visible messages may be only the compacted tail of the session.

Sessions without persisted cost keep `serverCost` absent/null and show no footer cost. Bobbit intentionally does not fabricate a zero-cost server snapshot, because "no cost has been recorded" is different from "the authoritative cost is exactly zero".

## Recording vs hydration

There are two separate operations:

- **Recording** mutates `CostTracker`. `SessionManager.trackCostFromEvent()` records only completed assistant turns: `message_end` events with `role: "assistant"` and a numeric usage cost. Streaming `message_update` frames are ignored because the same usage object can appear repeatedly while a message streams.
- **Hydration** reads `CostTracker` and sends the existing cumulative snapshot to clients. Hydration never calls `recordUsage()`.

This separation prevents double-counting when Bobbit restores a session, replays buffered events, sends a message snapshot, merges synthetic compaction-summary rows, or reconnects a client. Only a new live completed assistant turn adds to the persisted total; every attach/reconnect/refresh path just re-sends the cumulative value already on disk.

## WebSocket hydration paths

The WebSocket protocol hydrates persisted cost through both a dedicated `cost_update` frame and `state.serverCost` when a `state` snapshot is sent. Both carry the same cumulative snapshot from `CostTracker`.

Hydration happens on these paths:

- **Active attach / reconnect** — after `auth_ok`, the server sends `cost_update` when persisted cost exists. The async live `getState()` push and persisted fallback state are also wrapped with `serverCost`.
- **`get_state`** — sends `cost_update` first, then a `state` frame with `serverCost` merged into the agent state or persisted fallback state.
- **`get_messages`** — sends `cost_update` before the message snapshot, for both live and archived sessions.
- **`resume` fallback** — sends `cost_update` before replaying buffered events or returning `resume_gap`. If the client falls back to `get_messages`, that request sends the cost again before the snapshot.
- **Archived sessions** — initial archived attach, archived `get_state`, and archived `get_messages` all hydrate cost. Archived `state` uses the same helper that injects persisted model/image-model data, so the initial connect and later `get_state` response stay in sync.
- **Preparing/starting sessions** — safe read-only responses for `get_state`/`get_messages` still hydrate cost if a persisted record exists.
- **`refreshAfterCompaction()`** — broadcasts `cost_update` before the compacted `messages` snapshot, then broadcasts `state` with `serverCost` merged in.

`SessionManager.getSessionCost()` resolves cost from the live session's project first, then persisted session metadata, then a cross-project scan when needed. It returns `undefined` if no persisted record exists.

## Compaction ordering

Compaction is the path that made visible-message cost unsafe. After compaction, the agent's `getMessages()` response may include only the summary/tail and the next visible assistant turn. If the UI summed only those rows, the footer could appear to drop even though the cumulative spend did not.

`refreshAfterCompaction()` therefore sends frames in this order:

1. `cost_update` with the persisted cumulative session cost.
2. `messages` with the compacted transcript snapshot.
3. `state` with `serverCost` merged into the agent state.

The first frame primes `RemoteAgent.state.serverCost` before the reduced transcript lands, so the footer and stats popover never need to fall back to the compacted visible-message sum.

## UI and REST surfaces

- `RemoteAgent` writes `state.serverCost` from either `cost_update` frames or `state.serverCost`.
- `AgentInterface.renderStats()` uses `state.serverCost.totalCost` for the footer and context popover total cost row.
- `<cost-popover>` fetches authoritative persisted data from `/api/sessions/:id/cost/breakdown` for session breakdowns and `/api/goals/:id/cost/breakdown` for goal breakdowns.
- `/api/sessions/:id/cost` returns the same persisted session total used for hydration. It returns 404 when the session exists but has no cost record.
- Goal and task cost APIs continue to aggregate from `CostTracker`; this fix does not change their accounting semantics.

## Regression coverage

Relevant tests pin the behavior:

- `tests/context-cost-stats.spec.ts` — fixture-level UI coverage that visible-message cost alone is hidden, and `serverCost` wins in the footer and session stats popover.
- `tests/e2e/compact-cost-ws.spec.ts` — WebSocket/API coverage for active attach, `get_state`, resume fallback, archived attach/state, no-cost sessions, and `refreshAfterCompaction()` cost-before-messages ordering.
- `tests/e2e/ui/compact-cost.spec.ts` — browser regression that seeds persisted cumulative cost, shrinks the visible transcript with a compaction-like refresh, and verifies the footer, context popover, and session cost API agree.
- `tests/cost-tracker.test.ts` — persistence and accumulation coverage for `CostTracker` itself.

## Implementation map

| Concern | Primary module |
| --- | --- |
| Persist cumulative session cost | `src/server/agent/cost-tracker.ts` |
| Record live completed assistant usage | `src/server/agent/session-manager.ts` (`trackCostFromEvent`) |
| Resolve and inject persisted cost | `src/server/agent/session-manager.ts` (`getSessionCost`, `withSessionCostInState`, `getSessionCostUpdate`) |
| WS hydration and archived state | `src/server/ws/handler.ts` |
| Client cost state | `src/app/remote-agent.ts` |
| Footer and context popover display | `src/ui/components/AgentInterface.ts` |
| Session/goal cost popover | `src/ui/components/CostPopover.ts` |
| REST cost endpoints | `src/server/server.ts` |
