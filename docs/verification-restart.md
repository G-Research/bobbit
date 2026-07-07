# Restart-safe command gate verification

Command-based gate verification runs project checks such as type-checks, unit tests, and browser E2E suites from the goal worktree. Those commands can outlive a gateway process, so Bobbit treats them like other durable runtime work: the process identity, logs, and exit status are persisted before the command can continue independently.

This page covers command steps. Reviewer and QA agent resume uses the session restore path; see [llm-review Recovery](llm-review-recovery.md) and [cold restart re-prompting](cold-restart-reprompt.md).

## Why this exists

A gateway restart is infrastructure noise, not a command verdict. Before restart-safe command recovery, a restart could leave Bobbit with a persisted `running` step but no live child-process handle. Recovery then sometimes fabricated a failed command row such as “process died during gateway restart,” and downstream never-run review phases were rendered as failed placeholders.

The current contract is stricter:

- if Bobbit has a durable exit status, it finalizes the step from that status;
- if the command is still alive, Bobbit reattaches only after proving the PID belongs to the recorded command;
- if no durable command verdict can be recovered, the gate stays retryable/pending instead of becoming a fake command failure.

## Durable state written for command steps

For restart-recoverable command steps, `VerificationHarness` persists an `ActiveVerification` record to `active-verifications.json` and keeps it updated with command metadata:

- `pid`, `startTimeMs`, `deadlineMs`, and `timeoutSec`;
- stdout/stderr log paths (`outFile`, `errFile`);
- an atomic exit-code file path (`exitFile`);
- process identity paths and tokens (`pidFile`, `pidNonce` / `nonce`, `heartbeatFile`, `processStartToken`);
- command semantics needed to evaluate the verdict (`expectFailure`, `errorPattern`, `commandCwd`);
- restart support mode (`restartRecoveryMode`, `restartRecoveryUnsupportedReason`);
- cancellation/timeout cleanup state (`killRequestedAt`, `killReason`, `killSignal`, `killAttempts`, `killCompletedAt`, `killUnsafeReason`).

The active-verification file is written through a temp file and rename, so a restarted gateway sees either the previous complete snapshot or the new complete snapshot.

The detached wrapper writes the live process evidence:

- stdout and stderr append to retained log files from the beginning of execution;
- a pidfile records the wrapper PID plus a random nonce;
- a heartbeat file is refreshed while the wrapper is alive;
- the real child exit code is written to a temp exit file and atomically renamed into place.

The wrapper runs the user command in a subshell so `exit N` from the command cannot skip the exit-file write.

## Resume algorithm

On boot, `resumeInterruptedVerifications()` reloads `active-verifications.json` and resumes each running command step.

### 1. Exit file present

If the exit file exists, Bobbit treats it as a real command verdict. It reads the retained stdout/stderr tail, applies the same `expect: failure` and `error_pattern` semantics as the live path, finalizes the step, and stores diagnostics.

### 2. Process still running with verified identity

If no exit file exists, Bobbit tries to prove that the recorded PID still belongs to the command:

- the pidfile nonce must match the persisted nonce;
- the pidfile PID must match the persisted identity rules for the platform;
- the process must still be alive;
- on platforms with an OS process start token, the current token must match the persisted token;
- otherwise, a fresh matching heartbeat or freshly-written identity file must prove this is the current command, not a reused PID.

Only after that proof does Bobbit reattach file tailers and poll for the exit file until the original deadline. Output written before, during, and after the restart remains in the retained log files and can still be streamed or inspected.

### 2b. Container command steps (durable in-container recovery)

Docker-sandboxed goals run command steps through `docker exec`. Because the container filesystem is separate from the host, the durable evidence lives **inside** the container: the wrapper writes a pidfile, a refreshed heartbeat, and an atomic exit-code file under `/tmp/.bobbit-verif/<signalId>/<stepIndex>.{pid,heartbeat,exit}`. The attached `docker exec` pipe is kept for live output streaming, and the host `docker exec` client is `unref`'d and marked restart-survival so a graceful shutdown does not tear the in-container job down before it records its exit code.

`decideCommandRecoveryMode()` classifies these steps as `container-exec`. On resume, `_resumeContainerCommandStep()` re-attaches via `docker exec` (host `fs` cannot read the in-container files):

- read the in-container exit file (`docker exec … cat <exitFile>`) — if present, finalize from that exit code with the same `expect: failure` / `error_pattern` semantics;
- otherwise, while the in-container heartbeat is fresh and the deadline has not passed, poll for the exit file;
- on deadline, kill the in-container process group via `docker exec … kill -TERM/-KILL -- -<pgid>` (a host-side tree-kill of `docker exec` does not reach in-container descendants) and return the timeout result;
- if the job stopped without a durable verdict, return a retryable pending interrupt — never a fabricated failure.

