# Sandbox — User Stories

Sandbox mode runs agent commands inside a Docker container instead of on the host. These stories cover user-facing sandbox interactions and system-level security/isolation guarantees.

Key files: `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`.
Status endpoint: `GET /api/sandbox-status`. Container label: `bobbit-project=<projectId>`.

---

## SB-01: Enable sandbox for a project

**Preconditions:** A project is registered. Docker is installed and running. Sandbox is currently disabled for this project.

**Steps and expectations:**
1. Open Settings → project tab for the target project.
   - Project settings page loads with sub-tabs visible.
2. Set `sandbox: "docker"` in the project configuration (via project.yaml or the REST API `PUT /api/projects/:id/config`).
   - Setting is accepted and persisted.
3. Start a new session in this project.
   - A Docker container is created with the label `bobbit-project=<projectId>`.
   - `GET /api/sandbox-status` returns a response indicating the container is running.
   - Only **one** container exists for this project, regardless of how many sessions are active.
4. Open a second session in the same project.
   - No new container is created. Both sessions share the same container.
   - `docker ps --filter label=bobbit-project=<projectId>` shows exactly one container.
5. Remove `sandbox: "docker"` from project config (set to `null` or remove the key).
   - New sessions run commands on the host, not inside a container.
   - The existing container may remain (cleanup is manual via Maintenance).

**Edge cases:**
- If Docker is not installed or the daemon is not running, container creation fails with a clear error surfaced to the session.
- If the project has no `sandbox` key, all commands run on the host (default behavior).

**Coverage:** sandbox-security.spec.ts (API-level), manual integration tests

---

## SB-02: Observe agent commands running inside the sandbox

**Preconditions:** Project has `sandbox: "docker"` enabled. Container is running. Active session.

**Steps and expectations:**
1. Send a prompt that causes the agent to run a shell command (e.g. "list the files in the project root").
   - The agent's `bash` tool call executes inside the Docker container via `docker exec`.
   - Output reflects the container's filesystem, not the host filesystem.
2. Ask the agent to create a file (e.g. "create /tmp/sandbox-test.txt with contents 'hello'").
   - The file is created inside the container.
   - Running `docker exec <container> cat /tmp/sandbox-test.txt` on the host confirms the file exists in the container.
3. Ask the agent to run `git status` in the project directory.
   - Git operates on the repository mounted inside the container.
   - Output matches the branch and working tree state visible in the UI.
4. Ask the agent to run `whoami` or `hostname`.
   - Output reflects the container's user/hostname, not the host's.

**Edge cases:**
- Long-running commands inside the container respect the same timeout as host commands.
- If the container is stopped mid-command, the bash tool call returns an error (not a hang).

**Coverage:** sandbox-security.spec.ts, sandbox-branch-reconcile.spec.ts

---

## SB-03: Check sandbox status

**Preconditions:** Project has `sandbox: "docker"` enabled.

**Steps and expectations:**
1. Call `GET /api/sandbox-status`.
   - Response includes the container state (running, stopped, or not found).
   - Response includes the project ID and container ID.
2. Stop the container externally (`docker stop <container>`).
3. Call `GET /api/sandbox-status` again.
   - Response reflects that the container is no longer running.
4. Start a new session or send a command in an existing session.
   - The container is automatically recreated.
   - `GET /api/sandbox-status` shows running again.

**Coverage:** manual integration tests

---

## SB-04: Container death and automatic recovery

**Preconditions:** Project has `sandbox: "docker"` enabled. At least one active session. Container is running.

**Steps and expectations:**
1. Kill the container externally (`docker kill <container>`).
   - Within approximately 30 seconds, Bobbit detects the container is gone.
2. Observe recovery behavior.
   - A new container is created automatically with the same configuration and label.
   - `GET /api/sandbox-status` transitions from not-found/stopped back to running.
3. Send a command in the existing session after recovery.
   - The command executes successfully inside the new container.
   - The session did not need to be restarted manually.
4. If recovery fails (e.g. Docker daemon crashed):
   - The session is archived rather than left in a broken state.
   - The user can see the session was archived in the sidebar.

**Edge cases:**
- Rapid repeated kills (kill → recover → kill) do not produce duplicate containers. Only one container per project at any time.
- Data in non-mounted paths inside the container is lost on recreation (expected — only mounted volumes persist).

**Coverage:** sandbox-recovery.spec.ts

---

## SB-05: Gate verification runs inside sandbox

