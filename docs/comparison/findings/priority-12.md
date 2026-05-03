# Priority 12 — Sandbox / Isolation Backends

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 12.1 | Bobbit has no `Environment` interface; all shell is local-only | **real** | high |
| 12.2 | Bobbit has no Docker backend for shell execution | **real** | high |
| 12.3 | Bobbit has no SSH backend | **real** | high |
| 12.4 | Bobbit has no Modal/Daytona/Vercel cloud backends | **real** | high |

Phase-A audits already converge: Bobbit's bash extension `spawn`s a local `/bin/bash -c` process directly with no abstraction layer (`audits/bobbit.md:83`, `:220-223`, `:248`); Hermes has a full seven-backend abstraction behind `BaseEnvironment` with local/docker/ssh/modal/daytona/singularity/vercel_sandbox implementations (`audits/hermes.md:11`, `:80-91`, `:247-251`); Claude Code has OS-level sandboxing (Linux landlock / macOS sandbox-exec) plus remote-session execution but no built-in container or cloud backends (`audits/claude-code.md:81`, `:263-267`). All four Priority-12 goals are real gaps; Hermes is the canonical reference impl. Note: 12.1 (the abstraction itself) is the prerequisite — without it, 12.2/12.3/12.4 cannot land cleanly.

A one-time scope clarification vs `comparison.md`: row D4 scores Bobbit 4/9, which overstates the situation. Direct code search confirms there is **no** `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`, `Environment` interface, or `sandbox:` plumbing anywhere in `/Users/aj/Documents/dev/bobbit/src/` — the AGENTS.md description of a Docker sandbox refers to a not-yet-merged feature. The existing 4/9 score reflects git-worktree filesystem isolation between role agents only.

---

## Goal 12.1: Backend abstraction (Environment interface)

**Doc claim.** All shell execution is `local` only; need an `Environment` interface (`exec/background/kill/logs/cwd/env`) so future Docker/SSH/cloud backends can plug in.

**Bobbit reality.**
- Direct: `find . -path ./node_modules -prune -o -type f \( -name "*sandbox*" -o -name "*docker*" \) -print` returned **zero** matches under `src/server/` in master (`/Users/aj/Documents/dev/bobbit`).
- `grep -rln "Environment\b\|exec_backend" src/server/` returned no matches.
- The bash tool extension at `.bobbit/config/tools/shell/extension.ts:14-35` directly imports `spawn` from `node:child_process` and chooses a hardcoded host shell (`/bin/bash`, `cmd.exe`, or Git Bash). There is no abstraction between the tool and the host process:
  ```ts
  // .bobbit/config/tools/shell/extension.ts:14-35
  import { spawn } from "node:child_process";
  ...
  function getShellConfig(): { shell: string; args: string[] } {
      if (process.platform === "win32") { ... return { shell: "cmd.exe", args: ["/c"] }; }
      return { shell: "/bin/bash", args: ["-c"] };
  }
  ```
- `verification-harness.ts:935-950` likewise calls `spawn` directly against the host shell.
- Phase-A audit `audits/bobbit.md:220-223` confirms: "no Docker sandbox, no `project-sandbox.ts` / `sandbox-manager.ts` / `docker-args.ts`, no project-level `sandbox: docker` plumbing. Tools execute with the gateway process's host privileges."

**Claude Code reality.** No equivalent abstraction either — sandboxing is OS-level wrapping inside `BashTool`, not a pluggable backend interface. `audits/claude-code.md:81`: `shouldUseSandbox()` decides whether to wrap the host invocation in landlock/sandbox-exec. The execution model is still single-host. So CC is **not** a useful reference for 12.1.

