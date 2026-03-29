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

**Add a new REST endpoint**: Edit `src/server/server.ts` `handleApiRoute()`.

**Add a new WebSocket command**: Add to `ClientMessage` union in `src/server/ws/protocol.ts`, handle in `src/server/ws/handler.ts` switch, add convenience method on `RpcBridge` if it maps to an agent command. Existing examples of this pattern: `set_model` and `set_thinking_level`.

**Add a new UI component**: Add to `src/ui/components/`, export from `src/ui/index.ts`.

**Add a new tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`.

**Add a slash skill**: Create a `SKILL.md` file in `.claude/skills/<name>/` (project-level) or `~/.claude/skills/<name>/` (personal). The file should have YAML frontmatter with `description` and optional `argument_hint`, `allowed_tools`, `context`, `agent` fields. Skills are discovered automatically via `discoverSlashSkills()` in `src/server/skills/slash-skills.ts` and served at `GET /api/slash-skills`. You can also configure additional skill directories via the Skills page UI (`#/skills`) or by adding `skill_directories` to `.bobbit/config/project.yaml`:

```yaml
skill_directories: '[{"path":"~/my-team-skills"},{"path":"/shared/skills"}]'
```

The value is a JSON-encoded array of `{"path": "..."}` objects. Paths support `~` expansion. Custom directories are additive — the default directories (`.claude/skills/`, `.bobbit/skills/`, `~/.claude/skills/`, `~/.bobbit/skills/`, `.claude/commands/`) are always scanned. Skills from custom directories get source label `"custom"` and have lower priority than built-in directories (built-in skills with the same name win).

**Add a goal-related feature**: Goal CRUD is in `goal-manager.ts`/`goal-store.ts`. REST endpoints in `server.ts`. Goal assistant prompt in `goal-assistant.ts`. Client-side proposal parsing in `remote-agent.ts` `_checkForGoalProposal()`. Re-attempt flow: `buildReattemptContext()` in `goal-assistant.ts`, `startReattempt()` in `session-manager.ts` (client), re-attempt buttons in `goal-dashboard.ts` and `render-helpers.ts`.

**Add/edit tool documentation**: Navigate to `#/tools`, click a tool, edit the Description/Group/Docs fields, and Save. Or launch a Tool Assistant session for AI-guided documentation. Server-side: tool metadata lives in `.bobbit/config/tools/<group>/*.yaml` files, managed by `tool-manager.ts`, API routes in `server.ts`.

**Add a new tool**: Create a YAML file in the appropriate `.bobbit/config/tools/<group>/` directory (e.g. `.bobbit/config/tools/filesystem/my_tool.yaml`). Define `name`, `description`, `summary`, `group`, `provider`, and optionally `renderer` and `docs`. If the tool needs a custom extension, add code to the group's `extension.ts` in `.bobbit/config/tools/<group>/`. Register a renderer in `src/ui/tools/renderers/` if needed. MCP tools are auto-discovered from `.mcp.json` config files and don't require manual YAML definitions. See "Add/use MCP servers" below.

**Add/use MCP servers**: Bobbit auto-discovers MCP (Model Context Protocol) server configurations from Claude Code-compatible locations and exposes their tools as first-class Bobbit tools. Discovery sources (later overrides earlier):

1. `~/.claude.json` → `mcpServers` field (user scope)
2. `.mcp.json` in project root (project scope — shared via version control)
3. `.bobbit/config/mcp.json` → `mcpServers` field (Bobbit-specific overrides)

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

MCP tools are exposed with `mcp__<server>__<tool>` naming (double underscore separator). They appear in the Tools UI (`#/tools`), system prompts, and respect role-based access control via `allowedTools`. Environment variables in config `env` values (`${VAR}`) are expanded from `process.env`, matching Claude Code behavior.

Supported transports: **stdio** (spawn child process, most common) and **HTTP** (POST JSON-RPC to URL). The gateway connects to MCP servers at startup and routes tool calls via generated proxy extensions.

REST API: `GET /api/mcp-servers` (list servers and status), `POST /api/mcp-servers/:name/restart` (reconnect a server, also triggers re-discovery), `POST /api/internal/mcp-call` (internal proxy for tool execution).

