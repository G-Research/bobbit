# Add-project pre-flight & archive

The Add Project dialog runs a structured pre-flight pass against the candidate
`rootPath` before it lets the user click Submit, and offers a safe "start
fresh" path that archives any existing project-scoped `.bobbit/` content
without ever touching gateway-owned state.

This page is the user/developer-facing reference. The design rationale,
alternatives considered, and open questions live in
[design/robust-add-project.md](design/robust-add-project.md) — read that first
when changing the algorithm.

## Why this exists

The old flow only checked that the path was absolute, existed, was not a
symlink, and was not already registered. Everything else — readability,
writability, nesting under another project, weird filesystems, existing
`.bobbit/` contents — failed implicitly, often *after* a session had already
been spawned. The worst case was registering a project that accidentally
pointed at the running gateway's own working directory, corrupting cross-
project gateway state. Pre-flight surfaces all of those problems up front
with structured `pass | warn | fail` checks the user can read and act on.

## End-user guide

When you open Add Project and supply a path — either by typing it into the
input or picking one via the directory browser — the dialog runs a pre-flight
pass and renders a list of checks below the input. Typing is debounced
(400 ms); picking via the directory browser triggers the check immediately.
Each check has one of three levels:

| Level | Submit | Meaning |
|-------|--------|---------|
| `pass` | enabled | The check is fine. |
| `warn` | enabled | Something worth knowing — submit still allowed. |
| `fail` | **disabled** | A real problem; fix it before continuing. |

Submit stays disabled while any check is `fail`. The server re-runs the same
preflight inside `projectRegistry.register()` as a defense-in-depth guard, so
a client that skips the UI gate is rejected with HTTP 400 `code:
"preflight_failed"` (the failing report is included in the response body).

### The checks

The full set, in render order. Levels shown are the *bad* level — each check
reports `pass` when it succeeds.

