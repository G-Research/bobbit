# Verification command steps survive a gateway restart

When a gateway restart killed an in-flight gate verification, two cooperating
bugs left the gate locked behind HTTP 409 `Verification already in progress
for this commit` on every subsequent `gate_signal` for that SHA. The only
workaround was pushing an empty commit to change the SHA — which (a) loses
the right to retry a true environmental flake on the same SHA and (b)
accumulates noise commits on the goal branch.

This document explains the two-layer fix: command subprocesses now survive
the parent gateway dying (Layer 1), and even when they don't, the
duplicate-detection path correctly recognises a dead step from a previous
server lifetime (Layer 2).

See also [debugging.md — HTTP 409 after gateway restart](debugging.md#http-409-verification-already-in-progress-after-gateway-restart)
for the symptom→fix lookup, and [internals.md — Verification architecture](internals.md#verification-architecture)
for the broader verification context.

## The original bugs

Both lived in `src/server/agent/verification-harness.ts`.

1. **`areVerificationSessionsAlive(signalId)`** treated command-only steps as
   alive whenever their persisted `status === "running"` and `sessionId` was
   absent. That assumption holds during a single server lifetime but not
   across a restart: the persisted "running" flag survives in
   `.bobbit/state/active-verifications.json` after the spawned child is long
   dead. The zombie auto-cancel path in `server.ts` deferred to this method
   and so never fired.

2. **`resumeInterruptedVerifications()`** marked the gate signal as failed
   on resume error but did not remove the entry from the in-memory
   `activeVerifications` map. The gate-status endpoint read "failed"
   (correct) while the duplicate-detection check read "running" (wrong) —
   the two views drifted, and the gate was locked until the SHA changed.

## Two-layer design

### Layer 1 — command subprocesses outlive the gateway

The cleanest fix is not to lose the running child at all. Command steps are
now spawned `detached: true` with stdout/stderr redirected to files under
`<stateDir>/verifications/<signalId>/<stepIndex>.{out,err}`. A small bash
wrapper around the real command writes the exit code to
`<stepIndex>.exit` via an atomic rename:

```
( <user command>
); __ec=$?; printf %s "$__ec" > <stepIndex>.exit.tmp \
   && mv <stepIndex>.exit.tmp <stepIndex>.exit; exit $__ec
```

Because the wrapper — not the gateway — owns the exit-file write, even
SIGKILL of the gateway leaves the disk in one of two consistent states:
either no exit file (child still running) or a complete exit file (child
finished). There is no partial state to interpret.

`runCommandStep` stamps the persisted `ActiveVerification.step` with `pid`,
`startTimeMs`, `outFile`, `errFile`, `exitFile`, `bootEpoch`, `timeoutSec`,
`expectFailure`, and `errorPattern` **before** the gateway has a chance to
crash, then calls `child.unref()` so the surviving child does not keep the
old gateway alive during a graceful shutdown.

On boot, `_resumeCommandStep` handles three cases:

- **(A) Exit file present** — the wrapper finished before we got back. Read
  the recorded exit code plus the stdout/stderr tails and finalize via the
  same `matchExpectFailure` / pass-fail logic the live path uses. No
  difference in outcome from a non-interrupted run.
- **(B) `pid` still alive and not stale** — the detached child outlived the
  gateway. Re-attach a file tailer for live broadcast and poll for the exit
  file until the remaining timeout budget (computed from `startedAt`) is
  exhausted. If the deadline passes without an exit file, kill the child
  and finalize as failed.
- **(C) Process dead, no exit file** — the child was killed by something
  other than the gateway (OOM, manual kill, antivirus). Finalize as failed.

Live broadcast during resume uses `_startFileTailers`, which polls the out
and err files at 200 ms and emits `gate_verification_step_output` events
with the same shape the live-spawn path produces. UI clients that
re-connect after the restart see the full output written so far; clients
that were mid-stream across the restart may miss live tail between the
last poll before the restart and resume re-attaching (the file content is
captured in full either way).

Reviewer/agent-QA steps already persisted via session state and resume via
`_tryResumeFromSession`; nothing in Layer 1 changes that path.

### Layer 2 — correctness floor if the child also dies

Layer 1 covers the common case. It does not cover OS-level kills of the
child (OOM, manual `taskkill`, antivirus quarantine) — in those cases the
gate would still lock. Layer 2 ensures the duplicate-detection path
correctly classifies any dead step as not-alive, regardless of why it
died.

The mechanism is a per-`VerificationHarness`-instance `bootEpoch`
(`randomUUID()` at construction). Every step started by this instance is
stamped with this `bootEpoch`. The alive-check is now:

- `waiting` step → alive (phase-gated, hasn't started yet).
- Reviewer / agent step → alive iff `sessionManager.getSession(step.sessionId)`
  resolves.
- Command step → alive iff `step.bootEpoch === this.bootEpoch &&
  isPidAlive(step.pid)`.

A persisted-running step loaded from disk after a restart always has a
stale `bootEpoch`, so it is correctly read as not-alive — and the
duplicate-detection path in `server.ts` falls through to
`cancelStaleVerifications` and accepts the new signal.

`resumeInterruptedVerifications` synchronously removes failed-on-resume
entries from `activeVerifications` and rewrites
`.bobbit/state/active-verifications.json` in a `finally` block, so even if
the gate-store update throws (missing goal, deleted gate) the in-memory
map and the persistence file are still consistent before the next
`gate_signal` arrives.

## PID-reuse safeguard

Node does not expose a per-PID OS start time, so we cannot directly prove
that a live PID belongs to the same process we spawned. As a pragmatic
floor, `_resumeCommandStep` compares `Date.now() - step.startTimeMs`
against `step.timeoutSec * 1000`. If the recorded spawn time is older than
the step's own timeout, the original child must already have exited (its
timeout would have killed it). A live PID at that point is almost
certainly a recycled PID belonging to an unrelated process, so we skip
Case B and finalize as failed.

This is intentionally simple and cross-platform. A reused PID for an
unrelated short-lived process within the timeout window will still appear
"alive" in Case B, but it will not write to our exit file and the resume
poll loop will time out and finalize as failed — never as passed.
`isPidAlive(pid)` uses `process.kill(pid, 0)` which works identically on
POSIX and Windows.

Pinned by the second test in `tests/verification-harness-restart.test.ts`
("resumeInterruptedVerifications finalizes a step as failed when pid is
alive but startTimeMs indicates pid reuse").

## Cross-platform notes

The detached-survival path requires bash to run the exit-file wrapper. On
POSIX systems this is always available. On Windows, the harness uses Git
Bash via `GIT_BASH` from `shell-util.ts`. If Git Bash is not installed,
the harness emits a one-time warning
(`[verification] Git Bash not found on Windows — detached command mode
disabled …`) and degrades to attached-pipe mode for all command steps in
that gateway lifetime. Verifications still run; they just don't survive a
restart. This is a deliberate trade-off — silently failing to spawn would
be worse than running with degraded restart semantics.

Docker-exec steps (`containerId` set) also stay on the attached-pipe path.
Writing the exit file inside the container while persisting state on the
host would require a host-mounted volume per signal and a wrapper inside
the container; container survival across host gateway restart is
explicitly out of scope (see below).

## Out of scope

- **Reviewer / agent-QA session resume.** Already handled by
  `_tryResumeFromSession` and the team-store reviewer rebinding path; see
  [internals.md — Reviewer `kind` & restart resume](internals.md#reviewer-kind--restart-resume).
- **Host machine reboot.** Only same-host gateway restarts are covered. A
  reboot will lose all detached children regardless of the wrapper.
- **Mid-stream WS subscribers across the restart.** File content is
  captured in full and bootstrap-served on the next attach, but a client
  that was streaming live tail across the restart window may miss the
  bytes written between the last 200 ms poll before the gateway died and
  the resume re-attaching its tailer. The captured output reconciles on
  the next bootstrap call.
- **Docker-exec command steps.** Stay on the attached-pipe path. Their
  exit code is lost across a host gateway restart; the signal will be
  finalized as failed on resume.

## Where the code lives

| File | Symbol | Responsibility |
|---|---|---|
| `src/server/agent/verification-harness.ts` | `bootEpoch` (private field) | Per-instance UUID stamped on every step started by this harness. |
| `src/server/agent/verification-harness.ts` | `isPidAlive(pid)` | Cross-platform PID-existence probe via `process.kill(pid, 0)`. |
| `src/server/agent/verification-harness.ts` | `ActiveVerification.step` | Persisted shape now carries `pid`, `startTimeMs`, `outFile`, `errFile`, `exitFile`, `bootEpoch`, `timeoutSec`, `expectFailure`, `errorPattern`. |
| `src/server/agent/verification-harness.ts` | `runCommandStep` | Spawns the detached child with the bash exit-file wrapper, stamps the persisted step, sets up file tailers. |
| `src/server/agent/verification-harness.ts` | `_startFileTailers` | 200 ms polling tailer for out/err files; emits `gate_verification_step_output` events. |
| `src/server/agent/verification-harness.ts` | `_resumeCommandStep` | Boot-time recovery: Case A (exit file present) / B (pid alive) / C (dead) finalization. |
| `src/server/agent/verification-harness.ts` | `areVerificationSessionsAlive` | bootEpoch + `isPidAlive` liveness check. |
| `src/server/agent/verification-harness.ts` | `resumeInterruptedVerifications` | Synchronous in-memory + on-disk cleanup of failed-on-resume entries in a `finally`. |
| `src/server/server.ts` | duplicate-detection 409 path | Logs `[api] Rejecting gate_signal as duplicate` with per-step `{ name, status, pid, bootEpoch, sessionId }` so future false-positives are diagnosable from logs alone. |
| `tests/verification-harness-restart.test.ts` | 3 unit tests | Pins zombie alive-check, pid-reuse safeguard, resume cleanup. |
| `tests/e2e/verification-restart-resignal.spec.ts` | API E2E | Seeds a zombie verification, calls `resumeInterruptedVerifications`, asserts re-signal is accepted. |