**Hermes reality.** Has the canonical reference:
- `tools/environments/base.py:267-360` — abstract `BaseEnvironment(ABC)` defines `_run_bash`, `cleanup`, `init_session`, `execute`, `get_temp_dir`, with concrete cwd/env/snapshot/timeout/interrupt handling shared across backends.
  ```python
  # tools/environments/base.py:267-280
  class BaseEnvironment(ABC):
      """Common interface and unified execution flow for all Hermes backends.
      Subclasses implement ``_run_bash()`` and ``cleanup()``.  The base class
      provides ``execute()`` with session snapshot sourcing, CWD tracking,
      interrupt handling, and timeout enforcement."""
      _stdin_mode: str = "pipe"
      _snapshot_timeout: int = 30
  ```
- Backends list at `tools/environments/__init__.py` (siblings `local.py`, `docker.py`, `ssh.py`, `modal.py`, `daytona.py`, `singularity.py`, `vercel_sandbox.py`).
- Routing in `tools/terminal_tool.py:971-1213` (`_get_env_config` / `_create_environment`) — see also `audits/hermes.md:80-91`.
- Crucially, `tools/file_operations.py:373` (`ShellFileOperations`) routes `read_file/write_file/patch/search_files` through whichever backend is active, so coding tools are backend-agnostic (`audits/hermes.md:92`, `:249`).

**Verdict.** **real** (high confidence).

**Reasoning.** Both audits independently confirm Bobbit has no execution abstraction; the bash extension directly spawns a host process. Hermes provides a clean reference shape (abstract base + concrete backends + tool-layer routing). The doc's interface sketch maps closely onto Hermes' `BaseEnvironment` plus `terminal_tool._create_environment()` registry.

**Minimal proof of gap.**

Bobbit (`/Users/aj/Documents/dev/bobbit/.bobbit/config/tools/shell/extension.ts:14-35`):
```ts
import { spawn } from "node:child_process";
...
function getShellConfig(): { shell: string; args: string[] } {
    if (process.platform === "win32") { ... }
    return { shell: "/bin/bash", args: ["-c"] };
}
```

Hermes (`/Users/aj/Documents/dev/hermes-agent/tools/environments/base.py:306-321`):
```python
class BaseEnvironment(ABC):
    def __init__(self, cwd: str, timeout: int, env: dict = None):
        self.cwd = cwd; self.timeout = timeout; self.env = env or {}
        ...
    @abstractmethod
    def _run_bash(self, cmd_string: str, *, login=False, timeout=120,
                  stdin_data: str | None = None) -> ProcessHandle: ...
    @abstractmethod
    def cleanup(self): ...
```

**Scope-down notes.** Keep as proposed — abstraction is the prerequisite for 12.2–12.4. The proposed `Environment` interface should also expose a method that file/edit/grep tools can route through, mirroring Hermes' `ShellFileOperations` (otherwise coding tools stay tied to host fs even after shell goes remote).

---

## Goal 12.2: Docker backend

**Doc claim.** Implement `DockerEnvironment` (`docker run`, image via env, cwd mount, env allow-list) for sandboxed/CI/untrusted-repo execution.

**Bobbit reality.**
- No Docker integration in `src/server/`. `audits/bobbit.md:220-223`: "Searched `find /Users/aj/Documents/dev/bobbit -name '*sandbox*' -o -name '*docker*'` — no matches outside `node_modules`. `grep -rn 'sandbox\|docker' src/server/` — only `cli.ts` token comment; nothing in `agent/`."
- The AGENTS.md / system-prompt language about `sandbox: docker` and `project-sandbox.ts` describes an unmerged feature, not the master tree.
- `git log --oneline -5` shows recent merges focused on workflows/proposals/observer; no sandbox commits.

**Claude Code reality.** No built-in container backend. `audits/claude-code.md:265`: "no built-in container backend in this source; the sandbox is OS-level (Linux landlock / macOS sandbox-exec via `src/utils/sandbox/sandbox-adapter.ts`, used only inside `Bash`)." So CC is **not** a useful reference for 12.2 either.

