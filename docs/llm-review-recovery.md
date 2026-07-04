# llm-review Recovery

`llm-review` verification steps run a dedicated reviewer session and wait for that session to call `verification_result`. This makes review output visible and restartable, but it also means the gate depends on agent-runtime infrastructure: sockets, WebSockets, provider streams, the child agent process, and the gateway restart path.

The recovery policy treats infrastructure failures as recoverable before it marks the gate failed. A real review finding should fail fast; a transient runtime failure should get a bounded retry window; provider overload should wait longer without a tight loop.

## Recovery layers

Recovery happens at two layers:

1. **Session-level auto-retry** — `SessionManager.maybeAutoRetryTransient()` retries the reviewer turn that just errored. It uses the same continuation-safe path as the manual Retry button, so tool side effects are not blindly replayed.
2. **Verification-step retry** — `VerificationHarness` re-runs the `llm-review` step when the session still returns a retryable failure after the turn-level recovery window.

The layers are deliberately separate. Session auto-retry preserves the current reviewer context when possible. Step retry is the fallback when the current reviewer cannot recover cleanly.

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

## Reminder-first behavior

An idle reviewer that simply forgot to call `verification_result` is reminded before the gate fails.

Live `llm-review` sessions use this order:

1. Wait for the initial reviewer turn to finish or call `verification_result`.
2. If the turn errored, run the errored-turn recovery path above.
3. If the turn ended cleanly without the tool call, send a reminder:
   - a targeted JSON/tool-validation retry prompt when the last tool call failed validation;
   - otherwise a context-rich reminder that reattaches the kickoff context.
4. Wait for `waitForStreaming()` before starting the post-reminder idle race.
5. If the reminder turn goes idle without `verification_result`, check post-reminder transient recovery before declaring the reminder ignored.

The `waitForStreaming()` guard is important. Without it, `waitForIdle()` can resolve against the already-idle state immediately after the reminder is queued, causing the harness to fail and terminate the reviewer before the reminder turn starts. This race is pinned by `tests/verification-reminder-race.test.ts`.

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
| Errored-turn grace | `waitForReviewerErroredTurnRecovery()` |
| Restart resume | `_tryResumeFromSession()`, `_rerunLlmReviewStep()`, `resumeInterruptedVerifications()` |
| Reminder race guard | `SessionManager.waitForStreaming()` |
| Exhaustion diagnostics | `appendLlmReviewRecoveryDiagnostics()` |

## Tests and commands

Relevant unit coverage:

- `tests/verification-logic.test.ts` — socket/WebSocket/process classifiers, generic runtime retry, deterministic non-retryable failures, provider backoff classification, retry decisions.
- `tests/transient-review-error.test.ts` — legacy transient review classifier coverage.
- `tests/auto-retry-policy.test.ts` — session-level auto-retry policy and schedules.
- `tests/verification-reminder-race.test.ts` — reminder `waitForStreaming()` guard and post-reminder transient recovery ordering.
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
