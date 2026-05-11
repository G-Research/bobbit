# Robust add-project validation

Status: draft (design-doc gate)
Owner: goal `goal-robust-add-eee03bdd`

## Problem

The "add project" dialog only validates: absolute path, exists, not a symlink (via a confirm modal), no duplicate. Everything else — readability, writability, nesting under another project or worktree, existing `.bobbit/` contents, network paths, long-path limits, free disk — fails implicitly, often *after* a session has been spawned. Users hit cryptic errors, half-registered state, or worse: corrupted gateway state when the new project accidentally points at the gateway's own working directory.

This doc specifies a structured pre-flight validation pass plus an opt-in "start fresh" flow that archives existing project-scoped `.bobbit/` content while never touching gateway-owned files.

## Goals

1. Surface every reason a `rootPath` is bad *before* the user clicks Submit, with `pass | warn | fail` levels and human-readable explanations.
2. Give users a safe, auditable way to wipe existing `.bobbit/` content at a path (archive, not delete) — without ever clobbering gateway-owned state.
3. Defense-in-depth: client AND server run the same preflight; `projectRegistry.register()` re-runs it as a final guard.

## Non-goals

- Auto-fix permissions (chmod / chown). Report only.
- Migrating an already-registered project to a new path.
- A general-purpose "undo archive" button. The manifest file is enough for manual undo.
- New multi-repo scan UI behaviour. Preflight runs per-`rootPath`; multi-repo scan can call it per detected repo later.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Add-project dialog (src/app/dialogs.ts)                            │
│   ├── path input (debounced)                                       │
│   ├── PreflightPanel ──→ GET /api/projects/preflight?path=…        │
│   │     └─ renders pass/warn/fail list                             │
│   │     └─ inline action: "Archive existing .bobbit/" on warn      │
│   └── Submit (disabled while any fail)                             │
│             │                                                      │
│             ├── POST /api/projects/archive-bobbit (optional)       │
│             └── POST /api/projects { name, rootPath, … }           │
│                       └── projectRegistry.register()               │
│                            └── runPreflight() — final guard        │
└────────────────────────────────────────────────────────────────────┘
```

New modules:

- `src/server/agent/project-preflight.ts`
  - `runPreflight(rootPath: string, ctx: { registry: ProjectRegistry; gatewayProjectRoot: string }): PreflightReport`
  - Pure-ish: only stat / readdir / mkdir-probe on disk; no mutation of registry state.
- `src/server/agent/bobbit-archive.ts`
  - `GATEWAY_OWNED_FILES: readonly string[]` — single source of truth allowlist.
  - `archiveProjectBobbitDir(rootPath: string, opts: { gatewayOwned: boolean }): ArchiveResult`.

New endpoints in `src/server/server.ts::handleApiRoute()`:

- `GET /api/projects/preflight?path=<abs>` → `PreflightReport`.
- `POST /api/projects/archive-bobbit` body `{ rootPath: string }` → `ArchiveResult`. Client re-runs preflight afterwards.

`projectRegistry.register()` calls `runPreflight()` and throws on any `fail` check. The existing `SymlinkProjectRootError` is preserved; the symlink check appears in the preflight report as a `warn` AND continues to surface as the existing confirm modal so we don't regress the established `acceptCanonical` flow.

## Types

```ts
export type PreflightLevel = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;                       // stable, used by UI for remediation hooks
  level: PreflightLevel;
  title: string;                    // short, user-facing
  detail: string;                   // 1–2 sentence explanation
  remediation?: {
    kind: "archive-bobbit" | "use-canonical" | "shorter-path" | "free-space" | "external";
    label: string;                  // CTA label
    payload?: Record<string, unknown>;
  };
}

