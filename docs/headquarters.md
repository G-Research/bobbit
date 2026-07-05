# Headquarters project

Headquarters is Bobbit's built-in, user-facing server workspace. It exists so a fresh server is immediately usable without first adding a project, and so experienced users have one stable place for server-level configuration and cross-project coordination.

**Why it is physically separated from normal projects.** Headquarters represents the server/global scope, but Bobbit is often started from a directory that is *also* a normal Bobbit project. Earlier designs promoted that same-root normal project into Headquarters, which silently renamed the user's project. Headquarters now lives in its own directory (`.bobbit/headquarters/`) so the two scopes coexist as distinct visible projects and never fight over the same state. See [Same-root coexistence](#same-root-coexistence) below.

## Identity and startup

On startup Bobbit ensures a registered project with these server-owned fields:

| Field | Value |
|---|---|
| `id` | `headquarters` |
| `name` | `Headquarters` |
| `kind` | `headquarters` |
| `rootPath` | the Headquarters directory (`headquartersDir()`) |

Headquarters is not created through the Add Project flow. It is auto-ensured and repaired if an older record drifts (`ProjectRegistry.ensureHeadquartersProject(headquartersDir())`).

The hidden internal project with id `system` still exists for compatibility. It remains a non-UI persistence anchor for server-scope assistant sessions that do not belong to user work (some role/tool authoring flows). Do not expose `system` as a second global scope in the UI; the user-facing server scope is Headquarters.

## Storage model

Server-level state and config live inside a single **Headquarters directory**, resolved by `headquartersDir()` in `src/server/bobbit-dir.ts`:

| Resolution | Headquarters directory |
|---|---|
| Default | `<server-run-dir>/.bobbit/headquarters` |
| `BOBBIT_DIR` set | `$BOBBIT_DIR` |
| `BOBBIT_PI_DIR` set (legacy alias, `BOBBIT_DIR` unset) | `$BOBBIT_PI_DIR` |

Under that directory:

```text
<headquarters-dir>/
  state/     # bobbitStateDir()  — projects.json, preferences, HQ goals/sessions/staff, gateway runtime, proposal drafts, preview state, ...
  config/    # bobbitConfigDir() — server-scope roles/tools/policies, project.yaml (HQ workflows)
```

Key points:

- `BOBBIT_DIR` overrides the **Headquarters directory itself**, not a normal project's `.bobbit`. When set, server state/config are `$BOBBIT_DIR/state` and `$BOBBIT_DIR/config` (used in place, not nested under `headquarters/`).
- The Headquarters project's `rootPath` and default cwd are the Headquarters directory, not `<server-run-dir>`.
- All server/global persistence lives here: preferences, project registry, server config, hidden `system` anchor, HQ sessions/goals/staff, gateway runtime state, proposal drafts, preview state, MCP/tool runtime state.
- `<server-run-dir>/.bobbit/state` and `<server-run-dir>/.bobbit/config` are reserved for a normal project registered at the server run directory. Headquarters never claims those paths.

Helpers in `bobbit-dir.ts`: `headquartersDir(projectRoot?)`, `serverBobbitDir()` (alias, no arg), `bobbitDir()`/`bobbitStateDir()`/`bobbitConfigDir()` (server/HQ helpers), and `normalProjectBobbitDir(projectRoot)` for normal-project code. Normal-project code must never call `bobbitDir()`.

### Live server secrets exception

Live server secrets are the one thing that does **not** live inside the Headquarters directory. The admin bearer `token`, TLS material (`tls/`), and sandbox-agent auth (`sandbox-agent-auth/`) are stored under `serverSecretsDir()`, an OS-user-level directory **outside any project root**.

Why: the default Headquarters directory is `<server-run-dir>/.bobbit/headquarters`, a descendant of a same-root normal project's cwd. If the admin token lived there, a project agent could read it and escalate to gateway-wide API access. `serverSecretsDir()` resolves to:

1. `BOBBIT_SECRETS_DIR` when set (required for test isolation);
2. otherwise an OS user directory (`%APPDATA%`, `~/Library/Application Support`, or `$XDG_STATE_HOME`) plus `bobbit/secrets/<hash>`, where `<hash>` is derived from `headquartersDir()` so multiple servers on one machine do not collide.

Token/TLS readers are relocation-aware: writes always target `serverSecretsDir()`, and a legacy copy under the HQ/legacy state dir is read only as a fallback. Startup migration relocates any legacy live secret out to `serverSecretsDir()` and strips the project-reachable copy — this step is **fatal by design** if a secret cannot be provably removed. Secrets are never archived by `archive-bobbit`.

