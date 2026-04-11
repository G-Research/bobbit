# Goal Management — User Stories

The goal system orchestrates multi-agent work: creation via assistant or API, worktree setup, team auto-start, gate-based workflows, sandbox isolation, crash recovery, and dashboard monitoring.

---

## G-01: Create a goal via assistant

**Preconditions:** Project registered, sidebar visible.

**Steps and expectations:**
1. Click "New Goal" in the sidebar.
   - An assistant session opens in the main panel.
   - The assistant greets the user and asks what they want to build.
2. Describe the goal (e.g. "add dark mode support").
   - The assistant asks clarifying questions or proposes a goal.
3. The agent calls `propose_goal` with a title, spec, and workflow.
   - A preview form appears in chat showing editable fields: title, spec (markdown), workflow dropdown, and optional step toggles.
   - The form is pre-filled with the agent's proposal.
4. Edit the title to "Dark Mode v2" and toggle off an optional step (e.g. "QA testing").
   - Title field updates in real time. The toggled step is visually unchecked.
5. Click "Create Goal".
   - Goal appears in the sidebar under the project immediately.
   - Browser navigates to the goal dashboard.
   - The assistant session closes automatically (no orphaned session).
   - Gates listed on the dashboard match the selected workflow, minus the toggled-off optional step.
6. Open the goal dashboard and verify the spec.
   - Title reads "Dark Mode v2". Spec matches the edited markdown. Workflow matches the selection.

**Coverage:** goal-creation.spec.ts (assistant flow, optional step toggles), goal-creation-flow.spec.ts (navigation to dashboard)

---

## G-02: Create a goal directly via API

**Preconditions:** Project registered.

**Steps and expectations:**
1. Send `POST /api/goals` with `{ title: "Refactor auth", spec: "...", workflow: "feature" }`.
   - Response is `201 Created` with the goal object including an `id`.
   - Goal object includes `title`, `spec`, `workflow`, `status`, and `gates` array.
2. Fetch `GET /api/goals/:id`.
   - Returned goal matches the submitted title, spec, and workflow.
   - Gates array contains entries matching the workflow definition (e.g. `implementation`, `code-review`).
   - Each gate has `status: "pending"`.
3. Check the sidebar (via WebSocket `goals_update` message or page reload).
   - Goal "Refactor auth" appears under the project in the sidebar.
4. Create a second goal with the same title.
   - Both goals exist independently with distinct IDs. Duplicate titles are allowed.

**Coverage:** goal-creation.spec.ts (API creation), goal-creation-flow.spec.ts (API goal creation, navigation)

---

## G-03: Goal worktree setup

**Preconditions:** Goal created; project is in a git repo with `worktree_setup_command` configured (e.g. `npm ci`).

**Steps and expectations:**
1. Create a goal (via assistant or API).
   - Goal status is `preparing`. Dashboard shows a setup progress indicator.
2. Wait for worktree setup to complete.
   - A git branch is created (e.g. `goal/refactor-auth`).
   - A worktree directory is created at `<project-root>-wt-goal/<goalId>/`.
   - The configured `worktree_setup_command` runs inside the new worktree directory.
   - `SOURCE_REPO` environment variable is set to the primary worktree path.
3. Setup completes successfully.
   - Goal status transitions to `ready`.
   - Dashboard setup indicator shows a green checkmark.
4. Kill the setup command mid-run (simulate setup failure).
   - Goal status shows `error` with the failure output.
   - A "Retry" button appears on the dashboard.
5. Click "Retry".
   - Setup re-runs from scratch. On success, status transitions to `ready`.
6. Create a goal for a project whose root is a subdirectory of a git repo (e.g. `packages/frontend`).
   - Worktree is created at the repo root, but the goal working directory is offset to the subdirectory (`packages/frontend`).
   - Agent sessions use the offset directory as their CWD.

**Coverage:** API-level (worktree creation, setup command, retry). Manual integration tests cover crash during setup.

---

## G-04: Team auto-start

**Preconditions:** Goal created with auto-start enabled (the default), worktree setup completed successfully.

**Steps and expectations:**
1. Worktree setup completes (status transitions to `ready`).
   - A team lead session is created automatically within seconds.
   - The team lead session appears in the sidebar nested under the goal.
2. Open the goal dashboard.
   - The "Team" section shows the team lead agent with status `running` or `streaming`.
   - The team lead's task is visible (e.g. "Implement goal: Refactor auth").
