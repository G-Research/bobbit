# Goal Management — User Stories

## G-01: Create a goal via assistant

**Preconditions:** Project registered.

**Steps:**
1. Click "New Goal" in the sidebar.
2. An assistant session opens with an auto-prompt.
3. Type a description (or the `GOAL_PROPOSAL` keyword in test environments).
4. The agent calls the `propose_goal` tool with:
   - `title`: 2–5 words, under 29 characters
   - `spec`: Markdown content
   - `workflow`: a workflow ID (e.g. `"general"`)
   - `options`: comma-separated optional step names
5. A preview form appears in the right panel with editable fields.
6. Review and edit the title, spec, workflow, and optional step toggles.
7. Click "Create Goal".

**Expected:**
- `POST /api/goals` is called with the form fields.
- The goal appears in the sidebar under the project folder.
- The browser navigates to the goal dashboard (`#/goal/<id>`).
- The assistant session is terminated.
- Workflow gates are created per the selected workflow (snapshotted from the config cascade).
- Optional steps reflect the toggles (`enabledOptionalSteps` array).
- A goal branch is created as `goal/<sanitized-title-10chars>-<uuid8>`.

**Coverage:** Covered.

---

## G-02: Create a goal via API

**Preconditions:** Project registered.

**Steps:**
1. `POST /api/goals` with body containing:
   - `title` (required)
   - `spec` (required)
   - `workflowId` (default `"general"`)
   - `sandboxed` (optional boolean)
   - `autoStartTeam` (default `true`)
   - `enabledOptionalSteps` (optional array)
   - `projectId` (optional)

**Expected:**
- Goal is created with `setupStatus: "preparing"`.
- Gates are created per the specified workflow.
- Worktree setup runs asynchronously (does not block the response).
- The goal appears in the sidebar on the next refresh.

**Coverage:** Covered.

---

## G-03: Goal worktree setup

**Preconditions:** Goal created; project root is inside a git repo.

**Steps:**
1. Goal is created.
2. Server runs `setupWorktree` asynchronously.
3. Poll `setupStatus` via `GET /api/goals/:id`.

**Expected:**
- `setupStatus` transitions from `"preparing"` → `"ready"`.
- A goal branch exists at `goal/<title-slug>-<uuid8>`.
- A worktree directory is created at `<repo>-wt-goal/<branch-hyphened>`.
- `worktree_setup_command` runs if configured in `project.yaml`.
- On failure, retries once after a 1-second delay.
- If both attempts fail, `setupStatus` becomes `"error"` with a message.
- CWD offset is applied if the project root is a subdirectory of the git repo.
- `_setupsInFlight` prevents concurrent setup for the same goal.

**Coverage:** API-level.

---

## G-04: Team auto-start

**Preconditions:** Goal created with `autoStartTeam: true` (the default).

**Steps:**
1. Worktree setup completes successfully.
2. Server calls `GoalManager.setupWorktreeAndStartTeam()`.

**Expected:**
- A team lead session is created with the team tools extension.
- `teamLeadSessionId` is set on the goal.
- The team lead appears in the sidebar.
- The goal dashboard shows a team section.
- The team lead receives role `"team-lead"` with the team prompt template (goal branch, agent ID, and available roles injected).

**Coverage:** Partial.

---

## G-05: Goal dashboard overview

**Preconditions:** Goal exists.

**Steps:**
1. Click the goal in the sidebar.

**Expected:**
- URL becomes `#/goal/<id>`.
- A loading animation displays during the fetch.
- Title and spec are visible.
- Setup status badge shows one of: `preparing`, `ready`, or `error` (with a "Retry" button).
- Team section lists agents with role, status, and branch.
- PR status shown if the branch has been pushed (link, state badge, CI status, mergeable indicator).
- Last activity timestamp is displayed.

**Coverage:** Partial.

---

## G-06: Goal dashboard gates tab