**Preconditions:** Project has `sandbox: "docker"` enabled. A goal exists with a workflow gate that has a command-based verification step (e.g. `npm test`).

**Steps and expectations:**
1. Signal the gate (via `gate_signal` or the agent completing work).
   - Verification is triggered asynchronously.
2. Observe the verification command execution.
   - The command runs inside the Docker container, not on the host.
   - Verification output reflects the container's environment (paths, installed tools).
3. If the verification command passes:
   - Gate transitions to `passed`. Dashboard shows green status.
4. If the verification command fails:
   - Gate transitions to `failed`. Dashboard shows red status with output.
   - `gate_inspect` with section `verification` shows the full container output.

**Edge cases:**
- If the container is unavailable when verification triggers, the system attempts container recreation before running the command.
- Verification timeout applies inside the container the same as on host.

**Coverage:** manual integration tests

---

## SB-06: Branch reconciliation between container and UI

> **System property** — no direct user action required. Verifiable via automated tests.

**Guarantee:** The git branch name inside the Docker container matches the branch name displayed in the UI and used for PR lookups. Even when worktree branches are created with generated names, the branch inside the container is reconciled to match.

**Verification method:**
1. Create a goal session in a sandboxed project. The system assigns a worktree branch (e.g. `goal/my-feature`).
2. Inside the container, run `git branch --show-current`.
   - The output matches the branch name shown in the session sidebar and used by `git-status`/`git-diff` API endpoints.
3. Create a PR from the session. The PR targets the correct branch name.

**What could go wrong:**
- Branch name mismatch causes PR lookups to fail silently (wrong branch queried).
- Agent sees a different branch than the UI shows, leading to confusion in multi-agent workflows.

**Coverage:** sandbox-branch-reconcile.spec.ts

---

## SB-07: Mount security — sensitive host paths blocked

> **System property** — no direct user action required. Verifiable via automated tests.

**Guarantee:** The Docker container does not mount sensitive host paths. `docker-args.ts` maintains a blocklist that includes:
- SSH keys (`~/.ssh/`)
- Cloud credential directories (`~/.aws/`, `~/.azure/`, `~/.gcloud/`, `~/.config/gcloud/`)
- System directories (`/etc/`, `/usr/`, `/var/`, Windows system paths)
- Drive roots (`/`, `C:\`)

Path traversal attempts (e.g. `../../.ssh`) are normalized and rejected.

**Verification method:**
1. Inspect the Docker `run` arguments generated by `docker-args.ts`.
   - No mount (`-v` / `--mount`) includes any blocklisted path.
2. From inside the container, attempt to read `~/.ssh/id_rsa` or `~/.aws/credentials`.
   - Files are not accessible (path not mounted).
3. Attempt to configure a project root as `/` or `C:\`.
   - Rejected before container creation.
4. Attempt path traversal in project paths (e.g. set project root to `/home/user/project/../../.ssh`).
   - Path is normalized; traversal is detected and rejected.

**What could go wrong:**
- New cloud provider credential paths added to user home but not to blocklist.
- Symlinks inside mounted directories pointing to sensitive host paths (mitigated by mount configuration).

**Coverage:** sandbox-security.spec.ts, sandbox-pentest.spec.ts

---

## SB-08: Token and secret isolation

> **System property** — no direct user action required. Verifiable via automated tests.

**Guarantee:** The following are never accessible from inside the Docker container:
- Gateway authentication token (used for WebSocket/REST auth)
- TLS private keys and certificates
- Session metadata files (`.bobbit/state/sessions.json`)
- Server configuration files containing secrets

Only the minimum necessary directories are mounted: the project source tree and explicitly configured data directories.

**Verification method:**
1. From inside the container, attempt to read the gateway token.
   - The environment variable is not set; the token file is not mounted.
2. From inside the container, attempt to list `.bobbit/state/`.
   - Directory is not accessible or does not contain `sessions.json`.
3. From inside the container, attempt to read TLS key files.
   - Files are not mounted; reads fail with "no such file or directory."
4. Enumerate all environment variables inside the container (`env` / `printenv`).
   - No gateway secrets, API keys, or auth tokens are present.

**What could go wrong:**
- A new secret file is added to `.bobbit/` and inadvertently included in a broad mount.
- Environment variable leakage if container inherits host env (mitigated by explicit env configuration in `docker-args.ts`).

**Coverage:** sandbox-token.spec.ts
