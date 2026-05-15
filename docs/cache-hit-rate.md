# Cache-Hit Rate

Bobbit tracks `cacheReadTokens` and `cacheWriteTokens` on every agent turn. The cache-hit rate is a derived metric that makes cache effectiveness visible without any additional data collection.

## Formula

```
cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)
```

`cacheWriteTokens` is excluded — writes are charged at full price and are not cache hits. The denominator is the total input the provider charged for, across both tiers. A rate of `0.85` means 85% of input tokens were served from cache at the cheaper cache-read price.

**Null semantics:** when both `cacheReadTokens` and `inputTokens` are zero (cold session, or a provider that does not report cache counters), the rate is `null`. The UI renders `null` as an em dash (—) rather than `0%`, so an absent cache signal is never confused with a confirmed miss.

The rate is never stored on disk. `CostTracker.getSnapshot()` and related helpers derive it at read time from the raw counters, which are persisted.

## Server exposure

### WebSocket — `cost_update`

Every `cost_update` broadcast includes `cacheHitRate` in the `cost` payload:

```json
{
  "type": "cost_update",
  "sessionId": "...",
  "cost": {
    "inputTokens": 10000,
    "cacheReadTokens": 85000,
    "cacheWriteTokens": 5000,
    "outputTokens": 1200,
    "totalCost": 0.0034,
    "cacheHitRate": 0.8947
  }
}
```

Older clients that don't know the field safely ignore it.

### REST endpoints

All `/cost` and `/cost/breakdown` REST endpoints include `cacheHitRate` on the aggregate object:

| Endpoint | Scope |
|---|---|
| `GET /api/sessions/:id/cost` | Single session |
| `GET /api/sessions/:id/cost/breakdown` | Session + delegates |
| `GET /api/goals/:id/cost` | Aggregate across all goal sessions |
| `GET /api/goals/:id/cost/breakdown` | Per-session breakdown |
| `GET /api/tasks/:id/cost` | Session assigned to a task |

For goal/task aggregates, `cacheHitRate` is derived from the summed raw counters across all sessions — not averaged from individual rates.

## UI — CostPopover

The `CostPopover` component shows a **Cache hit** row in the token breakdown section:

- **Warm session:** rounded percentage, e.g. `89%`
- **Cold session or unsupported provider:** em dash (`—`)

The value updates live from `cost_update` WebSocket events on the same path as the existing token counters. No new dialog or affordance — it is one additional line in the existing breakdown.

`formatCacheHitRate()` in `CostPopover.ts` handles the null/missing/non-finite cases and always returns `—` for any of them, ensuring backwards compatibility with older server versions that do not send the field.
