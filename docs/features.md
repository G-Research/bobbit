# Features

Detailed reference for all Bobbit features. For a quick overview, see the [README](../README.md).

## Headquarters workspace

Every Bobbit server has a built-in project named **Headquarters** with stable id `headquarters`. It represents the server run directory and the server/global config scope, so a fresh install can create a Quick Session or staff agent immediately without Add Project setup.

Headquarters appears first in project lists by default and uses the Lucide `TowerControl` icon instead of the normal folder identity. The Settings preference `showHeadquartersInProjectLists` hides or shows it in normal lists only; hidden Headquarters remains resolvable internally and preserves its sessions, goals, staff, and config.

Non-workflow config with `projectId=headquarters` aliases server config. Workflows remain project-scoped under Headquarters. See [headquarters.md](headquarters.md) for the storage, API, UI, and no-worktree goal behavior.

## Sessions

Each session is a running `pi-coding-agent` child process with its own conversation history.

- **Persistence**: Session metadata (id, title, cwd, agent session file, restart re-drive marker stored in `wasStreaming`) persists to `.bobbit/state/sessions.json`. On server restart, sessions restore by re-spawning agents and using `switch_session` RPC to resume from the agent's `.jsonl` file. Active interactive sessions are automatically re-prompted; non-interactive verification reviewers are re-driven by the verification harness.
- **Auto-titles**: When the user sends their first prompt, `tryGenerateTitleFromPrompt()` fires **immediately** (before the agent replies) and calls Claude Haiku for a 2–3 word summary. The explicit `generate_title` command uses the full conversation history instead.
- **Multi-device**: Multiple browser tabs/devices can connect to the same session. Events are broadcast to all clients.
- **Session actions**: Sidebar rows and open-session headers share one canonical action model for rename/edit staff, terminate/end team, refresh, fork, copy link, system prompt inspection, and opening sessions in new windows. See [session-actions.md](session-actions.md).
- **Sidebar tree**: Projects, goals, sessions, staff, delegates, team leads, and archived sections share one tree model for hierarchy, expansion persistence, and indentation. See [sidebar-tree-state.md](sidebar-tree-state.md) and [sidebar-tree-indentation.md](sidebar-tree-indentation.md).
- **Force abort**: If a graceful abort doesn't make the agent idle within 3 seconds, the process is killed, a synthetic `agent_end` is emitted, and a fresh agent is spawned to resume the session. An `"aborting"` status is broadcast immediately so the UI shows feedback during the grace period. After force-kill, any in-flight steers that the SDK accepted but never echoed are pulled off the per-session shadow ledger and re-enqueued at the front of `promptQueue`; `drainQueue()` then redispatches them as a single steered batch. See [prompt-queue.md](prompt-queue.md#abort-and-force-kill-recovery) for details.

## Maintenance

Settings → Maintenance provides preview-first cleanup for durable resources that may outlive their active session. Worktree Cleanup is the canonical surface for safe Bobbit worktree removal across archived sessions, orphaned git worktrees, pool entries, and filesystem-only diagnostics while preserving archives, transcripts, proposals, and protected live/durable references. Related cards cover orphaned sessions, expired archives, and search index rows. See [maintenance.md](maintenance.md).

## Goals

