# Dashboard

## D-01: Dashboard loads with correct state

**Preconditions:** Goal exists with team and gates.

**Steps:**
1. Click goal in sidebar

**Expected:**
- Loading animation shows briefly
- Title, spec, status displayed
- Setup status badge (ready/pending/failed)
- Team section populated
- Gates section accessible

**Coverage:** Minimal — team-lifecycle-ui checks dashboard renders.

---

## D-02: Dashboard tabs navigation

**Preconditions:** Goal dashboard loaded.

**Steps:**
1. Click each tab (Overview, Gates, Team, Tasks)
2. Verify content switches

**Expected:**
- Each tab shows relevant content
- Active tab highlighted
- Tab state preserved on return from session view

**Coverage:** None — tab navigation untested.

---

## D-03: Gate status display

**Preconditions:** Goal with gates in various states.

**Steps:**
1. Navigate to gates tab
2. Observe gate cards

**Expected:**
- Pending gates: grey/neutral indicator
- Passed gates: green checkmark, signal content preview
- Failed gates: red X, verification output link
- Dependency arrows/lines between gates
- Eligible gates have Signal button enabled
- Blocked gates have Signal button disabled

**Coverage:** None — gate visual display untested.

---

## D-04: Verification output modal

**Preconditions:** Gate verification running or completed.

**Steps:**
1. Click "View Output" on a gate
2. Modal opens

**Expected:**
- Modal shows verification steps with status
- Output streams in real-time during active verification
- Completed steps show pass/fail/skip badges
- Can close modal, re-open shows same state
- Cancel button visible during active verification

**Coverage:** `tests/e2e/ui/gate-verification-ux.spec.ts` — viewer WS and links. `tests/e2e/verification-output.spec.ts` (API). Modal display partially tested.

---

## D-05: PR status on dashboard

**Preconditions:** Goal branch pushed, PR exists.

**Steps:**
1. View dashboard
2. PR status section visible

**Expected:**
- PR link displayed
- Status badge (open/merged/closed)
- CI status if available
- Refreshes periodically

**Coverage:** `tests/e2e/pr-cache.spec.ts` (API cache). No UI test.

---

## D-06: Dashboard auto-refresh

**Preconditions:** Goal with active team.

**Steps:**
1. View dashboard
2. Agent completes a task (in background)
3. Observe dashboard update

**Expected:**
- Team agent status updates without page refresh
- Gate status updates when verification completes
- Task status updates visible

**Coverage:** None — auto-refresh untested.

---

## D-07: Navigate from dashboard to agent session and back

**Preconditions:** Goal with team agent.

**Steps:**
1. Click agent link on dashboard
2. View agent session
3. Click back button or goal link

**Expected:**
- Agent session loads with correct messages
- Back navigation returns to dashboard
- Dashboard state preserved (same tab, scroll position)

**Coverage:** None — back-navigation untested.

---

## D-08: Retry goal setup

**Preconditions:** Goal setup failed (e.g. worktree creation error).

**Steps:**
1. View dashboard showing setup failure
2. Click "Retry Setup"

**Expected:**
- Setup re-runs
- Status transitions: failed → pending → ready
- Previous failed worktree cleaned up
- Team can start after successful retry

**Coverage:** None — retry setup untested.

---

## D-09: Tasks view

**Preconditions:** Goal with tasks created.

**Steps:**
1. Navigate to tasks tab
2. View task list

**Expected:**
- Tasks listed with type, status, assignee
- Dependencies shown
- Can see task details (spec, result)
- Status badges: todo, in-progress, complete, blocked

**Coverage:** `tests/e2e/tasks-api.spec.ts` (API). No UI test.

---

## D-10: Dashboard loading state

**Preconditions:** Goal exists.

**Steps:**
1. Navigate to goal dashboard (first load)

**Expected:**
- BobbitLoadingAnimation shows during data fetch
- Animation clears when data loads
- No flash of stale data from previous goal
- Error state shown if goal not found

**Coverage:** Unit test `goal-dashboard-setup-poll.spec.ts` (polling). No UI loading test.
