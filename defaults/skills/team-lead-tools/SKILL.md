---
name: team-lead-tools
description: Team-lead tool call reference (team/task/gate management parameters and worked examples) plus the reuse-vs-custom role/workflow decision guide
---

# Team-Lead Tool Reference

Part of the VER-03/F8 team-lead persona diet (`BOBBIT_LEAN_TEAM_LEAD=1`). This
is the full parameter/example reference for the team, task, and gate
management tools your resident prompt only summarizes, plus the detailed
reuse-vs-custom decision guide. Nothing here changes behavior versus the
full (non-lean) team-lead persona — it is the same content, just loaded on
demand instead of resident every turn.

## Team Management

- **team_spawn** — Spawn a role agent with its own git worktree. Returns `{ sessionId, worktreePath }`.
  - `role`: Any spawnable role name (see **Available Roles** in your resident prompt)
  - `task`: Task description sent as the agent's first prompt
  - `workflowGateId` (optional): Workflow gate ID this agent should produce output for (0 or 1). If `inputGateIds` is not set, the DAG dependencies of this gate are auto-injected as context.
  - `inputGateIds` (optional): Array of workflow gate IDs whose passed content to inject as context (0 or more). Overrides automatic DAG resolution — use when the agent needs gates beyond the formal dependencies.
  ```
  # Auto-resolve inputs from DAG dependencies:
  team_spawn(role="coder", task="Implement the fix", workflowGateId="implementation")
  # Explicit inputs (e.g. reviewer needs design-doc + implementation + test-results):
  team_spawn(role="reviewer", task="Review the fix", workflowGateId="code-review", inputGateIds=["design-doc", "implementation", "test-results"])
  ```

- **team_list** — List all agents with role, status, worktree, and task. No parameters.
- **team_dismiss** — Terminate an agent and clean up its worktree. Dismiss agents after their assigned task/milestone is complete and their branch has been merged or their findings have been consumed.
- **team_complete** — Dismiss all role agents and mark the goal complete. You (team lead) stay active.
- **team_steer** — Send a mid-turn redirect to a running agent (must be streaming).
- **team_prompt** — Send a prompt to an agent (queued if busy, immediate if idle). Accepts optional `workflowGateId` and `inputGateIds` to inject gate context into the prompt.
- **team_abort** — Force-abort a stuck agent that won't respond to steering.

## Task Management

- **task_list** — List all tasks with state, type, assignment, and dependencies.
- **task_create** — Create a task. Returns 409 if required upstream gates haven't passed.
  - `title`, `type`, `spec` (optional), `depends_on` (optional)
  - `workflowGateId` (optional): workflow gate this task should produce output for
  - `inputGateIds` (optional): workflow gate IDs to inject as context when prompting the agent
- **task_update** — Update fields, assign to a session, and/or transition state — all in one call.
  - `task_id` (required), plus any of: `title`, `spec`, `result_summary`, `head_sha`, `assigned_to`, `state`

## Gate Management

- **gate_list** — List all gates with status and definitions. No parameters.
- **gate_signal** — Signal a gate with content and/or metadata. Params: `gate_id` (required), `content` (optional markdown), `metadata` (optional key-value pairs). Re-signaling a passed gate cascade-resets downstream gates to pending.
- **gate_status** — Get latest signal details for a gate — verdict, failed-step names, compact failed-step output tail, and metadata. Param: `gate_id`.
- **gate_inspect** — Read bounded gate content, verification output, or signal history. Explicit verification inspection may use retained logs/artifacts for failed command steps while status stays compact. Params: `gate_id`, `section` ("content"/"verification"/"signals"), optional `signal_index`, `mode` ("grep"/"tail"/"head"/"slice"/"full"), `step` (verification step name from `failedSteps` — scopes `section="verification"` to one step), `pattern`, `context`, `max_results`, `lines`, `from`, `to`.

## Reuse existing roles and workflows — custom is the exception

**Default: reuse.** The roles and workflows the project already ships are the
right choice for the vast majority of work. Before inventing anything new,
read the **Available Roles** list in your resident prompt and the project's
stored workflows carefully — a role whose description sounds close to the work at hand
usually IS the right fit, even if the name isn't a perfect match. An existing
workflow that has one or two gates you don't need is still better than a
bespoke one, because unused gates are cheap (skip / mark optional) but custom
workflows/roles add ongoing maintenance cost and fragment the project.

**Only create a custom role or workflow when either:**
1. **The user explicitly asked for it.** ("Use a custom `synthesis-reviewer` for this audit" → do it.)
2. **No existing role/workflow can do the job after honest inspection** — not just imperfect, genuinely unsuited. A `coder` assigned to write a design doc is wrong (wrong prompt, wrong surface). A `code-reviewer` asked to write prose is wrong. A research/audit/exploration goal passed through a build→test→docs workflow is wrong — those gates will fail because there is nothing to build or test.

When a custom role/workflow IS justified:
- **One-off (this goal + its subgoals only)** → `inlineRoles` / `inlineWorkflow` on `propose_goal` or `goal_spawn_child`. Snapshotted onto the goal record; auto-cleaned on archive; does NOT pollute the project library.
- **Persistent (will matter across many goals)** → `propose_role` / `propose_project` (workflows under `workflows:`). Reserve for patterns the project genuinely needs long-term.

If you're about to invent a custom role or workflow, first justify why every
existing one failed. If you can't write a one-line reason, reuse instead.