Goals are a task-tracking layer on top of sessions. A goal has a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved`).

- **Goal assistant**: Sessions created with `assistantType: "goal"` get a special prompt that helps users define clear goals. The assistant calls `propose_goal` (and other `propose_*` tools) to emit structured proposals as tool calls, which persist in message history and can be reopened via an "Open proposal" button. A deprecated XML fallback (`proposal-parsers.ts`) still parses legacy `<goal_proposal>` blocks for backward compatibility.
- **Cross-project proposals**: Every `propose_*` tool takes an optional `projectId`. Omitted, it targets the session's own project (unchanged default); supplied, the proposal is seeded, validated, and accepted against the target project — the panel shows a "Proposing into &lt;Target Project&gt;" banner when target ≠ proposer. The primary use case is Headquarters agents proposing into real projects. No permission gating. See [cross-project-proposals.md](cross-project-proposals.md).
- **Auto-transition**: Goals move from `todo` to `in-progress` when their first session starts.
- **Worktrees**: Goals can optionally create a dedicated git worktree for isolated work. After creating the worktree, Bobbit runs the `worktree_setup_command` from `.bobbit/config/project.yaml` to install dependencies (if configured). No setup runs by default — you must explicitly configure it for your project's package manager. Headquarters also supports explicit data-only goals with `worktree: false`; git/branch/PR endpoints are guarded with `GOAL_GIT_UNAVAILABLE` when no worktree exists.
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
- **Nested Claude-plugin layout**: A scan directory can point at a Claude plugin tree, where skills nest one level deeper than the normal `<dir>/<name>/SKILL.md`. `scanSkillDir` additionally discovers, for each scanned directory: a plugins-parent root (`<dir>/<plugin>/skills/<name>/SKILL.md`, e.g. pointing at `~/.claude/plugins`) and a single plugin root (`<dir>/skills/<name>/SKILL.md`). This is why: pointing a custom directory at a plugin root or `~/.claude/plugins` used to resolve zero skills. Discovery is bounded to the `skills/` convention — no arbitrary deep recursion — and the normal one-level `.claude/skills` behaviour is unchanged (a dir literally named `skills` that holds a top-level `SKILL.md` is still treated as a normal one-level skill).
- **Custom directories**: Configure via Settings → Config Directories tab (`#/settings`, Directories tab), via the Skills page's directory editor, or by setting `config_directories` in project config. The legacy `skill_directories` key is still read for backward compatibility but `config_directories` is preferred. Custom directories are additive — defaults always scan. Skills from custom dirs get source `"custom"` with lower priority than built-in directories. The Skills page's editor manages **skills-only** directories (a `config_directories` entry whose `types` is exactly `["skills"]`, plus legacy `skill_directories`); multi-type directories (e.g. `{skills, mcp}`) are shown read-only and stay managed on the Settings page so the Skills page never downgrades them.
- **Skills page ↔ composer consistency**: The Skills page (`#/skills`) and the composer's `/` autocomplete resolve skills through the same `discoverSlashSkills` pipeline, but historically passed different scope parameters — the page defaulted to the Headquarters/system scope while the composer used the session's own project — so a skill could appear on the page yet be missing from a project session's `/` menu (or vice-versa), and the mismatch survived a hard refresh. The Skills page now defaults its config scope to the **currently-active project** and follows the active project as it changes, until the user explicitly picks a scope via the scope selector. On a hard refresh or deep-link to `#/skills`, the active project is derived from the last-connected session. **Invariant**: for a given project (with that project's scope selected on the page), the skills listed on the Skills page are the identical set offered by that project's session composer autocomplete. The page's custom-directory editor reads and writes the same scope-appropriate config store that resolves that scope's skills (`/api/projects/:id/config` for a project, `/api/project-config` for Headquarters), so what you edit is what sessions resolve.
- **Invocation**: Via `/skill-name` slash commands in the chat input. Skills can be invoked as a prefix (`/deploy staging`) or inline within a prompt (`Analyse using /my-skill the code`). The server resolves all `/skill-name` tokens at word boundaries and expands them inline. The autocomplete menu triggers at any `/` preceded by whitespace or at position 0, and anchors visually to the `/` character's position.
- **Frontmatter**: YAML frontmatter supports `description`, `argument_hint`, `allowed_tools`, `context` (e.g. `fork`), `agent`, `disable_model_invocation`, and `user_invocable`.
- **Autonomous activation**: Each session's system prompt embeds an "Available Skills" catalog (name + description + arg hint per skill) so the agent can invoke `activate_skill` mid-turn without the user typing `/name`. Skills with `disable_model_invocation: true` are omitted from the catalog.
- **Catalog budget**: The catalog is capped in bytes to keep the system prompt small. Default is **16 KB**; configurable per-user via Settings → General → "Skills catalog budget" within **1–128 KB**. The preference is stored as `skillsCatalogBudget` (bytes) via `PUT /api/preferences`; absent or `null` falls back to the default. When skills exceed the budget, the list is sorted alphabetically by name and the tail is dropped with a `_… (N more skills omitted, alphabetically truncated)_` footer so the agent knows more exist (it can still invoke them by name). A `[system-prompt] Skills catalog exceeded <budget>B budget — truncated N skill(s).` warning is logged. Tuning bounds are enforced server-side in `resolveSkillsCatalogBudget` (`src/server/agent/system-prompt.ts`) and mirrored by the Settings input.
- **API**: `GET /api/slash-skills` for autocomplete data (composer), `GET /api/slash-skills/details` for full content, file paths, and scanned directories (Skills page). Both take a `?projectId=` (and, for autocomplete, `?cwd=`) and resolve against that project's config store — passing the same project to both yields the same skill set.

