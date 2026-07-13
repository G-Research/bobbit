# Review-agent timeout contract

## Status and scope

This design covers the `llm-review` and `agent-qa` timeout/recovery work in the **Timeout contract and recovery** subgoal. It deliberately does not change command/build timeout policy and does not remove the legacy direct-review fallback; removal belongs to the separate direct-path subgoal.

The incident behind this change involved reviewers that were still investigating when the undocumented 600-second allowance expired. The fix is not a whole-step deadline. It is a larger, explicit, repeatable allowance for each active review turn.

## Contract

### Resolved allowance

Add these review-only exports in `src/server/agent/verification-harness.ts`, beside `DEFAULT_COMMAND_STEP_TIMEOUT_SEC` without changing either command constant:

```ts
export const DEFAULT_LLM_REVIEW_TIMEOUT_S = 1200;
export const MIN_LLM_REVIEW_TIMEOUT_S = 1;
```

Add an exported pure resolver, `resolveReviewStepTimeoutSec()`, and make it the only server-side review timeout resolver. Its inputs are the step type, optional workflow `timeout`, and (for `agent-qa`) the derived QA duration. Resolution order is:

1. If `step.timeout` is a finite positive integer, it wins for both `llm-review` and `agent-qa`. It may be shorter than 1200 seconds. This is the only way to opt out of the active-session 1200-second floor.
2. If a positive finite value is fractional because it came from a non-UI caller, floor it to whole seconds and clamp it to `MIN_LLM_REVIEW_TIMEOUT_S`. Workflow authoring and the editor continue to require positive integers.
3. A non-finite, zero, or negative value is invalid and is treated defensively as omitted by the runtime resolver; workflow validation/UI should reject it before execution. Falling back is safer than accidentally converting malformed input into a one-second kill window.
4. For `llm-review` with no explicit timeout, return `DEFAULT_LLM_REVIEW_TIMEOUT_S`.
5. For `agent-qa` with no explicit timeout, retain component QA configuration as a derived default, but apply the shared review floor: return `max(DEFAULT_LLM_REVIEW_TIMEOUT_S, (qa_max_duration_minutes + 5) * 60)`. Thus the normal 10-minute QA duration plus five-minute setup/teardown buffer resolves to 1200 seconds, while a project configured for 30 minutes still gets 2100 seconds. An explicit workflow timeout always overrides this derived value, including an explicitly shorter value.

This precedence removes the current `Math.max(qaTimeoutMs, (step.timeout || 900) * 1000)` bug in `runAgentQaStep()`, which prevents authors from intentionally selecting a shorter QA timeout.

The following stay unchanged:

- `DEFAULT_COMMAND_STEP_TIMEOUT_SEC = 300`
- `DEFAULT_UNIT_COMMAND_STEP_TIMEOUT_SEC = 1200`
- `resolveCommandStepTimeoutSec()` and command restart deadlines
- seeded workflow command/build timeouts
- the generic `SessionManager.waitForIdle()` default

### What an allowance measures

A review timeout is a **per-active-turn allowance**, not a wall-clock deadline for the whole verification step.

- A from-scratch attempt receives the full resolved allowance after its kickoff is dispatched.
- Every same-session reminder receives a fresh full allowance after the reminder starts streaming.
- Every restart continuation/reminder receives a fresh full allowance.
- Every same-session process-death resurrection cycle receives a fresh full allowance after its continuation starts streaming.
- A session auto-retry receives a fresh full allowance after the retry turn starts streaming.
- A step-level retry creates a fresh session and receives a fresh full allowance.

Setup, model selection, readiness waits, prompt dispatch, retry backoff, and short post-turn flushes do not reduce the active streaming allowance. `duration_ms` remains the total step duration and can therefore exceed `timeout * 1000` after multiple attempts, reminders, recovery cycles, and provider waits.

### Active-session floor

With no explicit workflow timeout, an actively streaming review turn must not be terminated before 1200 seconds of active-turn allowance has elapsed. If an omitted `agent-qa` timeout resolves higher because of component QA configuration, that higher resolved value is its floor.