## Same-root coexistence

Starting Bobbit in a directory already registered as a normal project yields **two distinct visible projects**: `headquarters` and the original normal project. They never merge.

- The normal same-root project keeps its id, name, kind, icon, ordering position, sessions, goals, staff, workflows, project-scoped config, and its normal `<root>/.bobbit/{state,config}` layout.
- Headquarters uses the Headquarters directory for storage and default cwd.
- A normal same-root project is **never** promoted, renamed, deleted, reordered, or reference-rewritten solely because its root equals the server run directory.

### Registration rules

- `register()` rejects duplicate *normal* projects by canonical path. Special projects (`headquarters`, `system`) do not block registering a normal project at the server run directory, because Headquarters' physical root is `headquartersDir`, not the server run directory.
- Registering a normal project at `headquartersDir` itself is rejected as a special-project collision.

### Add Project / preflight for the server run directory

For a candidate `rootPath === <server-run-dir>`:

- Adding it as a normal project is allowed (with explicit intent) when no normal project is already registered there.
- Preflight shows a **warning, not a failure**: Headquarters uses `<server-run-dir>/.bobbit/headquarters`; adding this path creates a separate normal project using `<server-run-dir>/.bobbit/{state,config}`.
- It does **not** return `HEADQUARTERS_ALREADY_EXISTS` just because the candidate equals the server run directory.
- A duplicate normal project at the server run directory is still rejected as a normal duplicate.
- Archive/destructive remediation never touches `<server-run-dir>/.bobbit/headquarters` or server secrets.

## Config scope rules

Headquarters is the user-facing alias for server/global configuration, not an extra project layer above it.

### Non-workflow config aliases server scope

For non-workflow config, a request with `projectId=headquarters` is normalized to server scope (`<headquarters-dir>/config`). This keeps one source of truth and avoids duplicate global overrides. Applies to:

- roles and role field resolution (`model`, `thinkingLevel`, `promptTemplate`);
- tools and tool group policies;
- skills and configured config directories;
- marketplace pack ordering/activation and contributed MCP/PI surfaces;
- role/tool mutation paths that accept a project id.

A role or tool written with `projectId=headquarters` is stored in server config and reports origin `server`. The UI labels that origin as **Headquarters** so users do not see both `System` and `Headquarters`.

### Workflows remain project-scoped

Workflows are the exception. They remain project-scoped, read from `project.yaml::workflows`.

- `resolveWorkflows("headquarters")` reads the Headquarters project config store, which aliases `<headquarters-dir>/config/project.yaml`.
- `resolveWorkflows(undefined)` returns an empty list; there is no system workflow cascade.

## Project lists, ordering, and visibility

`GET /api/projects` includes Headquarters by default and lists it first. The hidden `system` project is always excluded.

The `showHeadquartersInProjectLists` preference controls presentation only:

- absent or `true`: Headquarters appears in normal project lists, sidebar groups, and project pickers;
- `false`: Headquarters is omitted from those normal lists;
- explicit `GET /api/projects/headquarters` and explicit `projectId: "headquarters"` resolution still work;
- existing Headquarters sessions, goals, staff, config, and persisted state are not deleted or archived.

The preference is presentation-only and persists across reload/restart. When Headquarters is hidden and no normal projects are visible, the UI shows an escape hatch with **Quick Session in Headquarters**, **Show Headquarters**, and **Add Project**.

Headquarters is anchored before normal projects and is excluded from user drag-reorder payloads (`ProjectRegistry.setVisibleOrder()` returns Headquarters first, then normal projects by position). Deleting the same-root normal project removes only that entry and never removes or hides Headquarters.

## Immutability and Add Project safeguards

Headquarters is server-owned. Users can hide it, but not remove or retarget it.

- `DELETE /api/projects/headquarters` returns `403` with `code: "HEADQUARTERS_IMMUTABLE"`.
- `PUT /api/projects/headquarters` for normal project mutation is forbidden.
- Adding or moving another project to the Headquarters directory returns `HEADQUARTERS_ALREADY_EXISTS` or the existing Headquarters project for idempotent upserts.
- `/api/projects/archive-bobbit` refuses to archive Headquarters/server state, explicitly skips `headquarters/`, and never destroys legacy gateway files as part of normal-project remediation.

Deleting the last normal project is allowed; Headquarters remains as the built-in workspace unless the visibility preference hides it.

## Sessions, staff, and default cwd

Headquarters runs regular sessions and staff agents with `projectId: "headquarters"`. Their default cwd is the **Headquarters directory** (`headquartersDir`), not the server run directory — this keeps Headquarters sessions from accidentally operating on the server run directory's git checkout.