## File References (`@`-mentions)

Type `@` in the prompt composer to reference a file by path, mirroring the `/` slash-skill menu. On send, only existing filesystem targets outside Markdown fenced code, matched inline backtick spans, four-space/tab-indented code, and nested container code become references. Code-contained and genuinely missing tokens remain byte-for-byte literal with no warning, metadata, attachment, or chip. Existing targets that fail later access, containment, symlink, type, size, count, aggregate, stat, read, or race checks remain literal but render an unresolved chip and warning.

Readable text is snapshotted into `<file-reference>` blocks; images use `images[]`; other binaries become document attachments for snapshot and chip parity (the current agent prompt RPC forwards text and images, not document bytes). Snapshots, punctuation boundaries, and UTF-16 chip ranges persist through reload via the shared sidecar. Whole-send admission is atomic at 8 MiB of authenticated UTF-8 prompt text, 8,192 non-code candidates, and 4,096 distinct targets; these bounds are separate from delivery limits. Backed by `GET /api/file-mentions`. See [at-mention-file-references.md](at-mention-file-references.md) for complete behavior, limits, path safety, cancellation, and ordering guarantees.

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
- Queue pills show drag handle, edit (pencil), steer, and remove buttons. Steered pills that remain queued show a "Sent" badge; rows promoted while streaming are removed from the queue as they dispatch.
- Steered messages are batched — they reorder to the front of the queue and are delivered as a single combined prompt. Streaming `steer_queued` promotions dispatch immediately through `_dispatchSteer()`; idle or recovered steered rows drain first when the agent becomes idle.
- `follow_up` flag is preserved through the queue: messages enqueued with `isFollowUp: true` dispatch via `followUp()` RPC on drain.
- Queue state broadcast to clients via `queue_update` events.

See [prompt-queue.md](prompt-queue.md) for the full architecture.

## Workflows

Workflows define the gates a goal must pass, their dependency relationships (a DAG), quality criteria, and verification configs. Workflows are **project-scoped only** — they live inline in `project.yaml::workflows` and are designed by the project assistant from the project's actual components and commands. There is no builtin or system-scope layer, and the server does not auto-seed defaults on project creation. Headquarters can own workflows through its aliased server `project.yaml`, but they are still addressed with `projectId=headquarters`. Snapshotted into goals at creation (frozen). See [goals-workflows-tasks.md](goals-workflows-tasks.md), [headquarters.md](headquarters.md), and [internals.md — No default workflow scaffold](internals.md#no-default-workflow-scaffold).

## Git status rich diff viewer

The Git status widget's diff modal renders raw session/goal `git-diff` responses with `<rich-git-diff-viewer>`. Users get collapsible per-file sections, rename paths, `+/-` counts, split/inline controls, folded context expansion, truncation warnings, and accessible modal controls without changing the raw `{ diff }` endpoint contract. The parser seam is framework-neutral under `src/shared/git-diff/unified.ts`; the PR Walkthrough pack remains separate and may only share `src/shared/**` modules, not core UI. See [git-status-diff-viewer.md](git-status-diff-viewer.md) for behavior, integration, boundaries, and tests.

## PR Walkthrough Panel

