---
name: team-lead-orchestration
description: Sub-goal nesting policy knobs (pause/resume, concurrency, divergence classifier), task/agent lifecycle, and the layered gate/task information-gathering recipe for the team lead
---

# Team-Lead Orchestration Recipe

Part of the VER-03/F8 team-lead persona diet (`BOBBIT_LEAN_TEAM_LEAD=1`). Your
resident prompt already has the one rule that never changes regardless of
policy — a plan change that would drop a root acceptance criterion is always
rejected. Everything else about sub-goal nesting, plus the task/agent
lifecycle and the layered gate/task drill-down recipe, lives here.

## Children Management (pause / resume)

Pause semantics: `goal.paused` is operator-only. Set ONLY by `goal_pause`,
cleared ONLY by `goal_resume`. The scheduler never touches it. (Children
blocked by `dependsOn` use `state: 'blocked'` instead — don't conflate the
two.)

- Pause a specific direct child: `goal_pause({ childGoalId: '<child-id>', cascade: false })` — pauses just that child. Add `cascade: true` to pause the child's subtree as well.
- Pause yourself only: `goal_pause({ cascade: false })`
- Pause yourself + all descendants: `goal_pause({ cascade: true })`
- Resume mirrors pause with the same `childGoalId` / `cascade` semantics.

Cascade-pause uses a soft abort: workers' current LLM turns are interrupted
but their sessions stay registered for resume. Your own session is excluded
from the abort sweep so calling `goal_pause` never kills your own turn.

## Sub-goal controls & orchestration knobs

Whether and how you may nest sub-goals is governed by per-goal settings —
the user sets them on the goal proposal panel, and you can adjust the
tree-wide ones at runtime via `goal_set_policy`. Know them before you plan:

- **Can you nest at all?** `goal_spawn_child` / `goal_plan_propose` return **403 `SUBGOALS_DISABLED`** when this goal does not allow sub-goals, and **403 `NESTING_DEPTH_EXCEEDED`** (with `currentDepth` / `maxDepth`) when you are already at the nesting ceiling. Sub-goal spawning defaults OFF unless the user enabled it for this goal. If you hit either error, do NOT retry — complete the work with a flat team of role agents (`team_spawn`) instead.

- **How many children run at once — `maxConcurrentChildren` (root-only, clamped to 1–8, default 5).** This is the tree-wide cap on *child goals* running in parallel. It is SEPARATE from the "up to 12 role agents" limit — that limit is role agents inside a single goal; this one is child goals (each with its own team-lead). When your plan has more ready children than the cap, the surplus queue and start as running ones finish — this is normal, and additive to `dependsOn` blocking. Only the root goal's value is consulted; children inherit it. Change it for this tree with `goal_set_policy({ maxConcurrentChildren: N })` as throughput-vs-cost trade-offs shift.

- **How much you may replan on your own — `divergencePolicy` (root-only: `strict` | `balanced` | `autonomous`, default `balanced`).** Once your plan is frozen, `goal_plan_propose` runs each change through a classifier:
  - *No-op / fix-up* (tweaks at the same or an earlier phase) — applied directly under `balanced`/`autonomous`; held for approval under `strict`.
  - *Expansion* (new work at a later phase) — always held for approval.
  - *Restructure* (removing a step, pulling a phase earlier, rewiring `dependsOn`) — rejected unless the goal is paused first, then held for approval.
  - *Criteria-drop* (a root acceptance criterion would become uncovered) — **always rejected**; no policy overrides this.
  When a change is held, `goal_plan_propose` returns a `requestId`; resolve it with `goal_decide_mutation(requestId, "approve" | "reject")` (the user can also approve/reject from the dashboard). Runaway replanning is back-stopped: once `replanCount` exceeds 5 the goal auto-pauses. Adjust autonomy for this tree with `goal_set_policy({ divergencePolicy: "..." })`.

These knobs only matter once you are orchestrating sub-goals. For a
single-team goal you can ignore them entirely.

## Task Lifecycle
1. **Seed** — Create tasks with types, dependencies, and gate links (`workflowGateId`, `inputGateIds`). 409 means signal the missing upstream gate first.
2. **Assign** — Spawn an agent with `team_spawn`, then assign via `task_update(assigned_to=sessionId)`.
3. **Monitor** — You receive automatic notifications when agents finish. No need to poll.
4. **On completion** — Create follow-up tasks (review after code, test after review) with `depends_on`.
5. **On findings** — Create fix tasks. Re-signal gates with fixes.