**Hermes reality.**
- `tools/environments/docker.py` is the concrete backend.
- `tools/terminal_tool.py:1010-1015` shows the routing knobs: `docker_volumes`, `docker_mount_cwd_to_workspace`, `docker_run_as_host_user`, `docker_forward_env`, with image autodetect via `find_docker`.
- `audits/hermes.md:85`: "`docker` | `find_docker` autodetect; `docker_volumes`, `docker_mount_cwd_to_workspace`, `docker_run_as_host_user`, `docker_forward_env`."
- Hermes' `docker.py` reuses `BaseEnvironment.execute()` for snapshot sourcing, cwd tracking, interrupt, timeout — the per-backend code is small precisely because the abstraction in 12.1 carries the heavy lifting.

**Verdict.** **real** (high confidence).

**Reasoning.** Bobbit has no Docker backend (confirmed by both grep and audit). Hermes provides a concrete, working reference and demonstrates that with 12.1 in place, the per-backend code is tractable.

**Minimal proof of gap.**

Bobbit (master, top of repo):
```
$ find /Users/aj/Documents/dev/bobbit -path '*/node_modules' -prune -o \
       -type f \( -name '*sandbox*' -o -name '*docker*' \) -print
(no output)
```

Hermes (`/Users/aj/Documents/dev/hermes-agent/tools/environments/`):
```
docker.py daytona.py local.py managed_modal.py modal.py singularity.py
ssh.py vercel_sandbox.py file_sync.py base.py
```
With handler-side wiring at `tools/terminal_tool.py:1010-1213` (`_get_env_config` reads `TERMINAL_DOCKER_*` envs, dispatches to `DockerEnvironment`).

**Scope-down notes.** Acceptance criterion "File writes inside container materialise on host (mount)" is the right MVP; Hermes' `docker_mount_cwd_to_workspace` toggle is a useful precedent. Keep `BOBBIT_DOCKER_IMAGE` env-var configuration for parity. Defer per-session persistent-container option (Hermes spawns per-call) as a v2.

---

## Goal 12.3: SSH backend

**Doc claim.** Implement `SSHEnvironment` over `ssh user@host` with key auth, configured via `BOBBIT_SSH_HOST/USER/KEY`, with connection-pool reuse.

**Bobbit reality.**
- `grep -rln "ssh\|modal\|daytona\|vercel" src/` returned only `src/app/goal-dashboard.ts` (UI string), nothing in `src/server/`.
- No `ssh.ts`, no remote-exec module anywhere in master.

**Claude Code reality.** Partial relevance: `Agent(isolation: 'remote')` via `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` and `src/remote/RemoteSessionManager.ts` (`audits/claude-code.md:266`). However this is a **proprietary remote-session API** (`fetchSession`, `pollRemoteSessionEvents`, `archiveRemoteSession` from a teleport service), not a generic SSH transport. It's gated by `USER_TYPE === 'ant'`. Useful as inspiration but not as a drop-in reference for plain SSH.

**Hermes reality.**
- `tools/environments/ssh.py` — concrete backend.
- `tools/terminal_tool.py:987` sets `default_cwd = "~"` for ssh.
- `audits/hermes.md:87`: "`ssh` | `host`, `user`, `port`, `key`, `persistent`."
- Reuses `BaseEnvironment` snapshot + cwd-marker machinery so the same `read_file`/`write_file`/`patch` flow works against the remote host.

**Verdict.** **real** (high confidence).

**Reasoning.** Bobbit has no SSH execution path. Hermes' `ssh.py` is the right reference (open code, generic SSH), with `host/user/port/key/persistent` knobs that match the doc's `BOBBIT_SSH_HOST/USER/KEY` config.

**Minimal proof of gap.**

Bobbit:
```
$ grep -rln "ssh" /Users/aj/Documents/dev/bobbit/src/server/
(no matches)
```

