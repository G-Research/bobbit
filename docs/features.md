# Features

Detailed reference for all Bobbit features. For a quick overview, see the [README](../README.md).

## Sessions

Each session is a running `pi-coding-agent` child process with its own conversation history.

- **Persistence**: Session metadata (id, title, cwd, agent session file, `wasStreaming` flag) persists to `.bobbit/state/sessions.json`. On server restart, sessions restore by re-spawning agents and using `switch_session` RPC to resume from the agent's `.jsonl` file. If an agent was mid-turn when the server died, it is automatically re-prompted.
- **Auto-titles**: When the user sends their first prompt, `tryGenerateTitleFromPrompt()` fires **immediately** (before the agent replies) and calls Claude Haiku for a 2–3 word summary. The explicit `generate_title` command uses the full conversation history instead.
- **Multi-device**: Multiple browser tabs/devices can connect to the same session. Events are broadcast to all clients.
- **Force abort**: If a graceful abort doesn't make the agent idle within 3 seconds, the process is killed, a synthetic `agent_end` is emitted, and a fresh agent is spawned to resume the session. An `"aborting"` status is broadcast immediately so the UI shows feedback during the grace period. After force-kill, any in-flight steers that the SDK accepted but never echoed are pulled off the per-session shadow ledger and re-enqueued at the front of `promptQueue`; `drainQueue()` then redispatches them as a single steered batch. See [prompt-queue.md](prompt-queue.md#abort-and-force-kill-recovery) for details.

## Goals

Goals are a task-tracking layer on top of sessions. A goal has a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved`).

- **Goal assistant**: Sessions created with `assistantType: "goal"` get a special prompt that helps users define clear goals. The assistant calls `propose_goal` (and other `propose_*` tools) to emit structured proposals as tool calls, which persist in message history and can be reopened via an "Open proposal" button. A deprecated XML fallback (`proposal-parsers.ts`) still parses legacy `<goal_proposal>` blocks for backward compatibility.
- **Auto-transition**: Goals move from `todo` to `in-progress` when their first session starts.
- **Worktrees**: Goals can optionally create a dedicated git worktree for isolated work. After creating the worktree, Bobbit runs the `worktree_setup_command` from `.bobbit/config/project.yaml` to install dependencies (if configured). No setup runs by default — you must explicitly configure it for your project's package manager.
- **Workflows**: Goals can optionally attach a workflow — a DAG of gates with dependency ordering, quality criteria, and automated verification. Human sign-off steps use the review pane for submitted content, inline/final comments, and approve/reject decisions. See [goals-workflows-tasks.md](goals-workflows-tasks.md) and [review-pane-signoff.md](review-pane-signoff.md) for the full architecture.

## Teams

A team is a group of agent sessions working together on a goal, coordinated by a team lead.

- **Team lead**: A special session created when the team starts. Gets a system prompt with team orchestration tools (`team_spawn`, `team_list`, `team_dismiss`, `team_complete`).
- **Role agents**: Spawned by the team lead with a specific role (coder, reviewer, tester, or custom). Each gets its own git worktree and role-specific system prompt with restricted tool access.
- **Lifecycle**: Start → spawn role agents → agents work on tasks → complete (dismiss agents, keep lead) or teardown (dismiss all).

### Child agents (`team_delegate`)

Any session — goal or not — can launch a **child agent** with `team_delegate` (the rename of the
old `delegate` tool). The child runs in the parent's worktree with no conversation context, either
blocking one-shot or detached and orchestrated via `team_wait` / `team_prompt` / `team_steer` /
`team_dismiss`. Children inherit the parent's current model, survive gateway restarts, and are
cascade-archived with their parent. Packs reach the same machinery via the ambient `host.agents`
capability. See [orchestration.md](orchestration.md) for the full surface and guarantees.

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

## Skills

Slash-command skills discovered from Claude Code-compatible `SKILL.md` files.

- **Discovery**: Skills are found in `.claude/skills/<name>/SKILL.md` (project), `~/.claude/skills/<name>/SKILL.md` (personal), `.bobbit/skills/<name>/SKILL.md` (project/personal), and `.claude/commands/<name>.md` (legacy). Additional directories can be configured via the Settings → Config Directories tab or `config_directories` in `.bobbit/config/project.yaml`.
- **Custom directories**: Configure via Settings → Config Directories tab (`#/settings`, Directories tab) or by setting `config_directories` in project config. The legacy `skill_directories` key is still read for backward compatibility but `config_directories` is preferred. Custom directories are additive — defaults always scan. Skills from custom dirs get source `"custom"` with lower priority than built-in directories.
- **Invocation**: Via `/skill-name` slash commands in the chat input. Skills can be invoked as a prefix (`/deploy staging`) or inline within a prompt (`Analyse using /my-skill the code`). The server resolves all `/skill-name` tokens at word boundaries and expands them inline. The autocomplete menu triggers at any `/` preceded by whitespace or at position 0, and anchors visually to the `/` character's position.
- **Frontmatter**: YAML frontmatter supports `description`, `argument_hint`, `allowed_tools`, `context` (e.g. `fork`), `agent`, `disable_model_invocation`, and `user_invocable`.
- **Autonomous activation**: Each session's system prompt embeds an "Available Skills" catalog (name + description + arg hint per skill) so the agent can invoke `activate_skill` mid-turn without the user typing `/name`. Skills with `disable_model_invocation: true` are omitted from the catalog.
- **Catalog budget**: The catalog is capped in bytes to keep the system prompt small. Default is **16 KB**; configurable per-user via Settings → General → "Skills catalog budget" within **1–128 KB**. The preference is stored as `skillsCatalogBudget` (bytes) via `PUT /api/preferences`; absent or `null` falls back to the default. When skills exceed the budget, the list is sorted alphabetically by name and the tail is dropped with a `_… (N more skills omitted, alphabetically truncated)_` footer so the agent knows more exist (it can still invoke them by name). A `[system-prompt] Skills catalog exceeded <budget>B budget — truncated N skill(s).` warning is logged. Tuning bounds are enforced server-side in `resolveSkillsCatalogBudget` (`src/server/agent/system-prompt.ts`) and mirrored by the Settings input.
- **API**: `GET /api/slash-skills` for autocomplete data, `GET /api/slash-skills/details` for full content, file paths, and scanned directories.