**Change how messages render**: `src/ui/components/Messages.ts` for standard roles, `src/ui/components/message-renderer-registry.ts` for custom types.

## Debugging tips

**Debug duplicate messages**: The deferred message pattern in `remote-agent.ts` is subtle. `MessageList` renders `state.messages` (completed), `StreamingMessageContainer` renders `state.streamMessage` (in-progress). They must never show the same message. Tool-call messages stay in streaming until the next message starts. Check `flushDeferredMessage()` and `_deferredAssistantMessage`.

**Debug session connection timing**: `connectToSession()` in `session-manager.ts` overlaps ChatPanel creation with the WebSocket handshake. The ChatPanel is created and rendered (showing a "Connecting…" spinner) before `remote.connect()`. Model restore (`loadSessionModel` + dynamic import of `@mariozechner/pi-ai`) runs in parallel with the WebSocket connect via `Promise.all`. After connect resolves, `setAgent()` binds the agent to the pre-existing ChatPanel. The `switchGeneration` / `isStale()` guard invalidates in-flight work on rapid session switches. On connect failure, `state.chatPanel` is cleared to prevent a stuck spinner.

**Debug session/goal refresh**: Both `SessionStore` and `GoalStore` track a `generation` counter (monotonically increasing, resets on server restart). `GET /api/sessions` and `GET /api/goals` return `{ generation, sessions/goals }`. Clients pass `?since=N` to skip unchanged data — the server returns `{ generation: N, changed: false }` when the generation matches. The client tracks `sessionsGeneration` and `goalsGeneration` in `state.ts` and skips `renderApp()` when nothing changed, making the 5s background poll essentially free.

**Debug gate status cache**: `state.gateStatusCache` is refreshed via two paths: (1) bulk refresh in `refreshGateStatusCache()` during initial load or when goals change, and (2) per-goal refresh via `refreshGateStatusForGoal(goalId)` triggered by WebSocket `gate_status_changed` and `gate_verification_complete` events in `remote-agent.ts`. The dashboard's gate polling (`goal-dashboard.ts`) also syncs to this cache.

**Debug session persistence**: Check `.bobbit/state/sessions.json` for persisted session data. Sessions restore on startup via `session-manager.ts` `restoreSessions()`. If an agent's `.jsonl` session file is missing, that session is skipped. Failed restores create dormant entries that revive on client connect.

**Debug compaction issues**: Check `_isCompacting`, `_compactionSyntheticMessages`, and `_usageStaleAfterCompaction` in `remote-agent.ts`. The `compacting_placeholder` message must be filtered out and re-added correctly across server refreshes. Manual compaction is fire-and-forget from the WS handler's perspective.

**Debug renderApp performance**: `renderApp()` in `src/app/state.ts` is debounced via `requestAnimationFrame` — multiple calls within the same frame collapse into a single `doRenderApp()` execution. If you need synchronous DOM updates before layout measurement, use `renderAppSync()` from `state.ts` instead. To debug render frequency, add a temporary counter in the rAF callback in `state.ts` and log how many `doRenderApp()` calls occur per frame.

**Debug gates**: Gate state is stored in `GateStore` (`.bobbit/state/gates.json`). Gate dependencies are enforced — if a signal fails, check gate status via `GET /api/goals/:id/gates`.

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
| `project.yaml` | `ProjectConfigStore` | Project settings (build/test/typecheck commands, worktree setup, custom config) |
| `roles/assistant/*.yaml` | `assistant-registry.ts` | Assistant prompt definitions (goal, role, tool, personality, staff, setup) |
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

### `.bobbit/config/tools/<group>/` — tool definitions and extensions

Tool YAML definitions and extension code, organized by group (agent, browser, filesystem, html, shell, tasks, team, web). Scaffolded from `.bobbit/config/tools/` in the Bobbit repo. Each group contains `*.yaml` tool definitions and optionally an `extension.ts` for custom tool logic.

### Global state (not per-project)

| File | Owner | Purpose |
|---|---|---|
| `~/.pi/agent/auth.json` | `oauth.ts` | API auth credentials — global, not per-project |

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
