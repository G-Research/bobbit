# Resilience User Stories

## RE-01: Session survives crash
**Action:** Active session exists. Send message, kill server, restart on new port with same data directory, navigate to session.
**Expected:** Session not archived. Messages restored from .jsonl. CWD preserved. Follow-up message works. Git widget renders. Existing worktrees reused (not recreated).
**Coverage:** manual only.

## RE-02: Goal survives crash
**Action:** Goal with team exists, kill server, restart.
**Expected:** goals.json persisted. Dashboard loads. Gates preserved. Team restored. Goals stuck in setupStatus "preparing" marked "error" on restart.
**Coverage:** manual only.

## RE-03: Persistence files on crash
**Action:** Kill server hard (no graceful shutdown).
**Expected:** sessions.json is valid JSON. goals.json is valid. gates.json exists. team-state.json exists. .jsonl session files exist (proactive creation ensures this).
**Coverage:** manual only.

## RE-04: Worktree preserved
**Action:** Session with worktree, kill and restart.
**Expected:** Worktree directory exists. CWD matches exactly. Branch unchanged. Worktrees reused, not recreated on restart.
**Coverage:** manual only.

## RE-05: Sandbox container recovery
**Action:** Kill Docker container.
**Expected:** Health monitor detects within 20s. Container recreated with same named volumes. Sessions: terminated → recovered → idle within ~30s. Worktrees restored via 3-tier strategy: verify exists → git worktree repair → recreate from branch. If all fail, session archived.
**Coverage:** skipped without Docker.

## RE-06: Multiple sessions survive
**Action:** 5+ mixed session types (plain, worktree, sandbox), kill and restart.
**Expected:** All sessions present. Correct CWD, branch, messages for each. Can interact with all.
**Coverage:** manual only.
