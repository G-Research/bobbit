# Bobbit — Agent Guide

## What is this?

A remote gateway for AI coding agents. Wraps pi-coding-agent in a WebSocket server with a browser-based chat UI. The user runs `bobbit` on a dev machine and interacts with the agent from any browser.

For architecture details and features, see [README.md](README.md). For the REST API reference, see [docs/rest-api.md](docs/rest-api.md). For the WebSocket protocol, see [docs/websocket-protocol.md](docs/websocket-protocol.md).

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
npm run test:unit      # Unit tests (Playwright file:// fixtures)
npm run test:e2e       # E2E tests (auto-starts sandboxed gateway via Playwright webServer)
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

**Run tests before committing.** After any code change, run type-check and relevant tests. Pipe Playwright output through the test filter to keep context lean — it outputs just pass/fail counts and failure details:

```bash
# Type check first
npm run check

# Unit tests (fast, no server needed)
npx playwright test --config tests/playwright.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs

# E2E tests (starts sandboxed gateway on port 3099 automatically)
npm run build:server && npx playwright test --config playwright-e2e.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs
```

The test filter accepts verbosity flags you can use when debugging failures:
- `--failures` — summary + failure details only (default)
- `--verbose` — lists every test with OK/FAIL/SKIP status
- `--full` — raw JSON pass-through

If you only changed UI code (`src/ui/`, `src/app/`), unit tests are sufficient. Server changes (`src/server/`) need E2E tests too. The E2E `npm run build:server` step recompiles automatically.

**Test structure:**

- **Unit tests** (`tests/*.spec.ts`): Playwright with `file://` fixtures — plain HTML/JS files that test logic without a build step. See `tests/mobile-header.spec.ts` for the pattern.
- **E2E tests** (`tests/e2e/*.spec.ts`): Run against a real sandboxed gateway on port 3099, auto-started by Playwright's `webServer` config. Covers REST API, WebSocket protocol, session lifecycle, and agent tool invocations.

**Writing new tests**: Prefer `file://` fixtures with plain HTML/JS that simulate the logic under test. Extract state machine logic into testable functions where possible. For tests that need a real server (WebSocket, API integration), add to `tests/e2e/` — they use the `webServer` pattern in `playwright-e2e.config.ts`.

**Test isolation**: All tests must operate in isolation. Avoid using centralised or non-ephemeral systems and dependencies. E2E tests run with `BOBBIT_DIR` set to `.e2e-bobbit-<id>/` (a gitignored temp directory), so the test server's state files (sessions, goals, tasks, costs, tokens) are fully separated from the real dev server's `.bobbit/`. Never read from or write to `.bobbit/` in tests — use the isolated directory via `readE2EToken()` from `tests/e2e/e2e-setup.ts`. Unit tests should use `file://` fixtures with no external dependencies.

**Do NOT start background servers manually** from bash (`node server.js &`, `nohup`, etc.) — the bash tool waits for all stdout/stderr pipes to close, so backgrounded processes that inherit those FDs cause the bash tool to hang forever and crash the agent session. Always use Playwright's `webServer` config instead.

## Common tasks

**Add a new REST endpoint**: Edit `src/server/server.ts` `handleApiRoute()`.

**Add a new WebSocket command**: Add to `ClientMessage` union in `src/server/ws/protocol.ts`, handle in `src/server/ws/handler.ts` switch, add convenience method on `RpcBridge` if it maps to an agent command.

**Add a new UI component**: Add to `src/ui/components/`, export from `src/ui/index.ts`.

**Add a new tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`.

**Add a slash skill**: Create a `SKILL.md` file in `.claude/skills/<name>/` (project-level) or `~/.claude/skills/<name>/` (personal). The file should have YAML frontmatter with `description` and optional `argument_hint`, `allowed_tools`, `context`, `agent` fields. Skills are discovered automatically via `discoverSlashSkills()` in `src/server/skills/slash-skills.ts` and served at `GET /api/slash-skills`.

**Add a goal-related feature**: Goal CRUD is in `goal-manager.ts`/`goal-store.ts`. REST endpoints in `server.ts`. Goal assistant prompt in `goal-assistant.ts`. Client-side proposal parsing in `remote-agent.ts` `_checkForGoalProposal()`.

**Add/edit tool documentation**: Navigate to `#/tools`, click a tool, edit the Description/Group/Docs fields, and Save. Or launch a Tool Assistant session for AI-guided documentation. Server-side: tool metadata lives in `.bobbit/config/tools/<group>/*.yaml` files, managed by `tool-manager.ts`, API routes in `server.ts`.

