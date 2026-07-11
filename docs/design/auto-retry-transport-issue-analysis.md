# Auto-retry transport failure resolution

## Summary

A live team-lead session showed a retryable `fetch failed` failure with a manual **Retry** button but no automatic retry countdown. The fix expands auto-retry beyond assistant `message_end` errors so transport failures during prompt delivery also enter the same visible scheduler.

The resolved behavior is:

- `fetch failed`, `TypeError: fetch failed`, and common undici transport codes are classified as retryable transient transport errors.
- Deterministic/operator-action failures remain non-retryable.
- Prompt delivery failures before `message_end` recover the failed prompt row, show `auto_retry_pending`, and retry through `retryLastPrompt(..., { auto: true })`.
- Fresh user input supersedes recovered failed rows so stale prompts cannot replay later.
- Team-lead auto-nudges are only counted/logged as sent after delivery starts or is accepted.

## Failure mode

The observed stuck state combined two gaps:

1. Plain `fetch failed` was not classified as retryable, even though it is the common undici surface for socket resets, long-poll timeouts, gateway restarts, and similar transport interruptions.
2. Some failures happened before the agent could emit an assistant `message_end`. The prompt row was recovered, but the session did not enter the same `maybeAutoRetryTransient()` path that emits `auto_retry_pending` and arms the retry timer.

TeamManager made the failure more confusing by logging repeated auto-nudges as “Sent” when the nudge had only been handed to `enqueuePrompt()` and no lead turn had started.

## Retryability classification

Retryable transient transport/review errors now include:

- `fetch failed` and `TypeError: fetch failed`;
- undici transport codes such as `UND_ERR_SOCKET`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `UND_ERR_ABORTED`, and `UND_ERR_DESTROYED`;
- existing socket/process phrases such as `ECONNRESET`, `ECONNREFUSED`, `ENOTCONN`, `EPIPE`, `socket hang up`, websocket errors, and process exits;
- malformed streamed tool JSON and tool validation glitches already handled by the transient classifier.

Provider overload and rate-limit signals remain separate. `overloaded_error`, `rate_limit_error`, HTTP 429, and HTTP 529 use the longer provider backoff path instead of the bounded transport burst.

Deterministic failures are excluded before retryable matching. The non-retryable set includes:

- authentication and authorization failures;
- missing, invalid, expired, or unconfigured keys/tokens/credentials;
- provider/model configuration errors;
- unsupported, unknown, or unrecognized providers/models;
- permission denials;
- user/human aborts and cancellations;
- content/safety-policy blocks;
- validation, bad-request, invalid-request, and schema-validation failures.

This prevents sanitized wrappers like `The system encountered an unexpected error: missing API key` from looping.

## Bounded retry policy

Auto-retry still uses bounded retries for non-provider failures:

| Failure type | Schedule | Exhaustion behavior |
|--------------|----------|---------------------|
| Non-provider transient transport/review failures, including `fetch failed` | 1 s, 2 s, 4 s | Stop after the third auto attempt; leave manual Retry available |
| Generic unexpected/internal/system agent errors | 1 s, 5 s, 60 s | Stop after the third auto attempt; leave manual Retry available |
| Provider overload/rate-limit | Exponential from 1 s, capped at 5 min, ±20% jitter | No fixed attempt cap; stop on success, termination, new prompt, or explicit Retry |

When bounded dispatch-time retries exhaust, the server emits `auto_retry_cancelled` so the UI does not keep a stale countdown while manual Retry is required.

## Dispatch-time prompt recovery

Prompt delivery can fail before `agent_start` and before any assistant error message exists. The implemented flow is:

1. `dispatchDirectPrompt()` or `drainQueue()` calls `recoverPromptDispatch()` when the RPC rejects or returns `{ success: false }`.
2. `recoverPromptDispatch()` restores the failed row to the front of the prompt queue as the durable copy.
3. Provider-auth failures surface `provider_auth_required` and stop there.
4. Retryable non-auth failures synthesize error state (`lastTurnErrored`, `lastTurnErrorMessage`, retry counters) and call the same auto-retry scheduler used after `message_end` errors.
5. The scheduler emits `auto_retry_pending` and arms a timer.
6. The timer calls `retryLastPrompt(session.id, { auto: true })`.

The auto path remains continuation-safe. If a prior turn had run tools, `retryLastPrompt()` can use continuation text. For pre-`agent_start` delivery failures, recovery clears stale `turnHadToolCalls` because the failed prompt never started and could not have executed tools.

Recovered rows are consumed before retry dispatch. This makes the recovered row the single durable copy while waiting, but prevents duplicate replay after a successful retry and later `agent_end` drain.

## Fresh prompt supersession

A new user prompt is stronger intent than a recovered failed prompt. When it arrives while a dispatch-time retry is pending, the server:

- cancels the pending retry timer;
- emits `auto_retry_cancelled`;
- removes recovered dispatch-failure rows from the queue;
- dispatches the fresh prompt immediately when possible.

This prevents old prompt A from replaying after the user has already sent prompt B.

## TeamManager auto-nudge accounting

Auto-nudge delivery now separates “attempted enqueue” from “sent/started”. `enqueueAutoNudge()` tracks pending accounting callbacks and confirms success only when delivery returns a dispatched result or the lead actually starts a turn.

These outcomes are treated as no-start:

- synchronous `enqueuePrompt()` failure;
- asynchronous delivery rejection;
- parked delivery;
- queued delivery while the team lead remains idle.

No-start clears `nudgePending`, does not increment successful nudge counts, and does not log `Sent ... nudge`. It records an attempt and reschedules with backoff so failures cannot create tight loops or sticky suppression.

## Tests that pin the fix

- `tests2/core/auto-retry-policy.test.ts` pins `fetch failed` message-end scheduling, generic 1 s / 5 s / 60 s retries, retry exhaustion, and deterministic exclusions.
- `tests2/core/session-manager-direct-prompt-lifecycle.test.ts` pins direct and queued dispatch-time `fetch failed` recovery, visible `auto_retry_pending`, recovered-row consumption, fresh prompt supersession, stale tool-call-state clearing, and `auto_retry_cancelled` on exhaustion.
- `tests2/core/verification-logic.test.ts` and `tests2/core/transient-review-error.test.ts` pin retry classification and verification retry decisions for `fetch failed`, undici codes, and deterministic non-retryable failures.
- `tests2/core/team-manager-idle-nudge-backoff.test.ts` pins no-start nudge behavior: rejected or parked/queued auto-nudges are not counted or logged as sent before a lead turn starts, and they do not leave `nudgePending` sticky.
- `tests/e2e/ui/auto-retry-banner.spec.ts` pins banner rendering and clearing for `auto_retry_pending`, `auto_retry_cancelled`, and `agent_start`.

## Related reference

See [Auto-Retry](../auto-retry.md) for the ongoing runtime contract and policy details.
