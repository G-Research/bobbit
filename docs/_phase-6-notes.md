# Phase 6 — system prompts + actionable failure detail + tree cost: handoff notes

These bullets are inputs for Phase 8 (Documentation), which folds them into
`AGENTS.md`, `docs/internals.md`, `docs/debugging.md`, and `docs/rest-api.md`.
**Do not copy this file into AGENTS.md verbatim** — Phase 8 will reword to fit
the existing voice and dedupe with already-present entries.

Out-of-scope for Phase 6 by design (Phase 4 owns these): the `Children` tool
group definitions, `goal_spawn_child` / `goal_plan_propose` / etc. tool YAML +
extension, the matching REST handlers (`POST /api/goals/:id/spawn-child` and
friends), and `team-lead.yaml`'s `toolPolicies` block. Phase 6 only added the
*promptTemplate* paragraph to that file.

---

## Recipe entry — system-prompt nesting stanzas

> **Inject nested-goals awareness into a team-lead's system prompt** →
> `buildNestingContextSection({ team, goalBranch, parent?, root? })` in
> `src/server/agent/system-prompt.ts`. Caller (session-manager, when assembling
> a team-lead session prompt) populates a `NestingContext` and passes it via
> `parts.nestingContext`. The builder emits:
>
> - **Stanza A (top-level root):** `parent === undefined`. "You raise the PR; child goals must NOT." Mentions `maxConcurrentChildren` (default 3, max 8) and `divergencePolicy`.
> - **Stanza B (child team-lead):** `parent !== undefined`. "Your branch (X) merges INTO parent's branch (Y) LOCALLY. **DO NOT raise a PR.**" Substitutes `parent.title`, `parent.id`, `root.title`, `root.id`, parent branch, own branch.
> - **Stanza C (decision rule, always present for team goals):** table comparing `task_create` / `team_spawn` / `subgoal` lifetimes, branch ownership, and use-cases. Closes with "Subgoals are not free — don't decompose a 10-minute task into a subgoal."
>
> Non-team goals (assistant sessions) → `buildNestingContextSection` returns
> `undefined`; nothing is injected. The single-paragraph "Goal nesting awareness"
> pointer in `defaults/roles/team-lead.yaml::promptTemplate` (just below the
> role intro) acts as a redundant breadcrumb so the agent notices the
> constraint even without scanning the full system prompt.
>
> Files: `src/server/agent/system-prompt.ts` (builder + `PromptParts.nestingContext`
> wiring into both `_assembleSystemPrompt` and `getPromptSections`),
> `defaults/roles/team-lead.yaml` (promptTemplate pointer), tests
> `tests/system-prompt-nesting-stanzas.test.ts`.

## Debugging keyword index entries

- **Child team-lead raises a PR even though it shouldn't / `gh pr create` runs
  on a child goal** — Stanza B (rendered when `parent !== undefined`) must
  contain the literal `**DO NOT raise a PR.**` line. Confirm the session-manager
  populated `parts.nestingContext.parent` when assembling the prompt; if
  `parent` is undefined for a child goal, the builder falls through to Stanza A
  and the agent receives the *root* mandate ("raise the PR") which is the
  exact bug. Cross-check `goal.parentGoalId` is set on disk (Phase 1 lazy
  migration only fills `rootGoalId` for child goals; `parentGoalId` is the
  trigger for Stanza B). Recipe path: `src/server/agent/system-prompt.ts::buildNestingContextSection`.

- **Top-level team-lead never knows it can split work into subgoals** — Stanza
  C (the `subgoal` vs `team_spawn` vs `task_create` decision table) is always
  injected for team goals. If it's missing, the team-lead session was started
  with `nestingContext === undefined` (or `team: false`). Diagnostic:
  `GET /api/sessions/:id/prompt-sections` and look for a section labeled
  `Goal Nesting`.

