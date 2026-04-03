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
- The server CWD is always auto-registered as the "default" project on startup via `ensureDefaultProject()`.
- `register()` validates `rootPath` is absolute and exists on disk, checks for duplicate paths, and scaffolds `.bobbit/config/` and `.bobbit/state/` in the project directory if needed.
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

The `getDefault()` and `getDefaultProjectId()` methods are **deprecated**. They exist only for bootstrapping (constructing managers at startup) and the creation-time defaulting described above. New code must not use them for runtime store resolution.

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

### Project assistant

The project assistant guides users through registering a new project directory. It operates in two modes, selected automatically by the smart Add Project flow based on directory detection (`POST /api/projects/detect`):

**Detection mode** (assistant type `"project"`): For directories with existing content but no `.bobbit/`. The assistant explores the directory (package.json, build files, git config, CI config, README) and emits a `<project_proposal>` XML block with discovered settings: name, root_path, build_command, test_command, typecheck_command, test_unit_command, test_e2e_command, system_prompt_context, and worktree_setup_command.

**Scaffolding mode** (assistant type `"project-scaffolding"`): For empty or non-existent directories. The assistant asks what the project is about, suggests tech stacks, and helps scaffold the project structure (directory layout, basic files, README). After the user accepts the proposal, the assistant uses bash/write tools to create the project files, then emits the same `<project_proposal>` block format.

On proposal acceptance, the client-side handler registers the project via `POST /api/projects` and then writes all config fields to `project.yaml` via `PUT /api/projects/:id/config`. This ensures goal workflows can run effectively with build, test, and type-check commands configured from the start.

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

**Palette switching (UI)**: Applied via the `data-palette` attribute on `<html>`, the same mechanism as the global palette picker. On session/goal navigation, the UI resolves `activeSession → projectId → project.palette`. If a palette exists, it is applied; otherwise the global default from user preferences is restored. The switch is handled alongside session connection logic so the entire UI — sidebar, content area, headers — shifts palette together.

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

When only one project is registered, its folder row defaults to expanded so there is no extra click required. Each project row shows a folder icon, project name, settings gear, and new-goal button.

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
| `config-resolver.ts` | 3-tier config cascade |
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
4. Group default — `.bobbit/config/tool-group-policies.yaml`
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

**Key files:** `search-index.ts`, `message-extractor.ts`, `SearchBox.ts`, `SearchResults.ts`, `search-page.ts`.

**Indexed:** Goals (title, spec), sessions (title, role), messages (text blocks, tool call names), staff agents (name, description).

**FTS5 tables:** `goals_fts`, `sessions_fts`, `messages_fts`, `staff_fts`. Content tables include a `project_id` column for multi-project filtering. Schema version is 3 (bumped from 2 to add project_id). Version mismatch triggers automatic rebuild.

**Indexing:** Incremental via store hooks + `RpcBridge`. Staff indexing hooks live in `StaffManager` — index on create/update, remove on delete. Indexing methods (`indexGoal`, `indexSession`, `indexMessage`, `indexStaff`) accept a `projectId` parameter. Full rebuild on first run or schema version mismatch; `rebuildFromStores()` iterates all project contexts to re-index everything.

**API:** `GET /api/search?q=<query>&limit=20&offset=0&type=all|goals|sessions|messages|staff&projectId=<optional>` — when `projectId` is omitted, searches across all projects. Search results include `projectId` and `projectName` fields so the UI can show which project each result belongs to.

### Dual-mode sidebar search

The sidebar search box operates in two modes, controlled by a "Search Content" toggle that appears below the input when a query is active:

- **Title-only (default):** Client-side instant filtering. Filters goals by title, sessions by title, and staff by name using case-insensitive substring matching. No API call. The sidebar structure (goal groups, ungrouped sessions, staff, archived) is preserved — non-matching entries are hidden.
- **Content search:** Uses `GET /api/search` (FTS5) and maps results back to sidebar entries by ID. Message matches resolve to their parent session/goal. 200ms debounce on input.

State field `searchContentMode` (persisted in `localStorage`) tracks which mode is active.

### Full search page

