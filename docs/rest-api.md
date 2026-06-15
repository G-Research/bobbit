# REST API

All routes require `Authorization: Bearer <token>`. Token can also be passed as `?token=` query parameter.

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

### Health & Info

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + session count |
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
| `GET` | `/api/sessions` | List all sessions. Supports `?since=N` generation counter for conditional fetch. Response includes `archivedDelegates` array (see below) |
| `POST` | `/api/sessions` | Create a session (normal, delegate, or with role/traits/assistant type/reattemptGoalId) |
| `POST` | `/api/sessions/:id/fork` | Fork a live session: clone its transcript (+ tool-content / proposal drafts) into a new session and preserve its context. Body `{ newWorktree?: boolean }` (default `true`). See [Fork session endpoint](#fork-session-endpoint) |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Terminate a session |
| `PATCH` | `/api/sessions/:id` | Update session properties (title, colorIndex, preview, roleId, traits, assistantType, goalId) |
| `PUT` | `/api/sessions/:id/title` | Rename a session (legacy endpoint) |
| `POST` | `/api/sessions/:id/wait` | Block until session becomes idle, then return output |
| `POST` | `/api/sessions/:id/mark-read` | Record that the user viewed this session. Sets `lastReadAt = Date.now()` on the persisted session row; clients compare `lastActivity > lastReadAt` to render the unseen-activity dot. Works on live, dormant, and archived sessions. See [docs/internals.md — Read/unread state](internals.md#readunread-state). 404 if the session id is unknown. |
| `POST` | `/api/sessions/:archivedId/continue` | Create a new session whose agent CLI rehydrates from a byte-for-byte clone of the archived session's `.jsonl`. See [Continue-Archived endpoint](#continue-archived-endpoint) |
| `GET` | `/api/sessions/:id/output` | Get final assistant output from the last turn |
| `GET` | `/api/sessions/:id/git-status` | Git status for session's working directory (branch, ahead/behind, dirty files) |
| `GET` | `/api/sessions/:id/pr-status` | PR status for session's branch (via `gh pr view`) |
| `POST` | `/api/sessions/:id/bg-processes` | Start a background process and return its `BgProcessInfo` snapshot |
| `GET` | `/api/sessions/:id/bg-processes` | List active/exited background process snapshots for REST hydration |
| `GET` | `/api/sessions/:id/bg-processes/:pid/wait` | Long-poll until a background process exits, times out, or is interrupted |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid?action=kill` | Terminate a running process (whole tree / group); keep the now-terminal record until dismissed. `{ ok, killed }`; 404 if not found/not running |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid?action=dismiss` | Remove the record **and** delete its persisted log/status/spool files; broadcasts `bg_process_dismissed`. `{ ok }`; 409 if still running |
| `DELETE` | `/api/sessions/:id/bg-processes/:pid` | Legacy: kill-if-running, else dismiss |
| `GET` | `/api/sessions/:id/cost` | Persisted cumulative token usage and cost for a single session. Returns 404 when no cost record exists. Response includes `cacheHitRate: number \| null`. See [session-cost.md](session-cost.md) and [Cache-hit rate](cache-hit-rate.md). |
| `GET` | `/api/sessions/:id/cost/breakdown` | Session cost plus delegate-session breakdown, used by the session cost popover; cost objects include `cacheHitRate: number \| null`. |
| `GET` | `/api/sessions/:id/tool-content/:messageIndex/:blockIndex` | Lazy-load full tool input content for a truncated block (see [Large content truncation](#large-content-truncation)) |
| `GET` | `/api/sessions/:id/transcript` | Paginated, regex-filterable transcript reader. Backs the `read_session` tool. Query params: `offset` (negative = from end), `limit` (default 20, clamped 1..200), `pattern`, `case_sensitive`, `context` (±5 max), `verbose`. Same-project authorization via the `x-bobbit-session-id` request header. Errors: `session_not_found` (404), `transcript_unavailable` (404), `invalid_regex` / `invalid_params` (400), `permission_denied` (403). Pure parser lives in `src/server/agent/transcript-reader.ts`. |
| `GET` | `/api/sessions/:id/transcript/before-compaction` | Paginated read of the orphaned pre-compaction entries for a single compaction event. Query params: `compactionId` (required, sidecar entry id), `cursor` (from previous response's `nextCursor`), `limit` (default 50, clamped 1..200). Response envelope `{ total, returned, nextCursor, messages[] }`. Same-project authorization via the `x-bobbit-session-id` header. Errors: `session_not_found` (404), `transcript_unavailable` (404), `compaction_not_found` (404), `invalid_params` (400), `permission_denied` (403). Branch-split via the sidecar's `firstKeptEntryId`; legacy fallback scans the JSONL for an inline `type:"compaction"` marker. Reader: `readOrphanedBeforeCompaction` in `src/server/agent/transcript-reader.ts`. See [docs/compaction-history.md](compaction-history.md). |

### Side-panel workspace

The side-panel workspace endpoints persist the right-side panel tab set for a session: open tabs, active tab, tab order, and size mode. The server workspace is authoritative; closed tabs are absence and are not re-derived from render/content caches or localStorage. See [Side-panel workspace](side-panel-workspace.md) for the full lifecycle and identity rules.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/side-panel-workspace` | Return the canonical workspace, creating an empty default (`tabs: []`, `activeTabId: ""`, `sizeMode: "split"`, `revision: 0`) if none was persisted. |
| `POST` | `/api/sessions/:id/side-panel-workspace/open` | Validate and upsert a tab by id. Body `{ tab, focus?, placeAfterActive?, baseRevision?, strictRevision? }`. Opening an already-open id updates/focuses that tab instead of duplicating it. |
| `PATCH` | `/api/sessions/:id/side-panel-workspace/tabs/:tabId` | Patch an already-open tab. Body may be `{ patch }` or direct `title` / `label` / `source` / `state` fields. Returns `404 TAB_NOT_FOUND` for a closed/missing tab; this route never creates tabs. |
| `DELETE` | `/api/sessions/:id/side-panel-workspace/tabs/:tabId` | Close a tab. Missing tabs are idempotent; underlying preview/proposal/review/pack/inbox content is preserved for explicit reopen. |
| `POST` | `/api/sessions/:id/side-panel-workspace/active` | Body `{ activeTabId }`. The id must be open, or empty. |
| `POST` | `/api/sessions/:id/side-panel-workspace/reorder` | Body `{ tabIds, baseRevision }`; `If-Match: <revision>` is also accepted. The request must include each open tab exactly once. Stale revisions return `409` with the latest workspace. |
| `POST` | `/api/sessions/:id/side-panel-workspace/resize` | Body `{ sizeMode }`, where size mode is `collapsed`, `split`, or `fullscreen`. |
| `POST` | `/api/sessions/:id/side-panel-workspace/migrate` | One-time import from legacy localStorage keys. Ignored once the workspace has tabs or `metadata.migratedFromLocalStorageAt`. |

Each committed mutation increments `revision`, persists on the session record, and emits `side_panel_workspace` on the session WebSocket.

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

In-flight `propose_*` payloads are mirrored to `.bobbit/state/proposal-drafts/<sessionId>/<type>.{md,yaml}` so the agent can tweak them via `view_proposal` / `edit_proposal` without re-emitting the full payload. The file is the single source of truth; the in-memory client slot (`state.activeProposals[type]`) is a parsed projection. See [docs/internals.md — Editable proposals](internals.md#editable-proposals) and [docs/design/editable-proposals.md](design/editable-proposals.md).

`<type>` is one of `goal | project | role | tool | staff`. `goal` files are markdown with YAML frontmatter; the others are native YAML.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/proposal/:type` | Read the raw proposal file body. `200` with `text/markdown` (goal) or `application/yaml` (others). `404 {ok:false, code:"FILE_NOT_FOUND", message}` if no draft. |
| `GET` | `/api/sessions/:id/proposal/:type/snapshot?rev=N` | Read a historical revision without mutating the live draft. Parses `<type>.history/<rev>.<ext>` through the per-type plugin and returns `200 {ok:true, rev, fields}`. Does not broadcast `proposal_update` and does not update `state.activeProposals`. `400 {ok:false, code:"INVALID_BODY"}` for invalid rev; `404 {ok:false, code:"SNAPSHOT_NOT_FOUND", message}` if the snapshot file is missing; `400` with `ParseError` shape if the snapshot fails to parse. Used by read-only historical proposal tabs. |
| `POST` | `/api/sessions/:id/proposal/:type/seed` | Called by `propose_*` tool `execute()`. Body `{ args: <propose-args object> }`. Serialises args via the per-type plugin, atomically writes the file, parses, broadcasts `proposal_update {source:"seed", rev}`. `200 {ok:true, rev}` on success; `400` with structured error on parse/validate failure. For `type=goal`, the named `workflow` and `options` are validated against the project's workflows **before** writing — unknown values are rejected with `400 {ok:false, code:"UNKNOWN_WORKFLOW", availableWorkflows}` or `400 {ok:false, code:"UNKNOWN_OPTIONAL_STEP", validOptionalSteps}` (skipped when the session has no project, the project has zero workflows, or `workflow` is empty). See [goals-workflows-tasks.md — Validating a proposed workflow at proposal time](goals-workflows-tasks.md#validating-a-proposed-workflow-at-proposal-time). |
| `POST` | `/api/sessions/:id/proposal/:type/edit` | Surgical edit. Body `{ old_text: string, new_text: string }`. Exact-string replacement, first-and-only-occurrence rule, empty `new_text` deletes. On success: writes atomically, broadcasts `proposal_update {source:"edit", rev}`, returns `200 {ok:true, newContent, rev}`. On failure: file unchanged, returns 4xx with structured error. |
| `POST` | `/api/sessions/:id/proposal/:type/restore` | Mutating rollback endpoint for explicit API restore flows. Body `{ rev: number }` (positive integer). Copies `<type>.history/<rev>.<ext>` back to the live draft AND writes a NEW snapshot at `currentRev+1` so the rollback appears in the timeline. Broadcasts `proposal_update {source:"restore", rev: newRev}`. `200 {ok:true, newRev, fields}` on success; `400 {ok:false, code:"INVALID_BODY"}` if `rev` is not a positive integer; `404 {ok:false, code:"SNAPSHOT_NOT_FOUND", message}` if the requested snapshot file is missing; `400` with `ParseError` shape if the snapshot fails to parse. Historical chat-card tabs use `GET /snapshot` instead so browsing old revisions is non-mutating. |
| `DELETE` | `/api/sessions/:id/proposal/:type` | Delete the draft. Broadcasts `proposal_cleared`. `204` on success (idempotent — `204` even if the file was absent). Called by accept handlers after a successful save. The per-session `<type>.history/` directory is cleaned with the rest of the per-session draft dir on the 7-day purge (deferred from archive so the [archived-proposal-reopen flows](archived-proposal-reopen.md) can read drafts after the source session is archived). |
| `GET` | `/api/sessions/:id/proposals` | List every parsed proposal draft for the session in one call. Returns `200 { proposals: Array<{ proposalType, fields, rev }> }`; `proposals` is empty when the per-session directory is absent or empty. Mirrors the WS `proposal_update {source:"rehydrate"}` broadcast as a one-shot REST call — used by fast-path session switch-backs (no fresh WS auth, so the broadcast doesn't run) and by the archived-session footer to decide whether to surface a "Resubmit `<type>` proposal" button (see [docs/archived-proposal-reopen.md](archived-proposal-reopen.md)). `400` on invalid sessionId; `500` on unexpected enumeration failure. |

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
| `STRUCTURAL_VALIDATION_FAILED` | `400` | edit, seed | Project YAML fails the structural validator shared with `PUT /api/projects/:id/config`. |

**Atomic rollback.** Any failure in `edit` or `seed` after the per-type parse step leaves the file on disk byte-for-byte identical to its pre-call state — the implementation writes to `<file>.tmp` and `fs.rename`s only after parse + validate succeed. A failed edit followed by `GET` returns the original body unchanged.

**Path safety.** `:id` is validated against `/^[A-Za-z0-9_-]+$/` and `:type` against the union literal; invalid values return `400 {error:"Unknown proposal type: ..."}` before any disk access.

**Restart survival.** On WS attach, `src/server/ws/handler.ts` enumerates the per-session directory and re-emits one `proposal_update {source:"rehydrate", rev}` per surviving file (where `rev` is computed from the highest integer in the `<type>.history/` dir, or `0` for legacy sessions predating the snapshot system), so reloading a browser or restarting the server mid-edit yields the same UI state without a separate persistence layer.

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
| `GET` | `/api/goals` | List all goals. `?archived=true` returns archived goals with an `archivedSessions` field. Supports `?since=N` generation counter for conditional fetch |
| `POST` | `/api/goals` | Create a goal (`{ title, cwd, spec, team?, worktree?, reattemptOf? }`) |
| `GET` | `/api/goals/:id` | Get a goal |
| `PUT` | `/api/goals/:id` | Update a goal (title, cwd, state, spec, team, repoPath, branch, reattemptOf) |
| `DELETE` | `/api/goals/:id` | Delete a goal and its tasks |
| `GET` | `/api/goals/:id/commits` | Commit history for goal branch (excludes primary branch commits) |
| `GET` | `/api/goals/:id/git-status` | Git status for goal worktree (branch, ahead/behind primary, clean) |
| `GET` | `/api/goals/:id/cost` | Aggregate cost across all sessions linked to a goal (includes `cacheHitRate`) |
| `GET` | `/api/goals/:id/cost/breakdown` | Goal aggregate plus per-session breakdown, used by the goal cost popover; cost objects include `cacheHitRate: number \| null`. |
| `GET` | `/api/goals/:id/pr-status` | PR status for goal branch (cached, via `gh pr view`) |
| `GET` | `/api/goals/:id/github-link` | PR URL or sanitized GitHub branch fallback. Still available, but the sidebar `Open on GitHub` item now mirrors the goal-row PR badge instead of gating on this endpoint. See [Goal GitHub link endpoint](#goal-github-link-endpoint) |
| `POST` | `/api/goals/:id/pr-merge` | Merge PR for goal branch (`{ method? }`) |

### Goal GitHub link endpoint

`GET /api/goals/:id/github-link` resolves a PR URL or a sanitized GitHub branch URL for a goal. It remains available, but the sidebar **Open on GitHub** menu item no longer depends on it: that item now mirrors the goal-row PR badge (a PR with a `url` in `prStatusCache`, and a fully-passed gate summary for workflow goals) and opens the PR URL directly. The endpoint is still useful for callers that want a server-sanitized link, including the branch fallback the menu item no longer surfaces.

Success or unavailability both return `200` with a discriminated response:

```ts
type GoalGithubLinkResponse =
  | { available: true; url: string; kind: "pr" | "branch" }
  | { available: false; reason: "no-branch" | "no-github-remote" | "goal-not-found" };
```

Resolution order:

1. Return the goal's cached PR URL from `PrStatusStore` when present.
2. Otherwise look up PR status for the goal branch using `gh` through `execFile` argument arrays, not shell command strings.
3. If no PR URL exists, read `origin` with `git remote get-url origin` through `execFile`.
4. Strip embedded credentials, accept only GitHub remotes, and build an encoded branch tree URL.
5. Return `available: false` for missing goals, goals without branches, missing/non-GitHub remotes, or git lookup failures.

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
| `POST` | `/api/goals/:id/team/dismiss` | Dismiss a role agent (`{ sessionId }`) |
| `POST` | `/api/goals/:id/team/steer` | Steer a team agent mid-turn (`{ sessionId, message }`) |
| `POST` | `/api/goals/:id/team/abort` | Force-abort a stuck team agent (`{ sessionId }`) |
| `POST` | `/api/goals/:id/team/prompt` | Send prompt to a team agent, queued if busy (`{ sessionId, message }`) |
| `GET` | `/api/goals/:id/team/agents` | List agents for a team goal. `?include=archived` also returns archived agents with `teamLeadSessionId`, `teamGoalId`, and `delegateOf` fields |
| `POST` | `/api/goals/:id/team/complete` | Complete a team (dismiss agents, keep team lead). Body `{ confirmBypassedGates?: boolean }` — the agent/MCP path is refused while any gate is `bypassed`; a human confirms with `confirmBypassedGates: true` (403 for sandbox tokens). See [Gate bypass endpoint](#gate-bypass-endpoint). |
| `POST` | `/api/goals/:id/team/teardown` | Fully tear down a team (dismiss all + terminate team lead) |

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
| `POST` | `/api/sessions/:id/orchestrate/prompt` | Run-if-idle / queue a prompt to an owned child (`{ childSessionId, message }`) |
| `POST` | `/api/sessions/:id/orchestrate/steer` | Mid-turn steer an owned child (`409` if the child is not streaming) |
| `POST` | `/api/sessions/:id/orchestrate/abort` | Force-abort an owned child |
| `POST` | `/api/sessions/:id/orchestrate/wait` | Wait for the **first** awaited child to settle (chunked heartbeat, like `/wait`) |
| `POST` | `/api/sessions/:id/orchestrate/dismiss` | Terminate + archive an owned child |
| `GET` | `/api/sessions/:id/children-count` | Count + list (`{ count, children: [{ id, title }] }`) the session's live **and dormant/persisted** child agents, using the same predicate as the archive cascade. Backs the non-goal archive confirmation modal's child-agent enumeration |

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

### Tool Group Policies

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tool-group-policies` | Get all group default policies as `Record<string, GrantPolicy>` |
| `PUT` | `/api/tool-group-policies/:group` | Set or clear a group default policy (`{ policy: GrantPolicy \| null }`). Valid values: `always-allow`, `ask-once`, `always-ask`, `never-ask`, `never`. Pass `null` to clear. |

### Slash Skills

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/slash-skills` | Discover slash skills for autocomplete (name, description, argument hint) |
| `GET` | `/api/slash-skills/details` | Full slash skill details including content, file paths, and `directories` array listing all scanned directories (default + custom) |

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
| `GET` | `/api/projects` | List visible registered projects in persisted project order. Hidden projects, including the synthetic `system` project, are excluded. |
| `POST` | `/api/projects` | Register a project (`{ name, rootPath, color?, upsert?, acceptCanonical? }`). With `upsert: true`, returns the existing project if one already exists at `rootPath`. On success, `base_ref` is pinned best-effort to the live remote's `origin/<branch>` (via `git ls-remote --symref origin HEAD`) before `project.yaml` is persisted — an unreachable remote leaves it blank (today's runtime fallback). The same pin runs on the provisional→promote path. See [design/base-ref.md](design/base-ref.md). When `rootPath` is a symlink, returns 400 `{ error, code: "symlink_root", rootPath, canonical }` unless `acceptCanonical: true` is set — the caller should prompt the user with both paths and re-submit with `acceptCanonical: true` to register the canonical path (see [internals.md — Symlinked project rootPath handling](internals.md#symlinked-project-rootpath-handling)). Also returns 400 `{ error, code: "preflight_failed", report }` when the server-side pre-flight surfaces any `fail` check (see [add-project-preflight.md](add-project-preflight.md)). |
| `PUT` | `/api/projects/order` | Persist the full visible project ID order for sidebar project drag reorder. Returns `200 { projects }` in the saved order and broadcasts `projects_changed`. See [Project order](#project-order). |
| `GET` | `/api/projects/preflight?path=<absolute>` | Run the [pre-flight validation pass](add-project-preflight.md) for a candidate `rootPath`. Always 200 with a `PreflightReport` when `path` is supplied — failures are the response, not an error. 400 only when `path` is missing. |
| `POST` | `/api/projects/archive-bobbit` | Move existing `<rootPath>/.bobbit/` contents aside into `<rootPath>/.bobbit-archive-NNN/`, preserving `GATEWAY_OWNED_FILES` when the path is gateway-owned. Body: `{ rootPath }`. Does not mutate the registry. Returns 200 with `ArchiveResult`, 400 for bad input (`code: "bad-path"`), or 409 when `.bobbit/` is missing/empty (`code: "no-bobbit-dir"` / `"empty-bobbit-dir"`). See [add-project-preflight.md](add-project-preflight.md). |
| `GET` | `/api/projects/:id` | Get a single project. |
| `GET` | `/api/projects/:id/base-ref/detect` | Read-only `base_ref` resolver helper. Returns `{ resolved, detected }`. `resolved` is exactly what worktrees branch off right now (`resolveBaseRef` against the pool/primary repo). `detected` is the live `git ls-remote --symref origin HEAD` result as `origin/<branch>`, **filtered to be saveable** — it is `null` unless it passes the same grammar + cross-component existence checks add-time pinning applies, so any non-`null` value can be saved without rejection. No mutation. Drives the Settings "Detect from remote" action. See [design/base-ref.md](design/base-ref.md). |
| `PUT` | `/api/projects/:id` | Update name/color. |
| `DELETE` | `/api/projects/:id` | Unregister (does not delete files on disk). Any project may be removed, including the last visible one — when zero non-hidden projects remain, the UI falls back to the existing zero-project first-run state. The hidden "system" project is unaffected by this flow. |

#### Project order

`GET /api/projects` returns only visible, non-system projects in the server-persisted order. Use the returned array order as the source of truth for sidebar grouping; visible project records may include a `position` field, but clients should not need to sort by it.

`PUT /api/projects/order` is a reserved collection-level endpoint. It must be handled by the dedicated order route, never by the generic `PUT /api/projects/:id` update path. The server keeps the dedicated route before project-id handlers and excludes reserved collection subroutes from the generic matcher so `order` cannot be interpreted as a project ID.

`PUT /api/projects/order` saves a new global order for visible projects:

```http
PUT /api/projects/order
Content-Type: application/json

{ "projectIds": ["project-c", "project-a", "project-b"] }
```

`projectIds` must be the complete current list of visible, non-system project IDs in the requested order. On success, the server stores contiguous positions, returns `200` with the visible projects in saved order under `{ projects }`, and broadcasts `projects_changed` with the same ordered `projects` array so connected clients can sync without a reload.

Project objects include the normal project fields; this example is truncated to the fields relevant to ordering:

```json
{
  "projects": [
    { "id": "project-c", "name": "Gamma", "rootPath": "/repo/gamma", "position": 0 },
    { "id": "project-a", "name": "Alpha", "rootPath": "/repo/alpha", "position": 1 },
    { "id": "project-b", "name": "Beta", "rootPath": "/repo/beta", "position": 2 }
  ]
}
```

Invalid requests return `400` and do not mutate the registry:

```json
{ "error": "projectIds must be an array of strings", "code": "invalid_project_order" }
```

`invalid_project_order` covers malformed bodies, non-string IDs, duplicate IDs, unknown IDs, hidden project IDs, and the synthetic `system` project ID. Hidden/system projects do not participate in ordering and are never returned by `GET /api/projects`.

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

`POST /api/goals`, `POST /api/sessions`, and `POST /api/staff` all require a caller-identified project. Resolution order (no silent fallback):

1. If `body.projectId` is a non-empty string matching a registered project → use it.
2. Else if `body.cwd` is a non-empty string inside some registered project's `rootPath` → use that project.
3. Else → **400 Bad Request**.

| Condition | Status | Body |
|---|---|---|
| No `projectId`, no `cwd` | 400 | `{"error":"projectId required: no projectId was provided and cwd (\"\") does not match any registered project"}` |
| `cwd` provided, no containing registered project | 400 | `{"error":"projectId required: no projectId was provided and cwd (\"<cwd>\") does not match any registered project"}` |
| `projectId` provided, unknown id | 400 | `{"error":"Invalid project"}` |

The helper implementing this is `resolveProjectForRequest` in `src/server/agent/resolve-project.ts`. Callers in new handlers should invoke it at the top of the handler and return the 400 directly when `ok === false`.

#### `POST /api/sessions` — `assistantType` carve-outs

`POST /api/sessions` accepts an optional `assistantType` that changes how project resolution applies. The rule is one sentence: **only project-scope assistants require a resolvable project; server-scope assistants do not.**

| `assistantType` | Scope | Project resolution |
|---|---|---|
| _(unset)_, `goal` | project | Standard contract above — `projectId` or matching `cwd` required, else 400. |
| `project`, `project-scaffolding` | project (new) | The server creates a provisional project registration so the session persists under its own context. |
| `role`, `tool` | server | `projectId` is **optional**. When omitted, the server anchors the session at the synthetic `system` project (see [internals.md — Synthetic system project](internals.md#synthetic-system-project)). When the caller _does_ pass a `projectId` (e.g. the Roles/Tools pages when scoped to a project), it is honoured normally. |
| `staff` | project | Standard project resolution — `projectId` or `cwd` inside a registered project required, else 400. Staff agents are project-scoped permanent sessions (they own a `projectId`, a `staff.json` entry under that project, and runtime cwd derived from that project), so the creation assistant must land in a real project context. The UI's **New staff** button passes `projectId` + `cwd` directly from the project header. |

Why: `role` / `tool` assistants edit server-level config (custom roles, custom tools) that does not belong to any project. Forcing them through the project-resolution gate would make `npx bobbit` from a non-project directory return 400 just for opening the Roles page's "+ New Role" button. The system-project anchor gives those sessions a valid persistence store without requiring the user to register a real project first. `staff` is excluded from the carve-out because a staff agent is not server-level config — it is a long-lived agent that operates inside a specific project — so anchoring its creation assistant at the system project would orphan the record and risk launching from the server/default cwd.

### Project Config

Per-project overrides (recommended — scoped to a registered project):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/config` | Raw project-level overrides (only keys explicitly set). |
| `GET` | `/api/projects/:id/config/defaults` | Built-in defaults for all known config keys. |
| `GET` | `/api/projects/:id/config/resolved` | Fully resolved values; each key returns `{ value, source }` where `source` is `"project"`, `"server"`, or `"default"`. |
| `PUT` | `/api/projects/:id/config` | Set/clear project-level overrides. Empty string or `null` clears an override. Atomic: all keys validated before any are written. |
| `GET` | `/api/projects/:id/qa-testing-config` | Returns `{ configured: boolean }` — `true` iff at least one component has a non-empty `config.qa_start_command`. Drives the UI toggle on the `agent-qa` optional verify step. Detailed per-key values are not surfaced here; the `/qa-test` skill reads them directly from `project.yaml`. |

`PUT /api/projects/:id/config` is a generic KV writer. It accepts any scalar `project.yaml` field — including `build_command`, `test_command`, `typecheck_command`, `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `sandbox`, `base_ref`, and any custom keys the project defines — and the only validation is that keys must not contain `.`. `base_ref` carries extra rules: tags, SHAs, non-`origin` remote prefixes, and (for `sandbox = docker` projects) local refs are rejected with 400 and a structured `{ field: "base_ref", error, details? }` payload; multi-repo saves additionally `git rev-parse --verify` the ref in every component repo and return per-component bullets in `details[]` when missing. Validation only runs when `base_ref` is present in the body. See [design/base-ref.md](design/base-ref.md). Two fields (`config_directories`, `sandbox_tokens`) are sent as structured native types (arrays of mappings); legacy JSON-string payloads for these keys are rejected with 400. The seven legacy top-level QA keys (`qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_env`, `qa_max_duration_minutes`, `qa_max_scenarios`) are **rejected** with 400 — they live on `components[<name>].config[<key>]` now (see [internals.md — Multi-repo & components](internals.md#multi-repo--components)). Inline env vars directly into `qa_start_command`. See [internals.md — Native-YAML project.yaml fields](internals.md#native-yaml-projectyaml-fields). This endpoint is what the settings UI and the mid-session project-proposal accept path both write through (see [internals.md — Per-project config](internals.md#per-project-config)). The project's display `name` is **not** a `project.yaml` field — update it via `PUT /api/projects/:id`. Model preferences (`session_model`, `review_model`, `naming_model`) are **not** project-scoped either; they live in the preferences store.

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
| `POST` | `/api/system-prompt/customise` | Copy shipped `defaults/system-prompt.md` to `<bobbitConfigDir>/system-prompt.md` so the user can edit it |

**`POST /api/system-prompt/customise`** — no request body. Behaviour:

- If `<bobbitConfigDir>/system-prompt.md` does not exist, copies `defaults/system-prompt.md` to that path.
- If the user file already exists, it is left unchanged (no-op overwrite — user edits are never clobbered).
- Returns `{ path, created, content }` where `path` is the absolute user-override path, `created` is `true` only when the file was just copied this call, and `content` is the current file contents (newly copied default or pre-existing user version).
- Errors: `500 { error }` if the shipped default is missing from the install or the copy/read fails.

This is the explicit opt-in path for customising the global system prompt. The startup pipeline no longer scaffolds the file — see [internals.md — Config cascade](internals.md#config-cascade) for the runtime resolution rules.

### Workflows

Workflows are **project-scoped only** — there is no cascade and no system-scope layer. All mutations require `projectId`; reads without `projectId` return an empty list / 404 (intentionally lenient so the Workflows page doesn't crash during scope transitions). See [internals.md — Workflows are project-scoped only](internals.md#workflows-are-project-scoped-only) for the rationale.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows?projectId=X` | List workflows for a project. Without `projectId`, returns `{ workflows: [] }`. |
| `GET` | `/api/workflows/:id?projectId=X` | Get full workflow detail. Without `projectId`, returns 404. |
| `POST` | `/api/workflows?projectId=X` | Create a workflow. **Requires `projectId`** — 400 otherwise. |
| `PUT` | `/api/workflows/:id?projectId=X` | Update a workflow. **Requires `projectId`** — 400 otherwise. |
| `DELETE` | `/api/workflows/:id?projectId=X` | Delete (blocked if in-use by active goals). **Requires `projectId`** — 400 otherwise. |
| `POST` | `/api/workflows/:id/clone?projectId=X` | Deep-copy a workflow with a new ID. **Requires `projectId`** — 400 otherwise. |

There is no `?scope=server` parameter on workflow endpoints — it was removed when the system-scope workflow layer was eliminated.

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
| `GET` | `/api/image-models` | List currently available image-generation models |
| `POST` | `/api/image-generation/generate` | Generate images through the configured image model; used by the `generate_image` tool |

`GET /api/models` includes each model's `cost` in pi-ai's per-million-token shape: `{ input, output, cacheRead, cacheWrite }`. For AI Gateway models, Bobbit derives this from `/v1/models` `pricing.prompt` and `pricing.completion` metadata and does not call gateway aggregate endpoints such as `/v1/usage`, `/v1/cost`, or `/v1/credits`.

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

Outbound requests that these endpoints make to the configured/tested AI Gateway carry Bobbit's canonical AI Gateway user agent. Model discovery also consumes `/v1/models` pricing metadata and persists converted costs into generated agent `models.json` entries. See [AI Gateway request headers](internals.md#ai-gateway-request-headers-user-agent-x-opencode-session) and [AI Gateway model pricing](internals.md#ai-gateway-model-pricing).

### OAuth

Provider-aware. Bobbit can hold OAuth credentials for several providers concurrently (currently `anthropic` and `openai-codex`); every endpoint takes a `provider` discriminator so the same flow IDs and credential rows do not bleed across providers.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/oauth/status?provider=<id>` | OAuth status for one provider. Returns `{ provider, authenticated, expires? }`. |
| `POST` | `/api/oauth/start` | Begin an OAuth flow for a provider. Body: `{ provider }`. Returns `{ provider, flowId, url, callbackServer?, instructions? }`. |
| `POST` | `/api/oauth/complete` | Exchange `code` for tokens. Body: `{ flowId, code }`. Returns `{ success: true }` (200) or `{ success: false, error }` (400). |
| `GET` | `/api/oauth/flow-status?flowId=<id>&provider=<id>` | Poll an in-flight flow. Returns `{ complete, error? }`. |

**Provider IDs:** `anthropic` (Claude.ai login → API key/refresh token) and `openai-codex` (ChatGPT subscription → bearer token). Provider validation is performed by the `normalizeProvider` helper in `src/server/auth/oauth.ts`; an unsupported value causes the surrounding endpoint to throw, which the server wraps as `400 { error: "<thrown message>" }` (e.g. `"Error: Unsupported OAuth provider: foo"` for status, or `500` for start). The error string is implementation-defined — callers should treat any 4xx with an `error` field as "unknown provider".

**Why `provider` everywhere:** the same browser-redirect callback URL is shared between providers, and a user may legitimately have flows in flight for both at once. Keying every operation by `provider` (alongside `flowId`) keeps state strictly partitioned and lets the UI render Settings → Account as parallel rows that can be (re-)authed independently.

**`GET /api/oauth/status?provider=<id>`** responses:

- `200 { provider: "anthropic", authenticated: true, expires: 1775812345000 }` — credential present and not expired.
- `200 { provider: "anthropic", authenticated: false }` — no stored credential, or the stored credential is expired.
- `400 { error: "<message>" }` — provider value rejected by `normalizeProvider`.

The response intentionally does **not** echo the bearer token / API key — strict-OAuth contract.

**`POST /api/oauth/start`** body: `{ provider: "anthropic" | "openai-codex" }`. Returns:

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
- `callbackServer`: `true` for OAuth providers that complete via the embedded callback server (e.g. `openai-codex`); `false`/absent for providers that require the user to paste the returned `code` back into the UI (e.g. `anthropic`).
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

See [AGENTS.md — Add / debug per-provider OAuth](../AGENTS.md#add--debug-per-provider-oauth) for the file map and the Settings → Account UI walkthrough.

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

**Content origin — `/preview/<sid>/<rel-path>`** (no `/api/` prefix). Files are served from `<stateDir>/preview/<sid>/` with proper MIME types and `Cache-Control: no-store`. HTML responses get a `<base href="/preview/<sid>/">` and the shared theme/swipe bridge scripts injected; non-HTML assets pass through untouched. Auth is by the `bobbit_session` cookie (HttpOnly, `Path=/`, 30-day max-age, `Secure` outside localhost) — iframe loads, link navigation, and "Open in new tab" all carry it automatically. Path-traversal escapes return `403`; missing files return `404`. Method gate: `GET`/`HEAD` only.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/preview/mount?sessionId=<sid>` | Populate the per-session preview mount, OR restore an immutable artifact. Body is one of: `{ html, entry? }` (inline), `{ file: "/abs/path/report.html", assets?: string[], manifest?: string }` (copy entry plus explicitly declared siblings), or `{ artifactId }` (restore a previously captured artifact — mutually exclusive with `html`/`file`/`assets`/`manifest`). Returns `200 { url, path, relPath, entry, mtime, contentHash, artifactId }` for inline, plus `assets: string[]` (resolved + sorted) for the `file` form. `contentHash` is a lowercase SHA-256 hex string for the populated mount tree; `artifactId` is the id of the immutable artifact written alongside the mount (see [docs/design/side-panel-tab-contract.md](design/side-panel-tab-contract.md) and the [Preview architecture](preview-architecture.md) doc for lifecycle). `relPath` is the host-invariant `<sessionId>/<entry>` identifier (forward slashes on all OS) used by the agent tool to build the v3 snapshot marker. `400` invalid sessionId / bad entry / non-absolute file / file not `.html`/`.htm` / `assets` or `manifest` passed with `html` / invalid asset path (absolute, `..`, `\`, `\0`, `**`, `[...]`, `{a,b}`) / manifest JSON parse error / `artifactId` combined with another body field; `403` sandbox-out-of-scope or symlink escape; `404` source file / manifest file / literal asset missing / `artifactId` unknown or owned by a different session. No size cap — asset inclusion is explicit and agent-driven. On success the server fans out a `preview-changed` SSE event. |
| `POST` | `/api/preview/artifacts/<artifactId>/restore?sessionId=<sid>` | Restore a previously captured immutable preview artifact into the session's live mount and broadcast `preview-changed`. The artifact must belong to `<sid>`; cross-session ids return `404`. Returns the same shape as the mount `POST` (`{ url, path, relPath, entry, mtime, contentHash, artifactId }`). Used by the preview-renderer Open button on historical `preview_open` tool cards. Equivalent to `POST /api/preview/mount` with `{ artifactId }` body; this dedicated route keeps the URL self-describing for the client restore path. |
| `GET` | `/api/preview/mount?sessionId=<sid>` | Bootstrap probe used by the panel after session-select. Returns `{ url, path, relPath, entry, mtime, contentHash, artifactId? }` (artifactId present iff an artifact was persisted for the current mount), or `404 { error: "no preview mount" }` if the mount is missing or empty. |
| `GET` | `/api/sessions/:id/preview-events` | Server-Sent Events stream for preview changes. Frames: `event: hello` on connect, `event: preview-changed` with `{entry, mtime, url, path, contentHash, artifactId?}` after every successful mount or artifact restore. Note: the SSE payload does **not** include `relPath` — only the mount REST responses do. The handler bootstraps by emitting one `preview-changed` event synchronously if a mount already exists for the session — closes the subscription race. 25 s `:keepalive` comments. Cookie auth (or admin bearer); sandbox-token requests get `403`. |

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

Step `status` is explicit: `passed`, `failed`, `skipped`, `running`, `waiting`, or `blocked`. Non-final `running`, `waiting`, and `blocked` steps should not be interpreted as failed when `passed` is absent or null. Default verification output is the last 20 lines per step, including bounded live stdout/stderr tails for running command steps. Completed signals keep their persisted final results.

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
- Active verifications for affected gates are cancelled before status changes are persisted.
- The server emits `gate_status_changed` plus `gate_reset` WebSocket events and notifies the team lead when one is active.
- Sandboxed agent tokens are forbidden from this route.

Errors: 400 when the goal has no workflow; 403 for sandbox-scoped tokens; 404 for unknown goal/gate; 409 when the goal is archived.

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

A scoped read endpoint for targeted gate data retrieval. Used by the `gate_inspect` agent tool. It applies bounded text selection to text-heavy gate fields so agents can inspect large content, verification output, and signal history without loading the full payload into context.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `section` | `"content"` \| `"verification"` \| `"signals"` | yes | — | What data to retrieve |
| `signal_index` | integer | no | `-1` (latest) | Which signal. 0-based, negative indexes from end. Ignored for `section=signals`. |
| `step` | string | no | — | `section=verification` only: scope the response to a single verification step by name. Other sections return 400. |
| `mode` | `"full"` \| `"grep"` \| `"head"` \| `"tail"` \| `"slice"` | no | `"tail"` | Retrieval mode. Omitted mode returns the last 20 lines per selected field/verification step, not full output. |
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

When `mode` is omitted, the endpoint defaults to the last 20 lines. If that implicit default omits earlier lines, the response includes an omission hint such as:

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

Pass `step=<name>` to scope the snapshot to a single verification step. When set, `steps[]` contains only the matching step (still a single-element array, so the same response shape applies) and the selection mode applies to that one step's output. Step names come from `gate_status.failedSteps` and from each step's `name` in an unfiltered snapshot. An unknown step name returns 400 with the list of available step names for that signal; using `step` with `section=content` or `section=signals` returns 400 (`step is only valid with section='verification'`).
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

Step `status` is one of `passed`, `failed`, `skipped`, `running`, `waiting`, or `blocked`. `waiting` means the step is yet to run. `blocked` means it will not run because an earlier phase failed. For non-final `running`, `waiting`, and `blocked` rows, `passed` may be absent or null; clients must not infer failure from old placeholder `passed: false` seed values.

Running command steps may include bounded live stdout/stderr reads via `liveLogs`. The server reads a capped portion of the live log file first, then applies the requested `tail`, `head`, `slice`, `grep`, or `full` selection and the aggregate output budget. Use those selection modes for deeper targeted logs instead of relying on the default 20-line tail.

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
GET /api/goals/goal-1/gates/implementation/inspect?section=verification&mode=full
```

Returns 400 if `section` is missing or invalid, regex compilation fails, line counts are invalid, a slice range is missing/non-integer/below 1/`from > to`, `step` names an unknown step (the error lists the available step names), or `step` is combined with `section=content`/`section=signals`. Returns 404 if the resolved signal index is out of range.

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

`POST /api/sessions/:archivedId/continue` creates a brand-new session whose agent CLI rehydrates from a byte-for-byte clone of an archived, non-goal, non-delegate session's `.jsonl`. Used by the "Continue in New Session" footer button on archived session transcripts.

**Why it exists**: Users often want to pick up work from a finished session without reanimating its runtime state (stale worktree, dead sandbox container, committed/uncommitted changes on an old branch). This endpoint copies the *configuration* (project, model, role, sandbox mode, worktree mode) plus a verbatim copy of the source `.jsonl`, while routing through the normal session-setup pipeline so the runtime is entirely fresh — new worktree, new container state, no branch/commit inheritance, no goal/team/delegate relationships. The agent CLI rehydrates the cloned transcript via `switch_session`, the same mechanism restart-resume uses for live sessions — lossless, no byte budget, no system-prompt injection.

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

The new session's title is marked as generated, which prevents the first-message auto-titler from overwriting `Continued: …` on the user's first prompt. `assistantType` echoes the source value (or `null` for non-assistant sessions) so callers can confirm the identity carried over.

**Error responses**:

| Status | Meaning |
|---|---|
| `404` | Archived session not found, or its transcript (`.jsonl`) is missing on disk and `recoverSessionFile` cannot locate it |
| `409` | Source session is not archived |
| `410` | Source project has been unregistered (session cannot be continued without its project context) |
| `422` | Source is a goal, delegate, or team member (`goalId` / `delegateOf` / `teamGoalId` set) — not eligible for continuation; **or** the copy would cross realms (host↔sandbox or between two different sandboxed projects — `CrossRealmCopyError`) |
| `500` | JSONL clone failed unexpectedly (e.g. disk full, permission denied) — the destination file is unlinked and no session row (including any partially-cloned proposal-drafts directory) is created. See server logs. |

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
