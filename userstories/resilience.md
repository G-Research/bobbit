# Resilience

## RE-01: Session survives gateway crash

**Preconditions:** Active session with messages.

**Steps:**
1. Send message, receive response
2. Kill gateway process
3. Restart gateway (new port, same data dir)
4. Connect to app
5. Navigate to session

**Expected:**
- Session in sidebar, not archived
- Messages preserved
- CWD preserved
- Can send follow-up messages
- Git status widget renders (if worktree)

**Coverage:** Manual integration test only.

---

## RE-02: Goal survives gateway crash

**Preconditions:** Goal with team running.

**Steps:**
1. Kill gateway
2. Restart
3. Navigate to goal

**Expected:**
- Goal in sidebar
- Dashboard loads with correct state
- Gates preserve status
- Team sessions restored

**Coverage:** Manual integration test only.

---

## RE-03: Persistence files written before crash

**Preconditions:** Sessions and goals exist.

**Steps:**
1. Kill gateway (hard crash, no graceful shutdown)
2. Check data directory

**Expected:**
- sessions.json exists and is valid JSON
- goals.json exists and is valid JSON
- gates.json exists
- team-state.json exists
- Session .jsonl files exist

**Coverage:** Manual integration test only.

---

## RE-04: Worktree preserved across restart

**Preconditions:** Session with worktree.

**Steps:**
1. Create session (gets worktree)
2. Verify worktree directory exists
3. Kill and restart gateway
4. Check session CWD

**Expected:**
- Worktree directory still exists
- CWD points to same worktree
- Git branch unchanged
- Can continue working in worktree

**Coverage:** Manual integration test only.

---

## RE-05: Sandbox container recovery

**Preconditions:** Sandboxed project with running sessions.

**Steps:**
1. Kill the Docker container
2. Wait for health monitor to detect (20s)

**Expected:**
- Container automatically recreated
- Sessions transition: terminated → recovered → idle
- Worktrees restored inside container
- Can resume work

**Coverage:** `tests/e2e/sandbox-recovery.spec.ts` (skipped without Docker). Manual test only.

---

## RE-06: Multiple sessions survive crash (stress)

**Preconditions:** 5+ sessions of mixed types (plain, worktree, sandbox).

**Steps:**
1. Create sessions of each type
2. Send messages to each
3. Kill gateway
4. Restart
5. Verify each session individually

**Expected:**
- All sessions present (none archived)
- Each has correct CWD, branch, messages
- Can interact with each after restart

**Coverage:** Manual integration test — 6 variations.