Route: `#/search` (with optional `?q=<query>` parameter). Accessible via the "Full Search" button in the sidebar controls row or directly by URL.

Features: large auto-focused input, type filter toggles (Goals, Sessions, Staff, Messages), grouped results with snippets and `<b>` match highlighting, relative timestamps, archived badges, and "Load More" pagination. Clicking a result navigates to the relevant goal dashboard, session, or staff edit page.

**Key file:** `search-page.ts` manages its own local state (query, results, type filters, pagination offset).

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
| Tools | `.bobbit/config/tools/` |
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

**API:** `GET /api/mcp-servers`, `POST /api/mcp-servers/:name/restart`, `POST /api/internal/mcp-call`

---

## Docker sandbox

Opt-in Docker isolation for agent sessions. Set `sandbox: "docker"` in `project.yaml`.

### Configuration

All settings in `project.yaml` (Settings → Project → Docker Sandbox):

```yaml
sandbox: "docker"                      # "none" (default) or "docker"
sandbox_image: "bobbit-agent"          # must be pre-built
sandbox_credentials: '{"GITHUB_TOKEN": "ghp_..."}'  # env vars for container
sandbox_mounts: '["/data/shared:/data:ro"]'  # bind mounts
sandbox_pool_size: 2                   # pre-warmed containers (0 = disable)
sandbox_pool_max_idle: 300             # seconds before excess idle culled
```

### Docker image

```bash
docker build -t bobbit-agent docker/
```

Auto-built on startup if image missing but `docker/Dockerfile` exists (120s timeout). Includes Node.js 20, git, curl, gh, build-essential. Agent CLI bind-mounted at runtime.

### How it works

On `sandboxed: true` session creation:

1. Session manager validates mounts, ensures `bobbit-sandbox-net` Docker network exists
2. RpcBridge spawns agent inside Docker:
   - **Pool mode** (`pool_size > 0`): `docker exec -i <containerId>` into pre-warmed container (~200ms)
   - **Cold mode** (`pool_size == 0`): `docker run --rm` with project at `/workspace`, agent at `/agent-modules` (ro), tools at `/tools` (ro)
3. Tool extensions read credentials from env vars (fallback to files for non-sandboxed)
4. Container has direct internet access via the bridge network

Delegates inherit parent sandbox config. Container-internal paths remapped to host paths.

### Container pool

Pre-warmed containers eliminate 5–10s cold-start overhead. Lifecycle: pre-warm → claim (via `docker exec`) → replenish background → release when all sessions terminate → cull excess idle after `max_idle` seconds. Containers labeled `bobbit-pool=<project-hash>` for re-adoption on restart. Pool exhaustion falls back to cold `docker run`.

### Network

Containers run on a dedicated Docker bridge network (`bobbit-sandbox-net`) with direct outbound internet access. This replaces the previous proxy-based approach where all traffic was routed through a gateway-hosted `SandboxProxy`.

- **Network creation**: `ensureSandboxNetwork()` in `session-manager.ts` creates the network idempotently via `docker network create bobbit-sandbox-net --driver bridge --opt com.docker.network.bridge.enable_icc=false`. The `enable_icc=false` flag prevents inter-container communication.
- **Metadata endpoint blackholing**: Cloud metadata endpoints are blocked via `--add-host` entries in `docker-args.ts` (`169.254.169.254`, `metadata.google.internal`, and `metadata.internal` all resolve to `0.0.0.0`). `169.254.169.254` is the AWS/GCP/Azure IMDS endpoint; the named hosts cover GCP and Azure specifically. This is defense-in-depth against SSRF via cloud instance metadata.
- **Gateway reachable**: `--add-host=host.docker.internal:host-gateway` ensures the container can reach the gateway for API calls (tool extensions, delegate sessions, etc.).
- **Cleanup**: `cleanupSandboxNetwork()` removes the network on shutdown (non-fatal if containers are still connected).
- `web_search`/`web_fetch` use direct `curl` from inside the container — no gateway proxy needed.

### Scoped tokens

Each sandboxed session gets a unique 256-bit token restricting API access. Generated in `applySandboxWiring()`, in-memory only (regenerated on restart). Auth tries admin token first, then `SandboxTokenStore`.

