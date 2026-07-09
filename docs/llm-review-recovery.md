# llm-review Recovery

`llm-review` verification steps run a dedicated reviewer session and wait for that session to call `verification_result`. This makes review output visible and restartable, but it also means the gate depends on agent-runtime infrastructure: sockets, WebSockets, provider streams, the child agent process, and the gateway restart path.

The recovery policy treats infrastructure failures as recoverable before it marks the gate failed. A real review finding should fail fast; a transient runtime failure should get a bounded retry window; provider overload should wait longer without a tight loop.

## Recovery layers

Recovery happens at two layers:

1. **Session-level auto-retry** — `SessionManager.maybeAutoRetryTransient()` retries the reviewer turn that just errored. It uses the same continuation-safe path as the manual Retry button, so tool side effects are not blindly replayed.
2. **Verification-step retry** — `VerificationHarness` re-runs the `llm-review` step when the session still returns a retryable failure after the turn-level recovery window.

The layers are deliberately separate. Session auto-retry preserves the current reviewer context when possible. Step retry is the fallback when the current reviewer cannot recover cleanly.

## Reviewer session lifecycle (transcript preservation)

The reviewer step depends on a live agent session, and that session's *transcript* is a first-class artifact: an operator can open `/session/<id>` to read exactly what the reviewer saw and concluded. Two lifecycle rules protect that transcript. Both fix a regression where a long, sometimes already-complete review was silently destroyed.

### Fresh session id per from-scratch retry attempt

When the bounded step-retry loop re-runs an `llm-review` step from scratch, **each attempt gets a fresh reviewer session id**. Only the first attempt keeps the pre-generated `stepSessionId` (already broadcast to the UI via `gate_verification_step_started`); attempts 2..N mint a new `llm-review-<uuid>` id and re-broadcast the retired→new lineage so the UI can follow it.

Why this matters: the previous behavior generated a single `stepSessionId` *before* the retry loop and threaded the same id into every attempt. `SessionManager.createSession` keys sessions by id, so re-running with the same id built a brand-new agent *in place* and overwrote the prior attempt's transcript. The observable symptom was a reviewer whose displayed name suddenly changed (a fresh `generateTeamName`) while the URL stayed the same, and ~10 minutes of real review work — sometimes a completed pass — vanished. Minting a fresh id per attempt keeps every prior attempt viewable at its original URL.

The restart-*resume* path is the deliberate exception: it re-attaches to the reviewer's existing session (see [Restart resume and rerun](#restart-resume-and-rerun)) rather than starting a new one, because after a gateway restart the goal is to continue the *same* review, not start over.

### `createSession` clobber guard

`SessionManager.createSession` refuses to silently clobber an existing session. If a caller passes a `sessionId` that already maps to a **live** session (and does not set `opts.allowSessionReuse`), the call throws with a clear "Refusing to clobber live session" error; a collision with an **archived** record logs loudly. Both log the greppable prefix `[session-manager][session-id-clobber]`.

Why: the fresh-id-per-attempt rule above is the primary fix, but the guard is defense-in-depth. Any future caller that accidentally reuses a live reviewer id is a bug, and a bug that overwrites a transcript should fail loudly at the source rather than corrupt state silently. `allowSessionReuse` is the single sanctioned escape hatch, reserved for the restart-resume path; it is not used to re-create sessions in the normal flow.

## Error classification

Classification lives in `src/server/agent/verification-logic.ts`.

### Retryable transient infrastructure failures

`isTransientReviewError()` covers short-lived infrastructure and streaming failures, including:

- `WebSocket error`, `socket error`, `socket hang up`
- `ECONNRESET`, `ECONNREFUSED`, `ENOTCONN`, `EPIPE`
- connection reset/refused/closed/lost/terminated messages
- `Agent process not running` and process exit/death/termination variants
- streamed tool-call JSON glitches and `Validation failed for tool`

These use bounded retry. The goal is to absorb flakes without hiding a broken runtime forever.

### Retryable generic runtime failures

`isRetryableGenericAgentError()` covers sanitized agent/runtime messages such as:

- `The system encountered an unexpected error`
- unexpected agent/system/internal errors
- internal/system server errors

It first excludes deterministic causes. This ordering matters because providers and wrappers often prefix concrete failures with generic text.

### Terminal deterministic failures

The generic retry classifier does **not** retry failures that require configuration, credentials, policy, or user action, including:

- auth/authorization failures
- missing, invalid, expired, or unconfigured API keys, tokens, or credentials
- config errors
- permission denied / access denied
- user or human abort/cancel/interruption
- content/safety-policy blocks
- invalid request, validation, and schema-validation failures

