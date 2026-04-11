# Goal Dashboard — User Stories

The goal dashboard is the command centre for a running goal. It shows setup status, workflow gates, team agents, tasks, PR status, and verification output. These stories cover every interactive element on the dashboard.

---

## D-01: Dashboard loads on goal click

**Preconditions:** At least one goal exists in the sidebar. No dashboard is currently displayed.

**Steps and expectations:**
1. Click a goal in the sidebar.
   - The Bobbit loading animation appears immediately in the main content area.
   - No stale data from a previously viewed goal flashes before the animation.
2. Dashboard data arrives.
   - Loading animation clears.
   - Goal title is displayed prominently at the top.
   - Goal spec (markdown) renders below the title.
3. Observe the setup status indicator.
   - If setup is "preparing", a spinner or progress indicator is shown and the dashboard polls for updates.
   - If setup is "ready", a green/success indicator is shown and all sections are interactive.
   - If setup is "error", a red/error indicator is shown with a "Retry Setup" button.
4. Observe the team section.
   - If no team has been started, the section shows an empty state or "Start Team" prompt.
   - If agents are running, agent cards are visible with role and status.
5. Observe the gates section.
   - Gates are listed or accessible via a tab.
   - Each gate shows its current status (pending, passed, failed, verifying).
6. Navigate to a different goal in the sidebar.
   - Loading animation appears again (no stale data from the first goal).
   - New goal's title, spec, and status replace the previous dashboard content.
7. Navigate to the dashboard via deep link (direct URL with goal ID).
   - Dashboard loads identically to sidebar click — title visible, sections populated.

**Coverage:** navigation.spec.ts (goal title visible via deep link), goal-dashboard-setup-poll.spec.ts (setup polling unit test)

---

## D-02: Dashboard tabs switch content

**Preconditions:** Dashboard loaded for a goal with gates, team agents, and tasks.

**Steps and expectations:**
1. Observe the tab bar at the top of the dashboard.
   - Three tabs are visible: Overview, Gates/Workflow, and Team/Agents.
   - One tab is active by default (Overview) with a visually distinct highlight (e.g. underline, bold, or background).
2. Click the Gates/Workflow tab.
   - Tab content switches to show the gates list and workflow visualization.
   - The Gates/Workflow tab is now visually highlighted as active.
   - The Overview tab is no longer highlighted.
3. Click the Team/Agents tab.
   - Tab content switches to show agent cards with roles, statuses, and session links.
   - Team/Agents tab is highlighted; other tabs are not.
4. Click the Overview tab.
   - Content returns to the overview (title, spec, setup status, summary).
   - Overview tab is highlighted again.
5. Navigate away from the dashboard (e.g. click a session in the sidebar) and navigate back.
   - Dashboard reloads and the tab resets to the default (Overview), not the previously selected tab.
6. Click the same tab that is already active.
   - Nothing changes. No flicker, no reload, no error.

**Coverage:** none — needs UI E2E test for tab switching

---

## D-03: Gate status display on Gates tab

**Preconditions:** Goal with workflow containing gates in various states: at least one pending, one passed, one failed, and one verifying.

**Steps and expectations:**
1. Click the Gates/Workflow tab.
   - Gates are listed in dependency order (upstream gates appear before downstream gates).
2. Observe a pending gate.
   - Shows a neutral/grey status indicator.
   - No timestamp or content preview.
   - Signal button is enabled only if all upstream dependencies have passed.
3. Observe a passed gate.
   - Shows a green status indicator.
   - Displays a timestamp of when it passed.
   - Content preview or summary is visible (truncated if long).
4. Observe a failed gate.
   - Shows a red status indicator.
   - Displays a link to view the verification output.
   - Failed step summary or error snippet is visible.
5. Observe a verifying gate.
   - Shows a spinner or animated indicator.
   - Phase info is displayed (e.g. "Running step 2 of 5").
   - Signal button is disabled while verification is in progress.
6. Observe a gate whose upstream dependencies have NOT all passed.
   - Signal button is disabled (greyed out, no pointer cursor).
   - A tooltip or label explains why signalling is blocked (e.g. "Waiting on: upstream-gate").
7. Click the Signal button on an eligible gate (all upstream passed).
   - Signal is sent. Gate transitions to "verifying" state with a spinner.
   - No page reload required — the UI updates in place.

**Coverage:** gates-api.spec.ts (gate CRUD and signal API), gate-store-logic.test.ts (dependency ordering)

---

