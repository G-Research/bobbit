# Verification cancellation lifecycle

Verification cancellation is an orchestration outcome, not evidence that a project check failed. This contract preserves the audit trail and cleanup guarantees when an operator or goal lifecycle interrupts command, reviewer, QA, or human-sign-off work.

It complements [restart-safe command verification](verification-restart.md), which defines exact process ownership, and [Verifier Recovery](llm-review-recovery.md), which defines reviewer-session recovery. This page defines how an interrupted verification becomes a durable gate result and how clients should act on it.

## Durable cancellation record

A cancelled signal persists a cancellation object both on the verification and on each interrupted step:

```json
{
  "status": "cancelled",
  "cancellation": {
    "cause": "goal-pause",
    "requestedAt": 1710000000000,
    "finalizedAt": 1710000001234
  }
}
```

The supported causes are:

| Cause | Producer or meaning |
| --- | --- |
| `manual` | Operator used the cancel-verification action. |
| `goal-pause` | Goal was paused. |
| `superseded` | A newer signal replaced this signal generation. |
| `gate-reset` | Gate reset invalidated active work. |
| `bypass` | Human bypass displaced active work. |
| `goal-complete` | Goal completion began. |
| `team-teardown` | Team teardown began. |
| `shelved` | Goal was shelved. |
| `archive` | Goal archival began. |
| `zombie-recovery` | A replacement signal found no live owner for the old run. |
| `gateway-restart-recovery` | Gateway recovery could not continue the interrupted run. |
| `unknown` | A legacy cancellation record had no durable cause. |

`unknown` is a compatibility label, not a diagnosis. Older generic cancellation records remain readable, but Bobbit never infers a historical cause from command output, a kill reason, or later lifecycle state.

Cancellation provenance is recorded before any asynchronous reviewer, process, Docker, or sign-off cleanup begins. It is first-writer-wins: a later pause, reset, recovery pass, or retry cannot replace the cause chosen by the first cancelling producer. The intent and timestamps remain in the active durable record until finalization, so a gateway restart or delayed cleanup retry preserves them.

Output text never determines provenance. A reviewer summary, command log, timeout wording, or missing output is evidence about a step only after the harness has a durable lifecycle record for it; otherwise it can be stale, user-authored, or produced after cancellation. Restart interruption is therefore recorded only by the durable `restartInterrupted` marker, and the compatibility `unknown` cause remains unknown rather than being guessed from text.

## Outcome and audit semantics

`failed` means a command, reviewer, QA check, or human sign-off delivered a real failed verdict. An orchestration cancellation instead gives the signal verification `status: "cancelled"`; it does not make the gate failed.

The gate remains `pending` and eligible for a later signal. This keeps a cancelled run terminal as history without treating it as an approval or as a product defect. A superseded signal is historical only and cannot alter the current gate or its newer signal.

Cancellation keeps the enumerated workflow step list intact:

- completed steps retain their real status, output, duration, diagnostics, and artifacts;
- waiting or running steps become `cancelled`, with the run cancellation cause and timestamps; and
- no synthetic failed `Cancelled` command replaces the workflow.

This distinction matters during incident review: a completed check is still evidence, while an interrupted check is neither a pass nor a failure.

## Cleanup and publication fence

Cancelling a run first fences further work for that signal, drains pending human-sign-off resolvers, and stops verifier sessions. Command cleanup then retains the exact ownership rules for host process trees and Docker's payload and host transport. A cancellation never weakens those rules or authorizes a historical PID, process group, container process, or transport tree.

Terminal cancellation publication waits for all owned cleanup to settle. If exact cleanup is pending, the cancellation intent remains durable and cleanup is retried; it is not converted into a failed gate. This applies after a gateway restart as well as during normal operation.

The same fence protects real recovered outcomes. A genuine recovered pass or failure, including a non-restart `Resume Error`, is first staged as a durable terminal intent when cleanup is still owned. Reviewer, host-tree, Docker payload and transport, and human-sign-off cleanup then settle before the signal and gate result are published. This prevents a late callback from changing either an interrupted run or a real verdict.

The public active-verifications endpoint deliberately hides a run once it has entered cancellation cleanup. It is a view of work still running, not a process-ownership ledger. The durable signal history is the authoritative cancellation result after cleanup settles.

## Generation safety and re-signalling

Each signal is one generation. On re-signal, Bobbit fences the old generation as `superseded` before admitting the replacement. The replacement running generation resets the gate to `pending`. Old cleanup may continue and may persist its own historical signal, but it cannot publish a result into the replacement generation or change the current gate status.

