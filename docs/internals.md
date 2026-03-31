# Bobbit — Internals Reference

Deep-dive documentation for subsystems. Agents: read this when working in the relevant area, not on every task.

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

SQLite FTS5 via `better-sqlite3`. Index at `.bobbit/state/search.db` (rebuildable cache).

**Key files:** `search-index.ts`, `message-extractor.ts`, `SearchBox.ts`, `SearchResults.ts`.

**Indexed:** Goals (title, spec), sessions (title, role), messages (text blocks, tool call names).

**Indexing:** Incremental via store hooks + `RpcBridge`. Full rebuild on first run or schema version mismatch. Purge syncs on session delete.

**API:** `GET /api/search?q=<query>&limit=20&offset=0&type=all|goals|sessions|messages`

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

### `.bobbit/state/` — gitignored runtime

| File / Directory | Owner | Purpose |
|---|---|---|
| `token` | `token.ts` | Auth token (0600) |
| `sessions.json` | `SessionStore` | Session metadata |
| `goals.json` | `GoalStore` | Goal definitions |
| `tasks.json` | `TaskStore` | Task state |
| `gates.json` | `GateStore` | Gate state + signals |
| `team-state.json` | `TeamStore` | Team agents/roles |
| `staff.json` | `StaffStore` | Staff agents |
| `session-costs.json` | `CostTracker` | Token/cost data |
| `session-colors.json` | `ColorStore` | Session colors |
| `preferences.json` | `PreferencesStore` | Key-value prefs |
| `session-prompts/` | `system-prompt.ts` | Per-session prompts |
| `tls/` | `tls.ts` | TLS certs |
| `gateway-url` | `cli.ts` | Gateway base URL |
| `gateway-restart` | `harness.ts` | Dev restart sentinel |
| `rpc-debug.log` | `rpc-bridge.ts` | RPC event log |
| `mcp-extensions/` | `tool-activation.ts` | MCP proxy extensions |
| `search.db` | `SearchIndex` | FTS5 search index |

### Global

| File | Purpose |
|---|---|
| `~/.bobbit/agent/auth.json` | API auth credentials |