## D-04: Verification output viewer

**Preconditions:** A gate has a completed or in-progress verification (at least one step has run).

**Steps and expectations:**
1. Click "View Output" on a gate with verification results.
   - A modal or panel opens showing verification steps in order.
   - Each step shows: step name, status indicator (pass ✓, fail ✗, skip ⊘, running spinner).
2. For a running verification, observe real-time streaming.
   - Output text streams in as the verification command produces it (WebSocket-driven).
   - The currently running step shows a spinner and the output area auto-scrolls.
3. For completed steps, observe status badges.
   - Passed steps show a green "pass" badge.
   - Failed steps show a red "fail" badge with the output visible (last N lines).
   - Skipped steps show a muted "skip" badge.
4. While verification is running, observe the Cancel button.
   - Cancel button is visible and enabled.
   - Click Cancel — verification terminates, gate status transitions to "failed" or "cancelled".
   - Confirmation dialog may appear before cancellation proceeds.
5. Close the modal and reopen it.
   - Same verification state is shown (output is not lost).
   - For completed verifications, the full output is displayed immediately (no re-streaming).
6. Click "View Output" on a gate that has never been signalled.
   - Modal either does not open or shows an empty state ("No verification output").

**Coverage:** gate-verification-ux.spec.ts (verification viewer WS, session link navigation), cancel-verification.spec.ts (cancel flow API)

---

## D-05: PR status display

**Preconditions:** Goal branch has been pushed to a remote. A pull request exists on the remote (GitHub/GitLab).

**Steps and expectations:**
1. View the dashboard overview or PR section.
   - A PR link is displayed (clickable, opens the remote PR page).
   - PR number and title are shown.
2. Observe the PR status badge.
   - Badge shows the current state: "open" (green), "draft" (grey), "merged" (purple), or "closed" (red).
3. Observe CI check status.
   - CI checks are listed with pass/fail/pending indicators.
   - Overall CI status (all passing, some failing, pending) is summarized.
4. Observe the mergeable and review status.
   - Mergeable indicator shows whether the PR can be merged (no conflicts, checks passing).
   - Review status shows: approved, changes requested, or pending review.
5. Observe the Merge button.
   - Visible if the user has merge permission and the PR is mergeable.
   - Disabled if CI checks are failing or reviews are pending (depends on repo settings).
6. Wait for a CI check to complete on the remote.
   - PR status refreshes periodically (polling or cache-bust mechanism) — updated status appears without manual reload.
7. Navigate away from the dashboard and back.
   - PR status is fresh (re-fetched, not showing stale cached data).

**Coverage:** pr-cache.spec.ts (PR cache API, cache-bust endpoint)

---

## D-06: Dashboard live updates via WebSocket

**Preconditions:** Goal with an active team. Dashboard is open. An agent is actively working on a task.

**Steps and expectations:**
1. View the dashboard while an agent completes a task in the background.
   - Agent status updates from "active" to "idle" or "complete" without page refresh.
   - The team section reflects the change in real time.
2. An agent signals a gate in the background.
   - Gate status transitions from "pending" to "verifying" on the dashboard without refresh.
   - Verification progress (spinner, phase info) appears live.
3. Verification completes (pass or fail).
   - Gate status transitions from "verifying" to "passed" (green) or "failed" (red) without refresh.
   - Timestamp and output link appear automatically.
4. A new agent is spawned by the goal assistant.
   - A new agent card appears in the Team section without refresh.
5. An agent is dismissed.
   - The agent card updates to show "dismissed" or "exited" state without refresh.
   - No stale "active" indicator remains.
6. Leave the dashboard open for several minutes with no activity.
   - No errors accumulate. WebSocket connection remains healthy.
   - When activity resumes, updates appear immediately.

**Coverage:** none — needs UI E2E test with mock agent activity and WS assertions

---

## D-07: Navigate to agent session and back

**Preconditions:** Goal with at least one team agent that has an active session.

**Steps and expectations:**
1. On the dashboard Team tab, identify an agent with a session link.
   - Agent card shows the agent's role, status, and a clickable link to view its session.
2. Click the agent session link.
   - Session view loads. Chat messages from the agent's session are visible.
   - The session's message editor and context bar are functional.
3. Click the browser back button (or a "Back to Dashboard" link).
   - Dashboard loads again for the same goal.
   - Dashboard data is fresh (re-fetched, not a cached snapshot from before navigation).
   - The tab that was active before navigation may reset to Overview.
