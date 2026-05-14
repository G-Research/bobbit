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
| `POST` | `/api/sessions/:id/mark-read` | Record that the user viewed this session. Sets `lastReadAt = Date.now()` on the persisted session row; clients compare `lastActivity > lastReadAt` to render the unseen-activity dot. Works on live, dormant, and archived sessions. See [docs/internals.md — Read/unread state](internals.md#readunread-state). 404 if the session id is unknown. |
| `POST` | `/api/sessions/:archivedId/continue` | Create a new session whose agent CLI rehydrates from a byte-for-byte clone of the archived session's `.jsonl`. See [Continue-Archived endpoint](#continue-archived-endpoint) |
| `GET` | `/api/sessions/:id/output` | Get final assistant output from the last turn |
| `GET` | `/api/sessions/:id/git-status` | Git status for session's working directory (branch, ahead/behind, dirty files) |
| `GET` | `/api/sessions/:id/pr-status` | PR status for session's branch (via `gh pr view`) |
| `GET` | `/api/sessions/:id/cost` | Token usage and cost for a single session |
| `GET` | `/api/sessions/:id/tool-content/:messageIndex/:blockIndex` | Lazy-load full tool input content for a truncated block (see [Large content truncation](#large-content-truncation)) |
| `GET` | `/api/sessions/:id/transcript` | Paginated, regex-filterable transcript reader. Backs the `read_session` tool. Query params: `offset` (negative = from end), `limit` (default 20, clamped 1..200), `pattern`, `case_sensitive`, `context` (±5 max), `verbose`. Same-project authorization via the `x-bobbit-session-id` request header. Errors: `session_not_found` (404), `transcript_unavailable` (404), `invalid_regex` / `invalid_params` (400), `permission_denied` (403). Pure parser lives in `src/server/agent/transcript-reader.ts`. |
| `GET` | `/api/sessions/:id/transcript/before-compaction` | Paginated read of the orphaned pre-compaction entries for a single compaction event. Query params: `compactionId` (required, sidecar entry id), `cursor` (from previous response's `nextCursor`), `limit` (default 50, clamped 1..200). Response envelope `{ total, returned, nextCursor, messages[] }`. Same-project authorization via the `x-bobbit-session-id` header. Errors: `session_not_found` (404), `transcript_unavailable` (404), `compaction_not_found` (404), `invalid_params` (400), `permission_denied` (403). Branch-split via the sidecar's `firstKeptEntryId`; legacy fallback scans the JSONL for an inline `type:"compaction"` marker. Reader: `readOrphanedBeforeCompaction` in `src/server/agent/transcript-reader.ts`. See [docs/compaction-history.md](compaction-history.md). |


### Proposal drafts

In-flight `propose_*` payloads are mirrored to `.bobbit/state/proposal-drafts/<sessionId>/<type>.{md,yaml}` so the agent can tweak them via `view_proposal` / `edit_proposal` without re-emitting the full payload. The file is the single source of truth; the in-memory client slot (`state.activeProposals[type]`) is a parsed projection. See [docs/internals.md — Editable proposals](internals.md#editable-proposals) and [docs/design/editable-proposals.md](design/editable-proposals.md).

`<type>` is one of `goal | project | workflow | role | tool | staff`. `goal` files are markdown with YAML frontmatter; the others are native YAML.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/proposal/:type` | Read the raw proposal file body. `200` with `text/markdown` (goal) or `application/yaml` (others). `404 {ok:false, code:"FILE_NOT_FOUND", message}` if no draft. |
| `POST` | `/api/sessions/:id/proposal/:type/seed` | Called by `propose_*` tool `execute()`. Body `{ args: <propose-args object> }`. Serialises args via the per-type plugin, atomically writes the file, parses, broadcasts `proposal_update {source:"seed", rev}`. `200 {ok:true, rev}` on success; `400` with structured error on parse/validate failure. |
| `POST` | `/api/sessions/:id/proposal/:type/edit` | Surgical edit. Body `{ old_text: string, new_text: string }`. Exact-string replacement, first-and-only-occurrence rule, empty `new_text` deletes. On success: writes atomically, broadcasts `proposal_update {source:"edit", rev}`, returns `200 {ok:true, newContent, rev}`. On failure: file unchanged, returns 4xx with structured error. |
| `POST` | `/api/sessions/:id/proposal/:type/restore` | Restore a prior revision snapshot. Body `{ rev: number }` (positive integer). Copies `<type>.history/<rev>.<ext>` back to the live draft AND writes a NEW snapshot at `currentRev+1` so the rollback appears in the timeline. Broadcasts `proposal_update {source:"restore", rev: newRev}`. `200 {ok:true, newRev, fields}` on success; `400 {ok:false, code:"INVALID_BODY"}` if `rev` is not a non-negative integer; `404 {ok:false, code:"SNAPSHOT_NOT_FOUND", message}` if the requested snapshot file is missing; `400` with `ParseError` shape if the snapshot fails to parse. |
| `DELETE` | `/api/sessions/:id/proposal/:type` | Delete the draft. Broadcasts `proposal_cleared`. `204` on success (idempotent — `204` even if the file was absent). Called by accept handlers after a successful save. The per-session `<type>.history/` directory is cleaned with the rest of the per-session draft dir on session terminate. |

#### Error response shape

All 4xx responses for the edit / seed endpoints share the same JSON shape:

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
| `INVALID_BODY` | `400` | edit, seed | Body is not JSON, or required keys are wrong type. |
| `FILE_NOT_FOUND` | `404` | GET, edit | No prior `propose_<type>` in this session. The `message` names the matching `propose_*` tool. |
| `OLD_TEXT_NOT_FOUND` | `400` | edit | `old_text` does not occur in the file. |
| `OLD_TEXT_NOT_UNIQUE` | `400` | edit | `old_text` matches multiple times — ambiguous. Caller must extend `old_text` with surrounding context. |
| `FRONTMATTER_MALFORMED` | `400` | edit, seed | `goal.md` frontmatter fence is broken or unparseable. |
| `YAML_PARSE_ERROR` | `400` | edit, seed | Post-edit YAML body fails to parse. |
| `MISSING_REQUIRED_FIELD` | `400` | edit, seed | Per-type required-field whitelist failed (`field` set). |
| `STRUCTURAL_VALIDATION_FAILED` | `400` | edit, seed | Project YAML fails the structural validator shared with `PUT /api/projects/:id/config`. |

**Atomic rollback.** Any failure in `edit` or `seed` after the per-type parse step leaves the file on disk byte-for-byte identical to its pre-call state — the implementation writes to `<file>.tmp` and `fs.rename`s only after parse + validate succeed. A failed edit followed by `GET` returns the original body unchanged.

**Path safety.** `:id` is validated against `/^[A-Za-z0-9_-]+$/` and `:type` against the union literal; invalid values return `400 {error:"Unknown proposal type: ..."}` before any disk access.

**Restart survival.** On WS attach, `src/server/ws/handler.ts` enumerates the per-session directory and re-emits one `proposal_update {source:"rehydrate", rev}` per surviving file (where `rev` is computed from the highest integer in the `<type>.history/` dir, or `0` for legacy sessions predating the snapshot system), so reloading a browser or restarting the server mid-edit yields the same UI state without a separate persistence layer.

**Revision snapshots.** Every successful `seed` and `edit` write also writes an immutable per-rev snapshot under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/<rev>.<ext>` (filename grammar `^(\d+)\.(md|yaml)$`; integer rev parsed back from filenames — no metadata file). The server stamps the resulting `rev` on every `proposal_update` WS event (single source of truth — the client overwrites `slot.rev` with the server value, never increments locally). Snapshot-write failures are non-fatal: the live draft is committed and the broadcast carries `rev: 0`, which the client treats as "snapshot system unavailable". The `restore` endpoint is the only way to navigate the history; chat-card "Open proposal" buttons drive it via the `__proposal_rev_v1__:<n>` marker embedded in tool-result text by the `propose_*` and `edit_proposal` tool extensions. Full design: [docs/design/proposal-revision-snapshots.md](design/proposal-revision-snapshots.md).

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
| `POST` | `/api/goals` | Create a goal (`{ title, cwd, spec, team?, worktree?, reattemptOf?, parentGoalId?, divergencePolicy?, maxConcurrentChildren?, inlineRoles?, workflowId?, workflow? }`). Workflow resolution runs four layers: cascade lookup → project-store fallthrough (handles transient stale-cascade) → lazy auto-seed of built-in `general`/`feature`/`bug-fix`/`parent` workflows when the project store is empty → friendly `400 { code: "WORKFLOW_NOT_FOUND", workflowId, available: [...] }` when an explicit `workflowId` is unknown in a non-empty store. When `workflowId` is omitted, the first workflow in the project's store is used. See [goals-workflows-tasks.md — Default workflow resolution](goals-workflows-tasks.md#default-workflow-resolution) for the full convention. |
| `GET` | `/api/goals/:id` | Get a goal |
| `PUT` | `/api/goals/:id` | Update a goal. Updatable fields: `title`, `cwd`, `state`, `spec`, `team`, `repoPath`, `branch`, `reattemptOf`, `divergencePolicy`, `maxConcurrentChildren`, `paused`, `replanCount`, `acceptanceCriteria`, plus the parent/child relationship fields (`parentGoalId`, `rootGoalId`, `mergeTarget`, `spawnedFromPlanId`, `spawnedBySessionId`). |
| `DELETE` | `/api/goals/:id` | Archive a goal (soft-delete). **Cascade contract**: requires explicit `?cascade=true\|false` — omitted returns 422 `{code:"CASCADE_REQUIRED"}`. With `?cascade=false`, returns 409 `{code:"HAS_DESCENDANTS", count}` if the goal has any non-archived descendants. With `?cascade=true`, walks descendants depth-first and archives each. Optional `?mergedManually=true` reconciles the target's `state` to `"complete"` before archiving (target-only, NOT cascaded descendants); used by the `goal_archive_child` tool when the team-lead manually merged a child whose `ready-to-merge` failed. |
| `GET` | `/api/goals/:id/commits` | Commit history for goal branch (excludes primary branch commits) |
| `GET` | `/api/goals/:id/git-status` | Git status for goal worktree (branch, ahead/behind primary, clean) |
| `GET` | `/api/goals/:id/cost` | Aggregate cost across all sessions linked to a goal |
| `GET` | `/api/goals/:id/tree-cost` | BFS tree-cost rollup across the goal and all non-archived descendants. Returns `{ rootGoalId, totalCost, perGoal: [{goalId, cost}, ...] }`. Cached on `(rootGoalId, costGeneration)` — invalidated when any descendant's cost mutates. |
| `GET` | `/api/goals/:id/descendants` | BFS descendant walk via `parentGoalId` (depth cap 32). Returns `{ goals: PersistedGoal[] }` with full records for every descendant — live AND archived — of the goal, excluding the goal itself. Powers the dashboard's Plan-tab data source so archived siblings stay visible in the DAG regardless of the sidebar's "See Archived" toggle (see [docs/nested-goals.md — Plan tab](nested-goals.md#data-source-dashboardgoalpool-and-descendants)). NOT gated by `requireSubgoalsEnabled()` — Plan tab is core dashboard functionality. 404 if the goal or its project context is not found. |
| `GET` | `/api/goals/:id/pr-status` | PR status for goal branch (cached, via `gh pr view`) |
| `POST` | `/api/goals/:id/pr-merge` | Merge PR for goal branch (`{ method? }`) |

#### Nested goals (the 9 `Children` operations + plan/policy)

All routes in this section are gated behind the **Subgoals (Experimental)**
system-scope toggle (default OFF). When the toggle is off they return
`403 { code: "SUBGOALS_DISABLED" }` via `requireSubgoalsEnabled()`. The
`GET /api/goals/:id/tree-cost` route above is gated the same way. See
[docs/design/subgoals-experimental-toggle.md](design/subgoals-experimental-toggle.md).

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/goals/:id/spawn-child` | Create or return an existing child goal under the parent, keyed by `planId`. Body: `{ planId, title, spec, workflowId?, workflow?, suggestedRole?, inlineRoles?, dependsOn?: string[] }`. Idempotent on `planId` (re-call returns the existing child id, 200, instead of 201). `dependsOn[]` lists sibling `planId`s this child waits on — validated against the parent's existing children's `spawnedFromPlanId` values; 400 `SELF_DEPENDENCY`, 400 `UNKNOWN_PLAN_ID {missing}`, or 400 `DEPENDS_ON_CYCLE {path}` on failure. Stamped onto `PersistedGoal.dependsOnPlanIds` immediately after createGoal alongside `spawnedFromPlanId`. The child's branch is created off the parent's branch HEAD; child's `ready-to-merge` will merge LOCALLY into the parent (no remote PR raised). Cycle prevention (separate from depends-on): cannot spawn a child whose id is in the parent's ancestor chain. Nesting-limit gate: 403 `SUBGOALS_DISABLED` when subgoals are off for this goal tree, 403 `NESTING_DEPTH_EXCEEDED {currentDepth, maxDepth}` when spawning would push the child past the effective ceiling. The idempotency check runs BEFORE the nesting check, so re-calls with an already-spawned `planId` still succeed even past the limit. Pause-cascade gate: 409 `{code:"GOAL_PAUSED", goalId}` when the parent is paused — evaluated BEFORE the idempotency check, so a re-spawn of the same `planId` on a paused parent is also blocked (pause means "no new spawn intent"). See [docs/nested-goals.md — Nesting depth limit & per-goal toggle](nested-goals.md#nesting-depth-limit--per-goal-toggle) and [Pause / resume](nested-goals.md#pause--resume). |
| `POST` | `/api/goals/:id/integrate-child/:childId` | Merge a child's branch locally into the parent and auto-archive the child on success. **RTM gate guard**: returns 409 `{code:"RTM_NOT_PASSED"}` unless the child's `ready-to-merge` gate has passed; pass `{force:true}` in the body to override (recovery only). On clean merge: child auto-archived, team torn down. On merge conflict: 409 `{conflict:true, output}` and the child stays live for manual resolution. |
| `POST` | `/api/goals/:id/pause` | Cascade-required (`{cascade:boolean}`). Optional body field `childGoalId: string` targets a specific direct child of `:id` instead of `:id` itself — 404 if the child is not found/archived, 403 `NOT_DIRECT_CHILD` if it isn't a direct child of `:id`. Flips `paused:true` on the (cascaded) subtree, cancels in-flight gate verifications, and `abortSessionTurn`s (soft abort — sessions stay registered, ready to resume) **every** streaming session whose `goalId` is in the subtree — team-leads, coders, reviewers, and `llm-review-*` verifier sessions — via `SessionManager.getAllSessionsRaw()`. The caller's own session is excluded from the sweep (via `x-bobbit-spawning-session` / `x-bobbit-session-id` headers) so a coordinator pausing its own subtree doesn't abort itself mid-turn. While paused, every spawn path (`/team/start`, `/team/spawn`, `/spawn-child`, `/gates/:gateId/signal`) returns 409 `{code:"GOAL_PAUSED", goalId}`, and `TeamManager._bootRespawnSessionlessGoals` skips the goal (no whack-a-mole respawn). Returns `{paused:N}` where `N` is the number of goals newly flipped (re-pausing is a no-op). See [docs/nested-goals.md — Pause / resume](nested-goals.md#pause--resume) and [docs/design/pause-cascade.md](design/pause-cascade.md). |
| `POST` | `/api/goals/:id/resume` | Cascade-required (`{cascade:boolean}`). Optional body field `childGoalId: string` targets a specific direct child of `:id` instead of `:id` itself — 404 if the child is not found/archived, 403 `NOT_DIRECT_CHILD` if it isn't a direct child. Inverse of pause — clears `paused:false` on the subtree. Does NOT auto-restart aborted sessions; the operator restarts work manually via `/team/start`. |
| `PATCH` | `/api/goals/:id/plan` | Submit a plan or replan against the goal's frozen `execution.verify[]`. Body: `{proposedSteps: ClassifierPlanStep[]}`. Each step must have non-empty `planId`, `title`, and either top-level `spec` or `subgoal.spec` (R-015 — 400 `{code:"INVALID_PLAN_STEP", index}` otherwise). Each step's optional `dependsOn: string[]` is also validated: 400 `SELF_DEPENDENCY`, 400 `UNKNOWN_PLAN_ID {missing}`, or 400 `DEPENDS_ON_CYCLE {path}`. A `dependsOn` change on a matched `planId` bumps the classifier verdict to `restructure`. Returns the classifier verdict (`noop \| fix-up \| expansion \| restructure \| criteria-drop`) and applies the divergence-policy decision matrix (SUBGOALS-SPEC §3.6): criteria-drop → 409 `CRITERIA_DROP`; restructure on a non-paused goal → 409 `RESTRUCTURE_REQUIRES_PAUSE`; expansion → always queued (`{requiresApproval, requestId}`); fix-up under strict → queued, under balanced/autonomous → applied; `replanCount > 5` → auto-pause for human review. |
| `GET` | `/api/goals/:id/plan` | Read the goal's frozen plan with each child's resolved state. Returns `{steps, gateState, frozen, replanCount}` where each step includes `childGoalId` resolved via `verificationHarness.resolvePlanStepChild()` (5-tier: live in-progress → cached pointer → archived complete → live other → archived non-complete → rescue by title). |
| `POST` | `/api/goals/:id/mutation/:requestId/decision` | Resolve a queued mutation request from `PATCH /plan`. Body: `{decision: "approve" \| "reject"}`. Approve replaces `execution.verify[]` with the proposed steps and increments `replanCount` (auto-pauses at >5). RequestId is implicitly scoped to goalId — the store key is `(goalId, requestId)` so cross-goal access naturally 404s. |
| `PATCH` | `/api/goals/:id/policy` | Update `divergencePolicy` (`strict \| balanced \| autonomous`) and/or `maxConcurrentChildren` (1–8). Broadcasts `goal_state_changed` with the new policy values inline so clients don't refetch. `maxConcurrentChildren` is only consulted on root goals; children store the value but the harness reads the root's. |

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
| `POST` | `/api/goals/:id/gates/:gateId/signal` | Signal a gate (`{ status, content?, verifiedBy? }`). Returns 409 `{code:"GOAL_PAUSED", goalId}` if the goal is paused (blocks both the signal accept and the verifier spawn it would trigger). |
| `POST` | `/api/goals/:id/gates/:gateId/cancel-verification` | Cancel a stuck running verification (idempotent) |

### Goal Team

Routes accept both `/team/` and legacy `/swarm/` paths.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals/:id/team` | Get team state for a goal |
| `POST` | `/api/goals/:id/team/start` | Start a team (creates team lead session). Returns `400 { code: "SPEC_REQUIRED" }` if `goal.spec` is empty, shorter than 20 chars, or the literal sentinel `"placeholder"` — the team-lead's kickoff prompt embeds the spec, so a missing spec produces a useless agent. Guard is REST-only: internal call sites (`autoStartTeam`, verification-harness subgoal step) bypass it deliberately. See [design/team-lead-spec-injection.md](design/team-lead-spec-injection.md). Returns `409 { code: "GOAL_PAUSED", goalId }` if the goal is paused. |
| `POST` | `/api/goals/:id/team/spawn` | Spawn a role agent (`{ role, task, traits? }`). Returns `409 { code: "GOAL_PAUSED", goalId }` if the goal is paused. |
| `POST` | `/api/goals/:id/team/dismiss` | Dismiss a role agent (`{ sessionId }`) |
| `POST` | `/api/goals/:id/team/steer` | Steer a team agent mid-turn (`{ sessionId, message }`) |
| `POST` | `/api/goals/:id/team/abort` | Force-abort a stuck team agent (`{ sessionId }`) |
| `POST` | `/api/goals/:id/team/prompt` | Send prompt to a team agent, queued if busy (`{ sessionId, message }`) |
| `GET` | `/api/goals/:id/team/agents` | List agents for a team goal. `?include=archived` also returns archived agents with `teamLeadSessionId`, `teamGoalId`, and `delegateOf` fields |
| `POST` | `/api/goals/:id/team/complete` | Complete a team (dismiss agents, keep team lead) |
| `POST` | `/api/goals/:id/team/teardown` | Fully tear down a team (dismiss all + terminate team lead). **Cascade-required**: omitted `?cascade=` returns 422 `{code:"CASCADE_REQUIRED"}`. With `?cascade=false`, returns 409 `{code:"HAS_DESCENDANT_TEAMS", count, descendants:[{id,title}]}` if any non-archived descendant has a live team; with `?cascade=true`, walks descendants depth-first and tears down each team (best-effort per-goal), returning `{ok, toreDown, errors[]}`. |

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
| `POST` | `/api/roles` | Create a role (`{ name, label, promptTemplate, toolPolicies?, allowedTools?, accessory?, model?, thinkingLevel? }`). `toolPolicies` is the source of truth for tool access; `allowedTools` is accepted for backward compatibility and merged as `always-allow` entries. `model` is `"<provider>/<modelId>"` format and overrides `default.sessionModel` / `default.reviewModel` for sessions of this role. `thinkingLevel` is one of `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"` (clamped to the role's model capability at write time when `model` is set; see [docs/thinking-levels.md](thinking-levels.md)). |
| `GET` | `/api/roles/:name` | Get a role (includes `toolPolicies` and derived `allowedTools`) |
| `PUT` | `/api/roles/:name` | Update a role. Accepts `toolPolicies` (Record of tool/group name → policy), `model` (`"<provider>/<modelId>"`), and `thinkingLevel` (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`, clamped to the role's model capability when `model` is set). Policy values are validated against: `always-allow`, `ask-once`, `always-ask`, `never-ask`, `never`. Malformed `model` strings are rejected with 400. With `?projectId=<id>`, the update targets the project scope: if the role is not yet in the project store but exists anywhere in the cascade (builtin / server / ancestor project), it is **promoted on first edit** — a project-level record is written with the updated fields, leaving lower layers untouched. `404 Role not found` is returned only when the name is absent from the entire cascade. |
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

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/staff` | List staff agent definitions. Optional `?projectId=<id>` filter; otherwise aggregates across all projects. Each entry includes a `sandboxed` boolean (inherited from project config). Returns `{ staff: PersistedStaff[] }`. |
| `GET` | `/api/staff/orphaned` | List staff records that are not anchored to a real project — missing `projectId` or persisted under the synthetic `system` project (legacy from before staff became project-scoped). Returns `{ staff: PersistedStaff[] }`. Consumed by the sidebar's orphan banner. |
| `GET` | `/api/staff/:id` | Get a single staff agent definition (includes `sandboxed` boolean) |
| `POST` | `/api/staff` | Create a staff agent (`{ name, description, systemPrompt, cwd, triggers?, roleId?, projectId?, sandboxed? }`). Subject to the [project resolution contract](#project-resolution-contract). |
| `PUT` | `/api/staff/:id` | Update a staff agent (`{ name, description, systemPrompt, cwd, state, triggers, memory, roleId }`) |
| `PATCH` | `/api/staff/:id` | Re-home a staff record to a different project. Body: `{ projectId }`. Moves the persisted record between per-project stores, updates `staff.projectId`, and re-indexes search; the existing worktree branch is preserved (the next wake rebases against the new project's primary branch). Used by the sidebar's orphan banner "Assign to project…" action. Returns the updated `PersistedStaff` on 200. **400** when `projectId` is missing or not a non-empty string; **404** when either the staff id or the target project is unknown. |
| `DELETE` | `/api/staff/:id` | Delete a staff agent and terminate its session |
| `POST` | `/api/staff/:id/wake` | Manually trigger a staff agent's wake cycle |
| `GET` | `/api/staff/:id/sessions` | **Deprecated (410)**. Use `GET /api/staff/:id` instead. |

### Projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all registered projects. |
| `POST` | `/api/projects` | Register a project (`{ name, rootPath, color?, upsert?, acceptCanonical? }`). With `upsert: true`, returns the existing project if one already exists at `rootPath`. When `rootPath` is a symlink, returns 400 `{ error, code: "symlink_root", rootPath, canonical }` unless `acceptCanonical: true` is set — the caller should prompt the user with both paths and re-submit with `acceptCanonical: true` to register the canonical path (see [internals.md — Symlinked project rootPath handling](internals.md#symlinked-project-rootpath-handling)). Also returns 400 `{ error, code: "preflight_failed", report }` when the server-side pre-flight surfaces any `fail` check (see [add-project-preflight.md](add-project-preflight.md)). |
| `GET` | `/api/projects/preflight?path=<absolute>` | Run the [pre-flight validation pass](add-project-preflight.md) for a candidate `rootPath`. Always 200 with a `PreflightReport` when `path` is supplied — failures are the response, not an error. 400 only when `path` is missing. |
| `POST` | `/api/projects/archive-bobbit` | Move existing `<rootPath>/.bobbit/` contents aside into `<rootPath>/.bobbit-archive-NNN/`, preserving `GATEWAY_OWNED_FILES` when the path is gateway-owned. Body: `{ rootPath }`. Does not mutate the registry. Returns 200 with `ArchiveResult`, 400 for bad input (`code: "bad-path"`), or 409 when `.bobbit/` is missing/empty (`code: "no-bobbit-dir"` / `"empty-bobbit-dir"`). See [add-project-preflight.md](add-project-preflight.md). |
| `GET` | `/api/projects/:id` | Get a single project. |
| `PUT` | `/api/projects/:id` | Update name, color, palette, `rootPath`, or `parentProjectId`. Body fields are all optional; only present fields are applied. `parentProjectId: string \| null` sets/clears the link used by the [role field-level inheritance chain](internals.md#field-level-role-inheritance); the target must be an existing, non-hidden, non-provisional project that is not the project itself and does not already sit downstream in the chain. Self-reference, unknown id, hidden / provisional target, or any cycle → **400**. Pass `null` (or omit unchanged) to clear. |
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

#### `POST /api/sessions` — `assistantType` carve-outs

`POST /api/sessions` accepts an optional `assistantType` that changes how project resolution applies. The rule is one sentence: **only project-scope assistants require a resolvable project; server-scope assistants do not.**

| `assistantType` | Scope | Project resolution |
|---|---|---|
| _(unset)_, `goal` | project | Standard contract above — `projectId` or matching `cwd` required, else 400. |
| `project`, `project-scaffolding` | project (new) | The server creates a provisional project registration so the session persists under its own context. |
| `role`, `tool` | server | `projectId` is **optional**. When omitted, the server anchors the session at the synthetic `system` project (see [internals.md — Synthetic system project](internals.md#synthetic-system-project)). When the caller _does_ pass a `projectId` (e.g. the Roles/Tools pages when scoped to a project), it is honoured normally. |
| `staff` | project | Standard project resolution — `projectId` or matching `cwd` required, else 400. Staff agents are project-scoped permanent sessions (they own a `projectId`, a `staff.json` entry under that project, and a long-lived worktree), so the creation assistant must land in a real project context. The UI's **New staff** button passes `projectId` + `cwd` directly from the project header. |

Why: `role` / `tool` assistants edit server-level config (custom roles, custom tools) that does not belong to any project. Forcing them through the project-resolution gate would make `npx bobbit` from a non-project directory return 400 just for opening the Roles page's "+ New Role" button. The system-project anchor gives those sessions a valid persistence store without requiring the user to register a real project first. `staff` is excluded from the carve-out because a staff agent is not server-level config — it is a long-lived agent that operates inside a specific project — so anchoring its creation assistant at the system project would orphan the record and force a `propose_staff(cwd)` re-link later.

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
| `model` | `string` | no | Override id in `provider/modelId` form. Both sides are canonicalised before comparison. If unrecognised, the request silently falls back to the session's selected image model rather than rejecting. |
| `size` | `string` | no | Provider-specific size token (e.g. `1024x1024`). |
| `quality` | `string` | no | Provider-specific quality token (e.g. `auto`, `hd`). |
| `background` | `string` | no | One of `transparent`, `opaque`, `auto` (OpenAI-only). |
| `format` | `string` | no | One of `png`, `jpeg`, `webp`. |
| `aspectRatio` | `string` | no | Gemini/Imagen aspect ratio (e.g. `16:9`). |
| `imageSize` | `string` | no | Alternative size token validated against the registry entry's `sizes`. |
| `sessionId` | `string` | no | Used to resolve the session's selected image model when `model` is omitted. |

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

The `model` object echoes the resolved provider/id/name/api so the caller can confirm which model actually served the request (the request `model` may have been canonicalised or fallen back to the session default). Each image carries `data` (base64-encoded bytes) and `mimeType`; some OpenAI calls also include a `revisedPrompt` when the provider rewrote the prompt. The tool extension fans this out to disk paths or inlines base64 in chat as appropriate.

Error responses:

- `400 { error: "Missing prompt" }` — `prompt` missing or non-string. Note the capital `M`.
- `400 { error: "prompt exceeds 8192 chars" }` — prompt over the cap.
- `400 { error: "n must be 1..4" }` — `n` is not an integer or is outside `[1, 4]`.
- `500 { error: "<provider message>" }` — provider helper threw. The message comes straight from `err.message` (typically prefixed with the upstream HTTP status, never `[object Object]`). Provider-specific failure modes (Codex `n=1` clamp, `remote image exceeds 25 MB cap`, missing credentials) all surface here as `500`.

The gateway does **not** return `502` or `503` from this endpoint, and there is no separate `400 { error: "unknown image model" }` path — unknown `model` values silently fall back to the session default (the strict registry check lives on the `set_image_model` WS message instead, see [docs/websocket-protocol.md](websocket-protocol.md)).

Under the AI Gateway, the OpenAI-Codex driver model auto-selects through a fallback chain (env var `BOBBIT_OPENAI_CODEX_IMAGE_DRIVER_MODEL` → `gpt-5.5` → `gpt-5` → `gpt-4o`) — see [AGENTS.md — Image generation failure debugging](../AGENTS.md) for the full diagnostic path. The agent-facing routing rules (when to use `model="openai/gpt-image-2"` vs Google IDs) live in `defaults/system-prompt.md` and the per-tool `Parameters` table is in `defaults/tools/images/generate_image.yaml::detail_docs` (single source of truth).

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
| `POST` | `/api/preview/mount?sessionId=<sid>` | Populate the per-session preview mount. Body is one of `{ html, entry? }` (inline) or `{ file: "/abs/path/report.html", assets?: string[], manifest?: string }` (copy entry plus explicitly declared siblings). Returns `200 { url, path, entry, mtime }` for inline, plus `assets: string[]` (resolved + sorted) for the `file` form. `400` invalid sessionId / bad entry / non-absolute file / file not `.html`/`.htm` / `assets` or `manifest` passed with `html` / invalid asset path (absolute, `..`, `\`, `\0`, `**`, `[...]`, `{a,b}`) / manifest JSON parse error; `403` sandbox-out-of-scope or symlink escape; `404` source file / manifest file / literal asset missing. No size cap — asset inclusion is explicit and agent-driven. On success the server fans out a `preview-changed` SSE event. |
| `GET` | `/api/preview/mount?sessionId=<sid>` | Bootstrap probe used by the panel after session-select. Returns the same `{ url, path, entry, mtime }` shape, or `404 { error: "no preview mount" }` if the mount is missing or empty. |
| `GET` | `/api/sessions/:id/preview-events` | Server-Sent Events stream for preview changes. Frames: `event: hello` on connect, `event: preview-changed` with `{entry, mtime, url, path}` after every successful `POST /api/preview/mount`. The handler bootstraps by emitting one `preview-changed` event synchronously if a mount already exists for the session — closes the subscription race. 25 s `:keepalive` comments. Cookie auth (or admin bearer); sandbox-token requests get `403`. |

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

`POST /api/sessions/:archivedId/continue` creates a brand-new session whose agent CLI rehydrates from a byte-for-byte clone of an archived, non-goal, non-delegate session's `.jsonl`. Used by the "Continue in New Session" footer button on archived session transcripts.

**Why it exists**: Users often want to pick up work from a finished session without reanimating its runtime state (stale worktree, dead sandbox container, committed/uncommitted changes on an old branch). This endpoint copies the *configuration* (project, model, role, sandbox mode, worktree mode) plus a verbatim copy of the source `.jsonl`, while routing through the normal session-setup pipeline so the runtime is entirely fresh — new worktree, new container state, no branch/commit inheritance, no goal/team/delegate relationships. The agent CLI rehydrates the cloned transcript via `switch_session`, the same mechanism restart-resume uses for live sessions — lossless, no byte budget, no system-prompt injection.

**Request body**: empty (or absent). A legacy `mode` field is tolerated but ignored — there is no Summary vs Full distinction any more, and no transcript truncation. See [docs/design/lossless-continue-archived.md](design/lossless-continue-archived.md) for the design rationale.

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
| `404` | Archived session not found, or its transcript (`.jsonl`) is missing on disk and `recoverSessionFile` cannot locate it |
| `409` | Source session is not archived |
| `410` | Source project has been unregistered (session cannot be continued without its project context) |
| `422` | Source is a goal, delegate, team member, or assistant session — not eligible for continuation; **or** the copy would cross realms (host↔sandbox or between two different sandboxed projects — `CrossRealmCopyError`) |
| `500` | JSONL clone failed unexpectedly (e.g. disk full, permission denied) — the destination file is unlinked and no session row is created. See server logs. |

**Scope gate**: The endpoint refuses goal-linked, delegate, team, and assistant sessions on purpose. Goal coupling (team structure, gates, tasks, shared worktrees) and delegate scoping don't survive the continue-into-a-fresh-session model. Users wanting to iterate on a goal should create a new session inside the goal instead.

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