**Allowed endpoints:** `/api/health`, `/api/internal/mcp-call`, `/api/internal/verification-result`, `/api/preview`, `/api/sessions` (forced sandboxed), own session CRUD, own goal+team+gates+tasks, `/api/tasks/:id`, `/api/personalities`. Everything else blocked. `bash_bg` blocked at tool and API level.

Full allowlist: see `src/server/auth/sandbox-guard.ts`.

### Resource limits

All containers (pool and cold mode) receive resource limits via `docker-args.ts`:
- `--memory=4g` — prevents runaway memory consumption
- `--cpus=2` — limits CPU share
- `--pids-limit=256` — prevents fork bombs

These are applied unconditionally in `buildDockerRunArgs()` and cannot be overridden by project config.

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

### Security summary

- Container sees only `/workspace`, `/agent-modules` (ro), `/tools` (ro), `~/.bobbit/agent/sessions/`
- Runs as `node` user (uid=1000), no Docker socket
- Mount paths validated against blocklist (`/proc`, `/sys`, `/.ssh`, `/.aws`, etc.)
- Credential keys sanitized (`^[A-Za-z_][A-Za-z0-9_]*$`)
- `bash_bg` blocked (spawns on host); Docker args redacted in logs

### Key files

| File | Purpose |
|---|---|
| `docker/Dockerfile` | Image definition |
| `sandbox-pool.ts` | Pool lifecycle |
| `docker-args.ts` | Docker argument builder |
| `sandbox-status.ts` | Docker availability check, auto-build |
| `sandbox-token.ts` | Scoped token store |
| `sandbox-guard.ts` | Endpoint allowlist enforcement |

### Sandbox git fetch broker

In sandboxed mode, each agent container gets an independent `git clone --local` with its own object store. Commits made in one clone are not visible from another — unlike non-sandboxed worktrees which share the same `.git` directory. This means the team lead cannot `git merge` an agent's branch after the agent sets `headSha` on a task.

To bridge this gap, the server acts as a git fetch broker. When a sandboxed agent sets `headSha` on a task via `PUT /api/goals/:goalId/tasks/:taskId`, the server automatically runs `git fetch -- <agent-clone-path> <branch>` in the team lead's working directory. This makes the agent's commits available for `git merge` without requiring `git push` to a remote — critical when `GITHUB_TOKEN` is not available on the host.

The broker is implemented in `TeamManager.brokerGitFetch()` and invoked fire-and-forget from the task update handler. It never blocks or fails the API response.

**Security:** Branch names are validated against `/^[a-zA-Z0-9/_.\-]+$/` to prevent git option injection, and `--` separates options from arguments in the `git fetch` call.

**Edge cases:**
- **Non-sandboxed agents**: skipped — worktrees share `.git` objects natively
- **Dismissed agent** (worktree already removed): skipped via `fs.existsSync()` check
- **Same directory** (agent and team lead share a clone): skipped defensively
- **Best-effort**: failures are logged but never block the task update API response
- **Idempotent**: re-fetching an already-fetched branch is harmless

### REST API

| Endpoint | Method | Description |
|---|---|---|
| `/api/sandbox-status` | GET | Docker availability + image status |
| `/api/sandbox-image/build` | POST | Build image from Dockerfile |
| `/api/sandbox-pool` | GET | Pool stats |

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

### `.bobbit/config/` — version controlled

| File / Directory | Owner | Purpose |
|---|---|---|
| `system-prompt.md` | `cli.ts` | Global system prompt |
| `roles/*.yaml` | `RoleStore` | Role definitions + tool access |
| `workflows/*.yaml` | `WorkflowStore` | Workflow templates |
| `personalities/*.yaml` | `PersonalityStore` | Personality definitions |
| `tools/<group>/*.yaml` | `ToolManager` | Tool definitions + extensions |
| `project.yaml` | `ProjectConfigStore` | Project settings |
| `roles/assistant/*.yaml` | `assistant-registry.ts` | Assistant prompts |
| `tool-group-policies.yaml` | `ToolGroupPolicyStore` | Group grant policies |
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
