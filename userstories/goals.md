# Goal Management — User Stories

## G-01: Create a goal via assistant

**Preconditions:** Project registered.

**Steps:**
1. Click "New Goal" in the sidebar.
2. An assistant session opens.
3. Describe what you want built.
4. The agent proposes a goal.
5. A preview form appears with editable fields.
6. Edit the title, spec, workflow, and optional step toggles.
7. Click "Create Goal".

**Expected:**
- Goal appears in the sidebar under the project.
- Browser navigates to the goal dashboard.
- The assistant session closes.
- Gates match the selected workflow.
- Optional step toggles are respected.

**Coverage:** Covered.

---

## G-02: Create a goal directly

**Preconditions:** Project registered.

**Steps:**
1. Create a goal via API or direct form with a title, spec, and workflow.

**Expected:**
- Goal is created with the specified title, spec, and workflow.
- Gates are created matching the workflow.
- Goal appears in the sidebar.

**Coverage:** Covered.

---

## G-03: Goal worktree setup

**Preconditions:** Goal created; project is in a git repo.

**Steps:**
1. Goal is created.
2. Wait for setup to complete.

**Expected:**
- Setup status progresses from "preparing" to "ready".
- The goal gets its own branch and worktree.
- The configured setup command runs if present.
- If setup fails, status shows an error with a "Retry" button.
- If the project is a subdirectory of a repo, the goal working directory is offset to that subdirectory.

**Coverage:** API-level.

---

## G-04: Team auto-start

**Preconditions:** Goal created with auto-start enabled (the default).

**Steps:**
1. Worktree setup completes successfully.

**Expected:**
- A team lead session is created automatically.
- The team lead appears in the sidebar.
- The goal dashboard shows the team.

**Coverage:** Partial.

---

## G-05: Goal dashboard overview

**Preconditions:** Goal exists.

**Steps:**
1. Click the goal in the sidebar.

**Expected:**
- The dashboard loads with the goal's title and spec.
- Setup status is shown (preparing, ready, or error).
- Team agents are listed if the team has started.
- PR status is shown if the branch has been pushed.

**Coverage:** Partial.

---

## G-06: Gates tab

**Preconditions:** Goal has a workflow.

**Steps:**
1. Open the goal dashboard.
2. Click the "Gates" tab.

**Expected:**
- All gates are listed with their status (pending, passed, failed, or verifying).
- Dependencies between gates are visible.
- The "Signal" button is enabled only when upstream gates have passed.
- Passed gates show a green indicator.
- Failed gates show verification output.

**Coverage:** Partial.

---

## G-07: Signal a gate

**Preconditions:** Gate is eligible (upstream gates have passed).

**Steps:**
1. Go to the gates tab.
2. Enter content.
3. Click "Signal".

**Expected:**
- Gate enters a "verifying" state.
- Verification output streams in a modal if opened.
- On pass: gate turns green, downstream gates become eligible.
- On fail: gate turns red with output.

**Coverage:** Partial.

---

## G-08: Cancel verification

**Preconditions:** A verification is running.

**Steps:**
1. Open the verification output modal.
2. Click "Cancel".

**Expected:**
- Verification stops.
- Gate reverts to its previous status.
- The gate can be re-signaled.

**Coverage:** Covered.

---

## G-09: Goal with sandbox

**Preconditions:** Docker available; sandbox enabled for the project.

**Steps:**
1. Create a goal with the sandbox toggle on.

**Expected:**
- Team agents run inside a container.
- Git operations work inside the container.
- Git status widget works.

**Coverage:** Manual only.

---

## G-10: Re-attempt a failed goal

**Preconditions:** A previous goal failed or was abandoned.

**Steps:**
1. Start a new goal assistant.
2. The system detects the previous attempt.

**Expected:**
- The assistant acknowledges the previous attempt.
- Offers approaches: start fresh, fix up existing work, or revert and fix.
- The new goal references the old branch and PR.

**Coverage:** None.

---

## G-11: Dismiss goal proposal

**Preconditions:** The assistant has proposed a goal.

**Steps:**
1. Click "Dismiss" on the preview form.

**Expected:**
- The proposal disappears.
- The assistant session continues.
- You can ask for a new proposal.

**Coverage:** Covered.

---

## G-12: Goal survives gateway crash

**Preconditions:** A goal with a running team exists.

**Steps:**
1. The gateway crashes.
2. The gateway restarts.

**Expected:**
- Goal appears in the sidebar after restart.
- The dashboard shows correct status.
- Team sessions are restored.
- Gate statuses are preserved.
- Goals that were mid-setup show as error (can retry).

**Coverage:** Manual only.
