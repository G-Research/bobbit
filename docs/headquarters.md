# Headquarters project

Headquarters is Bobbit's built-in, user-facing server workspace. It exists so a fresh server is immediately usable without first adding a project, and so experienced users have one stable place for server-level configuration and cross-project coordination.

## Identity and startup

On startup Bobbit ensures a registered project with these server-owned fields:

| Field | Value |
|---|---|
| `id` | `headquarters` |
| `name` | `Headquarters` |
| `kind` | `headquarters` |
| `rootPath` | the server run directory (`getProjectRoot()`) |

Headquarters is not created through the Add Project flow. It bypasses normal project preflight because the server directory is intentionally gateway-owned.

The hidden internal project with id `system` still exists for compatibility. It remains a non-UI persistence anchor for server-scope assistant sessions that do not belong to user work, such as some role/tool authoring flows. Do not expose `system` as a second global scope in the UI; user-facing server scope is Headquarters.

## Storage model

Headquarters aliases the existing server `.bobbit` directories instead of owning an independent project tree:

- Bobbit dir: `bobbitDir()`
- State dir: `bobbitStateDir()`
- Config dir: `bobbitConfigDir()`

This matters when `BOBBIT_DIR` redirects server state/config away from `<server run dir>/.bobbit`. Headquarters follows the server-level location, not a hardcoded path under its `rootPath`.

Normal projects still use `<project root>/.bobbit/state` and `<project root>/.bobbit/config`. The hidden `system` project remains isolated under the server state directory's `system-project` anchor.

## Config scope rules

Headquarters is the user-facing alias for server/global configuration, not an extra project layer above it.

### Non-workflow config aliases server scope

For non-workflow config, a request with `projectId=headquarters` is normalized to server scope. This keeps one source of truth and avoids duplicate global overrides.

Applies to:

- roles and role field resolution (`model`, `thinkingLevel`, `promptTemplate`);
- tools;
- tool group policies;
- skills and configured config directories;
- marketplace pack ordering/activation and contributed MCP/PI surfaces;
- role/tool mutation paths that accept a project id.

A role or tool written with `projectId=headquarters` is stored in server config and reports origin `server`. The UI labels that origin as **Headquarters** so users do not see both `System` and `Headquarters`.

### Workflows remain project-scoped

Workflows are the exception. They remain project-scoped and are read from `project.yaml::workflows` for the selected project.

- `resolveWorkflows("headquarters")` reads the Headquarters project config store, which aliases `bobbitConfigDir()/project.yaml`.
- `resolveWorkflows(undefined)` still returns an empty list; there is no system workflow cascade.

This lets Headquarters own its own workflow list without introducing a second global workflow scope.

## Project lists, ordering, and visibility

`GET /api/projects` includes Headquarters by default and lists it first. The hidden `system` project is always excluded.

The `showHeadquartersInProjectLists` preference controls presentation only:

- absent or `true`: Headquarters appears in normal project lists, sidebar groups, and project pickers;
- `false`: Headquarters is omitted from those normal lists;
- explicit `GET /api/projects/headquarters` and explicit `projectId: "headquarters"` resolution still work;
- existing Headquarters sessions, goals, staff, config, and persisted state are not deleted or archived.

When Headquarters is hidden and no normal projects are visible, the UI shows an escape hatch with **Quick Session in Headquarters**, **Show Headquarters**, and **Add Project**.

Headquarters is anchored before normal projects and is excluded from user drag-reorder payloads. Normal projects keep their persisted order after it.

## Immutability and Add Project safeguards

Headquarters is server-owned. Users can hide it, but not remove or retarget it.

Guarded actions return structured errors instead of mutating server state:

- `DELETE /api/projects/headquarters` returns `403` with `code: "HEADQUARTERS_IMMUTABLE"`.
- `PUT /api/projects/headquarters` for normal project mutation is forbidden.
- Adding or moving another project to the server workspace returns `HEADQUARTERS_ALREADY_EXISTS` or the existing Headquarters project for idempotent upserts.
- Add Project preflight for the server workspace explains that Headquarters already owns it and does not offer destructive archive remediation.
- `/api/projects/archive-bobbit` refuses to archive the server-owned `.bobbit` state.

Deleting the last normal project is allowed; Headquarters remains as the built-in workspace unless the visibility preference hides it.

## Sessions, staff, and cross-project orchestration

Headquarters can run regular sessions and staff agents with `projectId: "headquarters"`. Their default cwd is the server run directory.

Fresh-server UX uses this directly:

- the splash primary action is **Quick Session**;
- if Headquarters is the only visible project, session and staff creation skip the project picker;
- adding a normal project later makes pickers list Headquarters first with helper text **Server workspace**.

Headquarters sessions/staff can inspect and coordinate other registered projects through existing Bobbit APIs and tools where those APIs permit cross-project access. Headquarters does not add a special support agent or bypass normal authorization/tool semantics.

## Goals without git worktrees

Headquarters goals support explicit no-worktree/data-only operation. A `POST /api/goals` request with `projectId: "headquarters"` and `worktree: false` can reach `setupStatus: "ready"` without `branch`, `worktreePath`, or `repoPath`.

Data-oriented flows continue to work, including:

- listing and archiving goals;
- gates and gate signals;
- tasks;
- archived-goal listing by `projectId=headquarters`.

Git-dependent goal affordances are guarded. Endpoints such as goal git status, diff, commits, PR status, PR merge, and child-goal merge return `409` with `code: "GOAL_GIT_UNAVAILABLE"` when a goal has no branch/worktree. The UI shows the Headquarters no-worktree notice and hides branch, merge, reset, fork, and PR actions instead of falling back to the server `HEAD` checkout.

Canonical copy:

> This Headquarters goal runs in the server directory without a git worktree. Git branch, merge, and PR actions are unavailable.

## Icon and UI identity

Headquarters uses the Lucide `TowerControl` icon anywhere a normal project would show the project/folder identity, including:

- sidebar project header;
- project/session/staff/goal pickers;
- settings and config scope rows;
- config origin/scope affordances where icon space exists.

Normal projects keep the usual folder/project icon and palette styling. Headquarters should not be represented as a normal color dot.

## Migration behavior

Startup repairs older state into the Headquarters model:

- an existing normal project rooted at the server run directory is promoted to `id: "headquarters"`;
- structured references in central state are rewritten to the stable id;
- central state files are not renamed away when Headquarters aliases `bobbitStateDir()`;
- search indexes affected by an id rewrite are dropped/rebuilt;
- backup files and migration markers are written so the process is idempotent and auditable.

The compatibility `system` project is not migrated into Headquarters. It remains hidden and isolated for internal persistence paths.
