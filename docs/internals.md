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
- **No default project.** Bobbit has no "default" project concept. On startup, the registry loads `projects.json` as-is — whatever is on disk, including zero projects. A fresh install is a valid state: the sidebar shows an Add Project CTA, and the toolbar **+ New Goal** button is disabled with tooltip "Add a project first" until at least one project is registered. Bobbit never implicitly registers a project based on the server CWD. `ProjectRegistry.ensureDefaultProject()` has been removed.
- `register()` validates `rootPath` is absolute and exists on disk, checks for duplicate paths, and scaffolds `.bobbit/config/` and `.bobbit/state/` in the project directory if needed. `POST /api/projects` supports `upsert: true` — if a project already exists at the same `rootPath`, the existing project is returned (200) instead of a 400 error. This makes project registration idempotent.
- `remove()` only unregisters — it does not delete files.
- **Delete protection:** `DELETE /api/projects/:id` returns `400 {"error":"Cannot delete the last remaining project — add another project first"}` when deleting would leave zero projects. There is no hidden carve-out for a "first" or "CWD" project — every project can be removed as long as at least one other project remains. Under `BOBBIT_E2E=1`, `?force=1` bypasses the last-project guard for tests that need to exercise the zero-project UX.
- The per-project settings page General tab exposes a "Remove Project" button in a Danger Zone section for every registered project. On confirmation, it calls `DELETE /api/projects/:id`, which invokes `remove()` and navigates the user back to system settings.
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
    search.flex/   # Lexical search index for THIS project (FlexSearch JSON)
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

- **State stores** (stateDir): GoalStore, SessionStore, GateStore, TaskStore, TeamStore, StaffStore, ColorStore, SearchService, CostTracker
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
3. **Explicit-required on creation** — `POST /api/sessions`, `POST /api/goals`, and `POST /api/staff` resolve the target project at the top of the handler via the `resolveProjectForRequest` helper in `src/server/agent/resolve-project.ts`. Resolution order: explicit `body.projectId` → `body.cwd` matching a registered project's `rootPath` → **400 Bad Request**. There is no creation-time default. Once created, the entity's `projectId` is set and all subsequent operations resolve through paths 1 or 2.

`ProjectContextManager` no longer exposes `getDefault()`, `getDefaultOrNull()`, `getDefaultProjectId()`, or `getDefaultProjectIdOrNull()`; `ProjectRegistry` no longer exposes `ensureDefaultProject()`. Any code path that needs a project must either resolve it explicitly (via `resolveProjectForRequest`, an entity lookup, or a threaded `projectId` parameter) or return 400. The only remaining reference to a "first registered project" is in `state-migration.ts`, and it is migration-only — see the block comment on `migrateToPerProjectState()` and the State migration section below.

##### Project selection contract

`POST /api/goals`, `POST /api/sessions`, and `POST /api/staff` share the following 400 contract:

| Condition | Body |
|---|---|
| Neither `projectId` nor `cwd` provided | `{"error":"projectId required: no projectId was provided and cwd (\"\") does not match any registered project"}` |
| `cwd` provided but no registered project has that `rootPath` | `{"error":"projectId required: no projectId was provided and cwd (\"<cwd>\") does not match any registered project"}` |
| `projectId` provided but unknown | `{"error":"Invalid project"}` (pre-existing) |

Callers should always pass an explicit `projectId` when one is available. `cwd`-only resolution exists to support agent tools and external scripts that only know a filesystem path.

`SessionManager` does not hold default store fields (`this.store`, `this.costTracker`, etc.). All store access goes through PCM resolution. `TeamManager`, `StaffManager`, and `VerificationHarness` follow the same pattern — they resolve stores per-goal or per-entity via PCM, with no fallback store references. `resolveStoreForId()` returns `null` instead of falling back, and callers use optional chaining.

**Verification harness project config resolution.** `VerificationHarness` resolves `ProjectConfigStore` per-goal via the private `resolveProjectConfigStore(goalId)` helper (alongside `resolveGateStore` etc.), not the server-level `projectConfigStore` injected at construction. This is what makes `{{project.*}}` substitution (e.g. `typecheck_command`, `test_unit_command`, `qa_max_duration_minutes`) pull from the **goal's owning project** config rather than the server's default. All four call sites — command-type verify steps in `runVerification`, LLM-review retry prompts in `_rerunLlmReviewStep`, agent-QA retry prompts in `_rerunAgentQaStep`, and the QA timeout lookup — go through the helper. If `projectContextManager` is unset (tests, legacy wiring) the helper silently falls back to the injected store; if it is set but the goal is not found in any context, the helper logs a `[verification]` warning and falls back, so the class of bug is diagnosable from logs.

This design prevents a class of data corruption bugs where missing `projectId` values silently route data to the wrong project's store.

**Per-project config directory scoping:** Config directories (for MCP servers, skills, and AGENTS.md/agent files) are resolved per-project. When a session is created for a project, the pipeline resolves that project's `ProjectConfigStore` to discover its custom config directories. This means each project can define its own MCP servers, slash skills, and agent instruction files via `config_directories` in its `project.yaml`, and sessions in that project will use them. MCP discovery additionally scans all registered projects so that MCP servers defined in any project are available to all sessions (with the primary project's configs taking priority on name conflicts).

### State migration

On first startup after upgrading to per-project state, `migrateToPerProjectState()` (`state-migration.ts`) distributes centralized state to per-project directories:

1. Reads central `goals.json`, `sessions.json`, `tasks.json`, `team-state.json`, `gates.json`, `staff.json`
2. Groups records by `projectId` (tasks/teams/gates resolve via their goal's project)
3. Merges into each project's `<rootPath>/.bobbit/state/` (avoids duplicates by ID)
4. Staff agents without a `projectId` are anchored to the migration target project (`projectRegistry.getByPath(serverCwd)` if registered, else `projects[0]`). This is **migration-only** behavior — it runs once, is guarded by `.migrated-to-per-project`, and does not imply a runtime default. The block comment on `migrateToPerProjectState()` explains why this anchor is safe and why it must not be reused elsewhere.
5. Renames central files with `.pre-migration` suffix (not deleted)
6. Writes `.bobbit/state/.migrated-to-per-project` marker to prevent re-running

The migration is idempotent and handles missing files gracefully (fresh installs have nothing to migrate). Any legacy central or per-project `search.db` is deleted on first startup under the new code — FlexSearch indexes rebuild automatically on first access (see [Semantic search](#semantic-search)).

**What stays global**: `projects.json`, auth token, gateway URL, preferences, session colors, PR status.

**Known limitations**: `active-verifications.json` stays in the central state dir (transient operational state).

### Verification architecture

The verification system is split into two modules:
- **`verification-harness.ts`** — orchestration: session lifecycle, WS event broadcasting, process spawning, retry logic, persistence. Also implements the **blocking-tool** contract used by `verification_result`: a tool extension POSTs a verdict, which resolves the Promise registered when the gate signal started verification. See [docs/blocking-tools.md](blocking-tools.md) for the pattern. The `ask_user_choices` tool uses a different, non-blocking shape — see [docs/non-blocking-ask.md](non-blocking-ask.md).
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

For each config type, items are merged by a unique key (roles by `name`, workflows by `id`, tools by `name`). Later layers shadow earlier ones entirely — no field-level merge. Without `projectId`, returns system scope (builtins + server stores at `<server-cwd>/.bobbit/config/`). With `projectId`, the project layer is added on top. Hidden workflows (e.g. `test-fast`) are filtered out at the cascade level.

**System-scope writes** (role / personality / workflow customize + override endpoints with `scope=server` or no scope) route to the standalone server stores constructed at module top in `src/server/server.ts` (`roleStore`, `personalityStore`, `workflowStore`, `toolManager`), which are backed by `<server-cwd>/.bobbit/config/`. They are **never** written into any project's store. Zero-project installs can still customize system-scope roles, personalities, and workflows because the server stores are independent of `ProjectContextManager`.

#### Server stores decoupling

`ConfigCascade` accepts explicit `ServerStores` accessors rather than reading from any project's stores. The standalone stores in `server.ts` are backed by `<server-cwd>/.bobbit/config/` (or `$BOBBIT_DIR/.bobbit/config/` in E2E tests). Using explicit accessors ensures PUT and GET use the same underlying stores and decouples the server layer from whether any project is registered.

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

**Mid-session project proposals**: Any agent session — regular, goal, staff, or non-project assistant — can call the `propose_project` tool to suggest changes to the current project's config, not just the project-assistant flow. The motivation is that agents often discover a missing test command, a better worktree setup, or a stale model preference while working on a goal; forcing the user into a separate project-assistant session just to accept that fix loses context. When a proposal arrives, the preview panel grows a "Project" tab showing a diff of the proposed fields against the current `project.yaml` (loaded via `GET /api/projects/:id/config`) and registry record. Unchanged fields collapse into a "No changes" group; `root_path` is read-only. The accept handler branches on whether the project is provisional:

- **Provisional** (project-assistant flow, unchanged): promote via `POST /api/projects/:id/promote`, write config via `PUT /api/projects/:id/config`, then terminate the assistant session and navigate to landing.
- **Registered** (new path): `PUT /api/projects/:id/config` for project.yaml fields and `PUT /api/projects/:id` for the project name if it changed. The session stays connected and the agent continues where it left off — no navigation, no termination.

The generic `PUT /api/projects/:id/config` endpoint is a passthrough KV writer (validates keys contain no dots, clears on empty string / `null`, otherwise writes), so any scalar `project.yaml` field is accepted — `build_command`, `test_command`, `typecheck_command`, `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `qa_start_command`, `sandbox`, plus project-defined custom keys. Model preferences (`session_model`, `review_model`, `naming_model`) live outside `project.yaml` in the preferences store and are handled by `propose_setup` rather than `propose_project`. Key modules: `session-manager.ts::acceptProjectProposal` (dispatcher), `render.ts::projectProposalPanel` (diff UI), `state.activeProjectProposal` (proposal + `currentConfig` snapshot). Full spec: [design/mid-session-project-proposals.md](design/mid-session-project-proposals.md).

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

**Session creation modes:** The session-setup pipeline (`src/server/agent/session-setup.ts`) handles four modes, all routed through the same plan/execute structure:

| Mode | Triggered by | Worktree? | Seed context? |
|---|---|---|---|
| Normal (assistant) | `POST /api/sessions` for assistant types (goal/project/tool) | No | No |
| Worktree | `POST /api/sessions` for non-goal, non-assistant sessions in a git repo | Yes (auto) | No |
| Delegate | Parent session spawns a child via the `delegate` tool | Inherits parent cwd | No |
| Continue-Archived | `POST /api/sessions/:archivedId/continue` | Yes (fresh) if source had one | Yes — archived transcript |

Continue-Archived sessions are covered in detail under [Continue-Archived sessions](#continue-archived-sessions) below.

**Staff agent worktrees:** Staff agents get a permanent worktree at creation time. Because staff sessions are long-lived (they persist across wake/sleep cycles rather than being recreated), their worktrees can become stale over time. To address this, `StaffManager.refreshWorktree()` runs on each wake cycle for non-sandboxed staff: it rebases the worktree branch onto the primary branch and re-runs the project's `worktree_setup_command` (e.g. `npm ci`). Sandboxed staff agents skip the host-side refresh — their container-internal worktrees are managed via `sandboxBranch`, which is passed to `createSession()` during staff creation and legacy migration so the container creates the worktree properly.

### Git status cache & client resilience

The git-status widget (shown on every session with a worktree and on the goal dashboard) exposes branch / ahead / behind / dirty state. It must stay visible through transient server load, network drops, and container recycles — the user loses orientation if it flickers out. The widget only disappears when the server *explicitly* confirms the cwd is not a git repository.

Full design lives in [docs/design/git-status-widget-reliability.md](design/git-status-widget-reliability.md). The sketch:

**Server (`src/server/server.ts`).** `batchGitStatus` is a 750ms-TTL single-flight cache wrapping the raw `runBatchGitStatus` spawn worker. Cache key is `${containerId ?? 'host'}::${cwd}::${summary|untracked}`. Concurrent callers share the same in-flight promise, resolved entries are reused for up to 750ms, errors are never cached (the entry is deleted on rejection so the next call retries fresh). The 750ms window is short enough that users never see "stale" data but long enough to collapse the idle / reconnect / visibility-change refresh storm into one git invocation. `invalidateGitStatusCache(cwd, containerId?)` is called from `/git-commit`, `/git-pull`, `/git-push`, merge endpoints, and the `?fetch=true` branch so local git writes never return cached pre-write state.

The default `/git-status` call uses `git status --porcelain=v1 -uno` (summary: skips untracked scan, which is the long tail on large repos). `?untracked=1` switches to `-uall` and sets `untrackedIncluded: true` on the response; clients must not treat `clean` as authoritative when `untrackedIncluded === false`. The session widget fetches summary by default and refetches `?untracked=1` when the user opens the dropdown — the widget dispatches a `git-status-dropdown-open` CustomEvent (bubbles, composed) for this. Summary and untracked responses live in separate cache keys so one doesn't shadow the other.

Spawn-level retry inside `runBatchGitStatus` swallows transient errors (EAGAIN, ENOBUFS, EBUSY, EMFILE, ENFILE, ETIMEDOUT, SIGTERM/SIGKILL, transient ENOENT on win32) with a short backoff; the HTTP handler adds a single belt-and-braces retry on any uncaught error. 15s overall timeout. Responses carry optional `partial: true` when Phase B (porcelain) times out but Phase A (branch / ahead / behind / upstream) succeeded — the client renders a yellow warning dot and the dropdown offers Re-scan.

Test-only hooks — `__setGitStatusFake` / `__clearGitStatusFake` / `__getGitStatusInvocationCount` / `__resetGitStatusInvocationCount` — replace the git-spawn path with a deterministic function so coalesce/TTL/retry E2E tests don't depend on the real `git status` binary, which becomes flaky under CI load (EAGAIN / ENFILE / Windows ENOENT races). Production code never touches them.

**Client (`src/app/api.ts`, `src/app/session-manager.ts`, `src/app/goal-dashboard.ts`, `src/ui/components/AgentInterface.ts`, `src/ui/components/GitStatusWidget.ts`, `src/app/git-status-refresh.ts`).**

- `fetchGitStatus` returns a discriminated `GitStatusResult = { kind: 'ok', data } | { kind: 'not-a-repo' } | { kind: 'error', err }`. Never `null`, never throws. The old `null` return collapsed "not a repo" and "transient failure" into the same outcome, which is exactly the bug that caused widget disappearance.
- Tri-state `gitRepoKnown: 'yes' | 'no' | 'unknown'` (property on `AgentInterface`, module variable in `goal-dashboard.ts`) gates rendering. Default `'unknown'` on session connect / dashboard load. Only HTTP 400 with `error === "Not a git repository"` flips to `'no'` (widget hides). 200 → `'yes'`. Any other non-2xx / network error / abort leaves it unchanged — widget stays visible with last-known-good data (or skeleton if there was none).
- `refreshGitStatusForSession` runs up to 4 attempts at [0, 500, 2000, 5000]ms. One in-flight refresh per session (tracked in a `Map<sessionId, AbortController>`); a session switch aborts the controller so retries don't land on the wrong `AgentInterface`. `gitStatusLoading = true` spans the entire retry chain and clears only in the final `finally` — users see continuous loading, not flicker.
- 30s safety poll (session) gated on `document.visibilityState === 'visible'` + active session + `gitRepoKnown !== 'no'`. 10s coalesce window via `gitStatusLastRefreshAt` so event-driven refreshes (agent idle, reconnect, local git action) don't double-fire with the poll. On `visibilitychange → visible` an immediate refresh fires rather than waiting out the interval. The goal dashboard uses the identical tri-state + retry at its existing 60s cadence (cadence unchanged per the design's out-of-scope list).
- `GitStatusWidget` has reactive `loading` and `partial` props. `loading && !branch` → shimmer skeleton ("Checking git…"); `loading && branch` → existing content + pulsing dot; `partial && branch` → yellow warning dot.

**Why tri-state plus retry instead of a single boolean "have we ever seen data"?** The `'no'` decision has to be authoritative — the widget is the user's only feedback that we even *tried* to read git state. Inferring "not a repo" from any failure mode (the pre-fix behaviour) silently hid the widget for network blips, CPU spikes, git lockfile contention, and Docker exec hiccups, and the only way the user got it back was a page reload. Making the server say it explicitly, and keeping every other failure visibly in `'unknown'` with retries, means the UI state always matches what we actually know.

### Continue-Archived sessions

Archived, non-goal, non-delegate sessions render a "Continue in New Session" button below their transcript. Clicking it creates a brand-new session that inherits the archived session's **settings** but none of its **runtime state**.

**Why split settings from runtime state**: Users reopening an archived session usually want to resume the task, not resurrect the exact environment. The old worktree may be gone, the sandbox container may have been pruned, and the branch may be merged or abandoned. Continue-Archived gives them the same tools (model, role, personality, sandbox/worktree flags) in a fresh runtime, with the prior conversation available as context only.

**What is copied:**

- `projectId`
- `modelProvider`, `modelId` (applied post-create via `setModel` + persisted immediately; worktree sessions set the model once the agent is ready)
- `role` (resolved via `roleManager.getRole()`, so prompt/accessory/tool policies are re-applied fresh)
- `personalities` (re-resolved through `personalityManager`)
- `sandboxed` flag (new container state per normal per-project sandbox rules)
- `worktreePath` presence — if the source had a worktree, the new session gets one via the standard pipeline (pool claim or `git worktree add`)

**What is explicitly NOT copied:**

- Working directory, worktree path, branch, uncommitted changes
- Sandbox container identity or in-container state (the new session joins the project's container per normal semantics)
- `goalId`, `teamGoalId`, `teamLeadSessionId`, `delegateOf` — guaranteed absent because the scope gate rejects those source types up front
- Task/gate signals, streaming state, tool state

**Scope gate** (enforced server-side in `handleApiRoute()` and client-side in `AgentInterface.ts`): the source must be archived, have no `goalId`, no `delegateOf`, no `teamGoalId`, no `assistantType`, and its project must still be registered. Violations return `409` / `422` / `410` respectively. See [docs/rest-api.md — Continue-Archived endpoint](rest-api.md#continue-archived-endpoint) for the full error table.

**Seed context**: The archived transcript (loaded via `sessionManager.getArchivedMessages()`) is rendered by `buildSeedContext()` in `src/server/agent/continue-archived.ts`:

- **Full mode**: `renderMessagesAsText()` flattens each message to `### <role>\n\n<body>`, rendering tool calls/results inline, dropping internal thinking blocks and base64 images. The output is capped at 128 KB (`SEED_TOTAL_BUDGET`).
- **Summary mode**: The transcript (capped at 60 KB input for the model call) is sent to the configured naming model with a bullet-point prompt covering goal, decisions, files touched, open threads. On model failure the helper falls back to full mode — users never get an empty seed.

The resulting string is passed to `createSession()` as `opts.seedContext` (with `seedContextSourceId` for attribution) and flows through `SessionSetupPlan.seedContext` → `PromptParts.seedContext` → `assembleSystemPrompt()` in `src/server/agent/system-prompt.ts`, which emits it under a `## Prior Session Transcript` heading with an instruction telling the agent the text is context-only and not an implicit request to act. The same content appears in the system-prompt tokens view (labeled `Prior Session Transcript` with a `Continued from archived session <id>` source) so users can see token cost impact.

**Title**: The new session is titled `Continued: <original title>` and the title is marked `markGenerated: true` so the first-message auto-titler does not overwrite it.

**Key files:**

- `src/server/agent/continue-archived.ts` — seed-context builder (rendering + summarization + budgets)
- `src/server/server.ts` — `POST /api/sessions/:archivedId/continue` handler (scope gate, settings extraction, session creation)
- `src/server/agent/session-setup.ts` — `SessionSetupPlan.seedContext` + `seedContextSourceId` fields
- `src/server/agent/system-prompt.ts` — `Prior Session Transcript` section assembly
- `src/ui/components/AgentInterface.ts` — footer renderer, keyed by `[data-continue-archived-footer]`
- `src/ui/components/ContinueSessionChooser.ts` — mode chooser dialog (Summary vs Full, with large-transcript warning)

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

**Toolbar "+ New Goal" behavior** depends on how many projects are registered:

| # projects | Click behavior |
|---|---|
| 0 | Button disabled with tooltip "Add a project first". Empty-state Add Project CTA is the primary action. |
| 1 | Skips the picker entirely and opens the goal creation dialog directly, scoped to the one project. |
| 2+ | Opens `<project-picker-popover>` (`src/ui/components/ProjectPickerPopover.ts`) anchored beneath the button, listing every registered project with its color dot. Clicking a project starts goal creation scoped to it; Esc / click-outside closes; arrow keys + Enter navigate. On mobile (viewport < 640px) the popover renders as a centered sheet. |

The per-project "+ goal" button on each project row bypasses the popover — the project is already unambiguous. Goal creation is centralized in `startNewGoalFlow(anchorEl)` in `src/app/goal-entry.ts` so every call site (toolbar button, mobile nav, empty-state CTA, `Alt+G` shortcut) stays in sync.

**Collapse state is per-project**: The Sessions and Staff section collapse toggles are stored per-project, not globally. Collapsing Sessions in Project A does not affect Project B. State is persisted as collapsed-project-ID sets in localStorage (`bobbit-collapsed-ungrouped`, `bobbit-collapsed-staff`). Default state is expanded for all projects. Access via `isUngroupedExpanded(projectId)` / `setUngroupedExpanded(projectId, value)` and `isStaffExpanded(projectId)` / `setStaffSectionExpanded(projectId, value)` in `state.ts`.

**Per-project Archived subsections**: Each project group ends with its own collapsible Archived subsection (rendered by `renderProjectArchivedSection` in `src/app/render-helpers.ts`, shared between desktop `renderSidebar` (`src/app/sidebar.ts`) and mobile `renderMobileLanding` (`src/app/render.ts`) so both breakpoints render identically). Bucketing is currently split: desktop uses an inline loop in `sidebar.ts` that emits `console.warn` for orphaned items, while mobile uses the `bucketArchivedByProject` helper in `render-helpers.ts` which silently drops unmatched items. The global Archived block that used to sit at the bottom of the sidebar is gone.

- **Global visibility toggle**: The bottom-bar "See Archived" button (localStorage `bobbit-show-archived`, state `state.showArchived`) still controls whether any archived content is rendered at all. It is global, not per-project — one toggle flips every per-project Archived subsection at once. This keeps the user-visible UX contract of the pre-existing toggle unchanged.
- **Per-project collapse state**: Each project's Archived subsection defaults to **expanded** when `showArchived` is on; users can collapse individual projects' subsections independently. Collapsed project IDs are persisted in localStorage `bobbit-archived-collapsed-projects` (mirrors `bobbit-collapsed-ungrouped` / `bobbit-collapsed-staff`). Access via `isArchivedSectionExpanded(projectId)` / `setArchivedSectionExpanded(projectId, value)` in `state.ts`. Default-expanded is deliberate: before the per-project split there was no intermediate "collapsed but visible" state, so expanded-by-default preserves the old behaviour of "See Archived on = archived items are visible".
- **Orphaned-item fallback**: Archived goals or sessions whose `projectId` is missing or does not resolve to a registered project are bucketed into the first project's Archived subsection so they remain visible to the user rather than silently disappearing. This is a UI rendering fallback for data inconsistencies — it does not imply a runtime default project on the server side. On desktop the fallback emits a `console.warn` to make the inconsistency debuggable; on mobile (via `bucketArchivedByProject` in `render-helpers.ts`) the fallback is silent.
- **Pagination (v1)**: Archived goals and sessions are still fetched globally (not per-project) via `GET /api/goals?archived=true` and `GET /api/sessions?include=archived`. The "Load more archived goals…" / "Load more archived sessions…" buttons are rendered **once**, below the project list, not per project. Per-project pagination would require server-side `projectId` filters on those endpoints and is intentionally deferred. On mobile the pagination buttons are additionally hidden while a search query is active, since search results collapse the per-project layout.
- **Search**: The `_archivedBySearch` / `_ensureArchivedForSearch` auto-open behaviour is unchanged — a search match inside any archived item still forces `state.showArchived` on globally. When a search query is active, each project's subsection only renders matching items; projects with no matches render no Archived subsection at all.
- **Collapsed sidebar**: `renderCollapsedSidebar` is unchanged — archived goals continue to render inline with live goals in the icon-only rail.

### REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all registered projects |
| `POST` | `/api/projects` | Register a project (body: `name`, `rootPath`, optional `color`) |
| `GET` | `/api/projects/:id` | Get a single project |
| `PUT` | `/api/projects/:id` | Update name/color |
| `DELETE` | `/api/projects/:id` | Unregister (blocked when it would leave zero projects; `?force=1` under `BOBBIT_E2E=1` bypasses) |
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

## Semantic search

Lexical search over goals, sessions, messages, and staff. One embedded index per project; everything runs locally with **no runtime network calls and no native binaries**.

> **Authoritative design:** [docs/design/portable-search.md](design/portable-search.md) — this section is the quick reference; the design doc is the source of truth for schema, ranking, and rationale. The earlier [docs/design/semantic-search.md](design/semantic-search.md) covers the previous Nomic+LanceDB architecture and is kept for historical context only.

### Why this shape

Bobbit must install and run anywhere — including network-restricted environments. The previous stack (Nomic embeddings + LanceDB) pulled in `@huggingface/transformers`, `onnxruntime-node`, `sharp`, and platform-specific Rust binaries, plus a ~140–500 MB model download on first search. Any of those can fail in an airgap.

The current engine is **[FlexSearch](https://github.com/nextapps-de/flexsearch)** — a pure-JS, zero-dependency full-text index library. One backend, one code path, no native compilation, no postinstall network work, no model cache. Natural-language "fuzzy meaning" queries are weaker than an embedding model; identifier/keyword search is **better** because strict tokenization ranks exact symbol matches first.

### Store

- **FlexSearch `Document` index** — one per project at `<project-root>/.bobbit/state/search.flex/`.
  - `index/<key>.json` — one file per FlexSearch export key (posting lists, document registry, tag index, cache).
  - `meta.json` — engine name/version, schema version, content policy version, last rebuild timestamp.
- Multi-field document schema: natural-language fields (`title`, `text`) use forward-prefix tokenization with stemming; an `identifier_text` field uses strict tokenization for exact-symbol matches (camelCase, snake_case, dotted paths all indexed as decomposed tokens).
- Persistence is export/import via FlexSearch's built-in serializer, written per-key with an atomic `.tmp` → rename and a trailing-edge debounce. Crash-mid-write leaves `.tmp` files that the loader skips on next open.
- Meta mismatch on startup triggers a full rebuild from the source-of-truth stores. Fields checked: `engine`, `engineVersion`, `schemaVersion`, `contentPolicyVersion`.

### Abstractions

The surface in `src/server/search/types.ts` that downstream code sees is unchanged from the previous backend, so v2 work (e.g. file indexing) drops in without a refactor:

- **`IndexSource`** — `iterate(ctx)` and optional `watch(ctx)`. Goals, sessions, messages, staff today. File indexing arrives via the same interface; `sources/files-source.stub.ts` ships as a reference shape.
- **`Indexable`** — uniform shape handed to the indexer: `id`, `sourceId`, `text`, `metadata`, `contentHash`, `weight`, `role`, optional `display`.
- **`SearchQuery`** / **`SearchResult`** / **`SearchResults`** — caller-facing query and result shapes.

`SearchService` (`search-service.ts`) is the per-project facade that bundles `FlexSearchStore`, `Indexer`, and the source array. `ProjectContext` constructs and owns one per project. No embedder component exists.

### Content policy (role-aware weighting)

What gets indexed per message matters more than the store choice. `content-policy.ts` (replaces the old `message-extractor.ts`) extracts role-tagged entries with weights applied as post-rank multipliers:

| Role | Weight | Text indexed |
|---|---|---|
| `title` (session title) | 3.0 | full |
| `spec` (goal spec) | 2.5 | `title + spec` |
| `user` (user message) | 2.0 | full |
| `profile` (staff profile) | 1.5 | `name + description` |
| `assistant` (assistant text) | 1.0 | `<thinking>…</thinking>` stripped before embedding |
| `tool_call` | 0.8 | `<tool_name> + first line of input` |
| `tool_result` | 0.5 | first 500 chars; **hard-skipped if raw >32KB** (aligns with `truncate-large-content.ts`) |

Bump `CONTENT_POLICY_VERSION` when the policy changes — the meta-mismatch check auto-rebuilds. Weights are tunable server-side without re-indexing the content itself.

### Chunking

`chunker.ts` splits overlong text into bounded chunks with overlap using an approximate-token counter (~4 chars/token). Chunk IDs follow `<parentId>:chunk:<n>` and the `parent_id` field stores the pre-chunk id. The store collapses by `parent_id` after ranking — one result per logical entity, keyed to the best-scoring chunk. Chunking remains because BM25 prefers bounded documents; exact token counts no longer matter (there is no embedding context window).

### Ranking

BM25-style lexical scoring across three indexed fields (`identifier_text`, `title`, `text`) with per-field boost (identifiers outrank titles, titles outrank body text). The final score is `fieldScore × doc.weight × recencyMultiplier`, where `weight` is the role-aware content-policy multiplier and `recencyMultiplier` decays recent-content bias to 1.0× over a 30-day half-life. Results are then collapsed by `parent_id` and the window sliced by `offset`/`limit`. Filters (`projectId`, `archived`, `types`) apply via FlexSearch tag filters. Snippet rendering in `snippet.ts` uses the same `<b>` contract — `search-page.ts` consumes an unchanged result shape.

### Orphan filtering & stale-click safety net

Search indexes lag behind deletes — a goal, session, or staff record can be removed between the index write and the next query, and the user ends up clicking a result that goes nowhere (blank goal dashboard, `SESSION_NOT_FOUND` modal, blank staff form). Two layers catch this:

- **Server-side orphan filter** (`ProjectContextManager.searchAll()` in `src/server/agent/project-context-manager.ts`): after merging per-project results, each hit is checked against the authoritative stores — `projectRegistry.has(projectId)`, `goalStore.get(id)` (live or archived), `sessionManager.getPersistedSession(id)` (live/dormant/archived), `staffStore.get(id)`. Hits that fail the check are dropped, `total` is recomputed from the filtered list (so Load More's remainder is honest), and a fire-and-forget opportunistic cleanup removes the stale rows from the owning project's `SearchService` (`removeGoal` / `removeSession` / `removeMessagesForSession` / `removeStaff`). The response does not wait on cleanup. This complements — does not replace — the Maintenance → Orphaned Index Rows scanner.
- **Weak-match tagging** (`toSearchResult()` in `src/server/search/flex-store.ts`): every `SearchResult` carries `matchedOn: "text" | "metadata"` based on whether the sanitized snippet contains a `<b>` highlight. `message` rows with `matchedOn === "metadata"` are phantom matches (token hit metadata only — the user can't see why) and are dropped in the same post-filter pass. Goal/session/staff weak-matches are kept (the match is real — the highlighter's window just didn't land on the token) and rendered with a muted "matched on title/metadata" note. Field is optional for back-compat; legacy clients treat an absent value as `"text"`.

### Grouped search results & stale-click toast

The full search page (`src/app/search-page.ts`) runs a purely client-side transform over the flat `SearchResult[]` into `ResultGroup` cards via `buildGroups()`: one card per unique goal / session / staff (staff are standalone; messages nest under their session; goals/sessions/staff render as peer top-level cards to keep nesting at two levels max). The collapsed card header carries up to two `<b>`-highlighted snippet fragments and a match-count pill; the chevron button toggles a per-render `_expanded` set (keyed by `kind:id`, not persisted across reloads); groups with `totalMatches === 1` auto-expand. The client-side type-filter runs *before* grouping so pill counts stay honest.

A click can still race a concurrent delete (entity existed at query time, gone at click time). Rather than bubble that up as a blocking `showConnectionError` modal or a blank dashboard, navigation from the search page is origin-tagged:

- `connectToSession(id, true, { onMissing: "toast" })` in `src/app/session-manager.ts` — on `SESSION_NOT_FOUND` / WS close code 4005, skip the modal and dispatch `window.dispatchEvent(new CustomEvent("search-result-stale", { detail: { kind, id } }))`.
- `src/app/goal-dashboard.ts` — on a 404 from the dashboard loader, dispatch the same event when the previous hash was `#/search`.
- `src/app/staff-page.ts` — same pattern for missing staff ids.

`search-page.ts` listens for `search-result-stale`, shows an inline 5s auto-dismiss toast, and marks the corresponding row with muted opacity + a "stale" badge. Non-search callers of `connectToSession` keep the default `onMissing: "modal"` behavior unchanged.

### Graceful degradation

Failure is surfaced as the **red status dot** + "Search unavailable" — never a silent partial mode. There is only one disabled path now (catastrophic store failure, e.g. the state dir is unwritable); `/api/search` returns **503** with `{ error: "search-unavailable", reason, state }`. See [docs/design/portable-search.md §10](design/portable-search.md) for the state machine (`initializing` → `ready` → `disabled` → `closed`).

### Re-indexing triggers

- **Incremental** (continuous, invisible): new messages, goal/session/staff create/edit/rename/archive → upsert via `SearchService.indexX(entity)`. Incremental upsert skips unchanged rows via `contentHash` comparison.
- **Full rebuild** (rare): first boot on a project with no `search.flex/` directory, meta mismatch (engine upgrade, schema version bump, content-policy version bump), index fails to load, or user clicks **Rebuild Index** in Settings. Runs in the background; status dot goes yellow.
- **Legacy cleanup:** on first open under the current engine, a stale `search.lance/` directory from the previous backend is deleted. The shared model cache at `~/.bobbit/models/` (from the earlier Nomic embedder) is no longer used — users can `rm -rf ~/.bobbit/models` to reclaim disk; Bobbit does not touch it automatically.

### WebSocket events

Added to `ServerMessage` in `ws/protocol.ts`, broadcast per-project and debounced at 500ms:

- `index:progress` — `{ phase: "rebuild"|"incremental", total, completed, backlog }`
- `index:complete` — `{ phase, durationMs, rowsWritten }`
- `index:error` — `{ message, recoverable }`

These drive the **search status dot** (`src/app/components/search-status-dot.ts`): green (idle), yellow (`backlog > 50` or active rebuild), red (unavailable, with Retry link).

### REST endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=…&projectId=…&type=…&limit=…&offset=…` | Hybrid query. `projectId` omitted → search across all projects. Results include `projectId`/`projectName`. Returns **503** when the service is disabled. |
| `POST /api/search/rebuild?projectId=…` | Kick off a full rebuild. Runs in background; progress via WS. |
| `GET /api/search/stats?projectId=…` | Service state, engine name + version, per-source row counts, dataset size on disk, last rebuild timestamp. **400** if `projectId` missing; **503** if disabled. |
| `POST /api/search/compact?projectId=…` | No-op under FlexSearch. Retained for API compatibility so older clients don't 404; always returns `{ ok: true }`. |
| `GET /api/maintenance/orphaned-index-rows?projectId=…` | Rows whose parent entity no longer exists. |
| `POST /api/maintenance/cleanup-index-rows?projectId=…` | Delete them. |

### Migration

Indexes are a rebuildable cache; the source-of-truth stores repopulate automatically via `rebuildFromSources([...])` on a meta mismatch. Any legacy `search.db` (pre-LanceDB) or `search.lance/` (pre-FlexSearch) directory is deleted on first startup under the current code — no data loss, just a one-time rebuild.

### Maintenance panel

**Settings → Maintenance → Search Index** surfaces engine name/version, state, last rebuild time, dataset size, and per-source row counts. Controls are **Refresh** and **Rebuild Index**; live rebuild progress is streamed over the WS events above. The earlier *Retry Download* and *Compact Dataset* buttons are gone — there is no model to download, and compaction is a no-op under the pure-JS engine.

### Two-mode search UX

**1. Filter mode (sidebar):** Instant client-side filtering — no API calls. Filters goals by title, sessions by title and agent role, and staff by name using case-insensitive substring matching. Archived sections auto-expand on a match and auto-collapse when cleared. A "Full Search" link navigates to the full search page with the current query. Key file: `SearchBox.ts`; filtering lives in `Sidebar.ts`.

**2. Full search page (`#/search`):** The sole consumer of `GET /api/search`. Large auto-focused input, type filter toggles (Goals, Sessions, Staff, Messages), grouped results with `<b>`-highlighted snippets, relative timestamps, archived badges, and "Load More" pagination. Key file: `search-page.ts`.

> **Design note — gate content:** Gate content (design specs, review findings) is not currently indexed. Tracked for future work; adding it requires bumping `SCHEMA_VERSION` or `CONTENT_POLICY_VERSION` to force a rebuild.

### Paginated archives

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

**Per-project scoping:** Config directories are resolved per-project. Each project's `config_directories` in its `project.yaml` affects only that project's sessions — a session in project B uses project B's custom directories for skill, MCP, and agent file discovery. Projects never inherit each other's config directories. The API endpoints (`/api/config-directories`, `/api/slash-skills`, `/api/slash-skills/details`) accept a `?projectId=` query parameter to resolve directories for a specific project.

**Built-in directories:**

| Type | Directories |
|---|---|
| Skills | `.claude/skills/`, `.bobbit/skills/`, `~/.claude/skills/`, `~/.bobbit/skills/`, `.claude/commands/` |
| MCP | `~/.claude.json`, `~/.claude/.mcp.json`, `~/.bobbit/.mcp.json`, `.mcp.json`, `.claude/.mcp.json`, `.bobbit/config/mcp.json` |
| Tools | `defaults/tools/` (builtins), `.bobbit/config/tools/` (overrides) |
| Agents | `AGENTS.md` (falls back to `CLAUDE.md`) |

**Agents type:** entries point at individual files, not directories. Concatenated into system prompt in order. `@ref` resolved relative to file's parent dir.

**Key file:** `src/server/agent/config-directories.ts`

### Skill chip rendering & autonomous activation

Skills follow the [Agent Skills spec](https://agentskills.io/specification)'s *progressive disclosure* model: skill name + description load with the system prompt (level 1, ~100 tokens each), the full body loads only when the skill is activated (level 2). This keeps the system prompt cheap regardless of how many skills are installed while still letting the agent self-route to the right one mid-turn. Full design: [docs/design/skill-ux-and-autonomous-activation.md](design/skill-ux-and-autonomous-activation.md).

**User invocation — literal text + chip.** When a user types `/name args` (prefix-only) or includes `/name` inline, `resolveSkillExpansions()` (`src/server/skills/resolve-skill-expansions.ts`) returns the original text plus a `skillExpansions[]` array of `{ name, args, source, filePath, range, expanded }`. The `expanded` body is *snapshotted at invocation time* so replaying the transcript later renders the same content the agent originally saw, even if SKILL.md has changed on disk. The chat bubble shows the literal text; each expansion is spliced in as a `<skill-chip>` element (`src/ui/components/SkillChip.ts`) at its recorded range. The model-facing prompt is byte-equal to the legacy fully-expanded form — only the persisted UI shape changed.

**Sidecar persistence.** The pi-coding-agent CLI owns the `.jsonl` transcript schema, so expansions are stored out-of-band in `<stateDir>/skill-sidecar/<sessionId>.jsonl` (one JSON line per user message). Lookup on replay matches `modelText` exactly with a ±2 s timestamp tolerance (falls back to text-only match for clock skew). A missing or unreadable sidecar is treated as "no expansions" — old sessions render as plain text, fully backward compatible. Key file: `src/server/skills/skill-sidecar.ts`.

**Autonomous activation — system prompt section.** At session start, `system-prompt.ts` injects an "Available Skills" section listing `name`, `description`, and `argument-hint` for every discovered skill where: (a) `disable-model-invocation` is not set, and (b) the role has access to the `Skills` tool group. The section is capped at 4 KB; if exceeded, skills are sorted alphabetically and truncated with a log warning. Existing 5-second cache TTL applies, so newly added skills appear within 5 s for autonomous use (immediately for slash use via cache miss).

**Activation tool.** Built-in `activate_skill({ name, args? })` (`defaults/tools/skills/activate_skill.yaml` + `extension.ts`) looks up the skill via `getSlashSkill()`, runs `buildSlashSkillPrompt()` along the same snapshot path as user invocations, and returns the expanded body as the tool result. The chat UI renders the tool call as the same `<skill-chip>` UX (`src/ui/tools/renderers/ActivateSkillRenderer.ts`). Activation of a `disable-model-invocation` skill is rejected with a clear error.

**Tool-group policy.** `activate_skill` is in the `Skills` tool group. Roles can opt out by setting `Skills: never` in their `toolPolicies`, which both removes the "Available Skills" section from the system prompt *and* hard-blocks any `activate_skill` call — see [Tool access policies](#tool-access-policies).

**WS handler echo.** `src/server/ws/handler.ts` must include `skillExpansions` in the user-message echo broadcast back to the client; dropping it causes chips to vanish until reload (when the sidecar replay path rehydrates them). Regression guarded by E2E coverage — see [docs/debugging.md — Skill chip not rendering](debugging.md#skill-chip-not-rendering).

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

**Lazy per-project init:** Bobbit does not initialize any sandbox at server startup. `SandboxManager` is constructed bare and each project's sandbox is brought up the first time it is actually needed, via the idempotent `SandboxManager.ensureForProject(projectId)`. Concurrent callers for the same project share a single in-flight init (`Map<projectId, Promise<void>>`). This replaces the previous behavior of initializing one sandbox for the default project at startup. `ensureForProject` is called from:

- Session setup (`session-setup.ts` plan phase) when the plan is `sandboxed`.
- `POST /api/goals` when the request body has `sandboxed: true`, after project resolution succeeds.
- `StaffManager` wake, for sandboxed staff agents.

A sandbox is never created for a project that has not asked for one. The image build is shared across projects (same Docker image tag). Failure to init project B's sandbox does not affect project A.

**Startup sequence (on first `ensureForProject` call for a project):**

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
- **UI lazy loading** — `WriteRenderer` shows a preview (first 512 chars) with a "Load full content" button. Full content is fetched via `GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex`. The endpoint reads `block.arguments?.content ?? block.input?.content` for tool-call blocks and falls back to `block.text` for text blocks (used by `preview_open` snapshots — see [Preview snapshots & reopening](#preview-snapshots--reopening)). See [docs/rest-api.md — Large content truncation](rest-api.md#large-content-truncation).
- **`preview_open` snapshot blocks** — `preview_open` tool_results carry a second `{type:"text"}` block whose text begins with the `__preview_snapshot_v1__\n` sentinel. `truncateSnapshotBlock()` walks `toolResult` messages, and when a snapshot exceeds the threshold it rewrites the block to `{ type:"text", text: marker, _truncated:true, _originalLength, preview }` — the marker is preserved so downstream consumers (UI renderer, further truncation passes) can still detect the block. Agent-facing context therefore only ever sees the 512-char preview; the UI hydrates the full HTML via the tool-content endpoint.
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

## Preview snapshots & reopening

The `preview_open` tool drives a single live preview side-panel in the UI. Each call overwrites the panel — there are no tabs, no history slots. But every past `preview_open` widget in chat history renders an **Open** button that re-hydrates its captured HTML back into the panel on demand, so users can flip between previous previews without re-running the agent.

### Why

Previews are transient by design: the agent iterates on a mockup by calling `preview_open` repeatedly, and each call replaces the panel. Once a newer call lands, the earlier HTML is gone from the panel — but the chat history still shows the widget for the earlier call, which is confusing if clicking it does nothing. Capturing the resolved HTML into the tool_result (so it persists in the session `.jsonl`) and giving each widget an Open button closes the loop. Crucially, the snapshot must **not** re-enter the agent's context on later turns, or large mockups would bloat token counts on every subsequent prompt.

Full design rationale is in [docs/design/reopenable-preview-widgets.md](design/reopenable-preview-widgets.md).

### Data flow

```
Agent calls preview_open({html|file})
       │
       └─→ extension (defaults/tools/html/extension.ts)
              │  1. Resolve content (inline html or fs.readFileSync(file))
              │  2. PATCH /api/sessions/:id {preview:true}
              │  3. POST  /api/preview?sessionId=… {html}
              └─→ tool_result = [
                   {type:"text", text:"Preview panel is open …"},
                   {type:"text", text: PREVIEW_SNAPSHOT_MARKER + html}
                 ]
       │
       └─→ session.jsonl persists BOTH blocks (full HTML)
       │
       └─→ emitSessionEvent → truncateLargeToolContent
              │  walks toolResult messages via truncateSnapshotBlock()
              │  if snapshot > 32KB: rewrite to {marker, _truncated, preview, _originalLength}
              └─→ broadcast + EventBuffer hold the stub; agent’s next turn
                  reads the stub from its own transcript (never the full HTML)

User clicks Open on widget #N (PreviewRenderer.ts)
       │  If the in-memory block has full text (not _truncated), use it directly.
       │  Otherwise GET /api/sessions/:id/tool-content/:mi/:bi (server reads
       │    the .jsonl and returns block.text for type:"text" blocks).
       └─→ strip PREVIEW_SNAPSHOT_MARKER →
            PATCH /api/sessions/:id {preview:true} →
            POST  /api/preview?sessionId=… {html}
            — same endpoints the extension used, same single-panel pipeline.
```

### Key design decisions

- **Versioned sentinel over a structured block type** — `__preview_snapshot_v1__\n` is a prefix on a plain `{type:"text"}` block rather than a new block type. This keeps the tool_result shape standard (agents and older clients treat it as an extra status line) and lets the truncation layer detect snapshot blocks with a single string check. The `v1` suffix reserves room for future format changes.
- **Extension captures, not the server** — the HTML is resolved once in the tool process (where `params.html` or `fs.readFileSync(params.file)` already lives) and flows through the normal tool_result path. The server doesn't need a special "snapshot store" — the `.jsonl` already persists tool_results durably.
- **Truncation preserves the marker** — `truncateSnapshotBlock()` keeps the marker prefix on the stub so downstream consumers (another truncation pass, the UI renderer deciding whether to show Open) can still recognise the block without inspecting `_truncated`.
- **Backwards compatible** — historical `preview_open` results that pre-date the feature have only a single status block. `PreviewRenderer.ts` detects this (no marker block) and renders Open in a disabled state rather than crashing or silently doing nothing.
- **No change to `/api/preview` or the panel** — Open replays through the exact endpoints the extension uses. The preview panel, its polling loop (`src/app/preview-panel.ts`), and the single-slot contract are untouched.

### Key files

| File | Purpose |
|---|---|
| `defaults/tools/html/snapshot.ts` | `PREVIEW_SNAPSHOT_MARKER` constant, `isSnapshotBlock`, `extractSnapshot` helpers |
| `defaults/tools/html/extension.ts` | Emits the 2-block tool_result (status + snapshot) after PATCH/POST succeed |
| `src/server/agent/truncate-large-content.ts` | `truncateSnapshotBlock()` handles marker-prefixed text blocks in `toolResult` messages; wired into both `truncateLargeToolContent()` (live events) and `truncateLargeToolContentInMessages()` (history loads) |
| `src/server/server.ts` | `/api/sessions/:id/tool-content/:mi/:bi` falls back to `block.text` when the block is a plain `type:"text"` block (snapshot blocks have no `arguments`/`input`) |
| `src/ui/tools/renderers/PreviewRenderer.ts` | Open button: state machine (idle → Opening → Opened ✔ / error), disabled for streaming and legacy single-block results, inline-or-lazy-load, strip marker, PATCH + POST |
| `tests/preview-renderer.spec.ts`, `tests/preview-extension.test.ts`, `tests/truncate-large-content.test.ts`, `tests/e2e/preview-snapshot.spec.ts`, `tests/e2e/ui/preview-reopen.spec.ts` | Unit, server-side, and browser E2E coverage |

---

## Event stream ordering & dedup

Live-streaming agent events (`message_update`, `message_end`, `tool_execution_start`, …) are delivered to the browser as `{type:"event", data, seq, ts}` WebSocket frames. The `seq` + `ts` fields exist to solve a pair of transport-level bugs that manifested as duplicated or reordered chat messages — **not** bugs in agent execution, and **not** visible on reload-replay (the snapshot path is already self-consistent).

### Why

Before this, `{type:"event"}` frames had no server-assigned identity. Two failure modes followed:

- **Snapshot-vs-live race on reconnect.** When the WebSocket dropped mid-turn, the client reconnected and requested a `get_messages` snapshot. Events arriving in the window between the snapshot request and its response were either dropped (snapshot overwrote them) or duplicated (snapshot already contained them **and** the live event re-arrived). The client had only text equality to fall back on, which covered user messages but not assistant/toolResult messages.
- **No tiebreaker for parallel tool bursts.** Back-to-back `message_end` frames from parallel tool calls could be dispatched in whichever order the renderer happened to reach them; without a server-assigned key the client could not restore the intended order.

The fix is additive and session-scoped: a monotonic `seq` per session plus a wall-clock `ts`. Existing `{type:"event"}` consumers ignore unknown keys, so old clients against new servers (and vice-versa) keep working — they just miss the new guarantees.

Full reasoning and alternatives considered are in [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md).

### Server side

`EventBuffer` (`src/server/agent/event-buffer.ts`) stores `{seq, ts, event}` tuples in a 1000-entry ring. `push()` assigns the next `seq` and stamps `ts = Date.now()`. It exposes:

- `since(fromSeq)` — entries with `seq > fromSeq` (the reconnect tail).
- `canResumeFrom(fromSeq)` — false if `fromSeq` is older than the retained window (ring eviction).
- `lastSeq` — highest assigned seq (used in `resume_gap` so the client can resync).

All `{type:"event"}` broadcasts flow through a single helper `emitSessionEvent(session, event)` in `src/server/agent/session-manager.ts`. It truncates large content, pushes into the buffer, and broadcasts `{type:"event", data, seq, ts}` in lockstep. This replaces the previous pattern of paired `eventBuffer.push(…) + broadcast(…)` calls at six call sites; the helper is the only place that can assign a seq, which keeps the stream strictly monotonic even across call sites.

Other broadcast types (`session_status`, `session_title`, `messages`, `state`, `queue_update`, …) do **not** carry `seq` — they are idempotent snapshots, not stream deltas, and the dup/reorder class of bug doesn't apply.

### Resume handshake

The WS protocol (`src/server/ws/protocol.ts`) gains two message types:

- `{type:"resume", fromSeq}` — client → server, sent immediately after `auth_ok` on a reconnect when the client has a non-zero `_highestSeq`.
- `{type:"resume_gap", lastSeq}` — server → client, sent when `canResumeFrom(fromSeq)` is false (the missed tail has already been evicted). The client resets its seq tracking to `lastSeq` and falls back to the `get_messages` snapshot path.

`src/server/ws/handler.ts` handles `resume` by replaying `since(fromSeq)` as normal `{type:"event"}` frames (same seq/ts as the originals), then the session continues to broadcast live events as they arrive. Clients that never send `resume` (old clients, or first-time connections with `_highestSeq === 0`) get the existing cold-connect path — `getState()` + `get_messages` — which is backward-compatible.

### Client side

`RemoteAgent` in `src/app/remote-agent.ts` tracks `_highestSeq` and a small `_pendingEvents` array:

- **Duplicate drop.** `seq <= _highestSeq` is silently discarded.
- **In-order dispatch.** `seq === _highestSeq + 1` advances the watermark and dispatches the event.
- **Out-of-order buffering.** Any higher seq is inserted into `_pendingEvents` (sorted by seq). After every ingest the drain loop pops entries whose seq is now contiguous and dispatches them. If `_pendingEvents` exceeds 500 entries the client abandons the gap and forces a snapshot refresh — a safety valve so a permanently-gapped client can't grow unbounded.
- **Baseline adoption.** The first seq’d frame on a fresh connection adopts `seq - 1` as the baseline, so the initial state-snapshot path doesn’t stall waiting for a non-existent seq 1.
- **Reconnect.** On WS reopen, if `_highestSeq > 0`, the client sends `{type:"resume", fromSeq: _highestSeq}` **before** any other traffic. On `resume_gap` it resets `_highestSeq` to the server’s `lastSeq` and falls back to `get_messages`.

Seq-less frames (old servers) fall through the dispatch path unchanged — the reducer still runs and the pre-seq dedup heuristics (user messages by text, assistant messages by id) still apply. There is no hard dependency on seq at render time; `messages[]` remains the authoritative ordered list, and seq only governs the event→state reducer.

### Tests

- `tests/event-buffer.test.ts` — seq monotonicity, eviction invariants, `since()` / `canResumeFrom()` / `lastSeq` semantics.
- `tests/remote-agent-seq-dedup.spec.ts` (+ `tests/fixtures/remote-agent-seq-dedup.html`) — file:// fixture driving synthetic WS frames through the reducer: duplicate drop, out-of-order buffering, `resume` on reconnect, compat fallback for seq-less frames, full-buffer replay dedup.
- `tests/e2e/ui/stories-streaming.spec.ts` — `ST-DEDUP-01` reproducing test: reconnect mid-stream must not duplicate or reorder events. Fails on master pre-fix, passes after.
- `tests/e2e/ui/stories-resilience.spec.ts` — `RE-07` (reconnect catch-up) unchanged and still green; the new `resume` path is a strict superset of its coverage.

### Key files

| File | Purpose |
|---|---|
| `src/server/agent/event-buffer.ts` | `{seq, ts, event}` ring buffer + `since()` / `canResumeFrom()` / `lastSeq` |
| `src/server/agent/session-manager.ts` | `emitSessionEvent()` — single push+broadcast helper |
| `src/server/ws/protocol.ts` | Additive `seq`/`ts` on `event`; new `resume` / `resume_gap` types |
| `src/server/ws/handler.ts` | Handles `resume`, emits `resume_gap` on eviction |
| `src/app/remote-agent.ts` | `_highestSeq`, `_pendingEvents`, reconnect `resume`, gap fallback |

---

## Steer-interruptible bash_bg wait

`bash_bg` action `wait` blocks the agent for up to 300 s (default) while the server long-polls `BgProcessManager.waitForExit()`. Without special handling, a steer (user or `team_steer`) arriving during that window would be accepted by the WebSocket handler but could not take effect until the wait resolved — the agent is stuck mid tool-call and the steer feels ignored.

**Contract.** When a steer is delivered for a session that has one or more in-flight `bash_bg wait` handlers:

- Every in-flight wait for that session is aborted immediately (the wait HTTP response resolves with `{ info, timedOut: false, aborted: true }`).
- The backgrounded processes are **not** killed — they keep running and can be re-queried via `bash_bg logs`, `grep`, or another `wait`.
- The shell extension translates the aborted result into a visible tool_result: `Process <hdr> wait interrupted by steer. Use 'logs' or 'wait' again to continue monitoring.`.
- The steer is then forwarded to `rpcClient.steer()` as usual and processed on the next turn.

### Why

Long waits made the agent feel unresponsive: users would type a correction, see it accepted, and then watch the UI sit idle for minutes because the agent was parked inside a `wait` tool call. Aborting the wait (not the process) keeps the correction latency proportional to the WebSocket round-trip, while preserving the original intent of having the process run in the background.

### Architecture

- `BgProcessManager.waits: Map<sessionId, Set<AbortController>>` — per-session registry of pending waits.
- `registerWait(sessionId, controller)` / `unregisterWait(sessionId, controller)` — called by the `/api/sessions/:id/bg-processes/:pid/wait` REST handler in its `try`/`finally` around `waitForExit(..., signal)`.
- `abortAllWaits(sessionId)` — aborts every registered controller for a session. Registry cleanup happens via the handlers' `finally` blocks (not inside `abortAllWaits`), so a single iterator pass is safe.
- `waitForExit(sessionId, processId, timeoutMs, signal?)` — races process `exit`, `setTimeout`, and `signal.abort` in a single promise with a shared `cleanup()` that clears the timer and removes the exit/abort listeners. A single `settled` flag guards against double-resolve.

### Call sites

Live-steer delivery is centralised on `SessionManager.deliverLiveSteer(sessionId, message)`, which calls `bgProcessManager.abortAllWaits(sessionId)` before forwarding to `session.rpcClient.steer(message)`. All steer paths that run while the agent is `streaming` go through this helper:

- `src/server/ws/handler.ts` — `case "steer"` (user-initiated live steer).
- `src/server/agent/team-manager.ts` — `injectSteerMessage()` and the task-completion nudge (mid-turn `team_steer`).
- `src/server/agent/session-manager.ts` — `SessionManager.drainQueue()` when dispatching a batch of steered messages while streaming (same abort behaviour, inline rather than through `deliverLiveSteer` because the rpc call is wrapped in batching).

### Termination cleanup

`SessionManager.terminateSession()` calls `bgProcessManager.abortAllWaits(id)` before `bgProcessManager.cleanup(id)`. `BgProcessManager.cleanup()` also calls `abortAllWaits()` defensively as its first step. This ensures any long-poll HTTP handlers still hanging in the server event loop resolve cleanly (as `aborted: true`) before the processes are killed and the session entry is dropped — no leaked Promises, no dangling `exit` listeners.

### Key files

| File | Purpose |
|---|---|
| `src/server/agent/bg-process-manager.ts` | `waits` registry, `registerWait`/`unregisterWait`/`abortAllWaits`, `waitForExit` with `AbortSignal` support |
| `src/server/agent/session-manager.ts` | `deliverLiveSteer()` helper; `drainQueue()` abort-before-dispatch; `terminateSession()` termination-time abort |
| `src/server/agent/team-manager.ts` | Team-initiated steers routed through `deliverLiveSteer()` |
| `src/server/ws/handler.ts` | WebSocket `case "steer"` routed through `deliverLiveSteer()` |
| `src/server/server.ts` | `/bg-processes/:pid/wait` REST handler — creates the `AbortController`, registers it, passes `signal` to `waitForExit`, unregisters in `finally` |
| `defaults/tools/shell/extension.ts` | Translates `aborted: true` into the user-facing "wait interrupted by steer" tool_result |
| `tests/bg-process-manager.test.ts` | Unit tests (abort before exit, abort after exit no-op, abort after timeout no-op) |
| `tests/e2e/bg-wait-steer-abort.spec.ts` | API E2E: long-sleep bg process + concurrent steer, asserts fast abort and process still running |

---

## Errored-turn recovery (implicit unstick on new input)

When an agent turn ends with `stopReason: "error"` (malformed tool_use JSON, provider transport blip not on the whitelist, content-filter trip, etc.), `SessionManager.handleAgentLifecycle` sets `session.lastTurnErrored = true`. Historically the queue was then fully gated: any subsequent prompt or steer sat in `promptQueue` forever until the user clicked the UI Retry button. That worked for "human needs to decide", but it created a permanent-wedge failure mode for transient glitches the `TRANSIENT_ERROR_PATTERNS` list didn't match, and it silently swallowed team-lead nudges to errored workers (stalling whole teams overnight).

### Design

**Process, don't retry.** A new prompt or steer arriving at a wedged session is treated as fresh intent. `SessionManager` clears the error flag, prepends a short `[SYSTEM: previous turn failed with: <snippet>. Ignore the incomplete last turn and handle the following.]` stub (via `buildErrorRecoveryPrefix`), and dispatches the new message. The failed turn is **not** re-attempted — the sender gets to decide what happens next, not the stuck turn. The explicit UI Retry button still exists for the "please re-attempt that turn" case; implicit unstick is strictly additive.

The broken assistant message (with a malformed `tool_use` block and no matching `tool_result`) stays in transcript history. Providers tolerate this as long as the next message is regular user text, not a `tool_result`; the system-prefix keeps the model oriented.

### Consecutive-error cap

`session.consecutiveErrorTurns: number` (on `SessionInfo`) is the brake. It increments on every `message_end` with `stopReason: "error"`, resets to 0 on any successful `message_end`, and is forced to 0 by the explicit-Retry path (`retryLastPrompt`) so a deliberate human action never erodes the budget.

`MAX_CONSECUTIVE_ERROR_TURNS = 3` (module-local constant in `src/server/agent/session-manager.ts`). Behaviour:

- `consecutiveErrorTurns < 3`: implicit unstick fires. `lastTurnErrored`, `lastTurnErrorMessage`, `turnHadToolCalls`, `transientRetryAttempts` are cleared (but **not** `consecutiveErrorTurns` — that only drops on a real success). Any `pendingAutoRetryTimer` is cancelled so we don't double-dispatch. Prefixed message dispatches; any already-parked queue items drain after it (unprefixed).
- `consecutiveErrorTurns ≥ 3`: the incoming message parks in `promptQueue` (today's pre-fix behaviour), and `[session-manager] Session … has N consecutive errors; parking incoming prompt. Human action required (click Retry or fix upstream issue).` is logged. Parked items drain automatically once a human resolves the upstream problem and clicks Retry.

This is strictly better than the pre-fix state: one-off glitches self-heal on the next message; persistent failures stop costing model calls after 3 attempts and match the old "parked awaiting human" endpoint. No exponential backoff — for auth/quota failures no wait helps, so a hard stop is the right final state.

### Entry points

- `SessionManager.enqueuePrompt` (`src/server/agent/session-manager.ts`) — user / REST prompt arrival.
- `SessionManager.deliverLiveSteer` — WS `{type:"steer"}` and team-manager steer paths. Still persists to `promptQueue` as `{ isSteered: true, dispatched: true }` **before** dispatching, to preserve the PI-25b/c invariant that steers survive a Stop/retry roundtrip.
- Both emit a one-line log on the implicit-unstick path recording `sessionId`, `source` (`enqueuePrompt` vs `deliverLiveSteer`), and current `consecutiveErrorTurns`, so the rescue-vs-park ratio is observable in practice.

### Team-manager suppression removed

The old `if (teamLeadSession.lastTurnErrored) { suppress }` guard in `team-manager.ts` existed solely because a nudge to an errored team lead would vanish into the queue forever. With implicit unstick + the cap, `SessionManager` is the single source of truth for error-state policy: the nudge either unsticks the lead (≤ 3 errors) or parks (≥ 3). TeamManager no longer second-guesses, which closes the "worker idle → nudge dropped → team stalls" path.

### Key files

| File | Role |
| --- | --- |
| `src/server/agent/session-manager.ts` | `SessionInfo.consecutiveErrorTurns`, `MAX_CONSECUTIVE_ERROR_TURNS`, increment/reset in `handleAgentLifecycle`, implicit-unstick branches in `enqueuePrompt` and `deliverLiveSteer`, cap-driven parking, `buildErrorRecoveryPrefix`, reset-on-success in `retryLastPrompt` |
| `src/server/agent/team-manager.ts` | Removed `lastTurnErrored` suppression in the worker-idle notify path; delivery now unconditional |
| `tests/queue-dispatch.spec.ts` | Unit coverage: happy-path unstick, cap parking, success resets counter, explicit Retry bypasses cap, steer path, queue drain, auto-retry timer cancellation |
| `tests/e2e/stuck-session-recovery.spec.ts` | API E2E: mock-agent error turn → new prompt dispatches without UI Retry |

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
| `search.flex/` | `SearchService` | FlexSearch index (JSON files under `index/` plus `meta.json`). See [Semantic search](#semantic-search). |
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
