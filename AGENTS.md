# Bobbit — Agent Guide

## Commands

```bash
npm run build          # Full build (server + UI)
npm run build:server   # Compile server TypeScript only
npm run build:ui       # Vite bundle UI only
npm run dev            # Gateway + vite dev server with hot reload
npm run dev:harness    # Gateway via restart harness + vite (use this for development)
npm run restart-server # Signal the harness to rebuild & restart the server
npm start              # Run built gateway (serves embedded UI)
npm run check          # Type-check both server and web without emitting
npm test               # Run all tests (unit + E2E)
npm run test:unit      # Unit tests — Node test runner + Playwright file:// fixtures (<30s)
npm run test:e2e       # E2E tests — each worker spawns its own gateway (<90s)
```

### Dev server harness

When developing Bobbit itself, use `npm run dev:harness` instead of `npm run dev`. The harness wraps the server process and watches a sentinel file (`.bobbit/state/gateway-restart`). When an agent finishes making server-side changes, it runs `npm run restart-server` to trigger:

1. Kill the running server
2. Wait for the port to clear
3. `npm run build:server` to recompile TypeScript
4. Relaunch the server

The harness also auto-restarts on unexpected crashes. Sessions survive restarts thanks to disk persistence (`.bobbit/state/sessions.json`).

## Development workflow

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full guide on running modes, when to restart the server, and how to make changes safely.

**Quick reference**: UI changes (`src/ui/`, `src/app/`) hot-reload automatically. Server changes (`src/server/`) require `npm run restart-server` to rebuild and restart. Always run `npm run check` to verify types before triggering a restart.

## Testing

Pipe Playwright output through the test filter to keep context lean — it outputs just pass/fail counts and failure details:

```bash
# Type check first
npm run check

# Unit tests — Node test runner + Playwright file:// fixtures (<30s, no server)
npm run test:unit 2>&1 | tail -5

# E2E tests — each worker spawns its own isolated gateway (<90s)
npm run test:e2e 2>&1 | tail -5

# Or use the JSON filter for structured output
npm run build && npx playwright test --config playwright-e2e.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs
```

The test filter accepts verbosity flags you can use when debugging failures:
- `--failures` — summary + failure details only (default)
- `--verbose` — lists every test with OK/FAIL/SKIP status
- `--full` — raw JSON pass-through

If you only changed UI code (`src/ui/`, `src/app/`), unit tests are sufficient. Server changes (`src/server/`) need E2E tests too.

**Test structure:**

- **Unit tests** (`tests/*.spec.ts` + `tests/*.test.ts`): Playwright with `file://` fixtures (plain HTML/JS files that test UI logic without a build step) plus Node test runner tests for server logic. See `tests/mobile-header.spec.ts` for the Playwright pattern.
- **E2E tests** (`tests/e2e/*.spec.ts`): Each Playwright worker spawns its own isolated gateway (unique port, unique `BOBBIT_DIR`, mock agent). Tests cover REST API, WebSocket protocol, session lifecycle, agent tool invocations, and fullstack browser tests against the real UI. The gateway fixture is in `tests/e2e/gateway-harness.ts`.

**Writing new tests**: Prefer `file://` fixtures with plain HTML/JS that simulate the logic under test. Extract state machine logic into testable functions where possible. For tests that need a real server (WebSocket, API integration, UI), add to `tests/e2e/` — import `test` from `./gateway-harness.js` to get an auto-started gateway per worker. For fullstack browser tests, use a Playwright `page` fixture alongside the gateway (see `session-lifecycle-ui.spec.ts`).

**Test isolation**: All tests must operate in isolation. E2E tests each get their own gateway with a unique `BOBBIT_DIR` (`.e2e-worker-<port>/`, gitignored, cleaned up on teardown). Tests never share server state. Never read from or write to `.bobbit/` in tests — use the isolated directory via helpers from `tests/e2e/e2e-setup.ts`. Unit tests should use `file://` fixtures with no external dependencies.

**Screenshots**: Fullstack E2E tests can capture screenshots via `SCREENSHOT=1` env var. Screenshots are saved to `tests/e2e/screenshots/` (gitignored).

**Do NOT start background servers manually** from bash (`node server.js &`, `nohup`, etc.) — the bash tool waits for all stdout/stderr pipes to close, so backgrounded processes that inherit those FDs cause the bash tool to hang forever and crash the agent session. Always use Playwright's `webServer` config instead.

## Common tasks

**Add a new REST endpoint**: Edit `src/server/server.ts` `handleApiRoute()`. Git-related endpoints follow this pattern — see the `git-diff` and `git-status` handlers for sessions and goals, which use `execFileAsync` (no shell) with path sanitization and a 5s timeout.

**View file diffs in the UI**: The `GitStatusWidget` (`src/ui/components/GitStatusWidget.ts`) shows clickable file entries that fetch unified diffs via `GET /api/sessions/:id/git-diff?file=<path>` or `GET /api/goals/:id/git-diff?file=<path>` and render them inline using the `<diff-block>` component. The widget receives `sessionId`/`goalId` and `token` props from `AgentInterface.ts` or `goal-dashboard.ts` to know which endpoint to call.

**Add a new WebSocket command**: Add to `ClientMessage` union in `src/server/ws/protocol.ts`, handle in `src/server/ws/handler.ts` switch, add convenience method on `RpcBridge` if it maps to an agent command. Existing examples of this pattern: `set_model` and `set_thinking_level`.

**Add a new UI component**: Add to `src/ui/components/`, export from `src/ui/index.ts`.

**Add a new tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`.

**Add a slash skill**: Create a `SKILL.md` file in `.claude/skills/<name>/` (project-level) or `~/.claude/skills/<name>/` (personal). The file should have YAML frontmatter with `description` and optional `argument_hint`, `allowed_tools`, `context`, `agent` fields. Skills are discovered automatically via `discoverSlashSkills()` in `src/server/skills/slash-skills.ts` and served at `GET /api/slash-skills`. You can also configure additional skill directories via Settings → Config Directories tab or by adding `config_directories` to `.bobbit/config/project.yaml`:

```yaml
config_directories: '[{"path":"~/my-team-skills","types":["skills"]},{"path":"/shared/skills","types":["skills"]}]'
```

The value is a JSON-encoded array of `{"path": "...", "types": [...]}` objects where types can include `"skills"`, `"mcp"`, `"tools"`, and/or `"agents"`. Paths support `~` expansion. Custom directories are additive — the default directories (`.claude/skills/`, `.bobbit/skills/`, `~/.claude/skills/`, `~/.bobbit/skills/`, `.claude/commands/`) are always scanned. Skills from custom directories get source label `"custom"` and have lower priority than built-in directories (built-in skills with the same name win).

The legacy `skill_directories` key still works for backward compatibility but `config_directories` is preferred. When saving from the Config Directories UI, `skill_directories` is migrated to `config_directories` automatically.

**Add a goal-related feature**: Goal CRUD is in `goal-manager.ts`/`goal-store.ts`. REST endpoints in `server.ts`. Goal assistant prompt in `goal-assistant.ts`. Client-side proposal parsing in `remote-agent.ts` `_checkForGoalProposal()`. Re-attempt flow: `buildReattemptContext()` in `goal-assistant.ts`, `startReattempt()` in `session-manager.ts` (client), re-attempt buttons in `goal-dashboard.ts` and `render-helpers.ts`.

**Add/edit tool documentation**: Navigate to `#/tools`, click a tool, edit the Description/Group/Docs fields, and Save. Or launch a Tool Assistant session for AI-guided documentation. Server-side: tool metadata lives in `.bobbit/config/tools/<group>/*.yaml` files, managed by `tool-manager.ts`, API routes in `server.ts`.

