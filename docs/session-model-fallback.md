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
- Restored or respawned sessions whose persisted tuple is re-applied at startup, except for the cold-restore condition below.
- Forked or continued sessions that inherit a tuple from the source session.

Before cold restore, Bobbit checks a complete persisted tuple against the current session-selectable catalog. If a completed catalog authoritatively omits it, the session enters `MODEL_SELECTION_REQUIRED` without starting Pi or attempting controlled fallback, regardless of `allowSessionModelFallback`. The durable tuple stays unchanged until an exact currently selectable replacement is verified. Catalog assembly or discovery errors are not authoritative omissions; exact AIGW rows from an eligible matching marked publication, or from the current process's same-URL discovery snapshot when the target cannot supply them, remain eligible for ordinary restore. The in-memory snapshot does not survive restart, never bypasses an unmarked target, and is unavailable for malformed target configuration. See [Saved sessions after authoritative model removal](ai-gateway-routing.md#saved-sessions-after-authoritative-model-removal) and [Restored session requires a model](debugging.md#restored-session-requires-a-model).

Spawn-pinned and inherited models are explicit because they represent a previous user or caller selection. Bobbit verifies the complete model/thinking tuple before the session becomes idle/live. For ordinary setup outside that recovery condition, a verification failure follows the setup-time controlled fallback rules.

Runtime model switching from the picker is deliberately excluded. Once a session is live, `allowSessionModelFallback` does not permit replacing the user's picker request with `default.sessionModel` or any provider-selected alternative.

## Exact live model-picker selection

The picker sends one combined `set_model` request containing `provider`, `modelId`, and the effective `thinkingLevel`. Bobbit clamps thinking against the exact selected model, asks the agent to bind that model, reads back the exact provider/model identity, applies thinking, and then reads back the complete tuple.

The live request succeeds only when the final state exactly matches the requested provider/model and normalized effective thinking level. Only then does the server atomically persist the tuple, update the session's spawn pins and model-name mirror, and broadcast a complete `state` frame. A Pi or provider fallback to an unrequested model is a read-back mismatch, not success—even when `allowSessionModelFallback` is enabled or the bound model equals `default.sessionModel`.

### Failure correction and bounded recovery

Before mutation, the server snapshots the previous durable verified tuple and the exact RPC bridge that will receive the request. A failed request never overwrites the durable tuple.

- If validation fails before mutation, Bobbit broadcasts the complete live tuple, or the complete durable tuple when live read-back is unavailable.
- If mutation began, Bobbit broadcasts a complete correction and makes one bounded rollback attempt on that same bridge. The bridge remains live only when a final read-back verifies the previous durable model and thinking level exactly.
- If there is no complete durable tuple, or rollback cannot be verified, Bobbit uses the existing `restartAgent` replacement path. The replacement starts from unchanged durability and is accepted only after a complete read-back; when a durable tuple exists, the replacement must match it exactly.

Every correction frame carries both model metadata and thinking level so both optimistic picker fields converge together. For a non-terminal failure, the server then reports `SET_MODEL_FAILED`; the client requests `get_state` as an additional authoritative refresh. Standalone `set_thinking_level` failures use the same complete-tuple correction and recovery contract, with `SET_THINKING_LEVEL_FAILED` as their error code.

#### Fail-closed quarantine

If restart or replacement fails, is unreachable, returns incomplete state, or cannot verify the unchanged durable tuple, Bobbit cannot safely leave the partially mutated runtime available. It synchronously uses existing `SessionManager` lifecycle behavior rather than adding a recovery subsystem:

1. If the session is live, `terminateSession` stops its bridge, detaches it from the live-session map, archives the existing record, and closes attached clients through the normal archived-session path.
2. If no live session can be terminated, `storeArchive` archives the dormant durable record.

This terminal path is called *quarantine* because it makes an unverifiable runtime unavailable; it is not a new session status or lifecycle mode. The previous durable tuple remains unchanged, and neither the requested partial tuple nor an unrequested fallback becomes durable. The archived session cannot accept more prompts. The sanitized failure directs the user to create a fresh session; if termination and archival both fail, the reported error includes that quarantine failure and still never reports the selection as successful.

#### Stale-target protection

A role assignment, respawn, or another replacement can install a new canonical bridge while an older model RPC is still settling. Recovery therefore binds every mutation and rollback RPC to the bridge captured at request start and checks canonical ownership before mutation, after model binding, before commit, before rollback, and again before any session-ID restart.

If ownership moved to a newer bridge, the stale request must not roll back, restart, terminate, or archive by session ID: those operations would target the replacement rather than the bridge that was partially mutated. Bobbit instead stops only the superseded captured bridge, reloads the latest durable tuple, and verifies the newer canonical bridge against it. A verified replacement is retained and broadcast as authoritative state; the stale request still fails.

If the superseded bridge cannot be stopped or the newer bridge cannot be verified, Bobbit reports a sanitized stale-recovery failure and retains the newer canonical session rather than quarantining it by stale session ID. The client reconciles after reconnecting and may retry the selection. This protects a concurrently committed tuple from being overwritten by an older durable snapshot.

## Persistence and visibility

Bobbit persists and displays only complete verified tuples:

- During setup, exact selection persists the selected tuple; a successful controlled fallback persists the verified `default.sessionModel` tuple and its effective thinking level.
- A `MODEL_SELECTION_REQUIRED` capsule keeps the unavailable persisted tuple visible and unchanged. Its exact replacement becomes durable only after startup, transcript rehydration, thinking clamp, and model read-back succeed; failure preserves the capsule and old tuple.
- During ordinary live picker selection, only the exact requested tuple may replace durable state. There is no successful live fallback outcome.
- On ordinary live selection failure, the prior durable tuple remains unchanged while complete correction frames reconcile attached clients to verified state. If recovery cannot establish a safe live runtime, normal termination/archive events replace further state reconciliation.

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
- Exact live picker binding, bridge-identity fencing, rollback, restart handoff, and fail-closed quarantine: `src/server/ws/runtime-model-selection.ts` and the model-selection branches in `src/server/ws/handler.ts`.
- Client optimistic-state correction: `src/app/remote-agent.ts` and `src/app/session-manager.ts`.
- Settings UI: `src/app/settings-page.ts`.
- Regression coverage: `tests/unit/core/controlled-model-fallback.unit.test.ts` and the focused runtime-zombie recovery and replacement-race unit cases, the combined-selection DOM test, and `tests/browser/journeys/ui/settings-model-fallback.journey.spec.ts`.

See also [Per-role model & thinking-level overrides](internals.md#per-role-model--thinking-level-overrides), [Spawn-time model pinning](internals.md#spawn-time-model-pinning), and [Image generation routing](internals.md#image-generation-routing).
