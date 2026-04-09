# Team

## T-01: View team agents on dashboard

**Preconditions:** Goal with team started.

**Steps:**
1. Navigate to goal dashboard
2. View team/agents section

**Expected:**
- All team agents listed with role, status, branch
- Active agents show "streaming" or "idle"
- Terminated agents show "terminated"
- Can click agent to navigate to its session

**Coverage:** `tests/e2e/ui/team-lifecycle-ui.spec.ts` — partial.

---

## T-02: Navigate to team agent session

**Preconditions:** Team agent exists.

**Steps:**
1. On dashboard, click agent name/link
2. Session view opens

**Expected:**
- Agent's chat messages visible
- Context bar shows agent's model
- Can send follow-up messages to agent
- Back button returns to dashboard

**Coverage:** None — navigation to agent session untested from dashboard.

---

## T-03: Dismiss a team agent

**Preconditions:** Team agent exists, idle.

**Steps:**
1. On dashboard, click dismiss button for agent
2. Confirm if prompted

**Expected:**
- Agent session terminated
- Agent disappears from team list (or shows terminated)
- Agent's worktree cleaned up
- Other agents unaffected

**Coverage:** `tests/e2e/ui/team-lifecycle-ui.spec.ts` — "dismiss agent".

---

## T-04: Abort entire team

**Preconditions:** Goal with multiple agents running.

**Steps:**
1. Click "Abort" on goal dashboard
2. Confirm

**Expected:**
- All agent sessions terminated
- All worktrees cleaned up
- Goal status reflects abort
- Dashboard shows no active agents

**Coverage:** `tests/e2e/team-abort.spec.ts` (API-level). No UI test.

---

## T-05: Complete team (merge and finish)

**Preconditions:** All work done, review gate passed.

**Steps:**
1. Click "Complete" on goal dashboard

**Expected:**
- All agents dismissed
- Worktrees cleaned up
- Goal marked complete
- PR created (if configured)

**Coverage:** None — team completion flow untested in UI.

---

## T-06: Steer a running agent

**Preconditions:** Agent is mid-turn (streaming).

**Steps:**
1. Navigate to agent session
2. Type a steer message
3. Send while agent is still working

**Expected:**
- Steer message injected into agent's conversation
- Agent acknowledges and adjusts behavior
- Both the steer and the agent's response visible in chat

**Coverage:** `tests/e2e/steer-midturn.spec.ts` (API-level), `tests/e2e/team-steer-prompt.spec.ts` (API). No UI test.

---

## T-07: Send follow-up prompt to idle agent

**Preconditions:** Team agent exists, idle.

**Steps:**
1. Navigate to agent session via dashboard
2. Type a follow-up message
3. Send

**Expected:**
- Message sent to agent
- Agent processes and responds
- Response visible in chat

**Coverage:** None — follow-up to team agent via UI untested.

---

## T-08: Team agent git handoff

**Preconditions:** Agent has completed a task with commits.

**Steps:**
1. Agent sets headSha on task completion
2. Team lead merges agent's branch

**Expected:**
- Task shows baseSha, headSha, branch
- Merge succeeds
- Changes visible on goal branch

**Coverage:** `tests/e2e/task-git-fields.spec.ts` (API-level). No UI test.
