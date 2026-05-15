# Cache-Hit Metric

The cache-hit rate is a derived observability metric that surfaces how effectively Anthropic's prompt cache is serving a session's input tokens.

## Formula

```
cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)
```

- `cacheReadTokens` — tokens served from cache at cache-read price.
- `inputTokens` — non-cached input tokens charged at full price.
- `cacheWriteTokens` is **excluded** — cache writes are charged at full price and are not hits.

The denominator is the total input charged by the provider in any tier. A value of `0.85` means 85% of input tokens were served from cache.

## Null / cold-session semantics

`cacheHitRate` is `null` when the denominator (`cacheReadTokens + inputTokens`) is zero — i.e.:

- Cold session: no turns have completed yet.
- Provider that does not report cache counters: both counters remain 0.

`null` is never coerced to `0` — the UI renders it as `—` to avoid implying the cache is missing when it simply hasn't been exercised.

## Implementation notes

- `cacheHitRate` is **derived on read**, never stored on disk. The persisted cost record (`session-costs.json`) contains only the five raw counters (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalCost`).
- Derivation lives in `deriveCacheHitRate()` and `withDerivedFields()` in `src/server/agent/cost-tracker.ts`.
- `SessionCost` (the public snapshot type) extends `RawSessionCost` with the `cacheHitRate: number | null` field.
- Goal-level cost aggregates `cacheHitRate` from the combined raw counters across all linked sessions, not by averaging per-session rates.

## Where it appears

| Surface | Value when null | Value when set |
|---|---|---|
| `CostPopover` "Cache hit" row | `—` | `XX%` (e.g. `85%`) |
| `cost_update` WebSocket event | `null` | `0`–`1` float |
| `GET /api/sessions/:id/cost` | `null` | `0`–`1` float |
| `GET /api/goals/:id/cost` | `null` | `0`–`1` float |
| `GET /api/tasks/:id/cost` | `null` | `0`–`1` float |

## Backwards compatibility

Clients that do not recognise `cacheHitRate` silently ignore it. Clients that receive `null` render `—` by convention. Neither behaviour requires a protocol version bump.
