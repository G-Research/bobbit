# The `bobbit` gateway tool group

The `bobbit` tool group is a curated, tiered wrapper over the Bobbit gateway
REST API. It lets an agent drive the gateway — inspect goals and sessions,
mutate runtime state, or perform admin/maintenance — **without hand-rolling
`curl`, hunting for the auth token, or resolving the gateway URL**. The
extension resolves credentials and the base URL once and exposes a small set of
`operation`-dispatched tools that return the gateway's JSON.

**Why it exists.** Before this tool, an orchestration agent that needed to act
across goals/projects had two bad options: hand-write `curl -sk` calls (reading
`.bobbit/state/token` + `.bobbit/state/gateway-url` itself, guessing paths and
bodies), or lean on the narrow goal-scoped tools (`task_*`, `gate_*`, `team_*`)
that only address the *current* goal. The `bobbit` group fills the gap: an
ergonomic, gateway-wide surface addressed by explicit id, with auth and
error-shaping handled for you.

See the design doc [`docs/design/bobbit-gateway-tool.md`](design/bobbit-gateway-tool.md)
for full endpoint mappings (§5) and the rationale behind every resolved
decision. This page is the user-facing reference.

## The three tiers

The group is split into three tools by privilege, each with its own tool
`group` so tool-group policies can grant/deny each tier independently. "Create a
session" is a higher-risk action than "list goals", and "mutate config /
destroy worktrees" is higher-risk still — separate groups let a user grant read
broadly, gate orchestration behind confirmation, and keep admin locked down.

All three tools share a single `Bobbit` tool-group; tier separation is
enforced purely by each tool's `grantPolicy`.

| Tool | Group | Default `grantPolicy` | Scope |
|---|---|---|---|
| `bobbit_read` | `Bobbit` | `allow` | Read-only introspection (GET; no side effects) |
| `bobbit_orchestrate` | `Bobbit` | `never` | Runtime state mutations (goals/sessions/tasks/gates/staff/team lifecycle) |
| `bobbit_admin` | `Bobbit` | `never` | Config + destructive maintenance (highest privilege) |

### What `never` means and how to enable a tier

`grantPolicy: never` does **not** mean the tool is absent. The tool is
registered (it appears in `GET /api/tools`) but **hidden from the agent's
toolset** until a role, project, or user tool-group policy explicitly enables
its group. This is deliberately more conservative than `deny` (which would show
the tool and refuse at call time): high-privilege surfaces should never even
appear unless someone opted in. The pattern mirrors
[`defaults/tools/agent/session_prompt.yaml`](../defaults/tools/agent/session_prompt.yaml),
which is `grantPolicy: never` for the same reason.

To enable `bobbit_orchestrate` or `bobbit_admin` for a session, do one of:

- **Tool-group policy** — set the policy for the `Bobbit` group to `allow` (or
  `ask`, for confirm-on-use) at the desired scope: `PUT
  /api/tool-group-policies/Bobbit`. Read current policies via `GET
  /api/tool-group-policies`.
- **Role allowlist** — a role definition can enable the group through its
  `tools` allowlist or `toolPolicies`.

Because all three tiers now live in the single `Bobbit` group, a group-level
`allow` reveals every tier whose own `grantPolicy` is not `never`. `bobbit_read`
(`grantPolicy: allow`) is visible by default; `bobbit_orchestrate` and
`bobbit_admin` stay hidden until the group is enabled *and* their `never`
default is overridden (e.g. a role that lists the tool explicitly). Grouping
them together means the group policy can no longer gate the tiers independently
— that separation now rests entirely on the per-tool `grantPolicy`.

## Registration model

`bobbit` is a **normal built-in tool group**, auto-discovered the same way
`web` and `browser` are — dropping the `defaults/tools/bobbit/` directory (its
three YAMLs + `extension.ts`) is sufficient for the runtime to pick it up. There
is **no HQ/orchestration gating and no dependency on `BOBBIT_GOAL_ID`**; tier
access is controlled purely by `grantPolicy` plus any tool-group policy.