| id | Bad level | What it catches |
|----|-----------|-----------------|
| `path.absolute` | fail | Relative paths. Bobbit needs an absolute root. |
| `path.exists` | fail | Path missing, a file, or stat fails. |
| `path.symlink` | warn | Path resolves through a symlink. The canonical path is offered as a remediation; the existing symlink-confirm flow still runs at submit. |
| `path.readable` | fail | `R_OK` access or `readdir` smoke test fails. |
| `path.writable` | fail | `W_OK` plus a real `mkdir`/`rmdir` probe (some filesystems lie about `W_OK`). |
| `path.long` | warn | **Windows only.** Path is longer than 200 characters. Worktree paths add ~80 chars on top and can exceed the 260-char limit. |
| `path.unc-or-network` | warn | UNC / network share (`\\server\…` or `//…`). Git worktrees on network filesystems are flaky. |
| `path.nested-in-project` | fail | Path is inside another registered project's `rootPath`, or inside its worktree root. Downgraded to `warn` when the only container is the gateway's own project — that case is unavoidable in dev. |
| `path.contains-project` | warn | Path is an ancestor of an existing registered project. Registering the parent would shadow it. |
| `path.is-worktree` | fail | `<rootPath>/.git` is a file pointing into another repo's `worktrees/` directory — register the primary checkout instead. |
| `bobbit.existing` | warn | `.bobbit/` already has content. Detail summarises sessions / goals / config files. Carries an inline **Archive existing .bobbit/** action. This check asks "is there content to archive?" — a distinct question from "is this a configured Bobbit project?", which is keyed to `.bobbit/config/project.yaml` and answered by [`POST /api/projects/detect`](internals.md#project-assistant). After a successful archive, `bobbit.existing` becomes `pass` (the empty re-scaffolded `config/`+`state/` shape doesn't trip it) and detection routes Continue to the project assistant, not auto-import. |
| `bobbit.gateway-owned` | warn | This path is the running gateway's own working directory (matches `getProjectRoot()`, contains `state/gateway-url`, or `state/watchdog.json`). Archive operations will preserve gateway-owned files when this is set. |
| `git.repo` | pass-only | Informational — whether `.git` is a directory or a file. Never blocking. |
| `disk.space` | warn | Free space on the volume is below 500 MB. |

Why these specific checks and not others: each one corresponds to a failure
mode we have seen in the wild that produced either cryptic errors or
half-registered state. See [design/robust-add-project.md](design/robust-add-project.md)
for the catalogue.

### Start fresh — archive existing `.bobbit/`

When `bobbit.existing` reports content at the path, the row carries an
**Archive existing .bobbit/** button. Clicking it opens a confirmation modal
showing the target archive directory and (when `bobbit.gateway-owned` is set)
the list of files that will be preserved in place.

The archive operation moves everything under `<rootPath>/.bobbit/` into a new
`<rootPath>/.bobbit-archive-NNN/` directory where `NNN` is a zero-padded
3-digit suffix starting at `001` and incrementing on each call
(`.bobbit-archive-001`, `.bobbit-archive-002`, …). The original `.bobbit/`
is then re-scaffolded with empty `config/` and `state/` subdirectories so the
add-project flow can proceed from a clean slate.

**Nothing is deleted.** Archives are kept in place at the project root so you
can audit or undo them manually. Each archive directory contains a
`MANIFEST.json` recording:

- `archiveDir`, `archivedAt` (ISO timestamp)
- `movedPaths` — every entry relative to `.bobbit/` that was moved
- `preservedPaths` — entries that stayed in place (only non-empty when
  `gatewayOwned: true`)
- `gatewayOwned` — whether the archive ran in gateway-owned mode
- `partial.failed` — any per-entry move failures (see below)

To undo manually: stop the gateway if applicable, move entries from the
archive directory back into `.bobbit/`, and delete the archive directory.

### What gets preserved when the gateway owns the path

When you're running the Bobbit gateway from inside a project directory and
that same directory is being registered (so `bobbit.gateway-owned` is `warn`),
the archive must not touch the files the running server depends on —
otherwise it would kill the gateway mid-operation. The preserved set is the
`GATEWAY_OWNED_FILES` allowlist exported from
[`src/server/agent/bobbit-archive.ts`](../src/server/agent/bobbit-archive.ts).

The allowlist covers (paths are relative to `<rootPath>/.bobbit/`):

- Cross-project gateway state — `state/gateway-url`, `state/watchdog.json`,
  `state/setup-complete`, `state/gateway-restart`, `state/token`,
  `state/sessions.json`, `state/projects.json`.
- TLS / DNS challenge state — `state/tls/`, `state/desec.json`.
- Restart caches — `state/tool-docs/`, `state/mcp-tool-docs/`.
- Per-session scratch — `state/preview/`, `state/tool-guard/`,
  `state/mcp-extensions/`, `state/html-snapshots/`, `state/proposal-drafts/`,
  `state/sessions/`, `state/session-prompts/`, `state/system-project/`, and
  `state/model-name-*` files.

When `bobbit.gateway-owned` is `pass` (the common case — the gateway runs
elsewhere), the allowlist is effectively empty and the entire `.bobbit/`
moves.

### Partial failures

The archive walks `.bobbit/` and moves entries one at a time, using
`fs.renameSync` with a copy+unlink fallback on `EXDEV` (cross-volume). If
some entries fail (a file is locked, a permission flips) the operation does
**not** roll back — that would risk compounding damage. Instead the result is
returned with `partial.failed` populated; the manifest reflects the true
mixed state; the client re-runs preflight which will show the remaining
content. Use the manifest to clean up manually.

## Developer guide

### Where things live

- `src/server/agent/project-preflight.ts` — `runPreflight(rootPath, ctx)` and
  the `PreflightCheck` / `PreflightReport` types. Pure-ish: only stat /
  readdir / mkdir-probe, never mutates registry state.
- `src/server/agent/bobbit-archive.ts` — `GATEWAY_OWNED_FILES`,
  `archiveProjectBobbitDir(rootPath, opts)`, `ArchiveError`,
  `ArchiveResult`. **Single source of truth** for the allowlist.
- `src/server/server.ts` — `/api/projects/preflight` and
  `/api/projects/archive-bobbit` route handlers, plus the
  `code: "preflight_failed"` branch on `POST /api/projects`.
- `src/server/agent/project-registry.ts` — `register()` re-runs preflight as
  a final guard and throws `PreflightFailedError` on any `fail` check.
- `src/app/dialogs.ts` — `renderPreflightPanel()` in the Add Project dialog
  and the archive confirmation modal.

### Pinning test: the allowlist cannot drift

`tests/bobbit-archive-allowlist.test.ts` walks every `.ts` file under
`src/server/`, finds every literal child segment joined onto
`bobbitStateDir(...)`, and asserts each distinct segment is either covered by
`GATEWAY_OWNED_FILES` or annotated with `// archive-safe` at the write site.

When you add a new server-level state writer:

1. If the file is gateway-owned (cross-project state, server scratch, etc.) →
   add the segment to `GATEWAY_OWNED_FILES` in `bobbit-archive.ts`.
2. If the file is genuinely project-scoped and *should* be archived when the
   user starts fresh → add `// archive-safe` on the write line.

Anything else fails the test. This is deliberate — silent drift in either
direction is a real bug (archiving gateway state kills the server; failing to
archive project state leaks old data into a "fresh" project).

`bobbitConfigDir()` writes (under `config/`) are user-editable project config
(`system-prompt.md`, `tools/`, `mcp.json`) and are **always** archived. Do
not add `config/...` entries to the allowlist.

### Adding a new preflight check

1. Pick a stable `id` namespaced by topic (e.g. `path.foo`, `bobbit.bar`).
   The UI uses it for `data-check-id` attributes and remediation hooks.
2. Decide the bad level: `fail` only if it should block submission, otherwise
   `warn`. Reserve `fail` for unambiguous "this cannot work" cases.
3. Append a push to the `checks` array inside `runPreflight()` in
   `src/server/agent/project-preflight.ts`. Always emit *some* check, even
   when the precondition is unmet — use a `warn` with `"Not checked: …"` so
   the UI still shows a row.
4. If the check carries a UI affordance, add a `remediation` of one of the
   known kinds (`archive-bobbit`, `use-canonical`, `shorter-path`,
   `free-space`, `external`) and handle it in `renderPreflightPanel()`.
5. Add a unit test in `tests/project-preflight.test.ts` covering both the
   pass and bad paths with a `file://` fixture.
6. If it changes the Submit gating, extend the browser E2E in
   `tests/e2e/ui/add-project-preflight.spec.ts`.

The full check spec including detection logic for each id lives in
[design/robust-add-project.md](design/robust-add-project.md) and is the
canonical reference if the source and this page disagree.

## REST endpoint reference

Both endpoints require the standard `Authorization: Bearer <token>` header.
See [rest-api.md](rest-api.md) for the surrounding `/api/projects` surface.

### `GET /api/projects/preflight?path=<absolute>`

Returns a structured `PreflightReport` for the candidate `rootPath`. The
endpoint always returns 200 when a `path` is supplied — failures are *the*
response, not an error condition. 400 only when the query parameter is
missing or malformed.

Response shape:

```json
{
  "rootPath": "/abs/path",
  "canonical": "/abs/path",
  "hasFail": false,
  "checks": [
    {
      "id": "path.absolute",
      "level": "pass",
      "title": "Absolute path",
      "detail": "Path is absolute."
    },
    {
      "id": "bobbit.existing",
      "level": "warn",
      "title": "Existing .bobbit/ found",
      "detail": "Found existing .bobbit/ contents: 2 sessions, 1 goal, 4 config files. You can archive this aside into .bobbit-archive-NNN/ before registering.",
      "remediation": {
        "kind": "archive-bobbit",
        "label": "Archive existing .bobbit/",
        "payload": { "rootPath": "/abs/path", "summary": "2 sessions, 1 goal, 4 config files" }
      }
    }
  ]
}
```

| Status | Body | When |
|--------|------|------|
| 200 | `PreflightReport` | Always when `path` is supplied. |
| 400 | `{ error: "Missing path query parameter" }` | `path` missing or not a string. |
| 500 | `{ error, stack }` | Unexpected server failure inside `runPreflight`. |

### `POST /api/projects/archive-bobbit`

Body: `{ "rootPath": "/abs/path" }`. Archives `<rootPath>/.bobbit/` content
into `<rootPath>/.bobbit-archive-NNN/`, applying the `GATEWAY_OWNED_FILES`
allowlist when the path is detected as gateway-owned (same detection as the
preflight check: matches `getProjectRoot()`, has `state/gateway-url`, or has
`state/watchdog.json`). Does **not** mutate the project registry — callers
should re-run preflight after a successful archive.

Response shape on 200:

```json
{
  "archiveDir": "/abs/path/.bobbit-archive-001",
  "archivedAt": "2026-05-11T10:23:45.000Z",
  "movedPaths": ["config/system-prompt.md", "state/goals/"],
  "preservedPaths": ["state/gateway-url", "state/tls/"],
  "gatewayOwned": true,
  "partial": {
    "failed": [{ "path": "state/locked.bin", "error": "EBUSY: ..." }]
  }
}
```

`partial` is omitted entirely when every entry moved successfully. The same
JSON is written to `<archiveDir>/MANIFEST.json` for audit.

| Status | Body | When |
|--------|------|------|
| 200 | `ArchiveResult` | Success (including partial-failure). |
| 400 | `{ error: "Missing rootPath" }` | Body missing or wrong shape. |
| 400 | `{ error: "rootPath must be absolute" }` | Path is relative. |
| 400 | `{ error: "rootPath does not exist" }` | Path missing on disk. |
| 400 | `{ error, code: "bad-path" }` | Path exists but is not a directory. |
| 409 | `{ error, code: "no-bobbit-dir" }` | `<rootPath>/.bobbit/` does not exist. |
| 409 | `{ error, code: "empty-bobbit-dir" }` | `.bobbit/` exists but has nothing to archive. |
| 500 | `{ error, stack }` | Unexpected server failure. |

### `POST /api/projects` — preflight rejection

Server-side `projectRegistry.register()` re-runs preflight as a final guard.
If any check fails, the request is rejected with:

```
HTTP 400
{
  "error": "Project preflight failed for /abs/path: <failing-check ids>",
  "code": "preflight_failed",
  "report": { "rootPath": ..., "checks": [...], "hasFail": true, ... }
}
```

This is independent of the existing `code: "symlink_root"` envelope, which
still fires from the same endpoint when the path is a symlink and
`acceptCanonical: true` is not set. Clients should handle both codes.

## See also

- [design/robust-add-project.md](design/robust-add-project.md) — full design
  including check catalogue, allowlist derivation, and open questions.
- [rest-api.md](rest-api.md) — full REST surface.
- [internals.md — Project assistant](internals.md#project-assistant) — the
  larger Add Project flow this pre-flight slots into.