Publication is ordered: persist the historical signal result, update the gate only if that signal is still current, durably retire the active owner, then emit status and transcript events only if the generation is still current after the writes. This post-write check prevents an event emitted by old cleanup from making a replacement look completed.

A paused goal rejects new signals while paused. Resuming does not automatically replay a cancelled verification: automatic replay could run a changed commit, workflow, goal lineage, or a superseded signal. Instead, after the goal is eligible again, use the explicit **Re-signal gate** action once. That creates a new generation under current admission checks.

Manual cancellation follows the same model: the interrupted run is terminal history, and a later explicit re-signal is allowed. Goal completion, shelving, archival, and team teardown similarly cancel active work without manufacturing a failed gate. Reset and bypass first cancel affected active generations, then apply their own gate-state transaction.

## Lifecycle admission fences

Reset and bypass close admission for their affected gates. Completion, shelving, archival, and team teardown close admission for every gate in the goal. The fences cover the interval from cancellation target selection through the authoritative lifecycle or gate-state write, preventing a new signal from escaping in an async gap.

A request made during these transitions fails closed with a retryable conflict rather than recording a signal that the operation did not own. If the durable cancellation fence cannot be written, the mutation is not allowed to proceed and returns `VERIFICATION_CANCELLATION_FENCE_FAILED`; retry after the storage problem is resolved. Fence ownership is reference-counted so nested terminal operations do not reopen admission early.

## Restart and recovery

At gateway startup, Bobbit first reloads active cancellation intent and resumes its exact cleanup. A previously cancelled run retains its first cause and step history until it can be finalized. If reviewer cleanup was already in progress, the durable `reviewerCleanupPending` marker retains the exact reviewer session identity; retrying cleanup never substitutes a later session.

Recovery distinguishes determined and unfinished work. A recoverable command result or an aggregate already determined by durable rows reconstructs a pass/fail terminal intent, then publishes it only after exact cleanup. Genuinely unfinished work first completes any retained ownership cleanup and then resumes. If the workflow, goal, gate, or signal context cannot be resolved, the active record is retained for later recovery rather than inventing an outcome.

If restart recovery conclusively finds no verdict for a marked step, it records `gateway-restart-recovery`, not a failed verification. A real failed sibling remains a failed aggregate, with the interrupted step still marked cancelled for audit. Bobbit sends one neutral re-signal notice only when that cancelled signal is still the gate's current generation. Zombie replacement and historical/superseded cleanup do not send that notice, avoiding misleading or duplicate instructions.

## API, events, and UI

REST signal history, gate detail/status, and inspection expose the durable verification status, cancellation object, and per-step cancellation data. The manual cancel endpoint returns `outcome: "cancelled"`, `cause: "manual"`, and the affected signal id; `pending: true` means exact cleanup has not settled yet. A reviewer that submits a verdict after teardown has begun is either accepted through the retained cleanup owner or receives retryable `503 VERDICT_NOT_PERSISTED`; the client must retry rather than treating the transport error as a verdict.

WebSocket cancellation completion uses `status: "cancelled"` with the same cancellation object. Clients should refresh authoritative gate data after gate events rather than infer a failure from a stopped spinner.

The dashboard, sidebar/status widget, and transcript render cancellation separately from failure and display a human-readable cause. Signal detail preserves completed outputs and marks interrupted steps with their cause and time. A cancelled current signal exposes the explicit re-signal action only when the goal and gate are eligible; stale or terminal lifecycle states do not expose an unsafe replay control.

## Troubleshooting and audit

1. Inspect the gate's latest signal and its `verification.cancellation` object. Treat `unknown` as unavailable legacy provenance, not a guessed cause.
2. Inspect each step. Preserve passed output as evidence; investigate only `failed` or `timeout` statuses as product verification verdicts. A `cancelled` step was interrupted.
3. If the manual cancel response has `pending: true`, wait for exact cleanup to settle. Do not kill recorded PIDs, process groups, Docker processes, or reviewer sessions manually.
4. For a current run cancelled by pause or restart recovery, resume the goal if needed and explicitly re-signal once. For a superseded run, inspect the newer signal instead.
5. If a lifecycle or gate mutation reports `VERIFICATION_CANCELLATION_FENCE_FAILED`, retry the operation. Do not assume the target mutation committed.

Use `gate_status` for the compact outcome, then `gate_inspect(section="verification", ...)` to audit step output and retained diagnostics. See [Retained gate diagnostics](gate-diagnostics.md) for bounded log and artifact inspection, and [Restart-safe command verification](verification-restart.md#operations-and-diagnosis) for exact cleanup and ownership failures.
