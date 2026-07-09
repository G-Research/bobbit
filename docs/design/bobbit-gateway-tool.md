# Design: `bobbit` gateway tool suite (three tiers)

Status: **design** · Goal: Bobbit Gateway Tool · Author: coder-cbeb

## 1. Overview & motivation

Agents that need to drive the Bobbit gateway across goals/projects currently
either hand-roll `curl -sk` (reading `.bobbit/state/token` +
`.bobbit/state/gateway-url` themselves) or lean on the narrow goal-scoped tools
(`task_*`, `gate_*`, `team_*`, `read_session`, `session_prompt`). There is no
ergonomic, gateway-wide surface.

This design adds a **`bobbit` tool group**: a thin, curated wrapper over the
gateway REST API exposed in `src/server/server.ts::handleApiRoute()`. It
encapsulates credential + base-URL resolution once and exposes a tiered,
operation-dispatched surface split into three tools by privilege:

- **`bobbit_read`** — read-only introspection (GET; no side effects).
- **`bobbit_orchestrate`** — runtime state mutations (POST/PUT/DELETE on
  goals/sessions/tasks/gates/staff/team lifecycle).
- **`bobbit_admin`** — config + destructive maintenance (highest privilege).

Each tool takes an `operation` discriminator plus operation-specific params
(validated with TypeBox), and returns the gateway's JSON verbatim, or a
structured error surfacing the gateway `{ error, code }` shape.

## 2. Resolved decisions (decided — do not re-litigate)

1. **Registration signal — NORMAL built-in tool group, NOT HQ-gated.** The
   extension registers its tools whenever gateway credentials resolve, exactly
   like `defaults/tools/web/extension.ts` and `defaults/tools/browser`. There is
   **no** dependency on `BOBBIT_GOAL_ID`, `BOBBIT_STAFF_ID`, or any
   Headquarters/orchestration signal. Tier access is controlled **purely** by
   each tool's `grantPolicy` in the YAML (plus any role/project/user tool-group
   policy). If credentials cannot resolve, the extension logs and returns
   (registers nothing) — matching existing extensions.

   > **Authoritative amendment (supersedes the original spec).** The goal spec
   > as originally written said "Default availability: Headquarters /
   > orchestration sessions only" and listed the exact registration signal as an
   > open question. The **goal owner explicitly directed in-session** that this
   > be reframed: *"Just make it a normal built in tool."* That directive is
   > authoritative and resolves the open question — bobbit is a normal built-in
   > group and `bobbit_read` defaults to `grantPolicy: allow` (available to all
   > sessions). This is an owner-approved decision, **not** an unresolved
   > deviation. The higher-risk tiers remain protected by `grantPolicy: never`.
   > (The spec text could not be edited from the team-lead session — the scoped
   > token is forbidden from `PUT /api/goals/:id` — so the amendment is recorded
   > here as the authoritative source.)

2. **`projectId` required for creation.**
   `bobbit_orchestrate.create_session` and `bobbit_orchestrate.create_goal`
   MUST require an explicit `projectId` param. No defaulting to `headquarters`
   or the system project. (The gateway itself enforces project resolution; the
   tool surfaces `projectId` as required so the failure is caught client-side
   with a clear message.)

