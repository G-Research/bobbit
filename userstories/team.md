# Team Management — User Stories

## T-01: View team agents on dashboard

**Preconditions:** Goal with team started.

**Steps:**
1. Navigate to goal dashboard.
2. View team section.

**Expected:**
- All agents listed with role label, status (idle/streaming/terminated), branch name, worktree path, and session link.
- Click agent navigates to session view.

**Coverage:** Partial.

---

## T-02: Navigate to team agent session

**Preconditions:** Team agent exists.

**Steps:**
1. Click agent name/link on dashboard.

**Expected:**
- Navigates to `#/session/<agentSessionId>`.
- Agent's chat messages visible.
- Context bar shows agent model.
- Can send follow-up messages via `team_prompt`.
- Back button returns to dashboard.

**Coverage:** None.

---

## T-03: Dismiss a team agent

**Preconditions:** Team agent exists.

**Steps:**
1. Click dismiss on dashboard.

**Expected:**
- Agent session terminated.
- Worktree cleaned up (git worktree remove + branch delete).
- Agent removed from team state.
- Other agents unaffected.
- `team-state.json` updated.

**Coverage:** Partial.

---

## T-04: Abort entire team

**Preconditions:** Goal with agents running.

**Steps:**
1. Click Abort on dashboard.
2. Confirm.

**Expected:**
- All agent sessions terminated.
- All worktrees cleaned up.
- Goal status reflects abort.
- Dashboard shows no active agents.
- `team-state.json` updated.

**Coverage:** API-level only.

---

## T-05: Complete team

**Preconditions:** All work done, review gate passed (server enforces).

**Steps:**
1. Click Complete on dashboard.

**Expected:**
- Server requires review gate passed first (409 if not).
- All agents dismissed.
- Worktrees cleaned up.
- Goal marked complete.
- PR created if configured.

**Coverage:** None.

---

## T-06: Steer a running agent

**Preconditions:** Agent mid-turn (streaming).

**Steps:**
1. Navigate to agent session.
2. Type steer message.
3. Send while busy.

**Expected:**
- Steer message injected as user message into agent's conversation mid-turn.
- Agent sees it interleaved with current work.
- Both steer and response visible in chat.
- Use sparingly — prefer letting agents finish.

**Coverage:** API-level only.

---

## T-07: Send follow-up to idle agent

**Preconditions:** Team agent idle.

**Steps:**
1. Navigate via dashboard.
2. Type message.
3. Send.

**Expected:**
- `team_prompt` sends follow-up.
- Agent processes and responds.
- Supports `workflowGateId`/`inputGateIds` for context injection from upstream gates.

**Coverage:** None.

---

## T-08: Team agent git handoff

**Preconditions:** Agent completed task with commits.

**Steps:**
1. Agent sets `headSha` via `task_update`.
2. Team lead merges.

**Expected:**
- Task has `baseSha` (auto-set on spawn), `headSha` (set by agent on completion), `branch` (auto-set on spawn).
- Team lead runs `git merge <task.branch>`.
- In sandbox, agents use standard git worktrees inside container with post-commit hook that pushes to remote.

**Coverage:** API-level only.
