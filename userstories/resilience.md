# Resilience User Stories

## RE-01: Session survives crash

**Steps:**
1. Send a message in an active session.
2. Kill the server (hard crash).
3. Restart the server.
4. Navigate to the session.

**Expected:**
- Session appears in the sidebar (not lost or archived).
- Previous messages are preserved.
- Can send a follow-up message and get a response.
- Working directory is unchanged.
- Git status works.

**Coverage:** Manual only.

---

## RE-02: Goal survives crash

**Steps:**
1. Have a goal with an active team.
2. Kill the server.
3. Restart the server.
4. Navigate to the goal.

**Expected:**
- Goal appears in the sidebar.
- Dashboard loads correctly.
- Gates preserved with their previous statuses.
- Team members restored.
- Goals that were mid-setup at crash time show an error status with a retry option.

**Coverage:** Manual only.

---

## RE-03: Data persisted before crash

**Steps:**
1. Kill the server (hard crash, no graceful shutdown).

**Expected:**
- Sessions, goals, gates, and team state are all persisted to disk before the crash.
- Session message history files exist on disk.

**Coverage:** Manual only.

---

## RE-04: Worktree preserved

**Steps:**
1. Create a session with its own git worktree.
2. Kill the server.
3. Restart the server.

**Expected:**
- Worktree directory still exists on disk.
- Working directory is the same as before the crash.
- Git branch is unchanged.

**Coverage:** Manual only.

---

## RE-05: Sandbox container recovery

**Steps:**
1. Kill the Docker container while sessions are active.

**Expected:**
- Container automatically recreated within ~30 seconds.
- Sessions recover automatically.
- Worktrees inside the container are restored.
- If recovery fails, the session is archived.

**Coverage:** Skipped without Docker.

---

## RE-06: Multiple sessions survive

**Preconditions:** 5+ sessions of different types (plain, worktree, sandbox).

**Steps:**
1. Kill the server.
2. Restart the server.

**Expected:**
- All sessions present after restart.
- Each has correct working directory, branch, and messages.
- Can interact with all of them.

**Coverage:** Manual only.