3. **Default per-tier `grantPolicy`:**
   - `bobbit_read` → `allow`
   - `bobbit_orchestrate` → `never`
   - `bobbit_admin` → `never`

   `never` = registered but hidden unless a role/project/user policy explicitly
   enables the tool (same mechanism `defaults/tools/agent/session_prompt.yaml`
   uses). The spec framed the options as "allow / ask / deny"; we deliberately
   chose **`never`** rather than `deny` for the two higher tiers because `never`
   hides the tool entirely (it never appears in the agent's toolset) rather than
   showing it and refusing at call time — the correct default for high-privilege
   surfaces, matching the `session_prompt` precedent. `ask` remains available
   for users who want a confirm-on-use tier.

4. **`delete_goal` dropped (DECIDED).** There is no hard-delete goal endpoint
   — `DELETE /api/goals/:id` archives (with cascade). The design exposes only
   `archive_goal`; `delete_goal` is NOT a separate operation and `detail_docs`
   documents "delete = archive". This formally resolves the spec's `delete_goal`
   entry rather than leaving the choice to the implementer.

## 3. File layout

```
defaults/tools/bobbit/
  extension.ts             # single ExtensionFactory; registers all 3 tools
  bobbit_read.yaml         # group: BobbitRead,        grantPolicy: allow
  bobbit_orchestrate.yaml  # group: BobbitOrchestrate, grantPolicy: never
  bobbit_admin.yaml        # group: BobbitAdmin,        grantPolicy: never
```

- **`extension.ts`** — one default-export `ExtensionFactory`. Resolves
  credentials once (§4.1), defines the shared `api()` helper + `ok()`/`err()`
  wrappers (§4.2), then calls `pi.registerTool(...)` three times — one per tool.
  Each `execute` switches on `operation` and dispatches to a per-operation
  handler. If creds don't resolve, it logs `[bobbit-tools] Cannot read gateway
  credentials — tools not registered` and returns.
- **`bobbit_read.yaml` / `bobbit_orchestrate.yaml` / `bobbit_admin.yaml`** —
  YAML manifests following the tasks/team/agent conventions (§6). Each carries
  `name`, `description` (≤150 chars), `summary`, `params`, `provider`
  (`type: bobbit-extension`, `extension: extension.ts`), `group`, `grantPolicy`,
  `docs`, and `detail_docs`. The operation catalogue for each tier lives in
  `detail_docs` (it cannot live in the `operation` param description — see §9
  budget constraint).

## 4. Shared extension internals

### 4.1 Credential / URL resolution (reuse from `tasks/extension.ts` verbatim)

Copy the exact pattern at the top of `defaults/tools/tasks/extension.ts`, minus
the `sessionId`/`goalId` gate:

```ts
let token: string;
let baseUrl: string;
const envToken = process.env.BOBBIT_TOKEN;
const envUrl = process.env.BOBBIT_GATEWAY_URL;
if (envToken && envUrl) {
  token = envToken;
  baseUrl = envUrl.replace(/\/+$/, "");
} else {
  try {
    const stateDir = process.env.BOBBIT_DIR
      ? path.join(process.env.BOBBIT_DIR, "state")
      : path.join(homedir(), ".pi");
    const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
    const urlFile = "gateway-url";
    token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
    baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
  } catch {
    console.error("[bobbit-tools] Cannot read gateway credentials — tools not registered");
    return;
  }
}
```

**Difference from tasks:** do NOT read or require `BOBBIT_SESSION_ID` /
`BOBBIT_GOAL_ID`. The tasks extension early-returns when those are absent; the
bobbit extension must NOT — it registers purely on credential availability.

Node's in-process `fetch` already targets the loopback gateway over its
self-signed TLS in the existing extensions (tasks/gates), so no
`rejectUnauthorized: false` / custom agent is needed.

### 4.2 HTTP helper + result wrappers (reuse from `tasks/extension.ts`)

```ts
async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  const resp = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!resp.ok) {
    // Surface the gateway's structured { error, code } shape (see §4.3).
    const structured = (typeof data === "object" && data !== null) ? data as Record<string, unknown> : undefined;
    const msg = structured && "error" in structured
      ? `${structured.error}${structured.code ? ` [${structured.code}]` : ""} (HTTP ${resp.status})`
      : `HTTP ${resp.status}: ${text}`;
    throw new ApiError(msg, resp.status, structured?.code as string | undefined);
  }
  return data;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: undefined };
}
function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
}
```

### 4.3 Structured error surfacing

The gateway responds to failures with `json({ error, code? }, status)` (see
e.g. `CASCADE_REQUIRED`, `SPEC_REQUIRED`, `PARENT_CROSS_PROJECT`,
`GOAL_PAUSED`, `HAS_DESCENDANT_TEAMS`). Define a small `ApiError` (extends
`Error`, carries `status` + `code`) so the `execute` catch can render a single
readable line via `err(...)` that includes both the human message and the
machine `code`. 204 No Content responses (e.g. marketplace uninstall) return an
empty body — `api()` should treat that as `ok({ ok: true, status: 204 })`.

### 4.4 Per-tool operation dispatch + validation

**Problem:** each tool has a single `parameters` schema, but each operation
takes different params. A full TypeBox discriminated union over dozens of
operations would (a) blow the param-description budget and (b) be unwieldy.

**Chosen approach — thin outer schema + per-operation validation map:**

- The tool's `parameters` is a small `Type.Object` with:
  - `operation: Type.Union([Type.Literal("health"), Type.Literal("list_goals"), …])`
    — the literal union of that tool's operations (no per-op description text;
    the catalogue is in `detail_docs`).
  - A flat set of `Type.Optional(...)` shared params covering the union of
    fields the operations use (e.g. `goalId?`, `sessionId?`, `taskId?`,
    `projectId?`, `gateId?`, `q?`, `archived?`, `include?`, `body?`). Common
    scalar ids are first-class optional fields; free-form request bodies for the
    richer POST/PUT operations are passed via a single
    `body?: Type.Optional(Type.Record(Type.String(), Type.Unknown()))` (or
    `Type.Any()`), documented per-operation in `detail_docs`.
- Inside `execute`, a `const OPS: Record<string, OpSpec>` map keyed by operation
  name holds `{ method, buildPath(params), buildBody?(params), required: string[] }`.
  The dispatcher:
  1. Looks up `OPS[params.operation]`; unknown → `err("unknown operation …")`.
  2. Validates each `required` field is present and non-empty; missing →
     `err("operation X requires param Y")`. (Lightweight runtime checks — the
     TypeBox schema only guarantees the `operation` literal + types of the
     shared optional fields; per-op requiredness is enforced here.)
  3. Calls `api(spec.method, spec.buildPath(params), spec.buildBody?.(params))`.

This keeps the on-wire schema tiny (budget-safe) while giving the implementer a
single declarative table per tool. The `OpSpec` table IS the operation
catalogue in code; the YAML `detail_docs` mirror it for the agent.

`ApiError` and the shared `api`/`ok`/`err`/`OpSpec` types live once at module
scope and are closed over by all three `registerTool` calls.

## 5. Operation catalogue

All paths are verified against `src/server/server.ts` line references (2026-07
`handleApiRoute()`). `:x` = path segment from a param. Query params are shown
as `?k=`. "Body" lists the JSON body keys the handler reads.

### 5.1 `bobbit_read` (group `BobbitRead`, all GET)

| operation | method | path | required | optional |
|---|---|---|---|---|
| `health` | GET | `/api/health` | — | — |
| `connection_info` | GET | `/api/connection-info` | — | — |
| `list_goals` | GET | `/api/goals` | — | `archived` (`?archived=true`), `q` |
| `get_goal` | GET | `/api/goals/:goalId` | `goalId` | — |
| `goal_cost` | GET | `/api/goals/:goalId/cost` | `goalId` | — |
| `goal_git_status` | GET | `/api/goals/:goalId/git-status` | `goalId` | — |
| `goal_commits` | GET | `/api/goals/:goalId/commits` | `goalId` | — |
| `goal_pr_status` | GET | `/api/goals/:goalId/pr-status` | `goalId` | — |
| `list_sessions` | GET | `/api/sessions` | — | `include` (`?include=archived`), `q`, `projectId` |
| `get_session` | GET | `/api/sessions/:sessionId` | `sessionId` | — |
| `session_cost` | GET | `/api/sessions/:sessionId/cost` | `sessionId` | — |
| `search` | GET | `/api/search` | `q` | `type` (all\|goals\|sessions\|messages\|staff), `limit`, `offset`, `projectId` |
| `list_projects` | GET | `/api/projects` | — | — |
| `get_project` | GET | `/api/projects/:projectId` | `projectId` | — |
| `list_workflows` | GET | `/api/workflows` | `projectId` | — (empty list without projectId) |
| `get_workflow` | GET | `/api/workflows/:workflowId` | `workflowId` | `projectId` (`?projectId=`) |
| `list_roles` | GET | `/api/roles` | — | — |
| `list_tools` | GET | `/api/tools` | — | `projectId` (config scope) |
| `list_gates` | GET | `/api/goals/:goalId/gates` | `goalId` | `view` (`?view=summary`) |
| `list_tasks` | GET | `/api/goals/:goalId/tasks` | `goalId` | `view` (`?view=summary`) |
| `get_task` | GET | `/api/tasks/:taskId` | `taskId` | — |
| `list_staff` | GET | `/api/staff` | — | — |
| `list_mcp_servers` | GET | `/api/mcp-servers` | — | — |
| `maintenance_inspect` | GET | (see sub-probes) | `probe` | `projectId` |

**`maintenance_inspect`** takes a `probe` param selecting one GET-only probe:

| `probe` value | path |
|---|---|
| `orphaned_worktrees` | `/api/maintenance/orphaned-worktrees` |
| `orphaned_sessions` | `/api/maintenance/orphaned-sessions` |
| `expired_archives` | `/api/maintenance/expired-archives` |
| `orphaned_index_rows` | `/api/maintenance/orphaned-index-rows` (`?projectId=`) |
| `worktrees` | `/api/maintenance/worktrees` |
| `archived_session_worktrees` | `/api/maintenance/archived-session-worktrees` |
| `worktree_pool` | `/api/worktree-pool` |
| `sandbox_pool` | `/api/sandbox-pool` |
| `sandbox_status` | `/api/sandbox-status` |
| `search_stats` | `/api/search/stats` (`?projectId=`) |

> `list_workflows` returns an empty list when `projectId` is omitted (there is
> no server-scope workflow set). We mark `projectId` **required** at the tool
> layer for a useful result, but the call itself will not error without it.

### 5.2 `bobbit_orchestrate` (group `BobbitOrchestrate`)

| operation | method | path | required | optional / body |
|---|---|---|---|---|
| `create_goal` | POST | `/api/goals` | `projectId`, `title` | body: `spec`, `workflowId` (default `general`), `cwd`, `parentGoalId`, `sandboxed`, `autoStartTeam` (default true), `enabledOptionalSteps[]`, `metadata{}` |
| `update_goal` | PUT | `/api/goals/:goalId` | `goalId` | body: `title`, `spec`, `state`, `cwd`, `branch`, `repoPath`, `reattemptOf` |
| `archive_goal` | DELETE | `/api/goals/:goalId?cascade=true\|false` | `goalId`, `cascade` | `mergedManually` (`?mergedManually=`) |
| `create_session` | POST | `/api/sessions` | `projectId` | body: `goalId`, `assistantType`, `roleId`, `cwd`, `worktree`, `sandboxed`, `title`, `args`. (Delegate creation via `delegateOf`+`instructions` is intentionally NOT exposed — use `team_delegate`.) |
| `terminate_session` | DELETE | `/api/sessions/:sessionId` | `sessionId` | — |
| `restart_session` | POST | `/api/sessions/:sessionId/restart` | `sessionId` | — |
| `create_task` | POST | `/api/goals/:goalId/tasks` | `goalId`, `title`, `type` | body: `spec`, `dependsOn[]`, `parentTaskId`, `workflowGateId`, `inputGateIds[]` |
| `update_task` | PUT | `/api/tasks/:taskId` | `taskId` | body: `title`, `spec`, `resultSummary`, `headSha` |
| `transition_task` | POST | `/api/tasks/:taskId/transition` | `taskId`, `state` | — (state: todo\|in-progress\|blocked\|complete\|skipped) |
| `assign_task` | POST | `/api/tasks/:taskId/assign` | `taskId`, `sessionId` | — |
| `signal_gate` | POST | `/api/goals/:goalId/gates/:gateId/signal` | `goalId`, `gateId` | body: `sessionId`, `content`, `metadata{}` |
| `reset_gate` | POST | `/api/goals/:goalId/gates/:gateId/reset` | `goalId`, `gateId` | — |
| `cancel_verification` | POST | `/api/goals/:goalId/gates/:gateId/cancel-verification` | `goalId`, `gateId` | — |
| `create_staff` | POST | `/api/staff` | `name`, `systemPrompt` | body: `description`, `triggers`, `roleId`, `cwd`, `projectId` |
| `team_start` | POST | `/api/goals/:goalId/team/start` | `goalId` | — (requires goal spec set → 400 `SPEC_REQUIRED` otherwise) |
| `team_teardown` | POST | `/api/goals/:goalId/team/teardown?cascade=true\|false` | `goalId`, `cascade` | — (409 `HAS_DESCENDANT_TEAMS` when cascade=false + live descendants) |

**Notes / flags:**
- **`delete_goal` is dropped (decided — see §2.4).** `DELETE /api/goals/:id`
  archives with cascade semantics (see `archiveGoalEndpoint`); there is no
  hard-delete endpoint. Only `archive_goal` is exposed; `detail_docs` documents
  "delete = archive". The archive-child
  variant `DELETE /api/goals/:parentId/archive-child/:childId` exists but is
  parent-scoped/authz-specialised — **not** exposed here; use `archive_goal` on
  the child id directly.
- `create_session`: the delegate path (`delegateOf`+`instructions`) is
  deliberately excluded — that is what the `team_delegate` tool is for (§7).
- `team_start`/`team_teardown` overlap with the goal-scoped team lifecycle but
  are keyed by explicit `goalId` (gateway-wide) — additive, not a duplicate of
  `team_spawn`/`team_complete` (those act on the *current* goal). `team_spawn`,
  `team_dismiss`, `team_complete`, `team_abort`, `team_steer`, `team_prompt`
  are NOT re-exposed — use the dedicated `team_*` tools.

### 5.3 `bobbit_admin` (group `BobbitAdmin`)

| operation | method | path | required | optional / body |
|---|---|---|---|---|
| `update_project_config` | PUT | `/api/projects/:projectId/config` | `projectId`, `config{}` | body = config key/values (merged) |
| `set_provider_key` | POST | `/api/provider-keys/:provider` | `provider`, `key` | — |
| `delete_provider_key` | DELETE | `/api/provider-keys/:provider` | `provider` | — |
| `custom_providers` | GET/POST/DELETE | `/api/custom-providers[/:id]` | `action` (list\|upsert\|delete) | `id` (delete), `config{}` (upsert body) |
| `aigw_configure` | POST/DELETE | `/api/aigw/configure` | `action` (configure\|remove) | `url` (configure) |
| `marketplace_install` | POST | `/api/marketplace/install` | `sourceId`, `dirName`, `scope` | `projectId` (scope=project) |
| `marketplace_update` | POST | `/api/marketplace/update` | `packName`, `scope` | `projectId` |
| `marketplace_uninstall` | DELETE | `/api/marketplace/installed` | `packName`, `scope` | `projectId` (204 on success) |
| `tool_override` | POST | `/api/tools/:name/customize?scope=&projectId=` | `name` | `scope` (default server), `projectId` |
| `role_override` | POST | `/api/roles/:name/customize?scope=&projectId=` | `name` | `scope`, `projectId` |
| `workflow_override` | POST | `/api/workflows/:id/customize?projectId=` | `workflowId`, `projectId` | — |
| `maintenance_cleanup` | POST | (see sub-actions) | `action` | action-specific |
| `sandbox_image_build` | POST | `/api/sandbox-image/build` | — | `projectId` (body or query) |
| `system_prompt_customise` | POST | `/api/system-prompt/customise` | — | — |
| `harness_restart` | POST | `/api/harness/restart` | — | — |
| `shutdown` | POST | `/api/shutdown` | — | — |

**`maintenance_cleanup`** takes an `action` param selecting one POST endpoint:

| `action` value | path | body |
|---|---|---|
| `worktrees` | `/api/maintenance/cleanup-worktrees` | (paths / dry-run per handler) |
| `archived_session_worktrees` | `/api/maintenance/cleanup-archived-session-worktrees` | — |
| `sessions` | `/api/maintenance/cleanup-sessions` | — |
| `purge_archives` | `/api/maintenance/purge-archives` | — |
| `cleanup_index_rows` | `/api/maintenance/cleanup-index-rows` | `projectId?` |
| `search_rebuild` | `/api/search/rebuild` | `projectId?` |
| `search_compact` | `/api/search/compact` | — |

**Notes / flags:**
- `custom_providers` and `aigw_configure` fold multiple HTTP verbs behind an
  `action` sub-discriminator because they share a base path. `set_provider_key`
  stores under `preferencesStore` key `providerKey.<provider>` (body `{ key }`);
  `delete_provider_key` removes it.
- `tool_override`/`role_override` require `scope` (`server`|`project`) via query
  string, and `projectId` when scope is `project`. `workflow_override` requires
  `projectId`. These map to the `*/customize` "copy into scope" endpoints, which
  is how an override is created; removing an override is a separate
  `DELETE .../override` endpoint (NOT exposed by default — flag as a possible
  future `*_override_remove` op if needed).
- `sandbox_image_build` reads `projectId` from body or `?projectId=`; returns
  409 if a build is already in progress.

### 5.4 Suggested TypeBox for each tool's `parameters`

Shared shape (same skeleton per tool; only the `operation` union differs):

```ts
Type.Object({
  operation: Type.Union([ /* literals for THIS tool's ops */ ], {
    description: "Gateway operation to run; see detail_docs for the catalogue.",
  }),
  // shared scalar ids (optional; requiredness enforced per-op at runtime)
  goalId: Type.Optional(Type.String({ description: "Goal id." })),
  sessionId: Type.Optional(Type.String({ description: "Session id." })),
  taskId: Type.Optional(Type.String({ description: "Task id." })),
  gateId: Type.Optional(Type.String({ description: "Gate id." })),
  projectId: Type.Optional(Type.String({ description: "Project id." })),
  workflowId: Type.Optional(Type.String({ description: "Workflow id." })),
  name: Type.Optional(Type.String({ description: "Resource name (tool/role/provider/pack/staff)." })),
  // query-ish
  q: Type.Optional(Type.String({ description: "Free-text query filter." })),
  archived: Type.Optional(Type.Boolean({ description: "Include archived items." })),
  include: Type.Optional(Type.String({ description: "Inclusion flag, e.g. 'archived'." })),
  view: Type.Optional(Type.String({ description: "Response view, e.g. 'summary'." })),
  scope: Type.Optional(Type.String({ description: "Config scope: server or project." })),
  cascade: Type.Optional(Type.Boolean({ description: "Cascade to descendants (archive/teardown)." })),
  probe: Type.Optional(Type.String({ description: "maintenance_inspect probe selector." })),   // read tool
  action: Type.Optional(Type.String({ description: "Sub-action selector for grouped operations." })), // admin tool
  // free-form request body for richer POST/PUT ops (create_goal, create_task, update_*, signal_gate, config, ...)
  body: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: "Operation body fields; see detail_docs per operation.",
  })),
})
```

Keep every `description` ≤ 80 chars (budget §9). `bobbit_read` omits
`cascade`/`action`/`body`; `bobbit_orchestrate` omits `probe`;
`bobbit_admin` omits `probe`/`gateId`. Trim the shared block per tool to only
the fields that tier uses — smaller schema, lower budget.

## 6. Tiering & `grantPolicy`

Each YAML assigns a distinct `group`:

| tool | group | grantPolicy |
|---|---|---|
| `bobbit_read` | `BobbitRead` | `allow` |
| `bobbit_orchestrate` | `BobbitOrchestrate` | `never` |
| `bobbit_admin` | `BobbitAdmin` | `never` |

- `grantPolicy: allow` — available by default wherever the group registers.
- `grantPolicy: never` — the tool is registered (visible in `/api/tools`) but
  hidden from agents unless a **role**, **project**, or **user** tool-group
  policy explicitly enables its group. Mechanism is identical to
  `session_prompt` (group `Agent`, `grantPolicy: never`).

**Enabling `orchestrate`/`admin` for a role:** set a tool-group policy for
`BobbitOrchestrate` / `BobbitAdmin` to `allow` (or `ask`) at the desired scope.
Tool-group policies are read/written via `GET /api/tool-group-policies` and
`PUT /api/tool-group-policies/:group` (see `src/server/server.ts` ~8354). A
role definition can also enable specific groups via its `tools` allowlist.
Because the three tools carry separate groups, a user can grant `read` broadly,
gate `orchestrate` behind `ask`, and keep `admin` `never` except for a trusted
admin role.

## 7. Overlap policy (constraints)

Do **not** duplicate or supersede existing tools:

- **Transcript reads** — do NOT re-implement `GET /api/sessions/:id/transcript`.
  `detail_docs` must point the agent to **`read_session`**.
- **Cross-session prompting/steering** — do NOT expose
  `POST /api/sessions/:id/prompt`, `/team/steer`, `/team/prompt`, or `/wait`.
  Point to **`session_prompt`** / **`team_prompt`** / **`team_steer`**.
- **Current-goal task/gate management** — `bobbit_read.list_tasks` /
  `list_gates` take an **arbitrary** `goalId` (gateway-wide, additive) and do
  NOT replace `task_list`/`gate_list` (current goal). Mutating the current
  goal's tasks/gates should still go through `task_*` / `gate_signal` /
  `verification_result`; the bobbit orchestrate equivalents exist for
  cross-goal orchestration by explicit id.
- **Team lifecycle** — `team_spawn`, `team_dismiss`, `team_complete`,
  `team_abort` remain the way to manage the *current* team. `bobbit_orchestrate`
  only exposes `team_start` / `team_teardown` keyed by explicit `goalId`.
- **Internal/UI-only endpoints** are explicitly out of scope: side-panel /
  preview mounts, review annotations, `ext/*` pack surfaces, provider-hooks,
  proposal drafts, bg-processes, drafts, `oauth/*`, `preferences`,
  `agent-dir/*`, image generation. None are in the catalogue.

## 8. Wiring (what's required beyond creating files)

Tool groups are **auto-discovered** by scanning the builtin tools directory —
no explicit registration. Evidence in `src/server/server.ts`:
- `runtimeBuiltinToolsDir()` resolves the shipped `defaults/tools` dir.
- `configCascade.resolveTools(projectId)` enumerates tool groups by scanning
  that dir (plus server/project config `tools/` dirs) — used by `GET /api/tools`
  (~7427) and the customize/override handlers (~8249 `findToolGroupDir`).
- The `web` and `browser` groups have no registration beyond their
  `defaults/tools/<group>/` directory; they are picked up the same way.

**Therefore, dropping `defaults/tools/bobbit/` with the three YAMLs +
`extension.ts` is sufficient** for discovery. The `provider.extension` field
(`extension.ts`) tells the runtime which file to load as the
`bobbit-extension`. The extension self-gates on credential availability (§4.1).

The only non-file change required is the **budget test** update (§9) — the test
hardcodes the list of extension dirs it imports.

## 9. Test plan (all under `tests2/`)

Register new files in `tests2/tests-map.json`.

1. **`tests2/core/tool-description-budget.test.ts` (edit existing).** Add
   `"bobbit"` to the `EXTENSION_FILES` array. Because the bobbit extension gates
   on credentials, extend `beforeAll` to set `process.env.BOBBIT_TOKEN` and
   `process.env.BOBBIT_GATEWAY_URL` (any non-empty values) so the extension
   registers and its three tool descriptions + all param descriptions get
   budget-checked (`description ≤ 150`, each param `description ≤ 80`,
   recursive). Guard-wrapped via `withEnv` (the file already uses
   `guardProcessEnv()`).

2. **`tests2/core/bobbit-tool-credentials.test.ts` (new, bucket: core).**
   - Env creds present → extension registers 3 tools (spy `registerTool`).
   - Env creds absent, state files present (`BOBBIT_DIR/state/token` +
     `gateway-url`) → registers from files.
   - Neither present → registers nothing, logs the expected message (assert via
     spied `console.error`), does NOT throw.
   - `baseUrl` trailing-slash trimming.

3. **`tests2/core/bobbit-tool-dispatch.test.ts` (new, bucket: core).** Stub
   global `fetch`; drive `execute` for a representative op in each tool:
   - Path building: `get_goal` → `GET /api/goals/:id`; `search` →
     `/api/search?q=…&type=…`; `maintenance_inspect{probe}` → correct probe
     path; `archive_goal{cascade}` → `?cascade=` appended;
     `maintenance_cleanup{action}` → correct POST path.
   - Body building: `create_goal` sends `{projectId,title,spec,workflowId,…}`;
     `signal_gate` sends `{sessionId?,content?,metadata?}`.
   - Method correctness (GET/POST/PUT/DELETE) per op.

4. **`tests2/core/bobbit-tool-validation.test.ts` (new, bucket: core).**
   - Unknown `operation` → `isError` result with clear message.
   - Missing required param (e.g. `get_goal` without `goalId`, `create_goal`
     without `projectId`) → `isError`, no `fetch` call made.
   - `create_session`/`create_goal` require `projectId` (decision #2).

5. **`tests2/core/bobbit-tool-errors.test.ts` (new, bucket: core).** Stub
   `fetch` to return `{ error, code }` with non-2xx → assert `err()` output
   includes both message and `[CODE]` and HTTP status; 204 → `{ ok:true }`.

6. **`tests2/core/bobbit-tool-tiers.test.ts` (new, bucket: core).** Parse the
   three YAMLs; assert `group` values (`BobbitRead`/`BobbitOrchestrate`/
   `BobbitAdmin`) and `grantPolicy` defaults (`allow`/`never`/`never`), and that
   each YAML `params.operation` union matches the operations the extension
   actually dispatches (guard against catalogue drift between YAML docs and
   code).

No `tests2/browser` journey — the tool surfaces no UI.

## 10. Docs plan

- **`docs/rest-api.md`** — add a short cross-reference section "Driving the
  gateway from an agent" pointing at the `bobbit` tool group as the preferred
  path over raw `curl`, and noting the three tiers.
- **New `docs/bobbit-gateway-tool.md`** (reference; distinct from this design
  doc) — user-facing: the three tiers, `grantPolicy` defaults, how to enable
  `orchestrate`/`admin` for a role, the overlap/redirect policy, and the full
  operation catalogue (link back here for endpoint detail). Alternatively fold
  into an existing tools doc — but a dedicated page is cleaner given the size.
- **`AGENTS.md`** — the "Gateway API access" section: add one line noting the
  `bobbit_read`/`bobbit_orchestrate`/`bobbit_admin` tools as the preferred path
  over hand-rolled `curl` for sessions that have the groups enabled, keeping the
  raw-curl instructions as the fallback. One-line pointer only (AGENTS.md bloat
  policy).
- **`defaults/system-prompt.md`** — REMOVE the verbose `# Gateway API access`
  section (the token/URL/`curl -sk`/netstat/key-endpoints block, currently ~lines
  74–96) and REPLACE it with a concise **"Bobbit harness architecture"** section:
  a short description that the Bobbit gateway/harness supervises agent sessions,
  goals, teams, projects, worktrees/sandboxes, and workflow gates, and that your
  session is one managed agent process (reattached across restarts). State that
  tools *may* be available to inspect/manipulate the harness (the
  `bobbit_read`/`bobbit_orchestrate`/`bobbit_admin` tiers) — preferred over
  hand-rolled HTTP — and that their absence means the capability was not granted
  to the session. Do NOT re-add token/URL/curl recipes to the system prompt.
  (This is a goal-owner-requested change layered onto the original spec.)

## 11. Open risks / flagged missing endpoints

- **`delete_goal` has no hard-delete endpoint — RESOLVED.** `DELETE /api/goals/:id`
  archives (cascade). Decided (§2.4): drop `delete_goal`, expose only
  `archive_goal`; `detail_docs` documents that "delete" = archive.
- **`tool_override`/`role_override`/`workflow_override` create overrides via the
  `*/customize` copy endpoints;** there is no single "override" verb. Removing an
  override is `DELETE /api/{tools,roles,workflows}/:name/override` — not in the
  default catalogue. Flag: add `*_override_remove` ops only if a use case
  appears.
- **`custom_providers` / `aigw_configure` multiplex verbs behind an `action`
  sub-param.** Slightly awkward but avoids inventing three ops each. Implementer
  may split them if preferred.
- **`maintenance_cleanup` destructiveness.** These endpoints delete worktrees /
  purge archives / rebuild the search index. They sit in `bobbit_admin`
  (`grantPolicy: never`) precisely for this reason. The dry-run/paths body
  contract of `cleanup-worktrees` should be confirmed against the handler
  (~16106) at implementation time and documented in `detail_docs`.
- **`list_workflows` without `projectId` returns `[]`.** Marked required at the
  tool layer for a useful result, but the gateway will not 4xx — document the
  empty-list behaviour so agents pass `projectId`.
- **Budget pressure.** Three `operation` unions with many literals plus shared
  optional params must stay under the pinned budgets. The literal union values
  are NOT counted as descriptions (only `description` strings are), so the main
  risk is the shared param `description` strings — keep each ≤ 80 chars and trim
  per-tool. Verified approach in §5.4.
