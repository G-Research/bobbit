# REST API

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
| `GET` | `/api/sessions/:id/pr-status` | PR status for session's branch (via `gh pr view`) |
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
| `GET` | `/api/goals/:id/pr-status` | PR status for goal branch (cached, via `gh pr view`) |
| `POST` | `/api/goals/:id/pr-merge` | Merge PR for goal branch (`{ method? }`) |

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

### Slash Skills

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/slash-skills` | Discover slash skills for autocomplete (name, description, argument hint) |
| `GET` | `/api/slash-skills/details` | Full slash skill details including content and file paths |

### Assistant Prompts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/roles/assistant/prompts` | List all assistant prompt definitions |
| `PUT` | `/api/roles/assistant/prompts/:type` | Update an assistant prompt (goal, role, tool, personality, staff, setup) |

### Staff Agents

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/staff` | List all staff agent definitions |
| `POST` | `/api/staff` | Create a staff agent (`{ name, description, triggers, skillId?, prompt? }`) |
| `POST` | `/api/staff/:id/wake` | Manually trigger a staff agent's wake cycle |

### Project Config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/project-config` | Get project settings (build/test/typecheck commands, custom config) |
| `GET` | `/api/project-config/defaults` | Get default project config values |
| `PUT` | `/api/project-config` | Update project config fields |

### Setup

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/setup-status` | Check if project setup wizard has been completed |
| `POST` | `/api/setup-status/dismiss` | Mark setup wizard as dismissed |

### Config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config/cwd` | Get the server's working directory |
| `PUT` | `/api/config/cwd` | Update the server's working directory |

### PR Status

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pr-status-cache` | Bulk PR status from disk cache (startup hydration) |

### System

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/shutdown` | Graceful server shutdown (used by coverage teardown) |

### Workflows

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows` | List all workflow templates |
| `GET` | `/api/workflows/:id` | Get full workflow detail |
| `POST` | `/api/workflows` | Create a workflow |
| `PUT` | `/api/workflows/:id` | Update a workflow |
| `DELETE` | `/api/workflows/:id` | Delete (blocked if in-use by active goals) |
| `POST` | `/api/workflows/:id/clone` | Deep-copy a workflow with a new ID |

### Preferences

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/preferences` | Get all preferences |
| `PUT` | `/api/preferences` | Merge preferences (set `null` to delete a key) |

### AI Gateway

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/aigw/status` | Check if AI gateway is configured, return available models |
| `POST` | `/api/aigw/configure` | Set AI gateway URL, discover models (`{ url }`) |
| `DELETE` | `/api/aigw/configure` | Remove AI gateway configuration |
| `POST` | `/api/aigw/test` | Test connection to a URL without saving (`{ url }`) |
| `POST` | `/api/aigw/refresh` | Re-discover models from configured gateway |
| `*` | `/api/aigw/v1/*` | Proxy requests to configured AI gateway |

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