The PR walkthrough panel is a guided pull-request or changeset review surface. It ships as a **built-in first-party pack** (`market-packs/pr-walkthrough/`) that is listed from the built-in source with no manual install; current builds ship it default-disabled until enabled from Market. The pack owns the viewer surfaces and the reviewer tools under `tools/pr-walkthrough/`; `pack.yaml` advertises the `pr-walkthrough` tool group, and Market expands it into concrete tool toggles. Two pack launchers (composer-slash / session menu) do the **same** thing on click: they call the pack's `run` route, which mints a **separate, isolated, read-only reviewer child** (`host.agents.spawn`, role `pr-reviewer`, `title: "PR Walkthrough"`) — it never drives the user's current agent — and then **auto-switch the view to that child session**, opening the panel there. There is **no owner-session panel** and **no manual "Run PR walkthrough" / "Load walkthrough" buttons**. A no-PR / spawn failure surfaces through visible launcher feedback from the session menu, spawning nothing and not switching the view; every click is a fresh reviewer (no dedup). The reviewer publishes cards only through validated `submit_pr_walkthrough_yaml`, and on submit it is **not** dismissed — it stays live and selectable until the user terminates it. The run path is GitHub-PR-only. Disabling the pack from the Market built-in section makes the feature unavailable (the deep-link degrades to an empty state). See [pr-walkthrough-panel.md](pr-walkthrough-panel.md) for the full behaviour and testing contract, [pr-walkthrough-launch-ux.md](design/pr-walkthrough-launch-ux.md) for the launch model, and [built-in-first-party-packs.md](design/built-in-first-party-packs.md) for the pack model.

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

Each session's system prompt is assembled from a fixed set of ordered sections (numbered below), including optional spawn-time provider context from `sessionSetup`. Sections are separated by `\n\n---\n\n` and written to `.bobbit/state/session-prompts/{sessionId}.md` at spawn time. Per-turn `beforePrompt` Dynamic Context is delivered separately as hidden `bobbit:dynamic-context` custom/user-side messages, not as a system-prompt tail.

The sections are ordered so that the **stable prefix** (sections 1–5, which are deterministic functions of the project and allowed tools) comes before the **volatile suffix** (sections 6–9, which vary per goal/task/session). This ordering lets provider prompt caches (Anthropic ephemeral, OpenAI prompt cache) reuse the tool docs and skills catalog across team spawns and between turns, because the cache key only invalidates at the first changed byte.

