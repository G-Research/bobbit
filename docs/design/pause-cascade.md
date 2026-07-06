# Pause Cascade

The Pause mechanism lets an operator stop all activity on a goal and its subtree without destroying it. This doc covers the full pause lifecycle, including two recent additions: prompt rejection and the in-chat warning banner.

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
- **Spawns are blocked.** Every spawn path (team start, child spawn, integration) returns `409 GOAL_PAUSED` while the goal remains paused. This includes both REST and agent-tool paths.
- **Prompts are rejected.** `POST /api/goals/:id/team/prompt` and `POST /api/sessions/:id/prompt` return `409 GOAL_PAUSED` when the target session's goal is paused (see [Prompt rejection](#prompt-rejection)).
- **Boot-resume nudges are skipped.** After a gateway restart, paused restored leads are not nudged to continue.
- **Pause is durable.** The paused state survives gateway restart and is restored from persisted goal state.

## What resume does

Resume re-enables spawns and prompt delivery but does **not** auto-restart sessions. Operators must manually start or prompt sessions after resuming a goal.

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

## Authorization

Pause and resume are classified as **`operator`** actions in `children-mutation-authz.ts`. The authorization check (`authorizeTeamLeadOrReject(id, "operator")`) accepts:

- A verified `bobbit_session` cookie (human UI actions).
- A caller whose session secret resolves to the goal's team lead.

See [docs/nested-goals.md — Security model](../nested-goals.md#security-model) for the full authorization split between `orchestration` and `operator` verbs.

## Key files

| File | Role |
|---|---|
| `src/server/agent/nested-goal-routes.ts` | Pause and resume REST handlers |
| `src/server/agent/goal-paused-guard.ts` | Spawn-time pause check (`409 GOAL_PAUSED`) |
| `src/server/server.ts` | Prompt-time pause checks (team/prompt and session/prompt) |
| `src/app/render.ts` | In-chat banner (`renderGoalPausedBanner`) |

## Test coverage

- `tests/e2e/api-goals-prompt-paused.spec.ts` — 409 GOAL_PAUSED for team/prompt and session/prompt; pause/resume without subgoals enabled.
- `tests/e2e/api-subgoals-disabled.spec.ts` — pause and resume are excluded from the `SUBGOALS_DISABLED` routes list.
- `tests/e2e/ui/goal-paused-banner.spec.ts` — banner appears on pause, Resume button opens dialog, banner disappears on resume.