export interface PreflightReport {
  rootPath: string;
  canonical: string;                // realpath(rootPath) or rootPath if absent
  checks: PreflightCheck[];
  hasFail: boolean;                 // convenience: any check.level === "fail"
}
```

## Preflight checks

All checks run unconditionally; later checks degrade gracefully when earlier ones fail (e.g. `path.exists=fail` short-circuits writability probes to a `skip` represented as `warn` with `detail: "not checked: directory does not exist"`).

| id                          | level on bad | detection                                                                                                          |
|-----------------------------|--------------|--------------------------------------------------------------------------------------------------------------------|
| `path.absolute`             | fail         | `!path.isAbsolute(rootPath)`                                                                                       |
| `path.exists`               | fail         | `fs.statSync(rootPath).isDirectory()` — fail if missing, file, or stat throws                                      |
| `path.symlink`              | warn         | `detectSymlinkRoot()` — surface canonical in `detail`; remediation = `use-canonical`                                |
| `path.readable`             | fail         | `fs.accessSync(rootPath, R_OK)` AND `fs.readdirSync(rootPath)` smoke test                                          |
| `path.writable`             | fail         | `fs.accessSync(W_OK)` AND `mkdirSync(<rootPath>/.bobbit-probe-<rand>)` + `rmdirSync` (some FS lie about `W_OK`)    |
| `path.long`                 | warn         | Windows only: `process.platform === "win32" && rootPath.length > 200` (worktree paths add ~80 chars → 260 limit)  |
| `path.unc-or-network`       | warn         | `/^\\\\/.test(rootPath)` OR (Linux/macOS) heuristic match against `/mnt/`, `/media/`, network FS types via statfs    |
| `path.nested-in-project`    | fail         | `rootPath` is inside another registered project's `rootPath` OR inside its `worktree_root` (canonicalized prefix) |
| `path.contains-project`     | warn         | `rootPath` is an ancestor of an existing registered project's `rootPath`                                           |
| `path.is-worktree`          | fail         | `<rootPath>/.git` is a file whose `gitdir:` target is `<somewhere>/worktrees/<name>` (i.e. a secondary worktree)   |
| `bobbit.existing`           | info (warn)  | `.bobbit/config/` or `.bobbit/state/` exists and non-empty; `detail` summarises counts (sessions, goals, configs) |
| `bobbit.gateway-owned`      | info (warn)  | See detection below. Gates the archive UI: when true, preserved-files list is non-empty.                           |
| `git.repo`                  | info (pass)  | `<rootPath>/.git` exists. Sub-flags: bare, detached, current branch — informational, never blocking                |
| `disk.space`                | warn         | `statfs` free < 500 MB on the volume containing `rootPath`                                                          |

`info` is rendered as `pass` with a neutral icon when nothing actionable, or as `warn` when it gates a remediation (e.g. `bobbit.existing` non-empty exposes the archive CTA).

### `path.nested-in-project` detection

Canonicalize both sides via `realpathSync` (best-effort, falling back to text) and use the same case-insensitive prefix logic as `ProjectRegistry.findByCwd()`. Additionally, for each registered project compute its worktree root (`project.worktree_root ?? <rootPath>-wt`) and check containment there too.

### `path.is-worktree` detection

```ts
const gitPath = path.join(rootPath, ".git");
if (fs.existsSync(gitPath) && fs.statSync(gitPath).isFile()) {
  const content = fs.readFileSync(gitPath, "utf8");
  const m = content.match(/^gitdir:\s*(.+)$/m);
  if (m && /[\\/]worktrees[\\/][^\\/]+$/.test(m[1].trim())) {
    // secondary worktree of another repo — fail
  }
}
```

### `bobbit.gateway-owned` detection

True if **any** of:

1. `path.resolve(rootPath) === path.resolve(getProjectRoot())` from `src/server/bobbit-dir.ts` — the gateway is running with this directory as its `projectRoot`.
2. `fs.existsSync(path.join(rootPath, ".bobbit", "state", "gateway-url"))` — strongly indicates a running gateway uses this dir.
3. `fs.existsSync(path.join(rootPath, ".bobbit", "state", "watchdog.json"))` — same.

Any one is sufficient; we want false positives over false negatives because the cost of accidentally archiving gateway state is severe (kills the running server) and the cost of preserving a few extra files in a non-gateway dir is zero.

## `GATEWAY_OWNED_FILES` allowlist

Single source of truth in `src/server/agent/bobbit-archive.ts`. Paths are relative to `<rootPath>/.bobbit/`. Derived from an exhaustive grep of `bobbitStateDir()` / `bobbitConfigDir()` writers in `src/server/`:

```ts
export const GATEWAY_OWNED_FILES: readonly string[] = [
  // Cross-project gateway state — running server depends on these
  "state/gateway-url",          // server.ts via cli.ts (gateway URL discovery)
  "state/watchdog.json",        // src/server/watchdog.ts
  "state/setup-complete",       // src/server/setup-status.ts
  "state/gateway-restart",      // src/server/harness.ts SENTINEL
  "state/token",                // src/server/auth/token.ts (admin token)
  "state/sessions.json",        // global session registry (spans projects)
  "state/projects.json",        // global project registry (spans projects)

  // TLS / OAuth
  "state/tls/",                 // src/server/auth/tls.ts (ca.crt, server.crt, server.key)
  "state/desec.json",           // src/server/auth/desec.ts (DNS challenge state)

  // Regenerated per restart but kept to avoid cold-start work
  "state/tool-docs/",           // server.ts (tool-docs generation)
  "state/mcp-tool-docs/",       // src/server/mcp/mcp-manager.ts

  // Per-session scratch — only relevant while server is running
  "state/preview/",             // src/server/preview/mount.ts
  "state/tool-guard/",          // src/server/agent/tool-activation.ts
  "state/mcp-extensions/",      // src/server/agent/tool-activation.ts
  "state/html-snapshots/",      // server.ts
  "state/proposal-drafts/",     // server.ts / session-manager.ts
];
```

A pinning unit test (`tests/bobbit-archive-allowlist.spec.ts`) re-greps `src/server/` for every literal joined onto `bobbitStateDir()` / `bobbitConfigDir()` and asserts each segment is covered by the allowlist (or explicitly tagged `// archive-safe` in the comment near the write site). This prevents silent drift when new server-level state is added.

