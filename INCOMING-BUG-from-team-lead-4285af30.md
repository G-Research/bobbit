# Bug report — execution-gate stuck in re-signal loop

**From:** team-lead-4285af30 (goal `v0.2 embeddings mcp retrieval`, id `4285af30-fe30-42ae-9683-fb2b6b6d5423`, branch `goal/v0-2-embed-4285af30`)
**To:** Meg Abyte / Nested goals & DAG subgoals team
**Forwarded by:** AJ
**Date:** 2026-05-02

## Symptom

`execution` gate stuck in failed→re-signal→failed loop. Harness keeps re-spawning duplicates of children that have actually completed and merged. Verification report cites archived child IDs (`31c49942-…`, `7f736b47-…`, `75dea8b6-…`, `6010be40-…`) under each plan step indefinitely.

## Plan + state

- 10-leaf parent-workflow plan, frozen via `goal-plan` signal (`maxConcurrentChildren: 5`, `divergencePolicy: balanced`).
- Phase 1 spawned 4 of 5 leaves (slot race; `context-fencing` never spawned). All 4 ran to `state: complete`.
- A server restart happened while children were complete-and-pending-merge.
- After restart, every `gate_signal execution` produces, for every plan step:

  > `Subgoal step interrupted by server restart — Detected partially-spawned child <id> (no team agents) — re-triggered worktree setup + team start.`

## Recovery I tried (fails to break the loop)

1. `goal_merge_child` ack'd `embedding-providers` clean (harness merged + archived original). For the other 3 (`sqlite-vec`, `streaming-scrubber`, `lifecycle-abc`) it 409'd on real conflicts (CHANGELOG.md, `tests/fakes/index.ts`, `src/config/defaults.ts`).
2. Manually `git merge --no-ff` the 3 branches; resolved conflicts; pushed. Goal HEAD now `52dfab2` and contains all 4 leaves' work.
3. Re-signal `execution` → harness spawned 4 *new duplicate* children (`31c49942`, `7f736b47`, `75dea8b6`, `6010be40`) with no team agents. All re-failed.
4. `goal_archive_child(recursive: true)` on all 4 duplicates.
5. Re-call `goal_merge_child` on the 3 remaining live-complete originals → all return `merged: true, commitSha: 52dfab2…` (already merged).
6. Re-signal `execution` → still fails citing the **same archived IDs from step 3**. The plan-step state retains them as canonical despite archival.

## Hypothesis

On `gate_signal execution`, the `spawnedFromPlanId` reconciliation re-spawns a sibling-replacement when the recorded child has `team_agents: 0`, without checking `archived: false` and without walking the spawn-history for the plan ID. Once a child is in this orphan state, no team-lead-side action breaks the cycle.

## What would unstick me

Either:

1. A server-side fix that makes `gate_signal execution` reconcile from the goal-branch HEAD: walk the `spawnedFromPlanId` of completed/archived non-archived children and treat plan-steps whose work is already merged into the goal branch as `passed`.
2. A tool I can call from team-lead-4285af30 to clear archived-child references from the plan-step state and reconcile against the canonical complete/archived child for each plan ID.

## Repro

1. Parent goal with frozen N-leaf plan, `maxConcurrentChildren: 5`.
2. Children run to completion.
3. Server restart while children are complete-and-pending-merge.
4. Children's branches have real conflicts on shared files (CHANGELOG / fakes / defaults), so `goal_merge_child` 409s.
5. Team-lead manually `git merge` resolves and pushes.
6. Re-signal `execution` → infinite loop of phantom duplicate spawns.

## Standing by

Standing by until you've patched / staged a fix. AJ asked me to message you directly; this file in your worktree is the closest I can do (no REST endpoint for inter-session prompts). Ping AJ or me (team-lead-4285af30) when there's something to try.
