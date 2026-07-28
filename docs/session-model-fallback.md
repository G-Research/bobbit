# Controlled session model fallback

Bobbit normally treats model selection as a user contract: if a user, role, workflow, or stored session state names a session model, Bobbit must either bind that exact model or fail visibly. This prevents a stale provider ID, missing API key, or provider outage from silently moving a session to a more expensive, less capable, or unexpected model.

The global `allowSessionModelFallback` preference provides one narrow exception during session setup. It is off by default and is exposed in **Settings → Models**, near the default model rows, as **Allow controlled session-model fallback**. It does not authorize fallback for an explicit live model-picker request.

## Preference

| Key | Type | Default | UI |
|---|---|---|---|
| `allowSessionModelFallback` | `boolean` | `false` when absent | Settings → Models, near model defaults |

The setting is intentionally global so eligible startup, restore, role, and review setup paths use one policy. It is not a per-session or per-role toggle, and it does not change the exact-selection contract of a running session.

## Behavior when disabled

When `allowSessionModelFallback` is absent or `false`, every explicit session-model failure is a hard failure:

- Bobbit surfaces the model setup error instead of continuing silently.
- The failed selected model is not replaced with another text model.
- Persisted session model state is not overwritten with a fallback.
- Bobbit does not fall through to AI Gateway best-ranked discovery, provider defaults, SDK defaults, pi-coding-agent defaults, or Bobbit hardcoded defaults.

This applies to missing auth, provider outages, stale model IDs, provider rejection, malformed preferences, non-session-selectable models, and read-back mismatches where the agent reports a different model than the one Bobbit requested.

## Controlled fallback during setup

When `allowSessionModelFallback` is `true`, an eligible setup path may try exactly one fallback after an explicit non-default session model fails:

```text
default.sessionModel
```

No other fallback target is permitted. Bobbit must bind and read back the fallback model, apply its normalized effective thinking level, and verify the complete tuple before the setup succeeds. It must not continue to AI Gateway best-ranked discovery, provider defaults, SDK defaults, pi-coding-agent defaults, or hardcoded model IDs.

`default.sessionModel` is not fallback-eligible when it is the selected model that failed. In that case Bobbit fails visibly, because falling back from the default to itself or to a discovered/default provider model would violate the controlled policy.

## Invalid fallback targets

Even with fallback enabled, Bobbit rejects the fallback and surfaces both the original and fallback error when `default.sessionModel` is:

- unset or empty;
- malformed, meaning it is not a `"<provider>/<modelId>"` string;
- not session-selectable;
- the same model as the failed selected model;
- unavailable because credentials are missing or invalid;
- rejected by the provider;
- bound unsuccessfully, including a model or effective-thinking read-back mismatch after `setModel` or spawn-time verification.

A failing fallback target is tried at most once. After that Bobbit stops and reports the failure.

## Eligible setup paths

Controlled fallback applies while Bobbit prepares or restores a session, before the selected tuple is accepted as live:

- `default.sessionModel` during normal session auto-selection. This is explicit and fails hard; it does not fall back to another model.
- Role model overrides (`role.model`) for ordinary sessions, team agents, staff agents, and verification sub-sessions.
- Review/QA defaults such as `default.reviewModel` when no role model override applies.
- Spawn-pinned models passed to the agent process at startup through the bridge's initial model option.
- Restored or respawned sessions whose persisted tuple is re-applied at startup.
- Forked or continued sessions that inherit a tuple from the source session.

Spawn-pinned and inherited models are explicit because they represent a previous user or caller selection. Bobbit verifies the complete model/thinking tuple before the session becomes idle/live. If verification fails, the setup-time controlled fallback rules apply.

Runtime model switching from the picker is deliberately excluded. Once a session is live, `allowSessionModelFallback` does not permit replacing the user's picker request with `default.sessionModel` or any provider-selected alternative.

## Exact live model-picker selection

The picker sends one combined `set_model` request containing `provider`, `modelId`, and the effective `thinkingLevel`. Bobbit clamps thinking against the exact selected model, asks the agent to bind that model, reads back the exact provider/model identity, applies thinking, and then reads back the complete tuple.

