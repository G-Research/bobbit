# Restart-Safe Gate Commands — Issue Analysis

## 1. Observed failure and impact

Observed incident:

- Goal: `dae9130e-4b4c-44cc-983e-4d189b4fc330`
- Gate: `implementation`
- Signal: `da474e6f-d707-4de1-986d-fe467c62afee`
- Failing phase: phase 2 command step, `E2E tests`
- Reported output: `Verification command process died during gateway restart before producing an exit code.`

The gateway restarted while a command-based verification step was running. On boot, verification recovery found neither a durable command verdict nor a usable live process, so `_resumeCommandStep()` finalized the command as failed. Then `_resumeOneVerification()` also finalized later, never-run phase 3 review steps as failed-looking rows instead of skipped rows. The resulting UI/status/notification implied multiple verification failures even though only one command step had actually been attempted, and even that step had no reliable command verdict.

Impact:

- A gateway restart can convert infrastructure interruption into a gate failure.
- The real command result and log tail can be lost or misclassified.
- Downstream phase rows become misleading failures, creating noisy team-lead notifications and unnecessary inspect commands for steps that never ran.
- The gate can block progress for reasons unrelated to the implementation under test.

## 2. Symptom vs. root cause

The skipped-step rendering/notification problem is a symptom. The root problem is that command verification does not yet have a restart-safe process model comparable to `bash_bg`.

### Symptom

`beginVerification()` seeds all verification steps early. Later-phase steps start as `status: "waiting"`, `passed: false` placeholders in the persisted signal/active state. Normal phased execution later converts downstream phases to explicit skipped results when an earlier phase fails:

- `status: "skipped"`
- `skipped: true`
- `output: "Skipped — earlier phase failed"`

The resume path does not fully replay that phase-finalization logic. In `_resumeOneVerification()`, non-running steps are copied as if they were already terminal. A `waiting` placeholder has neither `skipped: true` nor `status: "skipped"`, and `terminalStatusForStep()` falls back to `passed ? "passed" : "failed"`. That turns never-run later phases into failed rows.

### Root cause

The command step itself should not have been finalized as a command failure just because the gateway restarted. A command verification needs durable ownership of:

- process identity and liveness;
- stdout/stderr retention;
- final exit code or terminal reason;
- timeout/cancel intent;
- recovery state that survives gateway death.

Current command recovery can sometimes recover from an `exitFile`, but if the process is gone and no exit file exists, it fabricates a failed verification step with a restart-attributed message. That is not a real command verdict.

## 3. Current command-step persistence model and precise gaps

Relevant code: `src/server/agent/verification-harness.ts`.

### Current model

`beginVerification()` creates an `ActiveVerification` entry and persists it to `<stateDir>/active-verifications.json` via `_persistActive()`.

For non-container command steps, `runCommandStep()` can enter detached mode when a `streamCtx` exists:

1. Prepare retained stdout/stderr diagnostics paths.
2. Create a per-signal `exitFile` under `<stateDir>/verifications/<signalId>/<stepIndex>.exit`.
3. Wrap the user command as:
   - run command in a subshell;
   - capture `$?`;
   - write the exit code to `exitFile.tmp`;
   - rename to `exitFile`;
   - exit with the same code.
4. Spawn through `spawnTracked()`.
5. Persist fields on the active step: `pid`, `startTimeMs`, `outFile`, `errFile`, `exitFile`, `bootEpoch`, `timeoutSec`, `expectFailure`, `errorPattern`, `commandCwd`.
6. `child.unref()` and `tracked.markSurvival()` so `VerificationHarness.shutdown()`/`killAllTracked()` skips the child during gateway shutdown.
7. Tail stdout/stderr files from the gateway process for live UI output.

On restart, `_resumeCommandStep()` uses three cases:

1. If `exitFile` exists, read it and finalize using the retained stdout/stderr files.
2. Else if the persisted `pid` is still alive and not older than the timeout window, tail files and poll until the exit file appears or the deadline passes.
3. Else mark the step failed with `Verification command process died during gateway restart before producing an exit code.`

Container command steps currently use an attached `docker exec` path with a pid file only for timeout cleanup; they do not use the detached exit-file recovery path.

### Gaps

#### Metadata durability is weaker than process durability

`active-verifications.json` is written with plain `fs.writeFileSync(JSON.stringify(...))`. It lacks the atomic tmp/fsync/rename, backup rotation, and stale-epoch guard used by `SessionStore` and `BgProcessStore`. A crash during write or a stale writer can corrupt or regress the recovery index.