## File References (`@`-mentions)

Type `@` in the prompt composer to reference a file by path, mirroring the `/` slash-skill menu. On send the server resolves each `@path` token: text files are inlined into the model-facing prompt as `<file-reference>` blocks, images route through the `images[]` frame, and other binaries become document attachments. Unresolvable / oversized / out-of-cwd references degrade gracefully to the literal `@path`. Content is snapshotted at send time, so chips and original text replay stably via the shared skill sidecar. Backed by `GET /api/file-mentions`. See [at-mention-file-references.md](at-mention-file-references.md) for the full behaviour, caps, path-safety, and source map.

## Cost Tracking

Per-session token usage and cost tracking, aggregated to goal and task level.

- Tracks input tokens, output tokens, cache read/write tokens, and total cost.
- Persists cumulative session totals through `CostTracker`; this is the authoritative display source when present.
- Derives a **`cacheHitRate`** (`cacheReadTokens / (cacheReadTokens + inputTokens)`) on every read — not stored on disk. `null` for cold sessions or providers that don't report cache counters; rendered as `—` in the UI.
- Hydrates dashboard cost summaries via `cost_update` WebSocket events and `state.serverCost`, including reconnect and post-compaction refresh paths.
- `CostPopover` fetches `/cost/breakdown` when opened and shows the **Cache hit** row from that response; it is not directly live-updated by `cost_update` frames.
- Query via `GET /api/sessions/:id/cost`, `GET /api/goals/:id/cost`, or `GET /api/tasks/:id/cost` — all responses include `cacheHitRate: number | null`.

See [docs/cache-hit-rate.md](cache-hit-rate.md) for formula details, null semantics, and implementation notes.
See [session-cost.md](session-cost.md) for source-of-truth, hydration, and compaction behavior.

## Prompt Queue

Server-side queuing of user messages when the agent is busy.

- Steered messages sort before non-steered (priority interrupt).
- Queue auto-drains when the agent finishes a turn (suppressed on error — user must retry first).
- Client can promote queued messages to steered (`steer_queued`), remove them (`remove_queued`), edit them (remove + populate textarea), or drag-reorder them (`reorder_queue`).
- Queue pills show drag handle, edit (pencil), steer, and remove buttons. Steered pills show a "Sent" badge instead.
- Steered messages are batched — they reorder to the front of the queue and are delivered as a single combined prompt when the agent next becomes idle (on normal turn completion or after abort+restart).
- `follow_up` flag is preserved through the queue: messages enqueued with `isFollowUp: true` dispatch via `followUp()` RPC on drain.
- Queue state broadcast to clients via `queue_update` events.

See [prompt-queue.md](prompt-queue.md) for the full architecture.

## Workflows

Workflows define the gates a goal must pass, their dependency relationships (a DAG), quality criteria, and verification configs. Workflows are **project-scoped only** — they live inline in `project.yaml::workflows` and are designed by the project assistant from the project's actual components and commands. There is no builtin or system-scope layer, and the server does not auto-seed defaults on project creation. Snapshotted into goals at creation (frozen). See [goals-workflows-tasks.md](goals-workflows-tasks.md) and [internals.md — No default workflow scaffold](internals.md#no-default-workflow-scaffold).

## PR Walkthrough Panel

