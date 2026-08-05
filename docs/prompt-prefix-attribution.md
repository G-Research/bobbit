# Prompt-prefix attribution

Prompt-prefix attribution explains whether one of Bobbit's cache-relevant prompt inputs changed between requests. It is a local diagnostic: it identifies a changed Bobbit-owned component, but does not observe the final provider request or prove a provider cache hit or miss.

Open **System Prompt Inspector** for a session to see the latest result. The status is deliberately separate from the raw prompt-section inspector so operators can diagnose stability without exposing prompt content through this diagnostic.

For the implementation decision and source investigation, see [Prompt-prefix attribution design](design/prompt-prefix-attribution.md) and [Prompt-prefix instability evidence](design/prompt-prefix-instability-evidence.md).

## What is fingerprinted

Bobbit creates SHA-256 fingerprints for these four components at dispatch time:

| Component | Meaning | Interpretation when changed |
|---|---|---|
| **System prompt** | The ordered assembled prompt sections other than Tools, Available Skills, and Dynamic Context. | A Bobbit-owned prompt section, its text, or its position changed. |
| **Tools** | The activated tool names and rendered tool documentation used by the assembled prompt. | Tool selection or its effective prompt-facing definition changed. |
| **Dynamic context** | Session-setup context plus the accepted, budgeted per-turn provider blocks. | The current request received different ambient context. This is often expected. |
| **Skills** | The rendered available-skills catalog. | Skill discovery, activation, description, or catalog budget changed. |

Inputs are canonicalized before hashing: object keys are recursively sorted, while array order remains meaningful. A component's byte count is the UTF-8 size of its canonical hash input, not a token count.

The component set is intentionally limited to inputs Bobbit owns. It does not fingerprint provider-side serialization, unexposed Pi internals, conversation history, or provider cache state.

### Tool and MCP stability

Tool and MCP discovery/registration is deterministically ordered before Bobbit renders or registers it. This fixes an earlier source of restart/spawn variation caused by filesystem or discovery iteration order. A genuine change to the effective tool input can still produce **Prefix changed: Tools**; the fix removes incidental discovery-order churn rather than hiding meaningful changes.

## Reading the result

The inspector compares a request with the immediately preceding recorded request. The same states are returned by the API.

| State | Meaning | Operator action |
|---|---|---|
| **Prefix baseline: first request** | No prior recorded request exists. | Send another comparable request before judging stability. |
| **Stable prefix** | All four local component fingerprints and the comparison context match. | The Bobbit-owned inputs were stable. This is not proof of a provider cache hit. |
| **Prefix changed: _component_** | Exactly one fingerprint changed. | Inspect the named component first. |
| **Prefix changed: multiple components** | More than one of the four fingerprints changed. | Treat this as a combined configuration/context change; do not assume one cause. |
| **Prefix changed: unattributable** | The aggregate fingerprint changed but none of the named component fingerprints did. | Preserve the row and investigate; Bobbit intentionally does not guess a culprit. |
| **Prefix baseline changed at model switch** | Provider or model identity changed. | Treat the next request as a new cache domain, not as a component regression. |
| **Prefix baseline changed after compaction** | A successful compaction changed the conversation boundary. | Start a new comparison baseline; do not blame a named component. |

A model switch takes precedence if it and a compaction occur between the same two records. Failed or aborted compaction does not advance the compaction boundary.

### Dynamic context is normally volatile

Per-turn dynamic context is delivered on the user-side tail, not by changing the system-prompt bytes. Consequently, a provider returning different context blocks normally produces **Dynamic context** while **System prompt** remains stable. A provider timeout, error, or block being removed by budget selection can also change this component because the request receives a different block set.

This is diagnostic information, not a cache verdict. Use the session's [context trace](lifecycle-hub.md#the-trace-store) to correlate the same turn with provider timing, block counts, omissions, and errors. The trace likewise omits block content.

## Provider cache telemetry

The status row always displays `Provider cache: hit`, `miss`, or `unknown`.

`unknown` is the safe default. Missing, malformed, ambiguous, or zero-valued cache counters are **unknown**, never `miss`. Bobbit reports `hit` or `miss` only when a provider supplies an unambiguous per-request signal. Local fingerprint stability never changes that value or substitutes for provider telemetry.