Hermes (`/Users/aj/Documents/dev/hermes-agent/tools/environments/ssh.py`, exists; routed by `terminal_tool.py:982-988`):
```python
elif env_type == "ssh":
    default_cwd = "~"
...
return { "env_type": env_type, "cwd": cwd, "host_cwd": host_cwd, ... }
```

**Scope-down notes.** Connection pooling can be deferred to a v2 — Hermes uses per-session `persistent` flag. The doc's "mock SSH server for tests" is reasonable; a simpler test-plan is `localhost` ssh in CI when the runner has sshd available. Add a credentials-missing path (matches 12.4 style: backend disabled with actionable hint).

---

## Goal 12.4: Vercel/Modal/Daytona backends

**Doc claim.** Implement Modal/Daytona/Vercel as optional plugins each implementing the `Environment` interface; disabled when credentials are missing; per-session config (image/cpu/memory/persistent); errors structured, never crash the server.

**Bobbit reality.**
- No cloud-backend code anywhere — same searches as 12.2/12.3 returned nothing under `src/server/`.
- No plugin infrastructure for `exec-modal`/`exec-daytona`/`exec-vercel`. Bobbit has tool plugins (`.bobbit/config/tools/`) but no execution-backend plugin pattern (logical extension of 12.1).

**Claude Code reality.** Has remote execution (`Agent(isolation: 'remote')`, `RemoteSessionManager`) but it's the Anthropic-internal teleport service (`audits/claude-code.md:266`), not Modal/Daytona/Vercel. Not a reference for these specific cloud backends.

**Hermes reality.** All three exist and are well-trodden:
- `tools/environments/modal.py` (+ `managed_modal.py`, `modal_utils.py`).
- `tools/environments/daytona.py`.
- `tools/environments/vercel_sandbox.py` with runtime-aware preflight at `:128-180` (`_check_vercel_sandbox_requirements`).
- `audits/hermes.md:88-91`: routing table covers modal/daytona/vercel_sandbox alongside docker/ssh/singularity.
- `tools/terminal_tool.py:980-1013` shows per-backend cwd/host-path defensiveness (`_VERCEL_SANDBOX_DEFAULT_CWD`, the "is_host_path / is_relative" remap for sandboxed backends).
- Spillover persistence routes through the active backend's tmpdir so file artifacts work uniformly (`audits/hermes.md:130`, `:249`, `:302`).

**Verdict.** **real** (high confidence).

**Reasoning.** Three concrete cloud backends exist in Hermes with the exact shape the doc proposes (per-backend module, runtime preflight, credential check, structured config). Bobbit has nothing equivalent.

**Minimal proof of gap.**

Bobbit:
```
$ ls /Users/aj/Documents/dev/bobbit/src/server/exec/ 2>&1
ls: cannot access '.../exec/': No such file or directory
```

Hermes (`/Users/aj/Documents/dev/hermes-agent/tools/environments/`):
```
modal.py  managed_modal.py  modal_utils.py
daytona.py
vercel_sandbox.py
```
With per-backend preflight, e.g. Hermes `terminal_tool.py:128-180` `_check_vercel_sandbox_requirements()` performs runtime-aware credential and runtime checks before the backend is offered.

**Scope-down notes.**
- Doc's effort estimate (XL) is right — even with 12.1 in place, each cloud SDK has its own auth/lifecycle shape.
- Recommend implementing in this order based on user demand: **Modal first** (most general; SDK is mature), **Daytona second**, **Vercel last** (newest/least common). This matches Hermes' code-stability ordering (`modal.py` is plain; `vercel_sandbox.py` has a 50-line preflight specifically because it's the most quirk-laden).
- Acceptance criterion "missing credentials disable the backend cleanly with a setup hint" maps directly to Hermes' preflight pattern (`_check_vercel_sandbox_requirements`).
- Consider deferring 12.4 entirely until 12.1 + 12.2 ship and at least one user requests cloud execution. Cloud backends are ⭐ impact and XL effort by the doc's own admission.
