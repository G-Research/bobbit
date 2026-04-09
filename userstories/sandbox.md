# Sandbox

## SB-01: Enable sandbox for project

**Preconditions:** Docker available, project registered.

**Steps:**
1. Navigate to project settings
2. Commands & Sandbox tab
3. Enable sandbox toggle
4. Save

**Expected:**
- sandbox: "docker" written to project.yaml
- Container creation starts in background
- Sandbox status endpoint shows initializing → ready

**Coverage:** API-level (`sandbox-docker.spec.ts` — skipped without Docker). No UI test.

---

## SB-02: Sandbox container lifecycle

**Preconditions:** Sandbox enabled for project.

**Steps:**
1. Container auto-created on first sandbox session
2. Container reused for subsequent sessions
3. Container survives gateway restart

**Expected:**
- One container per project (not per session)
- Container labeled `bobbit-project=<projectId>`
- Named volumes for workspace and worktrees
- On restart: reconnects to existing container by label

**Coverage:** Manual integration test. `sandbox-docker.spec.ts` (skipped).

---

## SB-03: Sandboxed session execution

**Preconditions:** Sandbox container running.

**Steps:**
1. Create a session in sandboxed project
2. Agent runs commands

**Expected:**
- Commands execute inside container via docker exec
- File system changes inside container
- Agent CWD is /workspace or /workspace-wt/<name>
- Git operations work inside container

**Coverage:** `sandbox-docker.spec.ts` (skipped). Manual test.

---

## SB-04: Sandbox security — mount blocklist

**Preconditions:** Sandbox configured.

**Steps:**
1. Attempt to mount sensitive paths (docker.sock, .ssh, etc.)

**Expected:**
- All sensitive mounts rejected with warnings
- docker.sock, /proc, /sys, /etc, /home blocked
- .ssh, .aws, .gnupg, .config blocked
- Drive roots blocked

**Coverage:** `sandbox-security.spec.ts` — thorough. `sandbox-pentest.spec.ts`.

---

## SB-05: Sandbox security — token isolation

**Preconditions:** Sandbox container running.

**Steps:**
1. From inside container, attempt to read gateway token
2. From inside container, attempt to access state files

**Expected:**
- Gateway token not accessible
- TLS keys not accessible
- sessions.json not accessible
- Only sessions/, tool-guard/, html-snapshots/ subdirs mounted

**Coverage:** `sandbox-security.spec.ts`, `sandbox-pentest.spec.ts`.

---

## SB-06: Sandbox branch reconciliation

**Preconditions:** Team-spawned session in sandbox.

**Steps:**
1. Host creates worktree with branch A
2. Container uses branch B (different naming)
3. Check persisted session branch

**Expected:**
- Persisted branch matches actual container branch
- PR status lookups use correct branch
- Orphaned worktree detection uses correct branch

**Coverage:** `sandbox-branch-reconcile.spec.ts` (non-Docker paths only). Manual test for full Docker path.

---

## SB-07: Sandbox container death and recovery

**Preconditions:** Sessions running in sandbox container.

**Steps:**
1. Kill the container (docker kill)
2. Health monitor detects death (20s)
3. Container recreated
4. Sessions recovered

**Expected:**
- Health monitor logs container death
- New container created with same volumes
- Sessions: terminated → auto-recover → idle
- Worktrees restored (repair or recreate from branch)
- If recovery fails: session archived with log

**Coverage:** `sandbox-recovery.spec.ts` (skipped without Docker). Manual test.

---

## SB-08: Sandbox goal verification

**Preconditions:** Sandboxed goal, gate with command verify step.

**Steps:**
1. Signal gate
2. Command verification step runs

**Expected:**
- Command executes inside project container via docker exec
- If container unavailable: falls back to host with warning
- Verification result reflects container execution

**Coverage:** None — sandbox verification untested.
