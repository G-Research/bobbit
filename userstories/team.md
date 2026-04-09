# Team Management — User Stories

## T-01: View team agents on dashboard

**Preconditions:** Goal with team started.

**Steps:**
1. Open the goal dashboard.

**Expected:**
- All agents listed with their role, status, and branch.
- Each agent is clickable to navigate to its session.

**Coverage:** Partial.

---

## T-02: Navigate to team agent session

**Preconditions:** Team agent exists.

**Steps:**
1. Click an agent on the dashboard.

**Expected:**
- The agent's chat opens showing its messages.
- Can send follow-up messages to the agent.
- Back button returns to the dashboard.

**Coverage:** None.

---

## T-03: Dismiss a team agent

**Preconditions:** Team agent exists.

**Steps:**
1. Click dismiss on the dashboard.

**Expected:**
- The agent's session ends.
- The agent's worktree is cleaned up.
- Other agents are unaffected.

**Coverage:** Partial.

---

## T-04: Abort entire team

**Preconditions:** Goal with agents running.

**Steps:**
1. Click Abort on the dashboard.
2. Confirm the action.

**Expected:**
- All agents are terminated.
- All worktrees are cleaned up.
- Dashboard shows no active agents.

**Coverage:** API-level only.

---

## T-05: Complete team

**Preconditions:** All work done, review gate passed.

**Steps:**
1. Click Complete on the dashboard.

**Expected:**
- Only works if the review gate has passed.
- All agents are dismissed and worktrees cleaned up.
- Goal is marked complete.

**Coverage:** None.

---

## T-06: Steer a running agent

**Preconditions:** Agent is mid-turn.

**Steps:**
1. Navigate to the agent's session.
2. Type a steer message.
3. Send while the agent is working.

**Expected:**
- The message is injected into the agent's conversation.
- The agent adjusts its behavior based on the steer.
- Both the steer and the agent's continued response are visible in chat.

**Coverage:** API-level only.

---

## T-07: Send follow-up to idle agent

**Preconditions:** Team agent is idle.

**Steps:**
1. Navigate to the agent via the dashboard.
2. Send a message.

**Expected:**
- The agent processes the message and responds.
- The response is visible in chat.

**Coverage:** None.

---

## T-08: Git handoff between agents

**Preconditions:** Agent completed a task with commits.

**Steps:**
1. Agent finishes its work.
2. Team lead merges the agent's branch.

**Expected:**
- The agent's commits are on its branch.
- The team lead can merge the branch.
- In sandbox mode, commits are pushed automatically for durability.

**Coverage:** API-level only.
