# Auto-Retry: Provider Overload and Transient Errors

## Background

When the Anthropic API (or another provider) returns a transient error mid-turn
— such as `overloaded_error` (HTTP 529) or `rate_limit_error` (HTTP 429) — the
session used to stall silently and require the user to click **Retry** manually.
During peak load these events can last 10+ minutes; surfacing the error to the
user is worse than waiting.

The auto-retry system automatically reschedules the turn with an exponential
backoff, keeps the UI informed, and cancels gracefully whenever the user or
session intervenes.

---

## Two retry policies

### 1. Provider overload / rate-limit (unbounded)

Detected by `isProviderBackoffError()` in `verification-logic.ts`.

Triggers on:
- `overloaded_error` — Anthropic HTTP 529
- `rate_limit_error` — Anthropic HTTP 429
- Phrasings matching `HTTP 429`, `HTTP 529`, `status 429`, `statusCode: 529`,
  etc. (via `PROVIDER_BACKOFF_REGEXES`)

Behaviour:
- **No hard attempt cap.** Provider outages legitimately last 10+ minutes.
- **Exponential backoff** starting at 1 s, doubling each attempt, capped at
  **300 000 ms (5 minutes)** per attempt.
- **±20% jitter** applied after the cap so multiple concurrent team-lead
  sessions don't hammer the API at exactly the same moment.
- `transientRetryAttempts` is **preserved** across auto-retries so the delay
  keeps growing toward the cap. It is **not** reset until the session succeeds,
  is terminated, or the user explicitly clicks Retry.

Backoff sequence (no jitter, `random() = 0.5`):

| Attempt | Delay  |
|---------|--------|
| 1       | 1 s    |
| 2       | 2 s    |
| 3       | 4 s    |
| 4       | 8 s    |
| 5       | 16 s   |
| …       | …      |
| 10+     | 300 s (cap) |

### 2. Other transient errors (bounded, 3 attempts)

Detected by `isTransientReviewError()` but **not** `isProviderBackoffError()`.

Triggers on: malformed tool-call JSON (`SyntaxError … in JSON at position N`),
`ECONNRESET`, `EPIPE`, `socket hang up`, `process exited`, `Validation failed
for tool`, etc. (via `TRANSIENT_ERROR_PATTERNS` and `TRANSIENT_ERROR_REGEXES`).

Behaviour:
- Maximum **3 attempts** at fixed 1 s / 2 s / 4 s delays (legacy schedule,
  preserved for compatibility).
- After the third failure the error is surfaced to the user and the manual
  Retry button is required.

---

## Key functions

| Symbol | Location | Responsibility |
|--------|----------|----------------|
| `isTransientReviewError(output)` | `verification-logic.ts` | Returns true for both policy classes. |
| `isProviderBackoffError(output)` | `verification-logic.ts` | Narrows to the unbounded backoff class. |
| `TRANSIENT_ERROR_PATTERNS` | `verification-logic.ts` | Literal substring list (includes `overloaded_error`, `rate_limit_error`). |
| `PROVIDER_BACKOFF_REGEXES` | `verification-logic.ts` | Regex list for HTTP 429/529 status phrasings. |
| `TRANSIENT_ERROR_REGEXES` | `verification-logic.ts` | Regex list for JSON-glitch / Node `SyntaxError` variants. |
| `nextBackoffDelay(attempt, opts)` | `session-setup.ts` | Pure function: `baseMs * 2^(attempt-1)`, capped, then ±`jitterRatio` jitter. |
| `maybeAutoRetryTransient(session)` | `session-manager.ts` | Selects policy, computes delay, broadcasts `auto_retry_pending`, sets `pendingAutoRetryTimer`. |
| `cancelPendingAutoRetry(session, reason)` | `session-manager.ts` | Tears down the timer and broadcasts `auto_retry_cancelled`. |
| `retryLastPrompt(id, {auto})` | `session-manager.ts` | Performs the actual retry; `auto: true` preserves `transientRetryAttempts`. |

All detection logic is pure (no I/O) and lives in `verification-logic.ts`.
All scheduling / timer logic lives in `session-manager.ts`.

---

## `transientRetryAttempts` and the explicit vs. auto distinction

