# Team-lead spec injection at kickoff

## Problem: the two-stage placeholder race

When a team-lead session starts, it needs the goal spec to plan its work.
Historically that spec arrived through two indirect channels:

1. The goal's spec was embedded into the team-lead's **system prompt** at
   session-construction time, and
2. The agent's startup sequence instructed it to call `view_goal_spec` as
   its first tool action to read the canonical body.

That two-stage pattern was redundant on the happy path and broken on the
unhappy one. The unhappy path is **deferred-spec child spawns**:

- A parent team-lead spawns a child via `goal_spawn_child` with the spec
  set to the sentinel string `"placeholder"`.
- The server immediately calls `teamManager.startTeam(...)` (via the
  `autoStartTeam` flag) to get the worktree provisioned and the lead
  booted — fast, in parallel with the parent's next turn.
- The parent then fills in the real spec via `PUT /api/goals/:id` once it
  has finished writing it.

If session setup finished before the parent's `PUT`, the child team-lead
booted with `"placeholder"` baked into its system prompt. The agent had
to detect the placeholder, wait for the `goal_spec_changed` notification,
and re-call `view_goal_spec`. Token waste, latency, and a complicated
"is this the placeholder or the real thing?" branch in the role prompt.

## Fix: inject the spec into the first user message, freshly read

Two changes:

1. **Kickoff message carries the spec.** In
   `src/server/agent/team-manager.ts::_startTeamImpl`, just before the
   kickoff prompt is dispatched, the manager re-reads the goal record
   from its store and prepends the spec to the first user message as a
   delimited `# Goal Spec` block:

   ```
   # Goal Spec

   <freshly read goal.spec>

   ---

   Execute the task described in your system prompt. Follow the instructions carefully.
   ```

   The re-read is the key part. Session construction is async (worktree
   setup, MCP boot, etc.) and during that window a parent goal may still
   be in the middle of writing the real spec. Reading the goal store at
   the moment of dispatch — not at construction — closes the race.

2. **REST guard rejects empty/placeholder specs.**
   `POST /api/goals/:id/team/start` now returns
   `400 { code: "SPEC_REQUIRED" }` when the spec is empty, shorter than
   20 characters, or literally `"placeholder"`. This catches user-driven
   "Start Team" clicks against a goal whose spec was never filled in.

   The guard is REST-only. The two internal `teamManager.startTeam(...)`
   call sites — `autoStartTeam` (for project-assistant-created goals
   that already have real specs) and the verification-harness subgoal
   step (which uses the deferred-spec pattern intentionally) — bypass
   the REST layer and are unaffected.

## Why the kickoff message rather than the system prompt

The system prompt is built once when the agent session is constructed.
Refreshing it after construction means tearing down and rebuilding the
agent (the same heavy machinery used by compaction). Injecting at
**prompt** time, in contrast, is just a string concatenation immediately
before `rpcClient.prompt(...)`.

The system-prompt copy of the spec is still emitted as a fallback — if
some future call path bypasses the kickoff helper, the agent still has
the spec available in its context — but it is no longer the canonical
source and agents are explicitly told not to rely on it.

## Knock-on changes

- `defaults/roles/team-lead.yaml::promptTemplate` — step 1 of the
  startup sequence now reads "**The goal spec is in your first user
  message** — read it carefully before doing anything else. Do NOT
  call `view_goal_spec` on startup; it's only for re-reading after a
  `goal_spec_changed` notification."

- `defaults/tools/proposals/view_goal_spec.yaml` — summary and docs
  re-pitched as a **mid-flight re-read escape hatch**. The tool still
  exists; it is just no longer the canonical first-action read. It is
  invoked when a `goal_spec_changed` WebSocket notification fires
  mid-session (see [goal-spec-edit-notification.md](goal-spec-edit-notification.md)).

## Tests

- Unit: kickoff prompt shape, with and without a spec body.
- E2E: `POST /api/goals/:id/team/start` returns `400 SPEC_REQUIRED` for
  empty / short / `"placeholder"` specs; succeeds with a real spec.

## Future work

If a third call path appears that needs to start a team with deferred
spec, the same "re-read at dispatch" pattern should be lifted into a
helper rather than copied. The `autoStartTeam` path is fine today
because it shares `_startTeamImpl`; the verification-harness subgoal
path is fine for the same reason. Any new entry point should funnel
through `_startTeamImpl` rather than calling `createSession` directly.