**Preconditions:** Goal has an associated workflow.

**Steps:**
1. Navigate to the goal dashboard.
2. Click the "Gates" tab.

**Expected:**
- All gates are listed with status (`pending`, `passed`, or `failed`).
- Dependencies between gates are shown.
- The "Signal" button is enabled only for eligible gates (all upstream dependencies must be `passed`; server enforces this with HTTP 409).
- Passed gates show green with a content preview.
- Failed gates show red with a link to the verification output.
- Gates currently being verified show a progress indicator.

**Coverage:** Partial.

---

## G-07: Signal a gate

**Preconditions:** Gate is eligible (all upstream dependencies have `passed` status).

**Steps:**
1. Navigate to the gates tab.
2. Enter content (Markdown).
3. Click "Signal".

**Expected:**
- `POST /api/goals/:id/gates/:gateId/signal` is called with `content` and `metadata`.
- Gate status transitions to `"verifying"`.
- Verification runs asynchronously in phases (phase 1 steps run in parallel, then phase 2, etc.).
- Output streams via the `/ws/viewer` WebSocket.
- On pass: gate shows `passed`.
- On fail: gate shows `failed` with verification output.
- Downstream gates become eligible.
- Zombie verifications (all reviewer sessions dead) are auto-cancelled on re-signal.

**Coverage:** Partial.

---

## G-08: Cancel verification

**Preconditions:** A verification is currently running.

**Steps:**
1. Open the verification output modal.
2. Click "Cancel".

**Expected:**
- `POST /api/goals/:id/gates/:gateId/cancel-verification` is called.
- The verification stops.
- The gate reverts to its previous status.
- The modal shows a cancellation indicator.
- The gate can be re-signaled.

**Coverage:** Covered.

---

## G-09: Goal with sandbox

**Preconditions:** Docker is available; `sandbox: "docker"` is set in `project.yaml`.

**Steps:**
1. Create a goal with the sandbox toggle enabled.

**Expected:**
- A per-project container is created or reused (labeled `bobbit-project=<projectId>`).
- The worktree is created inside the container at `/workspace-wt/<name>`.
- Team agents execute commands via `docker exec`.
- Git status works through container exec.
- Named volumes provide persistence:
  - `bobbit-workspace-<projectId>` → `/workspace`
  - `bobbit-worktrees-<projectId>` → `/workspace-wt`

**Coverage:** Manual only.

---

## G-10: Re-attempt a failed goal

**Preconditions:** A previous goal has failed or been abandoned.

**Steps:**
1. Open a new goal assistant.
2. The system detects `reattemptGoalId` from context.
3. Previous goal context is injected into the assistant.

**Expected:**
- The assistant receives the previous goal's title, branch, PR URL, workflow, and spec.
- Three approaches are offered: revert & fresh, fix up, or revert & fix up.
- The assistant composes a new spec incorporating the original spec, failure details, and the chosen approach.

**Coverage:** None.

---

## G-11: Dismiss goal proposal

**Preconditions:** The assistant has proposed a goal (preview form is visible).

**Steps:**
1. Click "Dismiss" on the preview form.

**Expected:**
- The proposal is dismissed.
- The assistant session continues (it is **not** terminated).
- `state.activeGoalProposal` is cleared.
- The user can request a new proposal from the assistant.
- Deduplication by `tool_use` block ID prevents re-fires on reconnect.

**Coverage:** Covered.

---

## G-12: Goal survives gateway crash

**Preconditions:** A goal with a running team exists.

**Steps:**
1. The gateway process crashes.
2. The gateway restarts.

**Expected:**
- `goals.json` is persisted to disk before the crash.
- The goal appears in the sidebar after restart.
- The goal dashboard loads successfully.
- Gate statuses are preserved.
- Team sessions are restored from `sessions.json`.
- Goals stuck in `setupStatus: "preparing"` at restart are marked as `"error"`.

**Coverage:** Manual only.