There is also a create-window risk: the command can outlive the gateway before all recovery-critical fields are durably flushed. The code tries to stamp metadata immediately after spawn, but the model still depends on one JSON file write, not a purpose-built process store.

#### Process identity is only a PID plus age heuristic

The persisted command step stores `pid` and `startTimeMs`. There is no per-spawn nonce pidfile. `_resumeCommandStep()` treats an alive PID as the original process unless `Date.now() - startTimeMs > timeoutSec`. That is only a coarse pid-reuse guard:

- PID reuse inside the timeout window can be mistaken for the verification command.
- A still-running command beyond the timeout window can be treated as a reused PID and reported as gone.
- The resume path can then fail without reliably killing the actual over-timeout process tree.

`bash_bg` solves this with a pidfile carrying `processPid + nonce`, re-read on restore before liveness/kill decisions.

#### Exit status is only one ad-hoc `exitFile`

The child wrapper writes an exit code file, which is good, but there is no richer terminal snapshot:

- no `terminalReason` (`normal`, `timeout`, `cancelled`, `killed`, `unrecoverable`);
- no persisted kill/cancel intent;
- no status mirror for container execution;
- no explicit distinction between “real non-zero command exit” and “no command verdict was recoverable”.

Case C currently records a failed command step. That is too strong when the gateway restart itself may have caused the loss.

#### Timeout state is not restart-owned

`spawnTracked()` owns the timeout timer in memory. If the gateway dies, that timer dies. The child wrapper has no independent timeout enforcement. On restore, `_resumeCommandStep()` recomputes a deadline, but when the deadline is already past it can take the “pid looks reused” path rather than killing the live process group and recording a timeout. This risks both an orphaned verification subprocess tree and an incorrect failure reason.

Timeout recovery needs durable deadline/kill semantics: after restart, either continue waiting until the original deadline, or kill the persisted process group if the deadline has elapsed, then record timeout distinctly.

#### Cancellation after restart is not process-owned

Cancellation paths (`cancelAllVerifications()`, `cancelStaleVerificationsForGates()`) kill only entries in `_trackedCommandChildren`. After a restart, surviving command processes are not in that in-memory map until the resume path is actively polling them. A cancellation racing with or preceding resume can delete the active entry without killing the persisted process tree.

Cancellation needs to target persisted process identity, not only live `TrackedChild` handles.

#### Retained output is not a bounded durable projection

The command writes directly to stdout/stderr log files. Live tailers read those files and update in-memory active output, but high-volume output can grow the files until final diagnostics capping runs. Recovery paths read whole files with `fs.readFileSync()`, which can be expensive or unsafe for chatty commands.

There is no durable combined projection with byte/line caps, no persisted read offsets, and no copytruncate/rebase handling. This is weaker than `bash_bg` and makes “inspect after restart” depend on ad-hoc files.

#### Container command steps are outside the restart-safe path

When `containerId` is present, `runCommandStep()` uses attached `docker exec` with pipes and a temporary pid file for timeout cleanup. A gateway restart loses the host-side `docker exec` handle and its pipes. There is no in-container status file mirrored to host and no restore path analogous to `bash_bg` docker handling.

The implementation must either support container command verification using the same durable model or explicitly guard/document it as not restart-safe and leave the gate pending for re-signal rather than recording a fake command verdict.

## 4. How `bash_bg` solves analogous problems

Relevant code/docs:

- `src/server/agent/bg-process-manager.ts`
- `src/server/agent/bg-process-store.ts`
- `src/server/agent/bg-runner.ts`
- `docs/bg-process-persistence.md`

`bash_bg` moved the source of truth out of gateway-owned pipes and into durable files owned by the running process/wrapper.

Key patterns worth reusing:

| Pattern | Why it matters for gate commands |
|---|---|
| `BgProcessStore` atomic metadata store | Recovery-critical process metadata survives corrupt writes and stale snapshots. |
| Wrapper-owned status snapshot | The child records the real exit code even if the gateway is down. |
| Pidfile with nonce | Restore can distinguish the original process from a reused/foreign PID. |
| `processPid` vs `hostPid` | Docker and Windows need a signalable process identity, not merely the original `child.pid`. |
| Bounded per-stream spools | Output remains available without unbounded disk/memory growth while the gateway is down. |
| Durable combined projection | Status/inspect APIs read one authoritative bounded log, independent of live pipes. |
| Restore reconciliation cases | Alive → reattach; completed → read real exit; gone with no status → terminal unknown/unrecoverable, never fabricated exit code. |
| Persisted kill intent | Kill/cancel survives restart and is re-issued if the process is still alive. |
| Docker wrapper + host mirroring | Container-internal live state can be mirrored so exit/logs survive container churn where possible. |
| Windows no-Git-Bash Node helper | Restart-safety does not silently degrade on Windows when POSIX shell wrapping is unavailable. |