A deterministic failure breaks the retry loop and is surfaced as the step output.

### Provider rate-limit / overload

`isProviderBackoffError()` is a narrower classifier for provider overload, quota, or rate-limit signals such as `overloaded_error`, `rate_limit_error`, HTTP 429, and HTTP 529.

Provider backoff is also transient, but it gets a different policy: retry indefinitely with exponential delay capped and jittered. Provider incidents can last longer than a short bounded burst; failing immediately would turn temporary quota pressure into unnecessary gate failures.

## Retry schedules

| Layer | Error class | Schedule | Attempt cap |
|---|---|---|---|
| Session auto-retry | Provider rate-limit / overload | Exponential from 1s, capped at 5m, ±20% jitter | No hard cap |
| Session auto-retry | Socket/JSON/process transient | 1s, 2s, 4s | 3 attempts |
| Session auto-retry | Generic unexpected runtime | 1s, 5s, 60s | 3 attempts |
| Verification step retry | Provider rate-limit / overload | Exponential from 2s, capped at 15m, ±20% jitter | No hard cap |
| Verification step retry | Other retryable `llm-review` failures | Exponential from 2s between attempts | 3 attempts |

See [Auto-Retry](auto-retry.md) for the shared session-level policy.

## Errored-turn grace before cleanup

When the reviewer session goes idle without `verification_result`, the harness checks whether the last turn ended in a retryable error before terminating the session.

If the session has a pending auto-retry timer, the harness waits for the retry turn to actually start:

- ordinary retryable runtime/socket errors: up to the step timeout, capped at 75s;
- provider backoff: up to the step timeout, capped at 330s.

Once the retry turn starts, the harness waits for either `verification_result` or idle. If that retry turn errors again and another auto-retry is pending, the grace loop repeats. Only after the recovery path is exhausted does the harness return a failed step and clean up the reviewer session.

## Reminder-first behavior (in-session, multi-reminder)

An idle reviewer that simply forgot to call `verification_result` is **re-nudged on the same live session** before the gate fails. The session still holds its full analysis in context, so a reminder is far cheaper and more reliable than tearing it down and re-running from scratch.

Crucially, "completed the review but missed the tool call" is classified **non-transient** — the same intent the QA path encodes in `QA_NON_TRANSIENT_PATTERNS`. `"Agent did not call verification_result after reminder"` is deliberately *not* in the transient markers, so the bounded step-retry loop does **not** discard the reviewer's work with a fresh-id from-scratch re-run. In-session re-nudging is the recovery mechanism for this case; a from-scratch attempt is reserved for genuine infra-transient failures (socket resets, process death, etc.).

Live `llm-review` sessions use this order (`runLlmReviewViaSession`):

1. Wait for the initial reviewer turn to finish or call `verification_result`.
2. If the turn errored, run the errored-turn recovery path above.
3. If the turn ended cleanly without the tool call, send up to `MAX_REVIEWER_REMINDERS` (2) reminders, **each with a fair turn**:
   - a targeted JSON/tool-validation retry prompt when the last tool call failed validation;
   - otherwise a context-rich reminder that reattaches the kickoff context.
4. For each reminder, wait for `waitForStreaming()` (up to `REVIEWER_REMINDER_STREAM_SETTLE_MS`, 15s) before racing against idle.
5. If a reminder turn goes idle without the tool call but *did* stream, give a short late-verdict settle window (`REVIEWER_REMINDER_LATE_VERDICT_SETTLE_MS`, 20s) and re-check the channel once — the verdict POST may still be in flight — before deciding to nudge again or give up.
6. Only after all fair reminders are exhausted does the harness declare the hard failure and tear down.

Why multiple fair reminders: the pre-regression path sent exactly **one** reminder and then, if the already-idle reviewer had not started streaming within a tight 10s window, resolved `waitForIdle()` immediately and SIGTERM'd the reviewer — killing a session that had completed its review but simply needed a beat to emit the tool call. Giving each nudge a genuine settle window and allowing a second reminder restores the previously-better reliability.

The `waitForStreaming()` guard is still essential. Without it, `waitForIdle()` can resolve against the already-idle state immediately after the reminder is queued, causing the harness to fail and terminate the reviewer before the reminder turn starts. This race is pinned by `tests/verification-reminder-race.test.ts`.

## Late verdict during teardown is honored (no 404 drop)

A `verification_result` POST can race reviewer teardown: the reviewer emits its verdict at the same moment the harness gives up and starts cleaning up. Two changes ensure that late verdict is captured, not lost:

- **Teardown order.** The `finally` block terminates the session **first**, then deletes the pending resolver. The old order (delete resolver, then terminate) meant a POST landing during teardown hit `server.ts`'s `pendingResults.get()` lookup, found nothing, and was 404-dropped — a real pass silently lost. This matched the reported "I saw a pass but it never materialised at the server level."
- **Capturing resolver.** The resolver registered for the reviewer (`capturingResolver`) stores the first verdict it receives (`capturedVerdict`). If the reviewer went idle without the tool call (the hard-failure path set `hardFailureNoResult`) but a verdict then lands during teardown, the harness returns that late verdict instead of the "did not call verification_result" failure.

The `POST /api/internal/verification-result` route logs accept vs 404-drop with the greppable `[verification][reviewer-lifecycle]` prefix, so a genuinely dropped verdict is diagnosable rather than invisible.

## Diagnostics: greppable log prefixes

Reviewer lifecycle events emit structured, greppable log lines so a future failure is diagnosable without re-deriving the code path:

- **`[verification][reviewer-lifecycle]`** — reviewer spawn/attempt (attempt N/max, session id, goal, timeout), from-scratch retry lineage (retired id → fresh id), each reminder (number/max, JSON-retry vs context-rich), termination reason (e.g. `reason=reminder-exhausted`), late-verdict-honored-during-teardown, and `verification_result` POST accept vs 404-drop.
- **`[session-manager][session-id-clobber]`** — a caller tried to reuse a live or archived session id without `allowSessionReuse`; the transcript-clobber guard fired.

Grep these prefixes in the gateway log to reconstruct a reviewer's full lifecycle and transcript lineage across attempts.

## Restart resume and rerun

Reviewer and QA sessions are `nonInteractive`: normal user prompts are blocked, and only the verification harness should drive them. Restart recovery therefore has two owners:

- `SessionManager.shutdown()` records restart re-drive need in the legacy `wasStreaming` field using `sessionNeedsRestartRedrive()`. The predicate is false for `idle` and `terminated`, true for active/busy states such as `streaming`, `preparing`, `aborting`, and fresh `starting`, and preserves the prior persisted bit during the restore-startup window so a rapid shutdown does not invent a false interrupted turn.
- `SessionManager.restoreSession()` revives the process but deliberately does **not** send the generic mid-turn boot prompt to `nonInteractive` sessions. It clears the persisted marker and leaves reviewer/QA re-drive to `VerificationHarness.resumeInterruptedVerifications()` so two prompts cannot race into the same cold reviewer.

In-flight reviewer steps also persist in active verification state. After a gateway restart, `resumeInterruptedVerifications()` tries to recover them through `_tryResumeFromSession()`:

- If the reviewer session still exists, it is re-registered with the team store and wired to a fresh `verification_result` resolver.
- If the restored reviewer is already `idle`, the harness sends the reminder immediately instead of waiting for the long busy-session window.
- If the restored reviewer is still busy, the harness waits for either `verification_result` or actual idle before reminding it. This keeps the harness from interrupting an active turn while making the waiting behavior explicit.
- Reminder dispatch to a cold restored reviewer uses `promptWhenReady()` so the agent has time to load before the prompt timeout starts.
- After a reminder is accepted, the harness waits for `waitForStreaming()` before racing against post-reminder idle, so an already-idle status cannot instantly fail and terminate the reviewer before it reads the reminder.
- If the resume reminder cannot reach the reviewer because of a cold-agent timeout or process/runtime transient, the result is marked as transient and restart-interrupted, not as a hard review failure.
- `_resumeOneVerification()` then re-runs the original `llm-review` step from the workflow definition when context is available.
- If the restart interruption cannot be safely re-run, the gate is left pending so it can be re-signaled instead of being marked failed for an infrastructure interruption.

Live `nonInteractive` sessions that are not referenced by active verification state are surfaced deterministically during boot resume. The harness asks `SessionManager.listOrphanedNonInteractiveSessions()` before any long resume wait and logs the orphaned reviewers; operators can inspect and terminate stale records through Settings → Maintenance or the `/api/maintenance/orphaned-sessions` and `/api/maintenance/cleanup-sessions` routes. A late `verification_result` from these orphaned sessions has no pending resolver, so surfacing is safer than silently waiting for timeout cleanup.

