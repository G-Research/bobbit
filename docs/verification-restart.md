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

- **Windows without Git Bash** runs command steps through an attached shell. The step still runs, but a gateway restart cannot recover its exit code; recovery leaves the gate pending/retryable with a clear unsupported-path diagnostic.
- **Container command steps** currently use attached `docker exec`. They are guarded the same way: restart/no-verdict recovery is pending/retryable, not a fabricated command failure.
- **Host reboot** is outside this guarantee. If the host itself stops, detached children and their heartbeats stop too; Bobbit can only use any exit/log files already written.

## Code map

| Area | Where to look |
|---|---|
| Active verification persistence and resume | `src/server/agent/verification-harness.ts` (`ActiveVerification`, `resumeInterruptedVerifications`, `_resumeCommandStep`) |
| Command spawn wrapper and file tailing | `runCommandStep`, `_startFileTailers` |
| Process identity checks | `_readCommandIdentityFile`, `_verifyPersistedCommandIdentity`, `readProcessStartToken` |
| Timeout/cancel cleanup | `_markPersistedCommandKillIntent`, `_killPersistedCommandSteps`, `_killVerifiedCommandStepForTimeout` |
| Failure notification filtering | `src/server/agent/notify-team-lead-failure.ts` |
| Pure verification semantics | `src/server/agent/verification-logic.ts` |
| Retained diagnostics | `src/server/agent/gate-diagnostics.ts`, [gate-diagnostics.md](gate-diagnostics.md) |

Primary regression coverage lives in `tests/verification-command-restart-lifecycle.test.ts`, `tests/verification-command-restart-regression.test.ts`, and `tests/verification-harness-restart.test.ts`.
