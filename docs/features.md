# Features

Detailed reference for all Bobbit features. For a quick overview, see the [README](../README.md).

## Sessions

Each session is a running `pi-coding-agent` child process with its own conversation history.

- **Persistence**: Session metadata (id, title, cwd, agent session file, `wasStreaming` flag) persists to `.bobbit/state/sessions.json`. On server restart, sessions restore by re-spawning agents and using `switch_session` RPC to resume from the agent's `.jsonl` file. If an agent was mid-turn when the server died, it is automatically re-prompted.
- **Auto-titles**: When the user sends their first prompt, `tryGenerateTitleFromPrompt()` fires **immediately** (before the agent replies) and calls Claude Haiku for a 2–3 word summary. The explicit `generate_title` command uses the full conversation history instead.
- **Multi-device**: Multiple browser tabs/devices can connect to the same session. Events are broadcast to all clients.
- **Force abort**: If a graceful abort doesn't make the agent idle within 3 seconds, the process is killed, a synthetic `agent_end` is emitted, and a fresh agent is spawned to resume the session. An `"aborting"` status is broadcast immediately so the UI shows feedback during the grace period. After force-kill, any queued/steered messages are recovered via `resetDispatched()` + `drainQueue()`. See [prompt-queue.md](prompt-queue.md#abort-and-force-kill-recovery) for details.

## Goals

Goals are a task-tracking layer on top of sessions. A goal has a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved`).

- **Goal assistant**: Sessions created with `assistantType: "goal"` get a special prompt that helps users define clear goals. The assistant calls `propose_goal` (and other `propose_*` tools) to emit structured proposals as tool calls, which persist in message history and can be reopened via an "Open proposal" button. A deprecated XML fallback (`proposal-parsers.ts`) still parses legacy `<goal_proposal>` blocks for backward compatibility.
- **Auto-transition**: Goals move from `todo` to `in-progress` when their first session starts.
- **Worktrees**: Goals can optionally create a dedicated git worktree for isolated work. After creating the worktree, Bobbit runs the `worktree_setup_command` from `.bobbit/config/project.yaml` to install dependencies (if configured). No setup runs by default — you must explicitly configure it for your project's package manager.
- **Workflows**: Goals can optionally attach a workflow — a DAG of gates with dependency ordering, quality criteria, and automated verification. See [goals-workflows-tasks.md](goals-workflows-tasks.md) for the full architecture.

## Teams

A team is a group of agent sessions working together on a goal, coordinated by a team lead.

- **Team lead**: A special session created when the team starts. Gets a system prompt with team orchestration tools (`team_spawn`, `team_list`, `team_dismiss`, `team_complete`).
- **Role agents**: Spawned by the team lead with a specific role (coder, reviewer, tester, or custom). Each gets its own git worktree and role-specific system prompt with restricted tool access.
- **Lifecycle**: Start → spawn role agents → agents work on tasks → complete (dismiss agents, keep lead) or teardown (dismiss all).

## Tasks

Tasks are work items within a goal, managed via REST API or WebSocket commands.

- **State machine**: `todo` → `in-progress` → `complete` | `skipped` | `blocked`. Terminal states (`complete`, `skipped`) have no outgoing transitions.
- **Assignment**: Tasks can be assigned to sessions. The team manager notifies the team lead when assigned tasks reach terminal or blocked states.
- **Dependencies**: Tasks can declare dependencies on other tasks via `dependsOn`.

## Roles

Custom role definitions that control agent behaviour and tool access.

- **Built-in tools**: `role-manager.ts` maintains `AVAILABLE_TOOLS` — the master list of agent tool names.
- **Per-role configuration**: Each role has a name, label, prompt template, allowed tools list, accessory (for the mascot), and optional default traits.
- **Storage**: Builtin roles ship in `defaults/roles/`; user overrides go in `.bobbit/config/roles/`.

## Personalities

Personality definitions that modify agent behaviour via prompt fragments.

- Each personality has a name, label, description, and `promptFragment` that gets injected into the system prompt.
- Sessions can have multiple personalities. Personalities can be set at creation time or updated via `PATCH /api/sessions/:id`.
- Roles can define default personalities applied when no explicit personalities are provided.

## Skills

Slash-command skills discovered from Claude Code-compatible `SKILL.md` files.

- **Discovery**: Skills are found in `.claude/skills/<name>/SKILL.md` (project), `~/.claude/skills/<name>/SKILL.md` (personal), `.bobbit/skills/<name>/SKILL.md` (project/personal), and `.claude/commands/<name>.md` (legacy). Additional directories can be configured via the Settings → Config Directories tab or `config_directories` in `.bobbit/config/project.yaml`.
- **Custom directories**: Configure via Settings → Config Directories tab (`#/settings`, Directories tab) or by setting `config_directories` in project config. The legacy `skill_directories` key is still read for backward compatibility but `config_directories` is preferred. Custom directories are additive — defaults always scan. Skills from custom dirs get source `"custom"` with lower priority than built-in directories.
- **Invocation**: Via `/skill-name` slash commands in the chat input. Skills can be invoked as a prefix (`/deploy staging`) or inline within a prompt (`Analyse using /my-skill the code`). The server resolves all `/skill-name` tokens at word boundaries and expands them inline. The autocomplete menu triggers at any `/` preceded by whitespace or at position 0, and anchors visually to the `/` character's position.
- **Frontmatter**: YAML frontmatter supports `description`, `argument_hint`, `allowed_tools`, `context` (e.g. `fork`), `agent`, `disable_model_invocation`, and `user_invocable`.
- **API**: `GET /api/slash-skills` for autocomplete data, `GET /api/slash-skills/details` for full content, file paths, and scanned directories.

