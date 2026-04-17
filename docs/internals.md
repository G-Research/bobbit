# Bobbit — Internals Reference

Deep-dive documentation for subsystems. Agents: read this when working in the relevant area, not on every task.

## Multi-project architecture

A single Bobbit server manages N registered projects, each with its own `.bobbit/` directory, config, state, sessions, and goals. This enables teams to work across multiple codebases from one browser instance.

### Why multi-project?

Without multi-project support, running multiple Bobbit instances (one per project) means separate browser tabs, separate auth tokens, and no cross-project search. Multi-project lets a single server manage everything — sessions and goals are scoped per project, config cascades from global to project, and search works across all projects by default.

### Project Registry

`ProjectRegistry` (`project-registry.ts`) persists registered projects to `<server-cwd>/.bobbit/state/projects.json`. Each project is a `RegisteredProject`:

```typescript
interface RegisteredProject {
  id: string;        // UUID
  name: string;      // Display name (e.g. "my-api")
  rootPath: string;  // Absolute path to project directory
  createdAt: number; // Epoch ms
  color?: string;    // Optional accent color for sidebar grouping
}
```

Key behaviors:
- On startup, the server auto-registers the CWD as the "default" project via `ensureDefaultProject()` — but **only if `projects.json` already exists** in the state directory (i.e. not a fresh install). A truly fresh folder starts with zero projects; the user adds one explicitly via the "Add Project" flow. This prevents Bobbit from assuming every directory it runs in is a project.
- `register()` validates `rootPath` is absolute and exists on disk, checks for duplicate paths, and scaffolds `.bobbit/config/` and `.bobbit/state/` in the project directory if needed. `POST /api/projects` supports `upsert: true` — if a project already exists at the same `rootPath`, the existing project is returned (200) instead of a 400 error. This makes project registration idempotent.
- `remove()` only unregisters — it does not delete files. Callers guard against removing the default project.
- The per-project settings page General tab exposes a "Remove Project" button in a Danger Zone section (hidden for the default project). On confirmation, it calls `DELETE /api/projects/:id`, which invokes `remove()` and navigates the user back to system settings.
- Persistence is atomic (write to `.tmp` then rename).

### Per-project state isolation

Each registered project is a self-contained unit on disk. State (goals, sessions, tasks, teams, gates, search, costs) lives in `<project-root>/.bobbit/state/`, not in a central directory. The server aggregates across all projects.

```
<project-root>/.bobbit/
  config/          # Project config (roles, tools, etc.)
  state/
    goals.json     # Goals for THIS project
    sessions.json  # Sessions for THIS project
    tasks.json     # Tasks for THIS project's goals
    team-state.json # Team state
    gates.json     # Gate state and signals
    staff.json     # Staff agents
    search.db      # Search index for THIS project
    costs/         # Cost tracking

<server-cwd>/.bobbit/
  state/
    projects.json     # Global project registry (only truly global state)
    preferences.json  # Global UI preferences
    token             # Auth token
    gateway-url       # Gateway address
    colors.json       # Session colors
```

This means removing a project cleanly removes its state, and pointing a different Bobbit instance at a project directory gives access to its history.

### ProjectContext (scoped stores)

`ProjectContext` (`project-context.ts`) holds a complete set of stores scoped to one project. Every store constructor accepts a directory parameter (`stateDir` or `configDir`) instead of using module-level globals:

- **State stores** (stateDir): GoalStore, SessionStore, GateStore, TaskStore, TeamStore, StaffStore, ColorStore, SearchIndex, CostTracker
- **Config stores** (configDir): RoleStore, PersonalityStore, WorkflowStore, ToolManager, ProjectConfigStore, ToolGroupPolicyStore
- **Managers**: GoalManager (wraps GoalStore)

Directories derive from the project's `rootPath`:
- `stateDir` = `<rootPath>/.bobbit/state/`
- `configDir` = `<rootPath>/.bobbit/config/`

`ProjectContext.open()` initializes the search index and wires mutation hooks so goal/session changes are automatically indexed. `ProjectContext.close()` flushes the session store and closes the search index.

### ProjectContextManager

`ProjectContextManager` (`project-context-manager.ts`) is the central registry of `ProjectContext` instances. It initializes a context for each registered project on startup and provides aggregation methods for cross-project queries.

Key responsibilities:
- **Lazy creation**: `getOrCreate(projectId)` — creates and opens a context on first access
- **Store routing**: `getContextForGoal(goalId)` / `getContextForSession(sessionId)` — scans all contexts to find the owning project
- **Aggregation**: `getAllLiveGoals()`, `getAllLiveSessions()`, `searchAll()` — merge results across all projects
- **Generation counters**: Sums per-project generation counters so clients detect any change via a single `?since=N` parameter
- **Lifecycle**: `closeAll()` on shutdown, `remove(projectId)` when a project is unregistered

All API endpoints and WebSocket handlers resolve the correct per-project store through `ProjectContextManager` rather than accessing stores directly. Managers (`GoalManager`, `TaskManager`) accept store instances directly — they no longer create stores internally. `StaffManager` accepts `ProjectContextManager` and resolves the correct per-project `StaffStore` on each operation, matching the aggregation pattern used by goals and sessions.

#### Store resolution pattern

Store resolution **never falls back to a default project**. Every operation resolves its store through one of these paths:

1. **Entity-based resolution** — `getContextForGoal(goalId)`, `getContextForSession(sessionId)`: scans all project contexts to find the owning project. Returns `null` if not found; callers throw or return 404.
2. **Explicit projectId** — `getOrCreate(projectId)`: used when the caller already knows the target project (e.g. from a session's `projectId` field).
3. **Creation-time defaulting** — API endpoints for creating sessions, goals, and staff agents default to the server CWD project when no `projectId` is provided. This is the API contract for creation, not a store-resolution fallback — once created, the entity's `projectId` is set and all subsequent operations resolve through paths 1 or 2.

The `getDefault()` and `getDefaultProjectId()` methods are **deprecated**. They exist only for bootstrapping (constructing managers at startup) and the creation-time defaulting described above. New code must not use them for runtime store resolution. Null-safe alternatives `getDefaultOrNull()` and `getDefaultProjectIdOrNull()` are available for code paths that must handle zero-project environments gracefully (e.g. API creation endpoints return 400 "No projects configured" instead of crashing).

`SessionManager` does not hold default store fields (`this.store`, `this.costTracker`, etc.). All store access goes through PCM resolution. `TeamManager`, `StaffManager`, and `VerificationHarness` follow the same pattern — they resolve stores per-goal or per-entity via PCM, with no fallback store references. `resolveStoreForId()` returns `null` instead of falling back, and callers use optional chaining.

This design prevents a class of data corruption bugs where missing `projectId` values silently route data to the wrong project's store.

**Per-project config directory scoping:** Config directories (for MCP servers, skills, and AGENTS.md/agent files) are resolved per-project. When a session is created for a project, the pipeline resolves that project's `ProjectConfigStore` to discover its custom config directories. This means each project can define its own MCP servers, slash skills, and agent instruction files via `config_directories` in its `project.yaml`, and sessions in that project will use them. MCP discovery additionally scans all registered projects so that MCP servers defined in any project are available to all sessions (with the primary project's configs taking priority on name conflicts).

### State migration

On first startup after upgrading to per-project state, `migrateToPerProjectState()` (`state-migration.ts`) distributes centralized state to per-project directories:

1. Reads central `goals.json`, `sessions.json`, `tasks.json`, `team-state.json`, `gates.json`, `staff.json`
2. Groups records by `projectId` (tasks/teams/gates resolve via their goal's project)
3. Merges into each project's `<rootPath>/.bobbit/state/` (avoids duplicates by ID)
4. Staff agents without a `projectId` go to the default project
5. Renames central files with `.pre-migration` suffix (not deleted)
6. Writes `.bobbit/state/.migrated-to-per-project` marker to prevent re-running

The migration is idempotent and handles missing files gracefully (fresh installs have nothing to migrate). Central `search.db` is renamed — per-project indexes rebuild automatically on first access.

**What stays global**: `projects.json`, auth token, gateway URL, preferences, session colors, PR status.

**Known limitations**: `active-verifications.json` stays in the central state dir (transient operational state).

### Verification architecture

The verification system is split into two modules:
- **`verification-harness.ts`** — orchestration: session lifecycle, WS event broadcasting, process spawning, retry logic, persistence. Also implements the **blocking-tool** contract used by `verification_result`: a tool extension POSTs a verdict, which resolves the Promise registered when the gate signal started verification. The same contract is used by the `ask_user_choices` tool via `user-question-harness.ts` — see [docs/blocking-tools.md](blocking-tools.md) for the shared pattern.
- **`verification-logic.ts`** — pure functions extracted for unit testability: `substituteVars` (template variable resolution), `matchExpectFailure` (expect:failure gate evaluation), `groupStepsByPhase`/`getSortedPhases` (phased execution ordering), `partitionOptionalSteps` (optional step filtering), `buildStepCache`/`canSkipAllSteps` (cache reuse for same-commit re-signals), `isTransientReviewError`/`isTransientQaError` (transient failure detection). These are tested in `tests/verification-logic.test.ts` (~65 tests, <1s) without requiring a running server.

### Config resolution (3-tier hierarchy)

`ConfigResolver` (`config-resolver.ts`) provides hierarchical config resolution across three tiers:

```
~/.bobbit/         (global)    — lowest priority
<server-cwd>/.bobbit/  (server)    — middle
<project>/.bobbit/     (project)   — highest priority (wins)
```

Two resolution modes:

**Entity resolution** (`resolveEntities`): For named entities (roles, personalities, tools, workflows), merge by name across tiers. A project-level entity with the same name fully overrides the server/global version — no field-level merge. Entities that only exist at a higher tier remain available in all projects.

**Scalar resolution** (`resolveScalarConfig`): For `project.yaml` keys (build_command, test_command, default models, etc.), first defined value wins: project → server → global → built-in default. Returns both the resolved value and its source scope.

### Config cascade

The config cascade handles resolution of named config entities (roles, tools, personalities, workflows, tool group policies) through a three-layer merge. This is separate from `ConfigResolver`'s scalar config resolution above — it resolves entire config objects by name, not individual settings keys.

#### Why a cascade?

Without it, every project got a full independent copy of all config YAML via scaffolding. Editing the "global" version didn't propagate to existing projects, new Bobbit releases couldn't update defaults, and users couldn't tell which items were stock vs customised. The cascade makes builtins always-current and overrides explicit.

#### Architecture

```
builtin (dist/server/defaults/)  →  server (<server-cwd>/.bobbit/config/)  →  project (<project>/.bobbit/config/)
       lowest priority                                                              highest priority
```

Two modules implement this:

- **`BuiltinConfigProvider`** (`builtin-config.ts`): Reads factory defaults from `dist/server/defaults/` at runtime. These are the same files copied by `scripts/copy-defaults.mjs` at build time. Read-only, lazy-loaded with caching (`reload()` clears the cache). Mirrors the YAML parsing logic of each store (RoleStore, PersonalityStore, etc.).

- **`ConfigCascade`** (`config-cascade.ts`): Merges the three layers. Constructor takes a `BuiltinConfigProvider`, explicit `ServerStores` accessors, and `ProjectContextManager`. Provides `resolveRoles()`, `resolvePersonalities()`, `resolveWorkflows()`, `resolveTools()`, and `resolveToolGroupPolicies()` — all accepting an optional `projectId`.

Each returned item is a `ResolvedItem<T>` with:
- `item: T` — the config object
- `origin: "builtin" | "server" | "project"` — which layer provided this item
- `overrides?: ConfigOrigin` — which lower layer this item shadows, if any

#### Resolution rules

For each config type, items are merged by a unique key (roles by `name`, workflows by `id`, tools by `name`). Later layers shadow earlier ones entirely — no field-level merge. Without `projectId`, returns system scope (builtins + server). With `projectId`, adds the project layer. If `projectId` equals the default project ID, the project layer is skipped (it _is_ the server layer). Hidden workflows (e.g. `test-fast`) are filtered out at the cascade level.

#### Server stores decoupling

`ConfigCascade` accepts explicit `ServerStores` accessors rather than reading from `projectContextManager.getDefault()`. This matters because the standalone stores in `server.ts` may be backed by a different directory than the default project's stores (e.g. when `BOBBIT_DIR` is set in E2E tests). Using explicit accessors ensures PUT and GET use the same underlying stores.

#### Builtin seeding

On server startup, standalone stores are seeded with builtins that aren't already present. This ensures that code paths reading from standalone stores (e.g. `createGoal()` looking up workflows) work even when scaffolding no longer copies these files. Tools are excluded from seeding because they're still copied by scaffolding.

#### Scaffolding

`scaffoldBobbitDir()` creates empty `config/roles/`, `config/workflows/`, `config/personalities/` directories. These config types resolve at runtime via the cascade — no files are copied. Tools are still copied from defaults because they contain provider configs and `extension.ts` code that `updateToolMetadata()` modifies in-place. `system-prompt.md` is also still copied.

#### Session setup integration

The session setup pipeline (`session-setup.ts`) resolves roles and tools through `ConfigCascade` when a `plan.projectId` is available. A `lookupRole()` helper in the pipeline prefers cascade-resolved roles, falling back to the standalone store. This ensures sessions see the full three-layer resolution even when project config dirs are empty.

#### REST API

Config list endpoints accept `?projectId=` for project-scoped resolution:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/roles?projectId=X` | Resolved roles with `origin` and `overrides` fields |
| `GET` | `/api/personalities?projectId=X` | Resolved personalities |
| `GET` | `/api/workflows?projectId=X` | Resolved workflows |
| `GET` | `/api/tools?projectId=X` | Resolved tools |
| `POST` | `/api/roles/:name/customize?scope=project&projectId=X` | Copy resolved item to target scope for editing |
| `DELETE` | `/api/roles/:name/override?scope=project&projectId=X` | Remove override, revert to inherited |

The customize/override endpoints follow the same pattern for personalities (`:name`) and workflows (`:id`). CRUD endpoints (`POST`, `PUT`, `DELETE`) accept optional `projectId` for scope-aware operations.

#### UI

All five config pages (Roles, Tools, Skills, Personalities, Workflows) display a project scope row (System + per-project tabs) when multiple projects are registered. Items show origin badges (grey=builtin, blue=server, green=project). In project scope, inherited items (origin != "project") appear at 70% opacity. Customize/revert buttons manage overrides. Shared UI helpers live in `config-scope.ts` and `config-scope.css`.

### Project assistant

The project assistant guides users through registering a new project directory. It operates in two modes, selected automatically by the smart Add Project flow based on directory detection (`POST /api/projects/detect`):

**Detection mode** (assistant type `"project"`): For directories with existing content but no `.bobbit/`. The server creates a provisional project for the target directory and assigns the session to it. When the session connects, an auto-prompt is sent containing the directory path (e.g., "Start the project registration session. The project directory is: /path/to/my-project") — the assistant never needs to ask for it. The path is passed through `connectToSession()` via the `projectDirPath` option. The assistant explores the directory (package.json, build files, git config, CI config, README) and calls the `propose_project` tool with discovered settings: name, root_path, build_command, test_command, typecheck_command, test_unit_command, test_e2e_command, and worktree_setup_command. Because proposals are tool calls, they persist in message history and remain accessible on reconnect via the "Open proposal" button.

**Scaffolding mode** (assistant type `"project-scaffolding"`): For empty or non-existent directories. Like detection mode, a provisional project is created and the session is assigned to it. An auto-prompt is sent with the target directory path (e.g., "Start the new project setup session. The target directory is: /path/to/my-project"). The assistant acknowledges the directory, asks what the project is about, suggests tech stacks, and helps scaffold the project structure (directory layout, basic files, README). After the user accepts the proposal, the assistant uses bash/write tools to create the project files, then calls `propose_project` with the same settings.

**Provisional projects**: When a project assistant session is created (Path B or C), the server registers a **provisional project** via `ProjectRegistry.registerProvisional(name, rootPath)` with `provisional: true`. The assistant session is assigned to this provisional project's real `projectId` — so it has proper project isolation from the start, with its own store directory. The sidebar renders provisional projects as normal project folders but with a "(setting up)" badge, and suppresses action buttons (Add Goal, Add Staff, etc.) while the project remains provisional. Because this is server-side state, it survives page refreshes — unlike the previous `state.pendingProjects` client-side approach. If the session is terminated without accepting a proposal, the provisional project is cleaned up via `DELETE /api/projects/:id`.

When the agent calls `propose_project`, the client populates `state.activeProjectProposal` and shows a **preview form** in the right panel (similar to goal proposals) with editable fields: project name, build/test/typecheck commands, and worktree setup command. The user reviews and clicks "Accept" — only then does the client promote the provisional project via `POST /api/projects/:id/promote` (which clears the `provisional` flag and updates the name) and write all config fields to `project.yaml` via `PUT /api/projects/:id/config`. The config write is atomic — all keys are validated before any are written, so a validation failure leaves the existing config unchanged. The client deduplicates proposal acceptance by tracking processed tool_use block IDs in `sessionStorage`, preventing re-fires on message re-scan (reconnect, refresh). This ensures goal workflows can run effectively with build, test, and type-check commands configured from the start.

**Auto-import path**: If `POST /api/projects/detect` reports `.bobbit/` already exists, the UI skips the assistant entirely and registers the project immediately with the auto-detected name (from `package.json` or directory basename). Existing `.bobbit/config/` settings are preserved as-is.

**Directory browsing**: The smart Add Project dialog includes a Browse button backed by `GET /api/browse-directory?path=<base>`. This endpoint returns directory-only listings (skips files, hidden dirs, `node_modules`, and symlinks). Defaults to the server's CWD when no path is provided.

### Per-project config

Each registered project can override system-level settings (from `project.yaml`). This allows different projects to use different build commands, default models, sandbox settings, etc., while inheriting everything they don't explicitly override.

**Resolution cascade**: For each config key, `resolveScalarConfig()` checks project → server → global → built-in default. The first defined value wins. This reuses the same `config-resolver.ts` infrastructure described in [Config resolution](#config-resolution-3-tier-hierarchy) above.

**Server-side caching**: `ProjectContextManager` lazily instantiates a `ProjectContext` per project via `getOrCreate()`. On startup, `initAll()` pre-creates contexts for all registered projects.

**REST API**:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/config` | Raw project-level overrides (only keys explicitly set) |
| `GET` | `/api/projects/:id/config/defaults` | Built-in defaults for all config keys |
| `PUT` | `/api/projects/:id/config` | Set/clear project-level overrides. Empty string or `null` clears an override. |
| `GET` | `/api/projects/:id/config/resolved` | Fully resolved values — each key returns `{ value, source }` where source is `"project"`, `"server"`, or `"default"` |

**Settings UI**: The settings page has a two-tier layout. The top scope row selects System or a specific project. Sub-tabs within each scope show the relevant settings. Per-project tabs show inherited system values as placeholders with an "(inherited)" badge; overrides show normal text with a "×" reset button. URL scheme: `#/settings/<scope>/<tab>` where scope is `system` or a project UUID (backwards-compatible: `#/settings/shortcuts` maps to `#/settings/system/shortcuts`).

**Sidebar shortcut**: Project headers in the sidebar show a gear icon on hover that navigates directly to `#/settings/<project-id>/project`.

### Per-project palette

Projects can optionally be assigned one of the 10 built-in color palettes (`forest`, `ocean`, `dusk`, `ember`, `rose`, `slate`, `sand`, `teal`, `copper`, `mono`). This lets you visually distinguish projects — when you navigate to a session or goal belonging to a project with a palette, the entire UI switches to that palette.

**Data model** (`RegisteredProject` in `project-registry.ts`):

| Field | Type | Description |
|---|---|---|
| `palette` | `string \| undefined` | One of the 10 palette IDs, or undefined for no palette (use global default) |
| `colorLight` | `string` | Project accent color for light mode (always present, defaulted on creation) |
| `colorDark` | `string` | Project accent color for dark mode (always present, defaulted on creation) |

The deprecated `color` field is migrated on load: its value is copied to both `colorLight` and `colorDark`. Projects with no color get muted defaults from `DEFAULT_PROJECT_COLOR_LIGHT/DARK`.

**Auto-seeding**: When a palette is set via the REST API without explicit `colorLight`/`colorDark` values in the same request, the colors are seeded from the palette's primary color values. The constant map `PALETTE_PRIMARY_COLORS` in `src/shared/palette-colors.ts` maps each palette ID to its light and dark primary colors (extracted from the CSS `--primary` variable values).

**REST API**: `POST /api/projects` and `PUT /api/projects/:id` accept `palette`, `colorLight`, `colorDark` fields alongside existing project fields.

**Palette switching (UI)**: Applied via the `data-palette` attribute on `<html>`, the same mechanism as the global palette picker. On session/goal navigation, the UI resolves `activeSession → projectId → project.palette`. If a palette exists, it is applied; otherwise the global default from user preferences is restored. The switch is handled alongside session connection logic so the entire UI — sidebar, content area, headers — shifts palette together. In `connectToSession()`, the palette is applied twice: once immediately (using the session data already in `gatewaySessions`) and again after `refreshSessions()` completes. The second apply handles sessions (e.g. recently-spawned reviewer agents) that weren't yet in `gatewaySessions` at initial connect time — without it, `applyProjectPalette(undefined)` reverts to the global palette.

**Sidebar accent colors**: Project header folder icons and names use `colorLight` in light mode and `colorDark` in dark mode, selected reactively based on the current theme.

**Settings UI**: The per-project settings scope includes an "Appearance" tab (first tab) with:
1. A palette picker reusing the same palette preview cards from the global Color Palette tab, plus a "None (use global)" option.
2. Two color inputs side by side for light and dark mode accent colors, pre-filled from the palette seed or existing values.

Selecting a palette seeds the color fields from `PALETTE_PRIMARY_COLORS`; the user can then override colors independently.

### Session & goal scoping

- `PersistedSession` and `PersistedGoal` carry an optional `projectId` field.
- Session/goal list APIs accept `?projectId=` query parameter for filtering.
- Worktrees for goals are created relative to the project's `rootPath`, not the server CWD.
- Session CWD defaults to the project's `rootPath`.

### Session worktrees

Every non-goal, non-assistant session automatically gets its own git worktree branch. This eliminates conflicts between concurrent sessions that would otherwise all work on the same branch (usually master).

**Which sessions get worktrees:**

| Session type | Worktree? | Branch pattern |
|---|---|---|
| Regular (host) | Yes | `session/new-session-{uuid8}` |
| Regular (sandbox) | Yes | `session/s-{uuid8}` |
| Goal sessions | Yes (existing behavior) | `goal/<branch-name>` |
| Team agent sessions | Yes (existing behavior) | Per-agent branch within goal |
| Assistant sessions (goal, project, tool) | No | N/A — conversational only, no code edits |

**Lifecycle:**

1. **Creation**: When `POST /api/sessions` creates a non-goal, non-assistant session in a git repo, the server auto-generates worktree options. For host sessions, `git worktree add` creates the branch. For sandbox sessions, `ProjectSandbox.createWorktree()` creates it inside the container. **Subdirectory projects**: When a project's `rootPath` is a subdirectory of a git repo (e.g. `/repo/packages/my-app`), worktrees are still created at the git repo root level (full checkout), but the session `cwd` is offset to the corresponding subdirectory within the worktree. The `worktreePath` remains the worktree root (for cleanup). This offset is computed via `path.relative(repoRoot, project.rootPath)` and applied consistently in goal creation, `executeWorktreeAsync`, pool claims, and team member spawning.
2. **Working**: The agent works in the worktree directory (or subdirectory for offset projects). The git status widget shows ahead/behind master, and push/pull controls work the same as for goal branches.
3. **Cleanup**: On session terminate or archive, the worktree and branch are removed via `cleanupWorktree()` (host) or `ProjectSandbox.removeWorktree()` (sandbox).
4. **Orphan detection**: Orphaned `session/*` worktrees (from ungraceful shutdowns where cleanup didn't run) are **not** removed automatically on startup. Use Settings → Maintenance tab to preview orphaned worktrees and clean them up manually. The REST API (`GET /api/maintenance/orphaned-worktrees`) lists orphans; `POST /api/maintenance/cleanup-worktrees` removes them after validation.
5. **Restore**: After a restart, existing session worktrees are reused — the server reconnects to the worktree on disk without recreating it.

**Staff agent worktrees:** Staff agents get a permanent worktree at creation time. Because staff sessions are long-lived (they persist across wake/sleep cycles rather than being recreated), their worktrees can become stale over time. To address this, `StaffManager.refreshWorktree()` runs on each wake cycle for non-sandboxed staff: it rebases the worktree branch onto the primary branch and re-runs the project's `worktree_setup_command` (e.g. `npm ci`). Sandboxed staff agents skip the host-side refresh — their container-internal worktrees are managed via `sandboxBranch`, which is passed to `createSession()` during staff creation and legacy migration so the container creates the worktree properly.

### Sidebar grouping

The sidebar always groups sessions and goals under collapsible project folder rows — even with a single project. This unified code path avoids duplication between single-project and multi-project layouts.

```
├── Project A (collapsible)
│   ├── Goal 1
│   │   ├── session...
│   ├── Sessions (ungrouped)
│       ├── session...
├── Project B (collapsible)
│   ├── ...
├── [+ Add Project]
```

When only one project is registered, its folder row defaults to expanded so there is no extra click required. Each project row shows a folder icon, project name, settings gear, and new-goal button. When no projects are registered (fresh install), the sidebar shows a "No projects configured" empty state with an "Add Project" button.

**Collapse state is per-project**: The Sessions and Staff section collapse toggles are stored per-project, not globally. Collapsing Sessions in Project A does not affect Project B. State is persisted as collapsed-project-ID sets in localStorage (`bobbit-collapsed-ungrouped`, `bobbit-collapsed-staff`). Default state is expanded for all projects. Access via `isUngroupedExpanded(projectId)` / `setUngroupedExpanded(projectId, value)` and `isStaffExpanded(projectId)` / `setStaffSectionExpanded(projectId, value)` in `state.ts`.

### REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all registered projects |
| `POST` | `/api/projects` | Register a project (body: `name`, `rootPath`, optional `color`) |
| `GET` | `/api/projects/:id` | Get a single project |
| `PUT` | `/api/projects/:id` | Update name/color |
| `DELETE` | `/api/projects/:id` | Unregister (blocked for default project) |
| `GET` | `/api/projects/:id/config` | Raw project-level config overrides |
| `GET` | `/api/projects/:id/config/defaults` | Built-in defaults |
| `PUT` | `/api/projects/:id/config` | Set/clear project config fields |
| `GET` | `/api/projects/:id/config/resolved` | Resolved values with `{ value, source }` |

Session/goal/search endpoints accept optional `?projectId=` filter:
- `GET /api/sessions?projectId=<id>`
- `GET /api/goals?projectId=<id>`
- `GET /api/search?projectId=<id>`

### Key files

| File | Purpose |
|---|---|
| `project-registry.ts` | Project CRUD and persistence |
| `project-context.ts` | Scoped store container per project (with `open()`/`close()` lifecycle) |
| `project-context-manager.ts` | Central registry of contexts, aggregation, store routing |
| `state-migration.ts` | One-time migration from centralized to per-project state |
| `config-resolver.ts` | 3-tier scalar config cascade (`project.yaml` keys) |
| `builtin-config.ts` | Read-only provider for factory-default config from `dist/server/defaults/` |
| `config-cascade.ts` | Three-layer entity resolution (builtin → server → project) with origin tags |
| `config-scope.ts` | Shared UI scope row + origin badge helpers for config pages |
| `project-assistant.ts` | Guided project registration |

---

## Tool access policies

All tool access uses a **grant policy** system enforced by a single `tool_call` guard extension. Every tool resolves to one of three policy values:

| Policy | Behavior |
|---|---|
| `allow` | Tool executes immediately, no prompt. |
| `ask` | Guard blocks execution; UI prompts user for permission. |
| `never` | Tool is not registered — invisible to the agent. |

### Why a guard extension?

Earlier versions used a fragile multi-layered approach: stub extensions raced against real extensions using first-registered-wins semantics, error regex matching detected denials after the fact, and leaked tool detection was needed because shared extensions (e.g. a single `shell/extension.ts` that registers both `bash` and `bash_bg`) bypassed allowedTools filtering. The guard extension replaces all of that with a single interception point — pi-coding-agent's `tool_call` event hook fires before every tool execution and supports `{ block: true }` to prevent it.

### How the guard works

1. At session setup, `writeToolGuardExtension()` generates a TypeScript extension containing a map of all `ask`-policy tools and the session's pre-existing grants.
2. The extension registers a `pi.on("tool_call", ...)` handler that intercepts every tool invocation.
3. For `allow` tools (or tools already granted), the handler returns immediately — no blocking.
4. For `ask` tools without a grant, the handler POSTs to `POST /api/sessions/:id/tool-grant-request` (long-poll). The gateway broadcasts a `tool_permission_needed` WebSocket message to all connected clients, and the HTTP request blocks until the user responds.
5. The UI shows a grant dialog. The user can grant (with a duration choice) or deny.
6. On grant: the gateway resolves the long-poll with `{ granted: true }`. The guard adds the tool to its in-memory grant set so future invocations pass through.
7. On deny: the gateway resolves the long-poll with `{ granted: false, reason: "..." }`. The guard returns `{ block: true, reason }` and the agent sees a tool error.
8. `never` tools are never registered with the agent, so no `tool_call` event fires for them — the guard is not involved.

**Key files:** `tool-guard-extension.ts` (generates the guard), `tool-activation.ts` (`writeToolGuardExtension`, `computeToolPolicies`), `tool-group-policy-store.ts`, role YAML `toolPolicies`, tool YAML `grantPolicy`.

### Grant duration

Grant duration is chosen by the user at grant time, not configured in policy YAML. The grant dialog offers three options:

| Duration | Effect |
|---|---|
| **Always** (permanent) | Tool is added to the role's `toolPolicies` as `allow` — persists across sessions. |
| **This session** | Grant stored in the session's in-memory grant set — lasts until session ends. |
| **Just this once** | Grant is consumed immediately — the guard will prompt again on the next invocation. |

This replaces the old `ask-once` / `always-ask` distinction, which conflated "should this tool require a grant?" with "how long should the grant last?"

### Grant and deny protocol

**WebSocket messages:**
- `tool_permission_needed` (server → client): `{ toolName, group, roleName, roleLabel, lastPromptText? }`
- `grant_tool_permission` (client → server): `{ toolName, scope: "tool" | "group", group?, mode?: "persistent" | "session-only" | "one-time" }`
- `deny_tool_permission` (client → server): `{ toolName }`

**REST endpoint:**
- `POST /api/sessions/:id/tool-grant-request` — called by the guard extension (long-poll). Body: `{ toolName, toolGroup }`. Blocks until the user grants or denies. Returns `{ granted: boolean, reason? }`.

### Policy resolution cascade

Resolution order is unchanged (first non-null wins):

1. `role.toolPolicies["<tool-name>"]` — per-tool override on role
2. `role.toolPolicies["<group>"]` — per-group override on role
3. `tool.grantPolicy` — tool YAML default
4. Group default — `defaults/tool-group-policies.yaml` (builtin), overridden by `.bobbit/config/tool-group-policies.yaml` (server/project)
5. System fallback — `allow`

### REST API

- `PUT /api/roles/:name` — accepts `toolPolicies` (Record of tool/group name → `allow` | `ask` | `never`)
- `PUT /api/tools/:name` — accepts `grantPolicy`
- `GET /api/tool-group-policies` — all group default policies
- `PUT /api/tool-group-policies/:group` — set/clear group default (`{ policy: "allow" | "ask" | "never" | null }`)
- `POST /api/sessions/:id/tool-grant-request` — guard extension long-poll endpoint

### Migration from legacy policy values

Legacy policy values are normalized on load:

| Legacy value | New value |
|---|---|
| `always-allow` | `allow` |
| `ask-once` | `ask` |
| `always-ask` | `ask` |
| `never-ask` | `never` |

This happens transparently in `normalizeGrantPolicy()` — existing role YAML and tool YAML files with old values continue to work. The `allowedTools` array on roles is a computed getter derived from `toolPolicies` for backward compatibility — it includes only `allow`-policy tools (not `ask` or `never`).

> **Important:** Session creation must not use `role.allowedTools` directly to determine which tools are active, because that excludes `ask`-policy tools entirely. Instead, `server.ts` calls `computeEffectiveAllowedTools()` from `tool-activation.ts`, which returns both `allow` and `ask` tools. This ensures `resolveToolActivation()` in the session setup pipeline sees the full set and generates the guard extension for `ask`-policy tools. Without this, roles with only `ask` policies would produce sessions with no tool guard — the agent could use guarded tools without user approval.

---

## Full-text search & paginated archives

SQLite FTS5 via `better-sqlite3`. Each project has its own index at `<project-root>/.bobbit/state/search.db` (rebuildable cache). `ProjectContextManager.searchAll()` aggregates results across all project indexes.

**Key files:** `search-index.ts` (server-side FTS5 index), `message-extractor.ts` (text extraction from messages), `SearchBox.ts` (sidebar input component), `SearchResults.ts` (result display used by full search page), `search-page.ts` (full search route).

**Indexed:** Goals (title, spec), sessions (title, role), messages (text blocks, tool call names), staff agents (name, description).

**FTS5 tables:** `goals_fts`, `sessions_fts`, `messages_fts`, `staff_fts`. Content tables include a `project_id` column for multi-project filtering. Schema version is 3 (bumped from 2 to add project_id). Version mismatch triggers automatic rebuild.

**Indexing:** Incremental via store hooks + `RpcBridge`. Staff indexing hooks live in `StaffManager` — index on create/update, remove on delete. Indexing methods (`indexGoal`, `indexSession`, `indexMessage`, `indexStaff`) accept a `projectId` parameter. Full rebuild on first run or schema version mismatch; `rebuildFromStores()` iterates all project contexts to re-index everything.

**Query sanitisation:** User input is tokenised and special characters (`(`, `)`, `+`, `-`, `*`, `"`, etc.) are stripped from all tokens before constructing the FTS5 MATCH expression. Each token except the last is quoted as an exact term; the last token gets a `*` suffix for prefix matching. This prevents FTS5 syntax errors from user input while supporting incremental search-as-you-type.

**API:** `GET /api/search?q=<query>&limit=20&offset=0&type=all|goals|sessions|messages|staff&projectId=<optional>` — when `projectId` is omitted, searches across all projects. Search results include `projectId` and `projectName` fields so the UI can show which project each result belongs to.

### Two-mode search design

Search has two distinct modes with clear separation of concerns:

**1. Filter mode (sidebar):** Instant client-side filtering — no API calls. Filters goals by title, sessions by title and agent role, and staff by name using case-insensitive substring matching. The sidebar structure (goal groups, ungrouped sessions, staff, archived) is preserved — non-matching entries are hidden. Archived sections auto-expand when a match is found inside them and auto-collapse when the query clears (tracked by an internal flag to distinguish search-triggered vs manual expansion). A "Full Search" link below the input navigates to the full search page with the current query.

**Key file:** `SearchBox.ts` handles the input with debounce, Escape-to-clear, and Ctrl+K shortcut. Filtering logic lives in `Sidebar.ts`.

**2. Full search page (`#/search`):** The sole consumer of the FTS5 `GET /api/search` endpoint. Route: `#/search` (with optional `?q=<query>` parameter). Accessible via the "Full Search" link in the sidebar or directly by URL.

Features: large auto-focused input, type filter toggles (Goals, Sessions, Staff, Messages), grouped results with snippets and `<b>` match highlighting, relative timestamps, archived badges, and "Load More" pagination. Clicking a result navigates to the relevant goal dashboard, session, or staff edit page.

**Key file:** `search-page.ts` manages its own local state (query, results, type filters, pagination offset).

> **Design note — gate content:** Gate content (design specs, review findings) is not currently indexed in the FTS tables. This is a deliberate deferral — adding it requires schema changes and a rebuild trigger. Tracked for future work.

**Paginated archives:**
- `GET /api/goals?archived=true&limit=50&after=<cursor>` — cursor is `archivedAt` timestamp
- `GET /api/sessions?include=archived&limit=50&after=<cursor>`
- Live data uses generation-based polling (`?since=N`)

---

## Thinking level configuration

Configurable via `default_thinking_level` in `project.yaml`. Values: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `""` (empty = agent default `"medium"`).

Token budgets (hardcoded in `remote-agent.ts`): minimal=1024, low=4096, medium=10240, high=32768.

Per-session toggle overrides the project default.

---

## Config scan directories

Bobbit scans multiple directories for skills, MCP servers, tools, and agent files. Manage via Settings → Config Directories tab or `config_directories` in `project.yaml`.

Storage format:
```yaml
config_directories: '[{"path":"~/my-config","types":["skills","mcp"]}]'
```

Types: `"skills"`, `"mcp"`, `"tools"`, `"agents"`. Custom directories are additive. Built-in directories always scanned with higher priority.

**Per-project scoping:** Config directories are resolved per-project. Each project's `config_directories` in its `project.yaml` affects only that project's sessions — a session in project B uses project B's custom directories for skill, MCP, and agent file discovery. This prevents non-default projects from inheriting the default project's custom config directories, which would be incorrect in multi-project setups. The API endpoints (`/api/config-directories`, `/api/slash-skills`, `/api/slash-skills/details`) accept a `?projectId=` query parameter to resolve directories for a specific project.

**Built-in directories:**

| Type | Directories |
|---|---|
| Skills | `.claude/skills/`, `.bobbit/skills/`, `~/.claude/skills/`, `~/.bobbit/skills/`, `.claude/commands/` |
| MCP | `~/.claude.json`, `~/.claude/.mcp.json`, `~/.bobbit/.mcp.json`, `.mcp.json`, `.claude/.mcp.json`, `.bobbit/config/mcp.json` |
| Tools | `defaults/tools/` (builtins), `.bobbit/config/tools/` (overrides) |
| Agents | `AGENTS.md` (falls back to `CLAUDE.md`) |

**Agents type:** entries point at individual files, not directories. Concatenated into system prompt in order. `@ref` resolved relative to file's parent dir.

**Key file:** `src/server/agent/config-directories.ts`

---

## MCP servers

Auto-discovered from Claude Code-compatible locations. Sources (later overrides earlier):

1. Custom directories with type `"mcp"` (lowest priority)
2. Additional registered projects' MCP locations (see below)
3. `~/.claude.json` → `mcpServers` + `projects[<cwd>].mcpServers`
4. `~/.claude/.mcp.json`
5. `~/.bobbit/.mcp.json`
6. `<project>/.mcp.json`
7. `<project>/.claude/.mcp.json`
8. `<project>/.bobbit/config/mcp.json` (highest priority)

**Multi-project discovery:** In multi-project setups, MCP discovery scans all registered projects — not just the primary project. Each additional project's custom MCP directories, `.mcp.json`, `.claude/.mcp.json`, and `.bobbit/config/mcp.json` are included. Additional project configs have lower priority than user-level configs (`~/.claude.json` etc.) and the primary project's own configs, so the primary project always wins on name conflicts. This ensures sessions can access MCP servers defined in any registered project without manual duplication.

Config format matches Claude Code `.mcp.json`:
```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "remote": { "url": "https://mcp.example.com/api" }
  }
}
```

Tools exposed as `mcp__<server>__<tool>`. Transports: stdio (spawn) and HTTP (POST JSON-RPC). Env vars (`${VAR}`) expanded from `process.env`.

### MCP tool documentation

When an MCP server connects, `McpManager` auto-generates documentation for its tools so they follow the same two-tier pattern as built-in tools: enriched one-line summaries in the system prompt, full parameter docs on disk.

**Summary generation** — deterministic, no LLM dependency:
- First sentence of the tool description (terminated by `.`, `!`, or `?`)
- Truncated at ~120 characters on a word boundary with `...` if needed
- Falls back to `"MCP tool <name> from <server>"` when no description exists

**Disk cache** — stored in `<project-root>/.bobbit/state/mcp-tool-docs/`:
- `<serverName>.cache.json` — per-tool SHA-256 content hash (of description + inputSchema) and generated summary. On each connect, hashes are compared; only changed tools trigger regeneration.
- `<serverName>.md` — full Markdown reference with tool descriptions and parameter tables (name, type, required, description). Rewritten only when any tool in the server changes.

**Prompt layout** — `getToolDocsForPrompt()` in `tool-manager.ts` produces a single `# Tools` section (not two separate sections). Each group renders: summary lines → per-tool doc blocks → a footer link. Built-in groups link to `defaults/tools/<groupDir>/<tool>.yaml` (`detail_docs` field); MCP groups link to `.bobbit/state/mcp-tool-docs/<serverName>.md`.

**API:** `GET /api/mcp-servers`, `POST /api/mcp-servers/:name/restart`, `POST /api/internal/mcp-call`

---

## Docker sandbox

Opt-in Docker isolation for agent sessions. Set `sandbox: "docker"` in `project.yaml`. Each project gets one long-lived Docker container — agents work inside it using standard git worktrees, the same isolation model as non-sandbox mode.

### Architecture

```
HOST                                    CONTAINER (one per project, long-lived)
────                                    ────────────────────────────────────────
Bobbit server                           /workspace        (repo clone, native Linux)
  │                                     /workspace-wt/
  ├─ docker exec → team lead              ├─ goal-abc/     (worktree)
  ├─ docker exec → agent-1                │   └─ agent-1/  (worktree)
  └─ docker exec → agent-2                └─ goal-def/     (worktree)
```

- **One container per project**, created when sandbox is enabled, lives until disabled/removed
- **Container clones its own repo** from the real remote — no host-side clone, no cross-OS bind mounts for workspace
- **`npm ci`, Playwright install, and build happen inside the container** on native Linux filesystem
- **Agents use git worktrees** inside the container — identical to non-sandbox mode
- **One scoped token per project container** (not per-agent/session)

### Configuration

All settings in `project.yaml` (Settings → Project → Docker Sandbox):

```yaml
sandbox: "docker"                      # "none" (default) or "docker"
sandbox_image: "bobbit-agent"          # must be pre-built
sandbox_credentials: '{"GITHUB_TOKEN": "ghp_..."}'  # env vars for container
sandbox_mounts: '["/data/shared:/data:ro"]'  # bind mounts
```

### Docker image

```bash
docker build -t bobbit-agent docker/
```

Auto-built on startup if image missing but `docker/Dockerfile` exists (120s timeout). Includes Node.js 20, git, curl, gh, build-essential. Agent CLI bind-mounted at runtime.

### How it works

**Container lifecycle** is managed by `ProjectSandbox` (one instance per project) and `SandboxManager` (registry mapping projectId → ProjectSandbox).

**Startup sequence:**

1. `SandboxManager.initForProject(projectId, config)` creates a `ProjectSandbox` instance
2. `ProjectSandbox.init()` searches for an existing container by label (`bobbit-project=<projectId>`):
   - **Found running** → reconnect (reuse container ID)
   - **Found stopped** → restart via `docker start`
   - **Not found** → create new container with named Docker volumes (`bobbit-workspace-<projectId>` for `/workspace`, `bobbit-worktrees-<projectId>` for `/workspace-wt`)
3. On first create, the container runs an init sequence: `git clone <repoUrl>`, `npm ci`, optional Playwright install, `npm run build`
4. Container runs with `--restart=unless-stopped` so it survives Docker daemon restarts

**Agent spawn:**

1. `ProjectSandbox.createWorktree(name, branch, baseBranch?)` creates a git worktree at `/workspace-wt/<name>` inside the container via `docker exec`
2. A post-commit hook is installed in each worktree for mandatory push-to-remote (durability)
3. RpcBridge spawns the agent via `docker exec -i -w <containerCwd> <containerId>` — the `-w` flag sets the container process working directory so the agent CLI's `process.cwd()` resolves to the correct worktree path (without it, docker exec defaults to the container's WORKDIR `/workspace`, which is wrong for worktree sessions)
4. Delegates inherit parent sandbox config

**Session termination:**

1. `ProjectSandbox.removeWorktree(name)` removes the worktree inside the container via `docker exec git worktree remove`

### Network

Containers run on a dedicated Docker bridge network (`bobbit-sandbox-net`) with direct outbound internet access. This replaces the previous proxy-based approach where all traffic was routed through a gateway-hosted `SandboxProxy`.

- **Network creation**: `ensureSandboxNetwork()` in `session-manager.ts` creates the network idempotently via `docker network create bobbit-sandbox-net --driver bridge --opt com.docker.network.bridge.enable_icc=false`. The `enable_icc=false` flag prevents inter-container communication.
- **Metadata endpoint blackholing**: Cloud metadata endpoints are blocked via `--add-host` entries in `docker-args.ts` (`169.254.169.254`, `metadata.google.internal`, and `metadata.internal` all resolve to `0.0.0.0`). `169.254.169.254` is the AWS/GCP/Azure IMDS endpoint; the named hosts cover GCP and Azure specifically. This is defense-in-depth against SSRF via cloud instance metadata.
- **Gateway reachable**: `--add-host=host.docker.internal:host-gateway` ensures the container can reach the gateway for API calls (tool extensions, delegate sessions, etc.).
- **Cleanup**: `cleanupSandboxNetwork()` removes the network on shutdown (non-fatal if containers are still connected).
- `web_search`/`web_fetch` use direct `curl` from inside the container — no gateway proxy needed.

### Scoped tokens

Each sandboxed project gets a single 256-bit token shared by all sessions in that project. Generated via `SandboxTokenStore.register(projectId)`, in-memory only (regenerated on restart). Sessions are added to the scope via `addSession(projectId, sessionId)`. Auth tries admin token first, then `SandboxTokenStore`.

**Allowed endpoints:** `/api/health`, `/api/internal/mcp-call`, `/api/internal/verification-result`, `/api/preview`, `/api/sessions` (forced sandboxed), own session CRUD, own goal+team+gates+tasks, `/api/tasks/:id`, `/api/personalities`. Everything else blocked. `bash_bg` blocked at tool and API level.

Full allowlist: see `src/server/auth/sandbox-guard.ts`.

### Resource limits

Container resource limits are computed dynamically based on the host machine:
- **Memory**: total system memory minus 2GB (minimum 4GB) — leaves headroom for the host OS and gateway
- **CPU**: total CPU cores minus 2 (minimum 2) — prevents sandbox from starving the host
- **PIDs**: unlimited — fork bombs are mitigated by the memory and CPU limits

These are computed in `ProjectSandbox` and passed to `buildDockerRunArgs()`.

### Git authentication (GITHUB_TOKEN)

Sandbox containers include a git credential helper so agents can `git push` and use `gh pr create` without manual authentication. The token flows from the host into the container at runtime — the Docker image contains only the credential helper script, never the token itself.

**Injection path:**

1. `resolveHostApiCredentials()` in `session-manager.ts` auto-detects a GitHub token on the host — checking `GITHUB_TOKEN` env var, `gh auth token` CLI, and `~/.config/gh/hosts.yml`
2. The token is passed to the agent process via `docker exec -e GITHUB_TOKEN=xxx` (not `docker run -e`, because pooled containers start before credentials are known)
3. The Dockerfile configures a global git credential helper:
   ```
   git config --global credential.helper \
     '!f() { test -n "$GITHUB_TOKEN" && echo "username=x-access-token" && echo "password=$GITHUB_TOKEN"; }; f'
   ```
   When git requests HTTPS credentials, this helper reads `$GITHUB_TOKEN` from the current process environment and returns it as a password with the `x-access-token` username (GitHub's convention for token auth).
4. `gh` CLI also honours `GITHUB_TOKEN` natively — no extra configuration needed.

**Configuration:** The `sandbox_github_token` setting in `project.yaml` (defaults to `true`) controls whether the host token is injected. Set to `false` to disable injection — the credential helper will be present but inert (it checks `test -n "$GITHUB_TOKEN"` before returning credentials).

**Security notes:**
- The token is injected per-process via `docker exec -e`, not stored on the container filesystem
- The credential helper is a shell function, not a persisted script with embedded secrets
- If `GITHUB_TOKEN` is unset in the container's environment, the helper is a no-op and git falls back to its normal credential flow (which will fail in the sandbox since there is no TTY)

### Worktree management

Sandboxed agents use standard git worktrees inside the project container — the same model as non-sandbox mode. No shared bare repos or team remotes are needed.

**Worktree creation** (`ProjectSandbox.createWorktree()`):

1. Creates a worktree at `/workspace-wt/<name>` branching from the specified base
2. Installs a post-commit hook that pushes to the remote after every commit (durability — ensures commits survive container loss)
3. Called during agent spawn via `applySandboxWiring()`

**Worktree removal** (`ProjectSandbox.removeWorktree()`):

1. Removes the worktree via `git worktree remove --force`
2. Called during session termination

**Worktree pool** (host-side, `worktree-pool.ts`): The worktree pool pre-creates worktrees in the background so sessions start faster. Pools are **per-project** — `SessionManager` maintains a `Map<string, WorktreePool>` keyed by project ID, so each project's worktrees are rooted in the correct repo. On startup, a pool is initialized for every registered project whose `rootPath` is a git repo, using that project's `worktree_pool_size` and `worktree_setup_command` config. When a session is created, the pool claim looks up the pool by the session's `projectId` — sessions only claim from their own project's pool. New projects registered at runtime (`POST /api/projects`) get a pool auto-initialized if they're git repos. Deleted projects (`DELETE /api/projects/:id`) get their pool drained via `removeWorktreePool(projectId)`. The pool status API (`GET /api/worktree-pool`) returns per-project data: `{ pools: { [projectId]: { enabled, ready, target, filling } } }` without a query param, or flat status for a single project with `?projectId=<id>`. Settings UI shows per-project pool status when viewing a project's settings, and aggregated status in system scope.

**Pool freshness**: When a pooled worktree is acquired, it is fetched from origin and hard-reset to the remote primary branch before being assigned to a session. This prevents stale worktrees when the primary branch has advanced since the pool entry was created. The remote primary branch is resolved dynamically via `git symbolic-ref refs/remotes/origin/HEAD` (falls back to `origin/master` if the ref is not set). The fetch+reset is non-fatal — if it fails, the worktree is still usable but may be behind.

**Inter-agent coordination:** Because all agents share the same `/workspace` clone, they can fetch each other's branches directly (`git fetch origin <branch>`). The team lead merges agent branches locally, same as non-sandboxed teams.

### Session persistence across restarts

Sandbox containers are long-lived and survive gateway restarts (via `--restart=unless-stopped`). Session state (conversation history, branch, goal association) persists in `sessions.json` on the host via the bind-mounted `.bobbit/state/` directory.

**Recovery flow on gateway startup:**

1. `ProjectSandbox.init()` finds the existing container by label (`bobbit-project=<projectId>`)
2. If running, reconnects. If stopped, restarts. If gone, recreates with the same named volumes (`bobbit-workspace-<projectId>` for `/workspace`, `bobbit-worktrees-<projectId>` for `/workspace-wt`) — git history and agent worktrees in the volumes are preserved
3. If the volumes were also lost (e.g. Docker Desktop reset), the container re-clones from the remote — committed work is recovered from the remote, uncommitted work is lost
4. `restoreSession()` calls `applySandboxWiring()` which verifies the worktree still exists inside the container
5. If the worktree is missing (e.g. volume was reset but the container was recreated), the server attempts to recreate it via `ProjectSandbox.createWorktree(branch, branch)` using the session's persisted branch. If recreation succeeds, restore continues normally. If it fails (branch deleted, no sandbox available), the session is archived — the server never launches an agent into a non-existent CWD.

**Durability layers:** (1) Post-commit hooks push every commit to the remote immediately. (2) Named Docker volumes preserve `/workspace` and `/workspace-wt` across container recreation — agent worktrees survive even if the container is removed and recreated. (3) Session logs are bind-mounted to the host — never stored only inside the container.

### Verification command execution

When a gate's verification workflow includes `command` steps (e.g. running tests), the verification harness needs access to the team's latest code. For non-sandboxed goals, this code lives in the host worktree. For sandboxed goals, the team's commits only exist inside the shared team bare repo and the containers' `/workspace` directories — the host worktree does not have them.

To solve this, `runCommandStep` in `verification-harness.ts` accepts an optional `containerId`. At the call site, the harness checks `goal.sandboxed`; if true, it resolves the project container ID via `SandboxManager.get(projectId)` → `ProjectSandbox.getContainerId()`. When a container ID is available, the command runs via `docker exec -w /workspace <containerId> /bin/sh -c <command>` instead of spawning on the host.

**Fallback:** If the goal is sandboxed but the project container is not running (container crashed, Docker restarting), the harness falls back to host execution. A warning is emitted to both server logs (`console.warn`) and the verification step's output stream so the user can see why results may be stale.

### Container resilience

When a sandbox container is killed or removed (e.g. `docker rm -f`, OOM kill, Docker Desktop restart), the gateway automatically detects the death, recreates the container, and recovers all affected sessions — no server restart required.

#### Why this matters

Without container health monitoring, a killed container leaves all sandbox sessions in a stale state (`idle` or `streaming` with a dead subprocess). The user sees no error — sessions simply stop responding. Recovery previously required a full server restart, and even then sessions were often archived instead of restored due to broken worktree state.

#### Health monitor

`ProjectSandbox` runs a background health check that polls container liveness via `docker inspect --format "{{.State.Running}}"` every 20 seconds (configurable via `startHealthMonitor(intervalMs)`). The monitor is started automatically by `SandboxManager.initForProject()` after the container is initialized.

**Detection logic:**
- If the container is running → healthy, no action
- If the container is not running, inspect fails, or the container is gone → trigger recovery
- If a previous recovery attempt failed (`_status === "error"`), the monitor retries on the next poll — recovery is never permanently abandoned
- Active recovery is guarded by `_recovering` flag to prevent concurrent recovery attempts

**Recovery sequence:**
1. Set status to `"error"`, emit `container-died` event with the old container ID
2. Call `init()` to reconnect/recreate the container (reuses existing named volumes so git history and worktrees may survive)
3. On success, emit `container-recovered` event with the new container ID
4. On failure, log the error and retry on the next poll cycle

#### Event API

`ProjectSandbox` exposes `onHealthEvent(listener)` for low-level events (`container-died`, `container-recovered`). `SandboxManager` exposes a higher-level `onContainerRecovered(listener)` that fires with `(projectId, newContainerId)` — this is what `SessionManager` subscribes to for session recovery.

```typescript
type SandboxHealthEvent =
  | { type: "container-died"; projectId: string; containerId: string }
  | { type: "container-recovered"; projectId: string; containerId: string };
```

#### Session recovery flow

When the health monitor emits `container-recovered`, `SessionManager.recoverSandboxSessions()` runs:

1. **Find affected sessions** — all sessions with `sandboxed === true` and matching `projectId`
2. **Recover worktrees** using a 3-tier strategy for each session:
   - **Tier 1: Verify** — `docker exec test -d <cwd>` checks if the worktree still exists on the volume
   - **Tier 2: Repair** — `git worktree repair` inside the container fixes broken `.git` link files (common after hard container kill where the worktree directory survived on the volume but git metadata is inconsistent)
   - **Tier 3: Recreate** — `ProjectSandbox.createWorktree(name, branch)` creates a fresh worktree from the session's persisted branch
3. **Archive unrecoverable sessions** — if all three tiers fail (branch deleted, volume lost), the session is archived
4. **Restore sessions** — calls the existing `restoreSession()` path which re-spawns the agent process inside the new container
5. **Preserve WebSocket clients** — connected browser clients are saved before session deletion and re-attached after restore, so the UI receives the recovery status broadcast in real-time

The user experience for idle sessions: status briefly shows `terminated` (from `process_exit` handling), then automatically transitions back to `idle` within ~30 seconds. Chat history, branches, and all Bobbit state are preserved.

#### process_exit handling

When a container dies, all agent processes inside it die. The RPC bridge emits `process_exit` events for each dead process. `handleAgentLifecycle()` now handles this event type — it transitions the session to `terminated` status and broadcasts to connected UI clients. This provides immediate visual feedback while the health monitor works on recovery in the background.

#### Startup worktree repair

The existing session restore path (on gateway restart) also benefits from worktree repair. Before attempting `createWorktree` for a missing sandbox worktree, the restore flow now tries `git worktree repair` first. This handles cases where the worktree directory exists on the volume but git considers it broken — common after an ungraceful container shutdown.

### Security summary

- Container sees `/workspace`, `/workspace-wt/`, `/agent-modules` (ro), `/tools` (ro), `/bobbit-state/{sessions,tool-guard,html-snapshots}/` (selective mounts — the host gateway token, TLS keys, and other sensitive state files are not mounted)
- Runs as `node` user (uid=1000), no Docker socket
- Mount paths validated against blocklist (`/proc`, `/sys`, `/.ssh`, `/.aws`, etc.)
- Credential keys sanitized (`^[A-Za-z_][A-Za-z0-9_]*$`)
- One scoped token per project (not per-session) — all sessions in a project share access
- `bash_bg` blocked (spawns on host); Docker args redacted in logs

### Key files

| File | Purpose |
|---|---|
| `docker/Dockerfile` | Image definition |
| `project-sandbox.ts` | Per-project container lifecycle and worktree management |
| `sandbox-manager.ts` | Registry mapping projectId → ProjectSandbox |
| `docker-args.ts` | Docker argument builder |
| `sandbox-status.ts` | Docker availability check, auto-build |
| `sandbox-token.ts` | Per-project scoped token store |
| `sandbox-guard.ts` | Endpoint allowlist enforcement |

### REST API

| Endpoint | Method | Description |
|---|---|---|
| `/api/sandbox-status` | GET | Docker availability + image status |
| `/api/sandbox-image/build` | POST | Build image from Dockerfile |

---

## Large content truncation

When an agent writes a large file, the `pi-coding-agent` RPC protocol emits `message_update` events containing the **full accumulated message** on every streaming chunk. For a 40MB file write, this means ~40MB of JSON is serialized, broadcast via WebSocket, parsed by the browser, and held in the EventBuffer — on every token. With multiple agents writing simultaneously, this creates catastrophic memory pressure and freezes the Node.js event loop.

The truncation system intercepts events before they reach the broadcast layer and EventBuffer, replacing large tool input content with a lightweight stub while preserving the full content in the agent's `.jsonl` session file for on-demand access.

### Architecture

```
Agent process → message_update (full content)
       │
       ├─→ handleAgentLifecycle() — receives original (for search indexing)
       ├─→ trackCostFromEvent()   — receives original (for token accounting)
       │
       └─→ truncateLargeToolContent(event)
              │
              ├─→ eventBuffer.push()  — truncated (ring buffer stays small)
              └─→ broadcast()         — truncated (WebSocket payloads stay small)
```

### Key design decisions

- **32KB threshold** — generous enough that normal code files (<10KB) pass through untouched, but catches generated data files, large test fixtures, and minified bundles. Exported as `LARGE_CONTENT_THRESHOLD` from `truncate-large-content.ts`.
- **Zero overhead for small content** — no cloning occurs unless truncation is actually needed. The function returns the original event reference unchanged.
- **Original event never mutated** — `handleAgentLifecycle()` and `trackCostFromEvent()` receive the unmodified event. Only the broadcast/buffer path sees the truncated version.
- **Dual format support** — both `toolCall`/`arguments` (pi-coding-agent RPC format) and `tool_use`/`input` (Anthropic API format) are handled for robustness.
- **UI lazy loading** — `WriteRenderer` shows a preview (first 512 chars) with a "Load full content" button. Full content is fetched via `GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex`. See [docs/rest-api.md — Large content truncation](rest-api.md#large-content-truncation).
- **Streaming throttle** — `remote-agent.ts` throttles `streamMessage` updates to 2x/sec when content is truncated, reducing Lit re-render pressure in the browser.

### Key files

| File | Purpose |
|---|---|
| `truncate-large-content.ts` | `truncateLargeToolContent()` function and `LARGE_CONTENT_THRESHOLD` constant |
| `session-setup.ts` | Applies truncation in `subscribeToEvents()` before broadcast/buffer |
| `session-manager.ts` | Same truncation at all event listener sites |
| `server.ts` | REST endpoint for lazy-loading full content from `.jsonl` |
| `fetch-tool-content.ts` (UI) | Client-side REST helper for lazy loading |
| `WriteRenderer.ts` (UI) | Detects truncation, shows preview + "Load full content" button |
| `Messages.ts` (UI) | Handles `load-full-content` CustomEvent, fetches and re-renders |
| `remote-agent.ts` (UI) | Throttles stream updates for truncated content |

---

## Viewer WebSocket

The `/ws/viewer` endpoint provides a read-only, sessionless WebSocket connection for the goal dashboard to receive live gate verification events.

### Why a separate endpoint?

The main `/ws/:sessionId` endpoint binds a WebSocket to a specific agent session. When the user navigates to the goal dashboard, no session is active — the `RemoteAgent` disconnects. Without a connected WebSocket, `gate_verification_step_output` events from the server never reach the browser, so the verification output modal stays empty. The viewer endpoint solves this by keeping a lightweight connection open while the dashboard is mounted.

### Protocol

1. Client opens `ws(s)://<host>/ws/viewer`
2. Client sends `{ type: "auth", token: "<gateway-token>" }` — same auth as session connections
3. Server validates the token and responds with `{ type: "auth_ok" }`. The connection is marked as authenticated but is **not** associated with any session
4. Server broadcasts via `broadcastToGoal()`, which has a fallback path that sends to all authenticated clients with no session ID — this is how events reach the viewer
5. All client-to-server messages after auth are ignored (read-only)

### Client lifecycle

- **Connect on mount**: `loadDashboardData()` in `goal-dashboard.ts` opens the viewer WS after setting the current goal ID
- **Dispatch events**: Incoming messages are dispatched as `gate-verification-event` CustomEvents on `document`, matching the same pattern `RemoteAgent` uses — so `VerificationOutputModal` and `handleLiveVerificationEvent` work without modification
- **Disconnect on unmount**: `clearDashboardState()` closes the connection and clears the reconnect timer
- **Auto-reconnect**: On unexpected close, reconnects after a 3s delay (only if the dashboard is still mounted). Brief gaps are acceptable because the dashboard also polls gate status periodically

### Server handling

The upgrade handler in `server.ts` matches `/ws/viewer` alongside `/ws/:sessionId`. The WS handler in `handler.ts` recognizes the `__viewer__` sentinel session ID: after successful auth, it sends `auth_ok` and returns immediately without calling `sessionManager.addClient()` or syncing session state. No changes to `broadcastToGoal()` were needed — the existing fallback path already sends to authenticated clients with no session association.

## Goals, workflows, tasks & gates

See [goals-workflows-tasks.md](goals-workflows-tasks.md) for the full architecture.

### Goal re-attempt flow

1. User clicks "Re-attempt" in goal dashboard or sidebar
2. Goal assistant session created with `reattemptGoalId` → original goal's context loaded via `buildReattemptContext()`
3. Assistant guides: what went wrong, approach (revert/fix/both), new spec
4. On accept: old goal archived, new goal gets `reattemptOf` link

**Data:** `PersistedGoal.reattemptOf`, `PersistedSession.reattemptGoalId`. API: `POST /api/sessions` accepts `reattemptGoalId`; goals accept `reattemptOf`.

---

## Disk state

### `defaults/` — version controlled (shipped builtins)

| File / Directory | Owner | Purpose |
|---|---|---|
| `system-prompt.md` | `cli.ts` | Global system prompt template |
| `roles/*.yaml` | `RoleStore` | Built-in role definitions + tool access |
| `roles/assistant/*.yaml` | `assistant-registry.ts` | Built-in assistant prompts |
| `workflows/*.yaml` | `WorkflowStore` | Built-in workflow templates |
| `personalities/*.yaml` | `PersonalityStore` | Built-in personality definitions |
| `tools/<group>/*.yaml` | `ToolManager` | Built-in tool definitions + extensions |
| `tool-group-policies.yaml` | `ToolGroupPolicyStore` | Built-in group grant policies |

Copied to `dist/server/defaults/` at build time by `scripts/copy-defaults.mjs`. Read at runtime by `BuiltinConfigProvider`.

### `.bobbit/config/` — runtime overrides (gitignored)

| File / Directory | Owner | Purpose |
|---|---|---|
| `project.yaml` | `ProjectConfigStore` | Project settings |
| `roles/*.yaml` | `RoleStore` | Server/project role overrides |
| `workflows/*.yaml` | `WorkflowStore` | Server/project workflow overrides |
| `personalities/*.yaml` | `PersonalityStore` | Server/project personality overrides |
| `tools/<group>/*.yaml` | `ToolManager` | Server/project tool overrides |
| `tool-group-policies.yaml` | `ToolGroupPolicyStore` | Server/project policy overrides |
| `mcp.json` | `McpManager` | MCP server overrides |

### `<project-root>/.bobbit/state/` — per-project, gitignored

Each registered project has its own state directory. All store data is scoped to the owning project.

| File / Directory | Owner | Purpose |
|---|---|---|
| `goals.json` | `GoalStore` | Goal definitions |
| `sessions.json` | `SessionStore` | Session metadata |
| `tasks.json` | `TaskStore` | Task state |
| `gates.json` | `GateStore` | Gate state + signals |
| `team-state.json` | `TeamStore` | Team agents/roles |
| `staff.json` | `StaffStore` | Staff agents |
| `search.db` | `SearchIndex` | FTS5 search index |
| `costs/` | `CostTracker` | Token/cost data |
| `mcp-tool-docs/` | `McpManager` | Auto-generated MCP tool docs + summary caches |

### `<server-cwd>/.bobbit/state/` — global, gitignored

Only truly global state lives in the server's central state directory.

| File / Directory | Owner | Purpose |
|---|---|---|
| `projects.json` | `ProjectRegistry` | Registered project definitions |
| `token` | `token.ts` | Auth token (0600) |
| `session-colors.json` | `ColorStore` | Session colors |
| `preferences.json` | `PreferencesStore` | Key-value prefs |
| `session-prompts/` | `system-prompt.ts` | Per-session prompts |
| `tls/` | `tls.ts` | TLS certs |
| `gateway-url` | `cli.ts` | Gateway base URL |
| `gateway-restart` | `harness.ts` | Dev restart sentinel |
| `rpc-debug.log` | `rpc-bridge.ts` | RPC event log |
| `mcp-extensions/` | `tool-activation.ts` | MCP proxy extensions |

### Global

| File | Purpose |
|---|---|
| `~/.bobbit/agent/auth.json` | API auth credentials |