Note: `bobbitConfigDir()` writes are all user-editable project config (system-prompt.md, tools/, mcp.json). These are project-scoped and **should** be archived when the user opts in.

## Archive operation

```ts
export interface ArchiveResult {
  archiveDir: string;                    // absolute path to <rootPath>/.bobbit-archive-NNN
  archivedAt: string;                    // ISO timestamp
  movedPaths: string[];                  // relative to <rootPath>/.bobbit/
  preservedPaths: string[];              // relative to <rootPath>/.bobbit/
  gatewayOwned: boolean;
  partial?: { failed: Array<{ path: string; error: string }> };
}
```

Algorithm in `archiveProjectBobbitDir(rootPath, { gatewayOwned })`:

1. Compute `archiveDir = path.join(rootPath, ".bobbit-archive-" + nextSuffix(rootPath))` where `nextSuffix` scans for existing `.bobbit-archive-NNN` and picks the next free zero-padded 3-digit suffix starting at `001`.
2. `fs.mkdirSync(archiveDir, { recursive: true })`.
3. Build `preserveSet` = `GATEWAY_OWNED_FILES` if `gatewayOwned`, else `[]`.
4. Walk `<rootPath>/.bobbit/` BFS. For each entry:
   - If its relative path is on the preserve list (exact match OR is inside a preserved directory like `state/tls/`), record it in `preservedPaths` and skip.
   - Otherwise move it into `<archiveDir>/<relative-path>`, creating parent dirs. Use `fs.renameSync`; on `EXDEV` (cross-volume) fall back to recursive copy + `unlinkSync`/`rmSync`.
   - Record success in `movedPaths`; record failure in `partial.failed` and continue (no rollback).
5. Re-scaffold empty `<rootPath>/.bobbit/config/` and `<rootPath>/.bobbit/state/` if missing.
6. Write `<archiveDir>/MANIFEST.json` with the full result for audit / manual undo.

### Failure handling

Partial archive failure is surfaced explicitly — we do NOT attempt rollback (that risks compounding damage). The endpoint returns the `ArchiveResult` with `partial.failed` populated; the UI re-runs preflight which will show the now-mixed state truthfully. Manual undo is possible via the manifest. This matches the spec's "do not silently roll forward" requirement.

### Subtlety: walking under a preserved directory

