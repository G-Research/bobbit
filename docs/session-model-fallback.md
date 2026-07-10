# Controlled session model fallback

Bobbit normally treats model selection as a user contract: if a user, role, workflow, or stored session state names a session model, Bobbit must either bind that exact model or fail visibly. This prevents a stale provider ID, missing API key, or provider outage from silently moving a session to a more expensive, less capable, or unexpected model.

The global `allowSessionModelFallback` preference is the only exception to that rule. It is off by default and is exposed in **Settings → Models**, near the default model rows, as **Allow controlled session-model fallback**.

## Preference

| Key | Type | Default | UI |
|---|---|---|---|
| `allowSessionModelFallback` | `boolean` | `false` when absent | Settings → Models, near model defaults |

The setting is intentionally global because fallback changes the safety contract for every text-session model binding path. It is not a per-session or per-role toggle.

## Behavior when disabled

When `allowSessionModelFallback` is absent or `false`, every explicit session-model failure is a hard failure:

- Bobbit surfaces the model setup error instead of continuing silently.
- The failed selected model is not replaced with another text model.
- Persisted session model state is not overwritten with a fallback.
- Bobbit does not fall through to AI Gateway best-ranked discovery, provider defaults, SDK defaults, pi-coding-agent defaults, or Bobbit hardcoded defaults.

This applies to missing auth, provider outages, stale model IDs, provider rejection, malformed preferences, non-session-selectable models, and read-back mismatches where the agent reports a different model than the one Bobbit requested.

## Behavior when enabled

When `allowSessionModelFallback` is `true`, Bobbit may try exactly one fallback for an explicit non-default session-model failure:

```text
default.sessionModel
```

No other fallback target is permitted. After the selected model fails, Bobbit either binds and verifies `default.sessionModel`, or it fails. It must not continue to AI Gateway best-ranked discovery, provider defaults, SDK defaults, pi-coding-agent defaults, or hardcoded model IDs.

`default.sessionModel` is not fallback-eligible when it is the selected model that failed. In that case Bobbit fails visibly, because falling back from the default to itself or to a discovered/default provider model would violate the controlled policy.

## Invalid fallback targets

Even with fallback enabled, Bobbit rejects the fallback and surfaces both the original and fallback error when `default.sessionModel` is:

- unset or empty;
- malformed, meaning it is not a `"<provider>/<modelId>"` string;
- not session-selectable;
- the same model as the failed selected model;
- unavailable because credentials are missing or invalid;
- rejected by the provider;
- bound unsuccessfully, including read-back mismatch after `setModel` or spawn-time verification.

A failing fallback target is tried at most once. After that Bobbit stops and reports the failure.

## Covered model paths

The controlled policy covers explicit text-session model bindings across the session lifecycle:

- `default.sessionModel` during normal session auto-selection. This is explicit and fails hard; it does not fall back to another model.
- Role model overrides (`role.model`) for ordinary sessions, team agents, staff agents, and verification sub-sessions.
- Review/QA defaults such as `default.reviewModel` when no role model override applies.
- Runtime model switching from the session model picker (`set_model`).
- Spawn-pinned models passed to the agent process at startup through the bridge's initial model option.
- Restored or respawned sessions whose persisted model is re-applied at startup.
- Forked or continued sessions that inherit a model from the source session.

Spawn-pinned and inherited models are treated as explicit because they represent a previous user or caller selection. Bobbit verifies the model reported by the agent before the session becomes idle/live. If verification fails, the same controlled fallback rules apply.

## Runtime model picker reconciliation

The session model picker uses the same explicit-binding contract as startup and role/review overrides. The picker path requests `setModel`, then verifies the agent-reported model with a short bounded read-back retry. This covers agents that apply `setModel` slightly asynchronously while preserving the hard failure for a real read-back mismatch.

After any picker attempt, the displayed model must converge to server-confirmed state:

- On success, the server persists the verified model and broadcasts a `state` frame with the bound model metadata.
- If controlled fallback succeeds, that `state` frame names the verified `default.sessionModel` target, not the originally selected model.
- On failure, the server first broadcasts the actual bound model from `getState()`; if the agent state is unavailable, it falls back to the persisted session model. It then sends `SET_MODEL_FAILED` so the UI can show the error without leaving the optimistic selection stranded.

The browser may render the selected row optimistically while the request is in flight, but durable per-session model storage is updated only from server `state` frames. A `SET_MODEL_FAILED` error also triggers a fresh `get_state` request as a reconciliation fallback. The picker/footer therefore reflect the last server-confirmed model, never a failed optimistic choice.

## Persistence and visibility

Bobbit persists and displays only the model that was actually verified in the running agent:

- If the selected model succeeds, persisted state remains the selected model.
- If controlled fallback succeeds, persisted state and the UI model state are updated to the verified `default.sessionModel` target.
- If fallback is rejected or fails, Bobbit does not persist a replacement model, and the UI is reconciled back to the actual bound model.

Fallback attempts are logged with the failed selected model, the fact that controlled fallback was enabled, and the `default.sessionModel` target. Successful fallback also logs that the session is running on `default.sessionModel` because the selected model failed.

Error text is sanitized before it reaches clients, transcripts, or logs, so provider tokens and API keys are redacted.

## Legitimate non-explicit fallback

AI Gateway best-ranked discovery is still allowed only when there is no explicit session model to honor. For example, a new session with no role model and no `default.sessionModel` may still use AI Gateway discovery as the initial model resolution path.

Once an explicit model has been selected or inherited, failure never falls through to discovery or defaults except for the controlled `default.sessionModel` fallback described above.

## Image generation is separate

`allowSessionModelFallback` applies only to text/session, role, and review model binding. It does not apply to image generation.

Image generation uses the session image-model selector and `default.imageModel`. If an explicit image model is unavailable, image generation fails instead of falling back to `default.sessionModel` or another text model. Add a separate image-specific policy before changing that behavior.

## Implementation references

- Session startup, restore, respawn, fork, continue, and spawn-pinned verification: `src/server/agent/session-manager.ts` and `src/server/agent/session-setup.ts`.
- Shared hard-fail/read-back/fallback binding helper for role and review models: `src/server/agent/review-model-override.ts`.
- Runtime picker binding and failure reconciliation: `src/server/ws/runtime-model-selection.ts` and the `set_model` branch in `src/server/ws/handler.ts`.
- Client reconciliation and confirmed-state persistence: `src/app/remote-agent.ts` and `src/app/session-manager.ts`.
- Settings UI: `src/app/settings-page.ts`.
- Regression coverage: `tests/controlled-model-fallback.test.ts`, `tests/model-error-redaction.test.ts`, and `tests/e2e/ui/settings-model-fallback.spec.ts`.

See also [Per-role model & thinking-level overrides](internals.md#per-role-model--thinking-level-overrides), [Spawn-time model pinning](internals.md#spawn-time-model-pinning), and [Image generation routing](internals.md#image-generation-routing).