| # | Section | Volatile? | Source |
|---|---------|-----------|--------|
| 1 | **Global system prompt** | No | `.bobbit/config/system-prompt.md` (user customised) or `defaults/system-prompt.md`. Resolved by `resolveSystemPromptPath()`. See [internals.md — Config cascade](internals.md#config-cascade). |
| 2 | **AGENTS.md / project docs** | No | From the registered project root and configured `agents` files, with `@FILENAME.md` inline inclusion (recursive, circular-reference safe). Falls back to the session working directory only when no project root/config store is available. |
| 3 | **Working directory** | No | Injected `# Working Directory` block with the session's `cwd`. |
| 4 | **Tool documentation** | No | Assembled from `defaults/tools/<group>/` (project overrides under `.bobbit/config/tools/<group>/`). |
| 5 | **Available Skills catalog** | No | Built from the list of skills in scope for the session. |
| 6 | **Goal + Role** | Yes | Goal spec and/or role prompt; combined under a single `# Goal` heading. |
| 7 | **Current Task** | Yes | Task title, type, spec, and dependency list. Omitted when no task is assigned. |
| 8 | **Workflow upstream-gate context** | Yes | Passed gate content injected for context. Omitted when not in a workflow. |
| 9 | **Dynamic Context** | Yes | Provider-supplied ambient context from the `sessionSetup` lifecycle hook, fenced in `<context-block>` envelopes. Appended last (freshest, lowest-authority). Omitted unless an active provider contributes blocks. See [lifecycle-hub.md](lifecycle-hub.md#session-setup-wiring-g13). |

Implementation: `src/server/agent/system-prompt.ts::_assembleSystemPrompt`. The inspector UI uses `getPromptSections()` (same file) to show labeled sections in the same order. Section 9 is appended after section 8 by the `sessionSetup` provider wiring (Extension Platform G1.3); when no provider contributes, it is absent and the prompt is byte-identical to the 1–8 layout. The same inspector section is refreshed best-effort for per-turn `beforePrompt` blocks, but those blocks reach the model through the hidden custom-message channel so provider cached system-prompt bytes stay stable across turns.

Prompt files and prompt-section JSON snapshots are scoped to the owning gateway's `stateDir`. The production path still initializes one `session-prompts/` directory at startup, but tests and embedded gateways pass the explicit `stateDir` through prompt assembly, prompt-section persistence/load, purge, and cleanup. That dependency-injection seam prevents multiple in-process gateways in one test worker from writing inspector data to the wrong gateway's state directory while preserving the single-gateway behaviour and archive-purge lifecycle.

Bobbit, not pi-coding-agent, owns project instruction assembly. `src/server/agent/rpc-bridge.ts::buildAgentArgs()` always launches pi with `--no-context-files` and strips caller-supplied context-file flags before appending custom args. This prevents pi's built-in upward discovery from adding parent-directory `AGENTS.md` / `CLAUDE.md` files to the runtime `systemPrompt` or `before_agent_start` hook events. The registered project's configured agent files still appear once through Bobbit's `Project AGENTS.md` section, and provider-bridge `beforePrompt` context remains unchanged: per-turn blocks are delivered as hidden `bobbit:dynamic-context` custom/user-side messages, not by mutating `systemPrompt`.

## Reconnection

`RemoteAgent` auto-reconnects on unexpected disconnects with exponential backoff (1s base, 30s max). On reconnect: re-authenticates, requests current messages and state, server replays the latest `tool_execution_update` per tool call ID from the `EventBuffer`.

## Task Completion Notifications

When the agent finishes a turn, the browser client notifies the user via:
1. **Browser Notification API** — Shows session title and elapsed time
2. **Title flash** — Alternates document title with "Done (Xm)" until tab regains focus
3. **Audio beep** — Two-tone sine wave (880 Hz, 1046 Hz) via Web Audio API
4. **Favicon badge + sidebar unread dot** — Persists until the user opens the session

These cues are scoped to **human attention**: standalone sessions notify on idle (as before), team members and delegates stay silent (they escalate to their team lead, not the user), and a team lead notifies when the goal is `complete`, needs immediate human action, or is persistently stuck. One-shot beeps do not fire merely because a team lead went idle to wait for workers or verification. Notification surfaces consult the predicates in `src/app/notification-policy.ts`. See [design/notification-policy.md](design/notification-policy.md).

## Model routing and authentication

Bobbit can source models from built-in providers, local custom providers, or one configured AI Gateway. AI Gateway discovery is well-known-first so each upstream retains its native Responses, Bedrock Converse, or chat-completions route; the legacy model-list path remains available for older gateways. See [AI Gateway routing](ai-gateway-routing.md) for setup, operator controls, security boundaries, model-ID migration, and refresh behavior.

Models become usable either through the configured AI Gateway, via an **account OAuth login** (Settings → Account), or with a **provider API key** (Settings → Models → Provider API Keys). OAuth credentials are provider-partitioned in `auth.json` and are propagated into agent sandboxes through the same sanitized path for every provider. Text-session model fallback is opt-in via `allowSessionModelFallback`; see [Controlled session model fallback](session-model-fallback.md).

- **Anthropic** and **OpenAI** account login work as before.
- **Google** has two intentionally separate paths: account OAuth (`google-gemini-cli`, via the official Gemini Code Assist API) and a Google AI Studio API key (`google`, Gemini Developer API). Both are session-usable: account-backed Gemini models run in agent sessions through a generated Code Assist provider extension (per-request Bearer token + project from the gateway), while the API key remains an independent path. See [google-oauth-models.md](google-oauth-models.md) for the full split, runtime architecture, project selection, and caveats.
