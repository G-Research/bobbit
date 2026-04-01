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

**Known limitations**: Cost tracking uses the default project's `CostTracker` for all sessions. `active-verifications.json` stays in the central state dir (transient operational state).

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

The project assistant (`project-assistant.ts`) guides users through registering a new project directory. It explores the directory (package.json, build files, git config, CI config) and emits a `<project_proposal>` XML block with discovered settings: name, root_path, build_command, test_command, typecheck_command, and system_prompt_context.

Registered as assistant type `"project"` in the assistant registry.

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

### Session & goal scoping

- `PersistedSession` and `PersistedGoal` carry an optional `projectId` field.
- Session/goal list APIs accept `?projectId=` query parameter for filtering.
- Worktrees for goals are created relative to the project's `rootPath`, not the server CWD.
- Session CWD defaults to the project's `rootPath`.

### Sidebar grouping

When multiple projects are registered, the sidebar groups sessions and goals by project:

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

Single-project mode minimizes visual noise — no project headers shown.

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

All tool access uses a **grant policy** system. Every tool resolves to one of four values:

| Policy | Behavior |
|---|---|
| `always-allow` | Works without prompting. |
| `ask-once` | Prompted on first use per session. |
| `always-ask` | Prompted every time. |
| `never` / `never-ask` | Invisible to the agent. |

**Resolution order** (first non-null wins):

1. `role.toolPolicies["<tool-name>"]` — per-tool override on role
2. `role.toolPolicies["<group>"]` — per-group override on role
3. `tool.grantPolicy` — tool YAML default
4. Group default — `.bobbit/config/tool-group-policies.yaml`
5. System fallback — `always-allow`

**Key files:** `tool-group-policy-store.ts`, role YAML `toolPolicies`, tool YAML `grantPolicy`.

**REST API:**
- `PUT /api/roles/:name` — accepts `toolPolicies`
- `PUT /api/tools/:name` — accepts `grantPolicy`
- `GET /api/tool-group-policies` — all group policies
- `PUT /api/tool-group-policies/:group` — set/clear group default

**Migration:** On first startup, `allowedTools` entries migrate to `toolPolicies` as `always-allow`. Guarded by `_policyMigrated` flag. `allowedTools` is now a computed getter.

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
2. `~/.claude.json` → `mcpServers` + `projects[<cwd>].mcpServers`
3. `~/.claude/.mcp.json`
4. `~/.bobbit/.mcp.json`
5. `<project>/.mcp.json`
6. `<project>/.claude/.mcp.json`
7. `<project>/.bobbit/config/mcp.json` (highest priority)

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
sandbox_network_allowlist: '["github.com"]'  # JSON array of hostnames
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

1. Session manager validates mounts, starts sandbox proxy
2. RpcBridge spawns agent inside Docker:
   - **Pool mode** (`pool_size > 0`): `docker exec -i <containerId>` into pre-warmed container (~200ms)
   - **Cold mode** (`pool_size == 0`): `docker run --rm` with project at `/workspace`, agent at `/agent-modules` (ro), tools at `/tools` (ro)
3. Tool extensions read credentials from env vars (fallback to files for non-sandboxed)
4. Sandbox proxy controls all outbound HTTP/HTTPS

Delegates inherit parent sandbox config. Container-internal paths remapped to host paths.

### Container pool

Pre-warmed containers eliminate 5–10s cold-start overhead. Lifecycle: pre-warm → claim (via `docker exec`) → replenish background → release when all sessions terminate → cull excess idle after `max_idle` seconds. Containers labeled `bobbit-pool=<project-hash>` for re-adoption on restart. Pool exhaustion falls back to cold `docker run`.

### Network

Containers use default Docker bridge (not `--network=none`). All traffic routes through `SandboxProxy` (HTTP/HTTPS forward proxy on host):
- Gateway hostname auto-added to allowlist
- Empty allowlist = block all except gateway
- `web_search`/`web_fetch` routed through gateway API endpoints, bypass allowlist
- `BOBBIT_GATEWAY_URL` is real gateway address (not `host.docker.internal`)

### Scoped tokens

Each sandboxed session gets a unique 256-bit token restricting API access. Generated in `applySandboxWiring()`, in-memory only (regenerated on restart). Auth tries admin token first, then `SandboxTokenStore`.

**Allowed endpoints:** `/api/health`, `/api/web-proxy/*`, `/api/internal/mcp-call`, `/api/preview`, `/api/sessions` (forced sandboxed), own session CRUD, own goal+team+gates+tasks, `/api/tasks/:id`, `/api/personalities`. Everything else blocked. `bash_bg` blocked at tool and API level.

Full allowlist: see `src/server/auth/sandbox-guard.ts`.

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
| `sandbox-proxy.ts` | HTTP/HTTPS forward proxy with allowlist |
| `sandbox-pool.ts` | Pool lifecycle |
| `docker-args.ts` | Docker argument builder |
| `sandbox-status.ts` | Docker availability check, auto-build |
| `sandbox-token.ts` | Scoped token store |
| `sandbox-guard.ts` | Endpoint allowlist enforcement |

### REST API

| Endpoint | Method | Description |
|---|---|---|
| `/api/sandbox-status` | GET | Docker availability + image status |
| `/api/sandbox-image/build` | POST | Build image from Dockerfile |
| `/api/web-proxy/search` | POST | Gateway-mediated search (10 req/min) |
| `/api/web-proxy/fetch` | POST | Gateway-mediated fetch (10 req/min) |
| `/api/sandbox-pool` | GET | Pool stats |

---

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