Fresh-server UX uses this directly:

- the splash primary action is **Quick Session**;
- if Headquarters is the only visible project, session and staff creation skip the project picker;
- adding a normal project later makes pickers list Headquarters first with helper text **Server workspace**.

## No worktrees, no git

Headquarters must not use normal git/worktree/project lifecycle behavior. For `projectId === "headquarters"`:

- goals, sessions, staff, team agents, reviewers, and verification/review sub-sessions are forced to `worktree: false`; a `worktree: true` request is coerced to `false`.
- `resolveWorktreeSupport()`, `createWorktree()`, `createWorktreeSet()`, and `WorktreePool` are never invoked; `GET /api/worktree-pool?projectId=headquarters` returns an empty/unavailable response and never fills a pool.
- A `POST /api/goals` request with `projectId: "headquarters"` and `worktree: false` reaches `setupStatus: "ready"` without `branch`, `worktreePath`, or `repoPath`.
- Data-oriented flows still work: listing/archiving goals, gates and gate signals, tasks, and archived-goal listing by `projectId=headquarters`.

Git-dependent goal affordances are guarded. Endpoints such as goal git status, diff, commits, PR status, PR merge, and child-goal merge return `409` with `code: "GOAL_GIT_UNAVAILABLE"` when a goal has no branch/worktree. The UI hides branch, merge, reset, fork, and PR actions and shows a notice referring to the Headquarters directory, not the server git checkout.

Canonical copy:

> This Headquarters goal runs in the Headquarters directory without a git worktree. Git branch, merge, and PR actions are unavailable.

## Icon and UI identity

Headquarters uses the Lucide `TowerControl` icon anywhere a normal project would show project/folder identity:

- sidebar project header;
- project/session/staff/goal pickers;
- settings and config scope rows;
- config origin/scope affordances where icon space exists.

Normal projects keep the usual folder/project icon and palette styling. Headquarters is not represented as a normal color dot.

## Migration and repair on first boot

Startup runs `migrateLegacyHeadquartersDirectory()` (`src/server/agent/state-migration.ts`) before `ProjectRegistry` loads. It moves legacy server/HQ state into the Headquarters directory and repairs installs that were promoted by the earlier design. It is idempotent (guarded by the `.headquarters-dir-migrated` marker) and preserve-first — it copies/merges and never deletes legacy files during automatic migration.

- **Server-scope files** (`projects.json`, `preferences.json`, `setup-complete`, `gateway-url`, `session-prompts/`, `proposal-drafts/`, `preview/`, marketplace/MCP runtime state, hidden `system` anchor, ...) are moved into `<headquarters-dir>/state`.
- **Per-project stores** (`goals.json`, `sessions.json`, `staff.json`, `tasks.json`, gates, costs, search indexes) are attributed by rule: records with a current normal `projectId` route to that project; records restorable from a `.pre-headquarters-id-migration` backup as a same-root normal project are restored to `<server-run-dir>/.bobbit/state` under the old id; missing-`projectId` records are treated as ambiguous when a same-root normal project exists and are preserved in the legacy normal-project state (not surfaced under Headquarters); only records with no same-root normal evidence are stamped `projectId: "headquarters"`.
- **Config quarantine.** `<server-run-dir>/.bobbit/config` is dangerous because it is also the same-root normal project's config path. When a same-root normal project or reliable backup exists, that config stays normal-project config; ambiguous server candidates are copied to a quarantine location (`<headquarters-state-dir>/migration-quarantine/config/...`) and are **not** loaded by any config store, MCP discovery, or marketplace code. Only deterministic server-scope config is activated in `<headquarters-dir>/config`.
- **Repair.** `migrateHeadquartersProjectAliases` no longer promotes same-root normal projects. If a `.pre-headquarters-id-migration` backup shows a normal project rooted at the server run directory and the current registry lacks it, the normal project record is restored (id, name, kind, icon, order, workflows, config) while the Headquarters record is kept/repaired separately.

Diagnostics are written to `<headquarters-state-dir>/headquarters-migration-diagnostics.json` (source paths, copied/merged/quarantined files, ambiguous records, restored normal ids, previous-override hints, failures). User work is never silently moved between Headquarters and a normal project without a deterministic rule or a visible diagnostic.

## Related docs

- [internals.md — Headquarters project](internals.md#headquarters-project) and [projectId-required API contract](internals.md#projectid-required-api-contract).
- [rest-api.md](rest-api.md) for the project and goal endpoints.
- [security.md](security.md) for the admin token storage location and access controls (the token is stored in `serverSecretsDir()` outside any project root).
