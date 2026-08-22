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

### Cross-origin API preflight

Every `/api/` response advertises the API's complete request-method contract:
`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`. An `OPTIONS` preflight
returns `204` and additionally caches that approval for 600 seconds via
`Access-Control-Max-Age`. This lets a UI on a different origin perform every
supported API mutation, including `PATCH`, rather than having the browser
reject a valid request before it reaches the gateway.

The preflight allows these non-simple request headers:

- `Authorization`
- `Content-Type`
- `If-Match`
- `X-Bobbit-Session-Id`
- `X-Bobbit-Spawning-Session`
- `X-Bobbit-Session-Secret`

These headers are permitted so authenticated, concurrency-aware, and
session-scoped API calls can cross origins; permission is not authentication.
In particular, a remote UI normally authenticates with its explicit Bearer
token. CORS is intentionally non-credentialed: the gateway does not send
`Access-Control-Allow-Credentials`, so browsers must not rely on cross-origin
cookie authentication. Same-origin cookie flows remain governed by their
normal authentication rules.

This does not broaden the origin policy. A gateway serving its UI reflects the
request origin (and varies by `Origin`); a gateway not serving the UI continues
to advertise `*`. The method and header contract is separate from that origin
decision.

For example, the side-panel workspace persists a tab edit through
`PATCH /api/sessions/:id/side-panel-workspace/tabs/:tabId`. When the UI and
gateway use different origins, the browser preflights that `PATCH` before the
request. Advertising `PATCH`, `Authorization`, and any applicable session or
concurrency header lets the persistence request reach its existing route, so a
side-panel edit is retained instead of appearing to be forgotten after reload.

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

