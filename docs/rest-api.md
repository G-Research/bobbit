# REST API

Gateway routes require an authentication source accepted by that surface. Most
programmatic API calls use `Authorization: Bearer <admin-token>`; routes that
support it also accept `?token=`. Browser API requests and preview resources may
instead authenticate with a valid `bobbit_session` cookie. Scoped sandbox and
session credentials remain limited to their existing route allow-lists.

`bobbit_session` is a stateless signed value:
`v1.<iat>.<exp>.<nonce>.<signature>`. The canonical issuance and expiry Unix
seconds and 16-byte random nonce are authenticated by a 32-byte HMAC-SHA-256
tag over the exact ASCII `v1.<iat>.<exp>.<nonce>` prefix. Cookies have a fixed
30-day lifetime. Verification, including fixed-size timing-safe signature
comparison, is bounded and entirely in memory.

The only cookie state persisted is the stable, exact 32-byte signing key at
`<serverSecretsDir>/cookie-signing-key`. It is safely created or loaded once at
gateway startup with mode `0o600` and a `0o700` parent directory where Unix
permissions are supported. Invalid existing key material fails startup. The
admin Bearer token is never embedded in the cookie.

A legacy `<stateDir>/auth-cookies.json`, regardless of size or corruption, is
never inspected, migrated, rewritten, or deleted. A legacy 64-hex cookie is
invalid, but an existing UI tab self-heals when its next eligible
Bearer-authenticated API request replaces it with a signed cookie; the legacy
file remains untouched.

