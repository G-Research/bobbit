# Server logging policy

The gateway logs to stdout/stderr (prefixed `[harness]` under the dev restart
harness). Logs are a **diagnostic channel**, not an activity feed — anything a
user can already see in the UI does not belong here.

There is no central logger abstraction; the codebase uses `console.log/warn/error`
directly. The only level beyond that is a **debug gate**: `process.env.BOBBIT_DEBUG`.
Wrap a statement in `if (process.env.BOBBIT_DEBUG)` to keep it available for
deep debugging without polluting the default stream.

## Keep (logged by default)

1. **Background-task actions not visible in the UI** — orphan-worktree cleanup,
   remote-branch deletion, worktree-pool reclaim, team spawn/dismiss/teardown.
2. **Genuinely actionable errors / warnings** — credential failures, transient
   gateway retries, unhandled rejections, re-prompt failures, disallowed-tool
   guard breaches, "project no longer registered" skips.
3. **Key start-up / connection info** — the gateway banner (URL, auth token,
   CWD, accessible addresses), MCP connection summary, provider/network status,
   boot-phase milestones and summaries (`[boot] … done`, sweeper totals).

## Do NOT log by default

- **A. Routine start-up noise** — per-session/per-restart tool-registration
  (`Registered N … tools`), per-session/per-team restore lines, "model/thinking
  already pinned at spawn", no-op cost-backfill passes (`stamped 0 … entries`),
  expected `ECONNREFUSED` while the gateway restarts. → delete or gate behind
  `BOBBIT_DEBUG`.
- **B. Things observable via the UI** — prompt text received, full agent
  completion/notification message bodies, internal orchestration audit events
  (`wait owner=…`). → drop the body (log a concise reference) or gate behind
  `BOBBIT_DEBUG`.

## Rules of thumb

- Summarise loops: log one `… N session(s)` line, not one line per item.
- Never dump a message body that the UI already renders — log its length or a
  short reference instead.
- A recurring per-boot line whose value never changes (a standing backlog
  count) is noise; log only when the underlying action actually happened
  (e.g. `stamped > 0`).
- Genuine errors always log at `warn`/`error` regardless of `BOBBIT_DEBUG`.
