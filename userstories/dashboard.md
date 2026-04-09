# Goal Dashboard — User Stories

## D-01: Dashboard loads

**Preconditions:** Goal exists.

**Steps:**
1. Click goal in sidebar.

**Expected:**
- Loading animation shows briefly.
- Title and spec displayed.
- Setup status visible (preparing/ready/error).
- Team section visible if team has been started.
- Gates section accessible.
- No flash of stale data from a previously viewed goal.

**Coverage:** Minimal.

---

## D-02: Dashboard tabs

**Preconditions:** Dashboard loaded.

**Steps:**
1. Click each tab in turn.

**Expected:**
- Tabs include Overview, Gates/Workflow, and Team/Agents.
- Tab content switches on click.
- Active tab is visually highlighted.
- Tab state resets to default when navigating away and back.

**Coverage:** None.

---

## D-03: Gate status display

**Preconditions:** Goal with gates in various states (pending, passed, failed, verifying).

**Steps:**
1. View the Gates tab.

**Expected:**
- Gates listed in dependency order.
- Pending gates show a neutral/grey indicator.
- Passed gates show green with content preview and timestamp.
- Failed gates show red with a link to verification output.
- Verifying gates show a spinner with phase info.
- Signal button enabled only when all upstream dependencies have passed.
- Blocked gates have a disabled Signal button.

**Coverage:** None.

---

## D-04: Verification output modal

**Preconditions:** Verification running or completed on a gate.

**Steps:**
1. Click "View Output" on a gate.

**Expected:**
- Modal opens showing verification steps with status indicators.
- Output streams in real-time for running steps.
- Completed steps show pass/fail/skip badges.
- Cancel button visible during an active verification.
- Closing and re-opening the modal shows the same state.

**Coverage:** Partial.

---

## D-05: PR status

**Preconditions:** Goal branch pushed to remote; PR exists.

**Steps:**
1. View dashboard.

**Expected:**
- PR link displayed.
- Status badge (open / merged / closed / draft).
- CI check status shown.
- Mergeable and review status shown.
- Refreshes periodically.
- Merge button visible if you have permission.

**Coverage:** API-level only.

---

## D-06: Dashboard live updates

**Preconditions:** Goal with an active team.

**Steps:**
1. View dashboard.
2. An agent completes a task in the background.

**Expected:**
- Gate status updates appear without page refresh.
- Team agent status updates without page refresh.
- No manual reload needed for gate or verification changes.

**Coverage:** None.

---

## D-07: Navigate dashboard to agent and back

**Preconditions:** Goal with at least one agent.

**Steps:**
1. Click the agent link on the dashboard.
2. View the agent session.
3. Navigate back.

**Expected:**
- Agent session loads.
- Back navigation returns to the goal dashboard.
- Dashboard state is fresh (not cached from before).

**Coverage:** None.

---

## D-08: Retry goal setup

**Preconditions:** Goal setup failed (error status shown).

**Steps:**
1. Click the "Retry Setup" button.

**Expected:**
- Setup re-runs.
- Status transitions from error back to preparing, then to ready.
- Handles the case where a previous failed attempt left partial state — no manual cleanup needed.

**Coverage:** None.

---

## D-09: Tasks view

**Preconditions:** Goal with tasks.

**Steps:**
1. View the tasks section.

**Expected:**
- Tasks listed with type, status, assignee, dependencies, spec, and result.
- Git branch info shown per task.

**Coverage:** API-level only.

---

## D-10: Dashboard loading state

**Preconditions:** Goal exists.

**Steps:**
1. Navigate to the dashboard for the first time.

**Expected:**
- Loading animation shows.
- Animation clears when data loads.
- Error shown if goal not found.

**Coverage:** Unit test only.
