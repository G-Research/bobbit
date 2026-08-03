# Prompt-Cache Posture and Stall Diagnostics

Prompt caching can fail silently: provider requests still succeed while large stable prompts are charged as fresh input. Cache posture makes the small set of cache paths Bobbit can prove visible, and a stall diagnostic calls attention to sustained zero cache reads without changing an agent turn or provider request.

This is an observability feature. It does not determine whether a particular request should have hit a cache.

## Proven capability scope

Bobbit creates a cache posture only when the resolved, session-selectable catalog entry proves all of the following:

- provider is `anthropic`;
- API is the direct `anthropic-messages` API;
- the model accepts text input; and
- the selected provider/model tuple was verified against the current catalog.

The posture records the sanitized provider, model, API, expected caching state (`provider-managed`), and TTL (`unknown`). `unknown` is intentional: the model family alone does not prove an active cache configuration or a cache lifetime.

The classifier fails closed. It creates no posture and no stall warning for unknown or mismatched models, non-session-selectable entries, image models, internal one-shot completions, gateways and compatibility APIs, or providers/APIs whose cache telemetry support has not been proven. In particular, a Claude-like model name, pricing metadata, or inferred model metadata is not evidence of support.

## Posture lifecycle

A qualifying model selection emits a concise `cache_posture` session event. It is also retained as sanitized session state and replayed when a client attaches, so reconnecting does not hide the current cache context.

Usage is evaluated relative to a baseline captured when the current capable model posture begins. This prevents token totals from a prior unproven model or earlier capable model selection from being attributed to the current model. Selecting a different qualifying model establishes a new baseline; reselecting the same qualifying model keeps its baseline and health state.

A positive cache-read delta marks the current posture healthy. That recovery is shown to session status consumers, but it does not erase a prior stall record: historical evidence remains available for audit and attach replay.

## Stall condition

At the canonical cumulative usage-recording boundary, Bobbit emits a `cache_stall` diagnostic only when all conditions are true for the current capable-model baseline:

1. fresh `inputTokens` are at least **50,000**;
2. `cacheReadTokens` are exactly zero; and
3. the session has not already recorded a stall.

The threshold is inclusive: 49,999 fresh input tokens does not warn, and 50,000 does. It deliberately allows cold first turns and prompts below provider cache minima to complete without a diagnostic.

`cacheWriteTokens` do not count as a cache hit. Writes may show that the provider accepted cacheable material, but only a reported cache read proves reuse. This matches the cache-hit-rate formula:

```
cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)
```

The warning contains only sanitized operational fields: provider, model, API, expected caching state, TTL, timestamp, and cumulative baseline-relative input/cache-read/cache-write counts. It never includes prompt text, request payloads, credentials, credential-bearing gateway URLs, or raw provider responses.

## Durable once-only history

The first qualifying warning is durably latched for the whole session before it is emitted. Further usage updates do not generate more warnings, and the latch survives gateway restart, reattach, and model switches—including a switch to an unproven model. On attachment, Bobbit may replay the retained historical diagnostic so an operator can still see it; this is not a new warning.

A later positive cache read makes the current capable posture healthy, while retaining the original warning and its original model-specific evidence. This avoids both repeated noise and the loss of evidence after a transient recovery.

## Operator response

When a stall diagnostic appears:

1. Confirm that the session's posture names the intended model and `anthropic-messages` API. If there is no posture, the path is intentionally outside the proven scope and this detector makes no claim.
2. Inspect the session's cost/cache telemetry for cumulative `cacheReadTokens`, `cacheWriteTokens`, and `cacheHitRate`. A later positive read indicates recovery for the current model posture.
3. Check the provider-side cache configuration and request telemetry for the direct Anthropic Messages request path. Use the model-specific baseline counts in the diagnostic when correlating events.
4. Treat TTL as unknown unless provider evidence for the exact request path establishes it. Do not infer a TTL or enabled caching from a Claude-family name.

The diagnostic is a warning-only system notice: it does not fail a turn, pause a session, alter cost accounting, or retry a provider request.

## Deliberately deferred

This slice only detects and exposes cache posture/stalls. It does not inject cache points, wrap or alter provider payloads, change provider allowlists, set a default `PI_CACHE_RETENTION`, assert a TTL, modify Pi dependencies, or automatically enforce/pause a session. Cache-point injection, TTL policy, and enforcement are follow-up work.

## Related documentation

- [Cache-Hit Rate](cache-hit-rate.md) explains the underlying counters and derived metric.
- [Debugging Guide](debugging.md#prompt-cache-stall-warning) provides the operational triage checklist.
