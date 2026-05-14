# `propose_goal` Parent Picker & Depth Indicator

## Overview

When a user (or agent) proposes a new goal, the proposal modal can now designate a parent goal, making the new goal a subgoal of an existing one. This feature adds:

- **Parent picker** — a dropdown to select any non-archived goal in the same project as the parent.
- **Breadcrumb** — `Project › Parent › New Goal` path shown below the parent picker.
- **Depth indicator** — `depth N of M` badge that turns red when the nesting cap is reached.
- **"Subgoal of X" badge** — shown when a parent is selected; replaced by "Top-level goal" badge when no parent is set and subgoals are enabled.
- **Auto-inject for team-leads** — when a team-lead agent calls `propose_goal`, the server automatically pre-fills `parentGoalId` from the session's `teamGoalId`, so agents don't need to pass it explicitly.

The feature is conditional on the **Subgoals (Experimental)** preference (`subgoalsEnabled`). When the toggle is off, the picker is hidden — but if a proposal was already seeded with a `parentGoalId` (e.g. from a team-lead auto-inject), the picker remains visible so the user can clear it.

## User Flow

1. The user (or an agent) triggers `propose_goal`.
2. The proposal panel opens. If subgoals are enabled (or `parentGoalId` was pre-filled), the **Parent** dropdown appears.
3. The dropdown lists all non-archived goals in the same project. "— Top-level goal —" is the blank/default option.
4. Selecting a parent reveals the breadcrumb and depth indicator below the picker.
5. The depth indicator shows `depth N of M`. When `N >= M` (cap reached), it turns red and the **Create Goal** button is disabled.
6. If no parent is selected and subgoals are enabled, a muted "Top-level goal" badge appears instead.
7. Accepting the proposal calls `POST /api/goals` with the selected `parentGoalId` (or none for top-level).

## Server-Side

### Proposal seed auto-inject

Handler: `POST /api/sessions/:id/proposal/goal/seed` in `src/server/server.ts`.

When the seeding session is a `team-lead` and its `teamGoalId` is set, and the incoming `args` do not already contain a `parentGoalId` (or it is an empty string), the server enriches `args` with `parentGoalId: sess.teamGoalId` before writing the draft. This means agents calling `propose_goal` from inside a goal automatically propose a subgoal of that goal, with no extra argument required. The agent can still override this by passing `parentGoalId` explicitly.

### `POST /api/goals` — `parentGoalId` handling

The goal creation handler validates `parentGoalId` before calling `GoalManager.createGoal`:

1. **Same-project check** — the parent goal must exist in the same project. Cross-project parents are rejected because `createGoal` only walks its own goal store for depth and cycle detection.
2. **Depth cap check** — `checkCanSpawnChild` is called with the parent goal; it validates `subgoalsAllowed` and the effective nesting depth cap.
3. **Nesting inheritance** — when a parent is set, `inheritedChildOverrides(parent, prefs)` derives `subgoalsAllowed` and `maxNestingDepth` for the new child.