- **Generic "Check verification output" notification, no failed-step name or
  output, no merge-gap diagnostic** — Lesson 4.18. The new
  `buildVerificationFailureMessage(gateId, steps, goalBranch?)` in
  `src/server/agent/notify-team-lead-failure.ts` is called by
  `verification-harness.ts::notifyTeamLead` whenever `status === "failed"` and
  step results are available. Four call sites pass `{steps, goalBranch}`: the
  cached-skip-all-steps short-circuit, the live `verifyGateSignal` end branch,
  the live catch-block, and the resume-error catch-block. The fifth
  notifyTeamLead call (resume-suppressed-by-restart) intentionally bypasses
  the builder — its message is the benign "interrupted by restart, please
  re-signal" string. The legacy single-line "Check verification output" message
  is preserved as a fallback when `steps === []` (e.g. a future call site that
  hasn't been updated). Tests: `tests/notify-team-lead-failure-detail.test.ts`.
  - **Merge-gap diagnostic missing on a known command-step failure** —
    predicate is `failed.some(s => s.type === "command")`; an llm-review-only
    failure correctly suppresses it. Confirm at least one failed step has
    `type: "command"` in the persisted `gate_status` payload.

- **Tree cost rollup shows only the root team-lead's cost, not the descendant
  children's accumulated cost** — Lesson 4.21. `GET /api/goals/:id/tree-cost`
  walks the descendant tree via the `rootGoalId` chain (BFS, depth capped at
  32) and sums each goal's accumulated cost. The handler resolves the rollup
  root as `goal.rootGoalId ?? goal.id` so a request against a CHILD goal still
  returns the WHOLE-TREE rollup. Cache lives on the `CostTracker` (per-tracker
  WeakMap, keyed by rootGoalId; entries invalidated when
  `costTracker.getGeneration()` ticks past the cached generation). Generation
  bumps on every `recordUsage`/`removeSession`, so cache invalidation is free.
  Files: `src/server/agent/cost-tracker.ts::computeTreeCost` (pure helper,
  takes `(rootGoalId, allGoals: TreeCostGoal[], costTracker, sessionIdsForGoal)`),
  `src/server/server.ts` REST handler. Test: `tests/tree-cost-rollup.test.ts`,
  `tests/api-goals-tree-cost.test.ts`.

## REST API additions (Phase 8 → docs/rest-api.md)

### `GET /api/goals/:id/tree-cost`

Returns the accumulated cost of the entire goal tree rooted at the requested
goal's `rootGoalId` (or the goal itself when it has none). Response shape:

```json
{
  "rootGoalId": "string",
  "totalCostUsd": 0.0,
  "totalTokensIn": 0,
  "totalTokensOut": 0,
  "breakdown": [
    {
      "goalId": "string",
      "depth": 0,
      "title": "string",
      "costUsd": 0.0,
      "tokensIn": 0,
      "tokensOut": 0
    }
  ]
}
```

- Status 200 with the structure above on success.
- Status 404 `{"error":"Goal not found"}` when the goal id is unknown across
  every project.
- Status 200 with zeroed totals + empty breakdown when the goal has no
  `projectId` (no costTracker available — e.g. a project-less assistant
  session that won't normally appear here).
- Breakdown is sorted by `depth ASC, createdAt ASC` — root first, deepest
  descendants last; deterministic across repeated calls.
- Cache hit ratio is generation-stamped on the costTracker; the response is
  recomputed only when a session-cost mutation has occurred since the last
  call for the same root.

### Behaviour notes

- Archived descendant goals are still counted — their cost survives archival.
- Cost figures are rounded to 6 decimal places (matches per-session precision).
- Goals belonging to different trees (different `rootGoalId` chain) are
  EXCLUDED from the rollup. The filter is
  `g.id === rootGoalId || g.rootGoalId === rootGoalId`.

## Suggested AGENTS.md additions for Phase 8

A new "Goal nesting" recipe entry under `## Recipes` with:
- the rendering rules for Stanza A / B / C
- the `parts.nestingContext` plumbing path
- the team-lead.yaml promptTemplate pointer
- the four notifyTeamLead call sites that now pass step detail
- the `GET /api/goals/:id/tree-cost` endpoint (cache rules, response shape)

A new "Tree cost / rollup" debugging-keyword-index entry summarising the
diagnostic flow when a parent-goal dashboard's tree-cost looks stale.

A note that `CostTracker.getGeneration()` is now a public method whose
contract is "tick monotonically on every cost mutation"; downstream callers
should not assume the value is meaningful for any other purpose.