### 3. No durable verdict or unsafe identity

If Bobbit cannot recover an exit file and cannot safely prove process identity, it records an explicit restart-interrupted row rather than a failed command verdict. The step remains `status: "waiting"` with output explaining that no durable command verdict was obtained, and the gate status is left `pending` so the team lead can re-signal.

This path is used for true no-verdict interruptions, stale or mismatched pidfiles, stale heartbeats, PID-reuse suspicion, and attached/container command paths that do not yet provide restart-safe process identity.

## Timeout and cancellation cleanup

Timeouts and cancellations are restart-safe too. Before Bobbit signals a command tree, it persists kill intent on the active verification. Cleanup is not considered complete until Bobbit verifies one of these outcomes:

- the exit file appeared and the command can be finalized normally;
- the verified command process is gone;
- a verified timeout kill completed and the step can be finalized as timed out.

If identity cannot be proven, Bobbit refuses to kill the numeric PID because it may belong to an unrelated process. The active-verification entry remains on disk with `killRequestedAt` and `killUnsafeReason`, and cleanup is retried after restart or when the pidfile/heartbeat appears. This avoids both unsafe kills and silent orphaning.

## Logs and artifacts after restart

Command logs are retained under Bobbit state and exposed through the normal gate inspection tools:

```text
gate_status(gate_id="implementation")
gate_inspect(gate_id="implementation", section="verification", step="E2E tests", mode="grep", pattern="error|failed", context=3)
gate_inspect(gate_id="implementation", section="verification", step="E2E tests", mode="tail", lines=200)
gate_inspect(gate_id="implementation", section="verification", step="E2E tests", mode="slice", from=120, to=220)
```

Default status and implicit inspection stay compact. Explicit `gate_inspect` modes read retained stdout/stderr with bounded tails, grep, head, slice, or full selection. Playwright-style artifacts are retained with the same diagnostics model documented in [Retained gate diagnostics](gate-diagnostics.md).

## Phase and notification semantics

Phases keep their normal meaning during restart recovery:

- a recovered command success lets Bobbit continue later waiting phases through normal verification;
- a recovered real command failure skips later never-run phases as `status: "skipped"`, `skipped: true`, with output `"Skipped — earlier phase failed"`;
- a no-verdict restart interruption is not a real failed phase, so downstream waiting rows are not converted into fake failures.

Team-lead failure notifications list only real failed steps. Skipped downstream rows and restart-interrupted no-verdict rows are omitted, so notifications do not include `gate_inspect` commands for steps that never ran.

## Unsupported and degraded paths

Restart-safe recovery depends on a detached wrapper that can write durable identity and exit files.

