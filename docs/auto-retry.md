# Auto-Retry

## Purpose

Bobbit auto-retries agent turns when the last turn ended with a retryable infrastructure or agent-runtime error. The retry uses the same `retryLastPrompt(sessionId, { auto: true })` path as the chat **Retry** button so continuation safety stays centralized: if a failed turn already ran tools, Retry resumes rather than blindly replaying side effects.

Auto-retry is intentionally conservative. It keeps transient provider and runtime failures moving, but stops when the error looks deterministic and needs a human fix.

## Retry policies

| Error class | Classifier | Schedule | Stop condition |
|-------------|------------|----------|----------------|
| Provider overload / rate-limit | `isProviderBackoffError()` | Exponential from 1 s, capped at 5 min, ±20% jitter | No hard attempt cap; stops on success, termination, new prompt, or explicit Retry |
| JSON/network transient | `isTransientReviewError()` and not provider backoff | 1 s, 2 s, 4 s | After 3 failed auto attempts, leave manual Retry available |
| Generic unexpected/internal/system agent error | `isRetryableGenericAgentError()` and not transient | 1 s, 5 s, 60 s | After 3 failed auto attempts, leave manual Retry available |

The bounded policies exist to recover from short-lived failures without looping forever on a broken model, invalid request, or bad configuration. Provider overload stays effectively unbounded because real provider incidents can last longer than a short retry burst; the long capped backoff prevents tight retry loops while still recovering without user action.

## Classification

Core retry classification lives in `src/server/agent/verification-logic.ts`:

- `isProviderBackoffError(output)` matches provider overload/rate-limit signals such as `overloaded_error`, `rate_limit_error`, `HTTP 429`, and `HTTP 529`.
- `isTransientReviewError(output)` matches retryable transient glitches such as malformed streamed tool JSON, `ECONNRESET`, `EPIPE`, `socket hang up`, process exits, and `Validation failed for tool`.
- `isRetryableGenericAgentError(output)` matches sanitized runtime failures such as `The system encountered an unexpected error`, `unexpected internal error`, and `system server error`.

Generic auto-retry excludes errors that are likely deterministic or operator-actionable before applying the retryable match. Exclusions include:

- authentication or authorization failures
- missing, invalid, expired, or unconfigured API keys/tokens/credentials
- configuration errors
- permission denials
- user/human aborts or cancellations
- content/safety-policy blocks
- validation, bad-request, or schema-validation failures

This ordering matters: a wrapper like `The system encountered an unexpected error: missing API key` must not retry just because it contains the generic unexpected-error text.

## Scheduling lifecycle

`SessionManager.maybeAutoRetryTransient(session)` runs after a turn ends with `message_end.stopReason === "error"`.

When a policy applies, it:

1. increments `session.transientRetryAttempts`;
2. computes the policy delay;
3. emits `auto_retry_pending` through the session event stream;
4. sets `session.pendingAutoRetryTimer`;
5. when the timer fires, calls `retryLastPrompt(session.id, { auto: true })` if the session is still the current idle session.

A pending timer is cancelled when the user sends a new prompt, clicks explicit Retry, terminates the session, or the gateway shuts down. Cancellation emits `auto_retry_cancelled` except during shutdown.

`retryLastPrompt(..., { auto: true })` preserves `transientRetryAttempts` so repeated auto failures advance the schedule. Explicit user Retry resets the counter, because human intervention is treated as a fresh recovery attempt.

## UI events

The server emits `auto_retry_pending` while a retry timer is waiting:

```json
{
  "type": "auto_retry_pending",
  "reason": "provider-overload" | "transient-error",
  "retryDelayMs": 5000,
  "attempt": 2,
  "scheduledAt": 1715800000000,
  "error": "The system encountered an unexpected error."
}
```

Generic unexpected errors use `reason: "transient-error"` on the wire; the policy distinction is server-side. The client stores the event in `state.autoRetryPending` and renders the retry banner while the session remains `idle`.

`lastTurnErrored` remains true while auto-retry is pending, so the normal manual Retry affordance is still available. If the bounded retry budget is exhausted, no new pending event is emitted and the user must click Retry after fixing or accepting the failure.

## Team-lead auto-nudge interaction

Team leads rely on automatic nudges to resume work after child-agent or gate activity. `TeamManager` uses `nudgePending` to avoid flooding a lead with duplicate prompts, but that guard must only stay set when a lead turn actually starts.

Auto-nudge delivery now clears or avoids sticky `nudgePending` when delivery does not start a turn, including:

- `enqueuePrompt()` throws synchronously;
- the async delivery rejects;
- the prompt parks behind an errored/capped session;
- delivery resolves as queued while the team lead remains idle.

`agent_start` still clears `nudgePending` for the normal success path. This prevents an errored retry or parked nudge from permanently suppressing later team-lead nudges.

## Tests

Relevant unit coverage runs under `npm run test:unit`:

- `tests/backoff-delay.test.ts` pins `nextBackoffDelay()` math, cap handling, and jitter bounds.
- `tests/auto-retry-policy.test.ts` covers provider overload, JSON/network transient retries, generic unexpected retries at 1 s / 5 s / 60 s, retry exhaustion, non-retryable generic-looking exclusions, and dispatch through the existing auto Retry path.
- `tests/queue-dispatch.spec.ts` covers retry-counter preservation/reset and pending timer cancellation around prompt dispatch.
- `tests/team-manager-idle-nudge-backoff.test.ts` covers `nudgePending` clearing when a team-lead auto-nudge parks instead of starting a turn.