A small set of UI probe endpoints accept `optional=1` to represent definitive expected absence without producing browser-console-noisy `404` responses. A missing prompt draft on an existing session returns empty `204`; its bare request retains `404`. PR status returns empty `204` only when the target is ineligible/unresolved or an eligible lookup definitively found no PR. Eligible cold, in-flight, failed, and found PR states remain `200` snapshot envelopes in both modes. Missing sessions or goals remain `404`, and no-worktree Git restrictions remain `409`. Never parse a `204` body. See [Quiet optional probes](quiet-204-probes.md) for the exact state matrix and [Coordinated remote-state status](#coordinated-remote-state-status) for the PR envelope.

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
| `GET` | `/api/sessions` | List sessions. Every serialized row includes normalized `user_tags` and fresh derived `server_tags`. Supports `?since=N` generation counter for conditional fetch. `?include=archived` adds archived rows; `q` filters the archived corpus by title/role before pagination. Response includes `archivedDelegates` array (see below). See [Archived session list and query search](#archived-session-list-and-query-search) and [Session list tags and pinning](#session-list-tags-and-pinning). |
| `POST` | `/api/sessions` | Create a session (normal, delegate, or with role/traits/assistant type/reattemptGoalId). Standard sessions use the [default role contract](#standard-session-role-resolution). |
| `POST` | `/api/sessions/:id/fork` | Fork a live session. Body `{ newWorktree?: boolean, entryId?: string }`: omit `entryId` to clone the whole source JSONL, or supply a durable Pi prompt cursor to clone the active branch strictly before that prompt. See [Fork session endpoint](#fork-session-endpoint). |
| `POST` | `/api/sessions/:id/restart` | Restart a live session's agent process in place. Body `{ force?: boolean }`. See [Restart session agent endpoint](#restart-session-agent-endpoint) |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Terminate a session. A sandbox worktree owner with a live history-fork borrower returns typed `409 SHARED_SANDBOX_WORKTREE_IN_USE` without changing the owner. |
| `PATCH` | `/api/sessions/:id` | Update session properties (title, colorIndex, preview, roleId, traits, assistantType, goalId) |
| `PUT` | `/api/sessions/:id/title` | Rename a session (legacy endpoint) |
| `POST` | `/api/sessions/:id/wait` | Block until session becomes idle, then return output |
| `POST` | `/api/sessions/:id/prompt` | Prompt or steer any live target session. Body `{ message, mode?: "prompt" | "steer" }`; default mode is `"prompt"`. Successful responses include display metadata as `target: { sessionId, title? }`. Requires a caller session secret whose allowed tools include `session_prompt`; targets are otherwise arbitrary live sessions. A processless target awaiting model recovery returns `409 { code: "MODEL_SELECTION_REQUIRED" }` before prompt or steer acceptance, so no queue or transcript work is created; select a replacement through the session picker/`set_model` path. The existing `409 { code: "GOAL_PAUSED" }` response still applies when the target session's goal is paused (sessions with no associated goal are unaffected). See [Session prompt tools](session-prompt-tools.md). |
| `POST` | `/api/sessions/:id/mark-read` | Record that the user viewed this session. Sets `lastReadAt = Date.now()` on the persisted session row; clients compare `lastActivity > lastReadAt` to render the unseen-activity dot. Works on live, dormant, and archived sessions. See [docs/internals.md — Read/unread state](internals.md#readunread-state). 404 if the session id is unknown. |
| `PUT` | `/api/sessions/:id/pin` | Set or remove the durable `pinned=true` user tag. The body must be exactly `{ "pinned": boolean }`; success returns `{ "user_tags": string[] }`. See [Session list tags and pinning](#session-list-tags-and-pinning). |
| `POST` | `/api/sessions/:archivedId/continue` | Create a new session whose agent CLI rehydrates from a clone of the archived `.jsonl` while preserving user-visible transcript content losslessly. See [Continue-Archived endpoint](#continue-archived-endpoint) |
| `GET` | `/api/sessions/:id/output` | Get final assistant output from the last turn |
| `GET` | `/api/sessions/:id/draft?type=:type` | Read a persisted UI draft. Missing drafts return `404` by default; `optional=1` returns empty `204` for expected absence when the session exists. |
| `GET` | `/api/sessions/:id/git-status` | Read-only Git status for the session working directory (branch, upstream, ahead/behind, dirty files). Never publishes or updates a remote branch. See [Coordinated remote-state status](#coordinated-remote-state-status). |
| `GET` | `/api/sessions/:id/commits` | Commit list for the session branch. Supports `direction=behind` and `vs=primary`; includes changed files for each commit. See [Git commit lists and commit-scoped diffs](#git-commit-lists-and-commit-scoped-diffs) |
| `GET` | `/api/sessions/:id/git-diff` | Unified diff for the working tree, or for one committed file when `commit=<sha>&file=<path>` is supplied. See [Git commit lists and commit-scoped diffs](#git-commit-lists-and-commit-scoped-diffs) |
| `GET` | `/api/sessions/:id/pr-status` | Coordinated PR fast state for the session branch. See [Coordinated remote-state status](#coordinated-remote-state-status) for the snapshot envelope and missing-PR behavior. |
| `POST` | `/api/sessions/:id/bg-processes` | Start a background process and return its `BgProcessInfo` snapshot |
| `GET` | `/api/sessions/:id/bg-processes` | List active/exited background process snapshots for REST hydration |
| `GET` | `/api/sessions/:id/bg-processes/:pid/wait` | Long-poll until a background process exits, times out, or is interrupted |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid?action=kill` | Terminate a running process (whole tree / group); keep the now-terminal record until dismissed. `{ ok, killed }`; 404 if not found/not running |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid?action=dismiss` | Remove the record **and** delete its persisted log/status/spool files; broadcasts `bg_process_dismissed`. `{ ok }`; 409 if still running |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid` | Legacy: kill-if-running, else dismiss |
| `GET` | `/api/sessions/:id/cost` | Persisted cumulative token usage and cost for a single session. Returns 404 when no cost record exists. Response includes `cacheHitRate: number \| null`. See [session-cost.md](session-cost.md) and [Cache-hit rate](cache-hit-rate.md). |
| `GET` | `/api/sessions/:id/cost/breakdown` | Session cost plus delegate-session breakdown, used by the session cost popover; cost objects include `cacheHitRate: number \| null`. |
| `GET` | `/api/sessions/:id/tool-content/by-tool-call/:toolCallId/:blockIndex` | Preferred identity-addressed lazy-load for a truncated tool-content block. `?expected=preview-snapshot` verifies a historical preview marker before returning it (see [Large content truncation](#large-content-truncation)). |
| `GET` | `/api/sessions/:id/tool-content/:messageIndex/:blockIndex` | Legacy positional lazy-load for a truncated block; retained for compatibility (see [Large content truncation](#large-content-truncation)). |
| `GET` | `/api/sessions/:id/transcript` | Without `operation`, preserves legacy direct REST/UI paging and the `verbose`, `include_tool_results`, and `includeToolResults` aliases. Agent calls use `operation=list` for compact discovery or `operation=inspect` for one exact message/result. See [Focused transcript reads](read-session.md). |
| `GET` | `/api/sessions/:id/transcript/before-compaction` | Paginated read of the orphaned pre-compaction entries for a single compaction event. Query params: `compactionId` (required, sidecar entry id), `cursor` (from previous response's `nextCursor`), `limit` (default 50, clamped 1..200). Response envelope `{ total, returned, nextCursor, messages[] }`. Requires normal bearer/session authentication, then resolves the target session across gateway-accessible projects; any authenticated same-gateway caller that can reach the target session may read it, matching `read_session` / `GET /api/sessions/:id/transcript`. Errors: `session_not_found` (404), `transcript_unavailable` (404), `compaction_not_found` (404), `invalid_params` (400), `internal_error` (500). Split resolution order is sidecar `firstKeptEntryId`, then the in-file compaction entry's `firstKeptEntryId`, then the inline `type:"compaction"` marker itself for retained-tail-only or unresolvable-id checkpoints. Reader: `readOrphanedBeforeCompaction` in `src/server/agent/transcript-reader.ts` using the target session's sandbox-aware transcript read path. See [docs/compaction-history.md](compaction-history.md). |
| `GET` | `/api/sessions/:id/transcript/before-clear` | Authenticated, display-only pagination over the transcript segment immediately before one durable context-clear boundary. Requires `clearId`; see [Before-clear history](#before-clear-history). |
| `POST` | `/api/sessions/:id/provider-hooks/before-prompt` | Per-turn lifecycle dispatch, called only by the generated provider-bridge pi extension. Body `{ prompt?, turn?: { index } }`. Dispatches the `beforePrompt` hook and returns `{ content, tail, blocks }` — `content` is the fenced dynamic-context text delivered by the bridge as a hidden `bobbit:dynamic-context` custom/user-side message (or `""`), `tail` is temporary legacy system-prompt-tail back-compat for old bridges, and `blocks` is metadata-only `{ id, providerId, title, tokenEstimate }[]`. The endpoint also refreshes the prompt inspector's Dynamic Context snapshot best-effort; current bridges consume `content` and filter stale persisted dynamic-context custom messages from future LLM contexts instead of using `message_end` scrub. `404` for unknown session; `{ content: "", tail: "", blocks: [] }` when no Lifecycle Hub is configured. See [docs/lifecycle-hub.md](lifecycle-hub.md#per-turn--lifecycle-wiring-g14). |
| `POST` | `/api/sessions/:id/provider-hooks/before-compact` | Per-turn dispatch from the provider-bridge extension before transcript compaction. Dispatches `beforeCompact` and returns `{}` once provider flushes settle (bounded by per-provider timeouts). `404` for unknown session. |
| `GET` | `/api/sessions/:id/context-trace?limit=N` | Per-turn provider-dispatch trace for diagnostics. Returns `{ entries }` oldest→newest from `ContextTraceStore`; `limit` keeps the most recent N (clamped to 1000). Each entry records the hook, timestamp, and per-provider timing / blocks-kept / omitted / error. See [docs/lifecycle-hub.md](lifecycle-hub.md#the-trace-store). |
| `GET` | `/api/sessions/:id/google-code-assist/token` | Short-lived runtime material for the agent-side Code Assist (`google-gemini-cli`) provider extension: `{ accessToken, projectId }`. Refreshes the stored Google OAuth token per request; **never** returns the OAuth refresh token. `401 { code: "GOOGLE_CODE_ASSIST_REAUTH" }` when no account is signed in or the token can't be refreshed (prompts re-auth, not an API key); `502 { code: "GOOGLE_CODE_ASSIST_PROJECT" }` when the token is valid but project onboarding failed. `projectId` honors `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` when set. See [Google OAuth & Gemini models](google-oauth-models.md#per-request-token--project-endpoint). |

#### Before-clear history

`GET /api/sessions/:id/transcript/before-clear` returns only the message rows on
the active parent-linked branch of the transcript segment associated with one
**Context Cleared** boundary. It is a display API: neither compact-preview nor
verbose responses modify the active transcript or add history back to model
context. See [Session context controls](features.md#session-context-controls)
for `/clear` behavior.

The route uses normal bearer/session authentication and the same gateway-wide
target-session access as `read_session`, the ordinary transcript endpoint, and
before-compaction history. Any authenticated same-gateway caller that can reach
the target session may read the segment.

Query parameters:

| Parameter | Contract |
|---|---|
| `clearId` | Required opaque boundary ID. It must be at most 256 characters and match `clr_[A-Za-z0-9_-]+`. |
| `cursor` | Optional zero-based message offset; defaults to `0`. Pass a non-null `nextCursor` to continue forward. |
| `offset` | Alias for `cursor`. If both are present, their raw values must match. |
| `limit` | Optional integer from `1` through `200`; defaults to `50`. |
| `verbose` | Optional boolean: `1` or `true` returns renderer-ready rows with the full message projection; `0` or `false` returns compact previews. Matching is case-insensitive. |

Successful reads return messages in transcript order:

```json
{
  "total": 1,
  "returned": 1,
  "nextCursor": null,
  "messages": [
    { "index": 0, "role": "user", "ts": "2026-08-22T19:05:00.000Z", "text": "..." }
  ]
}
```

`total` is independent of pagination, `returned` is the number of rows in this
page, and `nextCursor` is `null` after the final page. A valid boundary whose
preceding transcript generation was intentionally unmaterialized returns
`200 { "total": 0, "returned": 0, "nextCursor": null, "messages": [] }`.

Route errors are:

| Status | Payload | Meaning |
|---|---|---|
| `400` | `{ "error": "invalid_params", "detail": "..." }` | `clearId`, cursor/offset, limit, or verbose validation failed. |
| `404` | `{ "error": "session_not_found" }` | The target session does not exist. |
| `404` | `{ "error": "clear_not_found" }` | The target session has no boundary with that `clearId`. |
| `404` | `{ "error": "transcript_unavailable", "detail": "..." }` | The retained display transcript cannot be read. |
| `500` | `{ "error": "internal_error", "detail": "..." }` | An unexpected request-processing failure occurred. |

The implementation entry points are the `beforeClearMatch` route in the server
and `readClearHistory` in the transcript reader.

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

No-operation requests retain the legacy direct REST/UI aliases and behavior. Agent `read_session` requests instead use `operation=list` to choose an index, then `operation=inspect` for exactly that message or result; its closed schema does not accept the legacy aliases. See [Focused transcript reads](read-session.md).

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

### Session list tags and pinning

Every serialized live or archived session-list row exposes two arrays:

```ts
{
  server_tags: string[];
  user_tags: string[];
}
```

Legacy missing or malformed values serialize as empty `user_tags`. Valid tags use lowercase kebab-case keys in `key=value` form; normalization keeps the last valid value for each key and preserves unknown keys. `server_tags` is rebuilt for every list serialization from canonical state and is never persisted or accepted from clients. Its projection includes read, activity, archive, and team state, plus project and goal ids when present. This projection exists so clients can consume consistent metadata without becoming another writer of runtime state.

`PUT /api/sessions/:id/pin` is the only user-tag mutation exposed by this feature:

```http
PUT /api/sessions/<id>/pin
Content-Type: application/json

{ "pinned": true }
```

Pin replaces any existing `pinned` value with one `pinned=true`; unpin removes that key. Both preserve unrelated user tags and leave server tags unchanged. The route works for live, dormant, terminated, and archived persisted sessions. Repeating a request is idempotent.

The body must be an object containing only the boolean `pinned` field. Malformed JSON, extra fields, and other value types return `400`; an unknown session returns `404`. The route uses the normal API authentication boundary.

Mutations for one session are serialized in admitted order while different sessions remain independent. The server waits for durable store flush before returning `200 { "user_tags": [...] }` and broadcasting `sessions_changed` with the same authoritative tags to authenticated UI clients. A failed write restores the prior in-memory tag shape, attempts to persist that compensation, returns `500`, and does not emit the success invalidation. This ordering prevents an acknowledged pin from disappearing after restart and prevents a later queued mutation from starting from failed optimistic state. See [Sidebar grouping](internals.md#sidebar-grouping) for the client reconciliation path and the [approved sidebar specification](design/session-manager-sidebar-views.md) for the normative product contract.

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

`POST /api/sessions/:id/fork` creates a writable live session that rehydrates through `switch_session` from a server-built clone of the source Pi transcript. The route supports two modes so whole-session and prompt-history forks share source eligibility, context assembly, worktree provisioning, cleanup, and response behavior.

#### Request

```ts
interface ForkSessionRequest {
  newWorktree?: boolean;
  entryId?: string;
}
```

| Request | Transcript boundary | Worktree default |
|---|---|---|
| `{}` or `{ newWorktree }` | Copy the whole source transcript file. | Omission means `newWorktree: true`, preserving the session-level **Fork** contract. |
| `{ entryId, newWorktree }` | Clone the active branch strictly before the named prompt. | The prompt UI always sends the boolean and opens with `false`; direct API callers that omit it still get the endpoint default of `true`. |

`newWorktree`, when present, must be boolean. A history `entryId` must be a trimmed, non-empty string of at most 256 UTF-16 code units. Unknown request fields are ignored, but the server never accepts a browser message array, rendered index, prompt text, or client-computed branch as the boundary.

#### History boundary and cursor eligibility

A prompt action exposes `entryId` only when the row is a settled server-origin user prompt with Bobbit's transcript-confirmed Pi cursor provenance. This client check keeps actions off assistant, tool-result-only, synthetic, optimistic, pending, archived, non-interactive, child/team, and current in-flight rows. It is only an affordance check: the server independently resolves the id in one immutable read of the source JSONL and requires that it name an ordinary accountable user prompt on Pi's current parent-linked active branch.

Before that read, the route resolves `agentSessionFile` through the session manager instead of trusting the persisted string. Sandbox paths must be canonical paths under a supported container sessions root, and host paths must pass the persisted-transcript read policy. An absent or rejected value falls back to recovery within trusted sessions roots; if no validated source can be resolved, the route returns `404` before creating destination state.

The destination contains the exact raw session header followed by the selected prompt's active ancestors in parent order. Retained model changes, assistant/tool records, compaction records, timestamps, line endings, and unknown additive Pi fields remain lossless. The selected prompt, its response, every later active entry, and inactive-branch records are physically absent. Selecting the first prompt therefore produces a transcript containing only the session header. The route never prefills, resends, or appends the selected prompt.

The immutable read is also the concurrency boundary: entries appended afterward cannot enter the destination. One unterminated final append fragment may be ignored; a malformed complete record or structurally ambiguous tree fails closed. The source transcript is never opened for write.

#### Worktree modes and ownership

- `newWorktree: false` reuses the source session's exact live `cwd`, including a nested directory within its worktree, and therefore shares the same filesystem state and branch. A history fork is persisted as a writable borrowed-worktree session without worktree/repository/branch teardown coordinates. It does not register, claim, reset, clean, stash, adopt, repair, or remove that tree. For a sandbox source, Bobbit resolves and persists the flattened final owner rather than treating an intermediate borrower as the owner; this keeps borrower chains on one teardown authority. Terminating or recovering a borrower cannot tear down or recreate the shared tree.
- `newWorktree: true` uses the established session-level Fork lifecycle. A Git-backed project gets a fresh owned `session/...` branch/worktree and the response waits for setup to finish; a non-Git project uses the established project-root behavior. Sandbox provisioning follows the same fresh-fork path rather than a history-specific lifecycle.

Sandbox borrower creation, borrower termination/archive, and final-owner termination/archive serialize through one FIFO keyed by that final owner. Reuse-fork launch revalidates the live source, cwd, and owner inside the FIFO, so it cannot attach after owner teardown. Final-owner teardown checks for live borrowers before any lifecycle mutation and returns `409 { "error": "...", "code": "SHARED_SANDBOX_WORKTREE_IN_USE" }` if one remains; callers should terminate borrowers first and retry. This rejection leaves the owner live and unchanged.

Both modes pass prior runtime cwd values only as provenance for rebasing top-level Pi runtime metadata during `switch_session`. User and assistant content mentioning an old path is not rewritten.

#### Preserved context and filtered state

Both fork modes preserve the source context that still applies: project; goal, task, and reattempt-goal association; assistant type; staff identity/environment or role/accessory configuration; sandbox realm; allowed tools; selected/effective model and thinking level; and generated `Fork: <source title>` naming. A valid fork may transition an associated todo goal through the existing shared behavior, but cursor validation completes first.

Whole-session forks retain their established full-JSONL and best-effort cache-copy behavior. History forks instead apply the cut consistently to destination state:

- proposal drafts and their history are copied because they are session-level;
- author bindings are copied only when an echoed settlement's exact Pi message ID names a retained prompt and its digest confirms the same model text; each retained row can admit at most one binding. History cuts disable timestamp- and text-only fallback matching so a discarded duplicate prompt cannot transfer its author to identical retained text;
- slash-skill/file-mention and compaction sidecars are copied only when their proven Pi entry or checkpoint survives the cut;
- positional tool-content cache directories are not copied because their indexes may refer to discarded rows; retained tool content remains in the JSONL;
- live prompt queues, in-flight steer state, EventBuffer snapshots, and other source-only runtime state are not copied.

A filtered sidecar copy failure fails the request instead of returning a destination with stale references. Launch failures purge the destination transcript, session record, proposals, caches, and copied sidecars. Cleanup never mutates the source or a borrowed worktree.

For a sandbox history fork, the materialized transcript stays in container coordinates through initial publication, cwd rebasing, sanitization, final-path rename, persistence, and `switch_session`. The host creates only an exclusive owner-only flat stage in the trusted sessions mount; fixed in-container code copies it to an exclusive sibling temporary file, flushes complete bytes, and atomically renames it over the destination. Transcript content is never passed in command arguments, and each invocation removes only its own host stage and sibling temporary file.

Failure cleanup validates canonical container session paths and deletes generated transcripts only through the live container. It never translates an attacker-influenced container path into direct host deletion. If the sandbox is unavailable, Bobbit still purges the host-owned destination record and sidecars but leaves the transcript orphan for trusted maintenance rather than risk host filesystem mutation.

#### Source immutability, single-flight, and navigation

The source process, session record, transcript bytes, sidecars, cwd/branch, prompt queue, running project state, connected clients, and session-list entry remain unchanged. The server reserves each exact `(sourceId, entryId, newWorktree)` history request while it runs; an identical concurrent request receives `HISTORY_FORK_IN_PROGRESS`, while different boundaries remain independent. The reservation is released on success and failure.

The browser also disables prompt actions while session creation is pending. On a successful `201`, the initiating client refreshes the session list, connects to the returned id as an existing session, refetches cloned history when ready, and navigates there. Other clients may observe the new session through normal session-list invalidation, but they are not navigated away from the source. A request, launch, or connection failure stays on the source route and uses the existing visible connection-error surface.

#### Success response

Success returns `201`:

```ts
interface ForkSessionResponse {
  id: string;
  cwd: string;
  status: string;
  projectId: string;
  goalId?: string;
  title: string;
}
```

`goalId` is omitted when not applicable. The title is `Fork: <source title>` and is marked generated so first-prompt auto-titling does not replace it.

#### Errors

History validation uses the standard `{ error, code }` response shape:

| Status | Code | `error` |
|---|---|---|
| `400` | `HISTORY_FORK_CURSOR_INVALID` | `Invalid history fork entry id` |
| `409` | `HISTORY_FORK_CURSOR_NOT_FOUND` | `This prompt is no longer available` |
| `409` | `HISTORY_FORK_CURSOR_INACTIVE` | `This prompt is no longer on the active conversation branch` |
| `422` | `HISTORY_FORK_CURSOR_NOT_USER` | `History forks must start before a user prompt` |
| `409` | `HISTORY_FORK_TRANSCRIPT_INVALID` | `The session transcript changed or is not valid for history forking` |
| `409` | `HISTORY_FORK_IN_PROGRESS` | `A fork from this prompt is already being created` |

An invalid `newWorktree` value returns `400 { "error": "Invalid newWorktree flag" }` without a code. A sandbox reuse request whose final owner cannot be resolved returns `422 { "error": "The source sandbox worktree owner is unavailable for history forking", "code": "HISTORY_FORK_SOURCE_UNAVAILABLE" }`. If the source cwd or owner changes before serialized launch, the route returns the same status and code with `error: "The source session is no longer available for history forking"`. Existing route failures remain unchanged: missing persisted source or transcript is `404`; an unregistered project or missing goal is `410`; archived, terminated/non-live, delegate, child, read-only, non-interactive, team, or cross-realm sources are `422`; clone, filtered-sidecar, worktree-setup, and launch failures are `500` with a descriptive `error`.

See [Unified Session Actions — Historic prompt actions](session-actions.md#historic-prompt-actions) for the user-facing controls and [History Fork Prompt Actions](design/history-fork-prompt-actions.md) for the design rationale.

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
  // "normal" → real exitCode; "killed" → user kill; "unrecoverable" → restart-only lost outcome;
  // "spawn-failed" → known shell/runtime startup failure. The latter three use exitCode null.
  // Optional/undefined for legacy snapshots.
  terminalReason?: "normal" | "killed" | "unrecoverable" | "spawn-failed" | null;
  // Present only for terminalReason="spawn-failed". Values are server-sanitized.
  spawnFailure?: {
    kind: "spawn";
    code: "ENOENT" | "EACCES" | "EPERM" | "UNKNOWN";
    message: string;
  };
  startTime: number;
  endTime: number | null;
};
```

`endTime` is `null` while `status === "running"`. On terminalization the server sets `endTime` once, and list / wait snapshots preserve that final value so reloads and reconnects keep showing the fixed `endTime - startTime` runtime.

- `POST /api/sessions/:id/bg-processes` returns `201 BgProcessInfo` for the created process. For a host session, it first validates the working directory before allocating or persisting a process. Container-session paths are intentionally not host-statted; Docker/runtime failures remain authoritative. A sandboxed session with no container returns `403` rather than executing on the host.
- `GET /api/sessions/:id/bg-processes` returns `{ processes: BgProcessInfo[] }` for UI hydration. Background processes survive a gateway restart — this list is rehydrated from the on-disk store and re-attached processes keep streaming. See [docs/bg-process-persistence.md](bg-process-persistence.md).
- `GET /api/sessions/:id/bg-processes/:pid/wait` returns `{ info: BgProcessInfo, timedOut: boolean, aborted: boolean }`; `info.endTime` is numeric after exit and remains `null` for running timeout/abort snapshots. A known startup failure settles wait normally with `info.status === "exited"`, `info.terminalReason === "spawn-failed"`, and its optional safe diagnostic.

Host working-directory preflight failures are stable `409` responses using the standard `{ error, code }` shape:

| Code | Meaning |
|---|---|
| `BG_CWD_MISSING` | The host working directory no longer exists. |
| `BG_CWD_NOT_DIRECTORY` | The resolved working-directory path is a file or other non-directory. |
| `BG_CWD_UNAVAILABLE` | The gateway cannot inspect the host working directory. |

These responses deliberately omit raw paths and operating-system errors. The stable code and concise message are safe to surface and sufficient to retry after repairing the session/worktree. A post-preflight runtime failure is not a `POST` error: it is returned as a durable terminal snapshot with `terminalReason: "spawn-failed"`; its optional `spawnFailure` object retains only the sanitized category and message for list, wait, REST hydration, and diagnostics.

Older exited snapshots may omit `endTime` or set it to `null`. Clients must render those runtimes as unknown/non-growing instead of substituting `Date.now()` for an exit timestamp.

**WS events.** `bg_process_created` / `bg_process_output` carry the running snapshot and streamed output; `bg_process_exited` carries `processId`, `exitCode`, `endTime`, `terminalReason`, and optional `spawnFailure`. `terminalReason` is authoritative: `exitCode` is `null` for `killed`, `unrecoverable`, and `spawn-failed`; only `spawn-failed` carries the safe startup diagnostic. `bg_process_dismissed` carries `{ processId }` so all clients drop the pill when a process is dismissed.

### Proposal drafts

In-flight `propose_*` payloads are mirrored to `.bobbit/state/proposal-drafts/<sessionId>/<type>.{md,yaml}` so the agent can tweak them via `view_proposal` / `edit_proposal` without re-emitting the full payload. The file is the source of truth for proposal draft content; the in-memory client slot (`state.activeProposals[type]`) is a parsed content projection. Side-panel tab presence is controlled separately by the server-backed workspace. See [docs/internals.md — Editable proposals](internals.md#editable-proposals) and [docs/design/editable-proposals.md](design/editable-proposals.md).

`<type>` is one of `goal | project | role | tool | staff`. `goal` files are markdown with YAML frontmatter; the others are native YAML.

Proposal mutations are owner-scoped. They require the matching `X-Bobbit-Session-Secret` capability or a signed same-origin operator cookie; a route `:id`, shared bearer credential, or public session-id header alone returns `403 PROPOSAL_OWNER_MISMATCH`. Read-only hydration retains the surrounding API's normal access contract.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/proposal/:type` | Read the raw proposal file body. `200` with `text/markdown` (goal) or `application/yaml` (others). `404 {ok:false, code:"FILE_NOT_FOUND", message}` if no draft. |
| `GET` | `/api/sessions/:id/proposal/goal/worktree-mode` | Read the goal draft's durable worktree mode and freshly recomputed eligibility for promoting its owner. An absent mode projects as `new-worktree`; coordinates are display-only server state. See [Current-session goal promotion](#current-session-goal-promotion). |
| `PUT` | `/api/sessions/:id/proposal/goal/worktree-mode` | Persist exactly `{ mode: "new-worktree" | "current-session" }`, create a proposal revision, and broadcast the normal stamped `proposal_update`. New worktree removes the optional field to preserve legacy serialization. |
| `POST` | `/api/sessions/:id/proposal/goal/accept` | Accept a draft whose persisted mode is `current-session`, create the normal goal/gates, and promote the proposal-owning session as its existing lead. Source and workspace authority are derived only from the route owner and canonical server state. |
| `GET` | `/api/sessions/:id/proposal/:type/snapshot?rev=N` | Read a historical revision without mutating the live draft. Parses `<type>.history/<rev>.<ext>` through the per-type plugin and returns `200 {ok:true, rev, fields}`. Does not broadcast `proposal_update` and does not update `state.activeProposals`. `400 {ok:false, code:"INVALID_BODY"}` for invalid rev; `404 {ok:false, code:"SNAPSHOT_NOT_FOUND", message}` if the snapshot file is missing; `400` with `ParseError` shape if the snapshot fails to parse. Used by read-only historical proposal tabs. |
| `POST` | `/api/sessions/:id/proposal/:type/seed` | Called by `propose_*` tool `execute()`. Body `{ args: <propose-args object> }`. Serialises args via the per-type plugin, atomically writes the file, parses, attempts to open/focus `proposal:<type>` in the side-panel workspace, then broadcasts `proposal_update {source:"seed", rev}`. `200 {ok:true, rev}` on success. For `type=goal`, the canonical goal-candidate validator checks project/path scope, workflow/options, inline workflow/roles, parent/nesting, metadata, and policy before any write. Failure returns its stable status/code/message, preserves any prior draft and revision, opens no tab, emits no proposal event or success marker, and leaves the failed tool input/result in the transcript for correction. See [Canonical goal-candidate validation](goals-workflows-tasks.md#canonical-goal-candidate-validation). |
| `POST` | `/api/sessions/:id/proposal/:type/edit` | Surgical content edit. Body `{ old_text: string, new_text: string }`. Exact-string replacement, first-and-only-occurrence rule, empty `new_text` deletes. Goal edits that change validated fields must also pass canonical candidate validation before commit. On success: writes atomically, broadcasts `proposal_update {source:"edit", rev}`, returns `200 {ok:true, newContent, rev}`. Does not open or focus side-panel tabs; already-open proposal tabs refresh from the content slot. On failure: file and revision unchanged, returns 4xx with structured error. |
| `POST` | `/api/sessions/:id/proposal/:type/restore` | Mutating rollback endpoint for explicit API restore flows. Body `{ rev: number }` (positive integer). A goal snapshot must pass current canonical candidate validation before replacement. On success, copies `<type>.history/<rev>.<ext>` back to the live draft and writes a new snapshot at `currentRev+1`, then opens/focuses the proposal tab and broadcasts `proposal_update {source:"restore", rev: newRev}`. `200 {ok:true, newRev, fields}` on success; invalid, missing, unparseable, or currently uncreatable snapshots leave the live draft/revision unchanged and return a structured 4xx. Historical chat-card tabs use `GET /snapshot` instead so browsing old revisions is non-mutating. |
| `DELETE` | `/api/sessions/:id/proposal/:type` | Delete the draft. Broadcasts `proposal_cleared`. `204` on success (idempotent — `204` even if the file was absent). Called by accept handlers after a successful save. The per-session `<type>.history/` directory is cleaned with the rest of the per-session draft dir on the 7-day purge (deferred from archive so the [archived-proposal-reopen flows](archived-proposal-reopen.md) can read drafts after the source session is archived). |
| `GET` | `/api/sessions/:id/proposals` | List every parsed proposal draft for the session in one call. Returns `200 { proposals: Array<{ proposalType, fields, rev }> }`; `proposals` is empty when the per-session directory is absent or empty. Mirrors the WS `proposal_update {source:"rehydrate"}` broadcast as a one-shot REST call — used by fast-path session switch-backs (no fresh WS auth, so the broadcast doesn't run) and by the archived-session footer to decide whether to surface a "Resubmit `<type>` proposal" button (see [docs/archived-proposal-reopen.md](archived-proposal-reopen.md)). This is content hydration only and does not open or focus side-panel tabs. `400` on invalid sessionId; `500` on unexpected enumeration failure. |

For goal drafts, the Markdown body is `spec`; omitted, `null`, and empty inputs serialize as the valid empty-string body, which survives seed, edit, snapshot, restore, rehydration, and acceptance. The frontmatter must still parse and contain a non-blank title. Other raw non-string specs fail with `SPEC_INVALID`, and oversized strings fail with `SPEC_TOO_LONG`, before persistence.

#### Current-session goal promotion

The goal proposal panel uses these owner-scoped routes only for the **Current session** mode. New worktree proposals continue through `POST /api/goals` unchanged. The separation is deliberate: the server can bind promotion authority to the proposal owner instead of accepting an arbitrary source session or checkout in general goal creation. Worktree-mode writes and acceptance require the matching owner capability or signed operator cookie; route identity and shared bearer authentication are insufficient.

##### Worktree mode projection

`GET /api/sessions/:ownerId/proposal/goal/worktree-mode` parses the owner's current goal draft and returns:

```json
{
  "mode": "current-session",
  "eligibility": {
    "eligible": true,
    "coordinates": {
      "sessionId": "session-id",
      "projectId": "project-id",
      "cwd": "/existing/worktree/packages/app",
      "worktreePath": "/existing/worktree",
      "repoPath": "/repository",
      "branch": "session/existing",
      "repoWorktrees": { "api": "/existing/worktree/api" },
      "sandboxed": false,
      "componentCount": 1
    }
  }
}
```

`repoWorktrees` and `containerId` are omitted when not applicable. An ineligible response replaces `coordinates` with `{ "eligible": false, "code": "...", "reason": "..." }`. The stable codes are:

| Code | Meaning |
|---|---|
| `SESSION_NOT_LIVE` | The owner has no matching live and durable non-archived session. |
| `SESSION_NOT_IDLE` | The owner is busy, compacting, restoring prior streaming work, dormant, lifecycle-fenced, or has pending prompt/steer work. |
| `SESSION_HAS_RELATION` | Goal, team, non-baseline role, assistant, staff, delegate, child, or task metadata already owns the session. |
| `SESSION_UNSAFE` | The session is read-only, non-interactive, terminal-child state, or borrows another worktree. |
| `PROJECT_UNAVAILABLE` | The draft has no usable registered target project, or its target does not resolve. |
| `PROJECT_MISMATCH` | Live or durable session state belongs to a different project. |
| `TRANSCRIPT_UNAVAILABLE` | The canonical transcript is missing or unreachable in its host/container realm. |
| `WORKTREE_UNAVAILABLE` | A dedicated branch/worktree is missing, unreachable, not current, or aliases the repository checkout. |
| `WORKSPACE_MISMATCH` | Live and durable workspace or sandbox metadata disagree. |
| `MULTI_REPO_MISMATCH` | Configured Git components and canonical component worktrees are incomplete, duplicated, aliased, or divergent. |
| `SANDBOX_UNAVAILABLE` | The exact recorded sandbox container is absent or not ready. |
| `PROMOTION_CONFLICT` | Multiple live adopted goals claim this owner, or retry provenance belongs to another project. |
| `WORKSPACE_CLAIMED` | Another live session, goal, team agent, or staff record claims an overlapping workspace. |

The first failing reason is concise enough for direct UI display. Eligibility is recomputed on every read; the route never trusts coordinates cached by the browser.

`PUT /api/sessions/:ownerId/proposal/goal/worktree-mode` accepts no keys besides `mode`. `current-session` writes the optional frontmatter field; `new-worktree` removes it. Both responses use the GET shape after the edit. The route can preserve a restored Current session selection even when it is now ineligible; the UI disables acceptance until the user chooses New worktree or eligibility becomes valid.

##### Accept in place

`POST /api/sessions/:ownerId/proposal/goal/accept` requires a non-empty `title`. It accepts only human-editable goal definition fields:

```text
title, spec, workflowId, workflow, inlineRoles, enabledOptionalSteps,
subgoalsAllowed, maxNestingDepth, divergencePolicy, maxConcurrentChildren,
parentGoalId, metadata
```

The body must not contain `sessionId`, `ownerSessionId`, `promoteSessionId`, `projectId`, `cwd`, `worktree`, `worktreePath`, `branch`, `repoPath`, `repoWorktrees`, `sandboxed`, `containerId`, or `autoStartTeam`. Supplying one returns `400 PROMOTION_AUTHORITY_REJECTED`; other unknown keys return `400 INVALID_BODY`. The route derives the source session from `ownerId`, the project and selected mode from the draft, and every workspace/sandbox coordinate from matching live and durable records. A non-empty `parentGoalId` returns `422 PROMOTION_PARENT_UNSUPPORTED` because this flow creates a top-level goal.

Immediately before mutation, the server re-reads the draft, rechecks that it still selects `current-session`, re-resolves the owner's live/durable workspace coordinates, and runs canonical goal-candidate validation against current project/workflow/policy state. A mode change returns `409 WORKTREE_MODE_MISMATCH`; an eligibility or candidate failure returns its current structured status/code/message and leaves the draft available. Explicit `enabledOptionalSteps`, including `[]`, replaces serialized draft `options`; omission inherits them. Successful acceptance returns the goal with `201`. The goal has `setupStatus: "ready"`, the exact source coordinates, and `worktreeOwnerSessionId: ownerId`; its team has that same session as `teamLeadSessionId` with no second lead.

Acceptance is single-flight per owner. Exact retries find the one existing live goal by `worktreeOwnerSessionId` and return it with `201`, even after successful acceptance cleared the draft. Multiple matching goals return `409 PROMOTION_CONFLICT`. While an attempt owns the session reservation, competing role or destructive session mutations return retryable `409 SESSION_GOAL_PROMOTION_IN_PROGRESS`.

Pre-commit failure compensates only an unchanged empty lead reservation plus the attempt-created gates and goal. Post-commit finalization failure keeps the attached session and goal for an exact retry. These boundaries preserve the original transcript, runtime, sandbox, and checkout in either case.

##### Lifecycle conflicts

While the adopted goal is live, direct source archive or purge returns `409 PROMOTED_SESSION_LIFECYCLE_CONFLICT`, and independent team teardown returns `409 PROMOTED_LEAD_TEARDOWN_CONFLICT`. Goal archive is the required ordered path. An archive racing unfinished acceptance returns `409 PROMOTION_IN_PROGRESS` before any goal state, verification, or cascade mutation.

After successful goal archive, the goal is durably marked archived before its team reservation is removed and the source session is archived. Archive does not delete the session-owned worktree. A later session purge may clean it only after the normal reference guards find no live owner or borrower. See [Promote the current session in place](goals-workflows-tasks.md#promote-the-current-session-in-place) for restart recovery, sandbox preservation, and multi-repository cleanup semantics.

#### Error response shape

Structured proposal failures use the same code/message envelope across seed, edit, snapshot, restore, and current-session acceptance where parsing or validation applies. Canonical goal-candidate errors additionally preserve their originating HTTP status and may include bounded `details` fields:

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
| `MISSING_WORKFLOW` | `400` | goal candidate validation | A required workflow selection is absent. Response includes `availableWorkflows` when known. |
| `UNKNOWN_WORKFLOW` | `400` | goal candidate validation | The selected workflow id is unavailable in the linked project's current creation-time lookup. Response includes visible `availableWorkflows` when known. |
| `UNKNOWN_OPTIONAL_STEP` | `400` | goal candidate validation | `options` or `enabledOptionalSteps` names a step that is not optional on the selected workflow. Response includes `validOptionalSteps` when known. |
| `STRUCTURAL_VALIDATION_FAILED` | `400` | edit, seed | Project YAML fails the structural validator shared with `PUT /api/projects/:id/config`. |
| `CWD_OUTSIDE_PROJECT` | `422` | goal seed, edit, restore, accept/create | `cwd` is outside the selected project's realpath-aware boundary, or does not match authenticated server-owned coordinates. |
| `PROPOSAL_OWNER_MISMATCH` | `403` | proposal mutations | Neither the matching session capability nor a signed same-origin operator cookie authenticated the owner. |

Other goal-candidate codes cover project visibility, title/spec shape, inline workflow/roles, parent/nesting, metadata, and root-only policy. They are intentionally shared with goal creation rather than redefined by proposal routes.

**Atomic rollback.** Any failure in goal seed, edit, restore, or worktree-mode update leaves the live file byte-for-byte identical, does not advance its revision, and emits no proposal update. The implementation promotes a temporary file only after parse and pre-commit validation succeed. A failed operation followed by `GET` returns the original body unchanged.

**Path safety.** `:id` is validated against `/^[A-Za-z0-9_-]+$/` and `:type` against the union literal; invalid values return `400 {error:"Unknown proposal type: ..."}` before any disk access.

**Restart survival.** On WS attach, `src/server/ws/handler.ts` enumerates the per-session directory and re-emits one `proposal_update {source:"rehydrate", rev}` per surviving file (where `rev` is computed from the highest integer in the `<type>.history/` dir, or `0` for legacy sessions predating the snapshot system), so reloading a browser or restarting the server mid-edit yields the same proposal content without a separate content persistence layer. Rehydrate does not open tabs; the side-panel workspace remains authoritative for whether `proposal:<type>` is present. Failed goal workflow-validation attempts are the exception: because no file/rev exists, their reopen metadata is recovered from the persisted transcript tool call/result rather than from this endpoint.

**Revision snapshots.** Every successful `seed` and `edit` write also writes an immutable per-rev snapshot under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/<rev>.<ext>` (filename grammar `^(\d+)\.(md|yaml)$`; integer rev parsed back from filenames — no metadata file). The server stamps the resulting `rev` on every `proposal_update` WS event (single source of truth — the client overwrites `slot.rev` with the server value, never increments locally). Snapshot-write failures are non-fatal: the live draft is committed and the broadcast carries `rev: 0`, which the client treats as "snapshot system unavailable". Chat-card "Open proposal" buttons parse the `__proposal_rev_v1__:<n>` marker and, for older revisions, call the non-mutating `GET /snapshot` endpoint to populate read-only historical tabs. The mutating `restore` endpoint remains available for explicit rollback flows but is not used for ordinary history browsing. Full design: [docs/design/proposal-revision-snapshots.md](design/proposal-revision-snapshots.md).

### Review payload artifacts

These session-scoped routes persist canonical `review_open` Markdown outside the bounded tool result, then address it by exact identity. See [Durable review opening](review-open-architecture.md) for the receipt, persistence, workspace, and cleanup contract.

| Method | Path | Authentication and identity contract |
|---|---|---|
| `POST` | `/api/sessions/:id/review-payloads` | Upload a canonical review for the exact owning session. Requires normal gateway authentication plus that session's `X-Bobbit-Session-Secret`; a sandbox credential may call only its own session collection route. The cumulative Markdown limit is 10 MiB in UTF-8 bytes across all files. |
| `GET` | `/api/sessions/:id/review-payloads/:payloadId?toolCallId=:toolCallId&reviewId=:reviewId&hash=:hash` | Fetch only when the route owner and payload id plus the complete `toolCallId`, `reviewId`, and SHA-256 `hash` tuple match the stored artifact. This is a browser/admin surface; sandbox credentials cannot fetch Markdown. |
| `POST` | `/api/sessions/:id/review-payloads/:payloadId/open` | Explicitly open or reopen the exact stored review through its owning session's workspace. This browser/admin-only route requires the body to repeat the exact `payloadId`, `toolCallId`, `reviewId`, and `hash`; sandbox credentials cannot mutate the workspace. |

The 10 MiB bound applies only to cumulative review Markdown. The upload route has a narrowly larger JSON request allowance for escaping and bounded metadata; it does not raise generic API-body, WebSocket, transcript, event-buffer, or tool-result limits.

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

Finite-shape resource update routes accept only their documented request keys. An unknown key returns `400` with every offending field named, and the route makes no update. Rejecting instead of projecting selected fields prevents an `ok: true` response from concealing a no-op. This applies to the update routes for projects, goals, tools, roles, tasks, workflows, sessions, staff, and goal policy.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals` | List goals. `?archived=true` returns archived goals with an `archivedSessions` field; `q` filters archived goals by goal title or affiliated session title/role before pagination. Supports `?since=N` generation counter for conditional fetch. See [Archived goal list and query search](#archived-goal-list-and-query-search) |
| `POST` | `/api/goals` | Create a goal (`{ title, cwd, spec?, projectId?, team?, worktree?, reattemptOf?, metadata? }`). `title` must be non-blank. An omitted, `null`, or empty `spec` becomes the empty string; other non-string or oversized values are rejected. `metadata` is an optional arbitrary, namespaced key/value object persisted on the goal and inherited by all its sessions and sub-goals; accepted only when it is a non-empty plain object. `projectId: "headquarters"` is valid; with `worktree: false`, a Headquarters goal can run data-only with no branch/worktree. See [Hierarchical goal metadata](design/goal-metadata.md). |
| `GET` | `/api/goals/:id` | Get a goal |
| `PUT` | `/api/goals/:id` | Update a goal (`title`, `cwd`, `state`, `spec`, `branch`, `reattemptOf`; `team` remains an accepted compatibility key). `team` does not change the always-on team mode. `repoPath` and `prUrl` are lifecycle/remote-state data, not update fields, and are rejected with `400`. |
| `PATCH` | `/api/goals/:id/policy` | Update per-goal policy (`subgoalsAllowed`, `maxNestingDepth`, `divergencePolicy`, `maxConcurrentChildren`). |
| `PUT` | `/api/goals/:id/workflow` | Replace the goal's complete frozen workflow snapshot, validate it, and reconcile gate state. See [Goal workflow replacement](#goal-workflow-replacement). |
| `POST` | `/api/goals/:id/retry-setup` | Retry a failed worktree setup. See [Goal setup recovery](#goal-setup-recovery). |
| `DELETE` | `/api/goals/:id` | Delete a goal and its tasks |
| `GET` | `/api/goals/:id/commits` | Commit history for goal branch (excludes primary branch commits); includes changed files for each commit. No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. See [Git commit lists and commit-scoped diffs](#git-commit-lists-and-commit-scoped-diffs) |
| `GET` | `/api/goals/:id/git-status` | Read-only Git status for the goal worktree (branch, ahead/behind primary, clean). Never publishes or updates a remote branch. No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. See [Coordinated remote-state status](#coordinated-remote-state-status). |
| `GET` | `/api/goals/:id/git-diff` | Unified diff for the goal worktree, or for one committed file when `commit=<sha>&file=<path>` is supplied. No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. See [Git commit lists and commit-scoped diffs](#git-commit-lists-and-commit-scoped-diffs) |
| `GET` | `/api/goals/:id/cost` | Aggregate cost across all sessions linked to a goal (includes `cacheHitRate`) |
| `GET` | `/api/goals/:id/cost/breakdown` | Goal aggregate plus per-session breakdown, used by the goal cost popover; cost objects include `cacheHitRate: number \| null`. |
| `GET` | `/api/goals/:id/pr-status` | Coordinated PR fast state for the goal branch. No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. See [Coordinated remote-state status](#coordinated-remote-state-status) for the snapshot envelope and missing-PR behavior. |
| `GET` | `/api/goals/:id/github-link` | PR URL or sanitized GitHub branch fallback. No-worktree goals return `200 { available: false, reason: "no-worktree", message }`. Still available, but the sidebar `Open on GitHub` item now mirrors the goal-row PR badge instead of gating on this endpoint. See [Goal GitHub link endpoint](#goal-github-link-endpoint) |
| `POST` | `/api/goals/:id/pr-merge` | Merge PR for goal branch (`{ method? }`). No-worktree goals return `409 { code: "GOAL_GIT_UNAVAILABLE" }`. |
| `POST` | `/api/goals/:id/integrate-child/:childId` | Locally merge a direct child's branch into the parent and auto-archive it on success. Body `{ force?: boolean }`. Never pushes either branch. See [Child-goal integration](#child-goal-integration). |
| `POST` | `/api/goals/:id/retry-scheduled-start` | Consume a current retryable child or root scheduler-recovery record and retry through the child scheduler. See [Scheduled child-start recovery](#scheduled-child-start-recovery). |

`PUT /api/goals/:id` rejects the four policy keys with `400`, names all of them in the response, and directs callers to `PATCH /api/goals/:id/policy`. That routing changes neither policy nor authorization: `subgoalsAllowed` and `maxNestingDepth` are operator-class, while `divergencePolicy` and `maxConcurrentChildren` are orchestration-class and remain team-lead-only. A mixed policy body uses the stricter orchestration class.

### Goal setup recovery

`POST /api/goals/:id/retry-setup` is the operator recovery path for a goal whose authoritative `setupStatus` is `error`. It has no request body. On acceptance it persistently transitions the goal to `retrying`, atomically clears the active `setupError`, broadcasts `goal_state_changed`, and returns without waiting for provisioning:

```json
{ "ok": true, "coalesced": false, "setupStatus": "retrying" }
```

Concurrent retry requests coalesce: the response may contain `coalesced: true` and the currently active setup state, but no extra worktree, Team Lead, or scheduler continuation is created. A request that joins a genuine initial `preparing` flight also reports coalescing. A persisted `preparing` state without a live flight is not treated as success; it returns `409` with an actionable explanation. A goal that is not failed or otherwise retrying/preparing returns `409`; an unknown goal returns `404`.

The eventual `ready` or `error` transition is delivered through `goal_state_changed` plus the corresponding setup completion/error event. Clients must refresh their goal state on those events rather than retaining the optimistic `retrying` snapshot. `ready` has no `setupError`, so all current-warning surfaces must disappear; a current `error` keeps one actionable diagnostic and blocks goal-scoped session and team starts. For lifecycle, child-scheduler, and Git coordination semantics, see [Goals, Workflows, Tasks & Gates — Atomic goal setup lifecycle](goals-workflows-tasks.md#atomic-goal-setup-lifecycle).

### Coordinated remote-state status

The session and goal `git-status` and `pr-status` routes use the server-owned remote-state coordinator. This keeps remote freshness authoritative on the server so additional browsers and surfaces do not multiply equivalent `git fetch` or GitHub reads. The full identity, budget, failure, and redaction model is in [Remote-state coordinator](remote-state-coordinator.md).

#### Request intent

All four routes accept `intent`:

| Value | Behavior |
|---|---|
| omitted or `automatic` | Return the current snapshot immediately and start or join eligible stale revalidation under the active cadence. |
| `visible` | Return immediate stale-while-revalidate state for a visibility return. Freshness, backoff, and single-flight still apply. |
| `explicit` | Await forced refresh. It bypasses freshness and automatic backoff, but concurrent and short-burst forced requests still coalesce. |
| `sidebar` | Request automatic PR state under the 60-second sidebar window instead of the 20-second active window. It does not create a browser-specific record. |

`sidebar` changes cadence only for PR state; a Git route still uses the repository's normal automatic policy. On Git routes, legacy `fetch=true` has the same blocking revalidation role as `intent=explicit`. It may be combined with `untracked=1` so the response reflects newly fetched refs and includes the full untracked-file scan. Without either explicit form, stale revalidation completes asynchronously and is delivered through WebSocket.

#### Response envelopes

The public coordinator metadata is:

```ts
type RemoteStateMetadata = {
  observedAt: number;
  refreshedAt?: number;
  ageMs: number;
  stale: boolean;
  source: "repository" | "pr";
  lastError?: "offline" | "auth" | "rate_limited" | "unavailable";
};
```

A successful Git-status response remains a flat `GitStatusEnvelope` for compatibility and also contains the metadata plus `data`, a copy of that entity's local `GitStatusEnvelope` projection:

```ts
type CoordinatedGitStatus = GitStatusEnvelope &
  RemoteStateMetadata & {
    source: "repository";
    data: GitStatusEnvelope;
  };
```

The nested projection remains entity-local: sibling worktrees share fetched refs, not dirty or untracked files. A cold remote-ref record has no `refreshedAt`; the Git route can still return local status in both the flat fields and `data`.

PR-status responses use the envelope directly:

```ts
type PullRequestFastState = {
  number: number;
  url: string; // canonical credential-free HTTPS URL for the validated repository/number
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeable: string | null;
  reviewDecision: string | null;
  viewerIsAdmin: boolean;
  viewerCanMergeAsAdmin: boolean;
};

type CoordinatedPrStatus = RemoteStateMetadata & {
  source: "pr";
  data?: PullRequestFastState | null;
};
```

On a cold eligible PR record, `data` and `refreshedAt` are absent while the first automatic refresh runs. A successful lookup that finds no PR sets `data: null`. After a transient failure, the envelope retains the last successful `data` and `refreshedAt`, marks `stale: true`, advances `ageMs`, and sets a safe `lastError`; a cold failure has no retained `data` or `refreshedAt`. Explicit reads await that success or failure envelope.

PR absence has two distinct route outcomes:

- If the target cannot be resolved to an eligible GitHub or trusted GitHub Enterprise repository and head, the default response is `404 { error: "No PR found" }`; `optional=1` returns empty `204`. No independent fallback lookup runs.
- If the target is eligible and a successful lookup returns `data: null`, the default response is `200` with that envelope; `optional=1` returns empty `204`. Cold and failed eligible snapshots remain `200` envelopes even with `optional=1`, because their freshness/error metadata is meaningful.

Unknown entities, missing host worktrees, no-worktree goals/Headquarters sessions, sandbox resolution, and the existing explicit Git/PR mutation routes retain their endpoint-specific behavior.

#### Completion WebSocket frame

A completed refresh is entity-addressed and wraps the snapshot body:

```ts
{
  type: "remote_state_snapshot";
  resource: "git" | "pr";
  sessionId?: string;
  goalId?: string;
  snapshot: RemoteStateSnapshot;
}
```

`resource` is the routing discriminator. `snapshot.source` is independently `"repository" | "pr"`. Session completions carry `sessionId`; goal and sidebar completions carry `goalId` on their authorized channel. Clients apply the completion directly and must not trigger another equivalent REST, `git fetch`, or GitHub read.

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

### Scheduled child-start recovery

`POST /api/goals/:id/retry-scheduled-start` is the operator recovery action for
a visible, bounded scheduled-start stop. It accepts no body. The target must
have a current retryable `schedulerRecovery` record and be an active,
start-eligible goal; paused, blocked, complete, and shelved goals return
`409 SCHEDULER_RETRY_INELIGIBLE` until their lifecycle condition is resolved.
Archived or unknown goals return `404`.

The route requires the same operator authorization as pause/resume. A child
recovery is consumed before entering the scheduler, so a replay or double-click
returns `409 NO_SCHEDULER_RECOVERY` rather than starting duplicate work. A root
recovery first validates and re-requests its durable affected-child targets;
if none remain actionable it retains the recovery and returns
`409 SCHEDULER_ROOT_RETRY_INELIGIBLE`. A child retry creates a fresh scheduler
request generation and returns:

```json
{ "childGoalId": "…", "outcome": "started" }
```

`outcome` may instead be `"capacity-blocked"` when the root is already at its
concurrency cap. A root circuit-breaker record persists its affected child IDs,
then re-requests only the still-eligible children after a restart and returns
`{ "rootGoalId": "…", "outcomes": ["started" | "capacity-blocked", "…"] }`.
The route never bypasses scheduler permits or directly creates a team.

See [Bounded scheduled-start recovery](nested-goals.md#bounded-scheduled-start-recovery)
for failure classification, re-entry, and operator workflow.

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
| `POST` | `/api/goals/:id/gates/:gateId/cancel-verification` | Cancel a stuck running verification. See [Cancel verification endpoint](#cancel-verification-endpoint). |
| `POST` | `/api/goals/:id/gates/:gateId/signoff` | Resolve a parked `human-signoff` step (`{ signalId, stepName, decision: "pass"\|"fail", feedback? }`); idempotent 409 on already-resolved steps. See [Sign-off endpoint](#sign-off-endpoint). |

### Cancel verification endpoint

`POST /api/goals/:goalId/gates/:gateId/cancel-verification` requests cancellation of the gate's running verification. It is idempotent and always returns `200` in one of these shapes:

```json
{ "cancelled": false, "message": "No running verification to cancel" }
```

No running verification existed.

```json
{ "cancelled": true, "pending": false }
```

Cancellation is terminal: exact cleanup settled.

```json
{ "cancelled": true, "pending": true, "message": "Cancellation is waiting for exact process cleanup" }
```

Cancellation intent is durable, but this is **not** terminal. Exact command payload cleanup — and, for Docker command steps, host `docker exec` transport cleanup — must settle before the old signal receives its terminal cancellation result. Clients can inspect `GET /api/goals/:goalId/verifications/active` while `pending` is `true`.

### Goal Team

Routes accept both `/team/` and legacy `/swarm/` paths.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals/:id/team` | Get team state for a goal |
| `POST` | `/api/goals/:id/team/start` | Explicitly start a team (creates or returns its live team-lead session). See [Explicit start lifecycle](#explicit-start-lifecycle). |
| `POST` | `/api/goals/:id/team/spawn` | Spawn a role agent (`{ role, task, traits? }`) |
| `POST` | `/api/goals/:id/team/dismiss` | Dismiss a role agent (`{ sessionId }`); returns the structured dismiss result documented below |
| `POST` | `/api/goals/:id/team/steer` | Backward-compatible streaming-only steer for a team agent (`{ sessionId, message }`) |
| `POST` | `/api/goals/:id/team/abort` | Force-abort a stuck team agent (`{ sessionId }`) |
| `POST` | `/api/goals/:id/team/prompt` | Prompt or steer a team agent, owned helper child, or direct-child goal team lead. Body `{ sessionId, message, mode?: "prompt" | "steer", workflowGateId?, inputGateIds? }`; default mode is `"steer"`. Returns `409 { code: "GOAL_PAUSED" }` when the goal is paused (checked before team membership). See [Session prompt tools](session-prompt-tools.md). |
| `GET` | `/api/goals/:id/team/agents` | List agents for a team goal. `?include=archived` also returns archived agents with `teamLeadSessionId`, `teamGoalId`, and `delegateOf` fields |
| `POST` | `/api/goals/:id/team/complete` | Complete a team (dismiss agents, keep team lead). Body `{ confirmBypassedGates?: boolean }` — the agent/MCP path is refused while any gate is `bypassed`; a human confirms with `confirmBypassedGates: true` (403 for sandbox tokens). See [Gate bypass endpoint](#gate-bypass-endpoint). |
| `POST` | `/api/goals/:id/team/teardown` | Fully tear down a team (dismiss all + terminate team lead) |

Restart semantics: boot restores persisted active team entries and re-subscribes their sessions; it does not call `/team/start` implicitly for existing teamless goals. After `/team/teardown`, or after creating a goal with `autoStartTeam: false`, the goal remains teamless across restart and this explicit start route remains the manual recovery path.

#### Explicit start lifecycle

`POST /api/goals/:id/team/start` (and its legacy `/swarm/start` alias) is an
explicit operator action. A successful request returns `201` with
`{ sessionId, title }`. It is single-flight per goal: concurrent requests join
the same start, and a later repeat returns the existing live team lead rather
than creating another one. If retained team state has no live lead, the route
returns `409 TEAM_LEAD_UNAVAILABLE`; callers must stop that team before starting
a replacement.

For an **operator-paused** otherwise-startable goal, explicit start first uses
the canonical *single-goal* resume lifecycle, then creates (or returns) the
lead. The resume durably clears `paused` and any stale merge-conflict marker and
broadcasts `goal_state_changed` before lead creation. It deliberately does not
use the cascade resume route: starting one team must not reactivate descendants.
This composition exists so a user can resume work intentionally without a
separate click while retaining the normal lifecycle's persistence and UI
notification rules.

Paused auto-resume is deliberately narrow:

- It requires a verified signed UI operator cookie, or the authentic secret of
  the goal's authoritative existing team lead (`X-Bobbit-Session-Secret`). A
  global Bearer token, the public spawning-session header, and another
  session's secret cannot resume the goal; they receive `403 NOT_TEAM_LEAD`.
- The goal must have team mode enabled, ready setup, and a usable spec. Archived,
  shelved, completed, and setup-incomplete paused goals remain paused and return
  concise structured errors such as `GOAL_ARCHIVED`, `GOAL_SHELVED`,
  `GOAL_COMPLETE`, or `GOAL_SETUP_INCOMPLETE`.
- Scheduler-owned `state: "blocked"` is never resumed or bypassed; it returns
  `409 GOAL_BLOCKED`. This preserves dependency scheduling as the sole owner of
  that state.

The transition is revalidated after the awaited resume. Therefore another
lifecycle mutation can make the goal non-startable after resume; in that case
start fails with a structured code, but the already durable resume is not rolled
back. Clients refresh goals and sessions after **both** a successful and failed
start request, and also reconcile the `goal_state_changed` broadcast, so this
committed state is visible without a manual page reload.

Non-paused starts keep their ordinary behavior. In particular, a completed goal
that is not operator-paused is not implicitly resumed; after its team has been
explicitly torn down, a normal explicit start can create a new lead as before.
All explicit-start failures use `{ error, code, goalId }` with concise,
actionable text; this route never returns an exception stack to the client.

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
| `POST` | `/api/roles` | Create a role (`{ name, label, promptTemplate, toolPolicies?, allowedTools?, accessory?, model?, thinkingLevel? }`). `toolPolicies` is the source of truth for tool access; `allowedTools` is accepted for backward compatibility and merged as `always-allow` entries. `model` is `"<provider>/<modelId>"` format and overrides `default.sessionModel` / `default.reviewModel` for sessions of this role. `thinkingLevel` is one of `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"` (clamped to the role's exact model capability at write time when `model` is set; `max` requires explicit per-model support; see [docs/thinking-levels.md](thinking-levels.md)). |
| `GET` | `/api/roles/:name` | Get a role (includes `toolPolicies` and derived `allowedTools`) |
| `PUT` | `/api/roles/:name` | Update a role. Accepts `toolPolicies` (Record of tool/group name → policy), `model` (`"<provider>/<modelId>"`), and `thinkingLevel` (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`, clamped to the role's exact model capability when `model` is set; `max` requires explicit per-model support). Policy values are validated against: `always-allow`, `ask-once`, `always-ask`, `never-ask`, `never`. Malformed `model` strings are rejected with 400. |
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
| `PUT` | `/api/staff/:id` | Update a staff agent (`{ name, description, systemPrompt, cwd, state, triggers, memory, roleId, contextPolicy, accessory }`). Same goal-trigger prompt validation as `POST /api/staff`: empty `prompt` on a `goal_created` / `goal_archived` row returns `400`. Changed `cwd` values must be non-empty and inside the staff agent's own project. An unchanged `cwd` on a legacy/orphan record may still be re-sent so other fields remain editable. `accessory`, when present, is normalised, persisted on the staff record, and mirrored to the current permanent session if one exists. `roleId` is optional and validated the same way as on `POST`: a non-empty string sets the role (unknown → **404**), `null` clears it, and a non-string non-null value → **400**; the change takes effect on the next session spawn. See [staff-agents.md — Role selection](staff-agents.md#role-selection). `sandboxed` is immutable and not an update field: a `PUT` containing it returns `400` naming `sandboxed` rather than silently dropping it (see [staff-agents.md](staff-agents.md)). `contextPolicy` accepts `"preserve"` or `"compact"` (see [staff-inbox.md](staff-inbox.md#contextpolicy)); other values are ignored. |
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
| `DELETE` | `/api/projects/:id` | Unregister a normal project (does not delete the registered project root). The server drains its worktree pool, terminates live history-fork borrowers before their owners and other sessions, and removes project state only after no live project session remains. The last normal project may be removed; Headquarters remains as the built-in workspace unless hidden by preference. `DELETE /api/projects/headquarters` returns 403 `HEADQUARTERS_IMMUTABLE`. The hidden `system` project is unaffected by this flow. |

Project deletion uses normal per-owner sandbox lifecycle serialization rather than bypassing shared-worktree ownership. If a concurrent launch or replacement leaves any live project session after termination, deletion stops before project-context removal and returns `409 { "error": "Project still has active sessions", "code": "PROJECT_SESSIONS_STILL_ACTIVE", "sessionIds": [...] }`. A shared sandbox owner conflict is likewise a typed `409` with `code: "SHARED_SANDBOX_WORKTREE_IN_USE"`. These fail-closed responses preserve the registered project and its remaining live sessions so the caller can terminate borrowers or other survivors and retry.

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
| `PUT` | `/api/projects/:id/config` | Set/clear project-level overrides. Empty string or `null` clears an override. Validation and publication are atomic: all accepted fields publish as one candidate or none do. For `:id=headquarters`, writes server/Headquarters config. |
| `GET` | `/api/projects/:id/qa-testing-config` | Returns `{ configured: boolean }` — `true` iff at least one component has a non-empty `config.qa_start_command`. Drives the UI toggle on the `agent-qa` optional verify step. Detailed per-key values are not surfaced here; the `/qa-test` skill reads them directly from `project.yaml`. |

`PUT /api/projects/:id/config` is a generic KV writer. It accepts any scalar `project.yaml` field — including `build_command`, `test_command`, `typecheck_command`, `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `sandbox`, `base_ref`, and any custom keys the project defines — and the only validation is that keys must not contain `.`. `base_ref` carries extra rules: tags, SHAs, non-`origin` remote prefixes, and (for `sandbox = docker` projects) local refs are rejected with 400 and a structured `{ field: "base_ref", error, details? }` payload; multi-repo saves additionally `git rev-parse --verify` the ref in every component repo and return per-component bullets in `details[]` when missing. Validation only runs when `base_ref` is present in the body. See [design/base-ref.md](design/base-ref.md). Two fields (`config_directories`, `sandbox_tokens`) are sent as structured native types (arrays of mappings); legacy JSON-string payloads for these keys are rejected with 400. The seven legacy top-level QA keys (`qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_env`, `qa_max_duration_minutes`, `qa_max_scenarios`) are **rejected** with 400 — they live on `components[<name>].config[<key>]` now (see [internals.md — Multi-repo & components](internals.md#multi-repo--components)). Inline env vars directly into `qa_start_command`. See [internals.md — Native-YAML project.yaml fields](internals.md#native-yaml-projectyaml-fields). This endpoint is what the settings UI and the mid-session project-proposal accept path both write through (see [internals.md — Per-project config](internals.md#per-project-config)). The project's display `name` is **not** a `project.yaml` field — update it via `PUT /api/projects/:id`. Model preferences (`session_model`, `review_model`, `naming_model`) are **not** project-scoped either; they live in the preferences store.

#### Persistence failure contract

Both settings writers (`PUT /api/projects/:id/config` and `PUT /api/project-config`) validate their request before publishing one complete configuration candidate. A publication failure leaves the previous `project.yaml` bytes and all committed config getters unchanged; neither endpoint returns `{ "ok": true }` in that case.

A configuration that is present but unreadable, malformed, or not a YAML mapping is repair-required. Saves return **409** with:

```json
{
  "error": "Project config could not be saved because it needs repair. Repair project.yaml and reload it before retrying.",
  "code": "PROJECT_CONFIG_LOAD_FAILED"
}
```

Other publication failures, such as a temporary-file write or rename failure, return **500** with:

```json
{
  "error": "Project config could not be saved. Check file permissions and retry.",
  "code": "PROJECT_CONFIG_PERSIST_FAILED"
}
```

These responses deliberately omit filesystem error details and configuration content. The project-scoped route also stages incoming `sandbox_tokens[].value` changes: it publishes the value-free token descriptors first, then updates `SecretsStore`. Therefore a failed configuration publication leaves the prior secrets as well as the prior config intact. `SecretsStore` publishes its own candidate before changing its in-memory state, so a secret publication failure retains the prior secret bytes and getters. Because the two files cannot form a single filesystem transaction, a secret failure occurs after `project.yaml` is already published: the route returns **500** without `{ "ok": true }` and the exact contract is:

```json
{
  "error": "Project config was saved, but sandbox secret values could not be saved. Check the project state directory permissions and retry.",
  "code": "SANDBOX_SECRET_PERSIST_FAILED"
}
```

The value-free descriptor changes remain in `project.yaml`; secret values remain at their prior values and the caller must retry. Token values never appear in `project.yaml` or its temporary candidate. For store load and publication mechanics, see [Durable publication and repair](internals.md#durable-publication-and-repair).

Server-level fallback, labelled Headquarters in the UI (applied when no normal project override is set):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/project-config` | Server-level project config (legacy; used as fallback for per-project overrides). |
| `GET` | `/api/project-config/defaults` | Built-in defaults. |
| `PUT` | `/api/project-config` | Update server-level config fields atomically; uses the same 409/500 persistence-failure contract as the project-scoped writer. |
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

`GET /api/models` returns the current Bobbit session catalog. Each `ApiModel` includes provider, ID, API, limits, input modes, reasoning capability, authentication state, and `cost` in Pi's per-million-token shape: `{ input, output, cacheRead, cacheWrite }`; optional fields include `baseUrl`, `thinkingLevelMap`, `compat`, `sessionSelectable`, `upstreamProvider`, and tiered `cost.tiers[]`.

#### Pi 0.84.1 Claude Opus 5 catalog

Pi's published `0.84.1` catalog is authoritative for the direct Anthropic row and all five supported Amazon Bedrock profiles:

| Exact provider/model | Published name | API | Base URL | Cost `{input, output, cacheRead, cacheWrite}` |
|---|---|---|---|---|
| `anthropic/claude-opus-5` | Claude Opus 5 | `anthropic-messages` | `https://api.anthropic.com` | `{5, 25, 0.5, 6.25}` |
| `amazon-bedrock/au.anthropic.claude-opus-5` | Claude Opus 5 (AU) | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `amazon-bedrock/eu.anthropic.claude-opus-5` | Claude Opus 5 (EU) | `bedrock-converse-stream` | `https://bedrock-runtime.eu-central-1.amazonaws.com` | `{5.5, 27.5, 0.55, 6.875}` |
| `amazon-bedrock/global.anthropic.claude-opus-5` | Claude Opus 5 (Global) | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `amazon-bedrock/jp.anthropic.claude-opus-5` | Claude Opus 5 (JP) | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `amazon-bedrock/us.anthropic.claude-opus-5` | Claude Opus 5 (US) | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |

All six rows have a 1,000,000-token context window, 128,000-token output limit, `reasoning: true`, `input: ["text", "image"]`, and `thinkingLevelMap: { xhigh: "xhigh", max: "max" }`. Combined with the ordinary provider defaults, this exposes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; the effective level is clamped against the exact selected row. Only the direct Anthropic row publishes `compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true }`. The Bedrock rows have no model-level `compat`, so Bobbit does not invent one; Pi's Bedrock adapter owns their adaptive-thinking behavior. See [Pi `0.84.1` reliable-turn compatibility](pi-runtime-compatibility.md#pi-0841-reliable-turn-compatibility) for the selected runtime contract.

Bobbit omits the exact deferred provider `kimi-coding` from `/api/models` and `/api/pi-ai/providers`, and Bobbit-owned default, role, and session-selection paths reject that provider without changing durable state. This is an exact provider-identity boundary, not a model-ID filter: Kimi-named IDs remain valid under a session-selectable AIGW, custom/local, Moonshot, or legacy gateway provider.

AI Gateway models may include `upstreamProvider`, which the UI uses for badges and search while preferences remain `aigw/<bare-id>`. Bobbit takes AIGW cost from well-known per-million-token `cost` metadata or converts legacy `/v1/models` per-token `pricing`; it does not call aggregate endpoints such as `/v1/usage`, `/v1/cost`, or `/v1/credits`.

Google has two independent, session-selectable model paths: `google-gemini-cli/*` uses a
Google account and Bobbit's native PKCE/Code Assist runtime, while `google/*` uses a Google
AI Studio API key and the Gemini Developer API. See
[Google OAuth & Gemini models](google-oauth-models.md) for authentication, model exposure,
and provider isolation.

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
- `400 { ok: false, error }` — pref is missing or could not be parsed as `provider/modelId`.
- `404 { ok: false, error: "Model \"...\" is not in the current available-models list..." }` — pref does not resolve against `/api/models`.
- `401` or `403` `{ ok: false, modelResolved, latencyMs, error, status, code: "authentication_failed" }` — a trusted upstream authentication failure.
- `404` `{ ok: false, modelResolved, latencyMs, error, status: 404, code: "model_not_found" }` — a trusted upstream model-specific failure.
- `429` `{ ok: false, modelResolved, latencyMs, error, status: 429, code: "rate_limited" }` — a trusted upstream rate, quota, or spend-limit failure.
- `502 { ok: false, modelResolved, latencyMs, error }` — an unclassified provider, transport, or timeout failure.
- `500 { ok: false, error }` — unexpected model discovery or probe setup failure.

For provider-native paths, classification accepts only a status prefix emitted by Pi; it never scans provider-controlled error text. Direct AI Gateway paths classify the observed HTTP status. The three classified outcomes are intentionally distinct: a `404` does not establish an authentication cause, and a `429` does not establish model availability.

Used by the Settings → Models tab per-row Test button. See [AI Gateway routing — Model probes](ai-gateway-routing.md#model-probes) and [Debugging](debugging.md#reviewnaming-model-mismatch-under-ai-gateway).

### AI Gateway

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/aigw/status` | Return `{ configured, url?, models? }`; configured gateways are discovered fresh. `models: []` describes that live status request and does not clear eligible durable or same-process retention in `/api/models`. |
| `POST` | `/api/aigw/configure` | Discover and persist a gateway (`{ url }`), publish `models.json`, and refresh sandbox mounts |
| `DELETE` | `/api/aigw/configure` | Remove gateway configuration and its generated provider |
| `POST` | `/api/aigw/test` | Run well-known-first discovery for `{ url }` without saving or changing active routing |
| `POST` | `/api/aigw/refresh` | Repeat configuration for the saved URL and refresh models/default seeding |
| `*` | `/api/aigw/v1/*` | Append `/v1/*` to the configured URL and proxy the request; save the gateway origin, not an already suffixed `/v1`, when using this route |

Configure, refresh, and delete return `remountPending: true` when the durable configuration succeeded but one or more tracked sandbox containers could not yet remount the atomically replaced `models.json`. Callers must not interpret that flag as a rollback; normal container health recovery continues.

Discovery first requests `/.well-known/opencode` at the gateway origin and falls back to `/v1/models` only when no authoritative config resolves. If discovery throws, `/api/models` uses Pi's exact rows from a valid marked publication when its normalized `baseUrl` matches the saved `aigw.url`. If the target is absent, or a marked target cannot supply rows, it may instead use the current process's last exact discovery snapshot keyed to that unchanged normalized URL. This snapshot is in memory only and does not survive restart. A valid unmarked target remains user-owned and authoritative through Pi composition; discovery retention never bypasses it. A malformed or ambiguous target fails closed.

A successful discovery result replaces the same-process snapshot and is authoritative even when empty after validation or filtering; retained rows are not merged into it. `GET /api/aigw/status` performs its own fresh discovery and may return `models: []` without mutating `models.json` or the catalog retention used by `/api/models`. Outbound requests carry Bobbit's canonical AI Gateway user agent. See [AI Gateway routing](ai-gateway-routing.md#transient-discovery-outages) for the full outage matrix, precedence, remote-config security, provider-specific routes, model-ID migration, and cache/container behavior; see [AI Gateway request headers](internals.md#ai-gateway-request-headers-user-agent-x-opencode-session) for implementation details.

### OAuth

Provider-aware. Bobbit can hold OAuth credentials for several providers concurrently (currently `anthropic`, `openai-codex`, and `google-gemini-cli`); every endpoint takes a `provider` discriminator so the same flow IDs and credential rows do not bleed across providers.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/oauth/status?provider=<id>` | OAuth status for one provider. Returns provider-safe authentication, storage, rejection, refreshability, expiry, and permitted display metadata. |
| `POST` | `/api/oauth/start` | Begin an OAuth flow. Body: `{ provider }`. Returns `{ provider, flowId, url, callbackServer?, instructions? }`. Anthropic contention returns actionable retry metadata. |
| `POST` | `/api/oauth/complete` | Submit a code, query string, or redirect URL to the provider-owned interaction. Body: `{ flowId, code, provider? }`. Returns `{ success: true }` or `{ success: false, error }`. |
| `POST` | `/api/oauth/cancel` | Cancel one provider-scoped flow. Body: `{ flowId, provider }`. Waits for Pi callback/token-exchange settlement before reporting success. |
| `POST` | `/api/oauth/finalize` | Accept a completed provider-scoped flow without rolling back its issued credential. Body: `{ flowId, provider }`. |
| `GET` | `/api/oauth/flow-status?flowId=<id>&provider=<id>` | Poll a flow. Returns `{ complete, error? }`; `provider` is recommended for provider isolation. |
| `POST` | `/api/oauth/logout` | Revoke/clear one provider's stored OAuth credential or rejection tombstone. Body: `{ provider }`. Returns `{ success, provider }`, never echoing token material. |

**Provider IDs:** `anthropic` (Claude account → renewable OAuth credential), `openai-codex` (ChatGPT subscription → bearer token), and `google-gemini-cli` (Google account → Gemini Code Assist bearer token). Provider validation is performed by the `normalizeProvider` helper in `src/server/auth/oauth.ts`; for the Google path it also accepts the inbound aliases `google` and `gemini` and collapses them to canonical `google-gemini-cli` (plain `google` stays the Google AI Studio API-key provider elsewhere). An unsupported value causes the surrounding endpoint to throw, which the server wraps as `400 { error: "<thrown message>" }` (e.g. `"Error: Unsupported OAuth provider: foo"` for status, or `500` for start). The error string is implementation-defined — callers should treat any 4xx with an `error` field as "unknown provider". See [Google OAuth & Gemini models](google-oauth-models.md) for the full account-vs-API-key split.

**Why `provider` everywhere:** the same browser-redirect callback URL is shared between providers, and a user may legitimately have flows in flight for both at once. Keying every operation by `provider` (alongside `flowId`) keeps state strictly partitioned and lets the UI render Settings → Account as parallel rows that can be (re-)authed independently.

**Current auth boundary:** Anthropic constructs Pi's public `Models` service with Bobbit's
Pi-compatible credential-store adapter and calls `Models.login("anthropic", "oauth", interaction)`.
Pi owns the current authorization parameters, scopes, loopback callback, callback-state
validation, token exchange, and refresh contract. Google OAuth is implemented natively in Bobbit
with PKCE and feeds the Code Assist provider extension; authenticated account models are
available for normal session selection. OpenAI Codex constructs Pi's `Models` service with
`builtinModels()` and calls `Models.login("openai-codex", "oauth", interaction)` using an
`AuthInteraction`. Bobbit does not use Pi's removed `getOAuthProvider` or
`OAuthLoginCallbacks` contracts. See [Anthropic OAuth](anthropic-oauth.md) and
[Pi runtime compatibility](pi-runtime-compatibility.md#openai-codex-oauth-migration).

**`GET /api/oauth/status?provider=<id>`** responses:

- `200 { provider: "anthropic", authenticated: true, expires }` — a current credential is usable.
- `200 { provider: "anthropic", authenticated: false, stored: true, refreshable: true, expires }` — a complete Anthropic row is expired. It remains stored for Pi's lazy refresh, but is not presented as an authenticated login until refresh succeeds.
- `200 { provider: "anthropic", authenticated: false, stored: true, rejected: true, refreshable: false, expires? }` — this exact OAuth credential was definitively rejected. The row is a non-secret tombstone or fenced equivalent and can be removed through provider-scoped logout; it cannot be refreshed or treated as authenticated.
- `200 { provider: "anthropic", authenticated: false, stored: true, refreshable: false, expires? }` — an incomplete persisted Anthropic OAuth row. It is visible for cleanup but is not a valid Pi credential.
- `200 { provider: "anthropic", authenticated: false }` — no stored credential.
- `400 { error: "<message>" }` — provider value rejected by `normalizeProvider`.

`stored`, `rejected`, and `refreshable` are omitted when they add no state beyond a current credential or absent row. The response intentionally does **not** echo bearer tokens, refresh tokens, or API keys. The `email?` field appears only for providers that capture non-secret account display metadata (currently `google-gemini-cli`).

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
- `callbackServer`: `true` for the Pi-backed Anthropic and OpenAI Codex loopback flows, and for `google-gemini-cli` via a loopback server on `http://localhost:<ephemeral-port>/oauth2callback`. Anthropic uses Pi's fixed loopback callback contract. The manual-complete route remains available for remote browser/gateway arrangements: its `code` field may carry a code, query string, or redirect URL, and Pi validates callback state before exchange. The Google flow also accepts the manual paste path when the browser cannot reach the gateway loopback.
- `instructions`: optional human-readable string the UI may render alongside the URL.

**`POST /api/oauth/complete`** body: `{ flowId, code, provider? }`. The optional provider is a defence-in-depth match against the stored flow; a mismatch is indistinguishable from an unknown flow. Anthropic delegates parsing of a bare code, query string, or full redirect URL and callback-state validation to Pi. Returns:

- `200 { success: true }` — token stored; a completed flow remains briefly addressable so a lost success response can be finalized or explicitly cancelled.
- `400 { error: "Missing flowId or code" }` — either field missing or empty.
- `400 { success: false, error: "code required" }` — `code` empty / whitespace-only after the trim check.
- `400 { success: false, error: "Unknown or expired flow ID" }` — the `flowId` was never created, was garbage-collected, or did not match the supplied provider.
- `400 { success: false, error: "OAuth flow expired" }` — the flow exceeded its TTL.
- `400 { success: false, error: "<provider message>" }` — token-exchange or login-promise rejection. Body always includes `success: false` for non-200 responses from `oauthComplete`; raw thrown exceptions are surfaced as `500 { error: "<message>" }` with no `success` field.

**`POST /api/oauth/cancel`** body: `{ flowId, provider }`. Cancellation is provider-scoped; an unknown or cross-provider flow returns `404 { success: false, error: "Unknown or expired flow ID" }`. Anthropic uses Pi's loopback callback, so the route waits for Pi's cancellation and any callback/token-exchange settlement before it reports success. A successful response means an immediate replacement login can start safely.

- `200 { success: true }` — the flow is cancelled and any safe rollback has completed.
- `400 { error: "Missing flowId" | "Missing provider" }` — required input missing.
- `503 { error: "OAuth cancellation did not complete. Retry cancellation before starting another sign-in.", code: "OAUTH_CANCEL_RETRY_REQUIRED", retryable: true, flowId }` — durable cleanup failed. Retry cancellation with the same provider and flow id; do not start another Anthropic login first.

Only one Pi-backed Anthropic flow can hold the fixed callback-port lease. A conflicting `POST /api/oauth/start` returns `409 { code: "ANTHROPIC_OAUTH_BUSY", retryable: true, error }`; cancel the in-flight flow or wait for it to settle, then retry. While a cancellation retry is required, a replacement Anthropic start returns `409` with `code: "OAUTH_CANCEL_RETRY_REQUIRED"`, `retryable: true`, and the blocking `flowId`.

**`POST /api/oauth/finalize`** body: `{ flowId, provider }`. Call this only after accepting a completed result; it removes the short acknowledgement window without rolling back the credential. It returns `200 { success: true }`, `400 { error: "Missing flowId or provider" }`, or `404 { success: false, error: "Unknown or expired flow ID" | "OAuth flow is not complete" }`.

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
- `error?: string` — present when the flow failed, expired, was cancelled, or is unknown/cross-provider mismatched. Unknown and cross-provider flows return `{ complete: false, error: "flow not found" }` with HTTP 404.
- HTTP 400 `{ error: "Missing flowId" }` if `flowId` query param is absent.
- HTTP 404 `{ complete: false, error: "flow not found" }` if the `flowId` is unknown or belongs to a different provider than the supplied `provider` query param.
- `200 { complete: false, error: "OAuth flow expired" }` when a known flow exceeds its TTL; callers may begin a new flow after its cleanup settles.

`provider` is recommended as a defence-in-depth check: if the stored flow's provider does not match the query parameter, the endpoint returns `404 { error: "flow not found" }` instead of leaking status across providers. The primary key is still `flowId`; the provider check just guarantees that a flow ID accidentally polled with the wrong provider cannot be used to confirm its existence.

**`POST /api/oauth/logout`** body: `{ provider }`. Normalizes the provider, optionally revokes the upstream token (Google posts to `oauth2.googleapis.com/revoke`; logout does not fail if revoke is transiently unavailable), deletes **only** that canonical provider's `auth.json` entry, and clears the OAuth cache. Returns `200 { success: true, provider }`. Provider-partitioned: logging out `google-gemini-cli` never touches `anthropic`, `openai-codex`, or the API-key-only `google` credential, and no response or log echoes token material.

See [Google OAuth & Gemini models](google-oauth-models.md) for the current account-vs-key split, Code Assist behavior, and session-selectable Google account models.

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

#### Historical `preview_open` snapshot markers

A successful `preview_open` result includes a v3 marker that lets its preview card reopen the historical preview from its immutable artifact. Current writers emit only this canonical compact shape:

```json
{"kind":"preview","url":"/preview/<sid>/","entry":"<entry>","contentHash":"<sha256>","artifactId":"<id>"}
```

The directory URL, canonical `entry`, `contentHash`, and `artifactId` preserve both the resolved file and its replay identity without a duplicate `path`. `entry` is a raw single filename, not a percent-encoded route segment. It is encoded exactly once when the reader rebuilds `/preview/<sid>/<encoded-entry>`, so literal-percent names such as `%41.html`, Unicode, and URL-significant characters resolve to their original files.

The complete marker block has a hard 250 UTF-8-byte cap so tool output stays bounded. A writer first uses the raw entry and may use a bounded reversible entry envelope when that saves space. Its last compact form may omit `entry` only with valid canonical `contentHash` and `artifactId`, and only beside trusted parameters from that same `preview_open` call; the renderer then derives and validates the basename from `file` (or `inline.html` for `html`). It otherwise fails with `PREVIEW_SNAPSHOT_CAP`, naming the filename and byte-budget reason rather than dropping replay identity or writing a dead marker. See [Current write contract](preview-architecture.md#current-write-contract) for the entry envelope and safety rules.

Compact marker URLs are not relaxed navigation rules: reconstructed routes still pass strict preview-route validation. Historical transcript markers remain readable because the reader accepts legacy full routes and `path`, `e`, `artifact_id`, `aid`, and `a` aliases. Those spellings are reader compatibility only; new writers never emit them.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/preview/mount?sessionId=<sid>` | Populate the per-session preview mount, OR restore an immutable artifact. Body is one of: `{ html, entry? }` (inline), `{ file: "/abs/path/report.html", assets?: string[], manifest?: string }` (copy the entry plus explicitly declared source-directory assets), or `{ artifactId }` (restore a previously captured artifact — mutually exclusive with `html`/`file`/`assets`/`manifest`). A `file` may itself be in a source subdirectory; its mounted `entry` is the raw basename and each `assets`/manifest path is resolved relative to that file's source directory, preserving declared nested asset paths in the mount. Undeclared siblings are not copied. Returns `200 { url, path, relPath, entry, mtime, contentHash, artifactId }` for inline, plus `assets: string[]` (resolved + sorted) for the `file` form. `contentHash` is a lowercase SHA-256 hex string for the populated mount tree; `artifactId` is the id of the immutable artifact written alongside the mount (see [docs/design/side-panel-tab-contract.md](design/side-panel-tab-contract.md) and the [Preview architecture](preview-architecture.md) doc for lifecycle). `relPath` is the host-invariant `<sessionId>/<entry>` identifier (forward slashes on all OS) used by the agent tool to build the v3 snapshot marker. `400` invalid sessionId / bad entry / non-absolute file / file not `.html`/`.htm` / `assets` or `manifest` passed with `html` / invalid asset path (absolute, `..`, `\`, `\0`, `**`, `[...]`, `{a,b}`) / manifest JSON parse error / `artifactId` combined with another body field; `403` sandbox-out-of-scope or symlink escape; `404` source file / manifest file / literal asset missing / `artifactId` unknown or owned by a different session. No size cap — asset inclusion is explicit and agent-driven. On success the server fans out a `preview-changed` SSE event. |
| `POST` | `/api/preview/artifacts/<artifactId>/restore?sessionId=<sid>` | Restore a previously captured immutable preview artifact into the session's live mount and broadcast `preview-changed`. The artifact must belong to `<sid>`; cross-session ids return `404`. Returns the same shape as the mount `POST` (`{ url, path, relPath, entry, mtime, contentHash, artifactId }`). Used by the preview-renderer Open button on historical `preview_open` tool cards. Equivalent to `POST /api/preview/mount` with `{ artifactId }` body; this dedicated route keeps the URL self-describing for the client restore path. |
| `GET` | `/api/preview/mount?sessionId=<sid>` | Bootstrap probe used by the panel after session-select. Returns `{ url, path, relPath, entry, mtime, contentHash, artifactId? }` (artifactId present iff an artifact was persisted for the current mount), or `404 { error: "no preview mount" }` if the mount is missing or empty. |
| `GET` | `/api/sessions/:id/preview-events` | Server-Sent Events stream for preview changes. Frames: `event: hello` on connect, `event: preview-changed` with `{entry, mtime, url, path, contentHash, artifactId?}` after every successful mount or artifact restore. Note: the SSE payload does **not** include `relPath` — only the mount REST responses do. The handler bootstraps by emitting one `preview-changed` event synchronously if a mount already exists for the session — closes the subscription race. 25 s `:keepalive` comments. Cookie auth (or admin bearer); sandbox-token requests get `403`. This route authenticates but never issues or renews a cookie. |

### Maintenance

Maintenance endpoints back Settings → Maintenance. They are preview-first and return structured counts so the UI can show cleaned, skipped, already-cleaned, and failed work. See [maintenance.md](maintenance.md) for the user/developer overview.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/maintenance/worktrees` | Canonical unified worktree inventory. Optional `?include=all|actionable|troubleshooting`; default is `all`. |
| `POST` | `/api/maintenance/cleanup-worktrees` | Canonical cleanup for all safe or selected unified worktree inventory items. Also accepts legacy orphan cleanup bodies. |
| `GET` | `/api/maintenance/orphaned-worktrees` | Legacy `{ worktrees }` compatibility shape; excludes ownership-unverified Git worktrees. Use the canonical troubleshooting inventory for diagnostics. |
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

The server always re-runs the unified inventory before cleanup and only removes fresh actionable candidates. Ownership-unverified Git worktrees, filesystem-only directories, pool entries, protected rows, stale selections, and invalid ids are skipped without mutation. Branch deletion is best-effort and blocked when any live or durable Bobbit record still references the branch.

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

Legacy orphan cleanup body shapes remain supported: `{}` and `{ worktrees: [{ path, branch, repoPath }] }`. Ownership-unverified Git worktrees are excluded or skipped without mutation; legacy responses keep the older `{ cleaned: number }` shape. Unknown keys in a legacy body return `400`.

**`GET /api/maintenance/orphaned-worktrees`** returns the legacy `{ worktrees }` shape but excludes ownership-unverified Git worktrees. Inspect those non-actionable rows through `GET /api/maintenance/worktrees?include=troubleshooting` instead.

**`GET /api/maintenance/archived-session-worktrees`** returns the existing archived-session compatibility shape: `sessions`, flattened `items`, `groups`, `selectionPresets`, additive `counts`, and `generatedAt`. It is backed by the unified inventory. Default scans omit sessions whose rows are all `already-cleaned`; use `?includeAlreadyCleaned=1` for diagnostics.

**`POST /api/maintenance/cleanup-archived-session-worktrees`** accepts the legacy archived-session modes:

- `{ "mode": "all" }`;
- `{ "mode": "selected", "sessionIds": [...] }`;
- `{ "mode": "selected", "worktrees": [{ "sessionId": "...", "key": "...", "repo": ".", "path": "..." }] }`;
- `{ "mode": "category", "categories": [...], "projectId"?: "...", "repoPath"?: "..." }`;
- `{ "mode": "preset", "presetId": "..." }`.

These modes are compatibility filters over the fresh unified scan; they do not bypass safety checks. Archived-session worktree cleanup preserves archived session metadata, transcripts, proposals, prompts, search records, and archive visibility.

### Search

Lexical (BM25-style) search over goals, sessions, messages, and staff. A per-project worker owns the FlexSearch index; a compact journaled document mirror is durable and the index is derived lazily. See [Semantic search](internals.md#semantic-search) and [Search worker and persistence](search-worker-persistence.md).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/search` | Query. Params: `q`, `projectId?`, `type?`, `limit?`, `offset?`, `includeArchived?` / `include=archived`. Omit `projectId` to search across all projects. Archived rows are excluded unless explicitly requested. |
| `POST` | `/api/search/rebuild` | Kick off a full rebuild in the background (`{ projectId }`) |
| `GET` | `/api/search/stats` | Stats for the project's search index (`?projectId=`) |
| `POST` | `/api/search/compact` | Compact the worker-owned document mirror into an atomic snapshot (`{ projectId }`) |
| `GET` | `/api/maintenance/orphaned-index-rows` | List index rows whose parent entity no longer exists (`?projectId=`) |
| `POST` | `/api/maintenance/cleanup-index-rows` | Delete orphaned index rows (`{ projectId }`) |

`GET /api/search` defaults to live-only results. Pass `includeArchived=true` or `include=archived` to include archived goals, sessions, messages, and staff matches. The full search UI uses `includeArchived=true` intentionally so archived badges/results remain visible; agent-facing `bobbit_read.search` stays live-only unless its caller opts in.

**Unavailable-service responses:** A query returns **503** with `{ error: "search-unavailable", reason, state }` whenever complete results cannot be guaranteed. `state` mirrors `SearchService.getState()` (one of `"initializing"`, `"ready"`, `"disabled"`, `"closed"`); `reason` additionally distinguishes temporary worker conditions such as `backpressure`, `degraded`, or `worker-backoff`. This is explicit rather than a partial-result mode. Rebuild Index is the recovery action for a persistent mirror/worker failure.

**`POST /api/search/rebuild`** — body `{ projectId }`. Returns **202 Accepted** on success; progress is streamed via the `index:progress` / `index:complete` / `index:error` WebSocket events (see [websocket-protocol.md](websocket-protocol.md)). **400** if `projectId` is missing.

**`GET /api/search/stats?projectId=<id>`** — returns:

```json
{
  "lastRebuildAt": 1775812345000,
  "rowCountsBySource": { "goals": 12, "sessions": 48, "messages": 9321, "staff": 3 },
  "datasetBytes": 8432104,
  "engine": "flexsearch",
  "engineVersion": "0.8.158",
  "state": "ready",
  "degraded": false,
  "unavailableReason": null
}
```

Returns **400** if `projectId` is missing, **404** if the project is not registered. Unlike a query, stats reports temporary worker/degradation state rather than returning incomplete search results.

**`POST /api/search/compact`** — body `{ projectId }`. Requests compaction of the worker-owned append-only mirror into an atomic snapshot, then returns `{ ok: true }`. The worker serializes this request with mutations so it cannot race a journal/snapshot write.

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

**Maintenance availability:** Both endpoints require a complete search dataset. While the lazy mirror is being recovered, or whenever the worker cannot guarantee completeness, they return the retryable **503** envelope instead of a success body:

```json
{ "error": "search-unavailable", "reason": "rebuilding", "state": "ready" }
```

`reason` describes the recovery fence and may be `"rebuilding"` even when the public service lifecycle in `state` is already `"ready"`. A 503 therefore means the scan or cleanup did not produce a successful result; clients must not interpret it as `{ "count": 0 }` or `{ "deleted": 0 }`. Wait for automatic recovery (or an `index:complete` event), then retry with bounded client backoff. If unavailability persists, request a source-backed rebuild and retry after it completes. No `Retry-After` header is part of this endpoint contract.

The existing error statuses remain unchanged: **400** for a missing `projectId`, **404** for an unregistered project, and **500** for an unexpected scan or cleanup failure.

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

- **`lastTurnErrored: boolean`** — set by an assistant `stopReason: "error"` terminal. It is provisional until the final boundary: a narrow cancellation-shaped terminal is reconciled there, clears the error state, and drains preserved queued work; a genuine error retains it for the Retry UI.
- **`consecutiveErrorTurns: number`** — count of consecutive genuine errored turns after final-boundary reconciliation. It is incremented by an error terminal but reset to `0` by cancellation reconciliation, a successful `message_end`, or a successful explicit `retryLastPrompt`; cancellations do not consume the cap.

Behaviour: while `lastTurnErrored` is `true`, an incoming prompt or steer **implicitly unsticks** the session (clears the flag, prepends a system-prefix, dispatches the new message without retrying the failed turn) as long as `consecutiveErrorTurns < MAX_CONSECUTIVE_ERROR_TURNS` (`3`). At or above the cap, the message is parked in `promptQueue` awaiting a human Retry click — which bypasses the cap. Both fields default to `false` / `0` for backward compatibility if the underlying session predates the feature.

See [Errored turns](prompt-queue.md#errored-turns) and [Stop, failure, and recovery](prompt-queue.md#stop-failure-and-recovery). For diagnosis, see [Session wedged after errored turn](debugging.md#session-wedged-after-errored-turn).

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

### Tool-content identity resolution

**`GET /api/sessions/:id/tool-content/by-tool-call/:toolCallId/:blockIndex`** is the preferred full-content route. It returns `200 { content: string }` for the requested zero-based content block, resolved by the URL-encoded tool-call id rather than a visible message position.

The route resolves the identity against the runtime transcript in both forms that can carry it:

- a `toolResult` message whose `toolCallId` equals `:toolCallId`;
- an assistant `toolCall` or `tool_use` content block whose `id` equals `:toolCallId`.

Without `expected`, the assistant call is selected when present (otherwise the tool result); the requested block must be the exact identity-bearing assistant-call block, so a neighbouring block on the same assistant message is refused. With `?expected=preview-snapshot`, the matching tool-result message is selected and the returned text must begin with a supported preview-snapshot marker. This lets historical, truncated preview cards retrieve their snapshot without trusting client-visible positions, while preserving legacy v1/v2 parsing in the renderer.

The route fails closed rather than returning a block from a different call:

| Status | Code | Meaning |
|---|---|---|
| `404` | `session_not_found` | The live session is unavailable. |
| `404` | `transcript_tool_call_unavailable` | Neither a matching tool result nor assistant tool-call block remains in the runtime transcript. |
| `404` | `transcript_block_unavailable` | The requested block is absent or has no extractable text/input content. |
| `409` | `tool_call_block_mismatch` | Generic identity lookup named a block other than the assistant tool-call block. |
| `409` | `snapshot_block_mismatch` | A preview lookup named the wrong block or the returned text is not a supported snapshot marker. |

`PreviewRenderer` uses this route for truncated historical snapshots. The other full-content UI consumer, the generic **Load full content** path, was migrated to the same identity resolution so client-only rows cannot misaddress the runtime transcript.

**`GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex`** remains available for positional callers. It returns the full, untruncated tool input content for a specific block at a zero-based runtime message and content-block index. It returns `200 { content: string }` on success and the legacy `404` responses when the session, message, block, or extractable content is missing. New client callers should use the identity route because their rendered history can contain rows absent from the runtime transcript.

**How truncation works:**

The `truncateLargeToolContent()` function in `truncate-large-content.ts` scans `message_update` and `message_end` events for tool call blocks with string content exceeding the threshold (default 32KB, exported as `LARGE_CONTENT_THRESHOLD`). When found, the content field is replaced with:

```json
{ "_truncated": true, "_originalLength": 1048576, "preview": "first 512 characters..." }
```

The original event is never mutated — a shallow clone is created only when truncation is needed. Events that don't exceed the threshold pass through with zero overhead (no cloning).

**UI behavior:** `WriteRenderer` detects truncated content and shows a preview with a size badge. A "Load full content" button fetches the full content via this endpoint. During streaming, only the preview is shown — syntax highlighting is never applied to multi-MB content.

### Internal test hooks

**`POST /api/internal/test/replay-buffered-events/:sessionId`** — gated behind `BOBBIT_E2E=1` (returns **403** otherwise). Iterates the named session's `EventBuffer` and re-broadcasts every retained entry on the same WebSocket path production uses. Used by `ST-DEDUP-01` in `tests/e2e/ui/stories-streaming.spec.ts` to deterministically reproduce client-side dedup of live-streaming frames without racing a real agent. The handler accepts both the pre-fix raw-event shape (bare event objects) and the post-fix `{seq, ts, event}` tuple shape, so the same hook can drive regression tests against either buffer layout. Returns `{ replayed, bufferSize }`.
