# Goal Dashboard — User Stories

## D-01: Dashboard loads

**Preconditions:** Goal exists.

**Steps:**
1. Click goal in sidebar.

**Expected:**
- URL changes to `#/goal/<id>`.
- `BobbitLoadingAnimation` shows during data fetch.
- Title and spec displayed.
- Setup status badge:
  - **preparing** — spinner.
  - **ready** — green badge.
  - **error** — red badge with Retry button.
- Team section visible if team has been started.
- Gates section accessible.
- No flash of stale data from a previous goal (`goalDashboardId` state tracks the current goal and prevents stale renders).

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
- Tab state is **not** preserved when navigating away and back (resets to the default tab).

**Coverage:** None.

---

## D-03: Gate status display

**Preconditions:** Goal with gates in various states (pending, passed, failed, verifying).

**Steps:**
1. View the Gates tab.

**Expected:**
- Gates listed respecting dependency ordering.
- **Pending** — grey indicator.
- **Passed** — green checkmark with content preview and timestamp.
- **Failed** — red X with a link to verification output.
- **Verifying** — spinner with phase info.
- Signal button enabled only when all upstream dependencies have passed.
- Blocked gates have a disabled Signal button.

**Coverage:** None.

---

## D-04: Verification output modal

**Preconditions:** Verification running or completed on a gate.

**Steps:**
1. Click "View Output" on a gate.

**Expected:**
- Modal opens.
- Content bootstraps from the API (`/api/goals/:id/verifications/active`).
- After bootstrap, streams live updates via the `/ws/viewer` WebSocket.
- Steps displayed with status indicators (running / pass / fail / skip).
- Output streams in real-time for running steps.
- Completed steps show status badges.
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
- Mergeable indicator shown.
- Review decision shown.
- Refreshes periodically (60 s throttle via `PR_POLL_INTERVAL_MS`).
- Merge button visible if the viewer is an admin.

**Coverage:** API-level only.

---

## D-06: Dashboard auto-refresh

**Preconditions:** Goal with an active team.

**Steps:**
1. View dashboard.
2. An agent completes a task in the background.

**Expected:**
- Gate status updates arrive via `/ws/viewer` WebSocket broadcasts (`broadcastToGoal`).
- Team agent status updates without a page refresh.
- No manual polling needed for gate or verification changes.

**Coverage:** None.

---

## D-07: Navigate dashboard to agent and back

**Preconditions:** Goal with at least one agent.

**Steps:**
1. Click the agent link on the dashboard.
2. View the agent session.
3. Click back / navigate back.

**Expected:**
- Agent session loads at `#/session/<id>`.
- Back navigation returns to `#/goal/<goalId>`.
- Dashboard state is reloaded (not cached).

**Coverage:** None.

---

## D-08: Retry goal setup

**Preconditions:** Goal setup failed (`setupStatus` is `"error"`).

**Steps:**
1. Click the "Retry Setup" button.

**Expected:**
- POST triggers `retrySetup()`, which resets status to `"preparing"`.
- Worktree setup re-runs.
- `createWorktree()` is idempotent — handles a pre-existing branch from the previous failed attempt.
- Status transitions: error → preparing → ready.

**Coverage:** None.

---

## D-09: Tasks view

**Preconditions:** Goal with tasks.

**Steps:**
1. View the tasks section.

**Expected:**
- Tasks listed with:
  - **Type** — implementation / code-review / testing / bug-fix / refactor / custom.
  - **Status** — todo / in-progress / complete / blocked / skipped.
  - **Assignee** session.
  - **Dependencies** (`depends_on`).
  - **Spec** and **result** fields.
  - Git handoff fields: `baseSha`, `headSha`, `branch`.

**Coverage:** API-level only.

---

## D-10: Dashboard loading state

**Preconditions:** Goal exists.

**Steps:**
1. Navigate to the dashboard for the first time.

**Expected:**
- `BobbitLoadingAnimation` shows.
- Animation clears when data loads.
- `state.goalDashboardId` is set to prevent stale data from a previously viewed goal.
- Error state shown if goal not found (404).

**Coverage:** Unit test only.