3. Create a goal with auto-start disabled.
   - Worktree setup completes but no team lead session is created.
   - Dashboard team section is empty. A "Start Team" button is available.
4. Click "Start Team" on the no-auto-start goal.
   - Team lead is created. Same result as step 1–2.

**Coverage:** auto-start-team.spec.ts (auto-start API)

---

## G-05: Goal dashboard overview

**Preconditions:** Goal exists with a running team (at least team lead + one spawned agent).

**Steps and expectations:**
1. Click the goal in the sidebar.
   - Dashboard loads showing the goal title and spec rendered as markdown.
   - No loading spinner persists after data arrives.
2. Observe the setup status section.
   - Shows one of: "Preparing" with spinner, "Ready" with green checkmark, or "Error" with retry button.
3. Observe the team section.
   - Lists all team agents with: name/role, status (idle, streaming, completed), and current task summary.
   - Clicking an agent name navigates to that agent's session.
4. Observe the PR/branch status.
   - If the goal branch has been pushed, a PR link or "Push to create PR" indicator is shown.
   - Branch name is displayed (e.g. `goal/refactor-auth`).
5. Navigate away and back to the dashboard.
   - State is preserved — no flash of empty content. Data is fetched fresh on each visit.

**Coverage:** goal-creation-flow.spec.ts (navigation to dashboard). Partial coverage — full dashboard rendering not yet E2E tested.

---

## G-06: Gates tab

**Preconditions:** Goal has a workflow with at least 3 gates, some with dependencies (e.g. `implementation` → `code-review` → `release`).

**Steps and expectations:**
1. Open the goal dashboard and click the "Gates" tab.
   - All workflow gates are listed in dependency order.
   - Each gate shows: name, status badge (`pending`, `passed`, `failed`, or `verifying`), and dependency arrows or labels.
2. Observe the first gate (no upstream dependencies).
   - "Signal" button is enabled (clickable).
   - Status badge shows `pending`.
3. Observe the second gate (depends on the first).
   - "Signal" button is disabled or hidden because the upstream gate has not passed.
   - A dependency label indicates it is waiting on the first gate.
4. Signal the first gate (see G-07) and wait for it to pass.
   - First gate badge turns green (`passed`).
   - Second gate's "Signal" button becomes enabled.
5. Signal the first gate and wait for it to fail.
   - First gate badge turns red (`failed`).
   - Verification output is shown inline or expandable below the gate.
   - Downstream gates remain disabled.
6. Attempt to signal the second gate via API while the first is still pending.
   - Server responds `409 Conflict`. Gate status does not change.

**Coverage:** gates-api.spec.ts (gate CRUD, signal, dependency enforcement)

---

## G-07: Signal a gate

**Preconditions:** Goal with a gate whose upstream dependencies have all passed (gate is eligible for signaling).

**Steps and expectations:**
1. Navigate to the Gates tab. Locate the eligible gate.
   - "Signal" button is enabled.
2. Enter content in the signal input (e.g. markdown describing what was done).
3. Click "Signal".
   - Gate status transitions to `verifying` immediately.
   - A spinner or pulsing indicator appears on the gate row.
4. Open the verification output modal (click the gate row or an "Output" button).
   - Verification output streams line by line as the verifier runs.
   - Modal shows real-time output (not batched).
5. Verification passes.
   - Gate badge turns green (`passed`).
   - Verification output shows a success summary.
   - Downstream gates that depend on this gate become eligible (their "Signal" buttons enable).
6. Signal a different gate and have verification fail.
   - Gate badge turns red (`failed`).
   - Verification output shows the failure details and failed step output.
   - The gate can be re-signaled (the "Signal" button re-enables after failure).
7. Signal a gate with empty content (no text).
   - Signal is accepted (content is optional). Metadata-only signals are valid.

**Coverage:** gates-api.spec.ts (signal, verification pass/fail)

---

## G-08: Cancel gate verification

**Preconditions:** A gate verification is currently running (gate status is `verifying`).

**Steps and expectations:**
1. Open the verification output modal for the verifying gate.
   - Modal shows streaming verification output.
   - A "Cancel" button is visible.
2. Click "Cancel".
   - Verification process stops immediately.
   - Modal closes or shows "Cancelled" status.
3. Check the gate status.
   - Gate reverts to its previous status (`pending` or `failed`, depending on prior state).
   - Gate does not remain stuck in `verifying`.
4. Re-signal the gate with new content.
   - Gate enters `verifying` again. Verification runs fresh.
   - Previous cancelled verification output is not shown (clean slate).