`state/tls/` is preserved as a whole. The walk should skip-and-record at the directory level rather than recursing into it (otherwise individual files would be reported in `preservedPaths` and we'd accidentally archive an empty `state/tls/` shell). Implementation: check preservation as `entryRel === preserved || entryRel.startsWith(preserved.endsWith("/") ? preserved : preserved + "/")`, and when a directory matches, do not recurse.

## REST endpoints

### `GET /api/projects/preflight?path=<encoded>`

- Auth: bearer token (same as other `/api/projects` endpoints).
- 200 → `PreflightReport`.
- 400 → `{ error }` if `path` missing or not a string.
- Always returns 200 with the report even when checks fail (the failures are *the* response).

### `POST /api/projects/archive-bobbit`

- Body: `{ rootPath: string }`.
- 200 → `ArchiveResult`.
- 400 → `{ error }` if `rootPath` missing, not absolute, or doesn't exist.
- 409 → `{ error }` if `<rootPath>/.bobbit/` doesn't exist or is already empty.
- Does NOT mutate the registry. Client re-runs `/preflight` after.

## UI changes (`src/app/dialogs.ts`)

The add-project dialog gains a `PreflightPanel` between the path input and the Submit button. Debounce 400 ms (matching existing `runDetection`). Layout:

```
┌── Add project ──────────────────────────────────┐
│ Path: [____________________________]            │
│                                                 │
│ Pre-flight:                                     │
│   ✓ Absolute path                               │
│   ✓ Exists and readable                         │
│   ⚠ Existing .bobbit/ found (3 sessions,        │
│     2 goals) — [Archive existing .bobbit/]      │
│   ✗ Already inside project "foo" at /a/b/c      │
│                                                 │
│ [Cancel]                              [Submit]  │
└─────────────────────────────────────────────────┘
```

- Submit is disabled while `report.hasFail === true`.
- The archive CTA on the `bobbit.existing` row opens a confirm modal showing:
  - Archive target directory (`.bobbit-archive-NNN`).
  - "Will be moved" list (from a dry-run summary).
  - "Will be preserved" list (only non-empty when `bobbit.gateway-owned` is true) with an explanatory note.
- After archive, the preflight panel re-fetches. `bobbit.existing` should now report `pass`.
- The existing `SymlinkRootError` confirm modal is kept as-is and triggered by the registration call path. The `path.symlink` preflight row is informational — clicking its remediation can open the confirm modal pre-emptively, but we don't reshape the established acceptCanonical flow.

## Server wiring

- New routes in `handleApiRoute()` next to the existing `/api/projects` block.
- `projectRegistry.register()` accepts an optional `preflight?: PreflightReport` to avoid double-work when the server already ran it, but ALWAYS re-runs the failing-checks subset itself (defense in depth — never trust a cached client report).
- `runPreflight` takes the registry and `getProjectRoot()` via dependency injection so tests can pass fixture registries and fake project roots.

## Testing

### Unit (`tests/project-preflight.spec.ts`, `tests/bobbit-archive.spec.ts`)

`file://` fixtures with tmp dirs covering each check id:

- `path.absolute` — relative input rejected.
- `path.exists` — missing dir, file-not-dir, broken symlink.
- `path.symlink` — symlink to sibling dir, canonical surfaced.
- `path.readable` / `path.writable` — chmod 000 on POSIX (skipped on Windows where chmod is a no-op).
- `path.long` — Windows-only; 250-char dir name.
- `path.nested-in-project` — fixture registry with project at `/a/b`; check `/a/b/c` and `/a/b-wt/branch/c`.
- `path.contains-project` — registry at `/a/b/c`, check `/a/b` warns.
- `path.is-worktree` — fixture with `.git` file containing `gitdir: /elsewhere/.git/worktrees/x`.
- `bobbit.gateway-owned` — dir containing `.bobbit/state/gateway-url`.

Archive tests:

- Empty `.bobbit/` → 409 (or equivalent error from the module).
- `.bobbit/` with mixed content, `gatewayOwned=false` → everything moves; manifest correct.
- `.bobbit/` with mixed content, `gatewayOwned=true` → only non-allowlist files move; `gateway-url`, `watchdog.json`, `tls/` preserved; manifest lists both.
- Second archive call lands in `.bobbit-archive-002/`.
- Cross-volume rename simulated by stubbing `fs.renameSync` to throw `EXDEV` — copy fallback triggers.
- Partial failure: one file is locked / unreadable; `partial.failed` populated; other files still archived; manifest reflects truth.

Allowlist pinning test (`tests/bobbit-archive-allowlist.spec.ts`):

- Greps `src/server/` for `bobbitStateDir(`, `bobbitConfigDir(`, `path.join(bobbitState`, etc.
- For each hit, extracts the literal next segment (the immediate child name).
- Asserts every distinct segment under `state/` is either in `GATEWAY_OWNED_FILES` or annotated with `// archive-safe` near the call site.

### API E2E (`tests/e2e/projects-preflight.spec.ts`)

- `GET /api/projects/preflight?path=…` against in-process gateway with isolated tmp dirs.
- `POST /api/projects/archive-bobbit` happy path + 409 on empty `.bobbit/`.
- Combined flow: preflight → archive → preflight again → register.

### Browser E2E (`tests/e2e/ui/add-project-preflight.spec.ts`)

Required per AGENTS.md ("every user-facing feature MUST have a browser E2E"):

- Happy path: absolute path, empty dir, all green, Submit enabled, project appears in sidebar.
- Fail blocks submit: path nested inside an existing project; Submit disabled; fail row visible.
- Archive flow: dir with existing `.bobbit/`; click archive CTA; confirm modal; re-run preflight; submit succeeds; `.bobbit-archive-001/` exists on disk.
- Repeated archive: archive twice; second archive directory is `.bobbit-archive-002/`.
- Gateway-owned preservation: simulate by writing `state/gateway-url` into the fixture dir; archive shows non-empty "preserved" list; file remains in place afterwards.

### `npm run check`, `npm run test:unit`, `npm run test:e2e` all pass.

## Open questions

1. **Should `path.symlink` block submit?** Existing behaviour is a confirm modal that auto-rewrites to canonical and proceeds. Keeping it as `warn` (not `fail`) preserves the established acceptCanonical UX. Decision: keep as `warn`, surface the existing modal at submit time.
2. **`disk.space` threshold.** 500 MB is arbitrary. Acceptable for v1; we can tune later. Surface the actual free amount in `detail` so the user can judge.
3. **UNC/network detection on POSIX.** Best effort only — `statfs` `f_type` matching for `nfs`, `cifs`, `fuse.sshfs` etc. is fragile across kernels. Initial impl: Windows UNC only (`^\\\\`); leave POSIX network detection as a follow-up if we see real reports of worktree breakage on NFS.
4. **Atomicity of archive across volumes.** Cross-volume copy+unlink is non-atomic by definition. We accept this and rely on the manifest for auditability. A future improvement could `fsync` parent dirs, but the cost/benefit isn't compelling for v1.

## Migration / compatibility

- Existing registered projects: no migration needed. Preflight is purely additive to the add-project flow.
- Existing `SymlinkRootError` code path: untouched.
- `projectRegistry.register()` gains the preflight guard; current callers (server.ts add-project route, registerSystemProject, etc.) need to either pass `acceptCanonical` for known-good paths or, for the system project case, bypass via a new `skipPreflight` opt (justified: the gateway's own working directory is the canonical "gateway-owned" path and would obviously fail `path.nested-in-project` against itself in some edge cases). Will be confirmed during implementation.

## Risks

- **False positive on `bobbit.gateway-owned`** for a fresh project dir that happens to contain a stale `gateway-url` file — preserves more than necessary on archive. Mitigation: the manifest makes it visible; user can manually remove.
- **Allowlist drift** if a new server-level write site is added without updating `GATEWAY_OWNED_FILES`. Mitigation: pinning test described above.
- **Long preflight on slow/network paths** — `mkdir` + `rmdir` probes hit disk. Mitigation: 400 ms debounce on the input; the server endpoint has a hard timeout. Future: cache by `(rootPath, mtime)` if it becomes a problem.
