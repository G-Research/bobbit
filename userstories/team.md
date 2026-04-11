# Team Management — User Stories

Team management covers the goal dashboard's Agents tab, team lifecycle (spawn, dismiss, abort, complete), inter-agent communication (steer, prompt), sidebar nesting, and git handoff between agents.

---

## T-01: View team agents on the goal dashboard

**Preconditions:** A goal exists with `team: true`. The team lead has spawned at least two agents (one `coder`, one `reviewer`). Navigate to `#/goal/:id`.

**Steps and expectations:**
1. Open the goal dashboard and click the "Agents" tab.
   - The Agents tab shows a count badge matching the total number of agents (including team lead).
   - The team lead row appears first, with a `statusBobbit` icon, the session name, and a purple `LEAD` role tag.
   - Each spawned agent row shows: `statusBobbit` icon (reflecting `idle`/`streaming`/`compacting`/`aborting` state), session name, and a colored role tag (`CODER`, `REVIEWER`, etc.).
   - Role tag colors are distinct per role (e.g. coder uses a different hue than reviewer).
2. Observe an agent that is currently streaming.
   - Its `statusBobbit` icon animates (bouncing pixel art).
   - Its status text reflects the active state.
3. Observe a dismissed agent (if any).
   - A muted `Dismissed` tag appears next to the role tag (`background: var(--muted); color: var(--muted-foreground)`).
   - The row is still visible but visually de-emphasized.
4. Verify the agent count in the tab badge updates when agents are spawned or dismissed.
   - Spawn a new agent → badge increments.
   - Dismiss an agent → badge decrements (or the dismissed agent remains counted but marked).

**Coverage:** covered (team-lifecycle-ui.spec.ts — dashboard rendering, role tags, status icons)

---

## T-02: Navigate to a team agent's session

**Preconditions:** Goal dashboard is open with at least one active team agent visible in the Agents tab.

**Steps and expectations:**
1. Click an agent row on the dashboard.
   - The app navigates to `#/session/:agentSessionId`.
   - The agent's chat history loads, showing its system prompt summary, tool calls, and responses.
   - The message editor is visible and focused at the bottom.
2. Observe the session header or breadcrumb.
   - It indicates this session belongs to the goal (goal title or back-link visible).
3. Click the back button or the goal breadcrumb link.
   - The app navigates back to `#/goal/:id` (the goal dashboard).
   - The Agents tab is still selected, showing the same agent list.
4. Click the team lead row.
   - Navigates to the team lead's session, which shows the orchestration messages (spawn commands, merge operations, etc.).

**Coverage:** covered (team-lifecycle-ui.spec.ts — agent row click, navigation)

---

## T-03: Dismiss a single team agent

**Preconditions:** Goal dashboard open, at least two active agents besides the team lead.

**Steps and expectations:**
1. Locate the dismiss button (X or trash icon) on a coder agent's row.
   - The button is visible on hover or always present (depending on viewport).
2. Click the dismiss button.
   - The agent's session is terminated (status changes to `idle` or disappears from active list).
   - A `Dismissed` tag appears on the agent's row (`background: var(--muted); color: var(--muted-foreground)`).
   - The agent's git worktree is cleaned up on the server (no stale worktree directory remains).
3. Verify other agents are unaffected.
   - The reviewer agent is still active and streaming/idle as before.
   - The team lead session continues running.
4. Attempt to send a message to the dismissed agent's session.
   - The session is no longer interactive — the editor is disabled or the session is marked as ended.
5. Refresh the page.
   - The dismissed agent still shows as dismissed (state persists via server).

**Coverage:** partial (team-lifecycle-ui.spec.ts — dismiss flow; team-abort.spec.ts — API validation)

---

## T-04: Abort the entire team

**Preconditions:** Goal with a team lead and at least two active agents. Goal dashboard is open.

**Steps and expectations:**
1. Click the "Abort" button on the goal dashboard.
   - A confirmation dialog or prompt appears (destructive action guard).
