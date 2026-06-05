# Human Sign-Off Gates

Status: shipped. Lives on `master` after the *Human Sign-Off Gates* goal (`goal/human-sign-off-0333f6af`).

## What it is

A third "human-decided" verification step type that pairs with the existing
`command`, `llm-review`, and `agent-qa` step types. A `human-signoff` step
parks the gate verification on a deferred resolver until a human approves or
rejects the step via the UI; the gate then transitions exactly as it would
for any other step's pass/fail.

Three concerns ship together because they each only make sense in the
presence of the others:

1. **Backend step type** (`type: human-signoff`) — verification harness
   wiring, REST endpoint, WebSocket event, restart-safe persistence.
2. **`<goal-status-widget>` + review pane** — chat-header pill mounted next to
   `<git-status-widget>` that surfaces gate progress and hands pending
   sign-off content to the review pane for Approve / Reject decisions.
3. **Four-rule notification policy** — the team-lead unread-dot predicate
   gains pending-sign-off and errored-and-parked rules, and a debounced
   "idle stuck" rule that closes the historical spawn-handoff
   false-positive.

User-facing docs:
[goals-workflows-tasks.md — Human sign-off steps](../goals-workflows-tasks.md#human-sign-off-steps)
· [review-pane-signoff.md](../review-pane-signoff.md)
· [workflow-authoring-guide.md §4.4](../../defaults/workflow-authoring-guide.md)
· [rest-api.md — Sign-off endpoint](../rest-api.md#sign-off-endpoint).

Sibling design doc: [notification-policy.md](notification-policy.md) covers
the predicate split and the four-rule team-lead disjunction that this goal
finalises.

## Why a third step type instead of a tool call

Bobbit already has two non-command step shapes — `llm-review` and `agent-qa`
— that park verification on an async resolver and emit a final
`{ passed, output, artifact }` result. A `human-signoff` step is the same
shape with a different resolver: a REST endpoint hit by the human via the
UI, rather than a reviewer agent submitting `verification_result`. Reusing
the harness machinery means restart-safety, cancellation, gate-cascade
reset, and the team-lead "consume failed reviewer feedback" flow all work
without new wiring.

Specifically rejected: a "human ack" tool the team lead would call mid-turn.
That couples human approval to the lead's liveness, blocks gate progress on
agent context-window pressure, and would need its own UI surface anyway.

## Behavior contract

- **Persistence.** Awaiting-human state lives on the active verification's
  step record (the same store as `agent-qa` mid-flight state). The harness's
  resume path re-broadcasts `gate_verification_awaiting_human` so any
  connected UI rehydrates the pending request after a server restart.
- **Re-signal cancellation.** When the gate is re-signaled mid-await,
  `cancelStaleVerifications()` drains `pendingSignoffs` with
  `{ cancelled: true }`. The awaited promise resolves; the outer
  `active.cancelled` short-circuit handles the rest. No new failure mode.
- **Result shape.** The harness builds a step result identical to
  `llm-review`: `{ passed, output, artifact: { contentType: "text/markdown", content } }`.
  Rejection feedback (when provided) goes into both `output` and the
  artifact, so the team lead consumes a failed sign-off the same way it
  reads a failed review (no new steer wiring).
- **Authz (v1).** Trusts the gateway token. Bobbit has no user-identity
  model today; anyone with UI access can sign off. Submission records only
  a timestamp. Sandboxed agents are explicitly blocked at the
  `sandbox-guard` layer — a sandboxed sub-agent cannot self-approve a
  sign-off step that gates its own work.
- **Timeout.** None. Steps wait indefinitely. The existing dashboard
  "Cancel verification" affordance still applies.
- **Test bypass.** Only `BOBBIT_HUMAN_SIGNOFF_SKIP=1` auto-passes a
  human-signoff step. There is **no** fallback to
  `BOBBIT_LLM_REVIEW_SKIP` — a "human" gate must not share a bypass
  with `agent-qa` / `llm-review`, otherwise the global E2E harness
  (which sets `BOBBIT_LLM_REVIEW_SKIP=1`) would silently auto-approve
  every human gate. With `BOBBIT_HUMAN_SIGNOFF_SKIP` unset or `=0`,
  the step parks awaiting a real human decision. Removing the legacy
  fallback was the Bug-1 defense-in-depth fix in the "Re-attempt:
  Sign-Off Gates" goal.

## Data flow

1. Workflow YAML declares `verify[].type: human-signoff` with `label` +
   `prompt`.
2. `gate_signal` → harness enumerates steps via `beginVerification` →
   `verifyGateSignal` enters the phase loop.
3. The human-signoff branch substitutes the prompt, sets `awaitingHuman: true`
   on the active step, persists to `active-verifications.json`, broadcasts
   `gate_verification_awaiting_human`, and `await`s a `pendingSignoffs`
   resolver.
4. `<goal-status-widget>` receives the WS event, refreshes the awaiting
   list, and pulses the badge.
5. User clicks **View content** — the widget fetches the gate signal content
   and opens a `verification-signoff-markdown` review document.
6. User approves or rejects in the review pane — `POST /api/goals/:id/gates/:gateId/signoff`
   invokes `verificationHarness.resolveSignoff()` with any composed final/inline feedback.
7. Step result is built → standard `gate_verification_step_complete`
   broadcast → phase machinery proceeds → `gate_verification_complete`.

## Notification policy — four-rule team-lead disjunction

`src/app/notification-policy.ts` exports two predicates with different
read-filter semantics:

| Predicate                       | Read-filterable | Rules covered |
|---------------------------------|-----------------|---------------|
| `needsHumanAttention`           | yes             | 1, 4          |
| `needsImmediateHumanAttention`  | no (bypass)     | 2, 3          |

A team-lead session surfaces persistent unread state when **any** of the
following hold. Polling and active-session beeps use the same policy but exclude
the idle-stuck rule so routine mid-workflow waits stay silent:

| # | Rule | Read filter | Notes |
|---|---|---|---|
| 1 | Goal complete                              | yes | Existing behavior |
| 2 | Goal has ≥ 1 `awaitingHuman` step           | no  | Sign-off requests demand attention until resolved |
| 3 | `lastTurnErrored` and `consecutiveErrorTurns ≥ MAX_CONSECUTIVE_ERROR_TURNS` (= 3) | no | Canonical "human action required" state — messages parked in `promptQueue` awaiting explicit Retry |
| 4 | Idle for ≥ `STUCK_IDLE_THRESHOLD_MS` (10s) with no live siblings, no in-flight verification, no awaiting sign-off | yes | Closes spawn-handoff false-positive — sub-second flickers between delegate handoffs no longer trip the dot |

Rules are independent triggers (OR semantics). Rule 4 explicitly suppresses
on `awaitingHumanSignoff` so it doesn't double-count with rule 2. The policy is
pure and consumed by three call sites — `api.ts` (polling beep),
`remote-agent.ts` (active-session `agent_end`), and
`render-helpers.ts::hasUnseenActivity` (sidebar dot). See
[notification-policy.md](notification-policy.md) for the full call-site
inventory and the team-lead idle-nudge backoff that sits alongside it.

### Why rule 2 needed special wiring

`awaitingHumanSignoff` is denormalised onto `state.gateStatusCache` keyed by
goal id. Two pieces had to line up for the bit to actually reach the
predicate:

- **Server.** `GET /api/goals/:id/gates?view=summary` uses the shared gate-status summary builder to aggregate `awaitingSignoffCount` per gate plus a goal-wide total from active verifications. The bare `/gates` endpoint does not include the count.
- **Client.** `src/app/gate-status-events.ts` centralizes the lifecycle events that refresh `state.gateStatusCache` through `src/app/api.ts`. Parking refreshes on `gate_verification_awaiting_human`; resolution refreshes on the sign-off resolved custom event and subsequent verification-step/completion events.

Without both, the policy data path is dead — rule 2 stays dormant indefinitely.

## Key files

| File | Role |
|---|---|
| `src/server/agent/verification-harness.ts` | `human-signoff` branch in `verifyGateSignal`; `pendingSignoffs` map; `resolveSignoff()`; resume path; cancellation drain |
| `src/server/agent/workflow-validator.ts` | Validates `human-signoff` step requires `prompt` + `label` |
| `src/server/agent/workflow-store.ts` · `project-config-store.ts` · `gate-store.ts` | `VerifyStep.type` / `GateSignalStep.type` discriminant additions |
| `src/server/server.ts` · `src/server/gate-status-summary.ts` | `POST /api/goals/:id/gates/:gateId/signoff` handler; authoritative summary aggregation for `?view=summary` |
| `src/server/auth/sandbox-guard.ts` | Blocks sandboxed agents from POSTing to `/signoff` |
| `src/ui/components/GoalStatusWidget.ts` | The pill + popover + pending sign-off launcher that opens submitted content in the review pane |
| `src/app/lazy-widgets.ts` | `ensureGoalStatusWidget()` lazy loader |
| `src/ui/components/AgentInterface.ts` | Mounts `<goal-status-widget>` next to `<git-status-widget>` for any session with a `goalId` / `teamGoalId` |
| `src/app/render-helpers.ts` | `renderGateProgressBadge` and `renderGateStatusIcon` — shared visual vocabulary between sidebar, widget, and dashboard |
| `src/app/notification-policy.ts` | `needsHumanAttention` + `needsImmediateHumanAttention` predicates |
| `src/app/api.ts` · `src/app/gate-status-events.ts` · `src/app/remote-agent.ts` | Cache refresh wiring (`?view=summary` fetch + centralized gate lifecycle event matching) |
| `src/app/state.ts` | `gateStatusCache` value shape — `awaitingHumanSignoff: boolean`; review document/source state |

## Pinning tests

- `tests/notification-policy.spec.ts` — file:// fixture covering the
  four-rule matrix including the spawn-handoff debounce case.
- `tests/workflow-validator.spec.ts` — `human-signoff` requires `prompt` +
  `label`.
- `tests/e2e/human-signoff.spec.ts` — full REST flow: signal → poll until
  `awaitingHuman: true` → POST `/signoff` pass and fail paths → idempotent
  409 on repeat.
- `tests/e2e/ui/goal-status-widget.spec.ts` — pill visibility, popover,
  View content handoff, review-pane Approve / Reject flow, reload persistence,
  and cleanup.