The cumulative cache-hit-rate metric answers a different question and follows the same no-signal principle; see [Cache-hit rate](cache-hit-rate.md).

## Privacy, persistence, and resilience

Attribution is hash-only diagnostics. Durable rows and API responses contain only metadata such as schema version, timestamp, session and sequence identifiers, model identity, compaction epoch, comparison result, full SHA-256 digests, UTF-8 byte counts, and telemetry state. They never contain prompt sections, tool descriptions or schemas, user text, skill descriptions, dynamic block content, or provider responses.

The existing System Prompt Inspector's section view is a separate raw-content inspection feature. Its persistence and copy behavior do not apply to attribution; the attribution details disclosure exposes only shortened digest display and metadata.

Rows live in a sibling JSONL file under the session context-trace state directory. They are retained across gateway restart and capped using the trace store's bounded, newest-record retention. On restart or respawn, Bobbit rebuilds the seed and compares the next same-model, same-compaction-epoch request with the persisted prior row. A genuine reconstructed difference therefore remains visible as its named component rather than being silently reset.

Attribution must never interrupt an agent request. Storage, canonicalization, and finalization failures disable or skip the diagnostic for that live session/turn while normal prompt dispatch and dynamic-context delivery continue. Corrupt, partial, legacy, or invalid persisted rows are ignored on read, so usable records remain available.

## API

`GET /api/sessions/:id/prompt-prefix-attribution?limit=N` returns hash-only records:

```json
{
  "entries": [
    {
      "schemaVersion": 1,
      "ts": 1735689600000,
      "sessionId": "session-id",
      "sequence": 4,
      "boundary": "before-prompt",
      "model": { "provider": "example", "id": "model-id" },
      "compactionEpoch": 0,
      "components": [
        { "kind": "system", "sha256": "…64 lowercase hex characters…", "bytes": 1234 },
        { "kind": "tools", "sha256": "…", "bytes": 456 },
        { "kind": "dynamic-context", "sha256": "…", "bytes": 78 },
        { "kind": "skills", "sha256": "…", "bytes": 90 }
      ],
      "aggregateSha256": "…",
      "providerCacheTelemetry": "unknown",
      "comparison": "changed",
      "culprit": "dynamic-context",
      "changed": ["dynamic-context"],
      "comparableTo": 3
    }
  ]
}
```

Entries are ordered oldest to newest. `limit` keeps the most recent requested records and is capped at 1000. `model`, `boundaryReason`, `culprit`, `changed`, and `comparableTo` are optional when they do not apply. `boundary` is `dispatch` when the dispatch fallback was stored, or `before-prompt` after the lifecycle hook finalized the current dynamic context. `comparison` is `first`, `stable`, `changed`, or `boundary`; `boundaryReason` is `model-switch` or `compaction` for an explicit boundary.

The endpoint uses the gateway's normal authentication rules. It intentionally returns no prompt text, even when the raw prompt-section endpoint is available.

## Troubleshooting

1. **No attribution card or no entries:** send a request after session setup. Attribution is optional diagnostics; a failed best-effort capture does not fail the session. Check gateway logs for a prompt-prefix attribution warning.
2. **First request forever:** verify that a request reaches normal dispatch and that diagnostics can append to the context-trace state directory. A restart preserves valid prior rows, so one new request should normally compare against them.
3. **Unexpected Tools change after restart:** verify effective tool configuration and MCP availability. Ordering is stabilized, so repeated discovery order alone should not explain the change; compare tool activation/configuration changes next.
4. **Unexpected System prompt or Skills change:** compare project, role, pack, skill, and prompt-section configuration. Do not attribute it to per-turn provider context unless Dynamic context also changed.
5. **Dynamic context changes every turn:** this can be expected for a provider that returns turn-specific blocks. Review the context trace for block counts, omissions, timeouts, or provider errors.
6. **Provider cache remains unknown:** this means Bobbit lacks an unambiguous per-request provider signal. Do not convert it to a miss or infer a hit from stable fingerprints.
7. **Unattributable result:** retain the sequence, component digests, model, and compaction epoch for investigation. The result is intentionally a signal to inspect the boundary rather than a guessed explanation.

If all four fingerprints remain stable and independent provider telemetry still demonstrates cache misses, capture that evidence before considering a request-shaping change. Bobbit does not add such a hook based on local heuristics alone.