`retryLastPrompt` accepts `{ auto: boolean }`:

- **`auto: false`** (user clicked Retry): resets `transientRetryAttempts` to 0
  and calls `cancelPendingAutoRetry(…, "explicit-retry")`. The next failure
  starts fresh at the 1 s base delay.
- **`auto: true`** (timer fired): does **not** touch `transientRetryAttempts`.
  If the retry itself ends in another overload, `maybeAutoRetryTransient` will
  find the counter already incremented and schedule a longer delay.

This is intentional: human intervention gets a fresh budget; the auto path must
grow toward the 5-minute cap or the backoff serves no purpose.

---

## Timer lifecycle — when pending retries are cancelled

A pending auto-retry timer is cleared (and `auto_retry_cancelled` broadcast)
in all of these situations:

| Trigger | Reason string |
|---------|---------------|
| User sends a new prompt | `"new-prompt"` |
| User clicks the Retry button (explicit retry) | `"explicit-retry"` |
| Session is terminated | `"terminated"` |
| Gateway shuts down (all sessions) | `"shutdown"` |

The `"shutdown"` case does not broadcast to clients (WebSocket is already torn
down).

---

## UI: auto-retry banner

When a retry is scheduled the server broadcasts a WebSocket event:

```json
{
  "type": "event",
  "data": {
    "type": "auto_retry_pending",
    "reason": "provider-overload" | "transient-error",
    "retryDelayMs": 4000,
    "attempt": 3,
    "scheduledAt": 1715800000000,
    "error": "<first 200 chars of error message>"
  }
}
```

The client stores this in `state.autoRetryPending`. `AgentInterface` renders a
banner below the composer:

> ↻ *Retrying in ~4s due to provider overload…* (attempt #3)

When the retry fires, or the user intervenes, the server broadcasts
`auto_retry_cancelled` and the banner disappears. The session status remains
`"idle"` throughout — the banner is the only visible indicator of the pending
wait.

---

## Testing

Three unit test files cover this feature, all runnable via `npm run test:unit`:

**`tests/backoff-delay.test.ts`** — pins `nextBackoffDelay` in isolation:
- Correct doubling sequence (1 s, 2 s, 4 s, …)
- Cap enforcement at `maxMs` before and after jitter
- Jitter bounds (±20% across a sweep of deterministic `random()` values)
- Finite, non-negative output even for very large attempt counts (no `Infinity`/`NaN`)

**`tests/auto-retry-policy.test.ts`** — pins the end-to-end policy decision
tree (`decideRetryPolicy` mirrors `maybeAutoRetryTransient`'s logic using the
same exported building blocks):
- Overload / rate-limit errors retry indefinitely past the 3-attempt bounded cap
- HTTP 429/529 status phrasings are classified as provider-backoff
- Non-provider transient errors stop after attempt 3
- Non-transient errors produce no retry

**`tests/queue-dispatch.spec.ts`** — integration-level pins on
`SessionManager`-style simulation:
- Explicit `retryLastPrompt` clears `pendingAutoRetryTimer`
- Explicit retry resets `transientRetryAttempts`; auto retry preserves it
- Provider-overload error retries past the 3-attempt non-provider cap

---

## E2E harness: canonical path helper

The E2E test harnesses (`gateway-harness`, `in-process-harness`) were updated
alongside this feature to fix a macOS path-canonicalization issue unrelated to
retry logic but discovered during the same work.

On macOS, `os.tmpdir()` returns `/var/folders/…` which is a symlink to
`/private/var/folders/…`. `POST /api/projects` rejects a symlinked `rootPath`
unless `acceptCanonical: true` is supplied. The harnesses were silently eating
the resulting 400, leaving the gateway with zero registered projects at startup.

The fix: `apiFetch` in `tests/e2e/e2e-setup.ts` now intercepts every `POST
/api/projects` call, resolves `rootPath` through `realpathSync`, and
automatically adds `acceptCanonical: true`. Tests that intentionally exercise
the 400 path use `rawApiFetch`, which bypasses this interceptor. The opt-out
marker `__e2e_no_accept_canonical: true` is also reserved for future negative
tests routed through `apiFetch`.
