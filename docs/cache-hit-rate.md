# Cache-Hit Rate

Bobbit tracks `cacheReadTokens` and `cacheWriteTokens` on every agent turn. The cache-hit rate is a derived observability metric that makes prompt-cache effectiveness visible without additional data collection or persisted state.

## Formula

```
cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)
```

- `cacheReadTokens` — tokens served from cache at cache-read price.
- `inputTokens` — non-cached input tokens charged at full price.
- `cacheWriteTokens` is excluded because writes are charged at full price and are not cache hits.

The denominator is the total input charged by the provider in any tier. A value of `0.85` means 85% of input tokens were served from cache.

## Null / cold-session semantics

`cacheHitRate` is `null` when the denominator (`cacheReadTokens + inputTokens`) is zero:

- Cold session: no turns have completed yet.
- Provider that does not report cache counters: both counters remain 0.

`null` is never coerced to `0`. The UI renders it as `—` to avoid implying the cache missed when it simply has no signal.

## Server exposure

### WebSocket — `cost_update`

Every `cost_update` broadcast includes `cacheHitRate` in the `cost` payload:

```json
{
  "type": "cost_update",
  "sessionId": "...",
  "cost": {
    "inputTokens": 10000,
    "outputTokens": 1200,
    "cacheReadTokens": 85000,
    "cacheWriteTokens": 5000,
    "totalCost": 0.0034,
    "cacheHitRate": 0.8947
  }
}
```

Older clients that do not recognise the field safely ignore it.

### REST endpoints

All `/cost` and `/cost/breakdown` REST endpoints include `cacheHitRate` on their cost objects:

| Endpoint | Scope |
|---|---|
| `GET /api/sessions/:id/cost` | Single session |
| `GET /api/sessions/:id/cost/breakdown` | Session + delegates |
| `GET /api/goals/:id/cost` | Aggregate across all goal sessions |
| `GET /api/goals/:id/cost/breakdown` | Per-session breakdown |
| `GET /api/tasks/:id/cost` | Session assigned to a task |

For goal/task aggregates, `cacheHitRate` is derived from the summed raw counters across all sessions, not averaged from individual rates.

## UI — CostPopover

The `CostPopover` component shows a **Cache hit** row in the token breakdown section:

- Warm session: rounded percentage, e.g. `89%`
- Cold session, unsupported provider, missing field, or non-finite value: em dash (`—`)

Dashboard cost summaries update from `cost_update` WebSocket events on the same path as the existing token counters. `CostPopover` fetches the latest `/cost/breakdown` payload when opened and renders the cache-hit row from that response; the open popover is not directly live-updated by `cost_update` frames. No new dialog or affordance is added; it is one additional line in the existing breakdown.

## Implementation notes

- `cacheHitRate` is derived on read and never stored on disk. The persisted cost record contains only raw counters (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalCost`).
- Derivation lives in `src/server/agent/cost-tracker.ts`.
- Public cost snapshots add `cacheHitRate: number | null` to the raw counters.
- No protocol version bump is required because clients that ignore unknown fields continue to work.