2. Confirm the abort action.
   - All agent sessions are terminated simultaneously.
   - All agent worktrees are cleaned up.
   - The team lead session is also terminated.
   - Dashboard transitions to show no active agents — all rows show dismissed/aborted state.
3. Verify via the sidebar.
   - The goal's nested sessions are all marked as ended.
   - No active streaming indicators remain.
4. Attempt to spawn a new agent after abort.
   - The goal is in an aborted state — spawning is rejected (server returns an error).
5. Non-team sessions (standalone sessions, other goals) are completely unaffected by the abort.

**Coverage:** covered (team-abort.spec.ts — API abort, membership enforcement, stuck-agent abort, swarm compat)

---

## T-05: Complete the team and mark goal done

**Preconditions:** Goal with team. All tasks are complete. The review gate has passed (status: `passed`). Goal dashboard is open.

**Steps and expectations:**
1. Click the "Complete" button on the goal dashboard.
   - The server validates that the review gate has passed.
   - All remaining active agents are dismissed.
   - All agent worktrees are cleaned up.
   - The goal state transitions to `complete`.
2. Observe the dashboard after completion.
   - Goal status shows "Complete" (green indicator or badge).
   - No active agent rows remain.
   - The Agents tab count is 0 or shows all agents as dismissed.
3. Attempt to complete a goal where the review gate has NOT passed.
   - The server rejects the request (HTTP 409 or similar).
   - An error message appears: the review gate must pass before completing.
   - No agents are dismissed; the goal remains in its current state.
4. After completion, the goal appears in the sidebar's archived/completed section (if archived).
   - Clicking it still shows the dashboard with read-only historical data.

**Coverage:** partial (team-lifecycle-ui.spec.ts — complete button; gate dependency enforcement tested in gates-api.spec.ts)

---

## T-06: Steer a running team agent mid-turn

**Preconditions:** A team agent (coder) is actively streaming a response (mid-turn). The agent's session is open in the chat view.

**Steps and expectations:**
1. Type a redirect message in the textarea while the agent is streaming.
   - The textarea is editable during streaming (not disabled).
   - The Send button shows as a Stop button, but typing switches context to steer mode.
2. Press Enter to send the steer.
   - The message is queued as a steer pill below the textarea with amber styling (`bg-amber-500/10 border-amber-500/30`) and a Zap icon.
   - The steer is delivered to the agent at the next tool boundary (not mid-token).
3. Observe the agent's behavior after receiving the steer.
   - The agent's partial response remains visible in chat.
   - The steer message appears as a user turn, visually marked as a steer.
   - The agent adjusts its work based on the steer content.
   - The agent's new response follows the steer in chronological order.
4. The steer pill updates to show "Sent" (Zap icon + "Sent" text in amber) once dispatched.
   - Dispatched steer pills are not draggable, editable, or removable.
5. Send a second steer before the first is acknowledged.
   - Both steers are batched and delivered together at the next tool boundary.
   - No steers are dropped or lost.
6. Steer via the team lead (using `team_steer` tool) instead of navigating to the agent's session.
   - The steer is delivered identically — agent sees it as a user message interleaved with its current work.

**Coverage:** covered (team-steer-prompt.spec.ts — API validation, membership enforcement, steer status 409; queue-ui.spec.ts — UI steer pills)

---

## T-07: Send a follow-up prompt to an idle team agent

**Preconditions:** A team agent has finished its initial task and is idle (not streaming). The agent's session is open.

**Steps and expectations:**
1. Type a follow-up message in the textarea (e.g. "Now add unit tests for the module you just created").
2. Press Enter to send.
   - The message appears as a user turn in the agent's chat.
   - The agent begins processing the new request (status transitions from idle to streaming).
   - The Send button transitions to a Stop button while the agent works.
3. The agent completes the follow-up task.
   - New tool calls and responses appear in chat below the follow-up message.
   - The agent returns to idle state.
4. Send the follow-up via the team lead (using `team_prompt` tool) without navigating to the agent's session.
   - The prompt is queued and delivered to the agent.
   - The agent processes it identically to a direct message.
