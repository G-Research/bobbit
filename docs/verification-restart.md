# Exact process ownership for command verification

Command verification runs untrusted project commands that can create large process trees and can outlive a gateway process. The verification runtime therefore treats process ownership as a durable security boundary, not as a best-effort cleanup detail. It must never turn an old PID or process-group number into a signal for unrelated work.

This page describes the lifecycle for `command` verification steps. It covers the tracked spawn primitive, command-step persistence, Docker execution, and restart recovery. Background `bash_bg` persistence is a separate feature; see [Persistent background processes](bg-process-persistence.md).

## Core contract

A command result is published only after these conditions are true:

1. ownership was established at spawn time;
2. the ownership evidence was durably recorded before readiness is acknowledged;
3. any timeout, cancellation, natural completion, or restart cleanup has settled the owned payload and its transport; and
4. the verification is still the current signal generation for its gate.

This ordering matters because process IDs and process-group IDs are reusable. A record that merely says “PID 123 exited” cannot safely authorize a later signal to `-123` after the original group has disappeared. Missing, legacy, stale, mismatched, or reused ownership evidence is therefore **pending/retryable**, never permission to signal a historical number.

`TrackedChild.ownershipReady` is the single public readiness boundary. Callers do not combine separate platform and container readiness promises: it resolves only when all ownership prerequisites for that spawn have succeeded, and rejects after fail-closed cleanup begins. Timeout clocks and shutdown-survival acknowledgement wait for this boundary, so a cold spawn cannot be timed out or preserved before Bobbit owns it.

## Frozen source checkout boundary

Process ownership answers *which process* Bobbit may clean up. Pinned verification answers *which source bytes* that process, a reviewer, or a sign-off decision may attest to. Every fresh verification signal first receives a server-owned checkout made from its complete non-ignored Git inventory. The checkout's raw-byte digest and full base commit are persisted on the signal and checked for post-acquisition step reuse, before each phase, after each phase, and before the terminal verdict.

A route-level whole-gate cache materialization creates no checkout lease because it executes no process. It may reuse v1 evidence only for the same v1 layout. It may reuse v2 evidence only when the route independently observes the exact ordered, path-free current component witness; absent, mismatched, or v1/v2-transition evidence is a cache miss. This prevents an aggregate digest from treating a changed component identity as a prior pass.

The public execution tree is source-only and has no usable Git metadata. A separate private detached worktree exists only for server-owned Git queries, such as creating a review baseline/diff context. Git uses fixed argument arrays, a validated full commit SHA, disabled repository hooks, and a trusted private cwd; no reviewer, sandbox, workflow command, or signal can select that Git cwd. This prevents Git discovery from an untrusted execution directory and prevents a sandbox from accessing repository metadata.

Sandboxed fresh phases use an exact signal-labelled sidecar rather than the normal mutable project container worktree. Its only writable additions are manager-approved ignored output overlays derived from the frozen `.gitignore`; their reports or dependency links are deliberately outside the source inventory. The sidecar is removed before the next host audit. Therefore a check can generate ignored output without making a source mutation invisible, and a source mutation cannot become a pass just because the command exited successfully.

The checkout and sidecar are resources with a durable terminal owner. After a pass, failure, cancellation, or restart, command cleanup completes first, then any sidecar is removed, then the checkout lease is released. A visible terminal gate result is not permission to forget these resources: an active verification record persists until that exact order converges. Retried cleanup is fail-closed and never targets an arbitrary historical path or process.

Restart recovery reopens only the same ready lease after validating its project owner, signal id, pinned root identity, and source identity. A v1 lease validates its single repository commit/digest; a D-4 v2 lease also validates its ordered per-repository commit/digest manifest and aggregate digest. It never recreates a source snapshot from a now-mutable worktree. Missing, changed, unreadable, or substituted pinned state is a restart interruption/pending or fixed infrastructure failure according to the step lifecycle; it is not evidence for a pass.

D-4 maps nested and multi-repository component locations through the persisted pinned layout, not through a live cwd. Recovery does not reconstruct that layout from the current parent, child, or sibling goal: it resumes only the executing goal's recorded layout, and fails closed if it cannot prove it. For cache behavior, diagnostics, and signal lifecycle, see [Goals, workflows, and tasks — Pinned source verification](goals-workflows-tasks.md#pinned-source-verification), [Pinned multi-repo verification (D-4)](design/pinned-multi-repo-verification.md), and the [D-5 end-to-end verification plan](design/pinned-gate-verification-e2e.md). The D-5 real-process integration E2E, rather than the browser fixture that injects a fake checkout manager, proves the full pinned-checkout diagnostic lifecycle.

## Spawn-time ownership

### POSIX