**Add a new tool**: Create a YAML file in the appropriate `.bobbit/config/tools/<group>/` directory (e.g. `.bobbit/config/tools/filesystem/my_tool.yaml`). Define `name`, `description`, `summary`, `group`, `provider`, and optionally `renderer` and `docs`. If the tool needs a custom extension, add code to the group's `extension.ts` in `.bobbit/config/tools/<group>/`. Register a renderer in `src/ui/tools/renderers/` if needed. MCP tools are auto-discovered from `.mcp.json` config files and don't require manual YAML definitions. See "Add/use MCP servers" below.

**Add/use MCP servers**: Bobbit auto-discovers MCP (Model Context Protocol) server configurations from Claude Code-compatible locations and exposes their tools as first-class Bobbit tools. Discovery mirrors the same root directories used for skills. Sources (later overrides earlier):

1. Custom directories with type `"mcp"` from `config_directories` → scanned for `.mcp.json` files (lowest priority)
2. `~/.claude.json` → `mcpServers` field (legacy Claude Code user config)
2b. `~/.claude.json` → `projects[<cwd>].mcpServers` (Claude Code per-project config)
3. `~/.claude/.mcp.json` → `mcpServers` field (Claude Code user-level MCP)
4. `~/.bobbit/.mcp.json` → `mcpServers` field (Bobbit user-level MCP)
5. `<project>/.mcp.json` → `mcpServers` field (project scope — shared via version control)
6. `<project>/.claude/.mcp.json` → `mcpServers` field (Claude Code project-level MCP)
7. `<project>/.bobbit/config/mcp.json` → `mcpServers` field (Bobbit project overrides)

Custom MCP directories can be added via Settings → Config Directories tab or the `config_directories` key in `project.yaml` (see "Manage config scan directories" below).

Configuration format matches Claude Code's `.mcp.json`:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "remote-server": {
      "url": "https://mcp.example.com/api"
    }
  }
}
```

MCP tools are exposed with `mcp__<server>__<tool>` naming (double underscore separator). They appear in the Tools UI (`#/tools`), system prompts, and respect role-based access control via tool access policies (see "Tool access policies" below). Environment variables in config `env` values (`${VAR}`) are expanded from `process.env`, matching Claude Code behavior.

Supported transports: **stdio** (spawn child process, most common) and **HTTP** (POST JSON-RPC to URL). The gateway connects to MCP servers at startup and routes tool calls via generated proxy extensions.

REST API: `GET /api/mcp-servers` (list servers and status), `POST /api/mcp-servers/:name/restart` (reconnect a server, also triggers re-discovery), `POST /api/internal/mcp-call` (internal proxy for tool execution).

### Tool access policies

All tool access control uses a single **grant policy** system. Every tool resolves to one of four policy values — there is no separate whitelist. The `allowedTools` field on roles is derived from resolved policies (tools with `always-allow` policy), not stored independently.

**Policy values:**