5. Send a follow-up to a dismissed agent.
   - The server rejects the request — dismissed agents cannot receive prompts.
   - An error message or disabled state prevents sending.

**Coverage:** covered (team-steer-prompt.spec.ts — prompt dispatch, membership enforcement, validation)

---

## T-08: Team sessions nest under their goal in the sidebar

**Preconditions:** A goal exists with a team lead and two spawned agents. The sidebar is visible.

**Steps and expectations:**
1. Observe the sidebar goal section.
   - The goal appears as a collapsible group in the sidebar.
   - The team lead session appears first under the goal.
   - Spawned agent sessions appear indented below the team lead.
   - Each session shows its role icon and name.
2. Click a team agent's session entry in the sidebar.
   - The app navigates to `#/session/:agentSessionId` (same as clicking from dashboard).
3. Click the goal entry itself (not a session).
   - The app navigates to the goal dashboard (`#/goal/:id`).
4. Team sessions do NOT appear in the ungrouped sessions list.
   - Sessions with `teamGoalId` or `goalId` set are filtered out of the standalone list.
5. Collapse the goal group in the sidebar.
   - All nested team sessions are hidden.
   - Expand again — they reappear in the same order.
6. When an agent is dismissed, its session entry in the sidebar reflects the ended state (muted styling or removal).

**Coverage:** covered (team-lifecycle-ui.spec.ts — sidebar nesting, session filtering)

---

## T-09: Git handoff between team agents

**Preconditions:** A coder agent has completed its task and made commits on its worktree branch. The team lead is active and ready to merge.

**Steps and expectations:**
1. The coder agent completes its task and updates the task with `state: "complete"` and a `result` containing the work summary.
   - The task record includes `baseSha` (branch point), `headSha` (tip of agent's work), and `branch` (agent's worktree branch name).
2. The team lead inspects the completed task via `task_list`.
   - The task shows `state: "complete"` with the git handoff fields (`baseSha`, `headSha`, `branch`).
3. The team lead merges the agent's branch into the goal branch.
   - The merge uses the `baseSha`/`headSha` range to cherry-pick or merge the agent's commits.
   - Merge conflicts (if any) are resolved by the team lead.
4. After a successful merge, the team lead dismisses the coder agent.
   - The agent's worktree is cleaned up.
   - The merged commits are now on the goal branch.
5. A second agent (reviewer) can now see the merged code on the goal branch.
   - The reviewer's worktree is rebased or updated to include the merged commits.
6. In sandbox mode, the agent's commits are pushed automatically for durability before handoff.
   - No commits are lost even if the container is recycled.

**Coverage:** partial (team-abort.spec.ts — worktree cleanup; git handoff fields tested via API in goals-workflows integration)

---

## T-10: Team auto-starts after goal setup completes

**Preconditions:** A new goal is created with `team: true` and a workflow that includes a setup gate. The setup gate has not yet passed.

**Steps and expectations:**
1. The goal is created and the dashboard shows "Setting up…" or a pending setup indicator.
   - No team agents are spawned yet — the setup gate blocks team start.
   - The Agents tab shows 0 agents (or just the team lead in a waiting state).
2. The setup gate passes (e.g. project detection completes, dependencies installed).
   - The team lead session is automatically created (or transitions from waiting to active).
   - The team lead begins reading the goal spec and spawning agents based on the workflow.
3. The team lead spawns agents according to the goal spec.
   - Agent rows appear on the dashboard as they are created.
   - Each agent starts working on its assigned task immediately after worktree setup.
4. If setup fails (gate status: `failed`):
   - No agents are spawned.
   - The dashboard shows the setup failure with error details.
   - The user can retry or fix the setup issue and re-trigger.
5. Navigate away from the dashboard during setup and return after completion.
   - The dashboard shows the fully started team — no manual refresh needed (WebSocket push updates the UI).

**Coverage:** partial (team-lifecycle-ui.spec.ts — team start after setup; gate dependency enforcement in gates-api.spec.ts)
