# Bobbit

A remote gateway for AI coding agents. Run a coding agent on a powerful machine, control it from any browser — desktop, phone, or tablet.

Bobbit wraps [pi-coding-agent](https://github.com/nickarrow/nickarrow) in a WebSocket gateway with a browser UI built on Lit. You start the server, open the URL (or scan a QR code on your phone), and interact with a coding agent that has full shell access to the host machine.

## How it works

```
┌─────────────┐         ┌──────────────────────────┐
│  Browser UI  │◄──WS──►│     Bobbit Gateway        │
│  (any device)│         │                           │
└─────────────┘         │  ┌──────────────────────┐ │
                        │  │ pi-coding-agent (RPC) │ │
                        │  │  stdin/stdout JSONL    │ │
                        │  └──────────────────────┘ │
                        └──────────────────────────┘
```

1. **Gateway** (`src/server/`) — Node.js HTTP + WebSocket server. Manages agent sessions as child processes communicating over JSONL on stdin/stdout. Sessions persist to disk and survive server restarts. Serves the built UI as static files or runs headless behind a Vite dev server.
2. **Browser client** (`src/app/`) — Connects to the gateway via WebSocket. Renders the chat UI using components from `src/ui/`. Desktop layout has a session sidebar; mobile has a landing page with session cards. Supports multi-device access and QR code sharing.
3. **UI components** (`src/ui/`) — Lit-based component library (forked from pi-web-ui). Message rendering, specialised tool call renderers, model selection, settings, and more.

## Quick start

```bash
npx bobbit
```

That's it. Bobbit installs, builds, scaffolds a `.bobbit/` directory in your project, and starts the gateway on `http://localhost:3001`. Open the printed URL in your browser.

**Global install** (if you prefer):

```bash
npm install -g bobbit
bobbit
```

### How it binds

- **No mesh network** (most users): Bobbit binds to `localhost:3001` with TLS disabled — plain HTTP, zero friction.
- **NordLynx detected**: Bobbit auto-binds to the NordVPN mesh IP with HTTPS (self-signed cert). This enables remote access from any device on the mesh.
- **Explicit host**: Pass `--host <addr>` to bind to a specific address. Non-loopback addresses default to HTTPS.

### From source

```bash
git clone <repo> && cd bobbit
npm install
npm run build     # compile server + bundle UI
npm start         # start gateway on :3001, serves UI
```

### Development

```bash
npm run build:server   # compile server TypeScript (required before first run)
npm run dev:harness    # gateway with auto-restart harness + vite dev server (recommended)
npm run dev            # gateway + vite without the harness
```

Both the gateway (`:3001`) and Vite (`:5173`) auto-bind to the NordLynx mesh IP. Vite proxies `/api` and `/ws` to the gateway. UI changes hot-reload instantly. Server changes require `npm run restart-server` to rebuild and restart.

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full development workflow.

### Dev server harness

Use `npm run dev:harness` when developing Bobbit itself. The harness wraps the server process and watches a sentinel file (`.bobbit/state/gateway-restart`). Running `npm run restart-server` triggers:

1. Kill the running server
2. Wait for the port to clear
3. Run `npm run build:server` to recompile TypeScript
4. Relaunch the server

The harness also auto-restarts on unexpected crashes. Sessions survive restarts thanks to disk persistence.

### CLI flags

```
bobbit [options]

--host <addr>       Bind address (default: NordLynx mesh IP if found, otherwise localhost)
--port <n>          Port (default: 3001)
--tls / --no-tls    Override TLS auto-detection (default: TLS on for non-loopback, off for localhost)
--cwd <dir>         Working directory for agent sessions (default: .)
--agent-cli <path>  Path to pi-coding-agent cli.js (auto-resolved from node_modules)
--static <dir>      Serve a custom UI build directory
--no-ui             Don't serve any UI (gateway-only mode)
--new-token         Force-generate a new auth token
--show-token        Print the current token and exit
```

## Architecture — Server

### Top-level files

| File | Purpose |
|---|---|
| `cli.ts` | Entry point. Parses args, auto-detects NordLynx IP and embedded UI, resolves custom system prompt from `.bobbit/config/system-prompt.md`, sets up TLS, updates deSEC DNS, starts the gateway. |
| `server.ts` | HTTP server with REST API routes + WebSocket upgrade handling + static file serving with SPA fallback. |
| `index.ts` | Barrel export of the server's public API (`createGateway`, `SessionManager`, `RpcBridge`, etc.). |
| `bobbit-dir.ts` | Resolves `.bobbit/` directory paths (config, state, global auth). Override via `BOBBIT_DIR` env var for test isolation. |
| `scaffold.ts` | First-run scaffolding — creates `.bobbit/` with default configs. |
| `watchdog.ts` | Process health watchdog. |
| `harness.ts` | Dev server wrapper. Watches sentinel file for restart signals, auto-restarts on crash. |
| `harness-signal.ts` | Touches the sentinel file to trigger a harness restart. |

### `agent/` — Session lifecycle, goals, teams, persistence

| File | Purpose |
|---|---|
| `session-manager.ts` | Creates/destroys/restores agent sessions. Manages RPC bridge lifecycle, client connections, auto-title generation, prompt queuing, cost tracking, and disk persistence. |
| `session-store.ts` | Persists session metadata to `.bobbit/state/sessions.json`. Sessions restore on server restart via `switch_session` RPC. |
| `rpc-bridge.ts` | Spawns `pi-coding-agent --mode rpc` as a child process. Sends commands via JSONL on stdin, receives responses and streaming events on stdout. |
| `event-buffer.ts` | Circular buffer of recent agent events. Replays the latest `tool_execution_update` per tool call ID on reconnect. |
| `title-generator.ts` | Auto-generates 2–3 word session titles via Claude Haiku. Reads auth from `~/.pi/agent/auth.json`. |
| `system-prompt.ts` | Assembles session system prompts from three layers: global `.bobbit/config/system-prompt.md`, `AGENTS.md` (with `@ref` resolution), and goal spec. Writes to `.bobbit/state/session-prompts/`. |
| `goal-manager.ts` | Goal CRUD operations, auto-transition from `todo` to `in-progress`, optional git worktree creation. |
| `goal-store.ts` | Persists goals to `.bobbit/state/goals.json`. States: `todo`, `in-progress`, `complete`, `shelved`. |
| `gate-store.ts` | Stores gate state and signal history in `.bobbit/state/gates.json`. |
| `goal-assistant.ts` | System prompt for goal creation assistant sessions. Outputs `<goal_proposal>` blocks. |
| `task-manager.ts` | Task CRUD with state machine (todo → in-progress → complete/skipped/blocked), assignment, and dependency tracking. |
| `task-store.ts` | Persists tasks to `.bobbit/state/tasks.json`. |
| `team-manager.ts` | Team lifecycle: start team lead, spawn/dismiss role agents with git worktrees, notify lead on task completion. |
| `team-store.ts` | Persists team state to `.bobbit/state/team-state.json`. |
| `team-names.ts` | Fun name pools for team agents, loaded from `data/team-names/` per role. Falls back to generic pool. |
| `name-generator.ts` | Generates role-themed funny names for team agents via Claude Haiku. |
| `role-manager.ts` | Role definitions CRUD. Maintains built-in tool registry (`AVAILABLE_TOOLS`). |
| `role-store.ts` | Persists roles as YAML files under `.bobbit/config/roles/`. |
| `role-assistant.ts` | System prompt for role creation assistant sessions. |
| `tool-manager.ts` | Manages tool definitions from `.bobbit/config/tools/<group>/*.yaml`. Reads, writes, and serves tool metadata. Detects tool renderers in `src/ui/tools/renderers/`. |
| `tool-assistant.ts` | System prompt for tool management assistant sessions. |
| `personality-manager.ts` | Personality CRUD and resolution (maps personality names to prompt fragments). |
| `personality-store.ts` | Persists personalities as YAML files under `.bobbit/config/personalities/`. |
| `personality-assistant.ts` | System prompt for personality assistant sessions. |
| `cost-tracker.ts` | Tracks per-session token usage and cost. Aggregates to goal and task level. Persists to `.bobbit/state/session-costs.json`. |
| `prompt-queue.ts` | Server-side prompt queue. Steered messages sort before non-steered. Auto-drains when agent becomes idle. |
| `color-store.ts` | Maps session IDs to color indices (0–13). Persists to `.bobbit/state/session-colors.json`. |
| `assistant-registry.ts` | Unified registry mapping assistant types (`goal`, `role`, `tool`) to their prompts and titles. |
| `bg-process-manager.ts` | Background process lifecycle management. |
| `staff-assistant.ts` | System prompt for staff agent assistant sessions. |
| `staff-manager.ts` | Staff agent lifecycle management. |
| `staff-store.ts` | Staff agent persistence (`.bobbit/state/staff.json`). |
| `staff-trigger-engine.ts` | Staff agent trigger evaluation engine. |
| `tool-activation.ts` | Tool activation/deactivation logic. |
| `workflow-store.ts` | Persists workflow templates as YAML files in `.bobbit/config/workflows/`. |
| `workflow-manager.ts` | Workflow CRUD, DAG validation, cloning. |
| `verification-harness.ts` | Async gate verification — command runner + LLM reviewer. |

### `auth/` — Authentication, TLS, DNS

| File | Purpose |
|---|---|
| `token.ts` | Generates 256-bit tokens, persists to `.bobbit/state/token` (mode 0600), validates with constant-time comparison. |
| `rate-limit.ts` | IP-based rate limiting for failed auth attempts. Auto-cleanup every 60s. |
| `tls.ts` | Auto-generates TLS certificates. Prefers mkcert (local CA) with openssl fallback. Regenerates on IP change. |
| `oauth.ts` | Server-side OAuth PKCE flow. Generates code verifier/challenge, returns auth URL, exchanges code for tokens. Stores credentials in `~/.pi/agent/auth.json` (global). |
| `desec.ts` | Updates a deSEC dynDNS A record on startup so the custom domain resolves to the current mesh IP. Config in `.bobbit/state/desec.json`. |

### `ws/` — WebSocket protocol

| File | Purpose |
|---|---|
| `protocol.ts` | TypeScript types for all client and server WebSocket message types. |
| `handler.ts` | WebSocket connection handler. Authenticates, routes commands to the RPC bridge or session manager, dispatches skill invocations. |

### `skills/` — Isolated sub-agent execution

| File | Purpose |
|---|---|
| `types.ts` | `Skill` interface: id, name, description, instructions, isolation level, expected output, timeout. |
| `registry.ts` | In-memory store of skill definitions. `registerSkill()` at import time, `getSkill()`/`listSkills()` at runtime. |
| `sub-agent.ts` | Spawns isolated agent subprocesses for skill execution. 10-minute default timeout. Receives only skill instructions + context + `AGENTS.md`. |
| `git.ts` | Git worktree create/cleanup helpers used by skills and team agents. |
| `definitions-sync.ts` | Exports registered skills to `.bobbit/state/skill-definitions.json` at startup for agent discovery. |
| `index.ts` | Barrel export + auto-registration of built-in skills. |
| `definitions/code-review.ts` | Three independent review skills: `correctness-review`, `security-review`, `design-review`. |
| `definitions/test-suite-report.ts` | Single skill that runs tests in a worktree and produces a structured report. |

## REST API

All routes require `Authorization: Bearer <token>`. Token can also be passed as `?token=` query parameter.

### Health & Info

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + session count |
| `GET` | `/api/connection-info` | List network interface addresses for multi-device access |
| `GET` | `/api/ca-cert` | Download the Bobbit CA certificate for device trust |

### Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions` | List all sessions (includes title, status, color, goal) |
| `POST` | `/api/sessions` | Create a session (normal, delegate, or with role/traits/assistant type) |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Terminate a session |
| `PATCH` | `/api/sessions/:id` | Update session properties (title, colorIndex, preview, roleId, traits, assistantType, goalId) |
| `PUT` | `/api/sessions/:id/title` | Rename a session (legacy endpoint) |
| `POST` | `/api/sessions/:id/wait` | Block until session becomes idle, then return output |
| `GET` | `/api/sessions/:id/output` | Get final assistant output from the last turn |
| `GET` | `/api/sessions/:id/git-status` | Git status for session's working directory (branch, ahead/behind, dirty files) |
| `GET` | `/api/sessions/:id/cost` | Token usage and cost for a single session |

### Goals

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals` | List all goals |
| `POST` | `/api/goals` | Create a goal (`{ title, cwd, spec, team?, worktree? }`) |
| `GET` | `/api/goals/:id` | Get a goal |
| `PUT` | `/api/goals/:id` | Update a goal (title, cwd, state, spec, team, repoPath, branch) |
| `DELETE` | `/api/goals/:id` | Delete a goal and its tasks |
| `GET` | `/api/goals/:id/commits` | Commit history for goal branch (excludes primary branch commits) |
| `GET` | `/api/goals/:id/git-status` | Git status for goal worktree (branch, ahead/behind primary, clean) |
| `GET` | `/api/goals/:id/cost` | Aggregate cost across all sessions linked to a goal |

### Goal Tasks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals/:id/tasks` | List tasks for a goal |
| `POST` | `/api/goals/:id/tasks` | Create a task (`{ title, type, spec?, parentTaskId?, dependsOn? }`) |

### Goal Gates

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals/:id/gates` | List gates for a goal |
| `POST` | `/api/goals/:id/gates/:gateId/signal` | Signal a gate (`{ status, content?, verifiedBy? }`) |

### Goal Team

Routes accept both `/team/` and legacy `/swarm/` paths.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals/:id/team` | Get team state for a goal |
| `POST` | `/api/goals/:id/team/start` | Start a team (creates team lead session) |
| `POST` | `/api/goals/:id/team/spawn` | Spawn a role agent (`{ role, task, traits? }`) |
| `POST` | `/api/goals/:id/team/dismiss` | Dismiss a role agent (`{ sessionId }`) |
| `POST` | `/api/goals/:id/team/steer` | Steer a team agent mid-turn (`{ sessionId, message }`) |
| `POST` | `/api/goals/:id/team/abort` | Force-abort a stuck team agent (`{ sessionId }`) |
| `POST` | `/api/goals/:id/team/prompt` | Send prompt to a team agent, queued if busy (`{ sessionId, message }`) |
| `GET` | `/api/goals/:id/team/agents` | List agents for a team goal |
| `POST` | `/api/goals/:id/team/complete` | Complete a team (dismiss agents, keep team lead) |
| `POST` | `/api/goals/:id/team/teardown` | Fully tear down a team (dismiss all + terminate team lead) |

### Tasks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks/:id` | Get a task |
| `PUT` | `/api/tasks/:id` | Update a task (title, spec, state, assignedSessionId, dependsOn) |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `POST` | `/api/tasks/:id/assign` | Assign a task to a session (`{ sessionId }`) |
| `POST` | `/api/tasks/:id/transition` | Transition task state (`{ state }`) |
| `GET` | `/api/tasks/:id/cost` | Cost for the session assigned to a task |

### Tools

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tools` | List all available agent tools (with docs, renderer status) |
| `GET` | `/api/tools/:name` | Get a single tool's full detail |
| `PUT` | `/api/tools/:name` | Update tool metadata (`{ description?, group?, docs? }`) |

### Roles

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/roles` | List all roles |
| `POST` | `/api/roles` | Create a role (`{ name, label, promptTemplate, allowedTools?, accessory? }`) |
| `GET` | `/api/roles/:name` | Get a role |
| `PUT` | `/api/roles/:name` | Update a role |
| `DELETE` | `/api/roles/:name` | Delete a role |

### Personalities

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/personalities` | List all personalities |
| `POST` | `/api/personalities` | Create a personality (`{ name, label, description, promptFragment }`) |
| `GET` | `/api/personalities/:name` | Get a personality |
| `PUT` | `/api/personalities/:name` | Update a personality |
| `DELETE` | `/api/personalities/:name` | Delete a personality |

### Skills

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/skills` | List available skill definitions (id, name, description) |

### Workflows

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows` | List all workflow templates |
| `GET` | `/api/workflows/:id` | Get full workflow detail |
| `POST` | `/api/workflows` | Create a workflow |
| `PUT` | `/api/workflows/:id` | Update a workflow |
| `DELETE` | `/api/workflows/:id` | Delete (blocked if in-use by active goals) |
| `POST` | `/api/workflows/:id/clone` | Deep-copy a workflow with a new ID |

### OAuth

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/oauth/status` | OAuth provider status |
| `POST` | `/api/oauth/start` | Begin an OAuth flow, returns auth URL |
| `POST` | `/api/oauth/complete` | Exchange code for tokens (`{ flowId, code }`) |

### Preview

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/preview` | Get preview HTML for a session (`?sessionId=`) |
| `POST` | `/api/preview` | Set preview HTML for a session (`?sessionId=`, `{ html }`) |

## WebSocket protocol

Connect to `wss://<host>:<port>/ws/<session-id>`. First message must be `{ "type": "auth", "token": "<token>" }`. After `auth_ok`, the client can send commands and receives streaming events.

### Client → Server

| Type | Fields | Description |
|---|---|---|
| `auth` | `token` | Authenticate the connection |
| `prompt` | `text`, `images?`, `attachments?` | Send a user prompt |
| `steer` | `text` | Interrupt the agent mid-turn with guidance |
| `follow_up` | `text` | Send a follow-up message |
| `steer_queued` | `messageId` | Promote a queued message to steered (priority) |
| `remove_queued` | `messageId` | Remove a message from the queue |
| `abort` | — | Abort the current agent turn |
| `retry` | — | Retry the last failed turn |
| `set_model` | `provider`, `modelId` | Switch the AI model |
| `compact` | — | Trigger context compaction |
| `get_state` | — | Request current agent state |
| `get_messages` | — | Request full message history |
| `set_title` | `title` | Set session title |
| `generate_title` | — | Auto-generate title from conversation |
| `ping` | — | Keepalive ping |
| `invoke_skill` | `skillId`, `context?` | Invoke an isolated skill sub-agent |
| `task_create` | `goalId`, `title`, `taskType`, `parentTaskId?`, `spec?`, `dependsOn?` | Create a task |
| `task_update` | `taskId`, `updates` | Update a task (title, spec, state, assignment, deps) |
| `task_delete` | `taskId` | Delete a task |

### Server → Client

| Type | Key Fields | Description |
|---|---|---|
| `auth_ok` | — | Authentication succeeded |
| `auth_failed` | — | Authentication failed |
| `state` | `data` | Current agent state snapshot |
| `messages` | `data` | Full message history array |
| `event` | `data` | Streaming agent event (message_start, content_delta, tool calls, etc.) |
| `session_status` | `status` | Session status change (idle, streaming, etc.) |
| `session_title` | `sessionId`, `title` | Title changed |
| `client_joined` | `clientId` | Another client connected |
| `client_left` | `clientId` | A client disconnected |
| `error` | `message`, `code` | Error message |
| `pong` | — | Keepalive response |
| `skill_started` | `skillId` | Skill execution began |
| `skill_completed` | `skillId`, `result` | Skill produced output |
| `skill_failed` | `skillId`, `error` | Skill execution failed |
| `cost_update` | `sessionId`, `goalId?`, `taskId?`, `cost` | Token usage and cost update |
| `queue_update` | `sessionId`, `queue` | Prompt queue changed |
| `task_changed` | `task` | A task was created, updated, or deleted |
| `tasks_list` | `tasks` | Full task list for a goal |

## Features

### Sessions

Each session is a running `pi-coding-agent` child process with its own conversation history.

- **Persistence**: Session metadata (id, title, cwd, agent session file, `wasStreaming` flag) persists to `.bobbit/state/sessions.json`. On server restart, sessions restore by re-spawning agents and using `switch_session` RPC to resume from the agent's `.jsonl` file. If an agent was mid-turn when the server died, it is automatically re-prompted.
- **Auto-titles**: When the user sends their first prompt, `tryGenerateTitleFromPrompt()` fires **immediately** (before the agent replies) and calls Claude Haiku for a 2–3 word summary. The explicit `generate_title` command uses the full conversation history instead.
- **Multi-device**: Multiple browser tabs/devices can connect to the same session. Events are broadcast to all clients.
- **Force abort**: If a graceful abort doesn't make the agent idle within 3 seconds, the process is killed, a synthetic `agent_end` is emitted, and a fresh agent is spawned to resume the session.

### Goals

Goals are a task-tracking layer on top of sessions. A goal has a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved`).

- **Goal assistant**: Sessions created with `assistantType: "goal"` get a special prompt that helps users define clear goals. The assistant outputs structured `<goal_proposal>` blocks parsed by the browser client.
- **Auto-transition**: Goals move from `todo` to `in-progress` when their first session starts.
- **Worktrees**: Goals can optionally create a dedicated git worktree for isolated work.
- **Workflows**: Goals can optionally attach a workflow — a DAG of gates with dependency ordering, quality criteria, and automated verification. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) for the full architecture.

### Teams

A team is a group of agent sessions working together on a goal, coordinated by a team lead.

- **Team lead**: A special session created when the team starts. Gets a system prompt with team orchestration tools (`team_spawn`, `team_list`, `team_dismiss`, `team_complete`).
- **Role agents**: Spawned by the team lead with a specific role (coder, reviewer, tester, or custom). Each gets its own git worktree and role-specific system prompt with restricted tool access.
- **Lifecycle**: Start → spawn role agents → agents work on tasks → complete (dismiss agents, keep lead) or teardown (dismiss all).

### Tasks

Tasks are work items within a goal, managed via REST API or WebSocket commands.

- **State machine**: `todo` → `in-progress` → `complete` | `skipped` | `blocked`. Terminal states (`complete`, `skipped`) have no outgoing transitions.
- **Assignment**: Tasks can be assigned to sessions. The team manager notifies the team lead when assigned tasks reach terminal or blocked states.
- **Dependencies**: Tasks can declare dependencies on other tasks via `dependsOn`.

### Roles

Custom role definitions that control agent behaviour and tool access.

- **Built-in tools**: `role-manager.ts` maintains `AVAILABLE_TOOLS` — the master list of agent tool names.
- **Per-role configuration**: Each role has a name, label, prompt template, allowed tools list, accessory (for the mascot), and optional default traits.
- **Storage**: Roles persist as YAML files under `.bobbit/config/roles/`.

### Personalities

Personality definitions that modify agent behaviour via prompt fragments.

- Each personality has a name, label, description, and `promptFragment` that gets injected into the system prompt.
- Sessions can have multiple personalities. Personalities can be set at creation time or updated via `PATCH /api/sessions/:id`.
- Roles can define default personalities applied when no explicit personalities are provided.

### Skills

Skills are reusable templates for spawning isolated sub-agents that produce structured outputs.

- **Isolation**: Sub-agents receive only skill instructions + explicit context + `AGENTS.md` — never the parent conversation.
- **Built-in skills**: `correctness-review`, `security-review`, `design-review` (three code review perspectives), and `test-suite-report` (runs tests and produces a structured report).
- **Invocation**: Via `invoke_skill` WebSocket command. Server broadcasts `skill_started`, then `skill_completed` or `skill_failed`.
- **Definition sync**: Registered skills are exported to `.bobbit/state/skill-definitions.json` for agent-side tool extensions to discover.

### Cost Tracking

Per-session token usage and cost tracking, aggregated to goal and task level.

- Tracks input tokens, output tokens, cache read/write tokens, and total cost.
- Updated via `cost_update` WebSocket events broadcast to connected clients.
- Query via `GET /api/sessions/:id/cost`, `GET /api/goals/:id/cost`, or `GET /api/tasks/:id/cost`.

### Prompt Queue

Server-side queuing of user messages when the agent is busy.

- Steered messages sort before non-steered (priority interrupt).
- Queue auto-drains when the agent finishes a turn.
- Client can promote queued messages to steered (`steer_queued`) or remove them (`remove_queued`).
- Queue state broadcast to clients via `queue_update` events.

See [docs/prompt-queue.md](docs/prompt-queue.md) for the full architecture.

### Workflows

Workflows define the gates a goal must pass, their dependency relationships (a DAG), quality criteria, and verification configs. Stored as YAML in `.bobbit/config/workflows/`. Snapshotted into goals at creation (frozen). See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).

### Assistant Registry

A unified registry (`assistant-registry.ts`) maps assistant types to their prompts and display titles:

- `goal` — Goal creation assistant
- `role` — Role creation assistant
- `tool` — Tool management assistant

Sessions created with an `assistantType` get the corresponding system prompt automatically.

### Compaction

Context compaction reduces token usage by summarising the conversation.

- **Manual**: User triggers via `compact` WebSocket command. Server calls `rpcClient.compact()` (120s timeout), then refreshes messages and state.
- **Auto**: Triggered by the agent subprocess when context grows too large. Events flow through the event system and the UI refreshes automatically.

### System Prompt Assembly

Each session's system prompt is assembled from three layers:

1. **Global** — `.bobbit/config/system-prompt.md` from the Bobbit project root
2. **AGENTS.md** — From the session's working directory, with `@FILENAME.md` inline inclusion (recursive, circular-reference safe)
3. **Goal spec** — If the session belongs to a goal, the goal's spec is appended

The assembled prompt is written to `.bobbit/state/session-prompts/{sessionId}.md` and cleaned up on session termination.

### Reconnection

`RemoteAgent` auto-reconnects on unexpected disconnects with exponential backoff (1s base, 30s max). On reconnect: re-authenticates, requests current messages and state, server replays the latest `tool_execution_update` per tool call ID from the `EventBuffer`.

### Task Completion Notifications

When the agent finishes a turn, the browser client notifies the user via:
1. **Browser Notification API** — Shows session title and elapsed time
2. **Title flash** — Alternates document title with "Done (Xm)" until tab regains focus
3. **Audio beep** — Two-tone sine wave (880 Hz, 1046 Hz) via Web Audio API

## Browser client (`src/app/`)

| File | Purpose |
|---|---|
| `main.ts` | App bootstrap. Routing setup, session sidebar, QR code dialog, OAuth integration. |
| `remote-agent.ts` | `RemoteAgent` — WebSocket adapter implementing the `Agent` interface for `ChatPanel`. Handles streaming state, deferred messages, compaction, reconnection, and notifications. |
| `state.ts` | Global app state: sessions list, goals list, active session/goal, connection status, panel states. |
| `api.ts` | Gateway REST API client helpers (`gatewayFetch`, `patchSession`, etc.). |
| `routing.ts` | Hash-based URL routing (`#/` landing, `#/session/{id}`, `#/goal/{id}`, `#/roles`, `#/tools`, `#/workflows`). |
| `render.ts` | Top-level render function. Header bar with model/thinking selectors, layout orchestration. |
| `render-helpers.ts` | Shared rendering utilities (Lucide icons, badges, delete confirmations). |
| `sidebar.ts` | Desktop sidebar: session list, goal list, create buttons, collapse toggle. |
| `session-manager.ts` | Session create/connect/disconnect lifecycle, preview polling. |
| `session-colors.ts` | Session color picker UI component. |
| `storage.ts` | IndexedDB store initialisation (settings, provider keys, sessions, goals, roles, specs). |
| `dialogs.ts` | Confirmation and prompt dialog helpers. |
| `goal-dashboard.ts` | Goal detail page with tabs: overview, tasks, gates, team, commits, cost. |
| `role-manager-page.ts` | Role list page and detail/edit view. |
| `role-manager-dialog.ts` | Role creation and editing dialog. |
| `tool-manager-page.ts` | Tool list (grouped) and detail page with docs editing. |
| `workflow-page.ts` | Workflow list and detail/edit page. |
| `preview-panel.ts` | Live HTML preview split-pane. Polls `GET /api/preview` and auto-refreshes iframe. |
| `mobile-header.ts` | Mobile-only top header bar, always pinned. |
| `proposal-parsers.ts` | Parses structured proposals (`<goal_proposal>`, `<role_proposal>`, `<tool_proposal>`) from assistant messages. |
| `cwd-combobox.ts` | Working directory selector with git branch display. |
| `custom-messages.ts` | Custom message type registration (system notifications). |
| `oauth.ts` | Browser-side OAuth flow (proxied token exchange). |

## UI components (`src/ui/`)

Forked from `@mariozechner/pi-web-ui`. Lit-based web components.

- **`ChatPanel.ts`** — Top-level orchestrator: wires agent, message list, input, model selector
- **`components/`** — Core components: `AgentInterface` (event→state bridge), `MessageList`, `StreamingMessageContainer`, `Messages` (per-role renderers), `Input` (chat input with attachments), `MessageEditor`, `GitStatusWidget`, `ThinkingBlock`, `ToolGroup`, sandboxed iframe providers
- **`dialogs/`** — `ModelSelector`, `SettingsDialog`, `SessionListDialog`, `AttachmentOverlay`, `ApiKeyPromptDialog`, `CustomProviderDialog`, `PersistentStorageDialog`, `ProvidersModelsTab`
- **`tools/`** — Specialised renderers for 20+ tool types (Bash, Read, Write, Edit, Grep, Find, Ls, Delegate, Browser*, WebSearch, WebFetch, Screenshot, SVG, HTML, Task, Team, Calculate, GetCurrentTime) + inline content display (HTML, SVG, PDF, Markdown, Docx, Excel, images)
- **`storage/`** — IndexedDB-backed persistence with typed stores for settings, sessions, provider keys, command history, goal/role/spec drafts
- **`utils/`** — ANSI handling, text formatting, auth token, model discovery, i18n, proxy utilities

## Dependencies

### Runtime

| Package | Purpose |
|---|---|
| `@lmstudio/sdk` | LM Studio local model integration |
| `@mariozechner/mini-lit` | Minimal Lit component library (buttons, dialogs, alerts, inputs) |
| `@mariozechner/pi-agent-core` | Agent interface types and event model |
| `@mariozechner/pi-ai` | AI model abstraction (providers, streaming, tool calling) |
| `@mariozechner/pi-coding-agent` | The coding agent (spawned as subprocess) |
| `@mariozechner/pi-tui` | Terminal UI utilities |
| `acme-client` | ACME/Let's Encrypt client for TLS certificates |
| `docx-preview` | DOCX document rendering in browser |
| `jszip` | ZIP file handling (used by document renderers) |
| `lit` | Web component framework |
| `lucide` | Icon library |
| `mkcert` | Local CA certificate generation |
| `ollama` | Ollama local model integration |
| `pdfjs-dist` | PDF rendering in browser |
| `qrcode` | QR code generation for mobile access |
| `ws` | WebSocket server |
| `xlsx` | Excel spreadsheet parsing |
| `yaml` | YAML parsing/serialisation (roles, personalities, workflows) |

### Development

| Package | Purpose |
|---|---|
| `@playwright/test` | Browser testing framework |
| `@tailwindcss/vite` | Tailwind CSS Vite plugin |
| `@types/node` | Node.js type definitions |
| `@types/ws` | WebSocket type definitions |
| `concurrently` | Run multiple processes (gateway + vite) |
| `shx` | Cross-platform shell commands |
| `typescript` | TypeScript compiler |
| `vite` | Frontend build tool and dev server |

## Security model

**This tool grants full shell access to the host machine.** The auth token is equivalent to an SSH key.

- 256-bit cryptographically random token generated on first run, persisted at `.bobbit/state/token` with mode `0600`
- All API routes and WebSocket connections require the token
- Constant-time token comparison prevents timing attacks
- IP-based rate limiting on failed auth attempts (automatic lockout)
- 5-second auth timeout on WebSocket connections
- Static file serving has directory traversal prevention (resolved path must start with static dir)
- Gateway binds to NordLynx mesh IP if available, otherwise `localhost` — never `0.0.0.0` unless explicitly requested
- TLS on by default for non-loopback addresses; disabled for localhost unless `--tls` is passed
- OAuth PKCE flow for obtaining API credentials securely

## Networking

By default, Bobbit binds to `localhost` for local-only access (HTTP). When a **NordVPN mesh network** is detected, the gateway auto-binds to the NordLynx interface's IPv4 address with HTTPS, enabling remote access from any device on the mesh.

**Port topology in dev mode:**
- **Vite** (`:5173`) — User-facing HTTPS, serves UI with HMR, proxies `/api/*` and `/ws/*` to the gateway
- **Gateway** (`:3001`) — HTTPS, REST API, WebSocket sessions, agent subprocess management

In production (`npm start`), the gateway serves the bundled UI directly on `:3001`.

**deSEC dynamic DNS**: On startup, the gateway updates a deSEC A record so a custom domain (e.g. `bobbit.dedyn.io`) resolves to the current mesh IP. Config stored in `.bobbit/state/desec.json`. Skipped for loopback addresses to avoid clobbering the record during tests.

**TLS** is on by default for non-loopback addresses; disabled for localhost to avoid self-signed certificate warnings. Pass `--tls` to force TLS on localhost. Certs are generated via mkcert (local CA) or openssl fallback. The cert covers the current host IP + localhost and regenerates automatically if the IP changes. Vite reuses the same cert.

**QR code**: Encodes `window.location.origin` + auth token. Scannable from any device on the NordVPN mesh.

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full networking reference, troubleshooting, and local-only setup.

## Testing

```bash
npm run check         # Type-check server + web without emitting
npm test              # Unit tests (Playwright with file:// fixtures)
npm run test:e2e      # E2E tests (auto-starts sandboxed gateway)
```

**E2E tests** use Playwright's `webServer` config in `playwright-e2e.config.ts` to **automatically start a sandboxed gateway on port 3099**. No manual server setup needed. The test server runs with `BOBBIT_DIR` set to an isolated temp directory so all state files are fully separated from the dev server's `.bobbit/`.

**Unit tests** use `file://` fixtures — plain HTML/JS files that test logic without a build step. See `tests/mobile-header.spec.ts` for the pattern.

Pipe Playwright output through the test filter for concise results:
```bash
npx playwright test --config playwright-e2e.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs
```

## Build structure

```
dist/
├── server/         # tsc output (Node16 modules)
│   ├── cli.js      # bin entry point
│   ├── harness.js  # dev server wrapper
│   └── ...         # all server modules
└── ui/             # vite output (browser bundle)
    └── index.html  # SPA entry
```

Two separate TypeScript configs:
- `tsconfig.server.json` — Node16 module resolution, `src/server/` → `dist/server/`
- `tsconfig.web.json` — Bundler resolution + DOM libs, `src/ui/` + `src/app/` (bundled by Vite, tsc only type-checks)

## Bobbit mascot

The bobbit is a pixel-art blob mascot rendered with CSS `box-shadow`, with idle/working/starting animations, 14 colour identities (via `hue-rotate`), and role-based accessories (hardhat, magnifying glass, test tube, crown, etc.).

See [docs/bobbit-sprites.md](docs/bobbit-sprites.md) for the full sprite reference, animation system, and accessory catalogue.
