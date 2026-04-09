# Sessions — User Stories

## S-01: Create a new session

**Preconditions:** App loaded, project in a git repo.

**Steps:**
1. Click "+" in the sidebar.
2. Wait for session to appear.

**Expected:**
- New session appears in sidebar with default title
- Session is highlighted as active
- Empty chat with textarea focused
- Context bar shows current model
- Session gets its own worktree with a dedicated branch
- Working directory is inside the worktree, not the main project directory
- If the project is in a subdirectory of the repo, the working directory is the equivalent subdirectory in the worktree
- Git status widget shows the session's branch name
- Setup command runs if configured (e.g. npm ci)

**Coverage:** partial

---

## S-02: Send a message and receive a response

**Preconditions:** Active session.

**Steps:**
1. Type message.
2. Press Enter.
3. Wait.

**Expected:**
- User message appears in chat
- Agent response appears below
- Textarea re-enables after response
- Session title auto-generates after first message

**Coverage:** covered

---

## S-03: Draft isolation across sessions

**Preconditions:** Two sessions exist.

**Steps:**
1. Go to session A.
2. Type "draft for A" (don't send).
3. Go to session B.
4. Type "draft for B" (don't send).
5. Go back to A.
6. Go back to B.

**Expected:**
- Session A shows "draft for A" on return
- Session B shows "draft for B" on return
- Drafts never leak between sessions
- Drafts survive page reload
- A sent message does not reappear as a draft

**Coverage:** none

---

## S-04: Terminate a session

**Preconditions:** Session exists.

**Steps:**
1. Hover session in sidebar.
2. Click X.
3. Confirm if prompted.

**Expected:**
- Session disappears from sidebar
- If it was selected, view switches to landing or another session
- Worktree is cleaned up

**Coverage:** covered

---

## S-05: Switch between sessions

**Preconditions:** Multiple sessions with messages.

**Steps:**
1. Click session A.
2. Verify messages.
3. Click session B.
4. Verify messages.
5. Click A again.

**Expected:**
- Each session shows only its own messages
- Sidebar highlights the active session
- Context bar shows the correct model for each session
- Loading animation shows briefly while connecting
- No errors

**Coverage:** partial

---

## S-06: Rapid session switching

**Preconditions:** 4+ sessions with messages.

**Steps:**
1. Click A.
2. Immediately click B.
3. Immediately click C.
4. Wait for C to load.

**Expected:**
- Session C loads correctly with its own messages
- No stale messages from A or B visible
- Sidebar shows C as active
- No errors

**Coverage:** none

---

## S-07: Session survives page reload

**Preconditions:** Session with messages.

**Steps:**
1. Send message, get response.
2. Reload page.
3. Wait for reconnect.

**Expected:**
- Session appears in sidebar
- Previous messages visible
- Can send new messages
- Context bar shows correct model

**Coverage:** covered

---

## S-08: Session worktree details

**Preconditions:** Project is a git repo.

**Steps:**
1. Create session.
2. Check git status widget.

**Expected:**
- Working directory is in a worktree, not the main project directory
- Session has its own branch (not master)
- Git status widget shows the branch name
- If project is in a subdirectory of the repo, working directory is the equivalent subdirectory in the worktree
- Setup command runs if configured (e.g. npm ci)

**Coverage:** partial

---

## S-09: Rename a session

**Preconditions:** Session exists.

**Steps:**
1. Double-click title or right-click → Rename.
2. Type new title.
3. Confirm.

**Expected:**
- Title updates in sidebar immediately
- Title persists across page reload

**Coverage:** none

---

## S-10: Change model mid-session

**Preconditions:** Active session.

**Steps:**
1. Click model selector in context bar.
2. Select different model.
3. Send a message.

**Expected:**
- Context bar shows new model
- Agent uses the new model
- Model choice persists across reconnect

**Coverage:** partial

---

## S-11: Abort a running agent

**Preconditions:** Agent is streaming.

**Steps:**
1. Send a message.
2. Click Stop while streaming.

**Expected:**
- Agent stops generating
- Partial response is visible
- Textarea re-enables
- Can send new messages

**Coverage:** partial

---

## S-12: Queue management

**Preconditions:** Agent is busy.

**Steps:**
1. Send message while busy.
2. Verify it appears in queue.
3. Send another.
4. Reorder via drag.
5. Remove one.

**Expected:**
- Queued messages appear as pills below the textarea
- Can drag to reorder
- Can remove a queued message
- Can steer (send immediately, interrupting current turn)
- Can edit (puts text back in textarea)
- When agent finishes, next queued message sends automatically

**Coverage:** covered

---

## S-13: Tool permission grant/deny

**Preconditions:** Tool policy set to "ask".

**Steps:**
1. Agent tries to use a guarded tool.
2. Permission dialog appears.
3. Click Allow or Deny.

**Expected:**
- Allow: tool executes, result visible
- Deny: agent told permission was denied
- Dialog closes after action
- "Allow for session" means no more prompts this session
- "Allow always" means no more prompts ever for this tool

**Coverage:** covered

---

## S-14: Session survives gateway crash

**Preconditions:** Session with messages, gateway running.

**Steps:**
1. Send message.
2. Gateway killed.
3. Gateway restarts.
4. Navigate to session.

**Expected:**
- Session appears in sidebar, not lost
- Previous messages visible
- Can send new messages
- Working directory unchanged
- Git status widget works

**Coverage:** manual only
