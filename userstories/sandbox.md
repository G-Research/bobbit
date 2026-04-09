# Sandbox User Stories

## SB-01: Enable sandbox
**Action:** Project settings → sandbox toggle.
**Expected:** sandbox:"docker" written to project.yaml. Container creation starts.
**Coverage:** API only.

## SB-02: Container lifecycle
**Action:** Observe container behavior across restarts.
**Expected:** One container per project (not per session). Labeled `bobbit-project=<projectId>`. Named volumes (`bobbit-workspace-<projectId>` for /workspace, `bobbit-worktrees-<projectId>` for /workspace-wt). On restart: reconnects by label, stopped → restarts, gone → recreates with same volumes.
**Coverage:** manual only.

## SB-03: Sandboxed execution
**Action:** Run commands in sandboxed session.
**Expected:** Commands via docker exec. CWD /workspace or /workspace-wt/<name>. Git works inside container. Resource limits: N-2 CPU cores, M-2GB memory.
**Coverage:** skipped.

## SB-04: Mount blocklist
**Action:** Attempt to mount sensitive paths.
**Expected:** docker.sock, /proc, /sys, /etc, /home, .ssh, .aws, .gnupg, .config blocked. Drive roots blocked. Non-absolute paths rejected. Path traversal rejected.
**Coverage:** covered.

## SB-05: Token isolation
**Action:** Attempt to access host secrets from container.
**Expected:** Gateway token not accessible. TLS keys not accessible. sessions.json not accessible. Only sessions/, tool-guard/, and html-snapshots/ subdirs mounted under /bobbit-state/.
**Coverage:** covered.

## SB-06: Branch reconciliation
**Action:** Host branch A vs container branch B (e.g. team-spawned session).
**Expected:** Persisted branch updated to match container. PR status uses correct branch. Orphan detection uses correct branch.
**Coverage:** partial (non-Docker paths only).

## SB-07: Container death recovery
**Action:** Kill container while sessions are active.
**Expected:** Health monitor detects in 20s. Container recreated. Sessions recover. 3-tier worktree recovery. If recovery fails, session archived.
**Coverage:** skipped.

## SB-08: Sandbox verification
**Action:** Gate command step runs in sandboxed goal.
**Expected:** docker exec inside project container. If container unavailable, falls back to host with warning.
**Coverage:** none.
