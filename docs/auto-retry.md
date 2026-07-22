# Auto-Retry

## Purpose

Bobbit auto-retries agent turns when the failure looks transient: provider overload, a transport interruption, malformed streamed tool output, or a sanitized internal/runtime error. The goal is to keep short-lived infrastructure failures moving without hiding deterministic problems that require a human or configuration change.

Auto-retry always dispatches through the same `retryLastPrompt(sessionId, { auto: true })` path as the chat **Retry** button. That keeps continuation safety centralized: if the failed turn already ran tools, Retry resumes the work instead of replaying side effects.

`llm-review` and `agent-qa` gate verification use the same retry classifiers and session-level scheduler for verifier failures; see [Verifier Recovery](llm-review-recovery.md).

## Verifier-session use

Verifier sessions are server-managed, non-interactive agent sessions. `VerificationHarness` owns the verification prompt and `verification_result` resolver, but retryable fetch, connection, provider, and prompt-dispatch failures should flow through `SessionManager.maybeAutoRetryTransient()` whenever possible.

That keeps verifier recovery on the same continuation-safe path as regular agents: retry the existing session, preserve id/history/metadata/workdir/tool context, and avoid creating an empty replacement just because a provider stream or transport failed.

If a verifier process is dead rather than merely errored, the verification harness uses same-session resurrection before considering a step-level retry. That process-death policy is documented in [Verifier Recovery](llm-review-recovery.md#same-session-process-death-resurrection).

## Retry policies

| Error class | Classifier | Schedule | Stop condition |
|-------------|------------|----------|----------------|
| Provider overload / rate-limit | `isProviderBackoffError()` | Exponential from 1 s, capped at 5 min, ±20% jitter | No hard attempt cap; stops on success, termination, new prompt, or explicit Retry |
| Non-provider transient transport/review error | `isTransientReviewError()` and not provider backoff | 1 s, 2 s, 4 s | After 3 failed auto attempts, leave manual Retry available |
| Generic unexpected/internal/system agent error | `isRetryableGenericAgentError()` and not transient | 1 s, 5 s, 60 s | After 3 failed auto attempts, leave manual Retry available |

The bounded policies recover from short-lived failures without looping forever on a broken model, invalid request, or bad configuration. Provider overload stays effectively unbounded because provider incidents can last longer than a short retry burst; the long capped backoff prevents tight retry loops while still recovering without user action.

## Classification

Core retry classification lives in the agent verification logic module:

- `isProviderBackoffError(output)` matches provider overload/rate-limit signals such as `overloaded_error`, `rate_limit_error`, HTTP 429, and HTTP 529.
- `isTransientReviewError(output)` matches retryable transient glitches such as malformed streamed tool JSON, `fetch failed`, `TypeError: fetch failed`, undici transport codes (`UND_ERR_SOCKET`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_CONNECT_TIMEOUT`, and related codes), `ECONNRESET`, `EPIPE`, `socket hang up`, process exits, and `Validation failed for tool`.
- `isRetryableGenericAgentError(output)` matches sanitized runtime failures such as `The system encountered an unexpected error`, `unexpected internal error`, and `system server error`.

Generic auto-retry excludes errors that are likely deterministic or operator-actionable before applying the retryable match. Exclusions include:

- authentication or authorization failures
- missing, invalid, expired, or unconfigured API keys/tokens/credentials
- provider/model configuration errors
- unsupported, unknown, or unrecognized providers/models
- permission denials
- user/human aborts or cancellations
- content/safety-policy blocks
- validation, bad-request, or schema-validation failures

This ordering matters: a wrapper like `The system encountered an unexpected error: missing API key` must not retry just because it contains generic unexpected-error text.

## Scheduling lifecycle

`SessionManager.maybeAutoRetryTransient(session)` is the single scheduler for retryable turn failures. It is reached from two paths:

1. a normal assistant `message_end` with `stopReason: "error"`; and
2. prompt delivery failures that happen before the agent can emit `message_end`, such as `rpcClient.prompt()` or `promptWhenReady()` rejecting with `fetch failed`.

When a policy applies, the scheduler:

1. increments `session.transientRetryAttempts`;
2. computes the policy delay;
3. emits `auto_retry_pending` through the session event stream;
4. sets `session.pendingAutoRetryTimer`;
5. when the timer fires, calls `retryLastPrompt(session.id, { auto: true })` if the session is still the current idle session.

A pending timer is cancelled when the user sends a new prompt, clicks explicit Retry, terminates the session, or the gateway shuts down. Cancellation emits `auto_retry_cancelled` except during shutdown.

If a bounded retry budget is exhausted, the server clears the stale countdown with `auto_retry_cancelled` and leaves manual Retry available.

## Pi internal retry events

Pi `0.81.1` can emit `agent_end` with `willRetry: true` before its own retry loop has produced the final turn outcome. Bobbit treats that event as non-final: the session stays streaming, one-time tool grants remain active, queued prompts are not drained, and `waitForIdle()` keeps waiting. Only a later `agent_end` where `willRetry !== true` completes the Bobbit turn lifecycle.

This keeps Pi's internal retry attempts from looking like separate user-visible turns or opening a queue window before the retry settles. The contract is pinned by `tests2/core/pi-rpc-agent-end-retry.test.ts`.

## Dispatch-time prompt failures

A prompt can fail before the agent starts a turn and before any assistant `message_end` exists. For retryable delivery failures:

- `recoverPromptDispatch()` re-enqueues the failed prompt row at the front of the queue as the durable copy.
- The session is restored to `idle`, enough error state is synthesized for retry bookkeeping, and `auto_retry_pending` is emitted through the same scheduler used by `message_end` errors.
- The auto timer still calls `retryLastPrompt(..., { auto: true })`; that method consumes the recovered queue row before dispatching, so a later `agent_end` drain cannot replay the same prompt a second time.
- If stale `turnHadToolCalls` state exists from a previous turn, dispatch-time recovery clears it because this failed prompt never reached `agent_start` and therefore cannot have run tools.

A fresh user prompt supersedes a recovered dispatch-failure row. The new prompt cancels the pending retry, emits `auto_retry_cancelled`, drops the recovered stale row, and dispatches the user's new intent so old work cannot replay after the follow-up succeeds.

Provider-auth failures do not enter this path. They surface `provider_auth_required` with remediation actions instead of scheduling hidden retries.

## UI events

The server emits `auto_retry_pending` while a retry timer is waiting:

```json
{
  "type": "auto_retry_pending",
  "reason": "provider-overload" | "transient-error",
  "retryDelayMs": 5000,
  "attempt": 2,
  "scheduledAt": 1715800000000,
  "error": "fetch failed"
}
```

Generic unexpected errors and non-provider transient transport failures both use `reason: "transient-error"` on the wire; the policy distinction is server-side. The client stores the event in `state.autoRetryPending` and renders the retry banner while the session remains `idle`.

`lastTurnErrored` remains true while auto-retry is pending, so the normal manual Retry affordance is still available.

## Team-lead auto-nudge interaction

Team leads rely on automatic nudges to resume work after child-agent or gate activity. The same nudge sources also run while a lead is sitting on an errored idle turn, so `TeamManager` checks that state before adding any new `[AUTO-NUDGE]` prompt.

If the lead is `idle` with `lastTurnErrored`, retryable errors are recovered through `retryLastPrompt(sessionId, { auto: true })` instead of enqueueing a fresh nudge. This keeps recovery on the same continuation-safe path as auto-retry and the UI Retry button.

Team auto-nudges are suppressed, without adding duplicate transcript cards, when:

- `SessionManager` already has a pending auto-retry timer;
- a retry or pending nudge is already in progress;
- the error is unknown, non-retryable, or has exhausted the bounded retry budget.

In the final case, the explicit UI Retry affordance remains the human-action path.

Auto-nudge delivery also treats these as no-start outcomes:

- `enqueuePrompt()` throws synchronously;
- the async delivery rejects;
- the prompt parks behind an errored/capped session;
- delivery resolves as queued while the team lead remains idle.

No-start outcomes clear `nudgePending`, do not increment the successful sent counter, and do not log `Sent ... nudge`. They advance a separate attempt counter only enough to reschedule with bounded backoff, avoiding repeated misleading “Sent” logs while the lead is still stuck. Retry attempts likewise do not count as successful nudges unless the agent actually starts.

`agent_start` confirms the normal success path. Auto-nudge, task-notification, verification, and agent-sourced lead turns preserve existing nudge backoff counters; external user/system prompts reset them.

See [Auto-Nudge Recovery for Errored Team Leads](design/auto-nudge-stuck-team-leads.md) for the team-manager-specific policy.

## Tests

Relevant coverage runs under `npm run test:unit` unless noted:

- `tests2/core/auto-retry-policy.test.ts` covers provider overload, generic unexpected retries at 1 s / 5 s / 60 s, retry exhaustion, deterministic exclusions, and `fetch failed` message-end scheduling.
- `tests2/core/session-manager-direct-prompt-lifecycle.test.ts` covers direct and queued `fetch failed` delivery failures before `message_end`, recovered queue rows, client-visible `auto_retry_pending`, `auto_retry_cancelled` on exhaustion/cancellation, no duplicate replay, fresh-prompt supersession, and stale tool-call-state clearing.
- `tests2/core/verification-logic.test.ts` and `tests2/core/transient-review-error.test.ts` cover `fetch failed`, undici transport codes, deterministic exclusions, and `shouldRetryVerificationStep()` behavior.
- `tests2/core/verification-verifier-lifecycle-repro.test.ts` covers verifier use of same-session auto-retry for retryable `agent-qa` fetch failures.
- `tests2/core/team-manager-idle-nudge-backoff.test.ts` covers no-start auto-nudge accounting and errored-idle recovery: retryable errors use `retryLastPrompt(..., { auto: true })`, unknown/non-retryable/exhausted errors suppress team nudges, and repeated timer ticks do not emit duplicate `[AUTO-NUDGE]` cards.
- `tests2/core/team-manager.test.ts` covers worker-idle notification recovery for errored idle team leads.
- `tests2/dom/queue-dispatch.test.ts` covers queue-level cancellation and retry/unstick invariants.
- `tests/e2e/ui/auto-retry-banner.spec.ts` covers the UI banner state for `auto_retry_pending`, `auto_retry_cancelled`, and `agent_start`.