The extension registers its tools **whenever gateway credentials resolve**:

1. Environment: `BOBBIT_TOKEN` + `BOBBIT_GATEWAY_URL`.
2. Otherwise state files under `<BOBBIT_DIR>/state/`: `token` + `gateway-url`.

If neither source yields credentials, the extension logs
`[bobbit-tools] Cannot read gateway credentials — tools not registered` and
registers nothing (it does not throw) — matching the behaviour of the existing
`tasks`/`gates` extensions.

## Operation catalogue

Each tool takes an `operation` discriminator plus operation-specific params and
returns the gateway's JSON. Summaries follow; for full endpoint mappings,
methods, and body keys see each tool's `detail_docs` and
[`docs/design/bobbit-gateway-tool.md` §5](design/bobbit-gateway-tool.md).

### `bobbit_read` — read-only introspection

All operations are GETs with no side effects.

- `health`, `connection_info` — gateway liveness + network info.
- `list_goals` (`archived`, `q`), `get_goal` — enumerate / fetch goals.
- `goal_cost`, `goal_git_status`, `goal_commits`, `goal_pr_status` — per-goal
  cost, git, commit, and PR details.
- `list_sessions` (`include=archived`, `q`, `projectId`), `get_session`,
  `session_cost` — enumerate / fetch sessions and their cost.
- `search` — full-text search across goals/sessions/messages/staff.
- `list_projects`, `get_project` — project registry.
- `list_workflows`, `get_workflow` — workflow templates (pass `projectId`;
  `list_workflows` returns an empty list without it — the call does not error).
- `list_roles`, `list_tools` — resolved roles and the tool catalogue.
- `list_gates`, `list_tasks` (by arbitrary `goalId`), `get_task` — cross-goal
  gate/task boards.
- `list_staff`, `list_mcp_servers` — staff agents and MCP servers.
- `maintenance_inspect` (`probe=`) — the GET-only maintenance probes (orphaned
  worktrees/sessions, expired archives, orphaned index rows, worktree/sandbox
  pools, search stats).

### `bobbit_orchestrate` — runtime state mutations

- `create_goal`, `update_goal`, `archive_goal` — goal lifecycle.
- `create_session`, `terminate_session`, `restart_session` — session lifecycle.
- `create_task`, `update_task`, `transition_task`, `assign_task` — task board.
- `signal_gate`, `reset_gate`, `cancel_verification` — workflow gates by id.
- `create_staff` — create a staff agent.
- `delete_staff` (`staffId`) — delete exactly one staff agent.
- `team_start`, `team_teardown` — goal-level team lifecycle by explicit `goalId`.

Notes:

- **`create_goal` and `create_session` require an explicit `projectId`** — there
  is no defaulting to `headquarters` or the system project.
- **`delete_staff` is single-resource only.** It requires `staffId`, validates
  that id before making a request, then dispatches through the same shared
  `bobbit_orchestrate` API helper to `DELETE /api/staff/:id`. Unknown ids return
  the backend not-found error. There is no bulk or wildcard staff delete.
- **`delete_goal` is intentionally absent.** There is no hard-delete goal
  endpoint; `archive_goal` (`DELETE /api/goals/:id`) archives with cascade
  semantics. Delete = archive.
- `team_start` returns `400 SPEC_REQUIRED` if the goal has no spec;
  `team_teardown` with `cascade=false` returns `409 HAS_DESCENDANT_TEAMS` when
  live descendants exist.

### `bobbit_admin` — config + destructive maintenance

- `update_project_config` — merge project config key/values.
- `set_provider_key`, `delete_provider_key`, `custom_providers`,
  `aigw_configure` — provider credentials and AI-gateway wiring.
- `marketplace_install`, `marketplace_update`, `marketplace_uninstall` — pack
  management.