### What should be reused

Prefer extracting or reusing the lower-level durable process runner concepts from `BgProcessManager`:

- wrapper construction;
- status/pid/nonce files;
- spool tailers and bounded projection;
- restore reconciliation;
- kill/cancel helpers by persisted `processPid`;
- atomic store write discipline.

A small shared “persistent command runner” would reduce drift between `bash_bg` and verification commands.

### What should not be reused directly

Verification steps should not become user-visible `bash_bg` records with normal bg-process lifecycle semantics. Gate verification has distinct requirements:

- workflow phases and skip semantics;
- `expectFailure` / `error_pattern` verdict mapping;
- retained gate diagnostics and artifact copying;
- team-lead notification behavior;
- gate-store status updates and active verification snapshots;
- cancellation tied to gate/goal lifecycle, not user pill dismissal.

The process substrate can be shared; the gate-verdict and workflow semantics should remain in `VerificationHarness`.

## 5. Reproduction and regression test strategy

Existing coverage is useful but incomplete:

- `tests/verification-harness-restart.test.ts` covers zombie command active entries and a PID-age reuse guard.
- `tests/e2e/verification-restart-resignal.spec.ts` covers re-signaling after a simulated zombie verification.
- `tests/verification-resume-restart-prompt.test.ts` and `tests/verification-resume-restart-recovery.test.ts` cover LLM reviewer resume behavior.
- `tests/spawn-tree-shutdown-survival.test.ts` pins `markSurvival()`/`killAllTracked()` behavior.
- `tests/bg-process-persistence.test.ts`, `tests/bg-process-windows-restart.test.ts`, and `tests/manual-integration/bg-process-restart-survival.spec.ts` cover the mature `bash_bg` process model.
- `tests/notify-team-lead-failure.test.ts` already pins that skipped steps are omitted from failure notifications when marked correctly.

Missing coverage: a command verification that is genuinely running across a gateway restart and then produces a real exit code.

### Required new regression cases

#### Success after restart

Create a workflow with a long-running command step that writes a pre-restart marker, sleeps, writes a post-restart marker, and exits 0.

Test flow:

1. Signal the gate.
2. Wait until live output contains the pre-restart marker.
3. Restart the gateway while the command is still running.
4. Wait for resume/finalization.
5. Assert:
   - gate verification passes;
   - command step status is `passed`;
   - stdout/stderr diagnostics include both markers;
   - `gate_status` and `gate_inspect` expose bounded output after restart;
   - `active-verifications.json` no longer contains the signal after completion.

This should be an API E2E or manual-integration test that exercises real process survival, not only a synthetic active-verification fixture.

#### Failure after restart

Use the same pattern but exit with a distinctive non-zero code after restart.

Workflow should include at least one later-phase LLM/QA step after the command phase.

Assert:

- command step status is `failed` because the real exit code was recovered;
- output/diagnostics include the post-restart marker and exit information;
- later-phase steps are explicit skipped rows:
  - `status: "skipped"`;
  - `skipped: true`;
  - `output: "Skipped — earlier phase failed"`;
- team-lead notification lists only the real failed command step, with no inspect commands for skipped downstream steps.

#### Alive across restart

Unit-level test for the process runner:

- persist a running command record with pidfile nonce and no status;
- fake liveness as alive;
- restore;
- assert tailers/status watcher are restarted and no failure is recorded until status appears.

#### Completed during downtime

Persist a running record, write a status snapshot and retained output before restore, fake liveness as dead, restore, and assert the real exit code is used.

Cover both code 0 and non-zero.

#### Lost without status

Persist a running record with retained output but no status and fake liveness as dead. Assert the result is explicitly “unrecoverable/unknown exit status” (or a restart-interrupt pending state, depending on final design), not a fabricated command exit. The output should make clear that no command verdict was obtained.

#### Timeout across restart

Start/persist a command whose original deadline elapses while the gateway is down or before resume completes. Assert restart recovery kills the persisted process group, records timeout distinctly, and leaves no orphan subprocess tree.

#### Cancellation after restart

Restore or simulate a live persisted command, then cancel the gate before normal completion. Assert cancellation uses persisted process identity and kills the process tree even without a live `_trackedCommandChildren` handle.

#### Container command behavior

If supported:

- run a command verification in a sandbox/container;
- restart the gateway;
- assert in-container process reattachment or status recovery, host-mirrored output/status, and process-group kill on timeout/cancel.

If not supported in the first implementation:

- add an explicit guard test proving container command steps interrupted by restart do not become fake command failures; they should be left pending/re-signalable with clear diagnostics.

#### Windows restart behavior

Add a Windows-focused/manual test mirroring the `bash_bg` manual integration, but through `gate_signal`. It should verify the dev harness kills only the gateway PID, not detached verification children, and that a Windows no-Git-Bash host does not silently degrade into non-restart-safe command execution.

## 6. Downstream phase semantics and notification bug

The phase bug should be fixed as a consequence of robust command recovery, but it still needs a direct safety net.

Correct invariant:

- A step that did not run because an earlier phase failed is not a failed verification step.
- It must be terminal skipped: `status: "skipped"`, `skipped: true`, with `output: "Skipped — earlier phase failed"`.
- Skipped downstream steps must not contribute to failed-step notification lists or inspect-command hints.

Implementation implication:

`_resumeOneVerification()` must finalize steps with phase awareness. Once a recovered/rerun step fails in phase N, any later `waiting` placeholders must be converted to skipped results, not passed through `terminalStatusForStep()` fallback. This should match the normal `verifyGateSignal()` phased execution behavior.

Notification behavior already filters `!passed && !skipped` in `buildVerificationFailureMessage()`. The failure in the incident happened because downstream rows were not marked `skipped`. Fixing resume finalization should automatically prevent team-lead notifications from listing never-run steps, but a regression test should assert the full notification text.

## 7. Implementation plan

Recommended plan:

1. Introduce a verification persistent-command substrate, preferably by extracting shared primitives from `BgProcessManager` rather than duplicating them.
2. Replace command-step detached mode with a durable runner that writes:
   - metadata via an atomic store;
   - stdout/stderr spools;
   - bounded combined projection or compatible retained logs;
   - status snapshot with real exit code;
   - pidfile with nonce and signalable process pid;
   - terminal reason / kill intent.
3. Flush recovery-critical metadata before exposing the command as running.
4. Update `_resumeCommandStep()` to reconcile like `bash_bg`:
   - status exists → final command verdict from real exit code;
   - process alive + nonce valid → reattach tailers/status watcher and continue;
   - deadline elapsed → kill persisted process group and record timeout;
   - gone + no status → classify as unknown/unrecoverable or restart-interrupt, not a fabricated command exit.
5. Make cancellation target persisted process identity after restart.
6. Preserve `expectFailure` and `error_pattern` mapping only when a real command exit/status or spawn error is available.
7. Add phase-aware finalization to `_resumeOneVerification()` so downstream waiting steps become skipped after a recovered failure.
8. Keep retained diagnostics/artifact copying integrated with the final command result.
9. Add the regression tests above, with at least one real restart success case and one real restart failure case.
10. If container support is not implemented immediately, add an explicit guard and documentation for the limitation; do not silently claim restart safety for container command steps.

## 8. Risk areas

### Timeout and orphaned subprocess trees

The highest-risk path is timeout across restart. The original in-memory timer is gone, but the child may still be running. Recovery must kill the same process tree the original timeout would have killed, without touching unrelated agents, browsers, Docker execs, or `bash_bg` processes.

### Cancellation races

Gate re-signal, goal completion, shelving, and cancel-verification can race with resume. Cancellation must be persisted and idempotent, and it must operate even if no live `TrackedChild` exists.

### Docker/container commands

`docker exec` handles are not restart-stable. A safe design needs in-container wrappers, process-group leadership (`setsid`), in-container spools/status/pid, and host mirroring of retained logs/status. Otherwise container commands should be explicitly treated as non-recoverable infrastructure interruption and left pending/re-signalable.

### Windows process survival

The dev restart harness must not tree-kill the gateway process. `src/server/harness-kill.ts` already documents the `bash_bg` fix of omitting `/T`; verification command survival relies on the same property. Windows without Git Bash also needs a Node helper path rather than silently falling back to attached, non-restart-safe execution.

### PID reuse and foreign-process kills

Never kill or reattach based only on a numeric PID after restart. A nonce-checked pidfile or equivalent identity proof is required before liveness is trusted. If identity cannot be proven, recovery should avoid killing unrelated processes and should surface an unknown/unrecoverable state.

### Output growth and memory pressure

A chatty command can keep writing while the gateway is down. Spools and retained projections must be bounded by the child/wrapper, not only by the gateway after it resumes. Recovery must avoid whole-file reads of unbounded logs.

### Existing LLM-review and optional-step behavior

The fix must not regress LLM reviewer resume/rerun behavior or optional-step semantics. Optional steps skipped because they are not enabled should remain skipped-as-passed, distinct from phase-skipped downstream steps after a real failure.