5. Cancel via API: `POST /api/goals/:id/gates/:gateId/cancel-verification`.
   - Same behavior as UI cancel — verification stops, status reverts.

**Coverage:** cancel-verification.spec.ts (cancel flow), cancel-verification UI tests

---

## G-09: Goal with Docker sandbox

**Preconditions:** Docker available and running; project has `sandbox: "docker"` in `project.yaml`.

**Steps and expectations:**
1. Create a goal for the sandbox-enabled project.
   - Goal setup creates the worktree as normal.
   - A Docker container is started (or reused) for the project. Container label: `bobbit-project=<projectId>`.
2. Team lead is spawned and begins work.
   - Agent's `bash` and `bash_bg` commands execute inside the Docker container, not on the host.
   - File edits happen in the worktree (mounted into the container).
3. Agent runs `git status` inside the container.
   - Git operations work correctly — the worktree is properly mounted.
   - Git status widget in the UI reflects the container's worktree state.
4. Check sandbox status via `GET /api/sandbox-status`.
   - Response shows the container is running with the correct project ID.
5. Agent completes work and is dismissed.
   - Container remains running (one long-lived container per project, shared across goals).

**Coverage:** Manual integration tests only (Docker required).

---

## G-10: Re-attempt a failed goal

**Preconditions:** A previous goal for the same project failed or was abandoned. Its branch and/or PR still exist.

**Steps and expectations:**
1. Click "New Goal" in the sidebar for the same project.
   - Assistant session opens.
2. Describe a goal similar to the previously failed one.
   - The assistant detects the previous attempt (via branch history or goal records).
   - The assistant acknowledges the prior failure and summarizes what was done.
3. The assistant offers approaches:
   - **Start fresh:** New branch from `master`, ignore previous work.
   - **Fix up existing work:** Branch from the old goal branch, build on existing changes.
   - **Revert and fix:** Start from `master` but reference the old branch for context.
4. Select an approach (e.g. "fix up existing work").
   - The proposed goal references the old branch name and PR (if applicable).
5. Create the goal.
   - New goal is created with the selected approach.
   - If "fix up," the new goal branch starts from the old goal branch tip.

**Coverage:** None (not yet automated).

---

## G-11: Dismiss a goal proposal

**Preconditions:** Goal assistant session is open, the agent has called `propose_goal`, and a preview form is visible in chat.

**Steps and expectations:**
1. Review the preview form showing title, spec, and workflow.
   - "Create Goal" and "Dismiss" buttons are both visible.
2. Click "Dismiss".
   - The preview form disappears from chat immediately.
   - No goal is created. Sidebar does not change.
3. The assistant session remains open and responsive.
   - Type a new message (e.g. "Actually, let's focus on performance instead").
   - The assistant responds and can propose a new, different goal.
4. The assistant proposes a second goal.
   - A new preview form appears with different title/spec.
   - "Create Goal" and "Dismiss" buttons are available again.
5. Click "Create Goal" on the second proposal.
   - Goal is created successfully. Only the second proposal becomes a goal.

**Coverage:** goal-proposal-dismiss.spec.ts (dismiss flow), goal-creation.spec.ts (dismiss button)

---

## G-12: Goal survives gateway crash and restart

**Preconditions:** A goal exists with a running team (team lead + at least one spawned agent). At least one gate has been signaled and passed.

**Steps and expectations:**
1. Verify pre-crash state: goal in sidebar, dashboard shows team agents, at least one gate shows `passed`.
2. Kill the gateway process (simulate crash).
   - All WebSocket connections drop. UI shows "Disconnected" or reconnecting indicator.
3. Gateway restarts (via harness or manual restart).
   - Server reads `sessions.json` and goal state from `.bobbit/state/`.
4. Reload the page (or wait for WebSocket reconnection).
   - Goal reappears in the sidebar under the correct project.
5. Open the goal dashboard.
   - Title, spec, and workflow are intact.
   - Gate statuses are preserved — the previously passed gate still shows `passed`.
   - Team agent sessions are listed (restored from `sessions.json`).
6. Click a team agent session in the sidebar.
   - Session loads with its full message history (from the `.jsonl` file).
   - Agent can resume work (or has already completed).
7. Crash the gateway during worktree setup (goal status is `preparing`).
   - After restart, goal status shows `error` (setup was interrupted).
   - "Retry" button is available on the dashboard.
   - Clicking "Retry" re-runs setup successfully.

**Coverage:** Manual integration tests (crash/restart resilience). Not in CI.
