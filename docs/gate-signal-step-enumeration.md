# Gate-signal step enumeration is atomic with `recordSignal`

When the team lead (or any client) `POST`s to `/api/goals/:id/gates/:gateId/signal`,
the server creates a `GateSignal` record, persists it to the gate store, and
then runs verification asynchronously. Between those two points there used to be
a race: the persisted signal carried `verification.steps: []` while the
in-memory `activeVerifications` map was still empty, so the dashboard widget
showed "no progress" for up to 15-30 seconds — long enough on multi-step gates
that users assumed verification was wedged.

This document explains the fix: step enumeration is now performed
**synchronously** in the REST handler before the gate-store write, so the
persisted signal and the `activeVerifications` map agree from the very first
state anyone can observe.

See also [debugging.md — Empty `verification.steps[]` after `gate_signal`](debugging.md#empty-verificationsteps-after-gate_signal)
for the symptom→fix lookup, and [internals.md — Verification architecture](internals.md#verification-architecture)
for the broader verification context.

## The original race

Three writers updated a signal's `verification` field, in this order:

1. The REST handler in `server.ts` constructed `signal.verification.steps = []`
   and called `gateStore.recordSignal(signal)` — the signal hit disk with no
   step list.
2. The handler fire-and-forget invoked `verifyGateSignal(signal, gate, …)`.
3. Several `await`s later (gate-store lookups, workflow resolution,
   `ProjectConfigStore` reads for variables like `base_ref`), the harness
   built the `ActiveVerification` entry, stamped `startedAt`, persisted
   `activeVerifications`, and only then began running steps. A second
   gate-store write eventually populated `signal.verification.steps`.

Anything that read the gate between (1) and (3) — including the dashboard's
polling fetch and the `/api/goals/:id/verifications/active` endpoint — saw
an empty step list. The `POST` response itself hid the bug because it
returned a step list built directly from the workflow definition, before
the persistence round-trip.

The window widened with verification-harness setup cost. On the
`implementation` gate (eight steps spanning build → typecheck → unit → e2e
→ multiple llm-reviews) it could last tens of seconds; on a single-step
gate it flashed through invisibly.

## The fix: split enumeration from execution

Enumerating the step list is cheap — it walks the workflow gate's
`verify[]` array, assigns `phase` and initial `status` (`"running"` for
the minimum phase, `"waiting"` for everything else), and stamps a single
`startedAt`. Actually running the steps is the expensive async part.

Splitting these into separate calls lets the REST handler do the cheap
half inline and persist the result with the signal record. Two writers
collapse into one writer — race gone.

### `VerificationHarness.beginVerification(signal, gate)`

```ts
beginVerification(signal: GateSignal, gate: WorkflowGate): GateSignalStep[]
```

Synchronous. Returns the enumerated `GateSignalStep[]` shaped exactly for
the caller to assign to `signal.verification.steps` before recording the
signal. Side effects:

- Seeds `activeVerifications.set(signal.id, …)` with `startedAt = Date.now()`
  and per-step `status` (`running` for the minimum phase, `waiting`
  otherwise).
- Persists `active-verifications.json` so the entry survives a restart
  even if the gateway dies before `verifyGateSignal` is reached.

**Idempotent.** Calling twice for the same `signal.id` returns the same
enumeration without re-stamping `startedAt`. This matters for tests and
for the fallback path described below.

**Returns `[]` for gates with no `verify[]` steps.** The caller still
records the signal; `verifyGateSignal` auto-passes it.

**Does NOT broadcast `gate_verification_started`.** The caller must emit
that event AFTER its own `gate_signal_received` broadcast — see
[WebSocket event ordering](#websocket-event-ordering) below.

### REST handler shape

The `gate_signal` handler in `server.ts` calls the harness inline before
recording the signal:

```ts
await verificationHarness.cancelStaleVerifications(goalId, gateId);

const signal = { id: signalId, /* … */, verification: { status: "running", steps: [] } };
const initialSteps = verificationHarness.beginVerification(signal, gateDef);
signal.verification = { status: "running", steps: initialSteps };

gateStore.recordSignal(signal);
broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId });

const active = verificationHarness.getActiveVerification(signal.id);
if (active && initialSteps.length > 0) {
  broadcastToGoal(goalId, { type: "gate_verification_started", /* … */ });
}

verificationHarness.verifyGateSignal(signal, gateDef, /* … */).catch(/* … */);
```

Two ordering details matter:

1. **`cancelStaleVerifications` runs BEFORE `beginVerification`.** Otherwise
   it would observe the just-seeded active entry and tear it down. The
   stale-cancel path is concerned with prior signals on the same gate, not
   the new one.
2. **`recordSignal` happens after `beginVerification` returns.** This is
   the entire point of the fix — the persisted signal and the
   `activeVerifications` map land in the same scheduler tick with matching
   step lists.

### Reuse in `verifyGateSignal`

`verifyGateSignal` now reuses the pre-seeded `activeVerifications` entry
rather than building a fresh one:

```ts
let active = this.activeVerifications.get(signal.id);
if (active) {
  verificationStartedAt = active.startedAt;
} else {
  // Fallback for callers that bypass the REST handler — tests,
  // restart-resume paths. Legacy inline construction + broadcast.
}
```

The fallback path is preserved so the harness remains usable standalone
(tests, `resumeInterruptedVerifications`). Production traffic goes through
the REST handler, so the fast path is always the reuse branch.

## WebSocket event ordering

Clients depend on `gate_signal_received` arriving **before**
`gate_verification_started` on the wire. The verification-core E2E suite
pins this ordering (`tests/e2e/verification-core.spec.ts`, "WS events have
correct shape, timestamps, and ordering").

An earlier iteration of `beginVerification` broadcast
`gate_verification_started` from inside its body. Because the REST handler
called `beginVerification` before its own `gate_signal_received`
broadcast, the events arrived on the wire in inverted order. The fix:

- `beginVerification` does NOT broadcast. It only enumerates steps and
  seeds the active entry.
- The REST handler emits `gate_verification_started` *after*
  `gate_signal_received`, reading the harness-stamped `startedAt` via
  `getActiveVerification(signalId)`.
- The fallback branch inside `verifyGateSignal` (resume-on-restart, direct
  test calls) keeps its own broadcast so those paths still emit the event.

`getActiveVerification(signalId): ActiveVerification | undefined` exists
specifically to support this read-after-seed pattern from the REST
handler.

## `GateSignalStep` carries lifecycle status

The persisted `GateSignalStep` (`gate-store.ts`) gained two optional
fields populated by `beginVerification`:

| Field | Values | When set |
|---|---|---|
| `status` | `"waiting" \| "running" \| "passed" \| "failed" \| "skipped"` | On initial enumeration and during execution. Omitted on terminal-state rows where `passed`/`skipped` already carry the verdict. |
| `phase` | `number` (default 0) | Mirrored from the workflow `VerifyStep` for ordering. |

The dashboard renderer (`goal-dashboard.ts`) consults `step.status` first
for in-flight signals. Without this, a freshly-seeded row with
`passed: false` and `status: "running"` would have rendered as a failed
step until the live `ActiveVerification` entry caught up via the next
poll. The renderer logic is:

```ts
const inFlight = vStatus === "running" && step.status
              && step.status !== "passed" && step.status !== "failed";
const stepClass = inFlight
  ? (step.status === "running" ? "running"
   : step.status === "skipped" ? "skip" : "waiting")
  : (step.passed ? "pass" : "fail");
```

Completed signals leave `status` unset and fall back to the boolean
`passed` verdict — the historical shape is unchanged.

## Stale-verification cancellation ordering

`cancelStaleVerifications(goalId, gateId)` iterates `activeVerifications`
and terminates entries that match the `(goalId, gateId)` pair. It must
run **before** `beginVerification` for the new signal — otherwise the
sweep observes the just-seeded entry as a "stale" verification for the
same gate, broadcasts `gate_verification_complete { status: "cancelled" }`,
and removes it.

The REST handler enforces this order. Any future call site that signals
a gate must follow the same pattern: cancel-stale → begin → record →
broadcast `signal_received` → broadcast `verification_started` → kick off
async `verifyGateSignal`.

## What is NOT changed

- **Per-step transition logic.** As individual steps run, the harness
  still flips their `status` from `"running"` to `"passed"`/`"failed"`/
  `"skipped"` and broadcasts `gate_verification_step_started` /
  `gate_verification_step_complete`. None of that path moved.
- **Resume-on-restart.** `resumeInterruptedVerifications` reads the
  persisted `active-verifications.json` exactly as before. The new
  per-step `status` field is additive; older persisted entries without
  it are treated as if `status` were absent (the boolean `passed` flag
  still drives terminal rendering).
- **Polling interval / batching on the dashboard side.** The fix holds
  even with a 1 ms-interval poller, by construction.

## Where the code lives

| File | Symbol | Responsibility |
|---|---|---|
| `src/server/agent/verification-harness.ts` | `beginVerification(signal, gate)` | Synchronous step enumeration + `activeVerifications` seed. Returns `GateSignalStep[]` ready to assign to `signal.verification.steps`. No WS broadcast. |
| `src/server/agent/verification-harness.ts` | `getActiveVerification(signalId)` | Public lookup so the REST handler can read back `startedAt` after `beginVerification` to emit `gate_verification_started` in the correct order. |
| `src/server/agent/verification-harness.ts` | `verifyGateSignal(signal, gate, …)` | Reuses the pre-seeded `activeVerifications` entry when present; falls back to legacy inline construction (and its own `gate_verification_started` broadcast) only for callers that bypass the REST handler. |
| `src/server/agent/gate-store.ts` | `GateSignalStep.status` / `phase` | Persisted lifecycle fields populated by `beginVerification`. |
| `src/server/server.ts` | `/api/goals/:id/gates/:gateId/signal` POST handler | Orchestrates the cancel-stale → begin → record → broadcast sequence. |
| `src/app/goal-dashboard.ts` | Signal-entry renderer | Consults `step.status` first for in-flight signals so seeded `running`/`waiting` rows don't render as failed. |
| `src/app/api.ts` | `GateSignalStep` client shape | Mirrors the server `status`/`phase` additions. |
| `tests/gate-signal-step-enumeration.test.ts` | Unit | Asserts the gate-store signal and `activeVerifications` agree on `steps[]` immediately after `recordSignal`. |
| `tests/e2e/gate-signal-progress.spec.ts` | API E2E | POSTs a signal, immediately re-reads the gate via summary / inspect / active endpoints and asserts identical step lists within the same scheduler tick. |
| `tests/e2e/ui/verification-progress-indicator.spec.ts` | Browser E2E | Asserts the dashboard renders named verify-card chips immediately after signal (no empty "Verification in progress…" placeholder) and that the chips survive a page reload (rendered from persisted gate-store state alone). |

## Origin

Observed on the dev gateway during the `goal/configurab-99c9ffe2`
(configurable base ref) goal — after the team lead signaled the
`implementation` gate, the dashboard's progress indicator stayed blank
for ~15-30 s, then "caught up". `gate_status` confirmed
`latestSignal.verification.steps: []` even though the `gate_signal`
response had returned all eight steps. Fixed in goal "Fix verification
progress race" (commits `f872d625`, `c1b59b95`, `06eb1f68`).
