# Configurable agent directory design record

This design has shipped. The durable behavior is documented in [Configurable agent directory](../configurable-agent-directory.md).

## Final decisions

- Default agent directory: `<projectRoot>/.bobbit/agent/`.
- Startup precedence: `BOBBIT_AGENT_DIR` > `PI_CODING_AGENT_DIR` > persisted Settings value > default.
- The active directory is resolved once at gateway startup. Settings writes are next-start only; there is no live switching or multi-root write mode.
- Migration is user-initiated and copy-only. It preserves the source directory and copies only the allowlist: `sessions/`, `auth.json`, `models.json`, `settings.json`, `google-code-assist.json`, and `bin/`.
- Transcript compatibility is read-oriented: existing absolute `agentSessionFile` paths remain authoritative, historical roots are remembered, and exact outside-root transcripts are readable only after persisted-session registration and transcript-shape validation.
- Sandbox access remains narrow: active sessions and read-only models are mounted, sandbox auth is generated/scoped, and host `auth.json` is never mounted.
- Project scaffolding ensures `.bobbit/.gitignore` ignores `agent/` as well as `state/`.

## Why restart-gated

The agent directory feeds process environment, binary staging, Docker bind mounts, transcript path translation, model cache reads, and auth/cache files. Live switching would create split-brain state: running agents and long-lived containers would keep old paths while the server starts writing new metadata elsewhere. Pinning the directory at startup keeps one active runtime root and makes Settings changes explicit: save, optionally copy data, restart.

## Why copy-only migration

Credentials and transcripts are user data. Bobbit should not silently move or delete them, especially when users may still run older installations against `~/.bobbit/agent/`. Copy-only migration lets the user preserve the source as a rollback path while preparing the next-start directory.

## Why the project-local default is allowed inside the worktree

Most paths inside a git worktree are rejected because they may put credentials into source-controlled files. The single exception is the intended local default, `<projectRoot>/.bobbit/agent/`, because `.bobbit/.gitignore` is scaffolded and repaired to ignore `agent/`. This gives new installs a server-local default without making arbitrary in-repo credential paths acceptable.