An explicit valid timeout is authoritative and may be shorter. For example, `timeout: 45` gives every active attempt/reminder/recovery turn 45 seconds. The absolute supported minimum is one second.

Idle and active are intentionally different:

- A turn that becomes idle without `verification_result` may enter the existing same-session reminder flow immediately.
- A turn that remains streaming/making progress waits its full resolved allowance. Expiry is a timeout, not an idle-without-result failure.
- A fixed streaming-settle wait that observes no `agent_start` does not pretend the reviewer consumed its active allowance.

Use a small internal result race such as `waitForReviewTurn()` to distinguish `result`, real `idle`, and `timeout`. Do not keep patterns like `_tryResumeFromSession()`'s `.catch(() => ({ type: "idle" }))`, because that collapses a timeout into idle and can prompt or terminate a reviewer that was still streaming.

### Provider-overload exclusion

Provider capacity waits are outside the review-thinking allowance. HTTP 429/529 and `overloaded_error`/`rate_limit_error`, classified by `isProviderBackoffError()`, remain effectively unbounded:

- session auto-retry backoff remains capped at five minutes per delay;
- verification-step provider backoff remains capped at 15 minutes per delay and has no attempt cap;
- ordinary retryable failures remain bounded as they are today;
- `REVIEWER_ERRORED_TURN_GRACE_MS = 75_000` remains unchanged;
- `REVIEWER_PROVIDER_BACKOFF_GRACE_MS = 330_000` remains unchanged.

Add a contract comment next to these grace constants and `verificationRetryDelayMs()` stating that provider-backoff delay/grace is deliberately outside the per-active-turn allowance and must not be folded into a whole-step deadline. The 75/330-second values bound waiting for a retry turn to begin; once streaming begins, that turn receives the full resolved allowance.

A provider-backoff attempt must not become a terminal timeout merely because the provider wait exceeded 1200 seconds. It stays on the existing unbounded provider retry path. Cancellation and goal completion still stop it.

### Fixed operational windows

These are coordination/flush windows, not review-thinking budgets, and remain fixed:

- `REVIEWER_REMINDER_STREAM_SETTLE_MS = 15_000`
- `REVIEWER_REMINDER_LATE_VERDICT_SETTLE_MS = 20_000`
- restart reminder `waitForStreaming(..., 10_000)`
- successful-result terminal `waitForIdle(..., 30_000)`
- cold-agent readiness/prompt transport timeouts owned by `promptWhenReady()`
- 75/330-second errored-turn start grace described above

The fixed streaming-settle window runs before the fresh active allowance. The short late-verdict and terminal-idle windows run after the active turn and do not extend or shrink its allowance.

## Server implementation

### `src/server/agent/verification-harness.ts`

#### Resolution and initial execution

- Add `DEFAULT_LLM_REVIEW_TIMEOUT_S`, `MIN_LLM_REVIEW_TIMEOUT_S`, and `resolveReviewStepTimeoutSec()` near the existing command timeout resolver.
- In `runLlmReviewStep()`, replace `(step.timeout || 600) * 1000` with the shared resolver.
- In `runAgentQaStep()`, compute the existing component-derived QA duration, then call the shared resolver using the precedence above. Remove the current explicit-timeout-loses-to-QA-floor `Math.max` behavior.
- Replace the `step.timeout ?? 600` lifecycle-log fallbacks in the main `llm-review` retry loop with the resolved value/constant. Add the resolved timeout to the analogous `agent-qa` lifecycle log.
- Store the resolved seconds in `ActiveVerification.steps[index].timeoutSec` before starting the session and include `timeoutSec` in `gate_verification_step_started`. The field already exists for command recovery; document that it now also records the resolved allowance for review-agent restart recovery.
- Keep the fresh session ID per from-scratch retry. Resolve the same workflow step on every retry, but start a new per-attempt timer rather than carrying elapsed time from the prior attempt.

#### Live session and reminder paths

