# Configurable agent directory

Bobbit keeps the agent CLI's durable data in an **agent directory**: session transcripts, provider auth, model metadata, Google Code Assist cache data, agent settings, and staged helper binaries. The directory is configurable so each Bobbit project can keep credentials and transcripts local to the server checkout instead of sharing one host-wide default.

The active directory is resolved once when the gateway starts. Settings changes are restart-gated; Bobbit never live-switches an already-running process.

## Resolution order

At startup Bobbit resolves the agent directory with this exact precedence:

1. `BOBBIT_AGENT_DIR`
2. persisted Settings value (`agentDir` in `.bobbit/state/preferences.json`)
3. default: `<projectRoot>/.bobbit/agent/`

`PI_CODING_AGENT_DIR` is not accepted as a user-facing Bobbit startup override. Bobbit may set it internally when spawning the underlying `pi-coding-agent`, but only to the already-resolved Bobbit agent directory so child processes cannot fall back to raw pi state.

Inputs are normalized before use:

- `~` and `~/...` expand to the host home directory.
- Relative paths resolve against `<projectRoot>`.
- Stored/displayed paths are absolute host paths.

`globalAgentDir()` returns the startup-resolved directory for the life of the process. Changing an environment variable or saving a new Settings value after startup does not change running sessions, sandbox mounts, model caches, or binary staging until restart.

## What lives there

| Path | Purpose |
|---|---|
| `sessions/` | Agent `.jsonl` transcripts and sidecars. New sessions write under the startup active directory. |
| `auth.json` | Host provider credentials. Never mounted wholesale into sandboxes. |
| `models.json` | Model registry and AI Gateway model metadata. |
| `settings.json` | Agent CLI compatibility settings. |
| `google-code-assist.json` | Google Code Assist cache/config data. |
| `bin/` | Staged `fd`/`rg` helper binaries used by the agent CLI. |

New scaffolds and upgraded existing scaffolds ensure `.bobbit/.gitignore` contains both `state/` and `agent/`, so the project-local default does not put credentials or transcripts into source control.

## Settings workflow

The Settings → Maintenance **Agent Directory** card shows:

- **Active directory** — the startup-pinned directory used by this process.
- **Startup source** — `BOBBIT_AGENT_DIR`, `persisted`, or `default`.
- **Default** — `<projectRoot>/.bobbit/agent/`.
- **Persisted / pending** — the saved directory that will be considered on future starts when no `BOBBIT_AGENT_DIR` override is active.
- **Effective after restart** — the directory Bobbit would use after restart with the current environment.
- **Restart guidance** — whether restart is required and which directory is active now vs next start.
- **Environment override** — a warning when `BOBBIT_AGENT_DIR` is active.

Saving a path writes only the next-start preference. It does not copy data or switch live sessions. Clearing the setting removes the persisted path and returns future starts to env/default precedence.

When `BOBBIT_AGENT_DIR` is active, the UI can still save a persisted path, but the override remains effective after restart until the env var is removed.

## Path validation

The validate/save flow rejects paths that could leak credentials into the repo or hide behind symlink tricks.

Validation rules:

1. The input must be a non-empty string, unless clearing the persisted setting.
2. `~` is expanded and relative paths resolve against `<projectRoot>`.
3. The git worktree root is detected with `git rev-parse --show-toplevel`; if that fails, Bobbit falls back to `<projectRoot>`.
4. A target inside the git worktree is rejected except the default `<projectRoot>/.bobbit/agent/` and paths nested under that default.
5. Existing symlinks/junctions and the deepest existing parent are resolved before `mkdir`, so a path outside the repo that resolves back into the worktree is rejected before creating anything.
6. The target directory is created if missing, then checked again with `realpath`.
7. The final directory must be readable and writable.
8. Bobbit creates, reads, and deletes a probe file to verify real read/write access.

Structured validation errors include stable codes such as `EMPTY_PATH`, `INSIDE_WORKTREE`, `CREATE_FAILED`, `NOT_DIRECTORY`, `ACCESS_DENIED`, and `PROBE_FAILED`.

## Copy data

Copying data is explicit, user-initiated, and copy-only. Bobbit never silently migrates data at startup, never deletes the source, and never renames the source directory.

The Settings **Copy data** card appears when the pending directory differs from the active directory. It copies from an active or historical configured agent directory to the pending next-start directory. It does not auto-discover `~/.pi/agent` and does not treat raw pi state as an implicit source.

Allowlist:

- `sessions/`
- `auth.json`
- `models.json`
- `settings.json`
- `google-code-assist.json`
- `bin/`

By default, existing destination files are skipped. If **Overwrite existing destination files** is selected, Bobbit overwrites only allowlisted files. Destination files outside the allowlist are untouched.

