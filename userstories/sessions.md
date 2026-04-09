# Sessions

## S-01: Create a new session

**Preconditions:** App loaded, at least one project registered.

**Steps:**
1. Click the "+" (New Session) button in the sidebar
2. Wait for session to appear in sidebar and textarea to be visible

**Expected:**
- New session appears in sidebar with a default title
- Session is selected (highlighted) in sidebar
- Main panel shows empty chat with textarea focused
- Context bar shows model name and provider
- Session status is `idle` via API

**Coverage:** `tests/e2e/ui/session-interactions.spec.ts` — "create and send message"

---

## S-02: Send a message and receive a response

**Preconditions:** Active session connected.

**Steps:**
1. Type a message in the textarea
2. Press Enter (or click Send)
3. Wait for response

**Expected:**
- User message appears in chat
- Agent response appears below user message
- Session status transitions: idle → streaming → idle
- Textarea is re-enabled after response
- Session title auto-updates if this is the first message

**Coverage:** `tests/e2e/ui/session-interactions.spec.ts` — "create and send message"

---

## S-03: Draft isolation across sessions

**Preconditions:** Two active sessions exist.

**Steps:**
1. Navigate to session A
2. Type "draft for A" in textarea (don't send)
3. Navigate to session B
4. Type "draft for B" in textarea (don't send)
5. Navigate back to session A
6. Navigate back to session B

**Expected:**
- Session A textarea shows "draft for A" on return
- Session B textarea shows "draft for B" on return
- Drafts never leak between sessions
- Drafts survive page reload (persisted to sessionStorage)

**Coverage:** None — draft isolation is untested.

---

## S-04: Terminate a session

**Preconditions:** Active session exists.

**Steps:**
1. Hover over session in sidebar
2. Click the X (terminate) button
3. Confirm if prompted

**Expected:**
- Session disappears from sidebar
- If session was selected, main panel shows landing or next session
- API confirms session is terminated/archived
- Worktree is cleaned up (if session had one)

**Coverage:** `tests/e2e/ui/session-interactions.spec.ts` — "terminate session"

---

## S-05: Switch between sessions

**Preconditions:** Multiple sessions exist with messages.

**Steps:**
1. Click session A in sidebar
2. Verify messages load
3. Click session B in sidebar
4. Verify messages load
5. Click back to session A

**Expected:**
- Each session shows its own messages (never mixed)
- Sidebar highlights the active session
- Context bar updates to show correct model/provider
- Previous session's WebSocket is disconnected (or cached)
- No console errors during switching

**Coverage:** `tests/e2e/ui/session-interactions.spec.ts` — "switch sessions", but rapid switching is untested.

---

## S-06: Rapid session switching (stress)

**Preconditions:** 4+ sessions with messages exist.

**Steps:**
1. Click session A
2. Immediately click session B (don't wait for A to load)
3. Immediately click session C
4. Wait for C to fully load

**Expected:**
- Final session (C) loads correctly with its messages
- No stale messages from A or B visible
- No console errors
- Sidebar shows C as active
- Loading indicator shows during transition, clears when connected

**Coverage:** None — rapid switching is untested.

---

## S-07: Session survives page reload

**Preconditions:** Active session with messages.

**Steps:**
1. Send a message, wait for response
2. Reload the page (F5)
3. Wait for app to reconnect

**Expected:**
- Session appears in sidebar
- Clicking it shows previous messages
- Can send new messages
- Context bar shows correct model info

**Coverage:** `tests/e2e/ui/session-interactions.spec.ts` — "reload preserves session"

---

## S-08: Session with worktree

**Preconditions:** Project is a git repo.

**Steps:**
1. Create a new session
2. Check session info via API

**Expected:**
- Session CWD is in a worktree directory (not project root)
- Session has its own git branch (not master)
- Git status widget renders in the UI

**Coverage:** `tests/e2e/ui/session-worktree.spec.ts`

---

## S-09: Rename a session

**Preconditions:** Active session exists.

**Steps:**
1. Right-click (or long-press) session in sidebar
2. Select "Rename"
3. Type new title
4. Confirm

**Expected:**
- Session title updates in sidebar immediately
- Title persists across page reload
- Title visible in session header

**Coverage:** None — rename UI flow is untested.

---

## S-10: Change model mid-session

**Preconditions:** Active session connected.

**Steps:**
1. Click model selector in context bar
2. Select a different model
3. Send a message

**Expected:**
- Context bar updates to show new model
- Agent uses new model for next response
- Model choice persists across reconnect

**Coverage:** `tests/e2e/context-bar-reconnect.spec.ts` (API-level), no UI E2E.

---

## S-11: Abort a running agent

**Preconditions:** Agent is streaming a response.

**Steps:**
1. Send a message that triggers a long response
2. Click the Stop button while agent is streaming

**Expected:**
- Agent stops generating
- Partial response is visible
- Textarea re-enables
- Session returns to idle
- Can send new messages after abort

**Coverage:** `tests/e2e/steer-midturn.spec.ts` (API-level abort), no UI click test.

---

## S-12: Queue management

**Preconditions:** Agent is busy (streaming).

**Steps:**
1. Send a message while agent is busy
2. Verify it appears in the queue
3. Send another message
4. Reorder the queue (drag or API)
5. Remove one queued message

**Expected:**
- Queued messages appear in queue UI
- Reordering changes execution order
- Removed message does not execute
- When agent finishes current turn, next queued message is sent automatically

**Coverage:** `tests/e2e/ui/queue-ui.spec.ts` — 5 tests covering queue display, send-while-busy, reorder, remove, steer-from-queue.

---

## S-13: Tool permission grant/deny

**Preconditions:** Session active, tool policy set to "ask".

**Steps:**
1. Send a message that triggers a guarded tool
2. Tool permission dialog appears
3. Click "Allow" (or "Deny")

**Expected:**
- Allow: tool executes, response includes tool output
- Deny: agent receives denial, responds accordingly
- Dialog disappears after action
- If "Allow always" selected, subsequent uses don't prompt

**Coverage:** `tests/e2e/ui/tool-ask-policy.spec.ts` — 3 tests.

---

## S-14: Session survives gateway crash

**Preconditions:** Active session with messages, gateway running.

**Steps:**
1. Send a message, wait for response
2. Gateway process is killed (hard crash)
3. Gateway restarts on new port
4. Navigate to the session

**Expected:**
- Session appears in sidebar (not archived)
- Previous messages are visible
- Can send new messages
- CWD is preserved
- Git status widget renders (if worktree session)

**Coverage:** Manual integration tests only — `tests/manual-integration/session-resilience.spec.ts`
