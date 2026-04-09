# Goals

## G-01: Create a goal via assistant

**Preconditions:** App loaded, project registered.

**Steps:**
1. Click "New Goal" in sidebar
2. Assistant session opens with auto-prompt
3. Type goal description (or use GOAL_PROPOSAL keyword in tests)
4. Agent calls `propose_goal` tool
5. Goal preview form appears in right panel
6. Review/edit title, spec, workflow selection
7. Toggle optional steps (e.g. QA testing)
8. Click "Create Goal"

**Expected:**
- Goal appears in sidebar under project
- Navigates to goal dashboard
- Assistant session is terminated
- Workflow gates are created per selected workflow
- Optional steps reflect toggles

**Coverage:** `tests/e2e/ui/goal-creation.spec.ts` — "goal creation via assistant flow"

---

## G-02: Create a goal via API (direct)

**Preconditions:** Project registered.

**Steps:**
1. POST /api/goals with title, spec, workflow

**Expected:**
- Goal created with correct fields
- Gates created per workflow
- Goal appears in sidebar on next refresh

**Coverage:** `tests/e2e/ui/goal-creation.spec.ts` — "direct API creation"

---

## G-03: Goal worktree setup

**Preconditions:** Goal created, project is a git repo.

**Steps:**
1. Goal is created (auto-start enabled)
2. Server sets up worktree for goal branch
3. Poll setupStatus

**Expected:**
- setupStatus transitions: pending → ready
- Goal branch exists in git
- Worktree directory created
- worktree_setup_command runs if configured

**Coverage:** `tests/e2e/auto-start-team.spec.ts` (API-level)

---

## G-04: Team auto-start

**Preconditions:** Goal created with autoStartTeam enabled.

**Steps:**
1. Worktree setup completes
2. Server automatically starts team

**Expected:**
- Team lead session created
- teamLeadSessionId populated on goal
- Team lead appears in sidebar
- Dashboard shows team section

**Coverage:** `tests/e2e/auto-start-team.spec.ts` (API-level), `tests/e2e/ui/team-lifecycle-ui.spec.ts` (partial)

---

## G-05: Goal dashboard — overview

**Preconditions:** Goal exists with team started.

**Steps:**
1. Click goal in sidebar
2. Dashboard loads

**Expected:**
- Title and spec visible
- Setup status shown (ready/pending)
- Team section shows agents with status
- Gates/workflow tab accessible
- PR status shown if branch pushed

**Coverage:** Minimal — `tests/e2e/ui/team-lifecycle-ui.spec.ts` checks dashboard loads but doesn't assert content deeply.

---

## G-06: Goal dashboard — gates tab

**Preconditions:** Goal with workflow gates.

**Steps:**
1. Navigate to goal dashboard
2. Click Gates/Workflow tab

**Expected:**
- All gates listed with status (pending/passed/failed)
- Dependencies shown (which gates block which)
- Signal button available for eligible gates
- Passed gates show green checkmark
- Failed gates show red X with verification output

**Coverage:** `tests/e2e/ui/gate-verification-ux.spec.ts` — partial (viewer WS, session links). Gate status display untested.

---

## G-07: Signal a gate

**Preconditions:** Gate is eligible (dependencies met).

**Steps:**
1. Navigate to gates tab
2. Enter gate content (markdown)
3. Click Signal
4. Verification runs asynchronously

**Expected:**
- Gate status transitions to verifying
- Verification output streams in modal (if open)
- On pass: gate shows passed status
- On fail: gate shows failed with output
- Downstream gates become eligible

**Coverage:** `tests/e2e/gates-api.spec.ts` (API-level thorough), `tests/e2e/ui/cancel-verification.spec.ts` (cancel flow). UI signal flow untested.

---

## G-08: Cancel verification

**Preconditions:** Verification is running on a gate.

**Steps:**
1. Open verification output modal
2. Click Cancel button

**Expected:**
- Verification stops
- Gate reverts to previous status
- Modal closes or shows cancellation
- Can re-signal the gate

**Coverage:** `tests/e2e/ui/cancel-verification.spec.ts`

---

## G-09: Goal with sandbox

**Preconditions:** Docker available, sandbox configured in project.

**Steps:**
1. Create goal with sandbox toggle enabled
2. Wait for setup

**Expected:**
- Container created/reused for project
- Worktree created inside container
- Team agents run inside container
- Git status works through container exec

**Coverage:** Manual integration test only (test C). All automated sandbox tests skipped without Docker.

---

## G-10: Re-attempt a failed goal

**Preconditions:** Goal exists that previously failed or was abandoned.

**Steps:**
1. Start new goal assistant session
2. System detects previous attempt (same title/spec)
3. Re-attempt context injected

**Expected:**
- Assistant acknowledges previous attempt
- Can reuse or modify previous spec
- New goal created with fresh gates

**Coverage:** None — re-attempt flow is untested.

---

## G-11: Dismiss goal proposal

**Preconditions:** Assistant has proposed a goal.

**Steps:**
1. Goal preview form visible
2. Click "Dismiss" or navigate away

**Expected:**
- Proposal dismissed
- Assistant session continues (not terminated)
- Can request a new proposal

**Coverage:** `tests/e2e/ui/goal-creation.spec.ts` — "dismiss and re-propose"

---

## G-12: Goal survives gateway crash

**Preconditions:** Goal exists with team running.

**Steps:**
1. Gateway crashes
2. Gateway restarts

**Expected:**
- Goal appears in sidebar
- Dashboard loads with correct status
- Team sessions restored
- Gates preserve their status
- Can continue working on the goal

**Coverage:** Manual integration test only.
