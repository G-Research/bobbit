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
| `GET` | `/api/sessions` | List all sessions. Supports `?since=N` generation counter for conditional fetch. Response includes `archivedDelegates` array (see below) |
| `POST` | `/api/sessions` | Create a session (normal, delegate, or with role/traits/assistant type/reattemptGoalId) |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Terminate a session |
| `PATCH` | `/api/sessions/:id` | Update session properties (title, colorIndex, preview, roleId, traits, assistantType, goalId) |
| `PUT` | `/api/sessions/:id/title` | Rename a session (legacy endpoint) |
| `POST` | `/api/sessions/:id/wait` | Block until session becomes idle, then return output |
| `POST` | `/api/sessions/:archivedId/continue` | Create a new session cloned from an archived one, seeded with its transcript. See [Continue-Archived endpoint](#continue-archived-endpoint) |
| `GET` | `/api/sessions/:id/output` | Get final assistant output from the last turn |
| `GET` | `/api/sessions/:id/git-status` | Git status for session's working directory (branch, ahead/behind, dirty files) |
| `GET` | `/api/sessions/:id/pr-status` | PR status for session's branch (via `gh pr view`) |
| `GET` | `/api/sessions/:id/cost` | Token usage and cost for a single session |
| `GET` | `/api/sessions/:id/tool-content/:messageIndex/:blockIndex` | Lazy-load full tool input content for a truncated block (see [Large content truncation](#large-content-truncation)) |


### Review Annotations

Per-session review annotations are stored server-side so they survive browser close/reopen, server restart, and are visible from any connected client (on refresh). Annotations are stored in `.bobbit/state/review-annotations-{sessionId}.json`. The client `AnnotationStore` uses a cache-first pattern: reads are synchronous from an in-memory cache, writes update the cache immediately and send async server requests.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/review/annotations` | Get all annotations and submitted flag for a session (`{ annotations, submitted }`) |
| `POST` | `/api/sessions/:id/review/annotations` | Add or upsert an annotation (`{ docTitle, annotation }`) |
| `DELETE` | `/api/sessions/:id/review/annotations/:annotationId` | Remove a single annotation. Requires `?docTitle=` query parameter |
| `DELETE` | `/api/sessions/:id/review/annotations` | Clear annotations. Body `{ docTitle }` clears one doc; empty body clears all |
| `POST` | `/api/sessions/:id/review/annotations/bulk` | Bulk write all annotations + submitted flag (used by `sendBeacon` on page unload). Body: `{ annotations, submitted }` |
| `GET` | `/api/sessions/:id/review/submitted` | Get the review submitted flag (`{ submitted }`) |
| `PUT` | `/api/sessions/:id/review/submitted` | Set the review submitted flag (`{ submitted: boolean }`) |

### Goals

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals` | List all goals. `?archived=true` returns archived goals with an `archivedSessions` field. Supports `?since=N` generation counter for conditional fetch |
| `POST` | `/api/goals` | Create a goal (`{ title, cwd, spec, team?, worktree?, reattemptOf? }`) |
| `GET` | `/api/goals/:id` | Get a goal |
| `PUT` | `/api/goals/:id` | Update a goal (title, cwd, state, spec, team, repoPath, branch, reattemptOf) |
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
| `GET` | `/api/goals/:id/gates/:gateId` | Get gate detail (status, signals, definition) |
| `GET` | `/api/goals/:id/gates/:gateId/inspect` | Scoped gate data retrieval (content, verification, or signal history) |
| `POST` | `/api/goals/:id/gates/:gateId/signal` | Signal a gate (`{ status, content?, verifiedBy? }`) |
| `POST` | `/api/goals/:id/gates/:gateId/cancel-verification` | Cancel a stuck running verification (idempotent) |

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
| `GET` | `/api/goals/:id/team/agents` | List agents for a team goal. `?include=archived` also returns archived agents with `teamLeadSessionId`, `teamGoalId`, and `delegateOf` fields |
| `POST` | `/api/goals/:id/team/complete` | Complete a team (dismiss agents, keep team lead) |
| `POST` | `/api/goals/:id/team/teardown` | Fully tear down a team (dismiss all + terminate team lead) |

### Tasks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks/:id` | Get a task |
| `PUT` | `/api/tasks/:id` | Update a task (title, spec, state, assignedSessionId, dependsOn, headSha, baseSha, branch, resultSummary) |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `POST` | `/api/tasks/:id/assign` | Assign a task to a session (`{ sessionId }`). Auto-populates `baseSha` and `branch` from the agent's `TeamAgent` record if available |
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
| `POST` | `/api/roles` | Create a role (`{ name, label, promptTemplate, toolPolicies?, allowedTools?, accessory? }`). `toolPolicies` is the source of truth for tool access; `allowedTools` is accepted for backward compatibility and merged as `always-allow` entries. |
| `GET` | `/api/roles/:name` | Get a role (includes `toolPolicies` and derived `allowedTools`) |
| `PUT` | `/api/roles/:name` | Update a role. Accepts `toolPolicies` (Record of tool/group name → policy). Policy values are validated against: `always-allow`, `ask-once`, `always-ask`, `never-ask`, `never`. |
| `DELETE` | `/api/roles/:name` | Delete a role |

### Tool Group Policies

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tool-group-policies` | Get all group default policies as `Record<string, GrantPolicy>` |
| `PUT` | `/api/tool-group-policies/:group` | Set or clear a group default policy (`{ policy: GrantPolicy \| null }`). Valid values: `always-allow`, `ask-once`, `always-ask`, `never-ask`, `never`. Pass `null` to clear. |

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
| `GET` | `/api/slash-skills/details` | Full slash skill details including content, file paths, and `directories` array listing all scanned directories (default + custom) |

### Assistant Prompts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/roles/assistant/prompts` | List all assistant prompt definitions |
| `PUT` | `/api/roles/assistant/prompts/:type` | Update an assistant prompt (goal, role, tool, personality, staff, setup) |

### Staff Agents

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/staff` | List all staff agent definitions. Each entry includes a `sandboxed` boolean (inherited from project config). |
| `GET` | `/api/staff/:id` | Get a single staff agent definition (includes `sandboxed` boolean) |
| `POST` | `/api/staff` | Create a staff agent (`{ name, description, triggers, skillId?, prompt? }`) |
| `PUT` | `/api/staff/:id` | Update a staff agent (`{ name, description, systemPrompt, cwd, state, triggers, memory, roleId }`) |
| `DELETE` | `/api/staff/:id` | Delete a staff agent and terminate its session |
| `POST` | `/api/staff/:id/wake` | Manually trigger a staff agent's wake cycle |
| `GET` | `/api/staff/:id/sessions` | **Deprecated (410)**. Use `GET /api/staff/:id` instead. |

### Projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all registered projects. |
| `POST` | `/api/projects` | Register a project (`{ name, rootPath, color?, upsert? }`). With `upsert: true`, returns the existing project if one already exists at `rootPath`. |
| `GET` | `/api/projects/:id` | Get a single project. |
| `PUT` | `/api/projects/:id` | Update name/color. |
| `DELETE` | `/api/projects/:id` | Unregister (does not delete files). Returns **400** `{"error":"Cannot delete the last remaining project — add another project first"}` when deleting would leave zero projects. Under `BOBBIT_E2E=1`, `?force=1` bypasses the guard for tests that need to exercise the zero-project UX. |

### Project resolution contract

`POST /api/goals`, `POST /api/sessions`, and `POST /api/staff` all require a caller-identified project. Resolution order (no silent fallback):

1. If `body.projectId` is a non-empty string matching a registered project → use it.
2. Else if `body.cwd` is a string and some registered project's `rootPath` matches it → use that project.
3. Else → **400 Bad Request**.

| Condition | Status | Body |
|---|---|---|
| No `projectId`, no `cwd` | 400 | `{"error":"projectId required: no projectId was provided and cwd (\"\") does not match any registered project"}` |
| `cwd` provided, no matching project `rootPath` | 400 | `{"error":"projectId required: no projectId was provided and cwd (\"<cwd>\") does not match any registered project"}` |
| `projectId` provided, unknown id | 400 | `{"error":"Invalid project"}` |

The helper implementing this is `resolveProjectForRequest` in `src/server/agent/resolve-project.ts`. Callers in new handlers should invoke it at the top of the handler and return the 400 directly when `ok === false`.

### Project Config

Per-project overrides (recommended — scoped to a registered project):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/config` | Raw project-level overrides (only keys explicitly set). |
| `GET` | `/api/projects/:id/config/defaults` | Built-in defaults for all known config keys. |
| `GET` | `/api/projects/:id/config/resolved` | Fully resolved values; each key returns `{ value, source }` where `source` is `"project"`, `"server"`, or `"default"`. |
| `PUT` | `/api/projects/:id/config` | Set/clear project-level overrides. Empty string or `null` clears an override. Atomic: all keys validated before any are written. |

`PUT /api/projects/:id/config` is a generic KV writer. It accepts any scalar `project.yaml` field — including `build_command`, `test_command`, `typecheck_command`, `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `qa_start_command`, `sandbox`, and any custom keys the project defines — and the only validation is that keys must not contain `.`. This endpoint is what the settings UI and the mid-session project-proposal accept path both write through (see [internals.md — Per-project config](internals.md#per-project-config)). The project's display `name` is **not** a `project.yaml` field — update it via `PUT /api/projects/:id`. Model preferences (`session_model`, `review_model`, `naming_model`) are **not** project-scoped either; they live in the preferences store.

Server-level fallback (applied when no project override is set):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/project-config` | Server-level project config (legacy; used as fallback for per-project overrides). |
| `GET` | `/api/project-config/defaults` | Built-in defaults. |
| `PUT` | `/api/project-config` | Update server-level config fields. |
| `GET` | `/api/config-directories` | List all config scan directories (skills, MCP, tools) with path, types, scope, exists, isRemovable. |

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

### Models

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/models` | List currently available models (`ApiModel[]`) |
| `POST` | `/api/models/test` | Probe a model pref with a minimal "Reply with OK" call (body: `{ pref: "<provider>/<modelId>" }`). 10s timeout. |

`POST /api/models/test` responses:

- `200 { ok: true, modelResolved, latencyMs }` — success.
- `400 { ok: false, error: "Malformed pref" }` — pref could not be parsed as `provider/modelId`.
- `404 { ok: false, error: "Model \"...\" is not in the current available-models list..." }` — pref does not resolve against `/api/models`.
- `422 { ok: false, error: "Test not supported for this provider yet..." }` — non-aigw providers are not probed.

Used by the Settings → Models tab per-row Test button. See [AGENTS.md — Debug a review or naming model picking the wrong model under AI Gateway](../AGENTS.md).

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

Provider-aware. Bobbit can hold OAuth credentials for several providers concurrently (currently `anthropic` and `openai-codex`); every endpoint takes a `provider` discriminator so the same flow IDs and credential rows do not bleed across providers.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/oauth/status?provider=<id>` | OAuth status for one provider. Returns `{ provider, hasToken, expiresAt? }`. |
| `POST` | `/api/oauth/start` | Begin an OAuth flow for a provider. Body: `{ provider }`. Returns `{ provider, flowId, authUrl, expiresAt }`. |
| `POST` | `/api/oauth/complete` | Exchange `code` for tokens. Body: `{ provider, flowId, code }`. Returns `{ provider, ok: true }`. |
| `GET` | `/api/oauth/flow-status?flowId=<id>&provider=<id>` | Poll an in-flight flow. Returns `{ complete, error?, expiresAt }`. |

**Provider IDs:** `anthropic` (Claude.ai login → API key/refresh token) and `openai-codex` (ChatGPT subscription → bearer token). Unknown values reject with `400 { error: "unknown provider" }`.

**Why `provider` everywhere:** the same browser-redirect callback URL is shared between providers, and a user may legitimately have flows in flight for both at once. Keying every operation by `provider` (alongside `flowId`) keeps state strictly partitioned and lets the UI render Settings → Account as parallel rows that can be (re-)authed independently.

**`GET /api/oauth/status?provider=<id>`** responses:

- `200 { provider: "anthropic", hasToken: true, expiresAt: 1775812345000 }` — credential present.
- `200 { provider: "anthropic", hasToken: false }` — no stored credential.
- `400 { error: "unknown provider" }` — `provider` missing or unrecognised.

The response intentionally does **not** echo the bearer token / API key — strict-OAuth contract.

**`POST /api/oauth/start`** body: `{ provider: "anthropic" | "openai-codex" }`. Returns:

```json
{
  "provider": "openai-codex",
  "flowId": "f_8c2…",
  "authUrl": "https://auth.openai.com/…",
  "expiresAt": 1775812945000
}
```

The caller opens `authUrl` in a system browser; the browser-redirect handler completes the flow via `POST /api/oauth/complete` once the provider returns a `code`.

**`POST /api/oauth/complete`** body: `{ provider, flowId, code }`. Returns:

- `200 { provider, ok: true }` — token stored.
- `400 { error: "code required" }` — `code` missing or empty.
- `400 { error: "unknown provider" }` — `provider` missing or unrecognised.
- `404 { error: "flow not found" }` — `flowId` is unknown, expired, **or** the stored flow's `provider` does not match the body. The provider mismatch is treated as "not found" rather than "forbidden" so cross-provider polling cannot be used to enumerate live flow IDs.

**`GET /api/oauth/flow-status?flowId=<id>&provider=<id>`** is the polling endpoint used by the Settings → Account UI while the user is in the browser. Returns:

```json
{ "complete": false, "expiresAt": 1775812945000 }
```

or on success / failure:

```json
{ "complete": true, "expiresAt": 1775812945000 }
{ "complete": true, "error": "user denied access", "expiresAt": 1775812945000 }
```

Response contract:

- `complete: boolean` — `false` while the flow is still pending, `true` once `/api/oauth/complete` has run for that `flowId` (regardless of success).
- `error?: string` — present only when `complete: true` and the flow failed.
- `expiresAt: number` — epoch-ms after which the flow will be garbage-collected.

`provider` is **required** as a defence-in-depth check: if the stored flow's provider does not match the query parameter, the endpoint returns `404 { error: "flow not found" }` instead of leaking status across providers. The primary key is still `flowId`; the provider check just guarantees that a flow ID accidentally polled with the wrong provider cannot be used to confirm its existence.

See [AGENTS.md — Add / debug per-provider OAuth](../AGENTS.md) for the file map and the Settings → Account UI walkthrough.

### Image generation

Bobbit routes image generation through the gateway so the agent's `generate_image` tool can call OpenAI (DALL-E 2/3 + Images API), Google (Gemini 2.5/3 Flash Image, Imagen 4), and OpenAI-Codex driver models behind one contract. The session-scoped image model is selected via the footer picker (UI) or `set_image_model` (WS); `POST /api/image-generation/generate` is the gateway-side execution endpoint the tool extension calls.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/image-models` | List currently-available image models — array of `ApiImageModel`. |
| `POST` | `/api/image-generation/generate` | Generate one or more images via the configured provider. |

**`GET /api/image-models`** returns the registry filtered by configured providers (e.g. an entry is omitted when its provider has no credential). Each item is an `ApiImageModel` (TypeScript type defined in `src/server/agent/image-generation.ts`):

```json
[
  {
    "id": "openai/gpt-image-2",
    "provider": "openai",
    "modelId": "gpt-image-2",
    "label": "GPT Image 2",
    "available": true,
    "reason": null,
    "sizes": ["1024x1024", "1536x1024", "1024x1536"]
  },
  {
    "id": "google/gemini-2.5-flash-image",
    "provider": "google",
    "modelId": "gemini-2.5-flash-image",
    "label": "Nano Banana (Gemini 2.5 Flash Image)",
    "available": false,
    "reason": "missing-credentials"
  }
]
```

Unavailable rows still appear so the Settings → Models → Image picker can render a red "Unavailable" badge with a tooltip pointing at the missing credential. See [docs/internals.md — Image generation routing](internals.md#image-generation-routing) for the full data flow.

**`POST /api/image-generation/generate`** is the back-end called by the `generate_image` tool extension. Request body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | `string` | yes | Free-form prompt. **Capped at 8192 chars** — longer payloads reject with `400`. |
| `n` | `integer` | no | Number of images. Clamped to `[1, 4]`; out-of-range values reject with `400`. Defaults to `1`. |
| `model` | `string` | no | Override id in `provider/modelId` form. Must match an entry in `/api/image-models`. Defaults to the session's selected image model. |
| `imageSize` | `string` | no | Provider-specific size token (e.g. `1024x1024`, `1536x1024`). Validated against the registry entry's `sizes`. |
| `sessionId` | `string` | no | Used to resolve the session's selected image model when `model` is omitted. |

Response on success:

```json
{
  "model": "openai/gpt-image-2",
  "images": [
    { "url": "https://…", "format": "png" },
    { "base64": "iVBORw0KG…", "format": "png" }
  ]
}
```

Each image carries either `url` or `base64` (some providers return only one), plus a `format` (`png` / `jpeg` / `webp`). The tool extension fans this out to disk paths or inlines base64 in chat as appropriate.

Error responses:

- `400 { error: "prompt exceeds 8192 chars" }` — prompt over the cap.
- `400 { error: "n must be 1..4" }` — `n` outside the `[1, 4]` range or non-integer.
- `400 { error: "openai-codex image driver supports n=1 only" }` — the OpenAI-Codex driver hard-clamps to `n=1`; requesting more is rejected up-front instead of silently returning a single image.
- `400 { error: "unknown image model" }` — `model` does not appear in `/api/image-models` (or canonicalises to a different id than the registry entry — both sides are canonicalised before comparison).
- `400 { error: "missing prompt" }` — `prompt` missing or non-string.
- `502 { error: "<provider HTTP status>: <provider message>" }` — upstream provider rejected the call. The message starts with the upstream HTTP status code; `<provider message>` is `data?.error?.message` falling back to `JSON.stringify(data?.error)` so it never reads `[object Object]`.
- `502 { error: "remote image exceeds 25 MB cap" }` — Bobbit refused to download a remote image referenced in the prompt because it crossed the 25 MB streaming cap (memory-exhaustion guard).
- `503 { error: "image generation unavailable" }` — no provider credentials configured for any registered image model.

Under the AI Gateway, the OpenAI-Codex driver model auto-selects through a fallback chain (configured pref → `gpt-5.5` → `gpt-5` → `gpt-4o`) — see [AGENTS.md — Image generation failure debugging](../AGENTS.md) for the full diagnostic path. The agent-facing routing rules (when to use `model="openai/gpt-image-2"` vs Google IDs) live in `defaults/system-prompt.md` and the per-tool `Parameters` table is in `defaults/tools/images/generate_image.yaml::detail_docs` (single source of truth).

### MCP Servers

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mcp-servers` | List all discovered MCP servers with status, tool count, and tool names |
| `POST` | `/api/mcp-servers/:name/restart` | Disconnect and reconnect an MCP server (also re-discovers from config files) |
| `POST` | `/api/internal/mcp-call` | Proxy a tool call to an MCP server (`{ tool: "mcp__server__name", args: {...} }`) |

**`GET /api/mcp-servers`** returns an array of server objects:
```json
[{
  "name": "playwright",
  "status": "connected",
  "toolCount": 12,
  "config": { "command": "npx", "args": ["@playwright/mcp@latest"] },
  "tools": [{ "name": "mcp__playwright__browser_navigate", "description": "Navigate to URL" }]
}]
```

**`POST /api/mcp-servers/:name/restart`** re-discovers servers from config files before connecting, so newly added servers can be started without a gateway restart.

**`POST /api/internal/mcp-call`** is the internal proxy endpoint used by generated agent extensions. Returns the raw MCP `{ content, isError }` response.

### Preview

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/preview` | Get preview HTML for a session (`?sessionId=`) |
| `POST` | `/api/preview` | Set preview HTML for a session (`?sessionId=`, `{ html }`) |

### Search

Lexical (BM25-style) search over goals, sessions, messages, and staff. Backed by a per-project FlexSearch index. See [docs/internals.md — Semantic search](internals.md#semantic-search) and [docs/design/portable-search.md](design/portable-search.md).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/search` | Query. Params: `q`, `projectId?`, `type?`, `limit?`, `offset?`. Omit `projectId` to search across all projects. |
| `POST` | `/api/search/rebuild` | Kick off a full rebuild in the background (`{ projectId }`) |
| `GET` | `/api/search/stats` | Stats for the project's search index (`?projectId=`) |
| `POST` | `/api/search/compact` | No-op under FlexSearch; retained for API compatibility (`{ projectId }`) |
| `GET` | `/api/maintenance/orphaned-index-rows` | List index rows whose parent entity no longer exists (`?projectId=`) |
| `POST` | `/api/maintenance/cleanup-index-rows` | Delete orphaned index rows (`{ projectId }`) |

**Disabled-service responses:** All Search endpoints return **503** with `{ error: "search-unavailable", reason, state }` when the service is disabled. `state` mirrors `SearchService.getState()` (one of `"initializing"`, `"ready"`, `"disabled"`, `"closed"`); `reason` mirrors `state` for diagnostic symmetry. The disabled path is catastrophic store-open failure — rare, and the Settings → Maintenance → Search Index panel exposes **Rebuild Index** as the recovery action.

**`POST /api/search/rebuild`** — body `{ projectId }`. Returns **202 Accepted** on success; progress is streamed via the `index:progress` / `index:complete` / `index:error` WebSocket events (see [websocket-protocol.md](websocket-protocol.md)). **400** if `projectId` is missing.

**`GET /api/search/stats?projectId=<id>`** — returns:

```json
{
  "lastRebuildAt": 1775812345000,
  "rowCountsBySource": { "goals": 12, "sessions": 48, "messages": 9321, "staff": 3 },
  "datasetBytes": 8432104,
  "engine": "flexsearch",
  "engineVersion": "0.8.158",
  "state": "ready"
}
```

Returns **400** if `projectId` is missing, **404** if the project is not registered.

**`POST /api/search/compact`** — body `{ projectId }`. No-op under the current engine; always returns `{ ok: true }`. Kept to avoid 404s from older clients.

**`GET /api/maintenance/orphaned-index-rows?projectId=<id>`** — scans the dataset for rows whose parent entity (goal, session, message, staff) no longer exists in the source-of-truth stores. Returns:

```json
{
  "count": 17,
  "sample": [
    { "id": "message:abc123:42:chunk:0", "source_id": "messages", "parent_id": "message:abc123:42" }
  ]
}
```

`sample` is capped (~10 entries) for preview in the Maintenance UI.

**`POST /api/maintenance/cleanup-index-rows`** — body `{ projectId }`. Deletes all orphaned rows found by the scan above. Returns `{ deleted: <count> }`.

### Summary views (`?view=summary`)

Three endpoints support a `?view=summary` query parameter that returns slim responses optimized for agent tool calls. Without this parameter, the full response is returned (used by the UI dashboard).

**Why this exists:** Full gate and task responses include signal history, content bodies, verification output, and task specs — often hundreds of KB. Agent tools call these endpoints frequently, and every byte enters the LLM context window permanently. Summary views strip non-essential data, reducing typical `gate_list` responses from ~436KB to ~500B.

**`GET /api/goals/:id/gates?view=summary`**

Returns status, dependency, and signal count per gate — no signal arrays or content bodies.

```json
{
  "gates": [{
    "gateId": "implementation",
    "name": "Implementation",
    "status": "failed",
    "dependsOn": ["design-doc"],
    "signalCount": 22,
    "updatedAt": 1775853741666,
    "failedSteps": ["E2E tests"]
  }]
}
```

Fields: `gateId`, `name`, `status`, `dependsOn`, `signalCount`. Conditional: `updatedAt` (if signaled), `failedSteps` (if failed — names of non-passed, non-skipped verification steps).

**`GET /api/goals/:id/gates/:gateId?view=summary`**

Returns the latest signal only, with truncated output for failed verification steps (last 40 lines). Content body is replaced with `hasContent` + `contentLength`.

```json
{
  "gateId": "implementation",
  "name": "Implementation",
  "status": "failed",
  "dependsOn": ["design-doc"],
  "signalCount": 22,
  "updatedAt": 1775853741666,
  "hasContent": true,
  "contentLength": 15234,
  "currentMetadata": { "new_regressions": "1" },
  "latestSignal": {
    "id": "sig-22",
    "sessionId": "08c8adf2",
    "timestamp": 1775853741666,
    "commitSha": "bd8fc7b",
    "verification": {
      "status": "failed",
      "steps": [
        { "name": "Type check passes", "passed": true },
        { "name": "E2E tests", "passed": false, "output": "… last 40 lines …" }
      ]
    }
  }
}
```

Passed verification steps include only `name` and `passed: true` — no output. Failed steps include a tail of their output (40 lines max).

**`GET /api/goals/:id/tasks?view=summary`**

Strips `spec`, `resultSummary`, `baseSha`, timestamps (`createdAt`, `updatedAt`, `completedAt`), and `inputGateIds`.

```json
{
  "tasks": [{
    "id": "743d021a",
    "title": "Server-side annotation store",
    "type": "implementation",
    "state": "complete",
    "assignedSessionId": "d425cf52",
    "branch": "goal-...-coder-d425cf52",
    "headSha": "def456",
    "workflowGateId": "implementation",
    "dependsOn": []
  }]
}
```

### Gate inspect endpoint

**`GET /api/goals/:id/gates/:gateId/inspect`**

A scoped read endpoint for targeted gate data retrieval. Used by the `gate_inspect` agent tool.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `section` | `"content"` \| `"verification"` \| `"signals"` | yes | — | What data to retrieve |
| `signal_index` | integer | no | -1 (latest) | Which signal. 0-based, negative indexes from end. |

**`section=content`** — Returns the markdown content body from a specific signal.
```json
{
  "gateId": "design-doc",
  "section": "content",
  "signalIndex": 0,
  "signalId": "sig-1",
  "text": "## Design Document\n\n..."
}
```

**`section=verification`** — Returns full verification step output (all steps, not truncated).
```json
{
  "gateId": "implementation",
  "section": "verification",
  "signalIndex": 21,
  "signalId": "sig-22",
  "steps": [
    { "name": "Type check", "type": "command", "passed": true, "duration_ms": 12400, "output": "Found 0 errors.\n" },
    { "name": "E2E tests", "type": "command", "passed": false, "duration_ms": 95200, "output": "..." }
  ]
}
```

**`section=signals`** — Returns a summary list of all signals (no content bodies or verification output).
```json
{
  "gateId": "implementation",
  "section": "signals",
  "signals": [
    { "index": 0, "id": "sig-1", "timestamp": 1775812345000, "sessionId": "efed71fb", "commitSha": "abc123", "verdict": "failed", "hasContent": true, "metadataKeys": ["new_regressions"] }
  ]
}
```

Returns 400 if `section` is missing or invalid. Returns 404 if the resolved signal index is out of range.

### Session error-state fields

`GET /api/sessions/:id` (and per-session entries in `GET /api/sessions`) includes two fields that expose the current error-state policy:

- **`lastTurnErrored: boolean`** — `true` when the most recent turn ended with `stopReason: "error"`. While `true`, the UI shows the error bubble + Retry button on the last user message.
- **`consecutiveErrorTurns: number`** — count of consecutive errored turns. Incremented on every `message_end` with `stopReason: "error"`, reset to `0` on any successful `message_end` and on successful explicit `retryLastPrompt`.

Behaviour: while `lastTurnErrored` is `true`, an incoming prompt or steer **implicitly unsticks** the session (clears the flag, prepends a system-prefix, dispatches the new message without retrying the failed turn) as long as `consecutiveErrorTurns < MAX_CONSECUTIVE_ERROR_TURNS` (`3`). At or above the cap, the message is parked in `promptQueue` awaiting a human Retry click — which bypasses the cap. Both fields default to `false` / `0` for backward compatibility if the underlying session predates the feature.

See [docs/prompt-queue.md — Error-state queue gating](prompt-queue.md#turn-errors-suppress-queue-draining) and [docs/debugging.md — Session wedged after errored turn](debugging.md#session-wedged-after-errored-turn) for the full rationale.

### Archived child enrichment in session response

`GET /api/sessions` (without `?since`) returns an `archivedDelegates` array alongside `sessions`. This contains all archived sessions that are children of any live session or live goal, found via BFS from live session IDs and live goal IDs through multiple relationship types:

- **`delegateOf`** — direct and nested delegate chains
- **`teamGoalId` / `goalId`** — archived sessions affiliated with live goals
- **`teamLeadSessionId`** — archived team members (coders, reviewers, QA agents) of live team leads

The BFS walks all three relationship types, then recursively includes delegates of any newly-discovered sessions. This ensures visibility is inherited: if a parent is visible in the sidebar, all its children are available behind a collapse chevron.

The `?include=archived` path (both paginated with `&limit=N` and non-paginated) also returns `archivedDelegates` via the same enrichment. This ensures that when the user toggles "Show Archived" in the sidebar, archived children of live sessions and goals remain visible rather than relying solely on the paginated window.

This avoids a separate fetch for archived child data — the sidebar can render chevrons and nested children immediately on first load. The alternative (a dedicated children endpoint with lazy-fetch) was rejected because it creates a chicken-and-egg problem: the chevron only renders when children are known, but children are only fetched on chevron click.

### Archived sessions in goals response

`GET /api/goals?archived=true` returns an `archivedSessions` array alongside the paginated goals. This contains all archived sessions affiliated with the returned goals (matched by `teamGoalId` or `goalId`), plus their delegate chains (BFS walk on `delegateOf`).

**Why:** Without this, expanding an archived goal in the sidebar would show no children — the sessions endpoint only enriches children of *live* goals, and archived goal sessions may be beyond the paginated session window. Including them in the goals response guarantees that any archived goal visible in the sidebar has its children immediately available.

The client merges these affiliated sessions into `state.archivedSessions` (additive merge, not replace) to avoid overwriting BFS-enriched delegates from the live poll.

**Note:** The `?since=N` polling path does **not** include `archivedDelegates` — it only returns the changed session list. Archived delegates are loaded on the initial full fetch and refreshed on full re-fetches (e.g. after reconnect). This is intentional: delegate relationships rarely change during polling intervals.

### Generation counters (conditional fetch)

`GET /api/sessions` and `GET /api/goals` support a `?since=N` query parameter for efficient polling. Both stores maintain a monotonically increasing generation counter that increments on every mutation.

**When `?since=N` matches the current generation** (nothing changed):
```json
{ "generation": 42, "changed": false }
```

**When data has changed** (or `?since` is omitted):
```json
{ "generation": 43, "sessions": [...], "archivedDelegates": [...] }
{ "generation": 18, "goals": [...] }
```

Note: `archivedDelegates` is only present in the sessions response when `?since` is omitted or when the generation has changed. It is absent in `?since` conditional responses (see above).

The generation resets to 0 on server restart. Clients should initialize their tracked generation to -1 so the first request always fetches the full payload.

### Continue-Archived endpoint

`POST /api/sessions/:archivedId/continue` creates a brand-new session that mirrors the settings of an archived, non-goal, non-delegate session and seeds the archived transcript into the new session's system prompt. Used by the "Continue in New Session" footer button on archived session transcripts.

**Why it exists**: Users often want to pick up work from a finished session without reanimating its runtime state (stale worktree, dead sandbox container, committed/uncommitted changes on an old branch). This endpoint copies the *configuration* (project, model, role, personality, sandbox mode, worktree mode) while routing through the normal session-setup pipeline so the runtime is entirely fresh — new worktree, new container state, no branch/commit inheritance, no goal/team/delegate relationships.

**Request body**:

```json
{ "mode": "summary" | "full" }
```

- `"full"` — injects the archived transcript verbatim (subject to the 128 KB seed-context budget enforced in `src/server/agent/continue-archived.ts`).
- `"summary"` — asks the configured naming model to produce a bullet-point recap of the archived conversation. Falls back to `"full"` if the naming model is unavailable.

**Success response** (`201 Created`):

```json
{
  "id": "<new session id>",
  "cwd": "<new session working directory>",
  "status": "<idle | streaming | ...>",
  "title": "Continued: <original title>"
}
```

The new session's title is marked as generated, which prevents the first-message auto-titler from overwriting `Continued: …` on the user's first prompt.

**Error responses**:

| Status | Meaning |
|---|---|
| `400` | `mode` is missing or not `"summary"` / `"full"` |
| `404` | Archived session not found, or its transcript (`.jsonl`) is missing or empty |
| `409` | Source session is not archived |
| `410` | Source project has been unregistered (session cannot be continued without its project context) |
| `422` | Source is a goal, delegate, team member, or assistant session — not eligible for continuation |
| `500` | Seed-context construction or session creation failed unexpectedly (see server logs) |

**Scope gate**: The endpoint refuses goal-linked, delegate, team, and assistant sessions on purpose. Goal coupling (team structure, gates, tasks, shared worktrees) and delegate scoping don't survive the continue-into-a-fresh-session model. Users wanting to iterate on a goal should create a new session inside the goal instead.

**Seed context injection**: The archived messages are rendered by `buildSeedContext()` in `src/server/agent/continue-archived.ts` and passed to `createSession()` as `opts.seedContext` (plus `seedContextSourceId` for attribution). The session-setup plan propagates it to `PromptParts.seedContext`, and `assembleSystemPrompt()` in `src/server/agent/system-prompt.ts` emits it under a `## Prior Session Transcript` heading with a directive telling the agent it's context-only — not a request to act.

### Large content truncation

When an agent writes a large file (>32KB of tool input content), the server truncates the content in WebSocket broadcasts and the EventBuffer to prevent memory pressure from multi-megabyte payloads being serialized/deserialized on every streaming token. The full content is preserved in the agent's `.jsonl` session file and available on demand.

**`GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex`** — Returns the full, untruncated tool input content for a specific content block.

- `messageIndex` — zero-based index into the session's message history
- `blockIndex` — zero-based index into the message's content blocks

Returns `200` with `{ content: string }` on success. Returns `404` if the session, message, or block is not found, or if the block has no extractable content.

**How truncation works:**

The `truncateLargeToolContent()` function in `truncate-large-content.ts` scans `message_update` and `message_end` events for tool call blocks with string content exceeding the threshold (default 32KB, exported as `LARGE_CONTENT_THRESHOLD`). When found, the content field is replaced with:

```json
{ "_truncated": true, "_originalLength": 1048576, "preview": "first 512 characters..." }
```

The original event is never mutated — a shallow clone is created only when truncation is needed. Events that don't exceed the threshold pass through with zero overhead (no cloning).

**UI behavior:** `WriteRenderer` detects truncated content and shows a preview with a size badge. A "Load full content" button fetches the full content via this endpoint. During streaming, only the preview is shown — syntax highlighting is never applied to multi-MB content.

### Internal test hooks

**`POST /api/internal/test/replay-buffered-events/:sessionId`** — gated behind `BOBBIT_E2E=1` (returns **403** otherwise). Iterates the named session's `EventBuffer` and re-broadcasts every retained entry on the same WebSocket path production uses. Used by `ST-DEDUP-01` in `tests/e2e/ui/stories-streaming.spec.ts` to deterministically reproduce client-side dedup of live-streaming frames without racing a real agent. The handler accepts both the pre-fix raw-event shape (bare event objects) and the post-fix `{seq, ts, event}` tuple shape, so the same hook can drive regression tests against either buffer layout. Returns `{ replayed, bufferSize }`.