The PR walkthrough panel is a guided pull-request or changeset review surface. It ships as a **built-in first-party pack** (`market-packs/pr-walkthrough/`) that is auto-resolved active-by-default — there is no manual install. Three pack launchers (git-widget button / composer-slash / command palette) all do the **same** thing on click: they call the pack's `run` route, which mints a **separate, isolated, read-only reviewer child** (`host.agents.spawn`, role `pr-reviewer`, `title: "PR Walkthrough"`) — it never drives the user's current agent — and then **auto-switch the view to that child session**, opening the panel there. There is **no owner-session panel** and **no manual "Run PR walkthrough" / "Load walkthrough" buttons**. A no-PR / spawn failure surfaces as an **inline error in the git-status-widget dropdown**, spawning nothing and not switching the view; every click is a fresh reviewer (no dedup). The reviewer publishes cards only through validated `submit_pr_walkthrough_yaml`, and on submit it is **not** dismissed — it stays live and selectable until the user terminates it. The run path is GitHub-PR-only. Disabling the pack from the Market built-in section makes the feature unavailable (the deep-link degrades to an empty state). See [pr-walkthrough-panel.md](pr-walkthrough-panel.md) for the full behaviour and testing contract, [pr-walkthrough-launch-ux.md](design/pr-walkthrough-launch-ux.md) for the launch model, and [built-in-first-party-packs.md](design/built-in-first-party-packs.md) for the pack model.

## Assistant Registry

A unified registry (`assistant-registry.ts`) maps assistant types to their prompts and display titles. Builtin definitions ship in `defaults/roles/assistant/` (user overrides in `.bobbit/config/roles/assistant/`), falling back to hardcoded defaults:

- `goal` — Goal creation assistant
- `role` — Role creation assistant
- `tool` — Tool management assistant
- `staff` — Staff agent creation assistant (see [staff-agents.md](staff-agents.md) for the staff lifecycle and the immutable-at-creation sandbox model)

Sessions created with an `assistantType` get the corresponding system prompt automatically. Assistant prompts can be edited via their YAML files and are reloaded on change.

## Compaction

Context compaction reduces token usage by summarising the conversation.

- **Manual**: User triggers via `compact` WebSocket command. Server calls `rpcClient.compact()` (120s timeout), then refreshes messages and state.
- **Auto**: Triggered by the agent subprocess when context grows too large. Events flow through the event system and the UI refreshes automatically.

## System Prompt Assembly

Each session's system prompt is assembled from eight sections. Sections are separated by `\n\n---\n\n` and written to `.bobbit/state/session-prompts/{sessionId}.md` at spawn time.

The sections are ordered so that the **stable prefix** (sections 1–5, which are deterministic functions of the project and allowed tools) comes before the **volatile suffix** (sections 6–8, which vary per goal/task/session). This ordering lets provider prompt caches (Anthropic ephemeral, OpenAI prompt cache) reuse the tool docs and skills catalog across team spawns and between turns, because the cache key only invalidates at the first changed byte.

| # | Section | Volatile? | Source |
|---|---------|-----------|--------|
| 1 | **Global system prompt** | No | `.bobbit/config/system-prompt.md` (user customised) or `defaults/system-prompt.md`. Resolved by `resolveSystemPromptPath()`. See [internals.md — Config cascade](internals.md#config-cascade). |
| 2 | **AGENTS.md / project docs** | No | From the session's working directory, with `@FILENAME.md` inline inclusion (recursive, circular-reference safe). |
| 3 | **Working directory** | No | Injected `# Working Directory` block with the session's `cwd`. |
| 4 | **Tool documentation** | No | Assembled from `defaults/tools/<group>/` (project overrides under `.bobbit/config/tools/<group>/`). |
| 5 | **Available Skills catalog** | No | Built from the list of skills in scope for the session. |
| 6 | **Goal + Role** | Yes | Goal spec and/or role prompt; combined under a single `# Goal` heading. |
| 7 | **Current Task** | Yes | Task title, type, spec, and dependency list. Omitted when no task is assigned. |
| 8 | **Workflow upstream-gate context** | Yes | Passed gate content injected for context. Omitted when not in a workflow. |

Implementation: `src/server/agent/system-prompt.ts::_assembleSystemPrompt`. The inspector UI uses `getPromptSections()` (same file) to show labeled sections in the same order.

## Reconnection

`RemoteAgent` auto-reconnects on unexpected disconnects with exponential backoff (1s base, 30s max). On reconnect: re-authenticates, requests current messages and state, server replays the latest `tool_execution_update` per tool call ID from the `EventBuffer`.

## Task Completion Notifications

When the agent finishes a turn, the browser client notifies the user via:
1. **Browser Notification API** — Shows session title and elapsed time
2. **Title flash** — Alternates document title with "Done (Xm)" until tab regains focus
3. **Audio beep** — Two-tone sine wave (880 Hz, 1046 Hz) via Web Audio API
4. **Favicon badge + sidebar unread dot** — Persists until the user opens the session

These cues are scoped to **human attention**: standalone sessions notify on idle (as before), team members and delegates stay silent (they escalate to their team lead, not the user), and a team lead notifies when the goal is `complete`, needs immediate human action, or is persistently stuck. One-shot beeps do not fire merely because a team lead went idle to wait for workers or verification. Notification surfaces consult the predicates in `src/app/notification-policy.ts`. See [design/notification-policy.md](design/notification-policy.md).