A tracked POSIX command is put in its own detached process group and receives an in-group sentinel at spawn time. The sentinel ignores graceful termination and remains after the command leader exits, closing the leader-exit window in which the group number could otherwise be reused.

The sentinel atomically writes an identity witness before acknowledging readiness. Its authority is the complete tuple: sentinel PID, group ID, per-spawn nonce, and process-incarnation start token. Linux uses the kernel start token from `/proc`; on macOS, the lower-resolution start observation is paired with an unguessable nonce held by the live sentinel. Before any recovered group signal, Bobbit reads the witness and re-observes the live sentinel. Every element must agree. Once the group is observed empty, or after its one final signal, its numeric group ID is permanently retired from cleanup.

### Windows

Windows uses a supervisor that creates the payload **suspended**, assigns it to a `KILL_ON_JOB_CLOSE` Job object, publishes the assignment acknowledgement, and only then resumes the payload. This removes the window in which a fast payload could create an unowned descendant. A Job close or termination reaps the tree without retargeting a PID after its exit.

The supervisor supplies owned, inheritable `NUL` handles for missing standard input, output, or error handles. This makes the pre-resume ownership barrier work in headless and redirected environments as well as interactive ones. Recovery does not attempt to reopen a Job from a PID: where a retained Windows transport must prove completion, a nonce-bound post-Job-close record is required.

## Durable command lifecycle

Before a restart-surviving command can continue, Bobbit persists its active step and the durable ownership/result locations. On supported host POSIX execution, the wrapper writes retained logs, a nonce-bound identity record, liveness evidence, and an atomic exit record. The command runs in a subshell so an `exit N` from project code cannot bypass the real exit-status write.

The kernel child wait is the verdict authority for live execution. A shell leader closing is not enough: tracked cleanup must prove the owned process tree has reached its completion boundary. The durable exit result is then the recovery authority for a completed host command. Logs remain diagnostic evidence; they do not decide the result.

Timeout and cancellation persist intent before destructive cleanup. A live tracked child uses its spawn-time ownership; restart recovery uses only retained exact authority. Both paths converge on the same durable cleanup phases. An obsolete signal may finish its own audit work, but it cannot overwrite the status of a newer gate signal.

## Docker command steps

A Docker command has two independent ownership domains:

- the in-container payload process group; and
- the host-side `docker exec` transport tree.

They are cleaned in that order. The host does not publish a gate result merely because the command leader or `docker exec` client exits.

### Container payload authority

The payload starts behind a host-only release barrier. Before release, an in-group sentinel supplies a tuple containing its PID, group ID, start token, container identity, and nonce. Bobbit binds that tuple to a **versioned Docker Engine attestation**: the exact Engine exec identity, structured `docker top` data, the tagged sentinel row, its daemon-namespace group, and an unbroken ancestry chain to the Engine-owned exec process. The attestation and witness are persisted atomically before payload release.

This distinction is deliberate. Container stdout, files, environment, tags visible to the payload, and container-created status data can be influenced by a same-UID command. They are not cleanup or verdict authority. The authoritative normal result is the host-observed `docker exec` lifecycle result, whose inner kernel parent waits for the payload. Thus neither output that resembles a completion message nor a payload-controlled file can manufacture a passing result.

For cancellation, timeout, normal completion, and restart recovery, Bobbit validates the persisted container ID, nonce, witness, and Engine attestation, then reads the live sentinel's PID, start token, and group ID. It repeats that exact check immediately before **each** negative-group signal. If the leader has already exited, the separate sentinel still makes the group identity available. If evidence is absent or differs, Bobbit does not signal.

Every destructive signal, including a re-signal, requires a currently live exact sentinel and an immediate revalidation of its PID, start token, and group ID against the persisted witness and attestation. A persisted earlier attempt does not authorize a numeric retry. If that sentinel is absent, stale, or reused after an attempt, recovery becomes observation-only: structured Docker Engine rows for the attested Engine group determine whether cleanup has finished, and Bobbit sends no historical numeric signal. A non-zombie member keeps cleanup pending; a zombie-only group is complete because zombies cannot execute or receive a signal.

### Host transport handoff

The host transport has its own retained ownership sentinel on POSIX, or the Job completion proof on Windows. It is deliberately retained across the payload handoff so a gateway crash cannot strand a `docker exec` tree or publish early. The durable order is:

```text
exact payload cleanup
  → host transport cleanup
  → durable completion/result state
  → terminal gate publication
```

Recovery repeats the same order. A host result record does not bypass payload or transport cleanup; a timeout or cancellation does not become terminal merely because one layer closed.

## Restart and failure behavior

On boot, Bobbit reloads active verification state before deciding an outcome:

- A valid durable host result is evaluated with the original command semantics, but terminal publication waits for required cleanup.
- A still-running supported host command is reattached only after its current identity matches its durable evidence.
- A Docker command first performs the exact payload-then-transport recovery sequence. It does not trust an in-container result file or a historical container PID.
- A command with no recoverable verdict remains pending so it can be re-signalled. It is not converted to a fabricated command failure.

If cleanup is unsafe or incomplete, the active record retains its cleanup intent and pending state. Retried cleanup may continue after restart, but it cannot widen authority: old or malformed records, PID reuse, a missing sentinel, unavailable Engine data, or a mismatched Job completion record remain fail-closed. Operators should let the pending state converge or re-signal after it settles; they must not manually reuse an ID from the record to kill a process group.

### Platform compatibility

- **Linux Docker** is the full container-attestation path. It requires a reachable Docker Engine and Linux process start-token support inside the container.
- **macOS host execution** uses the POSIX sentinel contract, with the Darwin start observation combined with the sentinel nonce. A start time alone is not authority.
- **Windows** uses spawn-time Job ownership for tracked trees. Native host command restart recovery remains pending/retryable when a prior Job cannot provide exact reopenable ownership; Bobbit never falls back to a persisted PID. Docker transport recovery requires the nonce-bound Job-close proof.
- **Host reboot** is outside the gateway-restart guarantee. Bobbit can use only state that was durably written before the host stopped.

## Operations and diagnosis

Common safe outcomes after a restart are a recovered real exit result, continued output while a verified command remains live, or a `pending`/`waiting` step requesting a re-signal. The last outcome is expected when Bobbit lacks a safe verdict or cleanup authority.

For a pending command step:

1. Inspect the retained step output first:

   ```text
   gate_status(gate_id="implementation")
   gate_inspect(gate_id="implementation", section="verification", step="<step name>", mode="tail", lines=200)
   gate_inspect(gate_id="implementation", section="verification", step="<step name>", mode="grep", pattern="pending|identity|witness|cleanup", context=2)
   ```

2. Inspect the active verification record for the recorded cleanup state and its reason. A retained unsafe/pending reason means Bobbit deliberately declined a potentially wrong-target signal.
3. Do not kill the recorded PID or PGID manually. Wait for exact recovery to settle; if no durable verdict can be recovered, re-signal the gate once the previous generation has been cleared.

A command that appears to finish but remains active is usually waiting for payload or transport cleanup, not for more command output. In Docker cases, confirm the Engine is reachable and leave the unrelated workload untouched while the retry records remain pending. See [Debugging: command verification interrupted by gateway restart](debugging.md#command-verification-interrupted-by-gateway-restart) for the symptom-oriented checklist.

## Verification coverage

Focused retry-free coverage is split by boundary:

```sh
npx vitest run --config vitest.config.ts --retry=0 \
  tests2/core/spawn-tree-process-cleanup.test.ts \
  tests2/core/verification-command-restart-lifecycle.test.ts \
  tests2/core/verification-harness-timeout.test.ts

npx tsx --test tests/spawn-tree-shutdown-survival.test.ts
```

The core tests cover sentinel identity mismatch and PID reuse, durable readiness/publication ordering, timeout and cancellation convergence, restart recovery, container witness/attestation mismatches, and zombie-only completion. The standalone native probe covers POSIX survival and Windows Job behavior where the platform is available.

The real Docker suite is intentionally manual because it starts a gateway and a real sandbox container:

```sh
npm run test:manual -- tests/manual-integration/verification-container-ownership.spec.ts
```

Its final coverage proves exact payload and host-transport lifecycle cleanup; per-exec attestation and isolation for concurrent steps; blocked forged results and an honest exit status of 23; cleanup after natural exit status 125 and expected failure; exact crash/restart recovery; a missing retained host-transport witness that remains running/pending until exact restoration and recovery; cancellation despite witness substitution; and structured-row or newline-injection resistance. Across destructive journeys, the target cleans up while an unrelated same-UID sibling remains alive.

Run the normal workflow gates for broader regressions:

```sh
npm run check
npm run test:unit
npm run test:browser
npm run test:e2e
```

## Code map

- `src/server/agent/spawn-tree.ts` — cross-platform tracked-tree ownership and shutdown survival.
- `src/server/agent/verification-command-runner.ts` — the command-step spawn boundary.
- `src/server/agent/verification-harness.ts` — durable verification state, Docker attestation, cleanup ordering, and restart recovery.
- `src/server/agent/verification-logic.ts` — recovery-mode selection and pure verification semantics.
- `tests2/core/` — deterministic lifecycle and recovery regressions.
- `tests/spawn-tree-shutdown-survival.test.ts` — native process ownership survival probe.
- `tests/manual-integration/verification-container-ownership.spec.ts` — real Docker ownership journey.