On success, `parentGoalId` is passed through to `GoalManager.createGoal`, which derives `rootGoalId` and `mergeTarget` automatically (see [goals-workflows-tasks.md — Nested goals](../goals-workflows-tasks.md#nested-goals-phase-1-data-model)).

### Error codes

All errors are `422` unless noted.

| Code | When |
|---|---|
| `PARENT_NOT_FOUND` | `parentGoalId` is not found in any project |
| `PARENT_CROSS_PROJECT` | `parentGoalId` exists but belongs to a different project |
| `SUBGOALS_DISABLED` | Subgoals preference is off for this goal tree |
| `NESTING_DEPTH_EXCEEDED` | Adding the child would exceed the effective `maxNestingDepth`. Response includes `currentDepth` and `maxDepth` fields. |

The UI renders these as a `showConnectionError` toast. The depth-cap error includes the numeric depth values so the message reads: `"Nesting depth cap reached: 3 / 3"`.

## Client-Side

UI implementation lives in `renderGoalForm` in `src/app/render.ts`.

### `GoalFormConfig` fields

| Field | Type | Purpose |
|---|---|---|
| `parentGoalId` | `string \| undefined` | Currently selected parent goal ID |
| `onParentGoalChange` | `(id: string \| undefined) => void` | Called when the dropdown changes |
| `subgoalsEnabled` | `boolean` | Whether to show the picker at all |
| `maxNestingDepth` | `number \| undefined` | Cap shown in the depth indicator (defaults to 3) |

### UI elements and `data-testid`s

| Element | `data-testid` | When rendered |
|---|---|---|
| Parent picker row (label + dropdown) | `goal-form-parent-row` | `subgoalsEnabled === true` OR `parentGoalId` is set |
| Breadcrumb | `goal-form-breadcrumb` | `parentGoalId` is set |
| Depth indicator | `goal-form-depth-indicator` | `parentGoalId` is set |
| "Subgoal of X" badge | `goal-form-subgoal-badge` | `parentGoalId` is set |
| "Top-level goal" badge | `goal-form-toplevel-badge` | `parentGoalId` is NOT set AND `subgoalsEnabled === true` |

The **Create Goal** button is disabled when the depth indicator is at cap (`childDepth >= maxNestingDepth`).

### Breadcrumb content

`Project › Parent Title › New Goal` (or just `Parent Title › New Goal` if the linked project is unknown). The project name comes from `config.linkedProjectId`; the parent title comes from the live `state.goals` list. If the parent goal cannot be found by ID (e.g. not yet loaded), the raw `parentGoalId` string is shown as a fallback.

### Parent picker filtering

The dropdown filters `state.goals` to:
- Non-archived goals only.
- Same-project goals only (when `config.linkedProjectId` is set).

This matches the server-side same-project requirement so invalid selections are caught in the UI before the API call.

### Depth computation

`computeGoalDepth(goalId, goals)` walks the `parentGoalId` chain in the client-side `state.goals` array to compute the 1-based depth (root = 1). The result is capped at 20 to guard against corrupt chains. Child depth = `parentDepth + 1`.

## Agent Usage

Team-lead agents can create subgoals of their current goal by calling `propose_goal` with just `title` and `spec` — no `parentGoalId` argument needed:

```
propose_goal(
  title="Implement feature X",
  spec="## Overview\n...\n## Covers\n- acceptance criterion"
)
```

The server's proposal seed handler detects that the calling session is a team-lead (`sess.role === "team-lead"`) with a `teamGoalId`, and pre-fills `parentGoalId` automatically. The user sees the proposal modal with the parent pre-selected and can clear it if they want a top-level goal instead.

To explicitly create a top-level goal from a team-lead session, pass `parentGoalId: ""` (empty string) — the server treats this the same as omitted.

## Constraints

- **Same-project only.** The parent goal must be in the same project as the new goal. The client-side picker filters the list; the server enforces it with `PARENT_CROSS_PROJECT`.
- **Depth cap.** The effective cap is determined by the root goal's `maxNestingDepth` setting (or the `maxNestingDepth` preference if no root-level override exists). The UI disables the Create button at cap; the server returns `NESTING_DEPTH_EXCEEDED` as a final guard.
- **Subgoals toggle.** The picker is only shown when `subgoalsEnabled` is `true` (Settings → Subgoals). Exception: if `parentGoalId` is already set on the proposal (e.g. from team-lead auto-inject), the picker stays visible even when the toggle is off, so the user can clear it and proceed with a top-level goal.
- **`parentGoalId` is set at creation only.** The server never updates it after creation. `rootGoalId` and `mergeTarget` are server-derived and not accepted from the client.

## Related Docs

- [goals-workflows-tasks.md — Nested goals](../goals-workflows-tasks.md#nested-goals-phase-1-data-model) — full `PersistedGoal` field reference.
- [nested-goals.md](../nested-goals.md) — depth caps, the per-goal toggle, and spawn-child semantics.
- [design/subgoals-experimental-toggle.md](subgoals-experimental-toggle.md) — the system-scope `subgoalsEnabled` preference.
- [rest-api.md — POST /api/goals](../rest-api.md#goals) — API reference including new error codes.
- Browser E2E: `tests/e2e/ui/propose-goal-parent-picker.spec.ts`.