Update `runLlmReviewViaSession()` and `runAgentQaStep()` so their result races distinguish timeout from idle:

1. Dispatch kickoff.
2. Race `verification_result` against actual idle with the full resolved allowance.
3. If the active wait expires, return a timeout result immediately; do not classify it as idle and send a reminder.
4. If real idle occurs without a result, run `waitForReviewerErroredTurnRecovery()` if needed, then send the existing reminder.
5. For each reminder, retain the fixed 15-second `waitForStreaming` settle. When streaming is observed, start a **new full resolved allowance** for the result/idle race. Do not subtract the 15 seconds or time spent in a previous reminder.
6. Retain the fixed 20-second late-verdict settle and 30-second successful-result flush.

`waitForReviewerErroredTurnRecovery()` keeps the 75/330-second start grace. Once the retry is streaming, its `waitForIdle()` receives the full resolved timeout rather than a remaining whole-step budget.

#### Same-session process recovery

`recoverVerifierAfterProcessDeath()` currently creates one deadline and subtracts the 15-second settle plus all resurrection attempts from a shared budget. Replace that shared deadline/`remainingMs()` model:

- Each of the at most `MAX_VERIFIER_SAME_SESSION_RESURRECTIONS` attempts is a fresh recovery cycle.
- Readiness, restart, prompt dispatch, and the fixed 15-second stream-settle happen outside the active allowance.
- If streaming begins, race result/idle/timeout with the full resolved allowance.
- If that turn errors, call errored-turn recovery with the resolved allowance and unchanged 75/330 start grace.
- Keep the 20-second late-verdict settle fixed.
- Stop issuing resurrection prompts once the process is alive but idle without a verdict, preserving the existing duplicate-prompt guard.

This intentionally supersedes the current documentation claim that all resurrection attempts share one original timeout budget. The locked contract is a fresh allowance per recovery cycle.

#### Restart resume

`_tryResumeFromSession()` must resolve its allowance in this order:

1. use persisted `ActiveVerification.steps[].timeoutSec` when present;
2. otherwise find the frozen step with `_findStepDefinition(v.goalId, v.gateId, step.name)` and call `resolveReviewStepTimeoutSec()` (including agent-QA component precedence);
3. for a legacy persisted active row whose step definition cannot be found, fall back to `DEFAULT_LLM_REVIEW_TIMEOUT_S`.

Replace only the review-budget literals:

- initial busy restored-session `waitForIdle(..., 180_000)`
- initial `waitForReviewerErroredTurnRecovery(..., 180_000)`
- post-resume-reminder `waitForIdle(..., 120_000)`
- post-resume-reminder recovery `(..., 120_000)`
- post-continuation fallback `waitForIdle(..., 120_000)`
- post-continuation fallback recovery `(..., 120_000)`

Each of those active/recovery turns receives the resolved allowance as a fresh window. Preserve the restart `waitForStreaming(..., 10_000)` and successful-result `waitForIdle(..., 30_000)` literals.

Persisted `startedAt` remains audit/UI timing; it is not used to subtract gateway downtime from the fresh recovery allowance.

#### Legacy direct path

Do **not** delete `runLlmReviewDirect()` or its routing call in this subgoal. It receives `timeoutMs` from `runLlmReviewStep()`, so moving timeout resolution to the shared resolver automatically raises its default and honors explicit shorter values. Keep its initial and reminder completion timers as separate fresh allowances. Add timeout metadata to its timeout return so it does not bypass marker propagation while it still exists.

Deletion and no-`SessionManager` fail-fast behavior are owned by the separate direct-path subgoal.

## Timeout marker and payload contract

Define and export a single server payload type in `src/server/agent/gate-store.ts`:

```ts
export interface VerificationTimeoutInfo {
  configuredSeconds: number;
  elapsedMs: number;
}
```

A terminal review timeout has all of these properties:

```ts
{
  passed: false,
  status: "timeout",
  timeout: {
    configuredSeconds: 1200,
    elapsedMs: 1200000
  },
  duration_ms: 1200000, // total step duration; may be larger after retries
  output: "LLM review timed out after 1200s."
}
```

`status: "timeout"` is the machine-readable terminal marker. `timeout` carries the configured per-turn allowance and elapsed duration for the particular turn that expired. `duration_ms` remains total step elapsed time and must not be repurposed as the timeout-cycle elapsed value.

Only real allowance expiry sets the marker. Idle-without-result, deterministic findings, process death before allowance expiry, cancellation, and provider backoff do not.

Propagate the fields through these exact types and construction points:

- `src/server/agent/verification-harness.ts`
  - internal review result shapes returned by `runLlmReviewStep()`, `runLlmReviewViaSession()`, `runAgentQaStep()`, `runLlmReviewDirect()`, `_tryResumeFromSession()`, `_rerunLlmReviewStep()`, `_rerunAgentQaStep()`, and process recovery;
  - `ActiveVerification.steps[]`: add terminal `timeout?: VerificationTimeoutInfo`; extend `status` with `"timeout"`; keep `timeoutSec` for the running resolved allowance;
  - `ResumedVerificationStep`, `TerminalGateSignalStepStatus`, `terminalStatusForStep()`, and `persistedStatusForStep()`;
  - `gate_verification_step_started`: `timeoutSec?: number`;
  - `gate_verification_step_complete`: `status: "timeout"` and `timeout?: VerificationTimeoutInfo`;
  - active-state persistence and both normal and resumed `GateSignalStep` builders.
- `src/server/agent/gate-store.ts`
  - `GateSignalStep.status` adds `"timeout"`;
  - `GateSignalStep.timeout?: VerificationTimeoutInfo`.
  - Gate verification and gate outcome remain `failed`; `passed` remains `false`.
- `src/server/ws/protocol.ts`
  - extend the started event with `timeoutSec?: number`;
  - extend the complete-event status union with `"timeout"` and add `timeout?: VerificationTimeoutInfo`.
- `src/server/gate-verification-snapshot.ts`
  - add `"timeout"` to `GateVerificationSnapshotStatus` and counts;
  - add `timeout?: VerificationTimeoutInfo` to `GateVerificationSnapshotStep`;
  - copy active/persisted timeout metadata to the snapshot;
  - treat timeout as a prior failure for phase blocking and aggregate gate semantics.
- `src/app/api.ts`
  - add `"timeout"` to the gate signal step status union;
  - add the matching `timeout` object to the gate signal step type.
- `src/app/goal-dashboard.ts`
  - retain `timeoutSec` on start and `timeout` on completion in `LiveVerification.steps[]`, so live consumers do not lose the fields.

The outbound sanitization in `sanitizeVerificationWsEvent()` may truncate `output`, but it must preserve status and timeout metadata unchanged.

The later timeout-rendering subgoal can consume this contract directly in `GateInspectRenderer.ts` and `GateVerificationLive.ts`; it must not string-match `output`.

## Workflow editor UX

### `src/app/workflow-page.ts`

The timeout field in `renderVerifyStepCard()` is shared by command and review-agent steps, so make both placeholder and help type-aware:

- `command`: placeholder `300`; hint explains the generic 300-second command default and that component `command: unit` defaults to 1200 seconds.
- `llm-review`: placeholder `1200`; hint: “Empty = 1200s per active attempt/reminder/recovery turn. Provider backoff is excluded.”
- `agent-qa`: placeholder `1200`; hint adds that a higher component `qa_max_duration_minutes + 5m` derived default can raise the omitted value, while an explicit positive integer overrides it and may be shorter.
- `human-signoff`: continue hiding the timeout field.

Keep `min="1"`, `step="1"`, integer normalization, and hidden-field cleanup. Add accessible explanatory text via the existing `.wf-field-hint`; do not rely on placeholder text as the only contract explanation.

## Documentation changes

The implementation/documentation phase updates all three requested documents; this design artifact does not edit them.

### `docs/llm-review-recovery.md`