The live request succeeds only when the final state exactly matches the requested provider/model and normalized effective thinking level. Only then does the server atomically persist the tuple, update the session's spawn pins and model-name mirror, and broadcast a complete `state` frame. A Pi or provider fallback to an unrequested model is a read-back mismatch, not success—even when `allowSessionModelFallback` is enabled or the bound model equals `default.sessionModel`.

### Failure correction and recovery

Before mutation, the server snapshots the previous durable verified tuple. A failed request never overwrites it.

- If validation fails before mutation, Bobbit broadcasts the complete live tuple, or the complete durable tuple when live read-back is unavailable.
- If mutation began, Bobbit broadcasts a complete correction and makes one bounded rollback attempt to the previous durable model and thinking level. The original bridge remains live only when a final read-back verifies that exact rollback tuple.
- If there is no complete durable tuple, or rollback cannot be verified, Bobbit uses the existing `restartAgent` replacement path. The replacement starts from unchanged durable state and its complete tuple is read back before it is accepted.

Every correction frame carries both model metadata and thinking level so both optimistic picker fields converge together. The server then reports `SET_MODEL_FAILED`; the client requests `get_state` as an additional authoritative refresh. Standalone `set_thinking_level` failures use the same complete-tuple correction and recovery contract.

## Persistence and visibility

Bobbit persists and displays only complete verified tuples:

- During setup, exact selection persists the selected tuple; a successful controlled fallback persists the verified `default.sessionModel` tuple and its effective thinking level.
- During live picker selection, only the exact requested tuple may replace durable state. There is no successful live fallback outcome.
- On live selection failure, the prior durable tuple remains unchanged while complete correction frames reconcile every attached client to verified state.

Setup-time fallback attempts are logged with the failed selected model, the fact that controlled fallback was enabled, and the `default.sessionModel` target. Successful setup fallback also logs that the session is running on `default.sessionModel` because the selected setup model failed.

Error text is sanitized before it reaches clients, transcripts, or logs, so provider tokens and API keys are redacted.

## Legitimate non-explicit fallback

AI Gateway best-ranked discovery is still allowed only when there is no explicit session model to honor. For example, a new session with no role model and no `default.sessionModel` may still use AI Gateway discovery as the initial model resolution path.

Once an explicit model has been selected or inherited, setup failure never falls through to discovery or defaults except for the controlled setup-time `default.sessionModel` fallback described above. An explicit live picker failure never falls back.

## Image generation is separate

`allowSessionModelFallback` applies only to text/session, role, and review model binding. It does not apply to image generation.

Image generation uses the session image-model selector and `default.imageModel`. If an explicit image model is unavailable, image generation fails instead of falling back to `default.sessionModel` or another text model. Add a separate image-specific policy before changing that behavior.

## Implementation references

- Session startup, restore, respawn, fork, continue, and spawn-pinned verification: `src/server/agent/session-manager.ts` and `src/server/agent/session-setup.ts`.
- Shared hard-fail/read-back/fallback binding helper for role and review models: `src/server/agent/review-model-override.ts`.
- Exact live picker binding, rollback, and restart handoff: `src/server/ws/runtime-model-selection.ts` and the `set_model` branch in `src/server/ws/handler.ts`.
- Client optimistic-state correction: `src/app/remote-agent.ts` and `src/app/session-manager.ts`.
- Settings UI: `src/app/settings-page.ts`.
- Regression coverage: `tests2/core/controlled-model-fallback.test.ts`, `tests2/core/model-error-redaction.test.ts`, `tests2/dom/client-combined-model-thinking-selection.test.ts`, and `tests/e2e/ui/settings-model-fallback.spec.ts`.

See also [Per-role model & thinking-level overrides](internals.md#per-role-model--thinking-level-overrides), [Spawn-time model pinning](internals.md#spawn-time-model-pinning), and [Image generation routing](internals.md#image-generation-routing).