Archived reviewer rows have an additional bucketing contract: verifier sessions are goal-owned even when old persisted metadata only has `goalId`, and transcript-bearing review/QA output must stay reachable while empty failed-startup placeholders stay out of standalone archive lists. See [Reviewer Archive Cleanup](reviewer-archive-cleanup.md) for the SessionStore backfill, sidebar fallback order, and pre-startup metadata stamping rules.

This preserves the distinction between "the reviewed work is bad" and "the reviewer was interrupted by the gateway/runtime."

## Exhausted recovery diagnostics

When bounded `llm-review` recovery is exhausted, or when the reviewer ignores the reminder, the failed step output gets a markdown diagnostics block:

```markdown
## Recovery diagnostics
- Attempted retries: <n>
- Final error class: provider-backoff | transient | generic-runtime | missing-verification-result | deterministic
- Reviewer ignored reminder: yes | no
```

Provider-backoff timeouts also include a suffix describing the active provider backoff state and retry attempts when that information is available from the session snapshot.

## Maintainer map

| Area | Primary symbols |
|---|---|
| Error classification | `isTransientReviewError`, `isProviderBackoffError`, `isRetryableGenericAgentError` |
| Verification retry decision | `shouldRetryVerificationStep`, `verificationRetryDelayMs` |
| Session auto-retry | `SessionManager.maybeAutoRetryTransient()` |
| Live reviewer path | `VerificationHarness.runLlmReviewViaSession()` |
| Fresh session id per attempt | bounded retry loop in `verifyGateSignal` (mints `llm-review-<uuid>` on attempts 2..N) |
| Transcript-clobber guard | `SessionManager.createSession()` (`opts.sessionId` + `opts.allowSessionReuse`) |
| In-session reminders | `MAX_REVIEWER_REMINDERS`, `REVIEWER_REMINDER_STREAM_SETTLE_MS`, `REVIEWER_REMINDER_LATE_VERDICT_SETTLE_MS` |
| Late-verdict capture | `capturingResolver` / `capturedVerdict` / `hardFailureNoResult` in `runLlmReviewViaSession()`; teardown order in its `finally` |
| Verdict POST channel | `POST /api/internal/verification-result` (`pendingResults` lookup) in `server.ts` |
| Errored-turn grace | `waitForReviewerErroredTurnRecovery()` |
| Restart resume | `_tryResumeFromSession()`, `_rerunLlmReviewStep()`, `resumeInterruptedVerifications()` |
| Reminder race guard | `SessionManager.waitForStreaming()` |
| Exhaustion diagnostics | `appendLlmReviewRecoveryDiagnostics()` |
| Greppable log prefixes | `[verification][reviewer-lifecycle]`, `[session-manager][session-id-clobber]` |

## Tests and commands

Relevant unit coverage:

- `tests/verification-logic.test.ts` — socket/WebSocket/process classifiers, generic runtime retry, deterministic non-retryable failures, provider backoff classification, retry decisions.
- `tests/transient-review-error.test.ts` — legacy transient review classifier coverage.
- `tests/auto-retry-policy.test.ts` — session-level auto-retry policy and schedules.
- `tests/verification-reminder-race.test.ts` — reminder `waitForStreaming()` guard and post-reminder transient recovery ordering.
- `tests2/core/verification-harness-review-reliability.test.ts` — fresh session id per from-scratch attempt (attempt 1's transcript preserved), late-`verification_result`-during-teardown honored (not 404-dropped), and the "did not call after reminder" non-transient classification.
- `tests2/core/session-id-clobber-guard.test.ts` — `createSession` refuses to clobber a live session id, while `allowSessionReuse` bypasses the guard for the sanctioned resume path.
- `tests/verification-resume-restart-prompt.test.ts` — cold restart resume prompt timeout routes to pending instead of hard failure.
- `tests/verification-resume-restart-recovery.test.ts` — cold reviewer readiness wait and transient resume failure rerun path.
- `tests/reviewer-archive-metadata.test.ts` — verifier metadata persistence before startup and legacy SessionStore backfill.
- `tests/ui-fixtures/sidebar-archived-fixture.spec.ts` — archived verifier bucketing and transcript/placeholder fallback visibility.

Focused checks while changing this area:

```bash
npx tsx --test tests/verification-logic.test.ts tests/transient-review-error.test.ts tests/verification-reminder-race.test.ts tests/verification-resume-restart-prompt.test.ts tests/verification-resume-restart-recovery.test.ts tests/reviewer-archive-metadata.test.ts
npx playwright test tests/ui-fixtures/sidebar-archived-fixture.spec.ts
```

Full required checks for production changes in this area:

```bash
npm run check
npm run test:unit
npm run test:e2e
```