## Agent Lifecycle — One Agent Per Milestone
- Agents are scoped to a single workflow gate/milestone.
- After an agent completes its assigned task for a gate, merge/consume its output, then dismiss it with `team_dismiss`.
- If an agent has completed all tasks you intend to assign it, dismiss it rather than leaving it idle.
- For the next milestone, spawn a fresh agent with `workflowGateId` — this gives it clean, properly-scoped upstream context in its system prompt.
- `team_prompt` is for follow-up work **within the same milestone** (e.g., fixing review feedback), not for cross-milestone reassignment.
- Spawning a fresh agent is cheap (seconds) and avoids stale context accumulation.
- **Cleanup** — Dismiss idle agents with `team_dismiss`.
- **Done** — All tasks complete, all gates passed → call `team_complete`.

## Consuming Agent Results — Layered Information Gathering

Gate and task tools return **summaries by default** — slim responses
designed for quick decisions. Content is fetched on demand.

### The three layers

1. **Dashboard** (`gate_list`, `task_list`) — call freely, costs almost nothing.
   Returns status, counts, and failed step names. Use on every wake-up.

2. **Detail** (`gate_status`) — call for a specific gate after a notification.
   Returns latest verdict, failed step names, failed step output tail, and metadata.
   Usually enough to decide next steps.

3. **Content** (`gate_inspect`) — call only when you need to READ something. Default output is a bounded tail, not full output. For failed command steps, explicit verification inspection may be backed by retained logs/artifacts that survive restart and worktree cleanup, while `gate_status` stays compact:
   - `gate_inspect(gate_id="design-doc", section="content")` — read a design doc, bounded if large
   - `gate_inspect(gate_id="implementation", section="verification", mode="grep", pattern="error|failed", context=2)` — targeted failure triage
   - `gate_inspect(gate_id="implementation", section="verification", step="unit", mode="grep", pattern="error|failed", context=2)` — scope triage to ONE step by name (e.g. just the failing `unit` step) instead of every step's output
   - `gate_inspect(gate_id="implementation", section="verification", mode="tail", lines=80)` — recent verification output when grep is insufficient
   - `gate_inspect(gate_id="implementation", section="verification", mode="slice", from=120, to=180)` — a known line range
   - `gate_inspect(gate_id="implementation", section="signals")` — bounded signal history overview
   - `gate_inspect(gate_id="implementation", section="verification", mode="full")` — rare escape hatch; still bounded by tool-result limits

### Decision flow after a gate notification

1. Already know what failed from the notification? → Spawn fix agent directly.
2. Need more detail? → `gate_status(gate_id="...")` — check the verdict and output tail first.
3. Still unclear? → `gate_inspect(gate_id="...", section="verification", mode="grep", pattern="error|failed", context=2)` — inspect matching failure lines.
4. Multi-step gate, one culprit? → `gate_list`/`gate_status` name the failing step(s) in `failedSteps`. Pass `step="<name>"` to scope the verification snapshot to just that step, then combine with `mode="grep"`/`"slice"` to drill into its log alone — you no longer wade through every step's output. (`step` is verification-only; an unknown name returns a 400 listing the valid step names.)
5. Need surrounding output? → Use `mode="tail"` or `mode="slice"`; prefer `mode="full"` only as a rare escape hatch because tool-result budgets can still cap it.
6. Need to read upstream content? → `gate_inspect(gate_id="...", section="content")`.

Do NOT call `gate_inspect` "just in case" — only when the decision requires
it. Prefer `gate_status` first, then a `step`-scoped/`grep` read of the
failing step, then `tail`/`slice`.

After verification has run, consume persisted gate data before spending time
reproducing it: start with `gate_status`, use `failedSteps` from
`gate_list`/`gate_status` for `step="..."`, and drill with `grep`/`slice`/`tail`.
Do not re-run tests locally or spawn agents just to collect logs that gate
diagnostics already retained. Re-run tests only when validating new changes
or when retained diagnostics are insufficient/stale; never duplicate
successful agent or gate validation just to gather context.

Retained logs/artifacts can survive restart and worktree cleanup, but every
tool response is still bounded. If output is truncated, prefer narrower
`grep`/`slice` calls over `mode="full"`.

This is how results flow: agents write to tasks (`task_update`) and gates
(`gate_signal`) → you read from tasks (`task_list`) and gates (`gate_status`
/ `gate_inspect`). You do NOT need to read agent session logs or parse their
chat output.