**Add a new tool**: Create a YAML file in the appropriate `.bobbit/config/tools/<group>/` directory (e.g. `.bobbit/config/tools/filesystem/my_tool.yaml`). Define `name`, `description`, `summary`, `group`, `provider`, and optionally `renderer` and `docs`. If the tool needs a custom extension, add code to the group's `extension.ts` in `.bobbit/config/tools/<group>/`. Register a renderer in `src/ui/tools/renderers/` if needed.

**Change how messages render**: `src/ui/components/Messages.ts` for standard roles, `src/ui/components/message-renderer-registry.ts` for custom types.

## Debugging tips

**Debug duplicate messages**: The deferred message pattern in `remote-agent.ts` is subtle. `MessageList` renders `state.messages` (completed), `StreamingMessageContainer` renders `state.streamMessage` (in-progress). They must never show the same message. Tool-call messages stay in streaming until the next message starts. Check `flushDeferredMessage()` and `_deferredAssistantMessage`.

**Debug session persistence**: Check `.bobbit/state/sessions.json` for persisted session data. Sessions restore on startup via `session-manager.ts` `restoreSessions()`. If an agent's `.jsonl` session file is missing, that session is skipped. Failed restores create dormant entries that revive on client connect.

**Debug compaction issues**: Check `_isCompacting`, `_compactionSyntheticMessages`, and `_usageStaleAfterCompaction` in `remote-agent.ts`. The `compacting_placeholder` message must be filtered out and re-added correctly across server refreshes. Manual compaction is fire-and-forget from the WS handler's perspective.

**Debug gates**: Gate state is stored in `GateStore` (`.bobbit/state/gates.json`). Gate dependencies are enforced — if a signal fails, check gate status via `GET /api/goals/:id/gates`.

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

Examples:

```yaml
# Node.js project
worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund

# Python project
worktree_setup_command: python -m venv .venv && .venv/bin/pip install -r requirements.txt

# Rust project
worktree_setup_command: cargo fetch

# Copy node_modules from source repo (fastest for npm — avoids full reinstall)
worktree_setup_command: robocopy "%SOURCE_REPO%\node_modules" node_modules /E /MT:8 /NFL /NDL /NJH /NJS /NC /NS /NP & if %ERRORLEVEL% LSS 8 exit /b 0

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


### `.bobbit/state/` — runtime state (gitignored)

| File / Directory | Owner | Purpose |
|---|---|---|
| `token` | `token.ts` | Auth token (mode 0600) |
| `sessions.json` | `SessionStore` | Session metadata (id, title, cwd, agentSessionFile, wasStreaming) |
| `goals.json` | `GoalStore` | Goal definitions (title, spec, cwd, state) |
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

### `.bobbit/config/tools/<group>/` — tool definitions and extensions

Tool YAML definitions and extension code, organized by group (agent, browser, filesystem, shell, tasks, team, web). Scaffolded from `src/server/defaults/tools/`. Each group contains `*.yaml` tool definitions and optionally an `extension.ts` for custom tool logic.

### Global state (not per-project)

| File | Owner | Purpose |
|---|---|---|
| `~/.pi/agent/auth.json` | `oauth.ts` | API auth credentials — global, not per-project |

## Goals, workflows, tasks & gates

Goals can optionally have a **workflow** — a DAG of gates with dependency ordering, quality criteria, and automated verification. Workflows are YAML templates snapshotted into the goal at creation.

**Tasks** link to workflow gates via `workflowGateId` (output) and `inputGateIds` (context inputs). **Context injection** feeds passed upstream gate content into agent prompts automatically — at spawn time (`team_spawn`) or prompt time (`team_prompt`).

For the full architecture — data models, context injection mechanics, verification lifecycle, REST API, and worked examples — see [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
