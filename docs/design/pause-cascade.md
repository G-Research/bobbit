# Pause Cascade

The Pause mechanism lets an operator stop all activity on a goal and its subtree without destroying it. This doc covers the full pause lifecycle, including durable operator intent, prompt rejection, and the in-chat warning banner.

## Overview

Pause is an **operator action** — it can be triggered from the goal dashboard by any authenticated user (cookie or team-lead secret). It is entirely separate from the scheduler's dependency `blocked` state; operator pause must not clear dependency blocking, and dependency-blocking never triggers a pause.

The two REST endpoints are:

```
POST /api/goals/:id/pause   { cascade: boolean }
POST /api/goals/:id/resume  { cascade: boolean }
```

`cascade: true` propagates the action to all descendants; `cascade: false` affects only the target goal. Omitting the body returns `422 CASCADE_REQUIRED`.

Both endpoints are **not** gated on the `subgoalsEnabled` system preference. Pause/resume have no dependency on subgoal functionality — they control goal execution lifecycle, not goal creation topology. Earlier versions incorrectly placed these routes behind `requireSubgoalsEnabled()` because they share `nested-goal-routes.ts` with actual subgoal routes (`spawn-child`, `integrate-child`, `plan`). That guard has been removed; pause and resume work on every install regardless of the subgoals setting.

## What pause does

When a goal is paused:

- **Sessions are soft-aborted.** All sessions associated with the goal and its subtree receive a graceful abort signal.
- **In-flight verifications are cancelled.** Gate verifications that are running or awaiting a reviewer are cancelled.
- **Spawns are blocked, with one explicit-start exception.** An authorized operator's `POST /api/goals/:id/team/start` may first run the canonical single-goal resume lifecycle and then start that goal's team. It never resumes descendants, and scheduler-owned `blocked` remains scheduler-owned. Bearer credentials and agent-tool callers cannot use this exception; all other spawn paths still return `409 GOAL_PAUSED`. See [Explicit start lifecycle](../rest-api.md#explicit-start-lifecycle).
- **Prompts are rejected.** `POST /api/goals/:id/team/prompt` and `POST /api/sessions/:id/prompt` continue to return `409 GOAL_PAUSED` when the target session's goal is paused (see [Prompt rejection](#prompt-rejection)).
- **Boot-resume nudges are skipped.** After a gateway restart, paused restored leads are not nudged to continue.
- **Pause is durable.** Operator pauses survive gateway restart, including when the goal has unresolved dependencies, and the restored goal remains shown as paused in the UI.

## Persistence and dependency scheduling

An operator pause is persisted atomically as `paused: true` with
`pauseSource: "operator"`. The provenance matters because an operator pause and
a scheduler dependency wait can both coexist on a `blocked` goal. On gateway
startup, `GoalManager` preserves records with operator provenance regardless of
whether their `dependsOnPlanIds` are resolved; it never reclassifies an
operator's instruction as a dependency wait.

The boot migration remains for compatibility. A pre-provenance paused record
with unresolved dependencies has no way to distinguish an old dependency pause
from an old operator pause, so it retains the prior migration: it becomes
`state: "blocked"` with `paused: false`. Keeping that migration prevents legacy
records from being stranded after their dependencies resolve. It is deliberately
skipped only for explicit operator provenance, which is the safe distinction the
older data did not carry.

When a paused child reaches its final resolved dependency, the dependency path
still submits it to the unified child scheduler. The scheduler leaves that child
`blocked` and queued without consuming a concurrency permit or attempting to
start a team. The queue is process-local, however, so a gateway restart loses
its membership and FIFO order. The durable `blocked` state plus resolved
`dependsOnPlanIds` lets a later resume reconstruct only this capacity-parked
child's scheduler request; it does not treat the volatile queue as persisted.

## What resume does

Resume clears the operator pause and re-enables spawns and prompt delivery. It
does **not** restart existing sessions, directly clear scheduler-owned
`blocked` state, or create a start for manual-start work.

There is one narrow scheduler re-drive. For each resumed child, the route may
return a request to the scheduler only when it is an eligible auto-start child,
its ancestors are unpaused, and all plan dependencies are resolved. It uses
existing in-memory scheduler intent when available. After a restart has lost
that volatile queue, a durable `state: "blocked"` child with resolved
dependencies is the narrow fallback that reconstructs a capacity-parked
request. The route does not start a team or choose capacity: the scheduler
retains lifecycle and concurrency-cap ownership. A child with an unresolved
dependency remains `blocked` for normal dependency integration, and manual-start
work is never invented.

Separately, an authorized explicit team start resumes only the requested
eligible goal before starting or returning its team; other sessions and
descendants remain untouched.

## Prompt rejection

Sending a prompt to a session whose goal is paused is rejected before any team membership or authorization checks:

```
HTTP 409
{ "error": "Goal is paused — resume it before sending prompts", "code": "GOAL_PAUSED", "goalId": "..." }
```

This applies to two endpoints:

- **`POST /api/goals/:id/team/prompt`** — checked after body parsing, before team membership verification. The goal is resolved from the URL `:id`; if it is paused, the 409 fires immediately.
- **`POST /api/sessions/:id/prompt`** — checked after body and caller-auth validation, before delivery. The goal is resolved from the target session's `goalId` or `teamGoalId`. Sessions with no associated goal are allowed through.

**Why reject before auth checks?** The pause check fires before team membership so that agents targeting a paused goal receive a clear, actionable error rather than an opaque auth failure. An agent that receives `GOAL_PAUSED` knows it should stop and wait rather than retry.

## In-chat warning banner

When an active session's goal is paused, a warning banner appears inside the conversation panel — above the chat messages — in all layout modes (connected, split, fullscreen, mobile). The banner:

- States "This goal is paused."
- Includes an inline **Resume** button that opens the same cascade-resume dialog as the goal header button.
- Uses `var(--warning)` color tokens.
- Carries `data-testid="goal-paused-banner"` for test targeting.
- Appears and disappears reactively as the goal's `paused` state changes (via WebSocket `goal_updated` events).

**Why a banner in addition to the header button?** The Pause/Resume toggle in the goal header is only visible on the goal dashboard, not inside individual session views. A user looking at a session transcript in a split layout may not notice the header state. The in-chat banner makes the paused state unmissable regardless of how the session is viewed.

The banner is rendered by `renderGoalPausedBanner` in `src/app/render.ts`, in the same banner stack as `renderArchivedBanner` and the reconnect banner, so it stacks predictably with other session-state indicators.

## Pending UI feedback

Pause/resume actions show immediate client-side feedback while the request is in flight. This feedback prevents double submission and avoids the appearance that a click did nothing while the server mutation and follow-up refresh complete.

- The goal dashboard **Pause** button (`data-testid="goal-pause-btn"`) becomes disabled and changes its label to **Pausing…**.
- The goal dashboard **Resume** button (`data-testid="goal-resume-btn"`) becomes disabled and changes its label to **Resuming…**.
- The paused-banner **Resume** button (`data-testid="goal-paused-banner-resume-btn"`) uses the same disabled **Resuming…** state.
- Duplicate pause/resume clicks are suppressed while the matching action is pending, including calls that bypass DOM disabled-state handling.
- On failure, pending feedback is cleared and the existing connection-error UI is shown.
- The final paused/resumed state remains canonical from the server refresh or WebSocket state; the client does not treat the pending affordance as a local paused-state mutation.

No-descendant actions use the pending button state around the direct `{ cascade: false }` request. Cascade confirmation dialogs keep their own existing working labels (`Pausing…` / `Resuming…`) while their confirm action is running.

## Authorization

Pause and resume are classified as **`operator`** actions in `children-mutation-authz.ts`. The authorization check (`authorizeTeamLeadOrReject(id, "operator")`) accepts:

- A verified `bobbit_session` cookie (human UI actions).
- A caller whose session secret resolves to the goal's team lead.

See [docs/nested-goals.md — Security model](../nested-goals.md#security-model) for the full authorization split between `orchestration` and `operator` verbs.

## Key files

| File | Role |
|---|---|
| `src/server/agent/nested-goal-routes.ts` | Pause/resume REST handlers and dependency auto-unblock submission |
| `src/server/agent/goal-store.ts` | Persisted `paused` flag and optional pause provenance |
| `src/server/agent/goal-manager.ts` | Boot-time legacy dependency-pause migration |
| `src/server/agent/child-team-scheduler.ts` | Capacity queue that skips paused children without starting them |
| `src/server/agent/goal-paused-guard.ts` | Spawn-time pause check (`409 GOAL_PAUSED`) |
| `src/server/server.ts` | Prompt-time pause checks (team/prompt and session/prompt) |
| `src/app/api.ts` | Shared dashboard/banner pending state and pause/resume dialog entrypoints |
| `src/app/dialogs.ts` | Direct no-descendant requests and cascade-confirm working labels |
| `src/app/goal-dashboard.ts` | Dashboard Pause/Resume controls |
| `src/app/render.ts` | In-chat banner (`renderGoalPausedBanner`) |

## Test coverage

- `tests/unit/core/operator-pause-durability-repro.unit.test.ts` — operator provenance survives manager re-initialization with unmet dependencies; pre-provenance dependency pauses still migrate to `blocked` and unpaused; a resolved paused sibling is queued rather than started.
- `tests/e2e/browser/crash-restart.browser-e2e.spec.ts` — UI and persisted state remain paused after a real gateway crash/restart with an unmet dependency.
- `tests/integration/gateway/api-goals-prompt-paused.gateway.test.ts` — 409 `GOAL_PAUSED` for team/prompt and session/prompt; pause/resume without subgoals enabled.
- `tests/integration/gateway/api-subgoals-disabled.gateway.test.ts` — pause and resume are excluded from the `SUBGOALS_DISABLED` routes list.
- `tests/browser/journeys/goal-paused-banner.journey.spec.ts` — banner appears on pause, Resume button opens dialog, banner disappears on resume.
- `tests/dom/goal-pause-resume-feedback.dom.test.ts` — dashboard and transcript-banner pending labels, duplicate suppression, and failure recovery.
