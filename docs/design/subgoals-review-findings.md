# Subgoals branch — code review findings

**Reviewer:** `code-reviewer-e6897153` on goal `audit-subg-225e4d3d`.
**Diff:** `git diff origin/master...HEAD` — 165 files, +21,500 / −335 LoC.
**Companion doc:** [`docs/design/subgoals-retro-audit.md`](subgoals-retro-audit.md) — the retro-audit's spec-deviation list (§4) and risk-area list (§5) is assumed read; this review focuses on **new code-quality findings** that are not already enumerated there.

---

## 1. Verdict

**Pass-with-fixes.**

The diff is structurally sound: the harness-as-scheduler invariant is preserved, every new store/manager carries the project-context `stateDir` constructor pattern, REST endpoints follow the existing `handleApiRoute()` convention, and the test coverage map is unusually thorough (>50 new test files). The findings below are mostly **Major or Minor** concerns — incomplete cascading of nested-goal fields between the harness path and the REST path, missing safety guards in destructive operations, repeated-but-divergent duplicates between server and client (Lesson-4.19 tier resolver), and a handful of REST-shape inconsistencies. One **Blocker** and three **Major** items must land before merge; the rest are clean fix-up commits.

---

## 2. Findings table

| ID | Severity | Area | File:line | Summary |
|---|---|---|---|---|
| R-001 | Blocker | harness | `src/server/agent/verification-harness.ts:3128` | Children spawned via `runSubgoalStep` never get their gates initialised — `gateStore.initGatesForGoal()` is missing, mirroring an established invariant the REST path enforces at `server.ts:3561`. |
| R-002 | Major | harness | `src/server/agent/verification-harness.ts:3091` | Harness-spawned children are not stamped with `spawnedBySessionId`, so subgoals created through a `subgoal` verify-step disappear from the sidebar's "nest under team-lead" rendering even when the parent has a team-lead. |
| R-003 | Major | harness | `src/server/agent/verification-harness.ts:3047-3081` | Workflow-resolution fallback chain in `runSubgoalStep` does not honour `body.workflow` precedence used by `POST /spawn-child` — the two callers of "spawn a child" diverge on what shape the child workflow ends up with. |
| R-004 | Major | REST | `src/server/server.ts:3719-3768` | `GET /api/goals/:id/plan` re-implements the tier resolver inline (4 tiers, no Tier 1.5 / Tier 5) instead of calling `verificationHarness.resolvePlanStepChild()` — the renderer-server-harness three-way agreement required by Lesson 4.22 is fragile. |
| R-005 | Major | REST | `src/server/server.ts:3791-3793` | `POST /integrate-child/:childId` does not check `child.state` or whether `ready-to-merge` actually passed before merging — agents can manually merge a still-running or failed child via `goal_merge_child`. |
| R-006 | Major | REST | `src/server/server.ts:3814-3837` | `POST /pause` cancels in-flight verifications but does not abort or steer in-flight team-lead / worker sessions (or at least mark them paused) — "paused" semantics for live agents are silently no-op. |
| R-007 | Major | data-model | `src/server/agent/goal-store.ts:202-228` | `update()` sets `updatedAt: Date.now()` even when no fields are actually changing (e.g. `update(id, {})` after the cleaned-undefined sweep), causing unnecessary `goal_state_changed` cascades and search-index bumps. |
| R-008 | Major | UI | `src/app/api.ts:1135-1175` | `teardownTeamWithDialog` uses an unconditional `POST teardown` (not `?cascade=false`) as the pre-flight, so a server-side change of pre-flight semantics will silently tear down descendants — the contract should be explicit. |
| R-009 | Major | tests | `tests/runSubgoalStep-tier-resolution.test.ts` | Tests assert on the *source-tier-name* string (e.g. `"live-active"`) but never test that the harness then short-circuits or spawns correctly when the tier is `"rescue"` — the rescue-path branch in `runSubgoalStep` is uncovered. |
| R-010 | Minor | data-model | `src/server/agent/goal-store.ts:120` | `inlineRoles` lazy-migration on `load()` does not exist — `parentGoalId` / `rootGoalId` / `inlineRoles` etc. all rely on being optional, but a malformed legacy record where `inlineRoles` is not an object would trip unit-test fixtures silently. |
| R-011 | Minor | harness | `src/server/agent/verification-harness.ts:3133` | `_waitForChildReadyToMerge` polls every 500ms in a busy loop — no exponential backoff, no maximum-wait timeout; a stuck child blocks a semaphore slot indefinitely. |
| R-012 | Minor | harness | `src/server/agent/verification-harness.ts:2874-2887` | Tier 1.5 cached-pointer wipe + `_persistActive()` is called four times in `resolvePlanStepChild` with copy-pasted bodies — extract a helper. |
| R-013 | Minor | classifier | `src/server/agent/plan-mutation.ts:226-243` | Criteria-coverage haystack joins on `\n` and uses `includes()`, so a criterion that wraps a line boundary in normalised text matches; intentional, but should be tested. |
| R-014 | Minor | classifier | `src/server/agent/plan-mutation.ts:188-208` | Phase-decrease detection iterates `phaseChanges` after the membership filter — an item that's `removed` is already excluded, but reading is non-obvious; comment the precondition. |
| R-015 | Minor | REST | `src/server/server.ts:3596-3717` | `PATCH /api/goals/:id/plan` reads `body.proposedSteps` without type-validating each element shape — `classifyMutation` happens to tolerate missing fields, but a malformed step (e.g. missing `planId`) can silently classify as `restructure`. |
| R-016 | Minor | REST | `src/server/server.ts:3597` | `PATCH /api/goals/:id/plan` is path-shaped identically to `GET /api/goals/:id/plan` but the implementations have no shared helper — two side-by-side regex matches against the same path. |
| R-017 | Minor | REST | `src/server/server.ts:3942` | `PATCH /api/goals/:id/policy` does not broadcast the new policy values in the event payload — clients relying on `goal_state_changed` must re-fetch the goal record. |
| R-018 | Minor | REST | `src/server/server.ts:3866` | The mutation-decision endpoint accepts `decision: "approve"|"reject"` but does not document or enforce that `requestId` belongs to `goalId` — an `approve` against `requestId` from another goal returns 404 only because `planMutationStore.get(goalId, requestId)` filters by goalId. Defensive but undocumented. |
| R-019 | Minor | extension | `defaults/tools/children/extension.ts:34-49` | Gateway URL/token resolution duplicates `defaults/tools/team/extension.ts:25-44` byte-for-byte — extract a `readGatewayCreds()` helper into `defaults/tools/_lib/`. |
| R-020 | Minor | extension | `defaults/tools/children/extension.ts:53-77` | The shared `api()` helper re-implements `team/extension.ts:48-65` with identical error-handling semantics + one extra header — a small refactor would keep them in sync (e.g. when retry/backoff is added). |
| R-021 | Minor | extension | `defaults/tools/children/extension.ts:101-108` | Inline-role schema in the `goal_spawn_child` tool YAML accepts `toolPolicies` as `Record<string, string>` (not `'allow' \| 'ask' \| 'never'`) — typo'd policy values are forwarded to disk and only fail later at gate-spawn time. |
| R-022 | Minor | extension | `defaults/tools/children/extension.ts:152` | `goal_plan_propose` auto-fallback path silently swallows the freeze-classifier — a parent that *intentionally* gave its goal a non-parent workflow has no way to opt out of the fallback and will get cycle-cascade-spawn behaviour without warning. |
| R-023 | Minor | classifier | `src/server/agent/plan-mutation.ts:80-85` | `normalise()` lowercases via `toLowerCase()` (no locale) — a Turkish-locale `İ` criterion will not match its dotless equivalent in a step spec. Document the assumption or use `toLocaleLowerCase("en")`. |
| R-024 | Minor | UI | `src/app/dialogs.ts:1900-1925` | `showStopTeamDialog`'s "this-only" return path on `descendantTeamCount === 0` is reachable only via the wrapper `teardownTeamWithDialog` short-circuit. Direct callers will mistake `this-only` for "user picked this-only" rather than "no descendants existed". Rename to `no-descendants` or split. |
| R-025 | Minor | UI | `src/app/sidebar-nesting.ts:91-120` | `indexGoals()` recomputes the visible-set filter twice (line 89 and again in `buildNestedGoalForest()` line 198) — minor allocation churn on every sidebar render. |
| R-026 | Minor | UI | `src/app/plan-edge-paths.ts:91` | `midLineY`-style legacy branch is preserved with an `@deprecated` comment but its call sites in tests aren't dated for removal — flag or schedule. |
| R-027 | Minor | UI | `src/app/dialogs.ts:1721` | `showArchiveGoalDialog` does a destructive `DELETE` as its pre-flight — when the server returns 200 (no descendants), the goal is already archived, so the UI's `confirmAction` for the no-descendant case is bypassed entirely. This is contrary to the established `confirmAction` UX for unarchived goals. |
| R-028 | Minor | tests | `tests/runSubgoalStep-merge-then-archive.test.ts` | The merge-then-archive test asserts ordering via a `calls[]` log but doesn't pin that `state: "complete"` was set BEFORE `archive` — the load-bearing order in `archiveGoalAfterMerge` is uncovered. |
| R-029 | Minor | tests | `tests/api-goals-pause-resume.test.ts` | E2E coverage exercises pause/resume but no test asserts that `cancelAllVerifications` actually fires when pausing a verifying goal — observable only via stub. |
| R-030 | Minor | docs | `AGENTS.md` recipes section | No recipe entry for the `parent` meta-workflow / `goal-plan` freeze flow — agents discovering the diff have to read `nested-goals.md` end-to-end to find the freeze contract. |
| R-031 | Minor | docs | `docs/debugging.md` | Lesson 4.5 (bare `spawn("node")`) has no debugging entry despite being one of the two unfixed items the retro-audit calls out — adding the entry makes the regression observable. |
| R-032 | Minor | data-model | `src/server/agent/goal-manager.ts:280` | `JSON.parse(JSON.stringify(...))` deep-clone used for workflow snapshot is a known performance footgun on large workflow trees; consider `structuredClone()` (Node 17+) for hot paths. |
| R-033 | Minor | data-model | `src/server/agent/goal-manager.ts:249` | Same `JSON.parse(JSON.stringify(...))` pattern for `inlineRoles` snapshot — see R-032. |
| R-034 | Minor | harness | `src/server/agent/verification-harness.ts:3172` | `_waitForChildReadyToMerge` declares `_parentGoalId` but never uses it. Either use it (validation: child's `parentGoalId === parentGoalId`) or drop the parameter. |
| R-035 | Minor | data-model | `src/server/agent/plan-mutation-store.ts:40-42` | `pruneExpired` is implemented and tested but never wired into a periodic sweep — pending mutations grow without bound. The 24h TTL is honoured at read-time only. |
| R-036 | Minor | system-prompt | `src/server/agent/system-prompt.ts:215` | Stanza A's "raise the PR" mandate uses `gh pr create` but doesn't mention the `gh` not-installed fallback that team-lead.yaml describes (line 286). Inconsistent guidance between the system-prompt-injected stanza and the role's promptTemplate. |
| R-037 | Minor | system-prompt | `src/server/agent/system-prompt.ts:241` | Stanza C's "decision-rule table" lists `subgoal` but doesn't mention the freeze classifier — a team-lead could call `goal_plan_propose` repeatedly and trigger auto-pause at >5 without seeing why in the prompt. |
| R-038 | Nit | classifier | `src/server/agent/plan-mutation.ts:53-58` | `ClassifierPlanStep` carries duplicated `subgoal: { planId, title, spec }` *and* top-level `planId`/`title`/`spec` — `effectiveTitle()`/`effectiveSpec()` resolve which to use, but the type allows both to be set with conflicting values. Tighten or document the precedence. |
| R-039 | Nit | REST | `src/server/server.ts:3826` | Pause loop uses `g.paused === true` to skip already-paused; symmetric resume uses `g.paused !== true` (line 3854) — both are correct but read inconsistently. Use the same shape. |
| R-040 | Nit | UI | `src/app/dialogs.ts:1857-1929` | `showStopTeamDialog`'s "this-only" return is on the SAME conditional branch as the cancel return (both via `cleanup`) but they propagate different result strings. Combining them via early-return at the top would be clearer. |
| R-041 | Nit | UI | `src/app/api.ts:1149-1157` | Dialog goal-title resolution falls through `state.goals → window.__goalCache → goalId` — three sources, last is the raw UUID. The `__goalCache` reference is described in the comment as historical; remove it. |
| R-042 | Nit | UI | `src/app/sidebar-nesting.ts:82-87` | The dedup-via-`enqueued`-set is a defensive guard with no observable trigger in production; reduce to an `assert` or remove if no test reproduces the regression it's defending against. |
| R-043 | Nit | extension | `defaults/tools/children/extension.ts:21-24` | Early return when `BOBBIT_GOAL_ID` / `BOBBIT_SESSION_ID` is missing logs nothing — silent disable. Mirror the team-lead extension's `console.error` for diagnosability. |
| R-044 | Nit | tests | `tests/role-children-tools-policy.test.ts` | Tests that every contributor declares `goal_*: never` but never asserts that team-lead.yaml declares `always-allow` for the same nine — drift in one direction is detected, drift in the other is not. |
| R-045 | Nit | docs | `docs/nested-goals.md` | The `spawnedBySessionId` field is documented as "spawning team-lead session id" but the backfill helper (`backfillSpawnedBySessionId`) treats it as "team-lead session id of the parent goal" — slightly different semantics under multi-team-lead history. |

---

## 3. Per-finding detail

### R-001 — Children spawned via subgoal verify-step have no gate state

**File:** `src/server/agent/verification-harness.ts:3082-3128` (`runSubgoalStep`, after `createGoal`)

**Problematic code:**

```ts
const child = await goalManager.createGoal(sg.title, parent.cwd, {
    spec: sg.spec,
    workflowId: childWorkflowId,
    resolvedWorkflow: resolvedChildWorkflow,
    projectId: parent.projectId,
    sandboxed: parent.sandboxed,
    parentGoalId,
    inlineRoles: inheritedInlineRoles,
});
await goalManager.updateGoal(child.id, { spawnedFromPlanId: planId });
// END Lesson 4.1 critical sequence.

childGoalId = child.id;
// ... no initGatesForGoal() call …
```

The REST `POST /api/goals/:id/spawn-child` path explicitly initialises gates for the new child after `createGoal` (`server.ts:3561`):

```ts
if (child.workflow) {
    ctx.gateStore.initGatesForGoal(child.id, child.workflow.gates.map(g => g.id));
}
```

**Standard violated:** AGENTS.md "Bind an ephemeral role or workflow to one goal" recipe explicitly calls this out: *"Critical companion: `spawn-child` also calls `gateStore.initGatesForGoal(child.id, child.workflow.gates.map(g => g.id))` after `createGoal` — without this, `gate_list` / `gate_signal` / `gate_status` / `gate_inspect` / the verification harness all see `[]` for the child even though `goal.workflow.gates` is populated."*

The two parallel spawn paths (`POST /spawn-child` and `runSubgoalStep`) MUST be in lockstep — the contributor-guide explicitly names them.

**Recommended fix:** Right after `await goalManager.updateGoal(child.id, { spawnedFromPlanId: planId })`, add:

```ts
if (child.workflow) {
    ctx.gateStore.initGatesForGoal(child.id, child.workflow.gates.map(g => g.id));
}
```

Add a unit test under `tests/runSubgoalStep-spawn-stamps-planId.test.ts` (or a sibling) that asserts `gateStore.getGatesForGoal(childId).length > 0` after the harness spawns a child.

**Block merge?** **Yes.** This is the same load-bearing invariant the recipe was added to enforce; subgoal-verify-step children will deadlock at `_waitForChildReadyToMerge` because the child's `ready-to-merge` gate has no row to poll.

---

### R-002 — Harness-spawned children miss `spawnedBySessionId`

**File:** `src/server/agent/verification-harness.ts:3082-3098`

**Problematic code:** The `createGoal` + `updateGoal` block in `runSubgoalStep` stamps `spawnedFromPlanId` but **does not** stamp `spawnedBySessionId`. Compare with `server.ts:3548-3553`:

```ts
await goalManager.updateGoal(child.id, {
    spawnedFromPlanId: planId,
    ...(suggestedRole ? { suggestedRole } : {}),
    ...(spawnedBySessionId ? { spawnedBySessionId } : {}),
});
```

**Standard violated:** AGENTS.md recipe "Render nested goal trees / plan DAG" — the sidebar attribution rule reads *"Sub-goals stamped with `spawnedBySessionId` render INSIDE the spawning team-lead session."* The harness IS the spawning agent for verify-step children; without the stamp, those children fall through to the parent-forest level, breaking the user's mental model.

**Recommended fix:** Resolve the parent's team-lead session id at the start of `runSubgoalStep` (via `teamManager.getTeamState(parentGoalId)?.teamLeadSessionId`) and include it in the `updateGoal` call. Cover with a test under `tests/runSubgoalStep-spawn-stamps-planId.test.ts` asserting `spawnedBySessionId === parent.teamLeadSessionId`.

**Block merge?** No — UX cosmetic; ship and follow up.

---

### R-003 — Harness vs REST spawn workflow-resolution divergence

**File:** `src/server/agent/verification-harness.ts:3047-3081`, `src/server/server.ts:3508-3517`

**Problematic code:** `runSubgoalStep`'s 4-tier cascade is `sg.workflowId → parent.workflow → "feature" → first-non-hidden`. `POST /spawn-child`'s cascade is `body.workflow → parent.workflow → body.workflowId → "feature" via createGoal`. These are not the same shape — most importantly, the harness has **no `body.workflow`** equivalent (subgoal verify-steps don't carry a full workflow object), but it ALSO doesn't honour the inline workflow that may already be in `step.subgoal.workflowId`'s referenced store entry.

**Standard violated:** Bobbit convention — when the same logical operation is exposed through two surfaces (REST and harness here), they MUST share a helper. The retro-audit §4.6 (Tier 2 inheritance) concedes the harness picks up parent.workflow stripping; combined with that, the divergence here makes "spawn child via subgoal step" subtly different from "spawn child via tool". A child spawned via `goal_plan_propose` after `applyPlanSteps` writes the plan to `execution.verify[]` will get a different child workflow than a child spawned via `goal_spawn_child` for the same `planId`.

**Recommended fix:** Extract a pure helper `resolveChildWorkflow(parent, sg, body, workflowStore)` into `src/server/agent/spawn-child-workflow.ts` and call it from both sites. Cover with `tests/spawn-child-workflow-resolution.test.ts` asserting parity across `(workflowId-only, body.workflow, parent.workflow, fallback)` cases.

**Block merge?** No, but high-value follow-up — the diff already invests heavily in tier-resolver parity for the child resolver (`plan-node-state.ts` mirrors `resolvePlanStepChild`). The workflow resolver deserves the same treatment.

---

### R-004 — `GET /api/goals/:id/plan` reimplements tier resolver inline

**File:** `src/server/server.ts:3719-3768`

**Problematic code:**

```ts
const matches = allGoals.filter(g => g.parentGoalId === id && g.spawnedFromPlanId === sg.planId);
const sortByCreatedDesc = (arr: PersistedGoal[]) => arr.slice().sort((a, b) => b.createdAt - a.createdAt);
const tier1 = sortByCreatedDesc(matches.filter(g => !g.archived && g.state === "in-progress"))[0];
const tier2 = !tier1 ? sortByCreatedDesc(matches.filter(g => g.archived === true && g.state === "complete"))[0] : undefined;
const tier3 = !tier1 && !tier2 ? sortByCreatedDesc(matches.filter(g => !g.archived && g.state !== "in-progress"))[0] : undefined;
const tier4 = !tier1 && !tier2 && !tier3 ? sortByCreatedDesc(matches.filter(g => g.archived === true && g.state !== "complete"))[0] : undefined;
const child = tier1 ?? tier2 ?? tier3 ?? tier4;
```

This is a **third** copy of the tier resolver, alongside `verification-harness.ts::resolvePlanStepChild` (server-canonical, has Tier 1.5 + Tier 5) and `plan-node-state.ts::resolvePlanNodeChild` (client). The retro-audit §5.6 already flags client-server agreement as a risk; this finding adds a third site that's **already** drifted: it has only 4 tiers and excludes Tier 1.5 + Tier 5 entirely.

**Standard violated:** AGENTS.md "Render nested goal trees / plan DAG" — *"`resolvePlanNodeChild` … MUST agree with server's `resolvePlanStepChild`."* The plan-status route is read by the same `goal_plan_status` tool a team-lead consults to decide next steps — silent disagreement here means an agent can see "tier-1.5 cached pointer matches" via a verify-step run while `goal_plan_status` reports "no child" and trigger a duplicate spawn.

**Recommended fix:** Refactor `verificationHarness.resolvePlanStepChild()` to accept `goals: PersistedGoal[]` as input rather than reading from `ctx.goalStore.getAll()` (or expose a thin pure-function wrapper). Have `GET /plan` call into it. Add `tests/api-goals-plan-tier-parity.test.ts` asserting the route returns the same `childGoalId` the harness would resolve for every fixture in `runSubgoalStep-tier-resolution.test.ts`.

**Block merge?** No — but high-value, and small.

---

### R-005 — `goal_merge_child` accepts pre-RTM merges

**File:** `src/server/server.ts:3770-3812` (`POST /integrate-child/:childId`)

**Problematic code:**

```ts
if (child.parentGoalId !== parentId) {
    json({ error: `Child ${childId} parentGoalId=…`, code: "PARENT_MISMATCH" }, 400);
    return;
}
const ctx = projectContextManager.getContextForGoal(parentId);
…
const outcome = await goalManager.mergeChild(parentId, childId);
```

There is no check that `gateStore.getGate(childId, "ready-to-merge")?.status === "passed"`. A team-lead calling `goal_merge_child` mid-flight — or an agent with a stale tier-3 child resolution — can merge a non-RTM child into the parent and leave the harness's `_waitForChildReadyToMerge` polling against an already-merged + still-live child.

**Standard violated:** SUBGOALS-SPEC §3.2 / Lesson invariant — only RTM-passed children should merge. The harness path enforces this (`_waitForChildReadyToMerge` blocks until passed); the manual path bypasses it.

**Recommended fix:** Before invoking `mergeChild`, look up `gateStore.getGate(childId, "ready-to-merge")` and reject with `409 RTM_NOT_PASSED` unless `status === "passed"`. Allow override via `body.force: true` for recovery cases (document it in the tool YAML).

**Block merge?** No — but ship soon; the cost of a bad manual merge is high (a half-merged sibling-conflict state).

---

### R-006 — `POST /pause` doesn't stop live agents

**File:** `src/server/server.ts:3814-3837`

**Problematic code:**

```ts
for (const g of targets) {
    if (g.paused === true) continue;
    await goalManager.updateGoal(g.id, { paused: true });
    await cancelAllVerifications(g.id);
    broadcastToAll({ type: "goal_state_changed", goalId: g.id });
    count++;
}
```

`cancelAllVerifications` cancels in-flight gate verifications, but the team-lead session and worker sessions continue running normally. A paused goal whose team-lead is mid-turn keeps spending tokens; a paused worker keeps writing to its branch. The user expects "paused" to mean "no further spend", but the implementation only pauses the verification harness's view.

**Standard violated:** "Drive a nested-goal lifecycle from the team-lead" recipe describes pause as a tree-level operation; the implicit contract is that paused goals *halt*. The retro-audit §4.13 documents the in-flight-child suppression rule (`anyInFlightChild` excludes paused), but that's the *parent's* nudge logic — the paused child itself is not actually halted.

**Recommended fix:** On pause, additionally:
1. Call `sessionManager.abortStreamingSession(teamLeadSessionId)` if the team-lead is streaming.
2. Park the prompt queue for paused team-lead sessions (or set a `paused` flag in `PromptQueue` consulted at `_dispatchSteer`).
3. Document the new behaviour in AGENTS.md "Drive a nested-goal lifecycle" recipe.

If full halt is not feasible in one commit, at minimum surface the partial-pause limitation to the user via the dialog text in `showPauseGoalDialog` ("Pausing stops new gate verifications but does not interrupt streaming agents").

**Block merge?** No — but the user-visible expectation gap is real; document or implement.

---

### R-007 — `goal-store.update()` writes `updatedAt` on no-op updates

**File:** `src/server/agent/goal-store.ts:212-228`

**Problematic code:**

```ts
update(id: string, updates: Partial<…>): boolean {
    const existing = this.goals.get(id);
    if (!existing) return false;
    this.generation++;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) cleaned[k] = v;
    }
    Object.assign(existing, cleaned, { updatedAt: Date.now() });
    this.save();
    this.onIndexUpdate?.(existing);
    return true;
}
```

A caller passing `{}` (or `{ paused: undefined }` on a goal whose `paused` is already `undefined`) will still bump `updatedAt`, `generation`, persist, and fire `onIndexUpdate`. The `applyPlanSteps` path in `server.ts` does `goalManager.getGoalStore().update(goal.id, { workflow })` — a no-op write of an unchanged workflow still cascades.

**Standard violated:** Bobbit store discipline — generation bumps must reflect real mutations.

**Recommended fix:** After computing `cleaned`, early-return when no key in `cleaned` differs from `existing`'s value. Skip the write/save/onIndexUpdate.

```ts
const changed = Object.keys(cleaned).some(k => (existing as any)[k] !== cleaned[k]);
if (!changed) return false; // or true with no side effects, depending on contract
```

**Block merge?** No — it's a perf / WS-event-noise issue, not a correctness one. But fix soon: every cascade-archive on a tree of N goals fires N redundant `goal_state_changed` events.

---

### R-008 — `teardownTeamWithDialog` pre-flight ambiguity

**File:** `src/app/api.ts:1135-1175`

**Problematic code:**

```ts
const probe = await gatewayFetch(`/api/goals/${goalId}/team/teardown`, { method: "POST" });
if (probe.ok) {
    await refreshSessions();
    return true;
}
if (probe.status === 409) { … }
```

The probe lacks an explicit `?cascade=false`. The server's `team/teardown` route (server.ts:6236) reads the cascade param from the URL: `const cascade = url.searchParams.get("cascade") === "true";` — i.e. missing param defaults to `false`, which is what we want. **But** the documentation states *"Every cascade-affecting REST call requires explicit `cascade: boolean`"* (AGENTS.md "Drive a nested-goal lifecycle"). The implicit default here violates that contract; if the server later flips its default to safer-by-default cascading, this client will silently change behaviour.

**Standard violated:** AGENTS.md "Drive a nested-goal lifecycle from the team-lead" recipe — *"Every cascade-affecting REST call (`pause`, `resume`, `archive`) requires explicit `cascade: boolean`."* `team/teardown` is in the same family.

**Recommended fix:** Change the probe URL to `/api/goals/${goalId}/team/teardown?cascade=false`. Add a server-side test that 422 is returned when `cascade` is omitted (currently the route silently treats omitted as `false`).

**Block merge?** No — but tightening matches the documented contract.

---

### R-009 — Tier-resolver tests don't cover the rescue branch's spawn behaviour

**File:** `tests/runSubgoalStep-tier-resolution.test.ts`

**Problematic code:** Tests assert `r.source === "rescue"` and `child.id === "..."` but stop short of running `runSubgoalStep` end-to-end on a Tier-5 hit and asserting the back-fill `spawnedFromPlanId` was actually persisted to disk (the comment says it's done lazily, but no test verifies the write completes). A regression where the lazy `updateGoal(...).catch(() => {})` swallows a real error would not be caught.

**Standard violated:** AGENTS.md "Add a subgoal verify-step" recipe — *"The very next call after `createGoal` MUST be `updateGoal({ spawnedFromPlanId })` (Lesson 4.1)."* The corresponding rescue-path back-fill is the same invariant, untested.

**Recommended fix:** Add a test case to `runSubgoalStep-tier-resolution.test.ts`:

```ts
it("Tier 5 rescue: back-fills spawnedFromPlanId on resolved child", async () => {
    // … spawn an orphan with matching title and undefined spawnedFromPlanId …
    const r = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);
    // Wait for the lazy back-fill (microtask).
    await new Promise(resolve => setImmediate(resolve));
    const updated = fx.goalStore.get("orphan-id");
    assert.equal(updated?.spawnedFromPlanId, planId);
});
```

**Block merge?** No.

---

### R-010 — `inlineRoles` lazy-migration missing on load

**File:** `src/server/agent/goal-store.ts:140-160` (the `load()` migration block)

**Problematic code:** The load-time migration handles `swarm → team`, `skipArtifactRequirements → skipGateRequirements`, `setupStatus` default, and `workflow` snake_case normalization. It does **not** validate `inlineRoles` is an object — a malformed legacy record (e.g. an array, or a stringified JSON) would pass through and crash later at `resolveRole()`'s `goal.inlineRoles?.[name]` only if the JS engine throws on the index. Per AGENTS.md *"the lazy-migration in `load()` handles missing fields automatically"*, defensive shape-validation is the established pattern.

**Recommended fix:** Add:

```ts
if (g.inlineRoles && (typeof g.inlineRoles !== "object" || Array.isArray(g.inlineRoles))) {
    console.warn(`[goal-store] Dropping malformed inlineRoles on goal ${g.id}`);
    delete g.inlineRoles;
}
```

**Block merge?** No.

---

### R-011 — `_waitForChildReadyToMerge` busy-polls without backoff or timeout

**File:** `src/server/agent/verification-harness.ts:3172-3204`

**Problematic code:**

```ts
while (true) {
    if (active.cancelled) return "cancelled";
    const child = ctx.goalStore.get(childGoalId);
    if (!child) return "archived-other";
    if (child.archived === true) {
        return child.state === "complete" ? "archived-complete" : "archived-other";
    }
    const rtm = ctx.gateStore.getGate(childGoalId, "ready-to-merge");
    if (rtm?.status === "passed") return "passed";
    await new Promise(r => setTimeout(r, POLL_MS));
}
```

500ms polling with no maximum runtime, no exponential backoff. A child stuck on a failed gate (or paused indefinitely) holds a `rootSubgoalSemaphore` slot forever. With `maxConcurrentChildren=3` and three stuck children, the parent can't make any forward progress until manual intervention.

**Standard violated:** AGENTS.md "Notification System — DO NOT POLL OR SLEEP" applies to agents but the spirit (event-driven) applies here: the poll could be replaced with a `gateStore` subscription / `goal_state_changed` event. At minimum, add a timeout.

**Recommended fix:**
1. Add a `MAX_WAIT_MS` (e.g. 24h) and return `"archived-other"` (or a new `"timeout"`) when exceeded.
2. Subscribe to gate-status WS events instead of polling — `gateStore.onChange` exists.

**Block merge?** No — but the slot-pinning failure mode is observable.

---

### R-012 — Tier 1.5 cached-pointer wipe duplication

**File:** `src/server/agent/verification-harness.ts:2870-2887`

**Problematic code:** Four near-identical blocks:

```ts
if (opts?.active && opts?.stepIndex !== undefined && opts.active.steps[opts.stepIndex]) {
    const st = opts.active.steps[opts.stepIndex];
    if (st.subgoal) st.subgoal.childGoalId = undefined;
    this._persistActive();
}
```

These wipe the cached pointer on three different conditions (cached-archived-non-complete, cached-vanished, harness-side tier-4 fallthrough at 3009). All four uses end with `this._persistActive()`.

**Recommended fix:** Extract a private helper:

```ts
private _wipeSubgoalCachedPointer(active: ActiveVerification | undefined, stepIndex: number | undefined): void {
    if (!active || stepIndex === undefined) return;
    const st = active.steps[stepIndex];
    if (st?.subgoal) {
        st.subgoal.childGoalId = undefined;
        this._persistActive();
    }
}
```

**Block merge?** No.

---

### R-013 — Criteria-coverage haystack joins on `\n`

**File:** `src/server/agent/plan-mutation.ts:226-243`

**Problematic code:**

```ts
const haystack = [
    normalise(rootSpec ?? ""),
    ...proposed.map(s => normalise(effectiveSpec(s) ?? "")),
].join("\n");
for (const crit of rootAcceptanceCriteria) {
    const needle = normalise(crit);
    if (needle.length === 0) continue;
    if (!haystack.includes(needle)) {
        uncovered.push(crit);
    }
}
```

`normalise(...)` collapses whitespace to single spaces (`s.replace(/\s+/g, " ")`), so the joined `\n` between segments becomes a single space in the final compare ONLY if the segments themselves end without trailing whitespace. The per-segment normalisation followed by `\n` join then a single `includes` is structurally fine — but a criterion that ends one step's spec and starts another's would match by accident. In practice harmless, but worth a test.

**Recommended fix:** Add a unit test asserting that a criterion split across two adjacent step specs does NOT pass coverage. If it does, change the haystack to a `for...of` loop testing each segment separately.

**Block merge?** No.

---

### R-014 — Phase-decrease detection precondition undocumented

**File:** `src/server/agent/plan-mutation.ts:188-208`

The phase-decrease loop iterates `phaseChanges` after the structural diff. `phaseChanges` only contains `planId`s that exist in BOTH `current` and `proposed` (because the loop populating it only inserts when both `c` and `s` are present at the same `planId`). The downstream loop reads `c = currentByPlanId.get(id)` and `p = proposedByPlanId.get(id)` — both are guaranteed non-null by construction. The `if (!c || !p) continue;` guard is dead code.

**Recommended fix:** Replace the `if (!c || !p) continue;` with a comment documenting the invariant, or remove and add a `// @ts-expect-error none` if the type system complains. Either is fine; both are clearer than the current shape which suggests the guard is meaningful.

**Block merge?** No — nit.

---

### R-015 — `PATCH /plan` doesn't validate `proposedSteps` shape

**File:** `src/server/server.ts:3618-3623`

**Problematic code:**

```ts
const body = await readBody(req).catch(() => null);
if (!body || !Array.isArray(body.proposedSteps)) {
    json({ error: "proposedSteps[] is required" }, 400);
    return;
}
const proposedSteps = body.proposedSteps as ClassifierPlanStep[];
```

A request with `proposedSteps: [{ phase: 1 }]` (no `planId`) passes the shape check. `classifyMutation` will treat it as a step with `planId: undefined`, and the diff math then computes `current.spawnedFromPlanId !== undefined` everywhere → "all current removed, all proposed added" → restructure verdict. The user gets a confusing 409 RESTRUCTURE_REQUIRES_PAUSE error instead of a 400 "missing planId".

**Recommended fix:** Validate each step has `planId: string` and `title: string` (and either `spec` or `subgoal.spec`); 400 on any malformed item with a precise error.

**Block merge?** No.

---

### R-016 — GET and PATCH `/plan` don't share a route helper

**File:** `src/server/server.ts:3597, 3720`

Two consecutive regex matches against the same `/^\/api\/goals\/([^/]+)\/plan$/` URL. Aside from the cosmetic duplication, they don't share goal-lookup or context-resolution code, so a future change to one (e.g. adding `?gateId=...` filter to PATCH) won't propagate.

**Recommended fix:** Extract a shared `resolvePlanContext(id)` helper that returns `{goal, ctx, gateId}` or null+sets json 404.

**Block merge?** No — minor.

---

### R-017 — `PATCH /policy` missing event payload

**File:** `src/server/server.ts:3942-3955`

**Problematic code:** After updating divergencePolicy / maxConcurrentChildren, the route broadcasts `{ type: "goal_state_changed", goalId: id }` with no payload. Clients consuming `goal_state_changed` (sidebar, dashboard) must re-fetch the goal record to discover the new policy values.

**Recommended fix:** Either include the new policy values in the broadcast event, or add a dedicated `policy_changed` event. Pick one and document in `protocol.ts`.

**Block merge?** No.

---

### R-018 — Mutation-decision endpoint cross-goal access undocumented

**File:** `src/server/server.ts:3866-3872`

`POST /api/goals/:goalId/mutation/:requestId/decision` does `planMutationStore.get(goalId, requestId)`. The store is keyed by `(goalId, requestId)`, so a stranger's `requestId` simply 404s. This works but isn't obvious from the route signature; add a comment.

**Recommended fix:** Add `// requestId is implicitly scoped to goalId — store key is (goalId, requestId)` above the `get`.

**Block merge?** No.

---

### R-019 — Gateway creds resolution duplicated

**File:** `defaults/tools/children/extension.ts:25-49`, `defaults/tools/team/extension.ts:25-49`, plus other extension files

Both files share the same 25-line block reading `BOBBIT_TOKEN` / `BOBBIT_GATEWAY_URL` env vars first, then falling back to disk reads of `<stateDir>/{token,gateway-token}` and `<stateDir>/{gateway-url}`. A server-side change to credential resolution (e.g. adding a new env var) would require touching every extension.

**Recommended fix:** Create `defaults/tools/_lib/gateway.ts` exporting `readGatewayCreds(): { token: string; baseUrl: string }` (with the error-return branch) and have all extensions import it.

**Block merge?** No.

---

### R-020 — `api()` HTTP helper duplicated

**File:** `defaults/tools/children/extension.ts:53-77`, `defaults/tools/team/extension.ts:48-65`

Same shape, same error-handling, with one extra header (`X-Bobbit-Spawning-Session`) in the children case. Duplicate code.

**Recommended fix:** Same `_lib/` pattern — extract `apiCall(method, path, body, opts?: { extraHeaders })`.

**Block merge?** No.

---

### R-021 — `inlineRoles.toolPolicies` schema is loose

**File:** `defaults/tools/children/extension.ts:104`

```ts
toolPolicies: Type.Optional(Type.Record(Type.String(), Type.String())),
```

Should be `Type.Record(Type.String(), Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("never")]))` to match `GrantPolicy`. Without this, a typo like `"alllow"` is accepted, snapshotted onto the goal, and only fails much later when the tool-activation pipeline reads it.

**Recommended fix:** Tighten the schema. Add a fail-loud test in `tests/proposal-types-goal-inline.test.ts`.

**Block merge?** No.

---

### R-022 — `goal_plan_propose` auto-fallback may be undesirable

**File:** `defaults/tools/children/extension.ts:152-184`

When the goal's workflow has no `execution` gate, the tool silently falls back to looping `goal_spawn_child`. A team-lead who picked a non-parent workflow on purpose (e.g. for a research goal with no children) gets surprise child spawns. The note in the result says "the freeze/replan classifier is unavailable on this workflow" but the agent has already paid for N spawns by then.

**Recommended fix:** Either:
1. Change the fallback to require an explicit `body.fallback: "spawn-children-direct"` opt-in; default behaviour returns the 400 error.
2. Or detect parent intent (`workflowId === "general"` etc.) and refuse the fallback for non-parent workflows.

**Block merge?** No — but the surprise-spawn surface is real.

---

### R-023 — `normalise()` locale-insensitive lowercase

**File:** `src/server/agent/plan-mutation.ts:80-82`

```ts
function normalise(s: string): string {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
}
```

`toLowerCase()` is locale-insensitive and produces wrong results on Turkish `İ → i̇` (diacritic), Lithuanian, etc. The classifier compares user-authored criteria against user-authored step specs, so a non-en locale running Bobbit could see false `criteria-drop` errors.

**Recommended fix:** Either document "criteria normalization is en-locale" in the classifier docs and the SUBGOALS-SPEC §3.6 reference, or use `toLocaleLowerCase("en")` explicitly.

**Block merge?** No.

---

### R-024 — `showStopTeamDialog` "this-only" return overloaded

**File:** `src/app/dialogs.ts:1862`

```ts
if (descendantTeamCount === 0) return "this-only";
```

`"this-only"` here means "no descendants — caller should proceed without dialog". When the dialog is actually shown, the user CAN'T choose "this-only" (the only confirm button is "cascade"). So the contract is: `"this-only"` → no descendants existed; `"cancel"` → user dismissed; `"cascade"` → user confirmed cascade. That's not what the variant name suggests.

**Recommended fix:** Rename to `"no-descendants"` or split into `"no-descendants" | "cascade" | "cancel"`. Update the call site in `api.ts:1162`.

**Block merge?** No.

---

### R-025 — `indexGoals` filters the visible-set twice

**File:** `src/app/sidebar-nesting.ts:84, 198`

`indexGoals(goals, opts)` filters out archived goals in `opts.includeArchived ? goals : goals.filter(g => !g.archived)`. `buildNestedGoalForest` then does the same filter again at line 198 to compute `tops`. The filter result could be cached or threaded through.

**Recommended fix:** Have `indexGoals` return `{ byId, childrenByParent, visible }` so the caller doesn't recompute.

**Block merge?** No — performance nit on a fast path.

---

### R-026 — `midLineY` legacy branch retention

**File:** `src/app/plan-edge-paths.ts:53-62, 91-103`

The `@deprecated` marker has no removal target. Tests that depend on the legacy shape should be migrated and the dead code removed before it bit-rots.

**Recommended fix:** Add a "remove after <date> / <PR-N>" TODO and convert the dependent tests to the new shape.

**Block merge?** No.

---

### R-027 — `showArchiveGoalDialog` pre-flight is destructive

**File:** `src/app/dialogs.ts:1721-1750`

The pre-flight is a real `DELETE /api/goals/:id?cascade=false` — when the goal has no descendants, it actually archives the goal. Compare to `showPauseGoalDialog` / `showResumeGoalDialog` which call `showCount === 0 ? gatewayFetch(POST /pause)` — same pattern, but the no-confirm archive deviates from the established `confirmAction("Archive Goal", ...)` flow that's used for unarchived goals (per AGENTS.md "Archive a goal (UI)" recipe).

**Standard violated:** AGENTS.md "Archive a goal (UI)" recipe — *"Goals with zero descendants fall through to the existing `confirmAction('Archive Goal', …)` flow — no UX regression for single-goal users."* The current implementation skips the confirm modal entirely for no-descendant goals.

Looking at `api.ts:933-960`, `deleteGoal` does have the `confirmAction` flow, so the dialog is invoked from a different path. But `showArchiveGoalDialog` itself has no `confirmAction` for the 200-OK pre-flight branch — it just returns. If the dashboard's archive button calls `showArchiveGoalDialog` directly (vs `deleteGoal`), it bypasses the confirm.

**Recommended fix:** Verify which call sites use `showArchiveGoalDialog` directly vs through `deleteGoal`. If any direct site exists, move the no-descendant confirm into `showArchiveGoalDialog` itself.

**Block merge?** No — but verify the call paths.

---

### R-028 — `archiveGoalAfterMerge` ordering test gap

**File:** `tests/runSubgoalStep-merge-then-archive.test.ts`

The test logs operations but doesn't assert that `state: "complete"` was set BEFORE `archive` (per the comment in `goal-manager.ts:533-545`: *"Order is load-bearing (Lesson 4.2 rescue path)"*). A regression that flips the order would silently re-introduce the rescue-path "stale state" bug.

**Recommended fix:** Add `assert.ok(stateCompleteCallIndex < archiveCallIndex)` to pin the order.

**Block merge?** No.

---

### R-029 — Pause-resume tests don't assert `cancelAllVerifications`

**File:** `tests/api-goals-pause-resume.test.ts`

Pause is documented to cancel in-flight verifications (server.ts:3831). No test stubs the harness and asserts the cancel was actually invoked.

**Recommended fix:** Add a stub-based test that sets up an active verification and asserts it's cancelled after pause.

**Block merge?** No.

---

### R-030 — AGENTS.md missing recipe for `parent` workflow / `goal-plan` freeze

**File:** `AGENTS.md` Recipes section

The diff adds the `parent` meta-workflow and the freeze flag (`computePlanFreezeUpdate`), both critical to the nested-goals UX, but no recipe entry points an agent at `parent-workflow-freeze.ts`. An agent diagnosing "why is execution.verify[] not changing after I edited it" has to read `nested-goals.md` end-to-end.

**Recommended fix:** Add a recipe entry:

```
- **Freeze a parent goal's execution.verify[] on `goal-plan` signal** → `computePlanFreezeUpdate()` in `src/server/agent/parent-workflow-freeze.ts`. Triggered by `gate_signal(gate_id="goal-plan")` on a `parent`-workflow goal. After freeze, plan changes route through the mutation classifier (`PATCH /api/goals/:id/plan`).
```

**Block merge?** No — but the diff already invests in recipe coverage; one more entry is cheap.

---

### R-031 — Debugging entry missing for Lesson 4.5

**File:** `docs/debugging.md`

The retro-audit calls out Lesson 4.5 (`spawn("node")`) as **unfixed**. Adding a debugging-keyword entry — even before fixing the production code — makes the regression observable when a contributor encounters the symptom.

**Recommended fix:** Add to `docs/debugging.md`:

```
### `spawn node ENOENT` after gateway restart under sanitised PATH

Three sites still use `spawn("node", …)` instead of `process.execPath`:
- `src/server/agent/rpc-bridge.ts:262`
- `src/server/harness.ts:112`
- `src/server/watchdog.ts:174`

Symptom: agent restart fails with `ENOENT` under `npm run dev:harness` or
sandboxed environments where `PATH` doesn't include `node`. Fix: replace with
`spawn(process.execPath, …)` and add a `tests/spawn-node-execpath-invariant.test.ts`
guard.
```

**Block merge?** No — and the production fix is in scope per the retro-audit's priority list.

---

### R-032 / R-033 — `JSON.parse(JSON.stringify(...))` deep-clone perf

**Files:** `src/server/agent/goal-manager.ts:249, 280, 293, 310`, `verification-harness.ts:3086`

`structuredClone()` is available in Node 17+ and faster (and correctly handles `Date`, `Map`, etc.). For workflow snapshots (often a few hundred lines of YAML expanded), the perf delta is small but measurable; more importantly, `structuredClone` is the modern idiom.

**Recommended fix:** Replace all five sites. Trivial. Add no test — pure refactor.

**Block merge?** No.

---

### R-034 — Unused `_parentGoalId` parameter

**File:** `src/server/agent/verification-harness.ts:3172`

```ts
private async _waitForChildReadyToMerge(
    _parentGoalId: string,
    childGoalId: string,
    active: ActiveVerification,
): Promise<…>
```

The `_parentGoalId` is passed but never read. A defensive use would be: assert `child.parentGoalId === _parentGoalId` after the `goalStore.get(childGoalId)` lookup, to catch tier-resolver bugs that could yield a cross-tree child.

**Recommended fix:** Either drop the param or add the assertion.

**Block merge?** No.

---

### R-035 — `pruneExpired` not wired into a periodic sweep

**File:** `src/server/agent/plan-mutation-store.ts:122`

`pruneExpired` is implemented and unit-tested but no caller invokes it. Pending-mutation files accumulate over the lifetime of a project. Even though each is small (~1KB), an unbounded growth pattern is bad form.

**Recommended fix:** Call `pruneExpired()` from a daily timer in `server.ts` (next to other periodic sweeps if any), OR call it lazily on every `PATCH /api/goals/:id/plan` for the goal's own file.

**Block merge?** No.

---

### R-036 — Stanza A omits `gh` not-installed fallback

**File:** `src/server/agent/system-prompt.ts:215-220`

Stanza A says *"After ready-to-merge passes, raise the PR via `gh pr create`"* with no fallback. `team-lead.yaml`'s promptTemplate (line 286) DOES include the fallback ("If `gh` is NOT available: Tell the user to create the PR manually"). A team-lead's full system prompt has BOTH stanzas, so this duplication risks the model learning the simpler "just call `gh pr create`" version — and contradicts the role's full guidance.

**Recommended fix:** Either drop the `gh pr create` mention from the stanza (defer to the role) or include the fallback path.

**Block merge?** No.

---

### R-037 — Stanza C doesn't mention the freeze classifier

**File:** `src/server/agent/system-prompt.ts:241-258`

The decision-rule table for `subgoal` vs `team_spawn` vs `task_create` doesn't mention `replanCount > 5 ⇒ auto-pause` or `divergencePolicy` consequences. A team-lead repeatedly calling `goal_plan_propose` will hit auto-pause without seeing why in the prompt.

**Recommended fix:** Add a one-line note: *"Note: repeated plan changes (>5) on a parent-workflow goal trigger auto-pause for human review."*

**Block merge?** No.

---

### R-038 — `ClassifierPlanStep` allows top-level + subgoal duplication

**File:** `src/server/agent/plan-mutation.ts:32-49`

```ts
export interface ClassifierPlanStep {
    planId: string;
    phase?: number;
    spec?: string;
    title?: string;
    subgoal?: { planId: string; title: string; spec: string; … };
}
```

If a caller sets `step.title = "A"` and `step.subgoal.title = "B"`, `effectiveTitle()` returns `"A"` — silent precedence. Document or enforce.

**Recommended fix:** Either document the precedence in the type's JSDoc (already partially done) or add a runtime warning when both are set with conflicting values.

**Block merge?** No.

---

### R-039 — Pause/resume `paused` check inconsistency

**File:** `src/server/server.ts:3826, 3854`

```ts
// pause:
if (g.paused === true) continue;
// resume:
if (g.paused !== true) continue;
```

Both are correct but the asymmetric shape is jarring. Use:

```ts
if (Boolean(g.paused) === true) continue;  // pause
if (Boolean(g.paused) === false) continue; // resume
```

Or `if (!g.paused) continue;` for resume's "not paused" case. Reads better.

**Block merge?** No — pure style.

---

### R-040 — `showStopTeamDialog` cancel-vs-this-only readability

**File:** `src/app/dialogs.ts:1860-1862`

```ts
if (descendantTeamCount === 0) return "this-only";
```

Embedded inside the function rather than guarded at the wrapper layer makes the function's contract opaque. Combined with R-024.

**Recommended fix:** Move the descendant-count guard into `teardownTeamWithDialog` and have `showStopTeamDialog` only ever return `"cascade" | "cancel"`.

**Block merge?** No.

---

### R-041 — `__goalCache` legacy fallback

**File:** `src/app/api.ts:1149-1157`

```ts
const liveGoal = stateModule.state.goals.find(g => g.id === goalId);
const goal = liveGoal
    ? { id: liveGoal.id, title: liveGoal.title }
    : ((window as any).__goalCache?.get?.(goalId) ?? { id: goalId, title: goalId });
```

The comment says `__goalCache` is historical and unset. Drop the lookup; fall through to the `{ id, title: goalId }` default.

**Block merge?** No.

---

### R-042 — `enqueued` defensive set in `indexGoals`

**File:** `src/app/sidebar-nesting.ts:82-87`

The `enqueued` set defends against a "reducer race" producing duplicate goal entries in the input list. No test reproduces this, and `byId.set(g.id, g)` already deduplicates the lookup. The defensive guard adds a `Set` allocation per render.

**Recommended fix:** Remove or convert to a one-time assert in dev mode.

**Block merge?** No.

---

### R-043 — Children extension silent disable

**File:** `defaults/tools/children/extension.ts:21-24`

```ts
if (!sessionId || !goalId) {
    return;
}
```

The team extension at the same line range logs an error. Add the same `console.error("[children-tools] BOBBIT_GOAL_ID / BOBBIT_SESSION_ID missing — tools not registered");` so a misconfigured session shows a diagnostic in the agent's stderr instead of silently lacking the tools.

**Block merge?** No.

---

### R-044 — Children-tools policy test gap

**File:** `tests/role-children-tools-policy.test.ts`

Asserts every contributor declares `goal_*: never`. Doesn't assert `team-lead.yaml` declares `always-allow` for the same nine tools. A regression that drops a `goal_spawn_child: always-allow` from team-lead would silently leave the team-lead unable to spawn children — and the test would still pass.

**Recommended fix:** Add the symmetric assertion.

**Block merge?** No.

---

### R-045 — `spawnedBySessionId` semantics drift

**File:** `docs/nested-goals.md:330-340`, `src/server/agent/goal-manager.ts:564-572`

The doc says *"the team-lead session id that spawned this child via `goal_spawn_child`"* — i.e. the SPECIFIC session at the time of spawn. The backfill helper looks up `teamStore.get(parent.parentGoalId)?.teamLeadSessionId` — i.e. the CURRENT live team-lead, which may differ from the original spawning session if the team-lead was re-attempted. Pick one semantics or document the divergence.

**Block merge?** No.

---

## 4. Areas of concern

These don't have a specific finding ID but warrant a second look in QA or future review.

- **`runSubgoalStep`'s 600+ LoC method.** The retro-audit notes the complexity is "irreducible". I disagree — blocks 6–8 (spawn → wait → merge) form a clear sub-method. The Lesson-4.1 atomicity invariant lives in block 6 only; blocks 7–8 are independent and could be extracted to `_handleResolvedChild()` and `_mergeAndArchiveChild()` without disturbing 4.1. Worth deferring until more lessons land, but the comment "every numbered block is a real bug we already shipped once" is a smell — irreducible methods don't usually have nine numbered sub-blocks.
- **`anyInFlightChild` parent-suppression interplay with `paused`.** The current rule "suppress nudges while any non-paused child is in-flight" is correct, but a subgoal paused mid-wait holds the parent's `runSubgoalStep` polling loop. Combined with R-011, two paused siblings on a `maxConcurrentChildren=3` tree can starve a third. Worth a stress test.
- **Cascade-archive walk depth-first vs BFS.** `listDescendants` walks BFS, then `archiveOrder = [...descendants].reverse()` to get deepest-first archive order. Reversing a BFS list is NOT the same as DFS post-order — siblings may be archived before their cousins' children. Probably fine because archive is idempotent, but the comment claims deepest-first which is misleading.
- **`computeTreeCost` cache invalidation correctness.** The cache keys on `(rootGoalId, costGeneration)`. `getGeneration()` ticks on every cost mutation across ALL trackers (it's a per-tracker counter). For two simultaneous trees, a cost write on tree A invalidates tree B's cache too — harmless (recompute) but wasteful. Worth measuring on multi-project setups.
- **Inline-workflow inheritance and aggregation-gate stripping.** `stripSubgoalStepsForChildInheritance` drops gates strictly between `execution` and `ready-to-merge`. A user-defined workflow with a gate named e.g. `synthesis-review` would be silently stripped from children. Document the side-effect prominently.
- **`POST /spawn-child`'s implicit auto-start.** Spawning a child via the REST handler auto-triggers `setupWorktreeAndStartTeam`. Spawning the same child via `runSubgoalStep` ALSO auto-triggers it (line 3122). The two paths' interaction during a restart-recovery window (where the harness re-enters `runSubgoalStep` for an already-spawned child) is worth a stress test.

---

## 5. Coverage assessment

### AGENTS.md recipes

The diff adds substantial recipe coverage — *"Add a nested-goal field"*, *"Add a subgoal verify-step"*, *"Bind an ephemeral role or workflow to one goal"*, *"Drive a nested-goal lifecycle from the team-lead"*, *"Cascade confirmation dialogs"*, *"Compute tree cost across descendants"*, *"Run mutation classification on a frozen plan"*, *"Inject nested-goals awareness into a team-lead's system prompt"*, *"Render nested goal trees / plan DAG"*. **Gap:** no recipe for the `parent` meta-workflow + freeze flag (R-030).

### Debugging keyword index

Several entries: *"Child team-lead raises a PR"*, *"`PATCH /api/goals/:id/plan` returns 409/400"*, *"Archived reviewer/QA sessions don't nest under their team-lead"*, *"`gateDef.dependsOn is not iterable`"*, *"Child re-executes parent's plan / deadlocks on `ready-to-merge`"*, *"Plan tab shows duplicate sub-trees"*. **Gap:** no entry for Lesson 4.5 (R-031), and no entry for "subgoal child sits in `setupStatus=preparing` forever" (the showstopper bug from `0f7e6a64` *is* covered by the `runSubgoalStep` + spawn-child handlers, but the symptom isn't keyword-indexed).

### E2E coverage requirement

Per AGENTS.md: *"Every feature that changes user-facing behavior MUST include a browser E2E test covering (1) navigation, (2) happy path, (3) persistence across reload, (4) cleanup/undo."*

- **Sidebar nesting (`tests/e2e/ui/sidebar-nesting.spec.ts`)** — covers happy path. Cleanup/undo less clear.
- **Plan tab DAG (`tests/e2e/ui/plan-tab.spec.ts`)** — covers happy path.
- **Cascade archive / pause (`tests/e2e/ui/cascade-archive.spec.ts`, `cascade-pause.spec.ts`)** — covers happy path AND cleanup (the cascade IS the cleanup).
- **Parent breadcrumb** — covers navigation only.
- **Tree-cost rollup** — covers happy path; no persistence test.
- **Mutation approval card** — `tests/mutation-approval-card.test.ts` is unit-level, not browser E2E. The reducer race in R-029-adjacent §5.8 risk has no E2E coverage.

**Gap:** Mutation-approval card has no browser E2E. Persistence across reload is not asserted on the plan-tab or tree-cost flows.

### Flaky-test risks

- **`tests/api-team-teardown-cascade.test.ts`** uses real SessionManager teardown — may be timing-sensitive. No `await` for the cascade walk to complete; uses `pollUntil` once but other assertions are sync.
- **`tests/runSubgoalStep-paused-child-keeps-waiting.test.ts`** uses real `setTimeout(500ms)` polling via `_waitForChildReadyToMerge`. A slow CI runner could miss the first poll tick.
- **`tests/cascade-dialog.test.ts`** — Playwright `file://` fixture; OK.
- **No port collisions detected** in the new tests (all use the in-process or ephemeral-port harness).

### Co-author trailer

Spot-checked recent commits on the branch via `git log --format='%(trailers)' origin/master..HEAD | head -20` — every commit includes `Co-authored-by: bobbit-ai <bobbit@bobbit.ai>`. ✓

### Truncation of large content >32KB

Not directly exercised by the new code paths — the harness's command/review steps already use `truncateLargeToolContent`. The new `runSubgoalStep` returns short status strings, not large content. ✓

### Reducer (transcript mutations)

`mutation-pending` and `mutation-update` are properly reduced via `reduce()` in `src/app/message-reducer.ts:432-465`. ✓

---

*Co-authored-by: bobbit-ai <bobbit@bobbit.ai>*