4. Click the agent session link again.
   - Session loads again. No duplicate session is created.
5. Click an agent that has been dismissed (session ended).
   - Session loads in read-only or archived mode — past messages are visible.
   - No error or blank screen.

**Coverage:** team-lifecycle-ui.spec.ts (start team, navigate to member, teardown), navigation.spec.ts (goal deep link), back-button-goal.spec.ts (back navigation)

---

## D-08: Retry goal setup after failure

**Preconditions:** Goal exists with setup status "error" (initial setup failed). Dashboard is showing the error state.

**Steps and expectations:**
1. Observe the error state on the dashboard.
   - Setup status shows "error" with a red indicator.
   - An error message or summary is visible.
   - A "Retry Setup" button is visible.
2. Click "Retry Setup".
   - Setup status transitions from "error" to "preparing" with a spinner.
   - The "Retry Setup" button is disabled or hidden during the retry.
3. Setup completes successfully.
   - Status transitions from "preparing" to "ready" with a green indicator.
   - All dashboard sections (gates, team, tasks) become interactive.
   - No leftover error messages from the previous failure.
4. Click "Retry Setup" again (setup fails a second time).
   - Status transitions: "error" → "preparing" → "error".
   - Error message updates to reflect the new failure (not the old one).
   - "Retry Setup" button reappears.
5. Retry setup where the previous failure left partial state (e.g. half-created workflow gates).
   - The retry handles partial state gracefully — no duplicate gates, no orphaned resources.
   - The result is identical to a fresh setup.

**Coverage:** goal-dashboard-setup-poll.spec.ts (setup polling transitions), goal-dashboard-setup-poll-repro.spec.ts (pre-fix behavior)

---

## D-09: Tasks view with details

**Preconditions:** Goal with multiple tasks in various states (todo, in-progress, complete, blocked, skipped). At least one task is assigned to an agent.

**Steps and expectations:**
1. Navigate to the tasks section (may be a sub-tab or part of Overview).
   - Tasks are listed in a structured layout (table or card grid).
2. Observe task metadata for each task.
   - Type is displayed (implementation, code-review, testing, bug-fix, refactor, custom).
   - Status is displayed with a visual indicator (todo: grey, in-progress: blue, complete: green, blocked: red, skipped: muted).
   - Assignee is shown (agent name/role or "Unassigned").
3. Observe task dependencies.
   - Dependencies are listed (e.g. "Depends on: task-2, task-3").
   - Blocked tasks clearly indicate which dependency is unmet.
4. Observe task spec and result.
   - Task spec (markdown) is visible or expandable.
   - Completed tasks show a result summary.
   - Tasks with no result show no result section (not an empty placeholder).
5. Observe git branch info per task.
   - Tasks with git handoff data show the branch name (e.g. `goal/my-feature/task-1`).
   - Branch info includes base SHA and head SHA if available.
6. Click on a task to expand or view details.
   - Full spec, result, and git info are visible.
   - Agent session link is clickable (navigates to the agent's session).
7. Tasks update in real time as agents complete work.
   - Status transitions (in-progress → complete) appear without page refresh.

**Coverage:** gates-api.spec.ts (task CRUD via API), team-manager.test.ts (task assignment logic)

---

## D-10: Loading and error states

**Preconditions:** Goal exists (or does not exist, for error case).

**Steps and expectations:**
1. Navigate to a goal dashboard for the first time.
   - Bobbit loading animation appears in the content area.
   - No partial or broken UI is visible during loading.
   - Animation is smooth (pixel-art bouncing mascot).
2. Dashboard data loads successfully.
   - Animation clears and is fully replaced by dashboard content.
   - No animation remnant or flicker remains.
   - Transition from loading to loaded is clean (no layout shift).
3. Navigate to a dashboard with a non-existent goal ID (e.g. tampered URL hash).
   - Loading animation appears briefly.
   - Error message displays: "Goal not found" or similar.
   - No infinite spinner. No blank screen.
   - Sidebar remains functional — user can navigate elsewhere.
4. Navigate to a dashboard when the server is slow to respond.
   - Loading animation persists until data arrives (no premature timeout).
   - If the request fails (network error), an error message is shown.
5. Rapidly click between two different goals in the sidebar.
   - Only the last-clicked goal's dashboard loads (no race condition showing the wrong goal).
   - No interleaved data from both goals.

**Coverage:** goal-dashboard-setup-poll.spec.ts (setup polling unit test), navigation.spec.ts (deep link loading)