## Cost Tracking

Per-session token usage and cost tracking, aggregated to goal and task level.

- Tracks input tokens, output tokens, cache read/write tokens, and total cost.
- Updated via `cost_update` WebSocket events broadcast to connected clients.
- Query via `GET /api/sessions/:id/cost`, `GET /api/goals/:id/cost`, or `GET /api/tasks/:id/cost`.

## Prompt Queue

Server-side queuing of user messages when the agent is busy.

- Steered messages sort before non-steered (priority interrupt).
- Queue auto-drains when the agent finishes a turn (suppressed on error — user must retry first).
- Client can promote queued messages to steered (`steer_queued`), remove them (`remove_queued`), edit them (remove + populate textarea), or drag-reorder them (`reorder_queue`).
- Queue pills show drag handle, edit (pencil), steer, and remove buttons. Steered pills show a "Sent" badge instead.
- Steered messages are batched — they are held until the user presses Stop/Escape, then delivered as a single block on abort.
- `follow_up` flag is preserved through the queue: messages enqueued with `isFollowUp: true` dispatch via `followUp()` RPC on drain.
- Queue state broadcast to clients via `queue_update` events.

See [prompt-queue.md](prompt-queue.md) for the full architecture.

## Workflows

Workflows define the gates a goal must pass, their dependency relationships (a DAG), quality criteria, and verification configs. Builtin workflows ship in `defaults/workflows/`; user overrides go in `.bobbit/config/workflows/`. Snapshotted into goals at creation (frozen). See [goals-workflows-tasks.md](goals-workflows-tasks.md).

## Assistant Registry

A unified registry (`assistant-registry.ts`) maps assistant types to their prompts and display titles. Builtin definitions ship in `defaults/roles/assistant/` (user overrides in `.bobbit/config/roles/assistant/`), falling back to hardcoded defaults:

- `goal` — Goal creation assistant
- `role` — Role creation assistant
- `tool` — Tool management assistant
- `personality` — Personality creation assistant
- `staff` — Staff agent creation assistant
- `setup` — Project setup wizard

Sessions created with an `assistantType` get the corresponding system prompt automatically. Assistant prompts can be edited via their YAML files and are reloaded on change.

## Compaction

Context compaction reduces token usage by summarising the conversation.

- **Manual**: User triggers via `compact` WebSocket command. Server calls `rpcClient.compact()` (120s timeout), then refreshes messages and state.
- **Auto**: Triggered by the agent subprocess when context grows too large. Events flow through the event system and the UI refreshes automatically.

## System Prompt Assembly

Each session's system prompt is assembled from three layers:

1. **Global** — `.bobbit/config/system-prompt.md` from the Bobbit project root
2. **AGENTS.md** — From the session's working directory, with `@FILENAME.md` inline inclusion (recursive, circular-reference safe)
3. **Goal spec** — If the session belongs to a goal, the goal's spec is appended

The assembled prompt is written to `.bobbit/state/session-prompts/{sessionId}.md` and cleaned up on session termination.

## Reconnection

`RemoteAgent` auto-reconnects on unexpected disconnects with exponential backoff (1s base, 30s max). On reconnect: re-authenticates, requests current messages and state, server replays the latest `tool_execution_update` per tool call ID from the `EventBuffer`.

## Task Completion Notifications

When the agent finishes a turn, the browser client notifies the user via:
1. **Browser Notification API** — Shows session title and elapsed time
2. **Title flash** — Alternates document title with "Done (Xm)" until tab regains focus
3. **Audio beep** — Two-tone sine wave (880 Hz, 1046 Hz) via Web Audio API