Symlink safety:

- A symlink source entry is skipped with a warning.
- The destination directory itself must not be a symlink.
- Existing destination symlinks are not overwritten.
- Recursive copies verify destination paths stay inside the selected pending directory.

The copy response reports copied, skipped, overwritten, missing, warning, and error entries, followed by the same restart guidance shown after save.

## Transcript compatibility

Persisted sessions store `agentSessionFile` as an absolute path. Bobbit keeps those paths readable across copy operations and future configuration changes.

Compatibility rules:

- New sessions write transcripts under the active startup directory's `sessions/` root.
- Existing absolute `agentSessionFile` values stay authoritative for host-side reads; Copy data does not rewrite them.
- `agentDirHistory` records configured startup, saved, and copied directories; it is not seeded from `~/.pi/agent`.
- Recovery scans active sessions first, then historical sessions roots, then read-only legacy transcript roots.
- Transcript guards accept paths inside trusted active, historical, or legacy `sessions/` roots.
- Exact persisted outside-root transcript paths are read-compatible only after they are registered from a persisted session and verified as regular, non-symlink `.jsonl` transcript files. They are not sanitizer write targets and are not deleted by purge.

For sandboxed sessions, the agent can see only the active mounted sessions root. If a persisted historical host transcript has been copied to the active root, Bobbit remaps `switch_session` to the active mounted copy while preserving the historical absolute path for host reads. If no active copy exists, the historical path remains unchanged and may not be visible inside the sandbox.

Legacy transcript roots, including `~/.pi/agent/sessions`, are read compatibility fallbacks only. Startup does not rename, move, copy from, or write marker directories into `~/.pi/agent`.

## Sandbox safeguards

Configuring the agent directory must not widen sandbox access.

Sandbox containers receive:

- the active `<agentDir>/sessions/` mounted at `/home/node/.bobbit/agent/sessions`;
- active `<agentDir>/models.json` mounted read-only when it exists;
- a generated scoped auth file from `.bobbit/state/sandbox-agent-auth/<scope>.auth.json` mounted read-only as `/home/node/.bobbit/agent/auth.json`;
- only the generated-extension state subdirectories needed for remapped `--extension` paths, including `.bobbit/state/google-code-assist/` and `.bobbit/state/tool-result-error-bridge/`, mounted read-only at `/bobbit-state/<subdir>`.

Sandbox containers do **not** receive:

- the full host agent directory;
- host `<agentDir>/auth.json`;
- `.bobbit/state` as a whole.

The sandbox auth file contains only sanitized credentials allowed by the project's sandbox token policy. Generated-extension mounts contain source code only, not host tokens, and are read-only so sandboxed agents can load but not mutate content-addressed code reused by later sessions.

Project sandboxes are recreated when their existing Docker bind mounts still point at a previous active agent directory or are missing current required state mounts such as `google-code-assist` or `tool-result-error-bridge`. Docker bind mounts cannot be changed in place, so recreating the container is the safe way to apply the least-privilege mount contract while preserving the named workspace volumes.

Remote-less sandbox clone sources are also sanitized. Instead of bind-mounting the live project root, Bobbit builds a temporary, remote-less clone source from safe tracked `HEAD` content, excluding `.bobbit/` subtrees and `auth.json` files, then mounts that sanitized repository read-only. Local path origins are rejected rather than passed through to git inside the container.

## Related code and tests

Primary implementation modules:

- `src/server/agent-dir-config.ts` — resolution, validation, state, copy-data reporting, restart guidance.
- `src/server/bobbit-dir.ts` — public directory helpers.
- `src/server/server.ts` — `/api/agent-dir*` endpoints.
- `src/app/settings-page.ts` — Maintenance settings UI.
- `src/server/agent/agent-session-path.ts` and `transcript-sanitizer.ts` — transcript compatibility and safety.
- `src/server/agent/docker-args.ts`, `project-sandbox.ts`, and `sandbox-clone-source.ts` — sandbox mounts, stale-mount recreation, sanitized clone source.

Representative regression tests:

- `tests/bobbit-dir-agent-dir.test.ts`
- `tests/agent-dir-validation.test.ts`
- `tests/agent-dir-migration.test.ts`
- `tests/e2e/agent-dir-settings.spec.ts`
- `tests/e2e/ui/settings-agent-dir.spec.ts`
- `tests/session-recovery-agent-dir.test.ts`
- `tests/transcript-host-absolute-context.test.ts`
- `tests/docker-args.test.ts`
- `tests/sandbox-clone-source.test.ts`
- `tests/scaffold-agent-gitignore.test.ts`
