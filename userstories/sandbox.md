# Sandbox User Stories

## SB-01: Enable sandbox

**Steps:**
1. Go to project settings.
2. Toggle sandbox on.

**Expected:**
- Sandbox mode saved.
- Container creation starts.

**Coverage:** API only.

---

## SB-02: Container lifecycle

**Expected:**
- One container per project (not per session).
- Container uses persistent storage volumes that survive restarts.
- On server restart: reconnects to the existing container if running, restarts it if stopped, or recreates it if gone — without losing data.

**Coverage:** Manual only.

---

## SB-03: Sandboxed execution

**Expected:**
- Agent commands run inside the container, not on the host.
- File changes happen inside the container.
- Git works inside the container.

**Coverage:** Skipped.

---

## SB-04: Mount security

**Expected:**
- Sensitive host paths are blocked from being mounted (e.g. SSH keys, cloud credentials, system directories).
- Drive roots are blocked.
- Path traversal attempts are rejected.

**Coverage:** Covered.

---

## SB-05: Token isolation

**Expected:**
- Agents inside the container cannot access the gateway authentication token, TLS keys, or session metadata.
- Only the minimum necessary data directories are accessible from within the container.

**Coverage:** Covered.

---

## SB-06: Branch reconciliation

**Expected:**
- The branch shown in the UI and used for PR lookups matches the actual branch inside the container, even if they were named differently at creation time.

**Coverage:** Partial.

---

## SB-07: Container death recovery

**Steps:**
1. Container dies while sessions are active.

**Expected:**
- Detected within ~30 seconds.
- Container recreated automatically.
- Sessions recover automatically.
- If recovery fails, the session is archived.

**Coverage:** Skipped.

---

## SB-08: Sandbox verification

**Preconditions:** Gate with a command verification step on a sandboxed goal.

**Expected:**
- Verification commands run inside the container.
- If the container is unavailable, commands fall back to the host.

**Coverage:** None.
