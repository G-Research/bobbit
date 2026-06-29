# Auto-retry transport failure issue analysis

## Summary

The merged auto-retry path is too narrow for the observed `fetch failed` stuck state.

There are two overlapping gaps:

1. `fetch failed` is not currently classified as transient/retryable, even though it is commonly the undici surface for socket resets, long-poll header timeouts, gateway restarts, and other transport failures. A turn that ends with `message_end.stopReason === "error"` and `errorMessage: "fetch failed"` can therefore show the manual **Retry** affordance but never emit `auto_retry_pending`.
2. Prompt-delivery failures that happen before the agent emits an assistant `message_end` are recovered as queued rows and the session is set back to `idle`, but they do not enter the same errored-turn state or `maybeAutoRetryTransient()` scheduler. That can leave a queued auto-nudge/retryable prompt waiting behind a visible frozen state, without countdown state.

The root fix should make retryability classification and scheduling cover retryable transport failures regardless of whether they arrive as an agent `message_end` error or as a prompt dispatch/enqueue failure, while preserving the existing bounded generic retry policy and deterministic non-retryable exclusions.

## Observed failure path

Evidence from live session `6c618081-9092-440b-a649-18832be1923f`:

- The implementation gate failed with reviewer steps whose output was exactly `LLM review failed: fetch failed`.
- The team-lead transcript then had several empty assistant entries around the gate-failure handling window, consistent with failed/aborted agent attempts rather than a clean explanatory assistant turn.
- Later, multiple `[AUTO-NUDGE]` messages were delivered together as user-visible input, while the desired `auto_retry_pending` countdown state was not visible.

The relevant transcript tail showed:

- gate inspection output for `Code quality review`: `LLM review failed: fetch failed`;
- gate inspection output for `Bug hunt`: `LLM review failed: fetch failed`;
- repeated no-workers `[AUTO-NUDGE]` text in a single user message after the failure.

## Current code paths

### Session auto-retry scheduler

`src/server/agent/session-manager.ts:3453` `handleAgentLifecycle()` tracks errored turns only when an assistant `message_end` arrives:

- `src/server/agent/session-manager.ts:3531-3542` reads `event.message.stopReason === "error"`, stores `session.lastTurnErrored`, stores a redacted `session.lastTurnErrorMessage`, and increments `consecutiveErrorTurns`.
- `src/server/agent/session-manager.ts:3649-3661` calls `maybeAutoRetryTransient(session)` only from the `agent_end` branch when `session.lastTurnErrored` is true.

`src/server/agent/session-manager.ts:3865` `maybeAutoRetryTransient()` then:

- classifies `session.lastTurnErrorMessage` via `isProviderBackoffError()`, `isTransientReviewError()`, and `isRetryableGenericAgentError()`;
- schedules provider overload/rate-limit with the longer jittered backoff;
- schedules generic unexpected errors at `1s`, `5s`, `60s`, then stops;
- emits `auto_retry_pending` through `emitSessionEvent()` before arming the timer;
- fires `retryLastPrompt(session.id, { auto: true })` from the timer.

`src/server/agent/session-manager.ts:4008` `retryLastPrompt()` is continuation-safe:

- it captures `turnHadToolCalls` before clearing error state;
- if tool calls already ran, it sends a system continuation prompt instead of replaying the original prompt;
- explicit retry resets retry budgets, while `{ auto: true }` preserves `transientRetryAttempts` so backoff can grow.

### Transport/prompt dispatch path

`src/server/agent/session-manager.ts:2831` `enqueuePrompt()` dispatches immediately when the session is idle and the queue is empty. It awaits `dispatchDirectPrompt()`.

`src/server/agent/session-manager.ts:3322` `dispatchDirectPrompt()`:

- records `lastPromptText` / `lastPromptImages`;
- marks the session streaming before the RPC resolves;
- calls `rpcClient.prompt()` or `promptWhenReady()`;
- on rejection or `{ success:false }`, calls `recoverPromptDispatch()` and rethrows.

`src/server/agent/session-manager.ts:3264` `recoverPromptDispatch()`:

- re-enqueues failed prompt rows at the front of the queue;
- surfaces provider-auth failures via `provider_auth_required`;
- otherwise broadcasts `idle`, broadcasts the queue, and schedules bounded immediate redrains for SDK busy races.

Important gap: non-auth transport failures in `recoverPromptDispatch()` do not set `lastTurnErrored`, do not set `lastTurnErrorMessage`, do not increment `consecutiveErrorTurns`, and do not call `maybeAutoRetryTransient()`. If the failure is `fetch failed`, the retry row may be recoverable in the queue, but no `auto_retry_pending` banner/timer is emitted.