- `tool_override`, `role_override`, `workflow_override` — create scope overrides
  via the `*/customize` endpoints (removing an override is not exposed here).
- `maintenance_cleanup` (`action=`) — **destructive**: delete worktrees, purge
  archives, clean index rows, rebuild/compact the search index.
- `sandbox_image_build` — build the sandbox image (409 if a build is already in
  progress).
- `system_prompt_customise` — customise the system prompt.
- `harness_restart`, `shutdown` — restart or stop the gateway.

These operations mutate config or destroy state, which is why the tier defaults
to `grantPolicy: never`.

## Overlap policy — bobbit does not replace the dedicated tools

`bobbit` is **gateway-wide and addresses entities by explicit id**. It is
*additive* to the existing goal-scoped tools, not a replacement. Reach for the
dedicated tool when it applies:

- **Transcript reads** → use **`read_session`**. `bobbit_read` does not expose
  `/api/sessions/:id/transcript`.
- **Prompting / steering sessions** → use **`session_prompt`**,
  **`team_prompt`**, or **`team_steer`**. `bobbit_orchestrate` does not
  re-implement these; delegate creation uses **`team_delegate`**, not
  `create_session`.
- **The current goal's task/gate board** → use **`task_*`** / **`gate_signal`**
  / **`verification_result`** and the current-goal **`task_list`** /
  **`gate_list`**. The `bobbit` `list_tasks`/`list_gates`/task-mutation ops take
  an *arbitrary* `goalId` for cross-goal work.
- **The current goal's team** → use **`team_spawn`**, **`team_dismiss`**,
  **`team_complete`**, **`team_abort`**. `bobbit_orchestrate` only exposes
  `team_start` / `team_teardown` keyed by explicit `goalId`.

Internal / UI-only endpoints (side-panel workspace, review annotations, preview
mounts, `ext/*` pack surfaces, provider-hooks, proposal drafts, bg-processes)
are deliberately out of scope.

## Auth: direct vs sandboxed agents (interim rollback)

The token an agent presents to the gateway depends on where it runs:

- **Non-sandboxed ("direct") agents** run directly on the host as the host user
  and receive the gateway **admin token** as `BOBBIT_TOKEN`. This is a
  deliberate **interim rollback** to the pre-HQ-split behaviour: a host-resident
  agent can already read the admin token off disk (`serverSecretsDir()/token`),
  so handing it over grants no new capability — it just removes the functional
  friction where direct agents used to 403 with *"sandbox token cannot access
  this endpoint"* on gateway-wide routes (`bobbit_read`/`bobbit_orchestrate`/
  `bobbit_admin`, cross-project `read_session`). Wired in
  `SessionManager.scopedGatewayEnvForDirectAgent` / `applyScopedGatewayCredentials`.
- **Sandboxed (Docker) agents** are unchanged: they receive a per-project
  **scoped token** (`SandboxTokenStore` + `mintScopedGatewayToken`) confined by
  the `isSandboxAllowed()` route whitelist. The admin token is never injected
  into the container. This is a real security boundary and must stay.

This direct-agent admin-token behaviour is a stop-gap. The longer-term
direction is a policy-driven, session-authenticated model where the tool's
grant policy is the authority and the admin token never leaves the server
(specced separately).

## Result and error shape

- **Success** — the tool returns the gateway's JSON verbatim.
- **204 No Content** (e.g. marketplace uninstall) — returns `{ ok: true }`.
- **Failure** — the gateway's structured `{ error, code }` body is surfaced as a
  single readable error line that includes the human message, the machine
  `code` (when present), and the HTTP status. A missing required param is caught
  client-side before any request is made, with a clear "operation X requires
  param Y" message.

## See also

The built-in [Support Assistant](support-assistant.md) is the primary consumer
of this tool group: it uses `bobbit_read` to inspect state and, after explicit
user confirmation, `bobbit_orchestrate` / `bobbit_admin` to apply changes on the
user's behalf.