- Add a dedicated timeout-contract section defining default 1200 seconds, the one-second absolute minimum, agent-QA resolution precedence, explicit-shorter override, and fresh per-attempt/reminder/recovery semantics.
- Define active streaming versus idle-without-result behavior.
- Replace “Same-session resurrection shares the original verifier step timeout as one remaining budget” with the fresh per-recovery-cycle contract.
- Explain that 15/20/10/30-second operational settle/flush windows are fixed and outside the active allowance.
- Preserve and explicitly explain 75/330-second runtime-error grace.
- State that provider overload/backoff is excluded and effectively unbounded.
- Document `status: "timeout"` and `timeout.configuredSeconds`/`timeout.elapsedMs` as the durable/live machine contract.

### `docs/goals-workflows-tasks.md`

- Keep the command bullet's 300/1200 command defaults unchanged.
- Expand the `llm-review` and `agent-qa` bullets with the 1200-second omitted default/floor, one-second minimum, explicit override, per-turn semantics, and provider exclusion.
- Correct the current QA timeout paragraph: omitted QA timeout is the maximum of 1200 seconds and component duration plus five minutes; explicit workflow timeout wins even when shorter.
- Update Workflow editor authoring text to describe the type-aware placeholder/help.

### `defaults/workflow-authoring-guide.md`

- Replace the generic “default 300s” timeout table entry with type-specific rules: command 300 seconds (unit command 1200), review agents 1200 seconds, agent-QA derived-default precedence, explicit-shorter behavior, and one-second minimum.
- Define timeout as per active attempt/reminder/recovery turn, not total step elapsed time.
- Note provider backoff exclusion and recommend a larger explicit timeout for unusually large diffs or long QA scenarios.

## Focused test plan

All new files must be registered in `tests2/tests-map.json` under `v2Native` with a concise invariant-focused reason.

### Unit: `tests2/core/verification-review-timeout-contract.test.ts`

Use fake clocks/session managers; no real LLM or long wait.

1. **Resolution/default and floor**
   - omitted `llm-review` resolves to 1200;
   - omitted default-config `agent-qa` resolves to 1200;
   - larger QA component duration raises the omitted QA value;
   - explicit agent-QA/LLM timeout wins even below 1200;
   - fractional positive values floor and clamp to one second;
   - invalid non-positive/non-finite values defensively fall back;
   - `resolveCommandStepTimeoutSec()` still returns 300/1200 exactly as before.
2. **Active streaming floor**
   - default active reviewer `waitForIdle` receives 1,200,000 ms and is not terminated earlier;
   - explicit `timeout: 7` receives 7,000 ms;
   - timeout is distinct from actual idle and does not enter the reminder path.
3. **Fresh windows**
   - every from-scratch attempt receives the full resolved value;
   - each reminder gets fixed 15-second start settle followed by the full resolved value;
   - each resurrection gets its own full value rather than a decreasing shared budget;
   - fixed 20-second late-verdict and 30-second flush values remain fixed.
4. **Provider exclusion and grace**
   - ordinary errored-turn start wait is 75,000 ms;
   - provider-overload start wait is 330,000 ms;
   - provider backoff continues into retry and does not emit timeout status merely because backoff outlasts the review allowance.
5. **Legacy path preservation**
   - source/runtime assertion that `runLlmReviewDirect()` remains reachable in this subgoal;
   - its initial and reminder timers receive fresh resolved allowances and its timeout return carries metadata.

Extend `tests2/core/verification-verifier-lifecycle-repro.test.ts` only where its old shared-resurrection-budget assertion contradicts the new locked contract; update it to pin fresh per-recovery windows while preserving same-session identity and the alive-idle duplicate-prompt guard.

### Integration: `tests2/integration/verification-review-timeout-payload.test.ts`

Run a real `VerificationHarness` + `GateStore` + snapshot mapping with a deterministic fake reviewer timeout:

- configure a short explicit timeout;
- assert `gate_verification_step_started.timeoutSec`;
- assert completion event `status === "timeout"` and exact `timeout.configuredSeconds`/`elapsedMs`;
- assert the persisted `GateSignal.verification.steps[0]` retains the marker/timing while overall verification/gate outcome is failed;
- assert `buildGateVerificationSnapshot()` returns status/metadata without string matching;
- assert `sanitizeVerificationWsEvent()` preserves the metadata;
- repeat through resume with a custom timeout and prove no review-budget call receives 180,000 or 120,000 ms, while 10,000/30,000 operational calls remain;
- include an omitted-timeout resume fixture for a legacy active row and assert the 1,200,000 ms fallback.

### Existing focused coverage

Run alongside:

- `tests2/core/verification-harness-review-reliability.test.ts`
- `tests2/core/verification-verifier-lifecycle-repro.test.ts`
- `tests2/core/verification-reminder-race.test.ts`
- `tests2/core/verification-resume-restart-prompt.test.ts`
- `tests2/core/verification-resume-restart-recovery.test.ts`
- `tests2/core/gate-verification-snapshot.test.ts`
- `tests2/core/verification-logic.test.ts`

Suggested command:

```bash
npm exec vitest -- run tests2/core/verification-review-timeout-contract.test.ts tests2/integration/verification-review-timeout-payload.test.ts tests2/core/verification-harness-review-reliability.test.ts tests2/core/verification-verifier-lifecycle-repro.test.ts tests2/core/verification-reminder-race.test.ts tests2/core/verification-resume-restart-prompt.test.ts tests2/core/verification-resume-restart-recovery.test.ts tests2/core/gate-verification-snapshot.test.ts tests2/core/verification-logic.test.ts
npm run check
```

## Browser E2E journey

Because the workflow editor help/placeholder is user-facing, add and register `tests2/browser/workflow-review-timeout-editor.spec.ts` (or fold the scenario into the existing workflow editor browser suite if one exists at implementation time):

1. Navigate to Settings → Workflows and customize/create a disposable workflow.
2. Add/select a `command` verification step; expand Advanced and assert timeout placeholder `300` plus command-specific help.
3. Change the step to `llm-review`; assert placeholder `1200` and the per-attempt/reminder/recovery + provider-backoff help.
4. Change it to `agent-qa`; assert the 1200 floor and component-derived QA precedence are explained.
5. Enter an explicit shorter positive integer, save, reload the page, and assert the value persists unchanged.
6. Enter an invalid value (zero/non-integer through browser input mechanics) and assert it cannot be saved as a valid timeout or is normalized according to the existing editor contract.
7. Change to `human-signoff`; assert the timeout field is removed and stale timeout data is not serialized.
8. Restore/delete the disposable workflow override so the journey is isolated and repeatable.

This SG1 browser journey validates authoring UX only. The separate timeout-rendering/control subgoal owns the end-to-end “Timed out” gate card and “Change timeout” scope-picker journey.

## Acceptance criteria

- Review-agent timeout resolution has one 1200-second source of truth and a defined one-second absolute minimum.
- Agent-QA precedence is explicit: valid workflow value wins; otherwise use the maximum of the shared default and component duration plus buffer.
- Default active review turns are never cut off before their resolved floor; explicit shorter values are honored.
- Attempts, reminders, auto-retries, restart continuation/reminders, and resurrection cycles each receive a fresh full allowance.
- Restart review-budget literals 180,000/120,000 are removed; fixed 10/15/20/30-second operations and 75/330-second grace remain.
- Provider backoff remains excluded and unbounded under existing cancellation rules.
- Timeout status and exact configured/per-cycle elapsed timing survive active state, WebSocket completion, gate persistence, app API typing, and gate snapshots.
- Overall gate semantics remain failed for a timed-out step.
- Command/build behavior is unchanged.
- `runLlmReviewDirect()` remains present and functional in this subgoal.
- The three requested docs and type-aware workflow editor are updated during implementation.
- Focused unit/integration tests and the authoring browser journey are registered in `tests2/tests-map.json`.