Bootstrap requires admin Bearer or localhost-trusted authentication on an
eligible browser-signaled API request. Renewal requires a qualifying API
request authenticated by the signed cookie and occurs only at or within the
inclusive seven-day window. A fresh valid cookie is not issued repeatedly.
Plain Bearer traffic without the required same-origin Fetch Metadata, sandbox
or session-bound traffic, internal callbacks, preview content, and preview SSE
do not receive `Set-Cookie`. The [preview cookie-auth reference](preview-architecture.md#cookie-auth)
documents the exact Fetch Metadata, Origin, Vite, credential, header, and route
exclusions.

Those browser headers classify issuance only; they do not establish authority
or prove a human caller. Consequently, a holder of the shared admin token can
still deliberately make an otherwise eligible browser-shaped request and
obtain the weak operator cookie. Cookies have
`HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`, plus `Secure` outside
localhost HTTP mode. Individual cookies are not independently revocable;
rotating the signing key invalidates all of them.

### Driving the gateway from an agent

Agents should prefer the **`bobbit` tool group** over hand-rolled `curl` for
calling these endpoints — it resolves the auth token and base URL for you and
returns the gateway's JSON. It is split into three privilege tiers:
`bobbit_read` (read-only introspection), `bobbit_orchestrate` (runtime
mutations), and `bobbit_admin` (config + destructive maintenance). See
[The `bobbit` gateway tool group](bobbit-gateway-tool.md). Raw `curl` remains
the fallback where the group isn't enabled.

### Error response shape

Non-2xx JSON responses follow:

```
{ error: string, stack?: string, code?: string, ...extra }
```

- `error` — human-readable message; always present.
- `stack` — server stack trace. Caught-exception responses (handlers using the `jsonError(status, err, extra?)` helper in `src/server/server.ts`) always include it; validation 4xx responses with literal strings (e.g. `"Missing title"`) omit it.
- `code` — optional machine-readable code (e.g. `"symlink_root"`).
- Additional fields may be merged via `extra` (e.g. `canonical` for symlink rejection).

Client call sites use the shared helpers `errorFromResponse(res, fallback)` and `errorDetails(err)` from `src/app/error-helpers.ts` to parse this body, attach `code`/`stack` to the thrown `Error`, and forward both to `showConnectionError(title, message, { code, stack })`, which renders via the `<error-details>` component (`src/ui/components/ErrorDetails.ts`). The set of modal call sites that must forward `{ code, stack }` is pinned by `tests/error-modal-call-sites.test.ts`; the helper contract is pinned by `tests/error-helpers.test.ts`.

### Quiet optional probes

A small set of UI probe endpoints accept `optional=1` to represent expected absence without producing browser-console-noisy `404` responses. In quiet mode, an existing session or goal with no optional data returns `204 No Content` and no body; genuinely missing sessions or goals still return `404`. Bare endpoints keep the legacy `404` absence contract. See [Quiet optional probes](quiet-204-probes.md).

### Health & Info

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + session count |
| `GET` | `/api/app-info` | Running Bobbit package version and build provenance: `{ version, buildType: "installed" | "source", commitSha? }` |
| `GET` | `/api/connection-info` | List network interface addresses for multi-device access |
| `GET` | `/api/ca-cert` | Download the Bobbit CA certificate for device trust |

### Dev harness

These endpoints expose restart support only for gateways launched through `npm run dev:harness`. The harness marks the child gateway with `BOBBIT_DEV_HARNESS=1`; ordinary `npm start` and `npm run dev` runs do not set it.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/harness-status` | Returns `{ restartAvailable: boolean }`. The Settings page uses this to decide whether to render the **Restart Server** button. |
| `POST` | `/api/harness/restart` | Requests a harness rebuild/restart. Returns `202 { ok: true, restartRequested: true }` under the dev harness, and `403 { error: "Restart is only available under the dev harness" }` otherwise. |

`POST /api/harness/restart` is gated on the server, not just hidden by the UI. On success it touches `.bobbit/state/gateway-restart`, the same sentinel used by `npm run restart-server`; the harness observes that file change, rebuilds the server, and relaunches the gateway.

### Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions` | List sessions. Supports `?since=N` generation counter for conditional fetch. `?include=archived` adds archived rows; `q` filters the archived corpus by title/role before pagination. Response includes `archivedDelegates` array (see below). See [Archived session list and query search](#archived-session-list-and-query-search) |
| `POST` | `/api/sessions` | Create a session (normal, delegate, or with role/traits/assistant type/reattemptGoalId). Standard sessions use the [default role contract](#standard-session-role-resolution). |
| `POST` | `/api/sessions/:id/fork` | Fork a live session: clone its transcript (+ tool-content / proposal drafts) into a new session and preserve its context. Body `{ newWorktree?: boolean }` (default `true`). See [Fork session endpoint](#fork-session-endpoint) |
| `POST` | `/api/sessions/:id/restart` | Restart a live session's agent process in place. Body `{ force?: boolean }`. See [Restart session agent endpoint](#restart-session-agent-endpoint) |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Terminate a session |
| `PATCH` | `/api/sessions/:id` | Update session properties (title, colorIndex, preview, roleId, traits, assistantType, goalId) |
| `PUT` | `/api/sessions/:id/title` | Rename a session (legacy endpoint) |
| `POST` | `/api/sessions/:id/wait` | Block until session becomes idle, then return output |
| `POST` | `/api/sessions/:id/prompt` | Prompt or steer any live target session. Body `{ message, mode?: "prompt" | "steer" }`; default mode is `"prompt"`. Successful responses include display metadata as `target: { sessionId, title? }`. Requires a caller session secret whose allowed tools include `session_prompt`; targets are otherwise arbitrary live sessions. Returns `409 { code: "GOAL_PAUSED" }` when the target session's goal is paused (sessions with no associated goal are unaffected). See [Session prompt tools](session-prompt-tools.md). |
| `POST` | `/api/sessions/:id/mark-read` | Record that the user viewed this session. Sets `lastReadAt = Date.now()` on the persisted session row; clients compare `lastActivity > lastReadAt` to render the unseen-activity dot. Works on live, dormant, and archived sessions. See [docs/internals.md — Read/unread state](internals.md#readunread-state). 404 if the session id is unknown. |
| `POST` | `/api/sessions/:archivedId/continue` | Create a new session whose agent CLI rehydrates from a clone of the archived `.jsonl` while preserving user-visible transcript content losslessly. See [Continue-Archived endpoint](#continue-archived-endpoint) |
| `GET` | `/api/sessions/:id/output` | Get final assistant output from the last turn |
| `GET` | `/api/sessions/:id/draft?type=:type` | Read a persisted UI draft. Missing drafts return `404` by default; `optional=1` returns empty `204` for expected absence when the session exists. |
| `GET` | `/api/sessions/:id/git-status` | Read-only Git status for the session working directory (branch, upstream, ahead/behind, dirty files). Never publishes or updates a remote branch. |
| `GET` | `/api/sessions/:id/commits` | Commit list for the session branch. Supports `direction=behind` and `vs=primary`; includes changed files for each commit. See [Git commit lists and commit-scoped diffs](#git-commit-lists-and-commit-scoped-diffs) |
| `GET` | `/api/sessions/:id/git-diff` | Unified diff for the working tree, or for one committed file when `commit=<sha>&file=<path>` is supplied. See [Git commit lists and commit-scoped diffs](#git-commit-lists-and-commit-scoped-diffs) |
| `GET` | `/api/sessions/:id/pr-status` | PR status for session's branch (via `gh pr view`). Missing PRs return `404` by default; `optional=1` returns empty `204` when the session exists. |
| `POST` | `/api/sessions/:id/bg-processes` | Start a background process and return its `BgProcessInfo` snapshot |
| `GET` | `/api/sessions/:id/bg-processes` | List active/exited background process snapshots for REST hydration |
| `GET` | `/api/sessions/:id/bg-processes/:pid/wait` | Long-poll until a background process exits, times out, or is interrupted |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid?action=kill` | Terminate a running process (whole tree / group); keep the now-terminal record until dismissed. `{ ok, killed }`; 404 if not found/not running |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid?action=dismiss` | Remove the record **and** delete its persisted log/status/spool files; broadcasts `bg_process_dismissed`. `{ ok }`; 409 if still running |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid` | Legacy: kill-if-running, else dismiss |
| `GET` | `/api/sessions/:id/cost` | Persisted cumulative token usage and cost for a single session. Returns 404 when no cost record exists. Response includes `cacheHitRate: number \| null`. See [session-cost.md](session-cost.md) and [Cache-hit rate](cache-hit-rate.md). |
| `GET` | `/api/sessions/:id/cost/breakdown` | Session cost plus delegate-session breakdown, used by the session cost popover; cost objects include `cacheHitRate: number \| null`. |
| `GET` | `/api/sessions/:id/tool-content/:messageIndex/:blockIndex` | Lazy-load full tool input content for a truncated block (see [Large content truncation](#large-content-truncation)) |
| `GET` | `/api/sessions/:id/transcript` | Paginated, regex-filterable transcript reader. Backs the `read_session` tool. Query params: `offset` (negative = from end), `limit` (default 20, clamped 1..200), `pattern`, `case_sensitive`, `context` (±5 max), `verbose`, `include_tool_results` / `includeToolResults`. Direct REST remains backward-compatible: omitted include flag keeps tool results unredacted; pass false/0 to redact. `read_session` passes false by default. Errors: `session_not_found` (404), `transcript_unavailable` (404), `invalid_regex` / `invalid_params` (400). See [Transcript reads and tool-result redaction](read-session.md). |
| `GET` | `/api/sessions/:id/transcript/before-compaction` | Paginated read of the orphaned pre-compaction entries for a single compaction event. Query params: `compactionId` (required, sidecar entry id), `cursor` (from previous response's `nextCursor`), `limit` (default 50, clamped 1..200). Response envelope `{ total, returned, nextCursor, messages[] }`. Requires normal bearer/session authentication, then resolves the target session across gateway-accessible projects; any authenticated same-gateway caller that can reach the target session may read it, matching `read_session` / `GET /api/sessions/:id/transcript`. Errors: `session_not_found` (404), `transcript_unavailable` (404), `compaction_not_found` (404), `invalid_params` (400), `internal_error` (500). Branch-split via the sidecar's `firstKeptEntryId`; legacy fallback scans the JSONL for an inline `type:"compaction"` marker. Reader: `readOrphanedBeforeCompaction` in `src/server/agent/transcript-reader.ts` using the target session's sandbox-aware transcript read path. See [docs/compaction-history.md](compaction-history.md). |
| `POST` | `/api/sessions/:id/provider-hooks/before-prompt` | Per-turn lifecycle dispatch, called only by the generated provider-bridge pi extension. Body `{ prompt?, turn?: { index } }`. Dispatches the `beforePrompt` hook and returns `{ content, tail, blocks }` — `content` is the fenced dynamic-context text delivered by the bridge as a hidden `bobbit:dynamic-context` custom/user-side message (or `""`), `tail` is temporary legacy system-prompt-tail back-compat for old bridges, and `blocks` is metadata-only `{ id, providerId, title, tokenEstimate }[]`. The endpoint also refreshes the prompt inspector's Dynamic Context snapshot best-effort; current bridges consume `content` and filter stale persisted dynamic-context custom messages from future LLM contexts instead of using `message_end` scrub. `404` for unknown session; `{ content: "", tail: "", blocks: [] }` when no Lifecycle Hub is configured. See [docs/lifecycle-hub.md](lifecycle-hub.md#per-turn--lifecycle-wiring-g14). |
| `POST` | `/api/sessions/:id/provider-hooks/before-compact` | Per-turn dispatch from the provider-bridge extension before transcript compaction. Dispatches `beforeCompact` and returns `{}` once provider flushes settle (bounded by per-provider timeouts). `404` for unknown session. |
| `GET` | `/api/sessions/:id/context-trace?limit=N` | Per-turn provider-dispatch trace for diagnostics. Returns `{ entries }` oldest→newest from `ContextTraceStore`; `limit` keeps the most recent N (clamped to 1000). Each entry records the hook, timestamp, and per-provider timing / blocks-kept / omitted / error. See [docs/lifecycle-hub.md](lifecycle-hub.md#the-trace-store). |
| `GET` | `/api/sessions/:id/google-code-assist/token` | Short-lived runtime material for the agent-side Code Assist (`google-gemini-cli`) provider extension: `{ accessToken, projectId }`. Refreshes the stored Google OAuth token per request; **never** returns the OAuth refresh token. `401 { code: "GOOGLE_CODE_ASSIST_REAUTH" }` when no account is signed in or the token can't be refreshed (prompts re-auth, not an API key); `502 { code: "GOOGLE_CODE_ASSIST_PROJECT" }` when the token is valid but project onboarding failed. `projectId` honors `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` when set. See [Google OAuth & Gemini models](google-oauth-models.md#per-request-token--project-endpoint). |

### Standard session role resolution

`POST /api/sessions` resolves a standard session's role before initial setup. The
server owns this default so quick-create buttons, keyboard shortcuts, project and
goal actions, Headquarters, and direct API clients all spawn the same agent even
when they omit `roleId`. Resolving before spawn also prevents a session from
merely displaying **General** while missing that role's runtime configuration.

After resolving the request's project, standard creation normalizes `roleId` as
follows:

| `roleId` input | Result |
|---|---|
| Omitted, `null`, or a string that is empty after trimming | Resolve `general` in the selected project's role cascade. |
| Non-empty string | Trim and resolve that explicit role; it is not replaced by `general`. Unknown roles return `404`. |
| Present, non-`null`, non-string value | Return `400 { "error": "roleId must be a string or null" }` without creating a session. |

The resolved role enters the shared setup pipeline for both worktree and
non-worktree sessions. Its prompt template and substitutions, effective tool
policies, model and thinking defaults, and accessory are therefore applied to
the first agent process. The role and accessory are also written to live state
and the persisted session record; the create response, session detail, and
session list consequently report `role: "general"` for the default case.
Project-scoped overrides win through the normal [config cascade](internals.md#config-cascade).

This default is intentionally narrow:

- Assistant sessions keep their assistant-type role mapping when no role is
  requested.
- Delegate creation exits through its own role-mapping path before this standard
  default is applied.
- Team and staff spawners keep their explicit, separately managed role mappings.
- Existing persisted sessions with no role are not rewritten. The rule applies
  only when creating a new standard session; later role management, including
  removing a role in **Modify Session**, is unchanged.

See [Sidebar Actions Menu — Session role controls](sidebar-actions-menu.md#session-role-controls)
for the creation and modification UI boundary.

### Transcript reader and `read_session`

`GET /api/sessions/:id/transcript` and the `read_session` tool share the same transcript reader but use different defaults. Direct REST calls keep the legacy behavior and leave tool results unredacted when `include_tool_results` / `includeToolResults` is omitted. Pass `include_tool_results=false`, `includeToolResults=false`, or `0` to get the redacted shape. The agent-facing `read_session` tool always sends the include flag and defaults it to false, so tool result bodies are omitted unless the agent passes `include_tool_results: true`.

`verbose` changes compact summaries into full content blocks; it does not override result-body redaction. For `read_session`, `verbose: true` still omits tool result bodies unless `include_tool_results: true` is also set. Either flag is context-heavy at the agent-tool layer and requires an explicit integer `limit` from 1 through 10; rejected tool calls return `CONTEXT_HEAVY_LIMIT_REQUIRED` without reaching this route. Direct REST and other programmatic callers retain the endpoint's existing limits and behavior. Use `pattern`, `context`, `offset`, and `limit` to find a large output first, then fetch narrow batches while monitoring token consumption. Redacted placeholders carry metadata such as tool name/id, status, and size or line counts. See [Transcript reads and tool-result redaction](read-session.md) for examples and response details.

### Archived session list and query search

`GET /api/sessions?include=archived` keeps the live session list in the same response and adds archived sessions from visible project contexts. This powers Show Archived and the sidebar's server-backed archived filter; see [Sidebar Archived Search](sidebar-archived-search.md).

Query parameters:

| Parameter | Meaning |
|---|---|
| `include=archived` | Enables archived session rows. Without it, only live sessions are returned, plus `archivedDelegates` needed for live nesting. |
| `q` | Optional archived-only search query. The server trims and lowercases it, then applies case-insensitive substring matching to archived session `title` and `role`. Live sessions are not filtered by this parameter. |
| `limit` | Optional archived page size, clamped to `1..200`. When present, pagination metadata is returned for the matching archived corpus. |
| `after` | Optional `archivedAt` cursor from the previous response's `nextCursor`; returns older matching archived rows. |
| `projectId` | Optional project filter applied to live and archived rows. |

With `limit`, the response shape is:

```ts
{
  generation: number,
  sessions: GatewaySession[],
  total: number,
  hasMore: boolean,
  nextCursor?: number,
  archivedDelegates: GatewaySession[]
}
```

`total`, `hasMore`, and `nextCursor` describe only the filtered archived corpus. `sessions` contains the current live sessions followed by the requested archived page, so clients that need only archived results should filter for `archived === true` or `status === "archived"`. `q` is applied before pagination so older matching archived sessions can be found without loading non-matching pages.

### Side-panel workspace

The side-panel workspace endpoints persist the right-side panel tab set for a session: open tabs, active tab, tab order, and size mode. The server workspace is authoritative; closed tabs are absence and are not re-derived from render/content caches or localStorage. See [Side-panel workspace](side-panel-workspace.md) for the full lifecycle and identity rules.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/side-panel-workspace` | Return the canonical workspace, creating an empty default (`tabs: []`, `activeTabId: ""`, `sizeMode: "split"`, `revision: 0`) if none was persisted. |
| `POST` | `/api/sessions/:id/side-panel-workspace/open` | Validate and upsert a tab by id. Body `{ tab, focus?, placeAfterActive?, baseRevision?, baseActiveTabId?, strictRevision? }`. Opening an already-open id updates/focuses that tab instead of duplicating it. When an open request is rebased over a newer workspace revision, `baseActiveTabId` lets the server detect that another device changed the active tab and open/update without stealing focus. |
| `PATCH` | `/api/sessions/:id/side-panel-workspace/tabs/:tabId` | Patch an already-open tab. Body may be `{ patch }` or direct `title` / `label` / `source` / `state` fields. Returns `404 TAB_NOT_FOUND` for a closed/missing tab; this route never creates tabs. |
| `DELETE` | `/api/sessions/:id/side-panel-workspace/tabs/:tabId` | Close a tab. Missing tabs are idempotent; underlying preview/proposal/review/pack/inbox content is preserved for explicit reopen. |
| `POST` | `/api/sessions/:id/side-panel-workspace/active` | Body `{ activeTabId }`. The id must be open, or empty. |
| `POST` | `/api/sessions/:id/side-panel-workspace/reorder` | Body `{ tabIds, baseRevision }`; `If-Match: <revision>` is also accepted. The request must include each open tab exactly once. Stale revisions return `409` with the latest workspace. |
| `POST` | `/api/sessions/:id/side-panel-workspace/resize` | Body `{ sizeMode }`, where size mode is `collapsed`, `split`, or `fullscreen`. |
| `POST` | `/api/sessions/:id/side-panel-workspace/migrate` | One-time import from legacy localStorage keys. Ignored once the workspace has tabs or `metadata.migratedFromLocalStorageAt`. |

Each committed mutation increments `revision`, persists on the session record, and emits `side_panel_workspace` on the session WebSocket.

### Restart session agent endpoint

`POST /api/sessions/:id/restart` restarts the live agent process for an existing session. It is the REST contract behind the sidebar hamburger action labeled exactly `Refresh agent`.

This endpoint exists alongside the active-session WebSocket `restart_agent` command. The WebSocket command is scoped to the session socket that sends it; the REST endpoint accepts an explicit `:id`, so sidebar actions can refresh an inactive row without switching the open chat. Both paths call `SessionManager.restartAgent(sessionId)`.

Request body (optional):

```json
{ "force": false }
```

- Omit the body, omit `force`, or send `force: false` for an idle session.
- Send `force: true` only after user confirmation when the session is `busy`, `streaming`, or compacting. Without force, those states return `409 SESSION_BUSY`.

Success returns `200`:

```json
{ "ok": true, "sessionId": "session-id" }
```

Restart is in-place. It preserves the session id, transcript/history, persisted session metadata, and any connected WebSocket clients. The manager stops the existing process, restores the persisted session, reattaches clients, and switches the new process back to the existing transcript file. The restore path rebuilds the session prompt, tool definitions, tool activation, MCP proxy/guard extensions, MCP-backed tool surface, MCP server configuration/auth state, and per-session environment from the current server-side managers and config.

For normal role-derived sessions, restart recomputes allowed tools from the current role/tool/group/MCP policy cascade instead of reusing the previous live allow-list. This is why an MCP group changed from `never` to `ask` or `allow` takes effect after `Refresh agent`. Persisted session allow-list constraints and live `session-only` / `one-time` grants are still carried across where appropriate, and explicit role-level `never` policies still take precedence over group defaults.

Stable error codes:

| Status | Code | Meaning |
|---|---|---|
| `404` | `SESSION_NOT_FOUND` | No live restartable session exists for `:id`, including missing, archived, or terminated sessions. |
| `403` | `SESSION_NOT_RESTARTABLE` | The session is read-only or non-interactive. |
| `409` | `SESSION_BUSY` | The session is `busy`, `streaming`, or compacting and the request did not include `{ "force": true }`. |
| `500` | `RESTART_ERROR` or a manager-provided code | Restart was accepted but the session manager could not respawn the process. The response still uses the standard `{ error, code }` shape. |

Clients should surface 5xx restart failures visibly rather than silently retrying. A manager-provided restart code, such as an unrecoverable archived-zombie condition, should be displayed or logged with the human-readable `error`.

See [Sidebar Actions Menu — Refresh agent](sidebar-actions-menu.md#refresh-agent) for the user-facing behavior.

### Fork session endpoint

`POST /api/sessions/:id/fork` forks a live source session into a new session that **rehydrates from a clone of the source's conversation history** (the same lossless `.jsonl` clone + `switch_session` mechanism as [Continue-Archived](#continue-archived-endpoint)). It is the contract behind the sidebar **Fork** action, so the server reads the persisted session record instead of trusting the browser to reconstruct context.

Request body (optional):

```json
{ "newWorktree": true }
```

- `newWorktree: true` (default when omitted) — create a fresh worktree/branch off the project repo (a plain project-root session when the project isn't a git repo).
- `newWorktree: false` — reuse the source session's existing worktree directly. The fork's `cwd` is set to the source's `worktreePath` and **no** new worktree is created; the two live sessions intentionally share the worktree/branch. The fork does not register worktree metadata, so terminating either session never tears down the shared tree. When the source has no worktree, the fork reuses the project-root cwd.

Success returns `201`:

```json
{
  "id": "new-session-id",
  "cwd": "/repo-or-worktree",
  "status": "idle",
  "projectId": "project-id",
  "goalId": "goal-id",
  "title": "Fork: Source title"
}
```

`goalId` is omitted when not applicable. The new session title is `Fork: <source title>` (`markGenerated`, so the first prompt's auto-titler won't overwrite it).

The fork clones the source `.jsonl` transcript and copies its tool-content cache and proposal drafts, then preserves project id, goal id, task id, reattempt goal id, staff id, role/accessory context, sandbox setting, allowed tools, and selected model.

Unsupported sources return `422`: archived, terminated, delegate, child, read-only, team-lead, or team-member sessions. Missing persisted sessions return `404`; sources whose project or goal no longer exists return `410`; a missing/empty source transcript returns `404`; a cross-realm clone returns `422`.

See [Sidebar Actions Menu](sidebar-actions-menu.md#fork-session-endpoint) for the user-facing behavior.

### Background processes

Background process snapshots use epoch-millisecond timestamps so clients can render runtime without depending on page load time:

```ts
type BgProcessInfo = {
  id: string;
  name: string;
  command: string;
  pid: number;
  // "unrecoverable" = the live outcome was lost across a gateway restart (output is still retained).
  status: "running" | "exited" | "unrecoverable";
  exitCode: number | null;
  // Why the process reached a terminal state; null while running. Authoritative for UI rendering.
  // "normal" → real exitCode; "killed" → user kill (exitCode usually null); "unrecoverable" → lost
  // across a restart (exitCode null, never fabricated). Optional/undefined for legacy snapshots.
  terminalReason?: "normal" | "killed" | "unrecoverable" | null;
  startTime: number;
  endTime: number | null;
};
```

`endTime` is `null` while `status === "running"`. On child exit the server sets `endTime` once, and list / wait snapshots preserve that final value so reloads and reconnects keep showing the fixed `endTime - startTime` runtime.

- `POST /api/sessions/:id/bg-processes` returns `201 BgProcessInfo` for the created process.
- `GET /api/sessions/:id/bg-processes` returns `{ processes: BgProcessInfo[] }` for UI hydration. Background processes survive a gateway restart — this list is rehydrated from the on-disk store and re-attached processes keep streaming. See [docs/bg-process-persistence.md](bg-process-persistence.md).
- `GET /api/sessions/:id/bg-processes/:pid/wait` returns `{ info: BgProcessInfo, timedOut: boolean, aborted: boolean }`; `info.endTime` is numeric after exit and remains `null` for running timeout/abort snapshots.

Older exited snapshots may omit `endTime` or set it to `null`. Clients must render those runtimes as unknown/non-growing instead of substituting `Date.now()` for an exit timestamp.

**WS events.** `bg_process_created` / `bg_process_output` carry the running snapshot and streamed output; `bg_process_exited` carries `processId`, `exitCode`, `endTime`, and `terminalReason` (the authoritative terminal field — `exitCode` is `null` for `killed`/`unrecoverable`); `bg_process_dismissed` carries `{ processId }` so all clients drop the pill when a process is dismissed.

### Proposal drafts

In-flight `propose_*` payloads are mirrored to `.bobbit/state/proposal-drafts/<sessionId>/<type>.{md,yaml}` so the agent can tweak them via `view_proposal` / `edit_proposal` without re-emitting the full payload. The file is the source of truth for proposal draft content; the in-memory client slot (`state.activeProposals[type]`) is a parsed content projection. Side-panel tab presence is controlled separately by the server-backed workspace. See [docs/internals.md — Editable proposals](internals.md#editable-proposals) and [docs/design/editable-proposals.md](design/editable-proposals.md).

`<type>` is one of `goal | project | role | tool | staff`. `goal` files are markdown with YAML frontmatter; the others are native YAML.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/proposal/:type` | Read the raw proposal file body. `200` with `text/markdown` (goal) or `application/yaml` (others). `404 {ok:false, code:"FILE_NOT_FOUND", message}` if no draft. |
| `GET` | `/api/sessions/:id/proposal/:type/snapshot?rev=N` | Read a historical revision without mutating the live draft. Parses `<type>.history/<rev>.<ext>` through the per-type plugin and returns `200 {ok:true, rev, fields}`. Does not broadcast `proposal_update` and does not update `state.activeProposals`. `400 {ok:false, code:"INVALID_BODY"}` for invalid rev; `404 {ok:false, code:"SNAPSHOT_NOT_FOUND", message}` if the snapshot file is missing; `400` with `ParseError` shape if the snapshot fails to parse. Used by read-only historical proposal tabs. |
| `POST` | `/api/sessions/:id/proposal/:type/seed` | Called by `propose_*` tool `execute()`. Body `{ args: <propose-args object> }`. Serialises args via the per-type plugin, atomically writes the file, parses, attempts to open/focus `proposal:<type>` in the side-panel workspace, then broadcasts `proposal_update {source:"seed", rev}`. `200 {ok:true, rev}` on success; `400` with structured error on parse/validate failure. For `type=goal`, the named `workflow` and `options` are validated against the project's workflows **before** writing. When project workflows are resolvable and non-empty, omitted, empty, or whitespace-only `workflow` is rejected with `400 {ok:false, code:"MISSING_WORKFLOW", message, availableWorkflows: [{ id, name }]}` so agents can retry with a valid workflow. Unknown values are rejected with `400 {ok:false, code:"UNKNOWN_WORKFLOW", availableWorkflows}` or `400 {ok:false, code:"UNKNOWN_OPTIONAL_STEP", validOptionalSteps}`. A rejected goal workflow seed writes no draft, creates no rev, emits no `__proposal_rev_v1__` success marker, and broadcasts no `proposal_update`; the real `propose_goal` tool call must persist/broadcast an errored tool result (`isError: true`) so the UI can render/open the failed attempt from the transcript tool-call input plus the validation result. Workflow validation is skipped only when there are genuinely no resolvable workflows. See [goals-workflows-tasks.md — Validating a proposed workflow at proposal time](goals-workflows-tasks.md#validating-a-proposed-workflow-at-proposal-time). |
| `POST` | `/api/sessions/:id/proposal/:type/edit` | Surgical content edit. Body `{ old_text: string, new_text: string }`. Exact-string replacement, first-and-only-occurrence rule, empty `new_text` deletes. On success: writes atomically, broadcasts `proposal_update {source:"edit", rev}`, returns `200 {ok:true, newContent, rev}`. Does not open or focus side-panel tabs; already-open proposal tabs refresh from the content slot. On failure: file unchanged, returns 4xx with structured error. |
| `POST` | `/api/sessions/:id/proposal/:type/restore` | Mutating rollback endpoint for explicit API restore flows. Body `{ rev: number }` (positive integer). Copies `<type>.history/<rev>.<ext>` back to the live draft AND writes a NEW snapshot at `currentRev+1` so the rollback appears in the timeline. Attempts to open/focus `proposal:<type>` in the side-panel workspace, then broadcasts `proposal_update {source:"restore", rev: newRev}`. `200 {ok:true, newRev, fields}` on success; `400 {ok:false, code:"INVALID_BODY"}` if `rev` is not a positive integer; `404 {ok:false, code:"SNAPSHOT_NOT_FOUND", message}` if the requested snapshot file is missing; `400` with `ParseError` shape if the snapshot fails to parse. Historical chat-card tabs use `GET /snapshot` instead so browsing old revisions is non-mutating. |
| `DELETE` | `/api/sessions/:id/proposal/:type` | Delete the draft. Broadcasts `proposal_cleared`. `204` on success (idempotent — `204` even if the file was absent). Called by accept handlers after a successful save. The per-session `<type>.history/` directory is cleaned with the rest of the per-session draft dir on the 7-day purge (deferred from archive so the [archived-proposal-reopen flows](archived-proposal-reopen.md) can read drafts after the source session is archived). |
| `GET` | `/api/sessions/:id/proposals` | List every parsed proposal draft for the session in one call. Returns `200 { proposals: Array<{ proposalType, fields, rev }> }`; `proposals` is empty when the per-session directory is absent or empty. Mirrors the WS `proposal_update {source:"rehydrate"}` broadcast as a one-shot REST call — used by fast-path session switch-backs (no fresh WS auth, so the broadcast doesn't run) and by the archived-session footer to decide whether to surface a "Resubmit `<type>` proposal" button (see [docs/archived-proposal-reopen.md](archived-proposal-reopen.md)). This is content hydration only and does not open or focus side-panel tabs. `400` on invalid sessionId; `500` on unexpected enumeration failure. |

#### Error response shape

Structured proposal validation failures share this JSON shape across seed, edit, snapshot, and restore where parsing/validation applies:

```json
{
  "ok": false,
  "code": "YAML_PARSE_ERROR",
  "message": "<human-readable detail, ≤ 1 KB>",
  "line": 12,
  "col": 5,
  "field": "components"
}
```

`line`, `col`, and `field` are optional and present when the underlying validator supplies them.

#### Structured error codes

| Code | Status | Endpoint(s) | When |
|---|---|---|---|
| `INVALID_BODY` | `400` | edit, seed, snapshot, restore | Body/query is not JSON where required, or required keys/params are wrong type. |
| `FILE_NOT_FOUND` | `404` | GET, edit | No prior `propose_<type>` in this session. The `message` names the matching `propose_*` tool. |
| `SNAPSHOT_NOT_FOUND` | `404` | snapshot, restore | Requested `<type>.history/<rev>.<ext>` file is missing. |
| `OLD_TEXT_NOT_FOUND` | `400` | edit | `old_text` does not occur in the file. |
| `OLD_TEXT_NOT_UNIQUE` | `400` | edit | `old_text` matches multiple times — ambiguous. Caller must extend `old_text` with surrounding context. |
| `FRONTMATTER_MALFORMED` | `400` | edit, seed | `goal.md` frontmatter fence is broken or unparseable. |
| `YAML_PARSE_ERROR` | `400` | edit, seed | Post-edit YAML body fails to parse. |
| `MISSING_REQUIRED_FIELD` | `400` | edit, seed | Per-type required-field whitelist failed (`field` set). |
| `MISSING_WORKFLOW` | `400` | goal seed | Project workflows exist but `propose_goal.workflow` was omitted, empty, or whitespace-only. Response includes `availableWorkflows` when known. |
| `UNKNOWN_WORKFLOW` | `400` | goal seed | `propose_goal.workflow` is not one of the linked project's workflow IDs. Response includes `availableWorkflows` when known. |
| `UNKNOWN_OPTIONAL_STEP` | `400` | goal seed | `propose_goal.options` names a step that is not an optional verify step on the selected workflow. Response includes `validOptionalSteps` when known. |
| `STRUCTURAL_VALIDATION_FAILED` | `400` | edit, seed | Project YAML fails the structural validator shared with `PUT /api/projects/:id/config`. |

**Atomic rollback.** Any failure in `edit` or `seed` after the per-type parse step leaves the file on disk byte-for-byte identical to its pre-call state — the implementation writes to `<file>.tmp` and `fs.rename`s only after parse + validate succeed. A failed edit followed by `GET` returns the original body unchanged.

**Path safety.** `:id` is validated against `/^[A-Za-z0-9_-]+$/` and `:type` against the union literal; invalid values return `400 {error:"Unknown proposal type: ..."}` before any disk access.

**Restart survival.** On WS attach, `src/server/ws/handler.ts` enumerates the per-session directory and re-emits one `proposal_update {source:"rehydrate", rev}` per surviving file (where `rev` is computed from the highest integer in the `<type>.history/` dir, or `0` for legacy sessions predating the snapshot system), so reloading a browser or restarting the server mid-edit yields the same proposal content without a separate content persistence layer. Rehydrate does not open tabs; the side-panel workspace remains authoritative for whether `proposal:<type>` is present. Failed goal workflow-validation attempts are the exception: because no file/rev exists, their reopen metadata is recovered from the persisted transcript tool call/result rather than from this endpoint.

**Revision snapshots.** Every successful `seed` and `edit` write also writes an immutable per-rev snapshot under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/<rev>.<ext>` (filename grammar `^(\d+)\.(md|yaml)$`; integer rev parsed back from filenames — no metadata file). The server stamps the resulting `rev` on every `proposal_update` WS event (single source of truth — the client overwrites `slot.rev` with the server value, never increments locally). Snapshot-write failures are non-fatal: the live draft is committed and the broadcast carries `rev: 0`, which the client treats as "snapshot system unavailable". Chat-card "Open proposal" buttons parse the `__proposal_rev_v1__:<n>` marker and, for older revisions, call the non-mutating `GET /snapshot` endpoint to populate read-only historical tabs. The mutating `restore` endpoint remains available for explicit rollback flows but is not used for ordinary history browsing. Full design: [docs/design/proposal-revision-snapshots.md](design/proposal-revision-snapshots.md).

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
| `GET` | `/api/goals` | List goals. `?archived=true` returns archived goals with an `archivedSessions` field; `q` filters archived goals by goal title or affiliated session title/role before pagination. Supports `?since=N` generation counter for conditional fetch. See [Archived goal list and query search](#archived-goal-list-and-query-search) |
| `POST` | `/api/goals` | Create a goal (`{ title, cwd, spec, projectId?, team?, worktree?, reattemptOf?, metadata? }`). `metadata` is an optional arbitrary, namespaced key/value object persisted on the goal and inherited by all its sessions and sub-goals; accepted only when it is a non-empty plain object. `projectId: "headquarters"` is valid; with `worktree: false`, a Headquarters goal can run data-only with no branch/worktree. See [Hierarchical goal metadata](design/goal-metadata.md). |
| `GET` | `/api/goals/:id` | Get a goal |
| `PUT` | `/api/goals/:id` | Update a goal (title, cwd, state, spec, team, repoPath, branch, reattemptOf) |
| `PUT` | `/api/goals/:id/workflow` | Replace the goal's complete frozen workflow snapshot, validate it, and reconcile gate state. See [Goal workflow replacement](#goal-workflow-replacement). |
| `DELETE` | `/api/goals/:id` | Delete a goal and its tasks |
| `GET` | `/api/goals/:id/commits` | Commit history for goal branch (excludes primary branch commits); includes changed files for each commit. No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. See [Git commit lists and commit-scoped diffs](#git-commit-lists-and-commit-scoped-diffs) |
| `GET` | `/api/goals/:id/git-status` | Read-only Git status for the goal worktree (branch, ahead/behind primary, clean). Never publishes or updates a remote branch. No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. |
| `GET` | `/api/goals/:id/git-diff` | Unified diff for the goal worktree, or for one committed file when `commit=<sha>&file=<path>` is supplied. No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. See [Git commit lists and commit-scoped diffs](#git-commit-lists-and-commit-scoped-diffs) |
| `GET` | `/api/goals/:id/cost` | Aggregate cost across all sessions linked to a goal (includes `cacheHitRate`) |
| `GET` | `/api/goals/:id/cost/breakdown` | Goal aggregate plus per-session breakdown, used by the goal cost popover; cost objects include `cacheHitRate: number \| null`. |
| `GET` | `/api/goals/:id/pr-status` | PR status for goal branch (cached, via `gh pr view`). Missing PRs return `404` by default; `optional=1` returns empty `204` when the goal exists. No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. |
| `GET` | `/api/goals/:id/github-link` | PR URL or sanitized GitHub branch fallback. No-worktree goals return `200 { available: false, reason: "no-worktree", message }`. Still available, but the sidebar `Open on GitHub` item now mirrors the goal-row PR badge instead of gating on this endpoint. See [Goal GitHub link endpoint](#goal-github-link-endpoint) |
| `POST` | `/api/goals/:id/pr-merge` | Merge PR for goal branch (`{ method? }`). No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. |
| `POST` | `/api/goals/:id/integrate-child/:childId` | Locally merge a direct child's branch into the parent and auto-archive it on success. Body `{ force?: boolean }`. Never pushes either branch. See [Child-goal integration](#child-goal-integration). |

### Child-goal integration

`POST /api/goals/:id/integrate-child/:childId` is the REST contract behind
`goal_merge_child`. It runs `git merge --no-ff` in the parent worktree. For a
multi-repo goal, it merges every matching component worktree and includes a
`repos` map keyed by component repo. The operation may fetch the child ref
best-effort, but it does not push the parent or child branch; publication is a
separate explicit user, agent, Ready-to-Merge, or PR action.

By default, the child's `ready-to-merge` gate must have passed. Send
`{ "force": true }` to bypass that check for a workflow without the gate or
a manually approved recovery. Parent/child identity is enforced; cross-tree
merges return `400 PARENT_MISMATCH`.

A clean or already-complete merge returns `200`:

```json
{
  "merged": true,
  "alreadyMerged": false,
  "conflict": false,
  "output": "Merge made by the 'ort' strategy."
}
```

`repos` is omitted for a single-repo goal. A clean or already-merged result
tears down the child's team and archives the child. A conflict aborts the Git
merge, preserves the child, and returns `409` with
`{ merged: false, alreadyMerged: false, conflict: true, output, repos? }`.
A missing/unpassed gate returns `409 RTM_NOT_PASSED`; goals without usable Git
worktrees return `409 GOAL_GIT_UNAVAILABLE`. Responses intentionally omit the
legacy `pushed` field because integration has no remote side effect.

### Goal workflow replacement

`PUT /api/goals/:id/workflow` replaces an existing goal's **entire frozen workflow snapshot**. This is a general workflow mutation endpoint, not a timeout-specific patch: callers send the complete workflow definition and may change its name, description, gates, dependencies, gate metadata, or verification steps. The workflow id is immutable. If the body includes `id`, it must equal the current snapshot id; the server preserves the snapshot's `id`, `createdAt`, and `hidden` fields and stamps a new `updatedAt`.

The body uses the same workflow shape and full-definition validator as project workflow authoring. It must be a plain object with a non-empty `name` and `gates` array. Validation covers gate and step shape, unique gate ids, dependency references and cycles, component/command references, subgoal dependencies, and finite positive-integer `timeout` values. Replacement is atomic: validation and conflict checks happen before either the goal or gate store is changed.

On success, the server persists and returns the normalized workflow snapshot, broadcasts `goal_state_changed`, and reconciles stored gates:

- unchanged gate definitions keep their status, signal history, and cache state;
- changed gate definitions are reset to `pending` and their verification cache is invalidated, while their signal history remains available for audit;
- removed gates and their stored state are deleted;
- newly added gates start as `pending` with empty signal history.

Gate array order is presentation-only for conflict detection. Reordering otherwise-identical gates does not reset them. Changes inside a gate, including its dependencies or `verify` array, count as a gate modification.

To avoid orphaning a live verifier, changing or removing a gate whose verification is currently running returns:

```json
{
  "error": "Workflow cannot modify or remove gates with active verifications",
  "code": "WORKFLOW_ACTIVE_VERIFICATION",
  "gateIds": ["review"]
}
```

The status is `409`, and neither store is mutated. An unrelated gate may still be changed while another gate is verifying. The conflict read and subsequent persistence run without an asynchronous gap, so a new verification cannot interleave after the guard.

Other errors are `400` for a non-object body, a goal without a workflow, an id change, or any workflow validation failure; and `404` for an unknown goal or missing project context.

This endpoint changes only the active goal snapshot. Project workflow endpoints remain the source for future goals; see [Changing a timed-out review allowance](goals-workflows-tasks.md#changing-a-timed-out-review-allowance) for the UI's current/future/both scope behavior.

### Git commit lists and commit-scoped diffs

The git-status widget uses the commit endpoints to explain what changed on a branch before a push, pull, or merge action. The same response shape is used for session-scoped and goal-scoped commit modals so the UI can render expandable commit rows without issuing one request per commit.

`GET /api/sessions/:id/commits` returns commits for the session branch. By default it lists unpushed commits relative to the upstream branch, falls back to recent `HEAD` commits when no upstream exists, supports `direction=behind` for incoming commits, and supports `vs=primary` to compare against the resolved primary ref. `GET /api/goals/:id/commits` returns commits on the goal branch relative to the primary branch when that comparison is available. Goal requests also accept `limit` clamped to the server's safe range.

Response envelope:

```json
{
  "commits": [
    {
      "sha": "9f3c1a8d4e...",
      "shortSha": "9f3c1a8",
      "message": "Add commit file diffs",
      "author": "Ada Developer",
      "timestamp": "2026-06-25T12:34:56.000Z",
      "filesChanged": 2,
      "insertions": 18,
      "deletions": 4,
      "files": [
        { "path": "src/ui/components/GitStatusWidget.ts", "status": "M", "statusLabel": "modified" },
        { "oldPath": "docs/old.md", "path": "docs/new.md", "status": "R", "statusLabel": "renamed" }
      ]
    }
  ]
}
```

`files[]` comes from name-status git output with rename detection enabled. Known status labels are `modified`, `added`, `deleted`, and `renamed`; unknown statuses are preserved and lowercased for display. For renamed files, `oldPath` is the source path and `path` is the destination path. Click targets should request the destination `path`; the diff endpoint includes rename metadata when Git reports it.

`GET /api/{sessions|goals}/:id/git-diff?file=<path>` keeps the existing working-tree diff behavior. Adding `commit=<sha>` switches the endpoint to a commit-scoped diff for that file:

```http
GET /api/sessions/:id/git-diff?commit=9f3c1a8&file=src%2Fui%2Fcomponents%2FGitStatusWidget.ts
GET /api/goals/:id/git-diff?commit=9f3c1a8&file=docs%2Fnew.md
```

The response is `{ "diff": "...unified diff..." }` and uses the same truncation behavior as working-tree diffs, including the truncation marker when the payload exceeds the configured diff size limit. Multi-repo callers may pass `repo=<repoName>` to route the diff to a specific repo worktree when one is registered. The Git status modal parses this raw string client-side with the shared unified-diff parser; see [Git status rich diff viewer](git-status-diff-viewer.md).

Validation and errors:

- `commit` is optional. When present, it must be a 4- to 40-character hexadecimal SHA that resolves to a commit object; otherwise the endpoint returns `400 { "error": "Invalid commit" }`.
- `file` is required for commit-scoped diffs. File paths that are empty, contain traversal (`..`), are POSIX/Windows absolute paths, or start with a Windows drive prefix are rejected with `400 { "error": "Invalid file path" }`.
- If the selected commit/file pair has no diff, the endpoint returns `404 { "error": "No diff found" }`.
- No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE", goalId, projectId, branch: null, worktreePath: null }` for git-dependent goal endpoints instead of falling back to the server checkout. Headquarters responses use copy explaining that the goal runs in the server directory without a git worktree.
- Unknown sessions/goals and missing worktrees use the same not-found responses as the existing git-status and git-diff endpoints.

Verification coverage should include API tests for changed-file response shapes, commit-scoped diffs, invalid commits, invalid paths, and rename records; UI/browser fixture coverage should assert that commit rows expand, file status labels render, the rich diff viewer opens, and clicking a committed file fetches `git-diff` with both `commit` and `file`. Run `npm run check` and `npm run test:unit` for this area; run `npm run test:e2e` when endpoint behavior changes.

### Archived goal list and query search

`GET /api/goals?archived=true` aggregates archived goals across visible project contexts. It is used by Show Archived and by the sidebar's server-backed archived filter; see [Sidebar Archived Search](sidebar-archived-search.md).

Query parameters:

| Parameter | Meaning |
|---|---|
| `archived=true` | Selects archived goals instead of live goals. |
| `q` | Optional archived-goal query. The server trims and lowercases it, then applies case-insensitive substring matching to goal `title`, or to `title` / `role` on an affiliated non-child session. |
| `limit` | Archived page size, default `50`, clamped to `1..200`. |
| `after` | Optional `archivedAt` cursor from the previous response's `nextCursor`; returns older matching archived goals. |
| `projectId` | Optional project filter for archived goals and affiliated sessions considered during matching. |

Response shape:

```ts
{
  goals: Goal[],
  total: number,
  hasMore: boolean,
  nextCursor?: number,
  archivedSessions: GatewaySession[]
}
```

`q` is applied before pagination across the full archived goal corpus. `total`, `hasMore`, and `nextCursor` describe the filtered goal corpus, not the `archivedSessions` side payload. `archivedSessions` contains archived sessions affiliated with goals in the returned page, plus related archived child/delegate rows needed for sidebar nesting.

### Goal GitHub link endpoint

`GET /api/goals/:id/github-link` resolves a PR URL or a sanitized GitHub branch URL for a goal. It remains available, but the sidebar **Open on GitHub** menu item no longer depends on it: that item now mirrors the goal-row PR badge (a PR with a `url` in `prStatusCache`, and a fully-passed gate summary for workflow goals) and opens the PR URL directly. The endpoint is still useful for callers that want a server-sanitized link, including the branch fallback the menu item no longer surfaces.

Success or unavailability both return `200` with a discriminated response:

```ts
type GoalGithubLinkResponse =
  | { available: true; url: string; kind: "pr" | "branch" }
  | { available: false; reason: "no-branch" | "no-worktree" | "no-github-remote" | "goal-not-found"; message?: string };
```

Resolution order:

1. Return the goal's cached PR URL from `PrStatusStore` when present.
2. Otherwise look up PR status for the goal branch using `gh` through `execFile` argument arrays, not shell command strings.
3. If no PR URL exists, read `origin` with `git remote get-url origin` through `execFile`.
4. Strip embedded credentials, accept only GitHub remotes, and build an encoded branch tree URL.
5. Return `available: false` for missing goals, goals without branches/worktrees, missing/non-GitHub remotes, or git lookup failures.

Branch names are never interpolated into a shell command; PR lookup and remote resolution both go through `execFile` argument arrays. See [Sidebar Actions Menu](sidebar-actions-menu.md#github-link-resolution) for how the menu item mirrors the PR badge rather than calling this endpoint.

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
| `GET` | `/api/goals/:id/gates/:gateId/signals` | Return signal history plus optional human-readable goal and gate names. See [Signal history endpoint](#signal-history-endpoint). |
| `GET` | `/api/goals/:id/verifications/active` | Return the goal's in-flight verification snapshots for live UI reconciliation. |
| `POST` | `/api/goals/:id/gates/:gateId/signal` | Signal a gate (`{ status, content?, verifiedBy? }`) |
| `POST` | `/api/goals/:id/gates/:gateId/reset` | Reset the gate plus transitive downstream dependents to `pending`; preserves signal history. See [Gate reset endpoint](#gate-reset-endpoint). |
| `POST` | `/api/goals/:id/gates/:gateId/bypass` | **Human-only.** Force a not-yet-passed gate to `bypassed` (`{ whyBypassed, whoAmI, isInitiatedByHuman: true }`); persists a synthetic audit signal. Never advertised to agents. See [Gate bypass endpoint](#gate-bypass-endpoint). |
| `POST` | `/api/goals/:id/gates/:gateId/cancel-verification` | Cancel a stuck running verification (idempotent) |
| `POST` | `/api/goals/:id/gates/:gateId/signoff` | Resolve a parked `human-signoff` step (`{ signalId, stepName, decision: "pass"\|"fail", feedback? }`); idempotent 409 on already-resolved steps. See [Sign-off endpoint](#sign-off-endpoint). |

### Goal Team

Routes accept both `/team/` and legacy `/swarm/` paths.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals/:id/team` | Get team state for a goal |
| `POST` | `/api/goals/:id/team/start` | Start a team (creates team lead session) |
| `POST` | `/api/goals/:id/team/spawn` | Spawn a role agent (`{ role, task, traits? }`) |
| `POST` | `/api/goals/:id/team/dismiss` | Dismiss a role agent (`{ sessionId }`); returns the structured dismiss result documented below |
| `POST` | `/api/goals/:id/team/steer` | Backward-compatible streaming-only steer for a team agent (`{ sessionId, message }`) |
| `POST` | `/api/goals/:id/team/abort` | Force-abort a stuck team agent (`{ sessionId }`) |
| `POST` | `/api/goals/:id/team/prompt` | Prompt or steer a team agent, owned helper child, or direct-child goal team lead. Body `{ sessionId, message, mode?: "prompt" | "steer", workflowGateId?, inputGateIds? }`; default mode is `"steer"`. Returns `409 { code: "GOAL_PAUSED" }` when the goal is paused (checked before team membership). See [Session prompt tools](session-prompt-tools.md). |
| `GET` | `/api/goals/:id/team/agents` | List agents for a team goal. `?include=archived` also returns archived agents with `teamLeadSessionId`, `teamGoalId`, and `delegateOf` fields |
| `POST` | `/api/goals/:id/team/complete` | Complete a team (dismiss agents, keep team lead). Body `{ confirmBypassedGates?: boolean }` — the agent/MCP path is refused while any gate is `bypassed`; a human confirms with `confirmBypassedGates: true` (403 for sandbox tokens). See [Gate bypass endpoint](#gate-bypass-endpoint). |
| `POST` | `/api/goals/:id/team/teardown` | Fully tear down a team (dismiss all + terminate team lead) |

Restart semantics: boot restores persisted active team entries and re-subscribes their sessions; it does not call `/team/start` implicitly for existing teamless goals. After `/team/teardown`, or after creating a goal with `autoStartTeam: false`, the goal remains teamless across restart and this explicit start route remains the manual recovery path.

### Orchestration routes (child agents)

These back the `team_delegate` / `team_wait` / own-children `team_*` agent tools. `:id` is the
**owner** session; the route resolves the authenticated caller as that owner and enforces that a
target `childSessionId` belongs to the owner (own-children scoping is server-enforced, not
client-trusted). All call the shared `OrchestrationCore` in-process. See
[orchestration.md](orchestration.md).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/orchestrate/children` | List the owner's tracked child agents |
| `POST` | `/api/sessions/:id/orchestrate/spawn` | Non-blocking spawn (single or `parallel`); child inherits the owner's current model unless overridden |
| `POST` | `/api/sessions/:id/orchestrate/delegate` | Blocking one-shot: spawn → wait for **all** → auto-dismiss; drop-in `delegate` parity. Always 2xx; per-child `status` carries success/timeout/failure |
| `POST` | `/api/sessions/:id/orchestrate/prompt` | Prompt or steer an owned child (`{ childSessionId, message, mode?: "prompt" | "steer" }`); default mode is `"steer"` for current tool callers |
| `POST` | `/api/sessions/:id/orchestrate/steer` | Backward-compatible mid-turn steer for an owned child (`409` if the child is not streaming) |
| `POST` | `/api/sessions/:id/orchestrate/abort` | Force-abort an owned child |
| `POST` | `/api/sessions/:id/orchestrate/wait` | Wait for the **first** awaited child to settle (chunked heartbeat, like `/wait`) |
| `POST` | `/api/sessions/:id/orchestrate/dismiss` | Terminate + archive an owned child; returns the structured dismiss result documented below |
| `GET` | `/api/sessions/:id/children-count` | Count + list (`{ count, children: [{ id, title }] }`) the session's live **and dormant/persisted** child agents, using the same predicate as the archive cascade. Backs the non-goal archive confirmation modal's child-agent enumeration |

#### Dismiss response shape

Both dismiss routes return the same structured shape for valid dismiss requests:

```json
{
  "ok": true,
  "status": "dismissed",
  "sessionId": "child-session-id",
  "message": "Child session child-session-id dismissed.",
  "retryable": false
}
```

| `status` | HTTP | Semantics |
|---|---:|---|
| `dismissed` | `200` | Owned live target was terminated and archived. |
| `already-dismissed` | `200` | Owned target is already not live or archived; this is idempotent success and should not be retried. |
| `not-owned` | `403` | Target exists but is not owned by the caller/goal, the caller is not the authentic owner/team lead, or the target is the team lead itself. |
| `not-found` | `404` | No live, persisted, or remembered target exists for that session id. |
| `failed` | `500` | Real termination/archive failure; check `message` and `retryable`. |

For `/api/sessions/:id/orchestrate/dismiss`, the authenticated per-session secret must
resolve to `:id`; otherwise the route returns structured `not-owned`. For
`/api/goals/:id/team/dismiss`, tracked team-agent cleanup is team-lead-only. The same goal
route also supports a team lead's own non-team helper child as a fallback, but only when the
per-session secret resolves to that team lead. See [orchestration.md — `team_dismiss`
outcomes](orchestration.md#team_dismiss-outcomes) for duplicate-dismiss, retry, and UI/tool
semantics.

### Tasks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tasks/:id` | Get a task |
| `PUT` | `/api/tasks/:id` | Update a task (title, spec, state, assignedSessionId, dependsOn, headSha, baseSha, branch, resultSummary) |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `POST` | `/api/tasks/:id/assign` | Assign a task to a session (`{ sessionId }`). Auto-populates `baseSha` and `branch` from the agent's `TeamAgent` record if available |
| `POST` | `/api/tasks/:id/transition` | Transition task state (`{ state }`) |
| `GET` | `/api/tasks/:id/cost` | Cost for the session assigned to a task (includes `cacheHitRate`) |

#### Cost response shape

All three cost endpoints (`/sessions/:id/cost`, `/goals/:id/cost`, `/tasks/:id/cost`) return the same `SessionCost` shape:

```json
{
  "inputTokens": 12500,
  "outputTokens": 340,
  "cacheReadTokens": 87000,
  "cacheWriteTokens": 3200,
  "totalCost": 0.004712,
  "cacheHitRate": 0.874
}
```

- `cacheHitRate` — derived field: `cacheReadTokens / (cacheReadTokens + inputTokens)`. `null` when both counters are 0 (cold session or provider does not report cache tokens). Never stored on disk; recomputed on every read.
- For goals, `cacheHitRate` is derived from the aggregate counters across all linked sessions — not an average of per-session rates.

See [docs/cache-hit-rate.md](cache-hit-rate.md) for full formula and null semantics.

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
| `POST` | `/api/roles` | Create a role (`{ name, label, promptTemplate, toolPolicies?, allowedTools?, accessory?, model?, thinkingLevel? }`). `toolPolicies` is the source of truth for tool access; `allowedTools` is accepted for backward compatibility and merged as `always-allow` entries. `model` is `"<provider>/<modelId>"` format and overrides `default.sessionModel` / `default.reviewModel` for sessions of this role. `thinkingLevel` is one of `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"` (clamped to the role's model capability at write time when `model` is set; see [docs/thinking-levels.md](thinking-levels.md)). |
| `GET` | `/api/roles/:name` | Get a role (includes `toolPolicies` and derived `allowedTools`) |
| `PUT` | `/api/roles/:name` | Update a role. Accepts `toolPolicies` (Record of tool/group name → policy), `model` (`"<provider>/<modelId>"`), and `thinkingLevel` (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`, clamped to the role's model capability when `model` is set). Policy values are validated against: `always-allow`, `ask-once`, `always-ask`, `never-ask`, `never`. Malformed `model` strings are rejected with 400. |
| `DELETE` | `/api/roles/:name` | Delete a role |

Role list/mutation routes that accept `projectId` treat `projectId=headquarters` as server/Headquarters scope for non-workflow config. Created or customized roles are stored in server config and appear with origin `server` (labelled Headquarters in the UI), not as a duplicate project override.

### Tool Group Policies

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tool-group-policies` | Get all group default policies as `Record<string, GrantPolicy>` |
| `PUT` | `/api/tool-group-policies/:group` | Set or clear a group default policy (`{ policy: GrantPolicy \| null }`). Valid values: `always-allow`, `ask-once`, `always-ask`, `never-ask`, `never`. Pass `null` to clear. |

Tool and tool-policy resolution follows the same Headquarters alias rule as roles: `projectId=headquarters` resolves server/Headquarters scope.

### Slash Skills

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/slash-skills` | Discover slash skills for autocomplete (name, description, argument hint) |
| `GET` | `/api/slash-skills/details` | Full slash skill details including content, file paths, and `directories` array listing all scanned directories (default + custom) |

Slash-skill discovery normalizes `projectId=headquarters` to server/Headquarters config while using the Headquarters directory (`headquartersDir()`) as the discovery cwd.

### Assistant Prompts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/roles/assistant/prompts` | List all assistant prompt definitions |
| `PUT` | `/api/roles/assistant/prompts/:type` | Update an assistant prompt (goal, role, tool, staff, setup) |

### Staff Agents

Staff agents are project-scoped permanent sessions: every record carries a `projectId`, lives in that project's `staff.json`, and renders in a dedicated collapsible **Staff** sub-section under the owning project in the sidebar (see [internals.md — Staff agents in the sidebar](internals.md#staff-agents-in-the-sidebar)). The staff-creation **assistant session** (`assistantType: "staff"`) is a normal session and appears in that project's Sessions list while open — it is not a staff agent until `propose_staff` is accepted.

For the user-facing model (lifecycle, immutable sandbox mode, legacy records) see [staff-agents.md](staff-agents.md). For the inbox queue that owns trigger fan-in and the agent-only state-transition endpoints below, see [staff-inbox.md](staff-inbox.md). For the trigger type reference (including the push-based goal lifecycle triggers and their required-prompt rule) see [staff-triggers.md](staff-triggers.md).

Staff records include a persisted `accessory` string as part of the staff identity. Valid accessory IDs round-trip through `staff.json`; missing, blank, non-string, or unknown values normalise to `"none"` on load and write. Staff sessions mirror this value only for rendering: create/recreate paths copy `staff.accessory` into the permanent session, and `PUT /api/staff/:id` mirrors changes to the current session when one exists so sidebar/avatar rendering updates immediately. If no current session exists, the persisted staff value is still used for the next permanent session.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/staff` | List staff agent definitions. Optional `?projectId=<id>` filter; otherwise aggregates across all projects. Each entry includes the normalised persisted `accessory` and the persisted `sandboxed` boolean (chosen at creation, immutable thereafter — see [staff-agents.md](staff-agents.md)). Returns `{ staff: PersistedStaff[] }`. |
| `GET` | `/api/staff/orphaned` | List staff records that are not anchored to a real project — missing `projectId` or persisted under the synthetic `system` project (legacy from before staff became project-scoped). Returns `{ staff: PersistedStaff[] }` with the same normalised staff shape. Consumed by the sidebar's orphan banner. |
| `GET` | `/api/staff/:id` | Get a single staff agent definition, including the normalised persisted `accessory` and persisted `sandboxed` boolean. |
| `POST` | `/api/staff` | Create a staff agent (`{ name, description, systemPrompt, cwd?, worktree?, triggers?, roleId?, projectId?, sandboxed?, accessory? }`). Returns `400` when any element of `triggers[]` has `type` `goal_created` / `goal_archived` and a missing or empty `prompt` (see [staff-triggers.md](staff-triggers.md)). Subject to the [project resolution contract](#project-resolution-contract): `projectId` selects a registered project; otherwise `cwd` must be inside one. With `projectId` and missing/blank `cwd`, the server uses the project root. Explicit `cwd` with `projectId` must stay inside that selected project. `worktree` defaults to auto (`true`/omitted: use a project worktree when supported; `false`: run in the project directory; non-git projects fall back to no-worktree). `sandboxed` defaults to `false` and is immutable. `accessory` defaults to `"none"`, is persisted on the staff record, and is copied onto the initial permanent session for rendering. `roleId` is optional: a non-empty string attaches a role (validated — unknown role returns **404**; a non-string, non-null value returns **400**); the role's prompt context is prepended to the staff system prompt and, when no explicit `accessory` is given, the role's accessory becomes the default. See [staff-agents.md — Role selection](staff-agents.md#role-selection). |
| `PUT` | `/api/staff/:id` | Update a staff agent (`{ name, description, systemPrompt, cwd, state, triggers, memory, roleId, contextPolicy, accessory }`). Same goal-trigger prompt validation as `POST /api/staff`: empty `prompt` on a `goal_created` / `goal_archived` row returns `400`. Changed `cwd` values must be non-empty and inside the staff agent's own project. An unchanged `cwd` on a legacy/orphan record may still be re-sent so other fields remain editable. `accessory`, when present, is normalised, persisted on the staff record, and mirrored to the current permanent session if one exists. `roleId` is optional and validated the same way as on `POST`: a non-empty string sets the role (unknown → **404**), `null` clears it, and a non-string non-null value → **400**; the change takes effect on the next session spawn. See [staff-agents.md — Role selection](staff-agents.md#role-selection). `sandboxed` is not in the allow-list — attempts to change it are silently dropped (see [staff-agents.md](staff-agents.md)). `contextPolicy` accepts `"preserve"` or `"compact"` (see [staff-inbox.md](staff-inbox.md#contextpolicy)); other values are ignored. |
| `PATCH` | `/api/staff/:id` | Re-home a staff record to a different project. Body: `{ projectId }`. Moves the persisted record between per-project stores, updates `staff.projectId`, re-indexes search, resets `cwd` to the target project root, and clears old runtime metadata (`currentSessionId`, `worktreePath`, `branch`, `repoPath`, `repoWorktrees`) so old-project paths cannot be retained. Used by the sidebar's orphan banner "Assign to project…" action. Returns the updated `PersistedStaff` on 200. **400** when `projectId` is missing, empty, hidden, or the system project; **404** when either the staff id or the target project is unknown. |
| `DELETE` | `/api/staff/:id` | Delete a staff agent and terminate its session |
| `GET` | `/api/staff/:id/inbox` | List inbox entries for a staff agent. Query: `state` (`pending` \| `completed` \| `failed` \| `cancelled`, default returns all), `limit` (default unbounded). Returns `{ entries: InboxEntry[] }` in FIFO order. See [staff-inbox.md](staff-inbox.md#rest-surface). |
| `POST` | `/api/staff/:id/inbox` | Enqueue a new inbox entry. Body: `{ title, prompt, context?, source?: { type?: "manual_api" \| "manual_ui" \| "trigger", actorId? } }`. `source.type` defaults to `manual_api`. Returns `201 { entry: InboxEntry }`. Replaces the deleted `POST /api/staff/:id/wake` route. |
| `POST` | `/api/staff/:id/inbox/:entryId/complete` | Agent-only: mark a `pending` entry as `completed`. Body: `{ sessionId, summary? }`. `sessionId` is verified to belong to the same staff (403 otherwise). 409 if the entry is not pending. Returns `{ entry }`. |
| `POST` | `/api/staff/:id/inbox/:entryId/dismiss` | Agent-only: mark a `pending` entry as `failed` or `cancelled`. Body: `{ sessionId, outcome: "failed" \| "cancelled", reason }`. `reason` is required and non-empty. Same 403 / 409 rules as `complete`. |
| `DELETE` | `/api/staff/:id/inbox/:entryId` | Prune an entry of any state. Returns `{ ok: true }` or 404. |
| `GET` | `/api/staff/:id/sessions` | **Deprecated (410)**. Use `GET /api/staff/:id` instead. |

### Projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List visible registered projects in persisted project order. Headquarters is a reorderable project with a `position` field; its position in the list reflects the saved sidebar order. Set `showHeadquartersInProjectLists === false` to hide it from listings. Hidden projects, including the synthetic `system` project, are excluded. |
| `POST` | `/api/projects` | Register a normal project (`{ name, rootPath, color?, upsert?, acceptCanonical? }`). With `upsert: true`, returns the existing project if one already exists at `rootPath`; an upsert for the server workspace returns the existing Headquarters project. Without upsert, the server workspace returns `409 { code: "HEADQUARTERS_ALREADY_EXISTS", projectId: "headquarters" }`. On success, `base_ref` is pinned best-effort to the live remote's `origin/<branch>` (via `git ls-remote --symref origin HEAD`) before `project.yaml` is persisted — an unreachable remote leaves it blank (today's runtime fallback). The same pin runs on the provisional→promote path. See [design/base-ref.md](design/base-ref.md). When `rootPath` is a symlink, returns 400 `{ error, code: "symlink_root", rootPath, canonical }` unless `acceptCanonical: true` is set — the caller should prompt the user with both paths and re-submit with `acceptCanonical: true` to register the canonical path (see [internals.md — Symlinked project rootPath handling](internals.md#symlinked-project-rootpath-handling)). Also returns 400 `{ error, code: "preflight_failed", report }` when the server-side pre-flight surfaces any `fail` check (see [add-project-preflight.md](add-project-preflight.md)). |
| `PUT` | `/api/projects/order` | Persist the visible-project order for sidebar drag reorder. Include Headquarters in `projectIds` when it is visible; omit it when hidden via preference (the server excludes it automatically). Returns `200 { projects }` in the saved order and broadcasts `projects_changed`. See [Project order](#project-order). |
| `GET` | `/api/projects/preflight?path=<absolute>` | Run the [pre-flight validation pass](add-project-preflight.md) for a candidate `rootPath`. Always 200 with a `PreflightReport` when `path` is supplied — failures are the response, not an error. 400 only when `path` is missing. For the server workspace, remediation that would archive gateway-owned `.bobbit` state is removed and the report explains that Headquarters already owns the path. |
| `POST` | `/api/projects/archive-bobbit` | Move existing `<rootPath>/.bobbit/` contents aside into `<rootPath>/.bobbit-archive-NNN/`, preserving `GATEWAY_OWNED_FILES` when the path is gateway-owned. Body: `{ rootPath }`. Does not mutate the registry. Returns 200 with `ArchiveResult`, 400 for bad input (`code: "bad-path"`), or 409 when `.bobbit/` is missing/empty (`code: "no-bobbit-dir"` / `"empty-bobbit-dir"`). Returns 403 `HEADQUARTERS_IMMUTABLE` for the server/Headquarters-owned `.bobbit` state. See [add-project-preflight.md](add-project-preflight.md). |
| `GET` | `/api/browse-directory?path=&prefix=&limit=` | Directory-only listing used by Add Project Browse and typeahead. See [Add Project directory helpers](#add-project-directory-helpers). |
| `POST` | `/api/create-directory` | Create the typed Add Project directory's final path segment. See [Add Project directory helpers](#add-project-directory-helpers). |
| `GET` | `/api/projects/:id` | Get a single project. `GET /api/projects/headquarters` works even when Headquarters is hidden from normal lists. |
| `GET` | `/api/projects/:id/base-ref/detect` | Read-only `base_ref` resolver helper. Returns `{ resolved, detected }`. `resolved` is exactly what worktrees branch off right now (`resolveBaseRef` against the pool/primary repo). `detected` is the live `git ls-remote --symref origin HEAD` result as `origin/<branch>`, **filtered to be saveable** — it is `null` unless it passes the same grammar + cross-component existence checks add-time pinning applies, so any non-`null` value can be saved without rejection. No mutation. Drives the Settings "Detect from remote" action. See [design/base-ref.md](design/base-ref.md). |
| `PUT` | `/api/projects/:id` | Update normal-project name/color/root/palette. Headquarters and hidden/system projects are immutable. |
| `DELETE` | `/api/projects/:id` | Unregister a normal project (does not delete files on disk). The last normal project may be removed; Headquarters remains as the built-in workspace unless hidden by preference. `DELETE /api/projects/headquarters` returns 403 `HEADQUARTERS_IMMUTABLE`. The hidden `system` project is unaffected by this flow. |

#### Add Project directory helpers

`GET /api/browse-directory` powers the Browse modal and directory-picker typeahead.
It accepts optional query parameters:

| Parameter | Meaning |
|---|---|
| `path` | Directory to list. Defaults to the gateway's configured CWD. |
| `prefix` | Case-insensitive basename prefix. Applied before per-entry stat calls. |
| `limit` | Positive integer maximum number of directory entries to return, clamped server-side. When more entries match, the response includes `truncated: true`. |

Success returns:

```json
{ "current": "/repo", "parent": "/", "entries": [{ "name": "app", "path": "/repo/app" }], "truncated": false }
```

Only visible directories are returned; files, hidden directories, `node_modules`,
and symlinks are skipped. Missing paths return `404`; non-directories or
inaccessible paths return `400`; unreadable directories return `500`.

`POST /api/create-directory` creates exactly one final path segment for the Add
Project flow:

```json
{ "path": "/absolute/new-project" }
```

Success returns `200 { "path": "/resolved/new-project" }`. The endpoint does
not create missing parents recursively.

| Status | Code | Meaning |
|---|---|---|
| `400` | `invalid_path` | Missing, non-string, empty, or non-absolute `path`. |
| `404` | `parent_not_found` | Parent is missing or not a directory. |
| `403` | `permission_denied` | Stat or mkdir failed with a permission error. |
| `409` | `already_exists` | Target already exists as a directory. The UI treats this as recoverable by refreshing detection/preflight. |
| `409` | `exists_as_file` | Target exists but is not a directory. |
| `500` | `create_failed` | Unexpected stat or mkdir failure. |

#### Project order

`GET /api/projects` returns visible projects in the server-persisted order. Headquarters is a normal reorderable project (PR #933) and carries a `position` field like any other visible project. Clients should not need to sort by it — the server returns projects already sorted by position.

`PUT /api/projects/order` is a reserved collection-level endpoint. It must be handled by the dedicated order route, never by the generic `PUT /api/projects/:id` update path. The server keeps the dedicated route before project-id handlers and excludes reserved collection subroutes from the generic matcher so `order` cannot be interpreted as a project ID.

`PUT /api/projects/order` saves a new global order for all visible projects, including Headquarters when it is visible.

```http
PUT /api/projects/order
Content-Type: application/json

{ "projectIds": ["headquarters", "project-c", "project-a", "project-b"] }
```

`projectIds` must be the complete current ordered list of all participating visible project IDs (normal projects **and** Headquarters when shown). Hidden projects and `system` are excluded. When Headquarters is hidden from project lists via the `showHeadquartersInProjectLists` preference, it is excluded from the expected set — clients should omit it from the payload in that case and the server preserves its existing slot.

On success, the server stores contiguous positions, returns `200` with all visible projects in saved order under `{ projects }`, and broadcasts `projects_changed` with the same ordered `projects` array so connected clients can sync without a reload.

Project objects include the normal project fields; this example is truncated to the fields relevant to ordering:

```json
{
  "projects": [
    { "id": "headquarters", "name": "Headquarters", "kind": "headquarters", "rootPath": "/server", "position": 0 },
    { "id": "project-c", "name": "Gamma", "rootPath": "/repo/gamma", "position": 1 },
    { "id": "project-a", "name": "Alpha", "rootPath": "/repo/alpha", "position": 2 },
    { "id": "project-b", "name": "Beta", "rootPath": "/repo/beta", "position": 3 }
  ]
}
```

Invalid requests return `400` and do not mutate the registry:

```json
{ "error": "projectIds must be an array of strings", "code": "invalid_project_order" }
```

`invalid_project_order` covers malformed bodies, non-string IDs, duplicate IDs, unknown IDs, hidden project IDs, and the synthetic `system` project ID. It also covers including Headquarters in `projectIds` when it is **hidden** via the `showHeadquartersInProjectLists` preference (because the server excludes it from the expected set in that case). When Headquarters is **visible**, it is a valid and required entry in `projectIds`; omitting it when visible returns `stale_project_order`. `system` is never returned by `GET /api/projects`.

Stale complete-order mismatches return `409` and do not mutate the registry:

```json
{
  "error": "Project order is stale",
  "code": "stale_project_order",
  "expectedProjectIds": ["project-a", "project-b", "project-c"],
  "receivedProjectIds": ["project-a", "project-b"]
}
```

A stale error means the submitted IDs were otherwise valid visible projects, but the submitted set no longer exactly matched the server's visible project set. The usual client recovery is to re-fetch `GET /api/projects`, apply the returned order, and let the user retry.

For the user-facing sidebar behavior, see [Sidebar project drag reorder](sidebar-project-reorder.md).

### Project resolution contract

`POST /api/goals`, `POST /api/sessions`, and `POST /api/staff` all require an explicit `projectId` in the request body. `cwd`-based project inference has been removed: `cwd` is an execution directory validated *after* project selection, not a way to identify the project. Headquarters satisfies this contract like any other registered project: pass `projectId: "headquarters"` (its `rootPath` is the Headquarters directory `<server-run-dir>/.bobbit/headquarters`, not the server run directory itself).

| Condition | Status | Body |
|---|---|---|
| Missing `projectId` | 400 | `{"error":"projectId required","code":"PROJECT_ID_REQUIRED"}` |
| `projectId` provided, unknown id | 404 | `{"error":"Project not found","code":"PROJECT_NOT_FOUND"}` |

The helper implementing this is `resolveProjectForRequest` in `src/server/agent/resolve-project.ts`.

The helper implementing this is `resolveProjectForRequest` in `src/server/agent/resolve-project.ts`. Callers in new handlers should invoke it at the top of the handler and return the 400 directly when `ok === false`.

#### `POST /api/sessions` — `assistantType` carve-outs

`POST /api/sessions` accepts an optional `assistantType` that changes how project resolution applies. The rule is one sentence: **only project-scope assistants require a resolvable project; server-scope assistants do not.**

| `assistantType` | Scope | Project resolution |
|---|---|---|
| _(unset)_, `goal` | project | Standard contract above — explicit `projectId` required, else 400. |
| `project`, `project-scaffolding` | project (new) | The server creates a provisional project registration so the session persists under its own context. |
| `role`, `tool` | server | `projectId` is **optional**. When omitted, the server anchors the session at the synthetic `system` project (see [internals.md — Synthetic system project](internals.md#synthetic-system-project)). When the caller _does_ pass a `projectId` (e.g. the Roles/Tools pages when scoped to a project), it is honoured normally. |
| `staff` | project | Explicit `projectId` required, else 400. Staff agents are project-scoped permanent sessions (they own a `projectId`, a `staff.json` entry under that project, and runtime cwd derived from that project), so the creation assistant must land in a real project context. The UI's **New staff** button passes `projectId` directly from the project header. |

Why: `role` / `tool` assistants edit server-level config (custom roles, custom tools) that does not belong to any project. Forcing them through the project-resolution gate would make `npx bobbit` from a non-project directory return 400 just for opening the Roles page's "+ New Role" button. The system-project anchor gives those sessions a valid persistence store without requiring the user to register a real project first. `staff` is excluded from the carve-out because a staff agent is not server-level config — it is a long-lived agent that operates inside a specific project — so anchoring its creation assistant at the system project would orphan the record and risk launching from the server/default cwd.

### Project Config

Per-project overrides are scoped to a registered project. Headquarters is special: `/api/projects/headquarters/config` is an alias over the server `ProjectConfigStore`, not a duplicate project config tree.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/config` | Raw project-level overrides (only keys explicitly set). For `:id=headquarters`, returns the server/Headquarters config file. |
| `GET` | `/api/projects/:id/config/defaults` | Built-in defaults for all known config keys. |
| `GET` | `/api/projects/:id/config/resolved` | Fully resolved values; each key returns `{ value, source }` where `source` is `"project"`, `"server"`, or `"default"`. Headquarters values resolve from the aliased server config. |
| `PUT` | `/api/projects/:id/config` | Set/clear project-level overrides. Empty string or `null` clears an override. Atomic: all keys validated before any are written. For `:id=headquarters`, writes server/Headquarters config. |
| `GET` | `/api/projects/:id/qa-testing-config` | Returns `{ configured: boolean }` — `true` iff at least one component has a non-empty `config.qa_start_command`. Drives the UI toggle on the `agent-qa` optional verify step. Detailed per-key values are not surfaced here; the `/qa-test` skill reads them directly from `project.yaml`. |

`PUT /api/projects/:id/config` is a generic KV writer. It accepts any scalar `project.yaml` field — including `build_command`, `test_command`, `typecheck_command`, `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `sandbox`, `base_ref`, and any custom keys the project defines — and the only validation is that keys must not contain `.`. `base_ref` carries extra rules: tags, SHAs, non-`origin` remote prefixes, and (for `sandbox = docker` projects) local refs are rejected with 400 and a structured `{ field: "base_ref", error, details? }` payload; multi-repo saves additionally `git rev-parse --verify` the ref in every component repo and return per-component bullets in `details[]` when missing. Validation only runs when `base_ref` is present in the body. See [design/base-ref.md](design/base-ref.md). Two fields (`config_directories`, `sandbox_tokens`) are sent as structured native types (arrays of mappings); legacy JSON-string payloads for these keys are rejected with 400. The seven legacy top-level QA keys (`qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_env`, `qa_max_duration_minutes`, `qa_max_scenarios`) are **rejected** with 400 — they live on `components[<name>].config[<key>]` now (see [internals.md — Multi-repo & components](internals.md#multi-repo--components)). Inline env vars directly into `qa_start_command`. See [internals.md — Native-YAML project.yaml fields](internals.md#native-yaml-projectyaml-fields). This endpoint is what the settings UI and the mid-session project-proposal accept path both write through (see [internals.md — Per-project config](internals.md#per-project-config)). The project's display `name` is **not** a `project.yaml` field — update it via `PUT /api/projects/:id`. Model preferences (`session_model`, `review_model`, `naming_model`) are **not** project-scoped either; they live in the preferences store.

Server-level fallback, labelled Headquarters in the UI (applied when no normal project override is set):

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
| `POST` | `/api/system-prompt/customise` | Copy shipped `defaults/system-prompt.md` to `<bobbitConfigDir>/system-prompt.md` so the user can edit it |

**`POST /api/system-prompt/customise`** — no request body. Behaviour:

- If `<bobbitConfigDir>/system-prompt.md` does not exist, copies `defaults/system-prompt.md` to that path.
- If the user file already exists, it is left unchanged (no-op overwrite — user edits are never clobbered).
- Returns `{ path, created, content }` where `path` is the absolute user-override path, `created` is `true` only when the file was just copied this call, and `content` is the current file contents (newly copied default or pre-existing user version).
- Errors: `500 { error }` if the shipped default is missing from the install or the copy/read fails.

This is the explicit opt-in path for customising the global system prompt. The startup pipeline no longer scaffolds the file — see [internals.md — Config cascade](internals.md#config-cascade) for the runtime resolution rules.

### Workflows

Workflows are **project-scoped only** — there is no cascade and no system-scope layer. All mutations require `projectId`; reads without `projectId` return an empty list / 404 (intentionally lenient so the Workflows page doesn't crash during scope transitions). Use `projectId=headquarters` for Headquarters workflows; they live in the aliased server `project.yaml::workflows` and are still reported as project-scoped workflows. See [internals.md — Workflows are project-scoped only](internals.md#workflows-are-project-scoped-only) for the rationale.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows?projectId=X` | List workflows for a project. Without `projectId`, returns `{ workflows: [] }`. |
| `GET` | `/api/workflows/:id?projectId=X` | Get full workflow detail. Without `projectId`, returns 404. |
| `POST` | `/api/workflows?projectId=X` | Create a workflow. **Requires `projectId`** — 400 otherwise. |
| `PUT` | `/api/workflows/:id?projectId=X` | Update a workflow. **Requires `projectId`** — 400 otherwise. |
| `DELETE` | `/api/workflows/:id?projectId=X` | Delete (blocked if in-use by active goals). **Requires `projectId`** — 400 otherwise. |
| `POST` | `/api/workflows/:id/clone?projectId=X` | Deep-copy a workflow with a new ID. **Requires `projectId`** — 400 otherwise. |

There is no `?scope=server` parameter on workflow endpoints — it was removed when the system-scope workflow layer was eliminated. Use `projectId=headquarters` for the visible server workspace workflow scope.

### Preferences

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/preferences` | Get all preferences |
| `PUT` | `/api/preferences` | Merge preferences (set `null` to delete a key) |

Model-related preference keys include `default.sessionModel`, `default.reviewModel`, `default.imageModel`, and `allowSessionModelFallback`. The fallback setting defaults to off when absent; see [Controlled session model fallback](session-model-fallback.md).

`showHeadquartersInProjectLists` controls only whether Headquarters appears in normal project lists/sidebar/pickers. It defaults to visible when absent. Setting it to `false` does not delete or archive Headquarters sessions, goals, staff, config, or persisted state; explicit `projectId: "headquarters"` remains resolvable.

`agentDir` and `agentDirHistory` are managed by the dedicated agent-directory workflow, not generic preferences. `PUT /api/preferences` rejects those keys with `400 { code: "AGENT_DIR_PREFERENCE_FORBIDDEN", use: "/api/agent-dir/pending" }` so callers cannot bypass validation, copy guidance, or restart-gated semantics.

### Agent directory

These endpoints back Settings → Maintenance → Agent Directory. They are restart-gated: they expose the active startup directory and save only the next-start preference. See [Configurable agent directory](configurable-agent-directory.md).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agent-dir` | Return active, default, persisted/pending, next-start, restart, env override, and history state. |
| `POST` | `/api/agent-dir/validate` | Validate/probe a candidate target path. Body `{ path }`. May create the directory to prove access. |
| `PUT` | `/api/agent-dir/pending` | Save or clear the persisted next-start agent dir. Body `{ path }`, where `null` or empty clears. |
| `POST` | `/api/agent-dir/migrate` | Explicitly copy allowlisted data from an active/historical configured source to the pending destination. Body `{ sourcePath, destinationPath, overwrite? }`. |

`GET /api/agent-dir` returns:

```ts
type AgentDirSource = "BOBBIT_AGENT_DIR" | "persisted" | "default";

interface AgentDirResolution {
  dir: string;
  source: AgentDirSource;
  raw?: string;
  projectRoot: string;
  defaultDir: string;
}

interface AgentDirApiState {
  activePath: string;
  activeSource: AgentDirSource;
  startup: AgentDirResolution;
  defaultPath: string;
  persistedPath?: string;
  pendingPath?: string;
  nextStart: AgentDirResolution;
  restartRequired: boolean;
  envOverride?: {
    active: true;
    source: "BOBBIT_AGENT_DIR";
    value: string;
    savedPathIgnored: boolean;
  };
  history: string[];
}
```

`PUT /api/agent-dir/pending` returns the same state plus `guidance`. Non-empty paths are validated with the same rules as `POST /api/agent-dir/validate`: `~` expansion, relative-to-project resolution, git-worktree exclusion except `<projectRoot>/.bobbit/agent/`, symlink/realpath checks, `mkdir`, and read/write probe. Validation failures return `{ ok:false, error:{ code, message, rawInput, resolvedPath? } }` with HTTP 400 on save.

`POST /api/agent-dir/migrate` is the Settings **Copy data** action. It accepts only user-selected sources known from the active or historical configured agent-directory set and destinations equal to the pending next-start directory. It does not auto-discover or special-case `~/.pi/agent`. It copies only `sessions/`, `auth.json`, `models.json`, `settings.json`, `google-code-assist.json`, and `bin/`; existing files are skipped unless `overwrite:true`. The response is an `AgentDirMigrationReport` with `copied`, `skipped`, `overwritten`, `missing`, `warnings`, `errors`, and `guidance`. Relationship/symlink violations return HTTP 400 with a report-level `error.code`.

### Models

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/models` | List currently available models (`ApiModel[]`) |
| `POST` | `/api/models/test` | Probe a model pref with a minimal "Reply with OK" call (body: `{ pref: "<provider>/<modelId>" }`). 15s timeout. |
| `GET` | `/api/pi-ai/providers` | List built-in pi-ai provider IDs through a browser-safe server boundary |
| `POST` | `/api/pi-ai/provider-key-test` | Test a built-in provider API key without persisting it |
| `GET` | `/api/image-models` | List currently available image-generation models |
| `POST` | `/api/image-generation/generate` | Generate images through the configured image model; used by the `generate_image` tool |

`GET /api/models` includes each model's `cost` in pi-ai's per-million-token shape: `{ input, output, cacheRead, cacheWrite }`, plus optional `cost.tiers[]` when Pi exposes tiered pricing metadata. Reasoning-capable models may also include `thinkingLevelMap`; Pi `0.80.6` uses that map to expose `max` thinking support for GPT 5.6 and Fable-class models. AI Gateway models may also include `upstreamProvider`, which the UI uses for badges and search while preferences remain `aigw/<bare-id>`. Bobbit takes AIGW cost from well-known per-million-token `cost` metadata or converts legacy `/v1/models` per-token `pricing`; it does not call aggregate endpoints such as `/v1/usage`, `/v1/cost`, or `/v1/credits`.

`GET /api/pi-ai/providers` and `POST /api/pi-ai/provider-key-test` are an internal browser-safe pi-ai boundary. Browser UI uses them instead of runtime bare value imports from `@earendil-works/pi-ai`, because the package index traverses Node-only exports such as environment API-key probing and causes browser builds to externalize `node:fs`. Keep provider catalog reads and key tests behind these server endpoints; first-message streaming is the separate lazy `@earendil-works/pi-ai/api/*` boundary documented in [Pi runtime compatibility](pi-runtime-compatibility.md).

`GET /api/pi-ai/providers` responses:

- `200 { providers: string[] }` — built-in pi-ai provider IDs, e.g. `"anthropic"` or `"openai"`. The response is not wrapped in a broader status envelope.
- Endpoint-specific validation errors are not expected; normal API auth and body-size failures still apply.

`POST /api/pi-ai/provider-key-test` body:

```json
{ "provider": "anthropic", "modelId": "claude-sonnet-...", "key": "sk-..." }
```

The key is used only for a one-off minimal completion probe (`"Reply with: OK"`) and is not stored. The server trims string fields before testing.

`POST /api/pi-ai/provider-key-test` responses:

- `200 { ok: true, modelResolved, latencyMs }` — the provider key completed a minimal request successfully.
- `400 { ok: false, status: 400, error: "Missing provider, modelId, or key" }` — any required body field is absent, non-string, or empty after trimming.
- `404 { ok: false, status: 404, error: "Model \"<provider>/<modelId>\" is not in the built-in pi-ai catalog." }` — the requested built-in model cannot be resolved.
- `502 { ok: false, modelResolved, latencyMs, error }` — pi-ai resolved the model but the provider request failed or timed out. The body has no `status` field in this path.

`POST /api/models/test` resolves the current model record before probing. AIGW Responses models call their per-model `{baseUrl}/responses`; AIGW completions models call `{baseUrl}/chat/completions`; Converse, future provider-native APIs, and non-AIGW models run through pi-ai. A failed route is not retried through another API.

Responses:

- `200 { ok: true, modelResolved, latencyMs }` — success.
- `200 { ok: false, modelResolved, latencyMs, error }` — a direct AIGW Responses/completions probe reached an upstream or transport failure.
- `400 { ok: false, error }` — pref is missing or could not be parsed as `provider/modelId`.
- `404 { ok: false, error: "Model \"...\" is not in the current available-models list..." }` — pref does not resolve against `/api/models`.
- `502 { ok: false, modelResolved, latencyMs, error }` — a pi-ai-backed provider/native-API probe failed.
- `500 { ok: false, error }` — unexpected model discovery or probe setup failure.

Used by the Settings → Models tab per-row Test button. See [AI Gateway routing — Model probes](ai-gateway-routing.md#model-probes) and [Debugging](debugging.md#reviewnaming-model-mismatch-under-ai-gateway).

### AI Gateway

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/aigw/status` | Return `{ configured, url?, models? }`; configured gateways are discovered fresh, with failures represented by `models: []` |
| `POST` | `/api/aigw/configure` | Discover and persist a gateway (`{ url }`), publish `models.json`, and refresh sandbox mounts |
| `DELETE` | `/api/aigw/configure` | Remove gateway configuration and its generated provider |
| `POST` | `/api/aigw/test` | Run well-known-first discovery for `{ url }` without saving or changing active routing |
| `POST` | `/api/aigw/refresh` | Repeat configuration for the saved URL and refresh models/default seeding |
| `*` | `/api/aigw/v1/*` | Append `/v1/*` to the configured URL and proxy the request; save the gateway origin, not an already suffixed `/v1`, when using this route |

Configure, refresh, and delete return `remountPending: true` when the durable configuration succeeded but one or more tracked sandbox containers could not yet remount the atomically replaced `models.json`. Callers must not interpret that flag as a rollback; normal container health recovery continues.

Discovery first requests `/.well-known/opencode` at the gateway origin and falls back to `/v1/models` only when no authoritative config resolves. Outbound requests carry Bobbit's canonical AI Gateway user agent. See [AI Gateway routing](ai-gateway-routing.md) for precedence, remote-config security, provider-specific routes, model-ID migration, and cache/container behavior; see [AI Gateway request headers](internals.md#ai-gateway-request-headers-user-agent-x-opencode-session) for implementation details.

### OAuth

Provider-aware. Bobbit can hold OAuth credentials for several providers concurrently (currently `anthropic`, `openai-codex`, and `google-gemini-cli`); every endpoint takes a `provider` discriminator so the same flow IDs and credential rows do not bleed across providers.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/oauth/status?provider=<id>` | OAuth status for one provider. Returns `{ provider, authenticated, expires?, email? }`. |
| `POST` | `/api/oauth/start` | Begin an OAuth flow for a provider. Body: `{ provider }`. Returns `{ provider, flowId, url, callbackServer?, instructions? }`. |
| `POST` | `/api/oauth/complete` | Exchange `code` for tokens. Body: `{ flowId, code }`. Returns `{ success: true }` (200) or `{ success: false, error }` (400). |
| `GET` | `/api/oauth/flow-status?flowId=<id>&provider=<id>` | Poll an in-flight flow. Returns `{ complete, error? }`. |
| `POST` | `/api/oauth/logout` | Revoke/clear one provider's stored credential. Body: `{ provider }`. Returns `{ success, provider }`, never echoing token material. |

**Provider IDs:** `anthropic` (Claude.ai login → API key/refresh token), `openai-codex` (ChatGPT subscription → bearer token), and `google-gemini-cli` (Google account → Gemini Code Assist bearer token). Provider validation is performed by the `normalizeProvider` helper in `src/server/auth/oauth.ts`; for the Google path it also accepts the inbound aliases `google` and `gemini` and collapses them to canonical `google-gemini-cli` (plain `google` stays the Google AI Studio API-key provider elsewhere). An unsupported value causes the surrounding endpoint to throw, which the server wraps as `400 { error: "<thrown message>" }` (e.g. `"Error: Unsupported OAuth provider: foo"` for status, or `500` for start). The error string is implementation-defined — callers should treat any 4xx with an `error` field as "unknown provider". See [Google OAuth & Gemini models](google-oauth-models.md) for the full account-vs-API-key split.

**Why `provider` everywhere:** the same browser-redirect callback URL is shared between providers, and a user may legitimately have flows in flight for both at once. Keying every operation by `provider` (alongside `flowId`) keeps state strictly partitioned and lets the UI render Settings → Account as parallel rows that can be (re-)authed independently.

**`GET /api/oauth/status?provider=<id>`** responses:

- `200 { provider: "anthropic", authenticated: true, expires: 1775812345000 }` — credential present and not expired.
- `200 { provider: "anthropic", authenticated: false, expires: 1700000000000 }` — a stored credential exists, but its expiry timestamp is in the past.
- `200 { provider: "anthropic", authenticated: false }` — no stored credential, or no confident expiry timestamp is available.
- `400 { error: "<message>" }` — provider value rejected by `normalizeProvider`.

The response intentionally does **not** echo the bearer token / API key — strict-OAuth contract.

The `email?` field appears only for providers that capture non-secret account display metadata (currently `google-gemini-cli`); it is never a token.

#### Client expiry reminders

After remote gateway authentication succeeds, the web client checks the Account-tab OAuth providers neutrally: `anthropic` (Anthropic), `openai-codex` (OpenAI), and `google-gemini-cli` (Google). The reminder exists to send users to the shared Account re-login surface instead of automatically launching an Anthropic-only OAuth flow.

A provider is considered confidently expired only when `/api/oauth/status?provider=<id>` returns `authenticated: false` with a finite `expires` value earlier than the client clock. Missing credentials, never-authenticated rows, missing/non-finite `expires`, non-2xx responses, network errors, and invalid JSON are treated as indeterminate and do not show a reminder for that provider.

When one or more providers are expired, the modal names the affected providers with their friendly labels. Its secondary left button is **Dismiss**; its primary right button is **Go to Account Settings**, which closes the modal and navigates to `#/settings/system/account` so the user can re-authenticate from Settings → Account. Dismissal never blocks normal app use.

Dismissed reminders persist client-side by stable identity: `provider + expires` (stored as `${provider}:${expires}`). The same expired credential stays suppressed across rechecks and reloads, but a different provider or a later expiry timestamp resurfaces the modal. Successful Account-tab re-authentication clears dismissed reminder state for that provider so future distinct expiries can be shown.

Only provider ids, friendly labels, and expiry timestamps participate in this client state. OAuth access tokens, refresh tokens, API keys, and other token material remain server-side and are never exposed by the status response or the reminder modal.

**`POST /api/oauth/start`** body: `{ provider: "anthropic" | "openai-codex" | "google-gemini-cli" }`. Returns:

```json
{
  "provider": "openai-codex",
  "flowId": "f_8c2…",
  "url": "https://auth.openai.com/…",
  "callbackServer": true,
  "instructions": "Open the URL above and authorize Bobbit."
}
```

- `url`: opens in a system browser; the provider's redirect lands on Bobbit's callback handler.
- `callbackServer`: `true` for OAuth providers that complete via an embedded/loopback callback server (e.g. `openai-codex`, and `google-gemini-cli` via a loopback server on `http://localhost:<ephemeral-port>/oauth2callback`); `false`/absent for providers that require the user to paste the returned `code` back into the UI (e.g. `anthropic`). The Google flow also accepts the manual paste path for remote-gateway setups where the browser cannot reach the gateway loopback.
- `instructions`: optional human-readable string the UI may render alongside the URL.

**`POST /api/oauth/complete`** body: `{ flowId, code }` (the stored flow already knows its provider, so the body does not repeat it). Returns:

- `200 { success: true }` — token stored.
- `400 { error: "Missing flowId or code" }` — either field missing or empty.
- `400 { success: false, error: "code required" }` — `code` empty / whitespace-only after the trim check.
- `400 { success: false, error: "Unknown or expired flow ID" }` — the `flowId` was never created or has been garbage-collected.
- `400 { success: false, error: "OAuth flow expired" }` — the flow exceeded its TTL.
- `400 { success: false, error: "<provider message>" }` — token-exchange or login-promise rejection. Body always includes `success: false` for non-200 responses from `oauthComplete`; raw thrown exceptions are surfaced as `500 { error: "<message>" }` with no `success` field.

**`GET /api/oauth/flow-status?flowId=<id>&provider=<id>`** is the polling endpoint used by the Settings → Account UI while the user is in the browser. Returns:

```json
{ "complete": false }
```

or on success / failure:

```json
{ "complete": true }
{ "complete": true, "error": "user denied access" }
```

Response contract:

- `complete: boolean` — `false` while the flow is still pending, `true` once the provider's callback has resolved (regardless of success).
- `error?: string` — present only when the flow failed (or when the `flowId` is unknown / cross-provider mismatched, in which case the body is `{ complete: false, error: "flow not found" }` with HTTP 404).
- HTTP 400 `{ error: "Missing flowId" }` if `flowId` query param is absent.
- HTTP 404 `{ complete: false, error: "flow not found" }` if the `flowId` is unknown, expired, **or** belongs to a different provider than the supplied `provider` query param.

`provider` is recommended as a defence-in-depth check: if the stored flow's provider does not match the query parameter, the endpoint returns `404 { error: "flow not found" }` instead of leaking status across providers. The primary key is still `flowId`; the provider check just guarantees that a flow ID accidentally polled with the wrong provider cannot be used to confirm its existence.

**`POST /api/oauth/logout`** body: `{ provider }`. Normalizes the provider, optionally revokes the upstream token (Google posts to `oauth2.googleapis.com/revoke`; logout does not fail if revoke is transiently unavailable), deletes **only** that canonical provider's `auth.json` entry, and clears the OAuth cache. Returns `200 { success: true, provider }`. Provider-partitioned: logging out `google-gemini-cli` never touches `anthropic`, `openai-codex`, or the API-key-only `google` credential, and no response or log echoes token material.

See [Google OAuth & Gemini models](google-oauth-models.md) for the account-vs-API-key provider split, the Code Assist runtime, and the current session-selectability limitation.

### Image generation

Bobbit routes image generation through the gateway so the agent's `generate_image` tool can call OpenAI (DALL-E 2/3 + Images API), Google (Gemini 2.5/3 Flash Image, Imagen 4), and OpenAI-Codex driver models behind one contract. The session-scoped image model is selected via the footer picker (UI) or `set_image_model` (WS); `POST /api/image-generation/generate` is the gateway-side execution endpoint the tool extension calls.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/image-models` | List currently-available image models — array of `ApiImageModel`. |
| `POST` | `/api/image-generation/generate` | Generate one or more images via the configured provider. |

**`GET /api/image-models`** returns the array directly (not wrapped) from `getAvailableImageModels(preferencesStore)`. Each item is an `ApiImageModel` (TypeScript type exported from `src/server/agent/image-generation.ts`):

```ts
interface ApiImageModel {
  id: string;            // e.g. "gpt-image-2"
  name: string;          // human-readable label
  provider: string;      // e.g. "openai", "google", "openai-codex"
  api: "openai-images" | "gemini-images" | "google-imagen";
  baseUrl: string;
  authenticated: boolean;
  sizes?: string[];
  qualities?: string[];
  aspectRatios?: string[];
  formats?: string[];
}
```

Unauthenticated rows (`authenticated: false`) still appear so the Settings → Models → Image picker can render a red "Unavailable" badge with a tooltip pointing at the missing credential. On internal failure the endpoint returns `500 { error: "Failed to load image models: <msg>" }`. See [docs/internals.md — Image generation routing](internals.md#image-generation-routing) for the full data flow.

**`POST /api/image-generation/generate`** is the back-end called by the `generate_image` tool extension. Request body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | `string` | yes | Free-form prompt. Capped at 8192 chars. |
| `n` | `integer` | no | Number of images. Must be an integer in `[1, 4]`. Defaults to `1`. |
| `size` | `string` | no | Provider-specific size token (e.g. `1024x1024`). |
| `quality` | `string` | no | Provider-specific quality token (e.g. `auto`, `hd`). |
| `background` | `string` | no | One of `transparent`, `opaque`, `auto` (OpenAI-only). |
| `format` | `string` | no | One of `png`, `jpeg`, `webp`. |
| `aspectRatio` | `string` | no | Gemini/Imagen aspect ratio (e.g. `16:9`). |
| `imageSize` | `string` | no | Alternative size token validated against the registry entry's `sizes`. |
| `sessionId` | `string` | no | Resolves the session's selected image model (the single source of truth for the model). |

There is no `model` field: the image model is controlled solely by the session image-model selector / `default.imageModel` settings default. A `body.model` is ignored if sent (regression-guarded), so neither an agent tool argument nor a human's prompt can change the model.

Response on success (HTTP `200`):

```json
{
  "model": {
    "provider": "openai",
    "id": "gpt-image-2",
    "name": "GPT Image 2",
    "api": "openai-images"
  },
  "images": [
    { "data": "iVBORw0KG…", "mimeType": "image/png" },
    { "data": "iVBORw0KG…", "mimeType": "image/png", "revisedPrompt": "…" }
  ]
}
```

The `model` object echoes the resolved provider/id/name/api so the caller can confirm which model actually served the request (always the session selector / `default.imageModel` / `defaultImageModelPref()`, canonicalised). Each image carries `data` (base64-encoded bytes) and `mimeType`; some OpenAI calls also include a `revisedPrompt` when the provider rewrote the prompt. The tool extension fans this out to disk paths or inlines base64 in chat as appropriate.

Error responses:

- `400 { error: "Missing prompt" }` — `prompt` missing or non-string. Note the capital `M`.
- `400 { error: "prompt exceeds 8192 chars" }` — prompt over the cap.
- `400 { error: "n must be 1..4" }` — `n` is not an integer or is outside `[1, 4]`.
- `500 { error: "<provider message>" }` — provider helper threw. The message comes straight from `err.message` (typically prefixed with the upstream HTTP status, never `[object Object]`). Provider-specific failure modes (Codex `n=1` clamp, `remote image exceeds 25 MB cap`, missing credentials) all surface here as `500`.

The gateway does **not** return `502` or `503` from this endpoint. The model is never taken from the request body, so there is no "unknown image model" rejection here (the strict registry check lives on the `set_image_model` WS message instead, see [docs/websocket-protocol.md](websocket-protocol.md)).

Under the AI Gateway, the OpenAI-Codex driver model auto-selects through a fallback chain (env var `BOBBIT_OPENAI_CODEX_IMAGE_DRIVER_MODEL` → `gpt-5.5` → `gpt-5` → `gpt-4o`) — see [AGENTS.md — Image generation failure debugging](../AGENTS.md) for the full diagnostic path. The agent-facing canonical model-ID reference (gpt-image-2 / Google IDs) lives in `defaults/system-prompt.md`; the model itself is chosen only via the session image-model selector / settings default, not the tool call. The per-tool `Parameters` table is in `defaults/tools/images/generate_image.yaml::detail_docs` (single source of truth).

### MCP Servers

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mcp-servers` | List all discovered MCP servers with status, tool count, and tool names |
| `POST` | `/api/mcp-servers/:name/restart` | Disconnect and reconnect an MCP server (also re-discovers from config files) |
| `POST` | `/api/internal/mcp-call` | Proxy a tool call to an MCP server (`{ tool: "mcp__server__name", args: {...} }`) |
| `POST` | `/api/internal/mcp-describe` | Return the JSON Schema for an MCP server's operations (`{ server, operation? }` → `{ tools: [...] }` or `{ tool: {...} }`); used by the `mcp_describe` discovery tool |

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

**`POST /api/internal/mcp-call`** is the internal proxy endpoint used by generated agent extensions. Returns the raw MCP `{ content, isError }` response. Enforces Layer B per-op `never`-policy denial via `resolveGrantPolicy` before dispatching. On error, the response body includes structured `{ error, server, operation }` fields when the tool name is parseable.

**`POST /api/internal/mcp-describe`** returns either `{ tools: [{ name, description, inputSchema }] }` (when `operation` is omitted) or `{ tool: {...} }` (when given). Returns 503 with `{ error: "server <name> not connected: <reason>" }` for unknown/disconnected servers, 404 for unknown operations. Auth: same `X-Bobbit-Session-Id` header as `mcp-call`. See [docs/mcp-meta-tools.md](mcp-meta-tools.md).

### Preview

The preview side-panel iframe is fed by a per-session content mount served from a cookie-authed origin path. Both `html=` and `file=` arguments to the agent's `preview_open` tool converge on the same mount, so there is no longer an inline-vs-file mode distinction. Full reference: [docs/preview-architecture.md](preview-architecture.md).

**Content origin — `/preview/<sid>/<rel-path>`** (no `/api/` prefix). Files are served from `<stateDir>/preview/<sid>/` with proper MIME types and `Cache-Control: no-store`. HTML responses get a `<base href="/preview/<sid>/">` and the shared theme/swipe bridge scripts injected; non-HTML assets pass through untouched. Auth is by the signed `bobbit_session` cookie (HttpOnly, `Path=/`, 30-day max-age, `Secure` outside localhost) — iframe loads, link navigation, and "Open in new tab" all carry it automatically. Preview content verifies cookies entirely in memory and never issues or renews them. Path-traversal escapes return `403`; missing files return `404`. Method gate: `GET`/`HEAD` only.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/preview/mount?sessionId=<sid>` | Populate the per-session preview mount, OR restore an immutable artifact. Body is one of: `{ html, entry? }` (inline), `{ file: "/abs/path/report.html", assets?: string[], manifest?: string }` (copy entry plus explicitly declared siblings), or `{ artifactId }` (restore a previously captured artifact — mutually exclusive with `html`/`file`/`assets`/`manifest`). Returns `200 { url, path, relPath, entry, mtime, contentHash, artifactId }` for inline, plus `assets: string[]` (resolved + sorted) for the `file` form. `contentHash` is a lowercase SHA-256 hex string for the populated mount tree; `artifactId` is the id of the immutable artifact written alongside the mount (see [docs/design/side-panel-tab-contract.md](design/side-panel-tab-contract.md) and the [Preview architecture](preview-architecture.md) doc for lifecycle). `relPath` is the host-invariant `<sessionId>/<entry>` identifier (forward slashes on all OS) used by the agent tool to build the v3 snapshot marker. `400` invalid sessionId / bad entry / non-absolute file / file not `.html`/`.htm` / `assets` or `manifest` passed with `html` / invalid asset path (absolute, `..`, `\`, `\0`, `**`, `[...]`, `{a,b}`) / manifest JSON parse error / `artifactId` combined with another body field; `403` sandbox-out-of-scope or symlink escape; `404` source file / manifest file / literal asset missing / `artifactId` unknown or owned by a different session. No size cap — asset inclusion is explicit and agent-driven. On success the server fans out a `preview-changed` SSE event. |
| `POST` | `/api/preview/artifacts/<artifactId>/restore?sessionId=<sid>` | Restore a previously captured immutable preview artifact into the session's live mount and broadcast `preview-changed`. The artifact must belong to `<sid>`; cross-session ids return `404`. Returns the same shape as the mount `POST` (`{ url, path, relPath, entry, mtime, contentHash, artifactId }`). Used by the preview-renderer Open button on historical `preview_open` tool cards. Equivalent to `POST /api/preview/mount` with `{ artifactId }` body; this dedicated route keeps the URL self-describing for the client restore path. |
| `GET` | `/api/preview/mount?sessionId=<sid>` | Bootstrap probe used by the panel after session-select. Returns `{ url, path, relPath, entry, mtime, contentHash, artifactId? }` (artifactId present iff an artifact was persisted for the current mount), or `404 { error: "no preview mount" }` if the mount is missing or empty. |
| `GET` | `/api/sessions/:id/preview-events` | Server-Sent Events stream for preview changes. Frames: `event: hello` on connect, `event: preview-changed` with `{entry, mtime, url, path, contentHash, artifactId?}` after every successful mount or artifact restore. Note: the SSE payload does **not** include `relPath` — only the mount REST responses do. The handler bootstraps by emitting one `preview-changed` event synchronously if a mount already exists for the session — closes the subscription race. 25 s `:keepalive` comments. Cookie auth (or admin bearer); sandbox-token requests get `403`. This route authenticates but never issues or renews a cookie. |

### Maintenance

Maintenance endpoints back Settings → Maintenance. They are preview-first and return structured counts so the UI can show cleaned, skipped, already-cleaned, and failed work. See [maintenance.md](maintenance.md) for the user/developer overview.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/maintenance/worktrees` | Canonical unified worktree inventory. Optional `?include=all|actionable|troubleshooting`; default is `all`. |
| `POST` | `/api/maintenance/cleanup-worktrees` | Canonical cleanup for all safe or selected unified worktree inventory items. Also accepts legacy orphan cleanup bodies. |
| `GET` | `/api/maintenance/orphaned-worktrees` | Legacy compatibility view of safe unowned Bobbit `session/*` git worktrees. |
| `GET` | `/api/maintenance/archived-session-worktrees` | Legacy compatibility view of archived-session worktree candidates. `?includeAlreadyCleaned=1` includes disabled diagnostic rows whose worktree path and git metadata are already gone. |
| `POST` | `/api/maintenance/cleanup-archived-session-worktrees` | Legacy compatibility cleanup for archived-session worktree candidates. |
| `GET` | `/api/maintenance/orphaned-sessions` | List orphaned non-interactive sessions. |
| `POST` | `/api/maintenance/cleanup-sessions` | Terminate selected orphaned sessions. |
| `GET` | `/api/maintenance/expired-archives` | Return expired archive purge counts and bytes. |
| `POST` | `/api/maintenance/purge-archives` | Purge expired archives. |
| `GET` | `/api/maintenance/orphaned-index-rows` | List search index rows whose parent records are gone (`?projectId=`). |
| `POST` | `/api/maintenance/cleanup-index-rows` | Delete orphaned search index rows (`{ projectId }`). |

**`GET /api/maintenance/worktrees`** returns the canonical inventory used by the unified Worktree Cleanup card. The inventory reconciles live runtime sessions, persisted live and archived sessions, goals, teams, delegates/child sessions, staff records, in-memory pool entries, git worktree metadata, and directories under each visible project's resolved worktree root.

```ts
type WorktreeInventoryClassification =
  | "ready-to-clean"
  | "protected-in-use"
  | "archived-owned"
  | "unowned-git-worktree"
  | "pool-entry"
  | "already-cleaned"
  | "stale-filesystem-only"
  | "scan-error";

interface WorktreeInventoryReport {
  items: WorktreeInventoryItem[];
  counts: {
    total: number;
    readyToClean: number;
    protectedInUse: number;
    archivedOwned: number;
    unownedGitWorktrees: number;
    poolEntries: number;
    alreadyCleaned: number;
    needsAttention: number;
    scanErrors: number;
    defaultSelected: number;
    byClassification: Record<string, number>;
    byReason: Record<string, number>;
    bySource: Record<string, number>;
  };
  generatedAt: number;
}
```

Each item includes project/repo/component provenance, `repoPath`, resolved `worktreeRoot`, `path`, optional `branch`, source list, owners, classification/disposition, machine-readable `reason`, human-readable `detail`, booleans for actionability/selection/default selection, path/git metadata state, and branch-deletion hints.

Use `?include=actionable` to return only cleanup candidates. Use `?include=troubleshooting` to return non-actionable diagnostic rows. Invalid `include` values return `400`.

**`POST /api/maintenance/cleanup-worktrees`** accepts the canonical bodies:

```json
{ "mode": "all-safe" }
```

```json
{ "mode": "selected", "itemIds": ["worktree-item-id"] }
```

`mode: "all-safe"` rejects selectors. `mode: "selected"` requires `itemIds` as an array of strings. If `itemIds` is present without `mode`, the request returns `400`. Non-object bodies are rejected.

The server always re-runs the unified inventory before cleanup and only removes fresh actionable candidates. Filesystem-only directories, pool entries, protected rows, stale selections, and invalid ids are skipped. Branch deletion is best-effort and blocked when any live or durable Bobbit record still references the branch.

```ts
interface CleanupWorktreeInventoryResponse {
  counts: {
    requested: number;
    cleaned: number;
    skipped: number;
    failed: number;
    branchDeleted: number;
    worktreeRemoved: number;
    notActionable: number;
    byStatus: Record<string, number>;
    byReason: Record<string, number>;
  };
  results: Array<{
    itemId: string;
    path?: string;
    repoPath?: string;
    branch?: string;
    status: "cleaned" | "skipped" | "already-cleaned" | "failed";
    reason?: string;
    detail?: string;
    worktreeRemoved: boolean;
    branchDeleted: boolean;
    error?: string;
  }>;
  generatedAt: number;
}
```

Legacy orphan cleanup bodies are still supported for compatibility. `{}` cleans all currently safe legacy orphan candidates and `{ worktrees: [{ path, branch, repoPath }] }` cleans matching safe candidates. Legacy responses keep the older `{ cleaned: number }` shape. Unknown keys in a legacy body return `400`.

**`GET /api/maintenance/orphaned-worktrees`** returns the legacy `{ worktrees }` shape. It is a filtered view of the unified inventory containing only actionable unowned Bobbit `session/*` git worktrees with `{ path, branch, repoPath }`.

**`GET /api/maintenance/archived-session-worktrees`** returns the existing archived-session compatibility shape: `sessions`, flattened `items`, `groups`, `selectionPresets`, additive `counts`, and `generatedAt`. It is backed by the unified inventory. Default scans omit sessions whose rows are all `already-cleaned`; use `?includeAlreadyCleaned=1` for diagnostics.

**`POST /api/maintenance/cleanup-archived-session-worktrees`** accepts the legacy archived-session modes:

- `{ "mode": "all" }`;
- `{ "mode": "selected", "sessionIds": [...] }`;
- `{ "mode": "selected", "worktrees": [{ "sessionId": "...", "key": "...", "repo": ".", "path": "..." }] }`;
- `{ "mode": "category", "categories": [...], "projectId"?: "...", "repoPath"?: "..." }`;
- `{ "mode": "preset", "presetId": "..." }`.

These modes are compatibility filters over the fresh unified scan; they do not bypass safety checks. Archived-session worktree cleanup preserves archived session metadata, transcripts, proposals, prompts, search records, and archive visibility.

### Search

Lexical (BM25-style) search over goals, sessions, messages, and staff. Backed by a per-project FlexSearch index. See [docs/internals.md — Semantic search](internals.md#semantic-search) and [docs/design/portable-search.md](design/portable-search.md).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/search` | Query. Params: `q`, `projectId?`, `type?`, `limit?`, `offset?`, `includeArchived?` / `include=archived`. Omit `projectId` to search across all projects. Archived rows are excluded unless explicitly requested. |
| `POST` | `/api/search/rebuild` | Kick off a full rebuild in the background (`{ projectId }`) |
| `GET` | `/api/search/stats` | Stats for the project's search index (`?projectId=`) |
| `POST` | `/api/search/compact` | No-op under FlexSearch; retained for API compatibility (`{ projectId }`) |
| `GET` | `/api/maintenance/orphaned-index-rows` | List index rows whose parent entity no longer exists (`?projectId=`) |
| `POST` | `/api/maintenance/cleanup-index-rows` | Delete orphaned index rows (`{ projectId }`) |

`GET /api/search` defaults to live-only results. Pass `includeArchived=true` or `include=archived` to include archived goals, sessions, messages, and staff matches. The full search UI uses `includeArchived=true` intentionally so archived badges/results remain visible; agent-facing `bobbit_read.search` stays live-only unless its caller opts in.

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

Three endpoints support a `?view=summary` query parameter that returns slim responses optimized for agent tool calls and gate progress counters. Without this parameter, the full response is returned for detail views.

**Why this exists:** Full gate and task responses include signal history, content bodies, verification output, and task specs — often hundreds of KB. Agent tools call these endpoints frequently, and every byte enters the LLM context window permanently. Summary views strip non-essential data, reducing typical `gate_list` responses from ~436KB to ~500B.

**`GET /api/goals/:id/gates?view=summary`**

Returns the server-authoritative gate progress summary for counters and status chips. The response is built by `src/server/gate-status-summary.ts` from stored `GateStore` state plus active verification state, so clients do not infer running or human-sign-off state from slim signal rows.

```json
{
  "passed": 0,
  "bypassed": 0,
  "bypassedCount": 0,
  "total": 1,
  "verifying": true,
  "verifyingCount": 1,
  "awaitingSignoffCount": 0,
  "awaitingHumanSignoff": false,
  "runningGateIds": ["implementation"],
  "gates": [{
    "gateId": "implementation",
    "name": "Implementation",
    "status": "passed",
    "effectiveStatus": "running",
    "running": true,
    "awaitingSignoffCount": 0,
    "dependsOn": ["design-doc"],
    "signalCount": 22,
    "updatedAt": 1775853741666
  }],
  "summary": { "...": "same fields as the top-level summary" }
}
```

Goal-wide fields: `passed`, `bypassed` (count of gates a human forced past verification; `bypassedCount` is an emitted alias for the same value), `total`, `verifying`, `verifyingCount`, `awaitingSignoffCount`, `awaitingHumanSignoff`, `runningGateIds`, and `gates`. `bypassed` is reported separately from `passed` so the badge can count bypassed gates toward the numerator while still flagging the goal as not-clean (red `(N/N)!`) — see [Human gate bypass](goals-workflows-tasks.md#human-gate-bypass). Per-gate fields: `gateId`, `name`, stored `status` (now includes `bypassed`), `effectiveStatus` (`running` while an active verification overlays stored state), `running`, `awaitingSignoffCount`, `dependsOn`, and `signalCount`. Conditional fields: `updatedAt` (if signaled) and `failedSteps` (if failed — names of non-passed, non-skipped verification steps). The top-level fields preserve existing consumers; `summary` is the canonical grouped shape used by newer clients.

**`GET /api/goals/:id/gates/:gateId?view=summary`**

Returns the latest signal only. Content body is replaced with `hasContent` + `contentLength`. When the latest signal is still running, `latestSignal.verification` is built from the same active snapshot used by `gate_inspect section=verification`, so `gate_status` and inspect agree on step status, durations, summary counts, active metadata, and bounded output.

```json
{
  "gateId": "implementation",
  "name": "Implementation",
  "status": "passed",
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
      "status": "running",
      "summary": "1 passed, 1 running, 1 waiting",
      "counts": { "passed": 1, "failed": 0, "skipped": 0, "running": 1, "waiting": 1, "blocked": 0 },
      "active": true,
      "steps": [
        { "name": "Type check passes", "type": "command", "status": "passed", "passed": true, "duration_ms": 15320 },
        { "name": "E2E tests", "type": "command", "status": "running", "duration_ms": 62150, "output": "… last 20 live lines …" },
        { "name": "QA review", "type": "agent-qa", "status": "waiting" }
      ],
      "selection": { "mode": "tail", "truncated": false }
    }
  }
}
```

Step `status` is explicit: `passed`, `failed`, `skipped`, `running`, `waiting`, or `blocked`. Non-final `running`, `waiting`, and `blocked` steps should not be interpreted as failed when `passed` is absent or null. Completed signals keep their persisted final results, including each step's explicit terminal `status`, `phase`, and `skipped` flag. Default verification output is the last 20 lines per step, including bounded live stdout/stderr tails for running command steps.

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

### Gate signal endpoint

**`POST /api/goals/:id/gates/:gateId/signal`** records a new gate signal and starts verification asynchronously. The response includes the signal id, gate id, goal id, current verification status, and the initialized step snapshot.

Verification step rows preserve the same durable fields used by gate inspection and history:

- `phase` — copied from the workflow step so clients can group and order phases;
- `status` — explicit lifecycle or terminal status (`waiting`, `running`, `passed`, `failed`, or `skipped`);
- `skipped` — `true` when a step was intentionally skipped, including disabled optional steps and downstream phase skips.

Fresh responses return the initialized rows from the verification harness. Cached same-commit responses return the persisted terminal `verification.steps[]` from the prior signal rather than rebuilding from workflow definitions, so cached cards retain skipped and phase metadata.

```json
{
  "id": "sig-22",
  "gateId": "implementation",
  "goalId": "goal-1",
  "status": "running",
  "steps": [
    { "name": "Type check", "type": "command", "phase": 0, "status": "running", "passed": false },
    { "name": "Unit tests", "type": "command", "phase": 1, "status": "waiting", "passed": false }
  ]
}
```

A completed or cached signal may include terminal rows such as:

```json
{ "name": "Later review", "type": "llm-review", "phase": 1, "status": "skipped", "skipped": true, "passed": false }
```

Skipped rows are intentional non-runs and are ignored by aggregate pass calculation; consumers should render them distinctly instead of inferring pass/fail from `passed` alone.

### Signal history endpoint

**`GET /api/goals/:id/gates/:gateId/signals`** returns the gate's complete stored signal history. The response also carries display metadata so identifier-only clients, such as gate-card sign-off launchers, can present readable review titles without making separate goal and workflow requests.

```json
{
  "signals": [{ "id": "sig-22", "content": "# Release candidate", "timestamp": 1775853741666 }],
  "goalTitle": "Ship release",
  "gateName": "Human approval"
}
```

`signals` is always present. `goalTitle` is included when the goal has a non-empty title, and `gateName` when the gate definition has a non-empty display name; either metadata field may be omitted. Consumers should prefer display names already present in their local context, then use this response metadata, and finally fall back to stable goal and gate identifiers. The signal history remains the content source of truth: launchers must select the exact signal by `id` rather than assuming the latest history row.

### Sign-off endpoint

**`POST /api/goals/:id/gates/:gateId/signoff`** — resolves a `human-signoff` verification step that is parked waiting on a human decision (`awaitingHuman: true` on the active verification's step). See [goals-workflows-tasks.md — Human sign-off steps](goals-workflows-tasks.md#human-sign-off-steps) for the full lifecycle.

Request body:

```json
{
  "signalId": "sig-7",
  "stepName": "design-approval",
  "decision": "pass",
  "feedback": "Approved — ship it."
}
```

| Field | Required | Notes |
|---|---|---|
| `signalId` | yes | Id of the gate signal whose verification owns the step. |
| `stepName` | yes | `name` of the parked step as declared in the workflow YAML. |
| `decision` | yes | `"pass"` or `"fail"`. Anything else → 400. |
| `feedback` | no | Free-form markdown. Stored verbatim in the step `output` and a `text/markdown` artifact. The review pane composes this from the final comment and inline comments when the decision came from a review document. |

Responses:

- **200** `{ "resolved": true }` — the resolver was invoked. The step result is built (`passed = decision === "pass"`) and the gate continues through the standard phase machinery.
- **400** — missing or malformed body.
- **404** — goal / signal / step does not exist or no active verification owns the signal/gate pair.
- **409** — idempotent surface. The step exists but is no longer awaiting human input. Body: `{ "error": "step is no longer awaiting human input", "stepName", "status": "passed" | "failed" | "skipped" }`. Distinguishes "another client just resolved it" from "never parked here".
- **400** when the goal is shelved; **409** when archived.

Authz (v1) trusts the gateway token — anyone with UI access can submit. Sandboxed sub-agents are blocked at the `sandbox-guard` layer so they cannot self-approve a sign-off step that gates their own work.

Review-pane behavior and validation are documented in [Review Pane Sign-Off](review-pane-signoff.md).

### Gate reset endpoint

**`POST /api/goals/:id/gates/:gateId/reset`** — invalidates a gate and every transitive downstream dependent from the goal's workflow DAG. The route has no required request body.

Response:

```json
{
  "ok": true,
  "gateId": "design-doc",
  "affectedGateIds": ["design-doc", "implementation", "ready-to-merge"],
  "changedGateIds": ["design-doc", "implementation"],
  "unchangedGateIds": ["ready-to-merge"],
  "previousStatuses": {
    "design-doc": "passed",
    "implementation": "failed",
    "ready-to-merge": "pending"
  },
  "gates": [
    { "gateId": "design-doc", "name": "Design Doc", "status": "pending" },
    { "gateId": "implementation", "name": "Implementation", "status": "pending" },
    { "gateId": "ready-to-merge", "name": "Ready to Merge", "status": "pending" }
  ],
  "reopen": {
    "reopened": true,
    "previousState": "complete",
    "state": "in-progress"
  },
  "teamLeadNotified": true
}
```

Notes:

- `affectedGateIds` includes the requested gate first, then downstream dependents reached through `dependsOn`.
- Only gates that were not already `pending` appear in `changedGateIds`; already-pending gates appear in `unchangedGateIds`.
- Every affected gate gets a `verificationCacheInvalidatedAt` marker. Signals at or before that timestamp cannot supply same-commit cached verification steps, so the next signal runs fresh verification even if the commit SHA is unchanged.
- Signal history, content, metadata, and verification output are preserved for audit. The gate `status` is the approval source of truth after reset.
- `human-signoff` approvals are never reused from verification cache; each re-signal requires a fresh human decision.
- After a fresh post-reset pass, later non-reset re-signals at the same commit may reuse that new passed output normally.
- Active verifications for affected gates are cancelled before the durable transaction begins. The route then re-reads the goal and repeats its dormant-state guards so cancellation cannot open a race with pause, shelving, or archival.
- `reopen` is always present. `reopened` reports whether the durable transaction includes `complete` → `in-progress`; `previousState` is the state captured by that transaction; and `state` is the resulting state. Active `todo`, `in-progress`, and `blocked` goals keep their current state.
- Reopening preserves the goal, tasks, gate audit data, branch/worktree and repository fields, and PR association. When a completed team runtime still exists, it also preserves and rearms that team and lead instead of replacing them.
- A completed goal whose team was explicitly torn down is still resettable. The goal reopens and its gates reset, but reset does not recreate a team, lead session, subscription, or nudge timer; `teamLeadNotified` is `false`. Starting a new runtime remains a separate operator action.
- A new successful request emits affected `gate_status_changed` events and `gate_reset` with the same `reopen` object. An actual reopen additionally emits global `goal_state_changed`. A retry that resumes a retained recovery intent suppresses duplicate events and notification.
- The team lead is notified only when at least one gate changed or the goal reopened and a live lead exists. The notice includes the lifecycle outcome. `teamLeadNotified` reports whether delivery succeeded.
- An exact retry after a fully finalized reset is idempotent: once all affected gates are pending and the goal is active, the response has `changedGateIds: []`, `reopen: { "reopened": false, "previousState": "in-progress", "state": "in-progress" }`, and `teamLeadNotified: false`; it does not rearm the runtime or send another lead notice.
- Sandboxed agent tokens are forbidden from this route.

#### Durable reset transaction

Goal lifecycle and gate state live in separate project stores. Reset coordinates them with a project-scoped write-ahead intent so a crash cannot leave the durable combination `complete` plus newly `pending` gates. After verification cancellation and lifecycle revalidation, the phases are:

1. Atomically persist an intent containing the requested gate, affected DAG scope, prior statuses, prior goal state, and whether reopening is required.
2. If required, strictly persist the goal as `in-progress`.
3. Strictly persist the selected and dependent gates as `pending`, including cache-invalidation markers.
4. Rearm the existing completed-team runtime, if one still exists.
5. Atomically clear the intent.

The goal and gate strict-write paths write through a temporary file and rename, propagate persistence errors, and restore their in-memory snapshot when the durable write fails. Gate observers run only after the strict gate commit; an observer failure is logged and cannot compensate the goal back to `complete` over already-pending gates.

Each project constructs its reset coordinator after loading its goal and gate stores but before team restoration and boot-resume scanning. Any retained intent is replayed state-first and idempotently, then cleared. Replay therefore handles restarts after intent persistence, goal persistence, gate persistence, or finalization failure. If replay itself cannot persist, the intent remains for a later restart. A goal explicitly made archived, shelved, or paused before replay wins over the older reset intent; recovery clears the intent without resuming work.

Synchronous commit failure uses controlled compensation. If strict gate persistence fails after the goal reopened, the server strictly restores the prior goal state and clears the intent before returning an error. No rearm, notification, or lifecycle/reset broadcast occurs. If either compensation write fails, the intent is deliberately retained so boot replay finishes the idempotent transaction instead of guessing which store won.

Runtime rearm is also retryable. If an existing team's unsubscribe or new event-subscription callback fails, the already-durable goal/gate reset is not rolled back. The API retains the intent and returns `503 TEAM_REOPEN_FAILED` with `retryable: true`, `durableReset: true`, and the original `reopen` outcome. Repeating the same reset resumes that intent and retries rearm without duplicate prompts, timers, events, or notifications. After success, the response reports the original affected scope and reopen outcome rather than presenting the durable replay as a no-op.

| Status | Code | Durable outcome |
|---|---|---|
| `500` | `GATE_RESET_PREPARE_FAILED` | Intent persistence failed; no goal or gate mutation occurred. `retryable: true`. |
| `500` | `GATE_RESET_PERSIST_FAILED` | Strict goal/gate commit failed. Successful compensation restores the pre-reset state; failed compensation leaves the intent for boot replay. `retryable: true`. |
| `503` | `TEAM_REOPEN_FAILED` | Goal and gates are durably reset, but an existing team runtime was not rearmed. Intent remains so the same request can retry. `durableReset: true`, `retryable: true`. |
| `500` | `GATE_RESET_FINALIZE_FAILED` | Goal, gates, and any required rearm committed, but intent cleanup failed. Replay or request retry finalizes idempotently. `durableReset: true`, `retryable: true`. |

Dormant goals are never reopened implicitly. Reset returns `409` before mutation for archived goals (`{ "error": "Goal is archived" }`), shelved goals (`{ "error": "Goal is shelved", "code": "GOAL_SHELVED", "goalId": "…" }`), and paused goals (`{ "error": "Goal … is paused", "code": "GOAL_PAUSED", "goalId": "…" }`). The goal must be returned to an active lifecycle through an explicit operator action before reset is allowed; reset itself never performs that recovery.

Other errors: 400 when the goal has no workflow; 403 for sandbox-scoped tokens; 404 for unknown goal/gate.

### Gate bypass endpoint

**`POST /api/goals/:id/gates/:gateId/bypass`** — a **human-only** override that forces a not-yet-passed gate to the distinct `bypassed` status when a verification step is genuinely impossible to satisfy. Modeled on the reset endpoint. This capability is **never advertised to agents**: there is no MCP/agent tool for it and it is absent from all agent-facing prompts and docs. The `isInitiatedByHuman` flag is the runtime backstop; non-discoverability is the primary defense. Full design and UI behavior: [goals-workflows-tasks.md — Human gate bypass](goals-workflows-tasks.md#human-gate-bypass).

Request body:

```json
{
  "whyBypassed": "The integration suite needs a vendor sandbox we can't provision here; verified manually instead.",
  "whoAmI": "Jane (release owner)",
  "isInitiatedByHuman": true
}
```

| Field | Required | Notes |
|---|---|---|
| `whyBypassed` | yes | Non-empty justification, persisted verbatim in the audit signal. |
| `whoAmI` | yes | Non-empty free-text label naming who bypassed. Not verified — honesty system. |
| `isInitiatedByHuman` | yes | Must be exactly `true`. Anything else is refused (see below). |

On success the gate status becomes `bypassed`, a synthetic audit signal (`sessionId: "human-bypass"`, `metadata.bypass: "true"`, plus `whyBypassed` / `whoAmI` / `bypassedAt`) is appended to the gate's signal history, any stale running verification for the gate is cancelled, a `gate_status_changed` event is broadcast on the goal WebSocket, and the live team lead (if any) is notified.

Response:

```json
{
  "ok": true,
  "gateId": "agent-qa",
  "status": "bypassed",
  "whyBypassed": "...",
  "whoAmI": "Jane (release owner)",
  "bypassedAt": "1739812345678",
  "teamLeadNotified": true
}
```

Errors:

- **400** when `isInitiatedByHuman !== true`, with the guard message: *"This method is currently intended for human use only. Bypassing a gate as an agent is not acting in the best interest of the outcome."* This is the default response an agent gets if it ever stumbles onto the route.
- **400** when `whyBypassed` or `whoAmI` is missing or blank; **400** when the goal has no workflow.
- **403** for sandbox-scoped tokens (checked before the body is read).
- **404** for unknown goal or unknown gate.
- **409** when the goal is archived or shelved.

**Downstream and completion semantics.** A bypassed gate satisfies dependency ordering for downstream gates (it unblocks dependents exactly like a passed gate), but it does **not** inject content into downstream agents — only `passed` gates with `injectDownstream` do that. The goal still cannot be completed by the agent path while a bypassed gate exists: `POST /api/goals/:id/team/complete` refuses with `Cannot complete: N gate(s) were bypassed and require human confirmation` unless called with `{ confirmBypassedGates: true }`, which is itself rejected with 403 for sandbox tokens. Resetting a bypassed gate returns it to `pending`.

### Gate inspect endpoint

**`GET /api/goals/:id/gates/:gateId/inspect`**

A scoped read endpoint for targeted gate data retrieval. Used by the `gate_inspect` agent tool. It applies bounded text selection to text-heavy gate fields so agents can inspect large content, verification output, retained artifacts, and signal history without loading the full payload into context.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `section` | `"content"` \| `"verification"` \| `"artifact"` \| `"signals"` | yes | — | What data to retrieve |
| `signal_index` | integer | no | `-1` (latest) | Which signal. 0-based, negative indexes from end. Ignored for `section=signals`. |
| `step` | string | no | — | `section=verification` or `section=artifact`: scope to a single verification step by name. Other sections return 400. |
| `artifact` | string | for `artifact` | — | Artifact id from `diagnostics.artifacts.files[].id` or exact `relativePath`. |
| `retry` | integer | no | — | `section=artifact` only: fetch a specific Playwright retry for a collapsed artifact id. |
| `mode` | `"full"` \| `"grep"` \| `"head"` \| `"tail"` \| `"slice"` | no | `"tail"` | Retrieval mode. Omitted mode returns bounded tail output, not full output. |
| `pattern` | string | for `grep` | — | Regex used by `mode=grep`. Invalid regexes return 400. |
| `context` | integer | no | `0` | Surrounding lines to include around each grep match. |
| `max_results` | integer | no | server default | Maximum grep matches before truncating. |
| `lines` | integer | no | server default | Number of lines for `mode=head` or `mode=tail`. |
| `from` / `to` | integer | for `slice` | — | 1-indexed inclusive line range for `mode=slice`. |

Retrieval controls mirror the background-shell inspection tools where they make sense:

- `grep` returns line-numbered regex matches with optional merged context.
- `slice` returns a line-numbered 1-indexed inclusive range.
- `head` and `tail` return bounded ranges identified in metadata.
- `full` requests the full rendered text, but normal line/byte/tool-result caps still apply.

When `mode` is omitted, content, verification, and signal-history reads default to the last 20 lines; artifact reads default to a bounded tail sized for one retained file. If an implicit default omits earlier lines, the response includes an omission hint such as:

```text
[N lines omitted — use mode="grep" with pattern="error|failed", or mode="slice" from=X to=Y, to inspect more]
```

Explicit `grep`, `head`, `tail`, `slice`, and `full` requests do not add this guidance hint beyond normal truncation metadata.

Selection metadata is returned with filtered output:

| Field | Meaning |
|---|---|
| `selection.mode` | Retrieval mode used |
| `selection.totalLines` | Total rendered line count when available |
| `selection.range` | Selected line range, when applicable |
| `selection.matchCount` / `selection.shownMatches` | Total and returned grep matches, when applicable |
| `selection.truncated` | Whether selection or response caps were applied |
| `selection.truncationReason` | Why output was truncated, when applicable |
| `selection.omittedHint` | Hint shown only for implicit default tails that omitted lines |

**`section=content`** — Returns selected markdown content from a specific signal.
```json
{
  "gateId": "design-doc",
  "section": "content",
  "signalIndex": 0,
  "signalId": "sig-1",
  "text": "120: ## Detailed Plan\n121: ...",
  "selection": {
    "mode": "slice",
    "totalLines": 240,
    "range": { "from": 120, "to": 180 },
    "truncated": false
  }
}
```

**`section=verification`** — Returns a verification snapshot with each step's `output` independently selected. For the latest running signal, this is the same active snapshot used by `gate_status`: persisted signal rows are overlaid with active harness state before output selection. A top-level `selection` may also appear when the combined response is capped.

Pass `step=<name>` to scope the snapshot to a single verification step. When set, `steps[]` contains only the matching step (still a single-element array, so the same response shape applies) and the selection mode applies to that one step's output. Step names come from `gate_status.failedSteps` and from each step's `name` in an unfiltered snapshot. An unknown step name returns 400 with the list of available step names for that signal; using `step` with `section=content` or `section=signals` returns 400.

Retained artifact bodies are not inlined in verification snapshots. `steps[].diagnostics.artifacts.files[]` is a compact metadata index only, with ids, paths, sizes, kinds, and retry metadata so callers can choose one file to fetch via `section=artifact`.
```json
{
  "gateId": "implementation",
  "section": "verification",
  "signalIndex": 21,
  "signalId": "sig-22",
  "status": "running",
  "summary": "1 passed, 1 running, 1 waiting",
  "counts": { "passed": 1, "failed": 0, "skipped": 0, "running": 1, "waiting": 1, "blocked": 0 },
  "active": true,
  "steps": [
    {
      "name": "Type check passes",
      "type": "command",
      "status": "passed",
      "passed": true,
      "duration_ms": 15320,
      "selection": { "mode": "tail", "totalLines": 1, "truncated": false }
    },
    {
      "name": "E2E tests",
      "type": "command",
      "status": "running",
      "duration_ms": 95200,
      "output": "… last 20 live stdout/stderr lines …",
      "liveLogs": { "stdout": true, "stderr": true },
      "selection": { "mode": "tail", "totalLines": 900, "range": { "from": 881, "to": 900 }, "truncated": false }
    },
    {
      "name": "QA review",
      "type": "agent-qa",
      "status": "waiting"
    }
  ],
  "selection": { "mode": "tail", "truncated": false }
}
```

Step `status` is one of `passed`, `failed`, `skipped`, `running`, `waiting`, or `blocked`. `waiting` means the step is yet to run. `blocked` is an active-snapshot derived state for a step blocked by an earlier phase failure; terminal persisted rows use `status: "skipped"` with `skipped: true` and their original `phase`. For non-final `running`, `waiting`, and `blocked` rows, `passed` may be absent or null; clients must not infer failure from old placeholder `passed: false` seed values.

Running command steps may include bounded live stdout/stderr reads via `liveLogs`. The server reads a capped portion of the live log file first, then applies the requested `tail`, `head`, `slice`, `grep`, or `full` selection and the aggregate output budget. Use those selection modes for deeper targeted logs instead of relying on the default 20-line tail.

Completed command steps can include retained diagnostics. When a verification request uses an explicit `mode`, `steps[].diagnostics` may report:

| Field | Meaning |
|---|---|
| `diagnostics.outputSource` | `"retained-logs"`, `"live-logs"`, or `"compact-tail"` |
| `diagnostics.logs.stdout` / `stderr` | Retained log path, bytes, line count, and cap/truncation metadata |
| `diagnostics.artifacts` | Compact retained artifact index for copied `test-results` / `playwright-report` files. Rows include metadata such as `id`, `relativePath`, retained `path`, `bytes`, `kind`, optional `testName`, and retry fields; rows do not include file `content`. |
| `diagnostics.inspectHints` | Suggested `gate_inspect` calls for targeted follow-up, including artifact fetch examples when artifacts exist |
| `diagnostics.note` | Human-readable summary of which output source was used |

Default `gate_status`, notifications, and omitted-mode inspection do not include retained log paths or artifact file lists. Retained stdout and stderr are capped at 20 MiB per stream, and explicit inspection exposes cap/truncation metadata. See [Retained gate diagnostics](gate-diagnostics.md) for artifact retention, symlink hardening, and cleanup lifecycle.

**`section=artifact`** — Returns selected text from one retained artifact file. `artifact` is required and accepts either the stable metadata `id` or an exact `relativePath`. Use `retry=N` with a collapsed Playwright retry id, or pass the retry artifact's exact `relativePath`. Use `step=<name>` when the artifact id is ambiguous across verification steps.

Artifact reads use the same `mode`, `pattern`, `context`, `max_results`, `lines`, `from`, and `to` selection controls. Omitted `mode` defaults to a bounded tail for a single file; explicit `mode=full` is still capped by normal selection and tool-result budgets. The retained `path` remains exposed in verification metadata so direct `read(path)` remains available as a fallback.

```json
{
  "gateId": "implementation",
  "section": "artifact",
  "signalIndex": 21,
  "signalId": "sig-22",
  "step": "E2E tests",
  "artifact": {
    "id": "pr-walkthrough-host-agents-078cd-child-self-recover--api",
    "relativePath": "test-results/pr-walkthrough-host-agents-078cd-child-self-recover--api/error-context.md",
    "path": "<stateDir>/gate-diagnostics/.../artifacts/test-results/pr-walkthrough-host-agents-078cd-child-self-recover--api/error-context.md",
    "bytes": 10094,
    "kind": "test-results",
    "retry": 1
  },
  "text": "bounded selected content",
  "selection": { "mode": "tail", "totalLines": 300, "range": { "from": 101, "to": 300 }, "truncated": false }
}
```

**`section=signals`** — Returns bounded signal history. The `signals[]` field remains present for compatibility, and large histories include totals/truncation fields plus deterministic selected JSON-lines `text`.
```json
{
  "gateId": "implementation",
  "section": "signals",
  "signalsTotal": 22,
  "signalsShown": 1,
  "signalsTruncated": true,
  "signals": [
    { "index": 21, "id": "sig-22", "timestamp": 1775812345000, "sessionId": "efed71fb", "commitSha": "abc123", "verdict": "failed", "hasContent": true, "metadataKeys": ["new_regressions"] }
  ],
  "text": "{\"index\":21,\"id\":\"sig-22\",\"timestamp\":1775812345000,\"sessionId\":\"efed71fb\",\"commitSha\":\"abc123\",\"verdict\":\"failed\",\"hasContent\":true,\"metadataKeys\":[\"new_regressions\"]}",
  "selection": {
    "mode": "tail",
    "totalLines": 22,
    "range": { "from": 22, "to": 22 },
    "truncated": false
  }
}
```

Examples:

```text
GET /api/goals/goal-1/gates/implementation/inspect?section=verification&mode=grep&pattern=error%7Cfailed&context=2
GET /api/goals/goal-1/gates/implementation/inspect?section=verification&mode=tail&lines=80
GET /api/goals/goal-1/gates/implementation/inspect?section=verification&mode=slice&from=120&to=180
GET /api/goals/goal-1/gates/implementation/inspect?section=verification&step=unit&mode=grep&pattern=error%7Cfailed&context=2
GET /api/goals/goal-1/gates/implementation/inspect?section=artifact&step=E2E%20tests&artifact=pr-walkthrough-host-agents-078cd-child-self-recover--api&mode=grep&pattern=Error%7Clocator%7Cfailed&context=3
GET /api/goals/goal-1/gates/implementation/inspect?section=artifact&step=E2E%20tests&artifact=pr-walkthrough-host-agents-078cd-child-self-recover--api&retry=1&mode=tail&lines=120
GET /api/goals/goal-1/gates/implementation/inspect?section=artifact&artifact=test-results%2Fpr-walkthrough-host-agents-078cd-child-self-recover--api%2Ferror-context.md&mode=slice&from=40&to=120
GET /api/goals/goal-1/gates/implementation/inspect?section=verification&mode=full
```

Returns 400 if `section` is missing or invalid, regex compilation fails, line counts are invalid, a slice range is missing/non-integer/below 1/`from > to`, `step` names an unknown step, `step` is combined with `section=content`/`section=signals`, `artifact` is missing for `section=artifact`, an artifact id or relative path is unknown, or `retry` is invalid. Artifact lookup errors include available ids or step names where possible. Returns 404 if the resolved signal index is out of range.

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

`POST /api/sessions/:archivedId/continue` creates a brand-new session whose agent CLI rehydrates from a clone of an archived, non-goal, non-delegate session's `.jsonl`. Used by the "Continue in New Session" footer button on archived session transcripts.

**Why it exists**: Users often want to pick up work from a finished session without reanimating its runtime state (stale worktree, dead sandbox container, committed/uncommitted changes on an old branch). This endpoint copies the *configuration* (project, model, role, sandbox mode, worktree mode) plus the source conversation history, while routing through the normal session-setup pipeline so the runtime is entirely fresh — new worktree, new container state, no branch/commit inheritance, no goal/team/delegate relationships. The agent CLI rehydrates the cloned transcript via `switch_session`, the same mechanism restart-resume uses for live sessions — lossless user-visible transcript content, no byte budget, no system-prompt injection.

For archived worktree-backed sources, the persisted `worktreePath` is only a provenance marker that enables worktree mode for the continued session. The endpoint does not require that path or the archived `branch` to exist, and it does not reuse them. The continued session gets its own `session/<new-id8>` branch/worktree from the currently registered project repo and configured base ref. Archived cwd/worktree values may be used only as old values when rebasing runtime-only Pi cwd metadata in the cloned transcript.

Non-sandboxed worktree-backed continues use the normal session worktree allocation path: claim a ready project worktree-pool entry when available, and fall back to cold `createWorktree` / `createWorktreeSet` if the pool is empty, returns `null`, or `claim()` throws. Sandboxed continues explicitly bypass the host-side pool because their worktrees live inside the project sandbox container. Single-repo and multi-repo projects use the same worktree-support resolver as `POST /api/sessions`, so Continue-Archived does not have a separate capability rule.

**Request body**: empty (or absent). A legacy `mode` field is tolerated but ignored — there is no Summary vs Full distinction any more, and no transcript truncation. See [docs/design/lossless-continue-archived.md](design/lossless-continue-archived.md) for the design rationale.

**Assistant sessions are accepted.** Sessions with `assistantType` set (one of `goal | role | tool | staff | project`) can be continued; the new session inherits the source's `assistantType`, persisted `role`, and `accessory`, and the proposal-draft directory — live `<type>.{md,yaml}` plus the `<type>.history/<rev>.<ext>` snapshot tree — is cloned verbatim into the new session's slot via `copyProposalDirIfPresent` (a sibling of `copyToolContentDirIfPresent` in `src/server/agent/continue-archived.ts`). The standard WS `auth_ok` rehydrate broadcast surfaces the draft in the proposal panel without extra wiring. See [docs/archived-proposal-reopen.md](archived-proposal-reopen.md) for the user-facing flow. Coding-agent guards (`goalId`, `delegateOf`, `teamGoalId`) remain in place — those sessions still return **422**.

**Success response** (`201 Created`):

```json
{
  "id": "<new session id>",
  "cwd": "<new session working directory>",
  "status": "<idle | streaming | ...>",
  "title": "Continued: <original title>",
  "assistantType": "<goal | role | tool | staff | project | null>"
}
```

The new session's title is marked as generated, which prevents the first-message auto-titler from overwriting `Continued: …` on the user's first prompt. `assistantType` echoes the source value (or `null` for non-assistant sessions) so callers can confirm the identity carried over. If the source was worktree-backed, the returned `cwd` points at the newly claimed or cold-created worktree path, not the archived source path.

Before `switch_session`, worktree-backed continues move the cloned JSONL into the final worktree-cwd slug path, then may rewrite runtime-only Pi cwd/session metadata from archived cwd/worktree values to the fresh cwd. Message content and user-visible transcript text are preserved losslessly.

**Error responses**:

| Status | Meaning |
|---|---|
| `404` | Archived session not found, or its transcript (`.jsonl`) is missing on disk and `recoverSessionFile` cannot locate it |
| `409` | Source session is not archived |
| `410` | Source project has been unregistered (session cannot be continued without its project context) |
| `422` | Source is a goal, delegate, or team member (`goalId` / `delegateOf` / `teamGoalId` set) — not eligible for continuation; **or** the copy would cross realms (host↔sandbox or between two different sandboxed projects — `CrossRealmCopyError`) |
| `500` | JSONL clone failed unexpectedly (e.g. disk full, permission denied), or fresh session/worktree creation failed against the current project repo/base ref after any pool fallback. Clone failures unlink the destination file and create no session row; create-session failures clean up the cloned transcript and any copied proposal/tool-content directories. A pool miss, `null` claim, or claim exception is not an API error by itself. Errors for worktree setup should identify the current project/base/worktree problem, not the archived source path or branch. See server logs. |

**Scope gate**: The endpoint refuses goal-linked, delegate, and team-member sessions on purpose. Goal coupling (team structure, gates, tasks, shared worktrees) and delegate scoping don't survive the continue-into-a-fresh-session model. Users wanting to iterate on a goal should create a new session inside the goal instead. Assistant sessions (`assistantType` set) are explicitly **not** in this gate — see the previous paragraph for the carry-over semantics.

**Cross-realm rejection**: `sessionFileCopy` (`src/server/agent/session-fs.ts`) supports host↔host and same-project sandboxed↔same-project sandboxed copies only. Host↔sandbox and cross-project sandboxed copies throw `CrossRealmCopyError`, which the handler maps to **422**. The user can re-register the project with matching sandbox config and retry. See [docs/internals.md — Continue-Archived sessions](internals.md#continue-archived-sessions) for the full mechanism.

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