| Policy | Behavior |
|---|---|
| `always-allow` | Tool works without prompting. |
| `ask-once` | Permission prompt on first use per session. Grant persists in memory for the session lifetime. |
| `always-ask` | Permission prompt every time. Grant is one-time (revoked after the agent's turn). |
| `never` / `never-ask` | Tool is invisible to the agent. No stub generated, no prompt shown. (`never` and `never-ask` are synonymous.) |

**Policy resolution order** (first non-null wins):

1. **Role + tool override**: `role.toolPolicies["mcp__playwright__browser_click"]`
2. **Role + group override**: `role.toolPolicies["mcp__playwright"]` or `role.toolPolicies["Browser"]`
3. **Tool default**: `tool.grantPolicy` from tool YAML
4. **Group default**: per-group policy from `.bobbit/config/tool-group-policies.yaml`
5. **System fallback**: `always-allow`

The resolution always returns a concrete policy value — it never returns null.

**Configure per tool** in `.bobbit/config/tools/<group>/*.yaml`:

```yaml
grantPolicy: ask-once  # "always-allow" | "always-ask" | "ask-once" | "never" | "never-ask"
```

**Configure per group** in `.bobbit/config/tool-group-policies.yaml`:

```yaml
# Maps group name → default grant policy
Browser: ask-once
Agent: always-allow
mcp__playwright: ask-once
```

Group defaults apply to all tools in that group unless overridden at the tool or role level. Managed server-side by `ToolGroupPolicyStore` in `src/server/agent/tool-group-policy-store.ts`.

**Configure per role** in `.bobbit/config/roles/*.yaml` via `toolPolicies` — supports both individual tool names and group-level prefixes:

```yaml
toolPolicies:
  mcp__playwright__browser_snapshot: always-ask
  mcp__playwright: ask-once  # applies to all tools in this MCP server
```

**Migration from `allowedTools`**: On first startup after upgrade, each role's `allowedTools` entries are automatically migrated into `toolPolicies` as `always-allow` entries. The migration is idempotent (guarded by a `_policyMigrated` flag in the role YAML) and non-destructive — `allowedTools` continues to be written to YAML for backward compatibility with older Bobbit versions, but `toolPolicies` is the single source of truth. After migration, `allowedTools` is a computed getter that returns tools whose resolved policy is `always-allow`.

**REST API:**
- `PUT /api/roles/:name` accepts `toolPolicies`
- `PUT /api/tools/:name` accepts `grantPolicy`
- `GET /api/tool-group-policies` → returns all group policies as `Record<string, GrantPolicy>`
- `PUT /api/tool-group-policies/:group` → set or clear a group default (`{ policy: GrantPolicy | null }`, null clears)

**UI for managing policies:**
- **Tool edit page** (`#/tools/:name`): "Default Grant Policy" dropdown sets the tool-level default. "Role Access" section shows per-role policy dropdowns with resolved effective policy hints.
- **Tool list page** (`#/tools`): group headers show a policy badge/dropdown for editing the group default directly.
- **Role edit page** (`#/settings/roles/:name`): "Tool Policy Overrides" section shows only explicit overrides in `toolPolicies`, with add/remove controls.

When a user approves a tool via the permission card, the persistent grant writes `toolPolicies[tool] = "always-allow"` on the role (not `allowedTools` directly).

**Manage config scan directories**: Bobbit scans multiple directories for skills, MCP servers, tools, and agent files. View all scanned directories and add custom ones via Settings → Config Directories tab (`#/settings`, Directories tab) or by editing `config_directories` in `.bobbit/config/project.yaml`. See "Config scan directories" section below for details. Note: `"agents"` entries point at **individual files** (e.g. `~/my-team/AGENTS.md`), not directories — unlike the other config types. REST API: `GET /api/config-directories` returns all directories with path, types, scope, exists status, and whether they're removable.

**Change how messages render**: `src/ui/components/Messages.ts` for standard roles, `src/ui/components/message-renderer-registry.ts` for custom types.

### Full-text search & paginated archives

Bobbit includes full-text search across goals, sessions, and chat message history, powered by SQLite FTS5 via `better-sqlite3`. The search index lives at `.bobbit/state/search.db` — it's a rebuildable cache, not a source of truth.

**Key files:**

| File | Purpose |
|---|---|
| `src/server/search/search-index.ts` | `SearchIndex` — FTS5 schema, indexing, querying, rebuild logic |
| `src/server/search/message-extractor.ts` | Extracts indexable text from message content blocks |
| `src/ui/components/SearchBox.ts` | Sidebar search input with keyboard shortcut |
| `src/ui/components/SearchResults.ts` | Grouped search results display |

**What gets indexed:**
- **Goals**: title, spec text
- **Sessions**: title, role name
- **Messages**: text content blocks and tool call names. Thinking blocks, tool results, and binary content are skipped.

**Indexing pipeline:**
- **Incremental**: `GoalStore` and `SessionStore` update the index on `put/update/archive`. `RpcBridge` indexes message text as it streams through.
- **Startup rebuild**: On first run (no `search.db`) or schema version mismatch, a full rebuild scans all `.jsonl` session files. This is a one-time cost logged to console.
- **Purge sync**: When `purgeOneSession()` deletes a session, its messages are removed from the index.

**Search API:**
- `GET /api/search?q=<query>&limit=20&offset=0&type=all|goals|sessions|messages` — returns ranked results grouped by type, with snippet excerpts (FTS5 `snippet()` function). Each result includes type, id, title, snippet, timestamp, archived status, and goalId.

**Paginated archives:**
- `GET /api/goals?archived=true&limit=50&after=<cursor>` — paginated archived goals sorted by `archivedAt` descending. Cursor is the `archivedAt` timestamp of the last item.
- `GET /api/sessions?include=archived&limit=50&after=<cursor>` — same pattern for archived sessions.
- Live (non-archived) goals and sessions continue to use generation-based polling (`?since=N`). Archived pagination is stateless.

**Sidebar search box:**
- Always visible at the top of the sidebar, below the config buttons row.
- `Ctrl+K` / `⌘K` focuses the input. `Escape` clears and restores normal sidebar view.
- 200ms debounced input calls `GET /api/search`. Results replace normal sidebar content, grouped into Goals / Sessions / Messages sections with snippet excerpts.
- Clicking a result navigates to the goal dashboard or connects to the session. The `×` button clears the search.

### Thinking level configuration

The default thinking level for new sessions is configurable via `default_thinking_level` in `.bobbit/config/project.yaml` or the Settings page Project tab. Valid values: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, or `""` (empty string = use the agent's built-in default of `"medium"`).

On session creation, if `default_thinking_level` is set and non-empty, the server sends a `set_thinking_level` RPC to the agent process. The per-session thinking toggle in the chat input bar overrides the project default for that session.

Thinking token budgets per level (hardcoded in `src/app/remote-agent.ts`, not currently configurable):

| Level | Token budget |
|---|---|
| minimal | 1,024 |
| low | 4,096 |
| medium | 10,240 |
| high | 32,768 |

### Config scan directories

The Settings → Config Directories tab shows every directory Bobbit scans for configuration, organized by type (Skills, MCP, Tools, Agents). Each entry shows its path, scope (built-in/user/project/custom), and whether the directory exists on disk. Custom directories can be added or removed; built-in directories are read-only.

Storage uses `config_directories` in `.bobbit/config/project.yaml`:

```yaml
config_directories: '[{"path":"~/my-team-config","types":["skills","mcp"]},{"path":"/shared/tools","types":["tools"]},{"path":"~/my-team/AGENTS.md","types":["agents"]}]'
```

Each entry specifies a `path` (supports `~` expansion) and `types` array (`"skills"`, `"mcp"`, `"tools"`, `"agents"`). Custom directories are additive — built-in directories are always scanned and have higher priority.

**Built-in directories:**

| Type | Directories |
|---|---|
| Skills | `<project>/.claude/skills/`, `<project>/.bobbit/skills/`, `~/.claude/skills/`, `~/.bobbit/skills/`, `<project>/.claude/commands/` |
| MCP | `~/.claude.json` (global + per-project), `~/.claude/.mcp.json`, `~/.bobbit/.mcp.json`, `<project>/.mcp.json`, `<project>/.claude/.mcp.json`, `<project>/.bobbit/config/mcp.json` |
| Tools | `<project>/.bobbit/config/tools/` |
| Agents | `<cwd>/AGENTS.md` (falls back to `<cwd>/CLAUDE.md` if `AGENTS.md` doesn't exist) |

**Agents type**: Unlike other config types, `"agents"` entries point at **individual files** (not directories). All discovered agent files are concatenated into the system prompt — the built-in file first, then custom files in the order they appear in `config_directories`. Each file's `@ref` references are resolved relative to that file's parent directory. If `AGENTS.md` exists in cwd, `CLAUDE.md` in cwd is not also read (to avoid duplication, since `CLAUDE.md` often just contains `@AGENTS.md`).

Cross-links on the Skills page and Tools page ("Manage scan directories →") navigate directly to this tab. Server-side logic is in `src/server/agent/config-directories.ts`.

## Debugging tips

**Debug duplicate messages**: The deferred message pattern in `remote-agent.ts` is subtle. `MessageList` renders `state.messages` (completed), `StreamingMessageContainer` renders `state.streamMessage` (in-progress). They must never show the same message. Tool-call messages stay in streaming until the next message starts. Check `flushDeferredMessage()` and `_deferredAssistantMessage`.

**Debug session connection timing**: `connectToSession()` in `session-manager.ts` overlaps ChatPanel creation with the WebSocket handshake. The ChatPanel is created and rendered (showing a "Connecting…" spinner) before `remote.connect()`. Model restore (`loadSessionModel` + dynamic import of `@mariozechner/pi-ai`) runs in parallel with the WebSocket connect via `Promise.all`. After connect resolves, `setAgent()` binds the agent to the pre-existing ChatPanel. The `switchGeneration` / `isStale()` guard invalidates in-flight work on rapid session switches. On connect failure, `state.chatPanel` is cleared to prevent a stuck spinner. Both `model` and `thinkingLevel` are synced from the server's `get_state` response in `remote-agent.ts` `handleServerMessage()` on connect/reconnect, so the UI always reflects the server's actual values after a page refresh.

**Debug session/goal refresh**: Both `SessionStore` and `GoalStore` track a `generation` counter (monotonically increasing, resets on server restart). `GET /api/sessions` and `GET /api/goals` return `{ generation, sessions/goals }`. Clients pass `?since=N` to skip unchanged data — the server returns `{ generation: N, changed: false }` when the generation matches. The client tracks `sessionsGeneration` and `goalsGeneration` in `state.ts` and skips `renderApp()` when nothing changed, making the 5s background poll essentially free.

**Debug gate status cache**: `state.gateStatusCache` is refreshed via two paths: (1) bulk refresh in `refreshGateStatusCache()` during initial load or when goals change, and (2) per-goal refresh via `refreshGateStatusForGoal(goalId)` triggered by WebSocket `gate_status_changed` and `gate_verification_complete` events in `remote-agent.ts`. The dashboard's gate polling (`goal-dashboard.ts`) also syncs to this cache.

**Debug session persistence**: Check `.bobbit/state/sessions.json` for persisted session data. Sessions restore on startup via `session-manager.ts` `restoreSessions()`. If an agent's `.jsonl` session file is missing, that session is skipped. Failed restores create dormant entries that revive on client connect.

**Debug compaction issues**: Check `_isCompacting`, `_compactionSyntheticMessages`, and `_usageStaleAfterCompaction` in `remote-agent.ts`. The `compacting_placeholder` message must be filtered out and re-added correctly across server refreshes. Manual compaction is fire-and-forget from the WS handler's perspective.

**Debug goal proposal dismiss persistence**: Dismissed goal proposals are tracked via `localStorage` keys with the pattern `bobbit-goal-proposal-dismissed-<sessionId>`. Each key stores a djb2 hash fingerprint of the dismissed proposal's `title + "\n" + spec`. When `onGoalProposal` fires in non-goal-assistant sessions (`session-manager.ts`), it checks `isProposalDismissed()` and skips showing proposals that match a stored fingerprint. `handleDismiss()` in `render.ts` calls `markProposalDismissed()` to persist. Cleanup happens in `terminateSession()` via `clearDismissedProposal()`. If a dismissed proposal reappears, check: (1) the localStorage key exists for that session ID, (2) the stored fingerprint matches the proposal's hash, (3) the session is not a goal-assistant type (those use IndexedDB draft persistence instead).

**Debug renderApp performance**: `renderApp()` in `src/app/state.ts` is debounced via `requestAnimationFrame` — multiple calls within the same frame collapse into a single `doRenderApp()` execution. If you need synchronous DOM updates before layout measurement, use `renderAppSync()` from `state.ts` instead. To debug render frequency, add a temporary counter in the rAF callback in `state.ts` and log how many `doRenderApp()` calls occur per frame.

**Debug gates**: Gate state is stored in `GateStore` (`.bobbit/state/gates.json`). Gate dependencies are enforced — if a signal fails, check gate status via `GET /api/goals/:id/gates`.

**Debug git diff viewer**: The `GitStatusWidget` fetches diffs on file click via REST (`/api/sessions/:id/git-diff` or `/api/goals/:id/git-diff`). The dropdown renders into a portal (`document.body`) so diffs aren't clipped by overflow. A `_currentDiffFile` guard prevents stale responses from overwriting when the user clicks a different file before the first fetch completes. If diffs don't appear, check: (1) the widget has `sessionId` or `goalId` and `token` set, (2) the server's path sanitization isn't rejecting the file path (it rejects `..` and absolute paths), (3) the git command isn't timing out (5s limit, 500KB response cap).

**Debug sandbox sessions**: Check `GET /api/sandbox-status` for Docker availability and image status. Session metadata in `sessions.json` includes `sandboxed: boolean`. The sandbox proxy logs to console with `[sandbox-proxy]` prefix — look for `BLOCKED` or `CONNECT` entries to diagnose network issues. Rate limiting on web proxy endpoints is 10 req/min per client IP (HTTP 429 when exceeded). If the container can't reach the gateway, check: (1) the sandbox proxy has the gateway hostname in its allowlist (logged at startup), (2) `BOBBIT_GATEWAY_URL` inside the container matches the real gateway address (not `host.docker.internal`), (3) the proxy is forwarding the CONNECT request (look for `CONNECT <gateway-host>:3001` in proxy logs). If tool extensions fail auth, check that `BOBBIT_TOKEN` contains a valid scoped sandbox token (not the admin token) — the scoped token is generated by `SandboxTokenStore` in `applySandboxWiring()`. If sandboxed sessions don't survive restarts, check that `agentSessionFile` in `.bobbit/state/sessions.json` contains a host-native path (not starting with `/home/node/`). Path remapping between container and host paths is handled by `containerToHostSessionPath()` and `hostToContainerSessionPath()` in `rpc-bridge.ts`.

Sandboxed delegates inherit sandbox config from their parent session. If a delegate fails to start, check that the parent session has `sandboxed: true` in `sessions.json` and that sandbox is still configured as `"docker"` in `project.yaml`. The delegate's cwd is always overridden to the parent's host-side cwd — container-internal paths like `/workspace` are never passed through.

**Debug container pool**: Check `GET /api/sandbox-pool` for pool stats (`enabled`, `total`, `idle`, `claimed`, `warming`). Pool containers are labeled `bobbit-pool=<project-hash>` — use `docker ps --filter label=bobbit-pool` to see them directly. Health checks run periodically via `docker inspect`; dead containers are removed and replacements started automatically. On gateway shutdown, agents receive SIGTERM first (graceful flush), then containers are stopped. If containers aren't being re-adopted after a gateway restart, verify the project hash in the label matches (it's derived from the project directory path). If sessions fall back to cold `docker run` unexpectedly, check that the pool has idle containers available — pool exhaustion is logged as a warning.

**Debug search index**: The search index at `.bobbit/state/search.db` is a rebuildable cache. If search returns stale or missing results, delete `search.db` and restart the server — it rebuilds automatically from `.jsonl` session files and store data. Check that `better-sqlite3` loaded correctly (native addon). FTS5 queries on 10K documents complete in <10ms, so slow searches indicate a different bottleneck (network, JSON serialization). If incremental indexing isn't working, verify the hooks in `GoalStore`, `SessionStore`, and `RpcBridge` are calling `SearchIndex` methods. If purged sessions still appear in search results, check that `purgeOneSession()` calls the index cleanup.

**Debug paginated archives**: Archived pagination uses cursor-based paging keyed on `archivedAt` timestamps. If items appear to be missing, check that `archivedAt` is set on the goal/session (older items archived before this feature may lack the field). The sidebar "Archived" section loads 50 items per page with a "Load more" button. If the count badge shows a different number than expected, verify the total comes from the paginated response metadata.

**Debug gate re-signal cancellation**: When a gate is re-signaled, `cancelStaleVerifications()` in `verification-harness.ts` terminates reviewer sessions from the prior signal and marks the old `ActiveVerification` as cancelled. The cancelled flag is checked after `Promise.all` resolves to suppress stale results. If reviewer sessions aren't being cancelled, check that `sessionManager` and `teamManager` are passed to the `VerificationHarness` constructor. Active verifications are tracked in `activeVerifications` map, keyed by signal ID — use `GET /api/goals/:goalId/verifications/active` to inspect in-flight state.

## Git conventions

The primary branch is **`master`** (not `main`). If the user refers to "main", treat it as `master`. Never create a `main` branch.

### Primary worktree and dev server

The dev server (Vite + gateway) runs from the **primary worktree** at `<project-root>`, which is checked out on `master`. Goal and agent sessions work in separate **git worktrees** under `<project-root>-wt-goal\`.

**Pushing to remote `master` does NOT update the running dev server.** After merging changes to remote master, you must pull them into the primary worktree for the dev server to pick them up:

```bash
cd <primary-worktree> && git pull origin master
```

UI changes (`src/ui/`, `src/app/`) hot-reload via Vite after the pull. Server changes (`src/server/`) additionally require `npm run restart-server` from the primary worktree.

You cannot `git checkout master` from a goal worktree (it's already checked out in the primary worktree). Instead, push to remote and pull from the primary worktree as shown above.

### Worktree setup command

When a goal or team agent creates a new git worktree, Bobbit optionally runs a setup command to install dependencies. This is configured via `worktree_setup_command` in `.bobbit/config/project.yaml`.

**If `worktree_setup_command` is not set, no setup runs.** This is intentional — Bobbit does not assume your project uses npm, pip, cargo, or any other package manager. You must explicitly configure it.

The command runs as a shell command in the new worktree directory with the `SOURCE_REPO` environment variable set to the original repo path (useful for copying build artifacts or caches). It has a 2-minute timeout and failures are non-fatal.

The command always runs via `sh -c` (Git Bash on Windows) for cross-platform consistency — since git is a hard prerequisite for Bobbit, Git Bash is always available. Write commands using Unix shell syntax.

Examples:

```yaml
# Node.js project
worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund

# Python project
worktree_setup_command: python -m venv .venv && .venv/bin/pip install -r requirements.txt

# Rust project
worktree_setup_command: cargo fetch

# Copy node_modules from source repo (fastest for npm — avoids full reinstall)
worktree_setup_command: cp -r "$SOURCE_REPO/node_modules" node_modules

# No dependencies to install
worktree_setup_command: ""
```

## Disk state summary

All per-project state lives under `<project-root>/.bobbit/`:

### `.bobbit/config/` — user-facing configuration (version controlled)

| File / Directory | Owner | Purpose |
|---|---|---|
| `system-prompt.md` | `cli.ts` | Global system prompt for agent sessions |
| `roles/*.yaml` | `RoleStore` | Role definitions and tool access |
| `workflows/*.yaml` | `WorkflowStore` | Workflow templates (gate DAGs, verification configs) |
| `personalities/*.yaml` | `PersonalityStore` | Personality definitions |
| `tools/<group>/*.yaml` | `ToolManager` | Tool definitions and extension code (name, description, docs, provider, renderer, extension.ts) |
| `project.yaml` | `ProjectConfigStore` | Project settings (build/test/typecheck commands, worktree setup, default thinking level, config_directories, custom config) |
| `roles/assistant/*.yaml` | `assistant-registry.ts` | Assistant prompt definitions (goal, role, tool, personality, staff, setup) |
| `tool-group-policies.yaml` | `ToolGroupPolicyStore` | Per-group default grant policies for tool access control |
| `mcp.json` | `McpManager` | MCP server overrides (Bobbit-specific additions to `.mcp.json`) |


### `.bobbit/state/` — runtime state (gitignored)

| File / Directory | Owner | Purpose |
|---|---|---|
| `token` | `token.ts` | Auth token (mode 0600) |
| `sessions.json` | `SessionStore` | Session metadata (id, title, cwd, agentSessionFile, wasStreaming, reattemptGoalId) |
| `goals.json` | `GoalStore` | Goal definitions (title, spec, cwd, state, reattemptOf) |
| `tasks.json` | `TaskStore` | Task definitions, state, assignments |
| `gates.json` | `GateStore` | Gate state and signal history |
| `team-state.json` | `TeamStore` | Team state (agents, roles, goal associations) |
| `staff.json` | `StaffStore` | Staff agent definitions and state |
| `session-costs.json` | `CostTracker` | Per-session token and cost data |
| `session-colors.json` | `ColorStore` | Session → color index (0-13) mapping |
| `preferences.json` | `PreferencesStore` | Key-value preferences (AI gateway config, etc.) |
| `session-prompts/` | `system-prompt.ts` | Assembled per-session prompt files (cleaned up on terminate) |
| `tls/` | `tls.ts` | TLS certificates and keys |
| `gateway-url` | `cli.ts` | Last-started gateway base URL (e.g. `https://100.x.x.x:3001`) |
| `gateway-restart` | `harness.ts` | Sentinel file for dev server restart |
| `desec.json` | `desec.ts` | deSEC dynDNS config (domain + API token) |
| `rpc-debug.log` | `rpc-bridge.ts` | Debug log of all RPC events |
| `mcp-extensions/` | `tool-activation.ts` | Generated proxy extension files for MCP tool calls |
| `search.db` | `SearchIndex` | SQLite FTS5 full-text search index (rebuildable from .jsonl files) |

### `.bobbit/config/tools/<group>/` — tool definitions and extensions

Tool YAML definitions and extension code, organized by group (agent, browser, filesystem, html, shell, tasks, team, web). Scaffolded from `.bobbit/config/tools/` in the Bobbit repo. Each group contains `*.yaml` tool definitions and optionally an `extension.ts` for custom tool logic.

### Global state (not per-project)

| File | Owner | Purpose |
|---|---|---|
| `~/.bobbit/agent/auth.json` | `oauth.ts` | API auth credentials — global, not per-project |

## Docker sandbox mode

Agent sessions can optionally run inside Docker containers with restricted filesystem, network, and credential access. This is an opt-in feature — the default (`sandbox: "none"`) preserves the existing bare-process behavior.

### Why sandboxing exists

Agents execute arbitrary code via `bash`, `write`, and other tools. In a team setting or when working on untrusted codebases, you may want to limit what an agent can access beyond the project directory. Docker sandboxing prevents agents from reading `~/.ssh`, `~/.aws`, `~/.config`, or any host path outside the project, and controls which network hosts they can reach.

### Configuration

All sandbox settings live in `project.yaml` (editable via Settings → Project tab → Docker Sandbox section):

```yaml
sandbox: "docker"                      # "none" (default) or "docker"
sandbox_image: "bobbit-agent"          # Docker image name (default: "bobbit-agent")
sandbox_network_allowlist: '["github.com", "api.github.com"]'  # JSON array of hostnames
sandbox_credentials: '{"GITHUB_TOKEN": "ghp_..."}'             # JSON object of env vars
sandbox_mounts: '["/data/shared:/data:ro"]'                    # JSON array of bind mounts
sandbox_pool_size: 2                   # Pre-warmed containers (default 2, 0 = disable pooling)
sandbox_pool_max_idle: 300             # Seconds before excess idle containers are culled
```

- **`sandbox`**: Set to `"docker"` to enable. When `"none"`, all sandbox options are ignored.
- **`sandbox_image`**: Docker image to use. Must be built beforehand (see below).
- **`sandbox_network_allowlist`**: JSON array of hostnames the agent is allowed to reach. Empty array (`[]`) blocks all outbound traffic. The gateway itself is always reachable (bypasses the proxy).
- **`sandbox_credentials`**: JSON object of environment variables injected into the container. Keys must match `^[A-Za-z_][A-Za-z0-9_]*$` — invalid keys are silently skipped.
- **`sandbox_mounts`**: JSON array of Docker bind-mount strings (`source:target[:options]`). Subject to comprehensive validation (see Security below).
- **`sandbox_pool_size`**: Number of pre-warmed containers to keep ready in the pool (default 2). Set to 0 to disable pooling and use cold `docker run` for every session.
- **`sandbox_pool_max_idle`**: Maximum seconds an excess idle container stays alive before being culled (default 300). Does not affect the minimum pool — only containers beyond `sandbox_pool_size` are culled.

Pool configuration is read at gateway startup. Changes require a gateway restart to take effect. The Settings → Project tab → Docker Sandbox section provides Pool Size and Max Idle Time inputs, plus a live pool status display showing warm/claimed/total counts.

### Docker image

Build the image from `docker/Dockerfile`:

```bash
docker build -t bobbit-agent docker/
```

**Auto-build on startup**: If the configured image is missing but `docker/Dockerfile` exists in the project directory, the gateway automatically builds it on startup before initializing the container pool. The build has a 120-second timeout and fails gracefully — a failed build disables the container pool but does not crash the server. You can also trigger a manual build from Settings → Project tab → Docker Sandbox section via the "Build Image" button, or by calling `POST /api/sandbox-image/build`.

The image includes Node.js 20, git, curl, gh CLI, and build-essential. The agent CLI itself is **not baked in** — it is bind-mounted from the host at runtime so sandboxed sessions always use the same agent version as the gateway. See `docker/README.md` for customization instructions.

### How it works

When a session is created with `sandboxed: true`:

1. **Session manager** reads sandbox config from `project.yaml`, validates mounts, and starts the sandbox proxy
2. **RpcBridge** starts the agent process inside a Docker container. Two paths depending on whether pooling is enabled:
   - **Pool mode** (`sandbox_pool_size > 0`): Claims a pre-warmed slot from the `SandboxPool` (each slot is a dedicated worktree + container pair) and runs `docker exec -i <containerId> node ...cli.js <args>`. The container is already running with all bind mounts and env vars configured.
   - **Non-pool mode** (`sandbox_pool_size == 0`): Spawns a fresh `docker run --rm` with:
     - Project directory mounted at `/workspace` (read-write)
     - Agent modules at `/agent-modules` (read-only)
     - Tool extensions at `/tools` (read-only)
     - Agent sessions directory at `/home/node/.bobbit/agent/sessions` (read-write, for session persistence across restarts)
     - `BOBBIT_GATEWAY_URL` and `BOBBIT_TOKEN` as env vars (no `.bobbit/` mount)
3. **Tool extensions** read gateway credentials from env vars (falling back to file reads for non-sandboxed sessions)
4. **Sandbox proxy** controls all outbound HTTP/HTTPS from the container

**Delegate sessions**: When a sandboxed session creates a delegate (via the `delegate` tool), the delegate automatically inherits the parent's sandbox configuration. The delegate runs in its own Docker container with the same image, network allowlist, credentials, and mounts as the parent. The delegate's working directory is always set to the parent's host-side project directory — container-internal paths like `/workspace` are remapped to prevent sandbox escape. This ensures delegates cannot bypass sandbox restrictions.

### Container pool

Without pooling, every sandboxed session pays the cost of `docker run` — container creation, filesystem setup, Node.js cold start, and agent CLI initialization. This takes 5–10s per session and compounds during team spawns when multiple agents start simultaneously. The container pool eliminates this overhead by keeping pre-warmed containers ready.

**Lifecycle:**

1. **Pre-warm on startup**: When `sandbox: "docker"` is configured and `sandbox_pool_size > 0`, the gateway starts N idle containers at startup. Each runs `sleep infinity` with all bind mounts and env vars already configured, labeled with `bobbit-pool=<project-hash>` for identification.
2. **Claim**: When a sandboxed session is created, `SandboxPool` provides an idle slot. `RpcBridge` uses `docker exec -i <containerId> node ...cli.js` instead of `docker run` — same stdio pipe protocol, but inside an already-running container. Startup drops from ~5–10s to ~200ms.
3. **Multi-session**: A single container can host multiple agent processes via separate `docker exec` calls, each with its own PID and stdio pipes. The container returns to "idle" only when all sessions inside it have terminated.
4. **Replenish**: When a container is claimed, the pool asynchronously starts a replacement in the background. The session does not wait for it.
5. **Release**: When all sessions in a container terminate, it returns to the idle pool. Excess idle containers beyond `sandbox_pool_size` are culled after `sandbox_pool_max_idle` seconds.
6. **Health monitoring**: Periodic liveness checks via `docker inspect` remove dead containers and start replacements.
7. **Fallback**: If the pool is exhausted (all containers claimed, no idle available), the session falls back to a cold `docker run` — the current non-pool behavior. Sessions never fail due to pool exhaustion, they just start slower. A warning is logged.

**Gateway restart resilience**: Pool containers are labeled (`bobbit-pool=<project-hash>`) so a restarted gateway re-adopts them via `docker ps --filter label=...` instead of orphaning them. On startup, stale containers from previously crashed gateways are also cleaned up.

**Graceful shutdown**: On gateway shutdown, agent processes receive SIGTERM first, then containers are stopped. This two-phase approach gives agents time to flush state before the container is removed.

### Network architecture

Containers always run on the default Docker bridge network — they are **not** started with `--network=none`. Instead, outbound network access is controlled by a sandbox proxy:

- A lightweight HTTP/HTTPS forward proxy (`SandboxProxy`) runs on the gateway host, binding to `0.0.0.0` on a random port
- The container's `http_proxy` and `https_proxy` env vars point to this proxy via `host.docker.internal`
- **All traffic routes through the proxy**, including agent→gateway communication. The gateway hostname is automatically added to the proxy's allowlist when sandbox wiring is applied (`SandboxProxy.addToAllowlist()`).
- **Empty allowlist**: the proxy blocks all outbound traffic except to the gateway
- **Non-empty allowlist**: the proxy allows CONNECT/requests to listed hostnames plus the gateway
- `BOBBIT_GATEWAY_URL` inside containers is the real gateway address (e.g. a Tailscale IP), **not** rewritten to `host.docker.internal`. This ensures the gateway is reachable regardless of which interface it binds to.
- `web_search` and `web_fetch` are routed through gateway API endpoints (`POST /api/web-proxy/search`, `POST /api/web-proxy/fetch`) and work regardless of the allowlist

**Security note**: The proxy binds to `0.0.0.0`, making it accessible to other containers or machines on the same network. On shared hosts, use firewall rules to restrict access to the proxy port.

### Scoped sandbox tokens

Sandboxed agents receive **scoped tokens** instead of the admin auth token. Each sandboxed session gets a unique 256-bit random token that restricts API access to only the endpoints that session needs.

**Token lifecycle**: Tokens are generated in `applySandboxWiring()` via `SandboxTokenStore.register()`, passed to the container as `BOBBIT_TOKEN`, and cleaned up on session termination. Tokens are in-memory only — they are regenerated on server restart during session restore.

**Auth flow** (`server.ts`): The auth layer tries the admin token first. If that fails, it checks the `SandboxTokenStore`. If a sandbox token matches, a `sandboxScope` is attached to the request and `isSandboxAllowed()` enforces the endpoint allowlist before routing to `handleApiRoute`.

**Endpoint allowlist** (`src/server/auth/sandbox-guard.ts`):

| Endpoint | Method | Allowed |
|---|---|---|
| `/api/health` | GET | Yes |
| `/api/web-proxy/search` | POST | Yes |
| `/api/web-proxy/fetch` | POST | Yes |
| `/api/internal/mcp-call` | POST | Yes |
| `/api/preview` | POST | Yes |
| `/api/sessions` | POST | Yes (forced `sandboxed: true`) |
| `/api/sessions/:id` | GET, PATCH, DELETE | Own session + children only |
| `/api/sessions/:id/wait` | POST | Own session + children only |
| `/api/sessions/:id/bg-processes*` | ANY | **Blocked** (host escape vector) |
| `/api/goals/:id` | GET | Own goal only |
| `/api/goals/:id/team/*` | GET, POST | Own goal only |
| `/api/goals/:id/gates/*` | GET, POST | Own goal only |
| `/api/goals/:id/tasks/*` | GET, POST, PUT | Own goal only |
| `/api/tasks/:id` | GET, PUT | Yes (task info and field updates) |
| `/api/tasks/:id/assign` | POST | Yes (task assignment) |
| `/api/tasks/:id/transition` | POST | Yes (task state changes) |
| `/api/personalities` | GET, POST | Yes |
| Everything else | ANY | **Blocked** |

The `/api/tasks/:id` endpoints are allowed without goal-scoping because tool extensions call them directly by task ID (e.g. `task_update`). Goal-scoped task access via `/api/goals/:id/tasks/*` is also supported.

**Delegate inheritance**: When a sandbox-scoped request creates a delegate (`POST /api/sessions` with `delegateOf`), the server forces `sandboxed: true` and registers the child session in the parent's scope. The child gets its own scoped token via `applySandboxWiring()`.

**Delegate escape prevention**: When a sandbox token creates a delegate, `server.ts` verifies that the `delegateOf` parent ID matches the token's own session or a registered child session. This prevents a sandboxed agent from attaching a delegate to an arbitrary unsandboxed session — which would otherwise let the delegate inherit the unsandboxed parent's config and escape the sandbox.

**WebSocket guard** (`ws/handler.ts`): Sandbox tokens can only connect to their own session or registered child sessions. Connection attempts to other sessions are rejected with close code 4003.

**bash_bg blocking**: `bash_bg` is excluded from the tool list for sandboxed sessions and blocked at the API level (`/api/sessions/:id/bg-processes` returns 403 for sandbox tokens). The filtering happens in three places: (1) during session creation, before tool restrictions and activation args are computed; (2) during session restore, when rebuilding the tool list from the persisted role; (3) at the API level via the sandbox guard. `BgProcessManager` spawns directly on the host — until bg processes can run inside containers, this is a hard block.

**Credential redaction**: Docker argument arrays are logged via `redactDockerArgs()` in `rpc-bridge.ts`, which replaces values of sensitive env vars (`BOBBIT_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `AWS_SECRET*`) with `<REDACTED>`. Both cold-mode `docker run` and pool-mode `docker exec` logs use this redaction.

**Key files**:

| File | Purpose |
|---|---|
| `src/server/auth/sandbox-token.ts` | `SandboxTokenStore` — in-memory token→scope mapping |
| `src/server/auth/sandbox-guard.ts` | `isSandboxAllowed()` — endpoint allowlist for sandbox tokens |

### UI

- **Sandbox checkbox**: In the session creation popover, a "Sandbox" checkbox appears below the "Create worktree" option when `sandbox: "docker"` is configured. The checkbox is disabled with a tooltip when Docker is unavailable or the sandbox image is missing — the tooltip includes the `docker build` command when the Dockerfile exists.
- **Settings page**: Settings → Project tab has a "Docker Sandbox" section showing sandbox mode, Docker status, image name, network allowlist, credentials, and additional mounts. When the image is missing and the Dockerfile exists, it shows a copyable build command and a "Build Image" button that triggers a build via the API.

### REST API

| Endpoint | Method | Description |
|---|---|---|
| `/api/sandbox-status` | GET | Docker availability, image status, and whether sandbox is configured. Returns `{ available, configured, dockerVersion?, imageExists?, dockerfileExists?, buildCommand?, error? }` |
| `/api/sandbox-image/build` | POST | Trigger a Docker image build from `docker/Dockerfile`. Returns 404 if no Dockerfile, 409 if build already in progress, 200 on success, 500 on failure |
| `/api/web-proxy/search` | POST | Gateway-mediated web search for sandboxed agents. Body: `{ query, maxResults? }`. Rate-limited to 10 req/min per client IP |
| `/api/web-proxy/fetch` | POST | Gateway-mediated URL fetch for sandboxed agents. Body: `{ url, maxLength? }`. Rate-limited to 10 req/min per client IP |
| `/api/sessions` | POST | Accepts `sandboxed: true` in body. Returns 400 if sandbox is not configured |
| `/api/sandbox-pool` | GET | Container pool status. Returns `{ enabled, total, idle, claimed, warming }` |

### Security

- **Filesystem isolation**: The container only sees `/workspace` (project dir), `/agent-modules` (read-only), `/tools` (read-only), and `~/.bobbit/agent/sessions/` (read-write, for session persistence). Only the `sessions/` subdirectory of `~/.bobbit/agent/` is mounted — `auth.json` and other files in `~/.bobbit/agent/` remain inaccessible. Host directories like `~/.ssh`, `~/.aws`, `~/.config` are not accessible. `BOBBIT_DIR` is never mounted — the agent communicates with the gateway via env-var-based auth.
- **Non-root execution**: Containers run as the `node` user (uid=1000), not root.
- **Network control**: All outbound HTTP/HTTPS is routed through the sandbox proxy, including agent→gateway traffic. With an empty allowlist, the container cannot make any outbound connections except to the gateway (whose hostname is auto-added to the allowlist).
- **Scoped API tokens**: Sandboxed agents receive a session-scoped token instead of the admin token. This token restricts API access to a strict allowlist of endpoints (see "Scoped sandbox tokens" section above). The agent cannot disable sandboxing, create unsandboxed sessions, read credentials, escalate permissions, or run host commands via bg-processes.
- **Mount validation**: `sandbox_mounts` are validated against a blocklist of system paths (`/proc`, `/sys`, `/dev`, `/etc`, `/root`, `/home`, etc.) and sensitive path substrings (`/.ssh`, `/.aws`, `/.gnupg`, `/.docker`, etc.). Relative paths, paths with `..`, home dir expansion (`~`), and drive roots are rejected.
- **Credential key sanitization**: Only keys matching `^[A-Za-z_][A-Za-z0-9_]*$` are passed through. This prevents shell injection via malformed env var names.
- **No Docker socket**: The Docker socket is never mounted. The container cannot control Docker or escape to the host.
- **bash_bg blocked**: Background processes (`bash_bg` tool) are blocked for sandboxed sessions at both the tool level (excluded from system prompt) and the API level (returns 403). `BgProcessManager` spawns directly on the host, bypassing the container.

### Key files

| File | Purpose |
|---|---|
| `docker/Dockerfile` | Agent sandbox image definition |
| `docker/README.md` | Image build instructions and customization guide |
| `src/server/agent/sandbox-proxy.ts` | HTTP/HTTPS forward proxy with hostname allowlist |
| `src/server/agent/sandbox-status.ts` | Docker availability check (`docker info` + image inspect), image auto-build (`buildSandboxImage()`) |
| `src/server/agent/sandbox-pool.ts` | Sandbox pool lifecycle: create slots (worktree + container pairs), claim, release, replenish, health check, shutdown, re-adopt |
| `src/server/agent/docker-args.ts` | Shared Docker argument builder — single source of truth for all container mount/env configuration |

The sandbox also required changes to: `rpc-bridge.ts` (Docker spawn path, path remapping helpers for sandbox session persistence, network path fix — uses real gateway URL instead of rewriting to `host.docker.internal`), `session-manager.ts` (sandbox wiring via `applySandboxWiring()` helper — generates scoped tokens, auto-adds gateway to proxy allowlist, excludes `bash_bg` from sandboxed sessions), `session-store.ts` (`sandboxed` field on `PersistedSession`), `server.ts` (REST endpoints, auth layer for sandbox tokens, sandbox guard enforcement), `ws/handler.ts` (WebSocket auth for sandbox tokens), `sidebar.ts` (sandbox checkbox), `settings-page.ts` (Docker Sandbox config section), and all tool extensions (env var fallback for gateway credentials).

## Goals, workflows, tasks & gates

For the full architecture — data models, context injection mechanics, verification lifecycle, REST API, and worked examples — see [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).

### Goal re-attempt flow

When a goal's PR has been merged or the goal is archived, users can **re-attempt** it — opening a goal assistant session pre-loaded with context from the original goal to define a new, informed attempt.

**How it works:**
1. User clicks "Re-attempt" (RotateCcw icon) in the goal dashboard nav bar or sidebar pill button
2. A goal assistant session is created with `reattemptGoalId` set to the original goal's ID
3. The assistant receives the original goal's title, spec, branch, and PR URL via `buildReattemptContext()` in `goal-assistant.ts`
4. The assistant guides the user through: what went wrong, preferred approach (revert & start fresh / fix up / revert & fix up), and composes a new goal spec
5. On proposal acceptance, the old goal is archived and the new goal gets `reattemptOf` linking back to it

**Data model:** `PersistedGoal.reattemptOf` (optional string, original goal ID). `PersistedSession.reattemptGoalId` (optional string, for goal assistant sessions). The dashboard shows a "Re-attempt of: [title]" badge when `reattemptOf` is set.

**API:** `POST /api/sessions` accepts `reattemptGoalId` in the body. `POST /api/goals` and `PUT /api/goals/:id` accept `reattemptOf`.