- **Windows without Git Bash** runs command steps through an attached `cmd.exe` shell, which cannot execute the bash exit-file wrapper. `decideCommandRecoveryMode()` classifies these as `pending-retry`: the step still runs, but a gateway restart cannot recover its exit code, so recovery leaves the gate **pending/retryable** (re-run on the next signal), never a fabricated verdict and never a hard "unsupported" failure.
- **Container command steps** are now restart-recoverable via durable in-container files and `docker exec` re-attach (see [§2b](#2b-container-command-steps-durable-in-container-recovery)). Recovery finalizes from the in-container exit code, or falls back to pending/retryable if the in-container job stopped without one.
- **Host reboot** is outside this guarantee. If the host itself stops, detached children and their heartbeats stop too; Bobbit can only use any exit/log files already written.

## Session-backed steps: cold-reviewer re-run

Reviewer (`llm-review`) and QA (`agent-qa`) steps resume by re-attaching to the restored reviewer session. Under N-way parallel session restore a freshly revived reviewer is *cold* (model + MCP init) and can miss the readiness window, producing reasons like "did not call verification_result after server restart", "timed out while resuming after server restart", or "Session lost during server restart". These are **re-runnable**, not genuine failures.

`shouldRerunSessionStepOnResume(reason)` (in `verification-logic.ts`) recognises these cold-reviewer / readiness / lost-session reasons and returns `true`, so `_resumeOneVerification` **deterministically re-runs the step from scratch** (`_rerunLlmReviewStep` / `_rerunAgentQaStep`) instead of leaving a terminal restart-interrupt. Genuinely unrecoverable reasons (workspace/container removed or deleted) return `false` and keep the pending/re-signal path. The restart-interrupt *suppression* guarantees (`shouldSuppressRestartInterrupt` / `RESTART_INTERRUPT_MARKERS`) are preserved, so a restart still never fabricates a phantom gate failure.

The net effect across all step types — command (incl. Docker), llm-review, agent-qa — is that a gateway restart mid-verification resumes to a real verdict or a clean re-run; the "interrupted by a server restart and could not be recovered" nudge is now the rare exception, not the default.

## Stale verification reconciliation (UI)

Server truth derives whether a verification is `running` live from the in-memory `activeVerifications` map, so it flips the instant an entry is removed. The UI live renderer, by contrast, was a WebSocket state machine whose only exit from `running` was a `gate_verification_complete` event — if that event never arrived (harness died, server restart, dropped WS), it spun forever.

Two changes fix this:

- **Server liveness in the snapshot.** `buildGateVerificationSnapshot()` accepts `isActiveVerificationAlive` (callers pass `areVerificationSessionsAlive(signalId)`). A matching-but-dead active entry is ignored for liveness, the snapshot is flagged `stale: true`, and its top-level `status` is never reported as `running`. `stale` is surfaced on the gate-detail summary and inspect responses.
- **Client reconciliation.** `GateVerificationLive` reconciles against the authoritative REST snapshot on a repeating interval and on tab-visibility / connectivity regain (not just once at mount). When persisted state says running but the authoritative active-verifications endpoint holds no live entry, the renderer transitions to a terminal **stale** state with a "Re-signal gate" affordance instead of a perpetual spinner. The goal dashboard's live map applies the same reconciliation.

## Slim gate-list payload

`GET /api/goals/:id/gates` (non-summary) previously returned the entire signal history with full inline step output, artifact bodies, and diagnostics — a payload growing unbounded with gates × signals × steps that the dashboard re-serialized every poll tick. `projectGateForList()` (in `gate-status-summary.ts`) now returns a slim projection: step `output` is blanked and `artifact.content` / `diagnostics` are dropped (step metadata and `artifact.contentType`/`metadata` are preserved). Full step text is still fetched lazily on expand via the gate-detail / `gate_inspect` / verification-snapshot paths, which are unchanged. The dashboard's gate poll also compares a compact `gateId:status:updatedAt:signalCount` signature instead of double-`JSON.stringify`, and pauses while the tab is hidden.

## Code map

| Area | Where to look |
|---|---|
| Active verification persistence and resume | `src/server/agent/verification-harness.ts` (`ActiveVerification`, `resumeInterruptedVerifications`, `_resumeCommandStep`) |
| Container durable recovery | `_resumeContainerCommandStep`, `_dockerExecCapture`, `runCommandStep` container branch |
| Recovery-mode classification / cold-reviewer re-run | `decideCommandRecoveryMode`, `shouldRerunSessionStepOnResume` (`src/server/agent/verification-logic.ts`) |
| Verification snapshot liveness / stale flag | `buildGateVerificationSnapshot` (`src/server/gate-verification-snapshot.ts`), `areVerificationSessionsAlive` |
| Slim gate-list projection | `projectGateForList` (`src/server/gate-status-summary.ts`) |
| Live renderer reconcile + stale UI | `src/ui/tools/renderers/GateVerificationLive.ts`, `src/app/goal-dashboard.ts` |
| Command spawn wrapper and file tailing | `runCommandStep`, `_startFileTailers` |
| Process identity checks | `_readCommandIdentityFile`, `_verifyPersistedCommandIdentity`, `readProcessStartToken` |
| Timeout/cancel cleanup | `_markPersistedCommandKillIntent`, `_killPersistedCommandSteps`, `_killVerifiedCommandStepForTimeout` |
| Failure notification filtering | `src/server/agent/notify-team-lead-failure.ts` |
| Pure verification semantics | `src/server/agent/verification-logic.ts` |
| Retained diagnostics | `src/server/agent/gate-diagnostics.ts`, [gate-diagnostics.md](gate-diagnostics.md) |

Primary regression coverage lives in `tests/verification-command-restart-lifecycle.test.ts`, `tests/verification-command-restart-regression.test.ts`, and `tests/verification-harness-restart.test.ts`. The gate-verification UX fixes (slim projection, snapshot liveness/stale, recovery classification, cold-reviewer re-run) are pinned by `tests/gate-verification-ux.test.ts`, with browser regressions in `tests/e2e/ui/gate-list-slim-projection.spec.ts` and `tests/e2e/ui/gate-verification-stale-reconcile.spec.ts`. Real restart-mid-verification behaviour against a live gateway + Docker belongs in `test:manual`.