`src/server/agent/session-manager.ts:3371` `drainQueue()` has the same dispatch-recovery shape for queued rows. Its catch path logs and re-enqueues, but also does not route retryable transport failures through the auto-retry scheduler.

### Retryability classification

`src/server/agent/verification-logic.ts:206` `TRANSIENT_INFRA_ERROR_REGEXES` includes socket/process phrases such as `ECONNRESET`, `ECONNREFUSED`, `socket hang up`, and `process not running`, but does **not** include plain `fetch failed`.

`src/server/agent/verification-logic.ts:290` `GENERIC_AGENT_NON_RETRYABLE_REGEXES` excludes deterministic errors: auth, missing/invalid API keys, credentials, configuration errors, permission denials, user abort/cancel, policy/content blocks, validation errors, bad requests, and schema validation.

`src/server/agent/verification-logic.ts:309` `isRetryableGenericAgentError()` retries sanitized unexpected/internal/system errors only after checking those exclusions.

Because `fetch failed` is neither in the transient infra regexes nor in the generic unexpected regexes, both SessionManager auto-retry and verification retry logic can treat it as terminal.

### UI state

`src/app/remote-agent.ts:609` stores `autoRetryPending` state. It is set by `auto_retry_pending` at `src/app/remote-agent.ts:2558` and cleared by `auto_retry_cancelled` at `src/app/remote-agent.ts:2575` or by `agent_start`.

`src/ui/components/AgentInterface.ts:1806` renders the countdown banner from `state.autoRetryPending`.

The manual **Retry** affordance is separate: `src/ui/components/MessageList.ts:281` passes `onRetry` only for the last assistant message with `stopReason === "error"`, and `src/ui/components/Messages.ts:491` renders the red error card and button when `errorMessage` exists. Therefore a retryable `fetch failed` message-end error can show **Retry** while no auto-retry banner appears if the server never emits `auto_retry_pending`.

### TeamManager auto-nudge accounting

`src/server/agent/team-manager.ts:1048` `enqueueAutoNudge()` is the central helper for no-workers, workers, stuck-watchdog, and boot-resume nudges. It sets `nudgePending` before calling `sessionManager.enqueuePrompt()` and attaches async rejection handling.

Relevant handling:

- `src/server/agent/team-manager.ts:1085` clears `nudgePending` if delivery returns `{ parked:true }` or `{ status:"queued" }` while the lead remains idle.
- `src/server/agent/team-manager.ts:1067-1078` attaches handlers to thenables so rejected delivery clears `nudgePending`.
- `src/server/agent/team-manager.ts:1223` and `src/server/agent/team-manager.ts:1270` increment nudge counters and log “Sent ... nudge” immediately after `enqueueAutoNudge()` returns true.
- `src/server/agent/team-manager.ts:1400` preserves nudge counters on `agent_start` when `lastPromptSource` is `auto-nudge`, `task-notification`, `verification`, or other non-external sources.

The sticky `nudgePending` case has partial regression coverage, but there is still a misleading sent-state edge: `enqueueAutoNudge()` returns true before an async prompt delivery actually starts a turn. The scheduling/logging callers then count and log the nudge as sent even if the thenable later rejects or resolves as queued/parked/no-start. This matches the symptom of repeated “Sent” auto-nudges while the lead remains stuck.

## Root cause hypothesis

Primary root cause: plain `fetch failed` is missing from the retryable transient transport classifier. When the error is surfaced as `message_end.stopReason === "error"`, the server reaches `maybeAutoRetryTransient()`, but classification returns false, so no `auto_retry_pending` event or timer is scheduled.

Secondary root cause: prompt delivery failures and nudge dispatch failures have a separate recovery path that re-enqueues rows and idles the session without entering the errored-turn auto-retry scheduler. That bypass matters for failures before `agent_start` / assistant `message_end`, including cold-start `promptWhenReady()` failures and RPC/transport failures in `dispatchDirectPrompt()` or `drainQueue()`.

TeamManager contributes to the confusing UX by counting an auto-nudge as “sent” when it has only been handed to `enqueuePrompt()`, not when the lead actually starts a turn. For async failure/no-start cases, accounting and backoff can diverge from what the user sees.

## Retryability classification

Treat as retryable transport/transient:

- plain `fetch failed` and `TypeError: fetch failed`;
- undici socket causes that often accompany it (`UND_ERR_SOCKET`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_CONNECT_TIMEOUT`, `terminated` when clearly transport-scoped);
- existing transient infra patterns: `ECONNRESET`, `ECONNREFUSED`, `ENOTCONN`, `EPIPE`, `socket hang up`, websocket errors, process-not-running/exited;
- JSON/tool-call streaming glitches already covered by the existing JSON regexes;
- sanitized generic unexpected/internal/system errors that pass the current non-retryable exclusion filter.

Keep provider overload/rate-limit separate:

- `overloaded_error`, `rate_limit_error`, HTTP/status `429`, HTTP/status `529` must continue using provider backoff capped at 5 minutes, not the generic `1s/5s/60s` burst.

Do **not** auto-retry deterministic/operator-action failures:

- authentication/authorization failures;
- missing/invalid API keys, tokens, credentials;
- provider/model configuration errors;
- permission denials / access denied / `EACCES` / `EPERM`;
- user/human aborts or cancellations;
- content-policy/safety-policy blocks;
- validation errors, bad requests, invalid requests, schema validation;
- unsupported provider/model errors.

The existing `GENERIC_AGENT_NON_RETRYABLE_REGEXES` covers most of this list; unsupported provider/model should be added if not already matched by configuration/validation wording.

## Proposed reproduction tests

### 1. Message-end `fetch failed` schedules auto retry

Add a unit test near `tests/auto-retry-policy.test.ts` that constructs a minimal `SessionManager` session like the existing generic unexpected tests, with:

- `lastTurnErrored: true`;
- `lastTurnErrorMessage: "fetch failed"` or `"TypeError: fetch failed"`;
- `lastPromptText` set;
- idle status and fake timers.

Call `manager.maybeAutoRetryTransient(session)` and assert:

- `pendingAutoRetryTimer` is set;
- an `auto_retry_pending` event is present in the `EventBuffer`;
- delay is `1000` for attempt 1, then `5000`, then `60000` if this goes through the generic bounded transport policy;
- after the timer fires, `rpcClient.prompt()` is called through `retryLastPrompt(..., { auto:true })`.

This reproduces the visible Retry/no-banner failure when `fetch failed` appears as assistant `message_end` error.

### 2. Dispatch-time `fetch failed` schedules visible pending retry

Add a SessionManager unit test around `enqueuePrompt()` / `dispatchDirectPrompt()`:

- create an idle session with empty queue and `rpcClient.prompt = mock.fn(async () => { throw new TypeError("fetch failed"); })`;
- call `await assert.rejects(() => manager.enqueuePrompt(session.id, "hello"), /fetch failed/)` if preserving current rejection behavior, or assert returned status if the implementation chooses to swallow after scheduling;
- assert the failed prompt row was recovered at the front of the queue;
- assert `auto_retry_pending` was emitted and `pendingAutoRetryTimer` exists;
- advance fake timers and assert the retry uses the recovered prompt exactly once.

This covers failures before any assistant `message_end` exists.

### 3. Queued drain dispatch `fetch failed` schedules visible pending retry

Add a targeted `drainQueue()` test or extend existing queue dispatch tests:

- seed a queued row;
- make `rpcClient.prompt()` reject with `fetch failed` during drain;
- assert the row is recovered, status returns idle, and the auto-retry pending event is emitted instead of only tick-0 redraining.

This protects prompts parked behind previous work and auto-nudge rows.

### 4. TeamManager no-start nudge accounting

Add/extend tests near `tests/team-manager-idle-nudge-backoff.test.ts`:

- make `sessionManager.enqueuePrompt()` return a thenable that rejects after a microtask;
- assert `nudgePending` clears;
- assert nudge count/backoff is not incremented as a successful sent nudge, or is rolled back if the implementation increments before settlement;
- assert logs/observable state do not claim repeated sent nudges when no `agent_start` occurs.

Add a second variant where `enqueuePrompt()` resolves `{ status:"queued" }` while the lead remains idle and no `agent_start` fires.

### 5. UI/state banner rendering for stuck state

Existing `tests/e2e/ui/auto-retry-banner.spec.ts` covers synthetic event rendering. Add a lighter state-level test if possible:

- feed a `message_end` error with `errorMessage:"fetch failed"` through the server-side lifecycle or a narrow SessionManager harness;
- verify the client receives/handles `auto_retry_pending` and the banner state is populated.

If full server-to-browser coverage is too expensive, keep the UI test synthetic and rely on server unit tests for event emission.

### 6. Verification harness classifier regression

Because the live failure was `LLM review failed: fetch failed`, add a pure classifier test for `isTransientReviewError("fetch failed")` and `shouldRetryVerificationStep(...)` to ensure review/QA retry loops do not mark a gate failed immediately for a retryable transport blip.

## Proposed implementation plan

1. Extend retryability classification in `src/server/agent/verification-logic.ts`:
   - add `fetch failed` / `TypeError: fetch failed` to transient infra classification;
   - add common undici transport codes if absent;
   - add unsupported provider/model to the non-retryable exclusions if needed.
2. Extract/introduce a SessionManager helper for scheduling retryable dispatch failures, e.g. `maybeAutoRetryPromptDeliveryFailure(session, reason, source)`:
   - classify with the same provider-backoff/transient/generic predicates;
   - set enough session error state for retry bookkeeping and manual Retry consistency (`lastTurnErrored`, `lastTurnErrorMessage`, `consecutiveErrorTurns`) without fabricating duplicate transcript rows unless the UI requires it;
   - call the same `maybeAutoRetryTransient()` path so `auto_retry_pending` emission and timers stay single-sourced.
3. Call that helper from `recoverPromptDispatch()` after re-enqueueing rows for non-auth retryable failures. Do not call it for provider-auth failures, terminated sessions, aborting sessions, or non-retryable deterministic failures.
4. Ensure the auto timer dispatch does not duplicate rows:
   - if the dispatch failure already re-enqueued the failed row, `retryLastPrompt({ auto:true })` should either consume the recovered queued row like explicit retry does, or dispatch via the existing continuation-safe path without causing the next `agent_end` drain to replay the same prompt.
   - add assertions for queue length before/after retry.
5. Adjust TeamManager auto-nudge delivery accounting:
   - separate “attempted enqueue” from “turn started” / “delivery accepted”;
   - increment/log sent counters only after `agent_start` or a dispatch result that reliably means the turn started;
   - on rejection, parked, or queued-with-idle/no-start, clear `nudgePending` and do not advance sent backoff as if successful.
6. Preserve UI event semantics:
   - every scheduled auto retry emits `auto_retry_pending` through `emitSessionEvent()`;
   - explicit retry/new prompt/termination continue to emit `auto_retry_cancelled` when a timer exists;
   - `agent_start` continues to clear the client banner.

## Risks and edge cases

- **Duplicate side effects after tool calls:** auto retry must keep using `retryLastPrompt({ auto:true })` so mid-work failures send the continuation prompt rather than replaying the original user request and duplicating tool actions.
- **Duplicate prompt rows:** dispatch-failure recovery re-enqueues rows. Auto retry must consume or coordinate with that recovered row so the same prompt is not sent once by the timer and again by a later queue drain.
- **Busy-guard spin:** `recoverPromptDispatch()` already has bounded tick-0 redrains for `Agent is already processing`. Adding auto-retry scheduling must not create a second tight loop for the same failure.
- **Provider auth/configuration:** auth failures already route to `provider_auth_required`; they must not schedule auto retry behind the user’s back.
- **User aborts:** aborted turns can emit error-shaped events but are explicitly cleared in `handleAgentLifecycle()`; do not reclassify them as retryable transport errors.
- **Team-lead nudge backoff:** not incrementing counters until `agent_start` avoids misleading “Sent” logs, but repeated delivery failures still need bounded retry/backoff to avoid hammering a dead session every base interval.
- **Reconnect/banner persistence:** `auto_retry_pending` and `auto_retry_cancelled` already go through `emitSessionEvent()` and the event buffer. New paths should use the same helper and not direct-broadcast seqless frames.
- **Verification semantics:** making `fetch failed` transient will cause LLM review steps to retry instead of failing immediately. Keep bounded attempts for non-provider transport errors so real persistent network/config problems still surface.

## Files to change later

- `src/server/agent/verification-logic.ts` — retryability classifier updates.
- `src/server/agent/session-manager.ts` — schedule auto retry for retryable prompt delivery/dispatch failures and avoid duplicate queue replay.
- `src/server/agent/team-manager.ts` — auto-nudge sent/no-start accounting.
- `tests/auto-retry-policy.test.ts` — `fetch failed` and dispatch-failure auto-retry coverage.
- `tests/team-manager-idle-nudge-backoff.test.ts` — no-start/rejected nudge accounting.
- Optional: `tests/e2e/ui/auto-retry-banner.spec.ts` or a state-level equivalent for banner state on the observed stuck class.
