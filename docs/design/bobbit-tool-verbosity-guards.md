# Design: Bobbit tool verbosity guards

Status: **implemented for `bobbit_*`; superseded for agent-bound `read_session`**
Goal: **Bobbit Tool Verbosity Guards**

> **Supersession boundary:** This document remains the design record for compact
> `bobbit_read`, `bobbit_orchestrate`, and `bobbit_admin` projection. The later
> [Bound Session Diagnostics issue analysis](bound-session-diagnostics-issue-analysis.md)
> supersedes its `read_session` architecture. Use
> [Bounded session diagnostics](../read-session.md) for the shipped agent-facing
> contract. Ordinary direct transcript REST/UI calls retain the compatibility
> behavior described in that guide.

## 1. Problem and scope

Agent-facing gateway tools previously placed much more data in model context than the caller needed. The largest risks were:

- `bobbit_read` returning full goal/session records, including frozen workflow snapshots and full goal specs;
- `read_session` allowing `verbose: true` and `include_tool_results: true` over its normal 20-message default or larger windows; and
- all three `bobbit_*` tools returning successful REST payloads verbatim, with no compact default.

The initial implementation added an **agent-tool output policy** to four tools:

- `bobbit_read`, `bobbit_orchestrate`, and `bobbit_admin` in `defaults/tools/bobbit/extension.ts`;
- `read_session` in `defaults/tools/agent/extension.ts`.

Compact-by-default projection for the three `bobbit_*` tools remains at the
post-REST agent boundary and does not change their gateway REST responses. The
initial `read_session` extension guard is still one layer, but it is no longer
its complete architecture: authenticated agent-bound transcript requests also
use route-level pre-read enforcement, canonical reader projection and work
admission, and a final Pi lifecycle budget. Those controls do not apply to an
ordinary direct REST/UI transcript request.

## 2. Resolved values and shared vocabulary

For `bobbit_*`, the shared module below remains the source of truth. Its
`read_session` entry records the original builtin-extension layer; the immutable
alias guard and agent-bound route/reader enforcement are defined by the
superseding architecture in [section 6](#6-read_session-superseding-agent-boundary-and-rest-compatibility).

Add `defaults/tools/_shared/context-heavy-guard.ts` as the single source of truth used by both extension families. Export these exact values:

```ts
export const CONTEXT_HEAVY_LIMIT = 10;
export const CONTEXT_HEAVY_ERROR_CODE = "CONTEXT_HEAVY_LIMIT_REQUIRED";

export const CONTEXT_HEAVY_FLAGS = {
  bobbit_read: ["verbose"],
  bobbit_orchestrate: ["verbose"],
  bobbit_admin: ["verbose"],
  read_session: ["verbose", "include_tool_results"],
} as const;

export const CONTEXT_HEAVY_LIMIT_GUIDANCE =
  "You should not typically pull this much data from the API. " +
  "Context-heavy flag(s) {flags} require an explicit limit at or below {cap}. " +
  "Call again with limit <= {cap} and fetch in smaller batches only if you REALLY need full verbosity. " +
  "Keep an eye on token consumption.";
```

`CONTEXT_HEAVY_LIMIT_GUIDANCE` is the canonical, testable template. A formatter replaces `{flags}` with comma-separated flag names wrapped in backticks and both `{cap}` placeholders with `10`.

The shared module also exports:

```ts
type ContextHeavyTool = keyof typeof CONTEXT_HEAVY_FLAGS;

interface ContextHeavyGuardError {
  error: string;
  code: typeof CONTEXT_HEAVY_ERROR_CODE;
}

function activeContextHeavyFlags(
  tool: ContextHeavyTool,
  params: Record<string, unknown>,
): string[];

function contextHeavyLimitError(
  tool: ContextHeavyTool,
  params: Record<string, unknown>,
  pageable: boolean,
): ContextHeavyGuardError | undefined;
```

A flag is active only when its value is the boolean `true`; false, absent, and truthy strings do not activate it because TypeBox supplies booleans to these tools. If no heavy flag is active, or `pageable` is false, the guard returns `undefined`. Otherwise, `limit` must be explicitly present, finite, integral, and in `[1, 10]`. Missing, zero, negative, fractional, non-finite, or greater-than-10 limits return the structured error.

The shared classification makes adding a future context-heavy option deliberate: the implementer must add its name to `CONTEXT_HEAVY_FLAGS`, and the unit tests pin those arrays.

## 3. Structured error contract

A rejected call must not fetch the gateway and must not throw. It returns a normal extension tool error whose text is parseable JSON:

```json
{
  "error": "You should not typically pull this much data from the API. Context-heavy flag(s) `verbose`, `include_tool_results` require an explicit limit at or below 10. Call again with limit <= 10 and fetch in smaller batches only if you REALLY need full verbosity. Keep an eye on token consumption.",
  "code": "CONTEXT_HEAVY_LIMIT_REQUIRED"
}
```

The extension result has `isError: true`, `details: undefined`, and one text content block containing `JSON.stringify(errorObject)`. This mirrors the existing agent-facing `read_session` structured-error style and preserves the gateway convention of `{ error, code }` without producing an HTTP 500.

The message deliberately contains all recovery guidance in one place:

1. do not normally pull this much API data;
2. names every active offending flag;
3. requires an explicit limit at or below 10;
4. says to fetch smaller batches only when full verbosity is genuinely necessary; and
5. reminds the agent to watch token consumption.

## 4. Bobbit compact projection architecture

### 4.1 Files and public helpers

Add `defaults/tools/bobbit/compact-projection.ts`. It owns all projection policy and exports:

```ts
export const COMPACT_TEXT_PREVIEW_CHARS = 200;
export const COMPACT_TRUNCATION_SUFFIX = "…(truncated; pass verbose:true)";
export const BOBBIT_COMPACT_PROJECTIONS: Record<
  "bobbit_read" | "bobbit_orchestrate" | "bobbit_admin",
  Record<string, ProjectionSpec>
>;

export function projectBobbitResponse(
  tool: "bobbit_read" | "bobbit_orchestrate" | "bobbit_admin",
  operation: string,
  data: unknown,
): unknown;
```

`BOBBIT_COMPACT_PROJECTIONS` is the **only operation-to-projection map**. Do not put field trimming in `READ_OPS`, `ORCH_OPS`, individual `postProcess` callbacks, or the three `execute` functions. The map must contain one entry for every operation in `BOBBIT_OPERATIONS`; a drift test compares their keys.

`defaults/tools/bobbit/extension.ts` remains the shared registration/dispatch extension for all three tools and imports this pure projection module plus the shared heavy-flag guard. Keeping the projection pure makes it directly unit-testable and keeps REST dispatch concerns separate.

### 4.2 Universal compact rules

Projection profiles are allowlists for known entity shapes plus a conservative generic sanitizer for irregular diagnostic/mutation responses. Every profile applies these universal rules:

**Always retain when present**

- identity and label: `id`, `title`, `name`;
- state: `state`, `status`, `type`;
- project identity: `projectId`;
- errors: `error`, `code`;
- paging: `pagination`, `total`, `hasMore`, `nextOffset`, `nextCursor`;
- recency: `createdAt`, `updatedAt`, `lastActivity`.

These fields survive even when omitted accidentally from a profile allowlist. Pagination objects are recursively sanitized but retain their current fields, including `limit`, `offset`, `cursor`, `mode`, `itemKey`, and `pagedBy`.

**Always remove**

```ts
const UNIVERSAL_DROP_FIELDS = new Set([
  "generation",
  "colorIndex",
  "accessory",
  "clientCount",
  "lastReadAt",
  "isCompacting",
  "spawnPinnedModel",
  "spawnPinnedThinkingLevel",
  "imageGenerationModel",
  "goalAssistant",
  "roleAssistant",
  "toolAssistant",
]);
```

The canonical `assistantType` and `role` strings remain. For any object with an `id`, a non-canonical alias whose scalar value equals that same `id` is removed; protected universal keys (`id` and `projectId`) are never removed by this equality rule. This removes redundant values such as a root goal's `rootGoalId === id` without removing a task's distinct `goalId`.

**Freeform text**

Every string longer than 200 characters is shortened to its first 200 Unicode code units followed immediately by `…(truncated; pass verbose:true)`, except exact machine/action fields that must remain usable: IDs, state/status/type, pagination cursors, branch/SHA fields, timestamps, `error`, and `code`. Named freeform fields (`spec`, `description`, `prompt`, `promptTemplate`, `systemPrompt`, `instructions`, `snippet`, `content`, `currentContent`, `resultSummary`, `output`, `message`, and similarly named markdown/text fields) always pass through the preview helper. Strings at or below 200 characters are unchanged. The output remains valid JSON.

**Embedded workflows**

Goal and session profiles never emit a `workflow` object. They retain an existing `workflowId`; if it is absent but the embedded workflow has a string `id`, projection may derive `workflowId` from that ID before dropping the object. This special rule applies only to workflow snapshots embedded in goal/session-shaped payloads. `get_workflow` is the explicit retrieval operation and returns a compact workflow definition as described below.

### 4.3 Projection profiles

The map refers to named profiles so list/get/mutation operations share identical entity semantics.

#### Goal profile

Keep:

`id`, `title`, `state`, `workflowId`, `projectId`, `branch`, `mergeTarget`, `setupStatus`, `setupError` (previewed), `team`, `paused`, `parentGoalId`, `archived`, `archivedAt`, `createdAt`, `updatedAt`, and `spec` (previewed).

Drop `workflow`, `worktreePath`, `repoPath`, `cwd`, `sandboxed`, `subgoalsAllowed`, `autoStartTeam`, and redundant `rootGoalId`. Other internal planning/config fields are not allowlisted. `list_goals` applies the same goal profile to `goals`; when archive opt-in supplies `archivedSessions`, those rows use the session profile rather than remaining full records.

#### Session profile

Keep:

`id`, `title`, `status`, `assistantType`, `role`, `projectId`, `goalId`, `teamGoalId`, `taskId`, `delegateOf`, `parentSessionId`, `archived`, `archivedAt`, `createdAt`, `lastActivity`, `lastTurnErrored`, `consecutiveErrorTurns`, `completedTurnCount`, and `restoreError` (previewed).

Drop `cwd`, persisted filesystem/worktree paths, and the universal UI/model bookkeeping fields. `list_sessions` applies the profile to both `sessions` and opt-in `archivedDelegates`.

#### Search-hit profile

Keep `id`, `type`, `title`, `score`, `projectId`, `state`, `status`, `archived`, recency timestamps, and `snippet` truncated to the standard preview. Do not retain indexed full bodies or source documents.

#### Task profile

Keep `id`, `goalId`, `parentTaskId`, `title`, `type`, `state`, `dependsOn`, `assignedTo`, `assignedSessionId`, `workflowGateId`, `inputGateIds`, `branch`, `baseSha`, `headSha`, `createdAt`, `updatedAt`, `completedAt`, `spec` (previewed), and `resultSummary` (previewed). This supports assignment, transitions, dependency checks, and git handoff while bounding prose.

#### Gate profile

Keep `id` when supplied, canonical `gateId`, `goalId`, `name`, `type`, `status`, `state`, `dependsOn`, `assignedTo`, `signalCount`, `updatedAt`, `hasContent`, `contentLength`, bypass audit fields (`whyBypassed`, `whoAmI`, `bypassedAt`), and short aggregate counts. Keep `currentContent`/`content` only as a preview. Remove inline `verify` definitions, verification prompts, signal arrays, artifact bodies, step output, and diagnostics bodies. Compact summary/count envelopes remain intact.

#### Project profile

Keep `id`, `name`, `title`, `state`, `status`, `rootPath`, primary/default branch identifiers, `createdAt`, and `updatedAt`. Descriptions are previewed. Large component/config/workflow bodies are omitted from the default entity profile.

#### Workflow profile

For `list_workflows`, keep `id`, `name`, `title`, `projectId`, `type`, `createdAt`, `updatedAt`, and previewed `description`; omit gates. For `get_workflow`, additionally keep a compact `gates` array containing only `id`, `name`, `type`, `dependsOn`, optional/phase metadata, and previewed `description`/`content`. Drop each gate's `verify` blocks and prompt bodies. Thus the explicit workflow read supports DAG inspection without returning verifier prompts.

#### Role, tool, staff, MCP, and commit profiles

- Role: `id`, `name`, `label`, `role`, `type`, `projectId`, `status`, `toolPolicies`, and previewed `description`/prompt fields. Tool policies remain because there is no `get_role` operation.
- Tool: `id`, `name`, `label`, `type`, `group`, `grantPolicy`, `provider`, `enabled`, `status`, `projectId`, and previewed descriptions. Preserve short diagnostics attached to the list envelope.
- Staff: `id`, `name`, `title`, `status`, `state`, `role`, `roleId`, `projectId`, timestamps, and previewed `description`/`triggers`; omit full system prompts.
- MCP server: `id`, `name`, `title`, `type`, `status`, `projectId`, `enabled`, and previewed diagnostic/error descriptions. Omit embedded tool schemas.
- Commit: `id`, `sha`, `hash`, `title`, `message` (previewed), `author`, `createdAt`, `timestamp`, and `status`.

#### Cost and generic diagnostic profiles

`goal_cost` and `session_cost` use an `identity` profile and return unchanged because their payloads are already small and wholly diagnostic.

`health`, `connection_info`, git/PR status, maintenance probes, reset/cleanup acknowledgements, provider/override acknowledgements, and other irregular mutation/admin results use a `generic` profile. Generic projection recursively applies universal drops, text truncation, duplicate-ID removal, and embedded goal/session workflow suppression while preserving short scalar diagnostics and short structural arrays/objects. It preserves legitimate fields named `verify`; only the task, gate, and workflow allowlist profiles omit verifier prompt blocks. This avoids inventing unstable allowlists for heterogeneous maintenance results while still bounding their text. Any array that has a `PageSpec` is paged before generic projection.

### 4.4 Exact operation map

`BOBBIT_COMPACT_PROJECTIONS` maps operations as follows:

| Tool | Operations | Profile |
|---|---|---|
| `bobbit_read` | `list_goals`, `get_goal` | goal (`goals` collection for list) |
| | `list_sessions`, `get_session` | session (`sessions` collection for list) |
| | `search` | search-hit collection |
| | `goal_cost`, `session_cost` | identity |
| | `goal_commits` | commit collection |
| | `list_projects`, `get_project` | project |
| | `list_workflows` | workflow-summary collection |
| | `get_workflow` | workflow-detail |
| | `list_roles` | role collection |
| | `list_tools` | tool collection |
| | `list_gates` | gate collection |
| | `list_tasks`, `get_task` | task |
| | `list_staff` | staff collection |
| | `list_mcp_servers` | MCP-server collection |
| | `health`, `connection_info`, `goal_git_status`, `goal_pr_status`, `maintenance_inspect` | generic |
| `bobbit_orchestrate` | `create_goal`, `update_goal` | goal |
| | `create_session`, `restart_session` | session |
| | `create_task`, `update_task`, `transition_task`, `assign_task` | task |
| | `create_staff` | staff |
| | `signal_gate` | gate/generic signal summary |
| | `archive_goal`, `terminate_session`, `reset_gate`, `cancel_verification`, `delete_staff`, `team_start`, `team_teardown` | generic |
| `bobbit_admin` | `create_project` | project |
| | every other admin operation | generic |

All catalogue keys must appear explicitly in the map even when several point to the same frozen profile object. There is no fallback for a known operation: a missing map entry is a programmer error caught by tests. Unknown operations are rejected by existing dispatch validation before projection.

## 5. Bobbit dispatch and paging flow

Add an optional `toolName` argument to the shared `dispatch` path (or equivalent tier metadata), then execute in this order:

1. resolve the `OpSpec`; reject an unknown operation;
2. validate required parameters;
3. resolve its `PageSpec` using the existing `resolvePageSpec`;
4. run `contextHeavyLimitError(toolName, params, pageSpec !== undefined)` **before building the URL or fetching**;
5. build path/body and call REST;
6. apply existing `postProcess` behavior (including archive filtering);
7. apply existing `pageResult` normalization/slicing;
8. if `params.verbose === true`, return the processed/paged payload unchanged;
9. otherwise call `projectBobbitResponse(toolName, operation, processedAndPaged)`;
10. serialize through `ok()`.

Paging must precede projection. `pageResult` needs the original collection shape and totals; projection must then preserve the normalized `pagination` object. Archive filtering also precedes projection so current live-only semantics and grand-total safeguards do not change.

For a paged `bobbit_read` operation, `verbose: true` therefore requires an explicit `limit <= 10`. The limit is validated before existing `normalizePaging` can clamp it; a caller asking for `limit: 200` must receive guidance, not a silently clamped verbose response. With `limit <= 10`, verbose mode returns the same full item JSON the tool returns today, plus the same existing normalized pagination metadata.

`bobbit_orchestrate` and `bobbit_admin` currently have no `PageSpec` operations and do not expose `limit`. Their `verbose` flag selects full versus compact success responses, but limit gating is a documented no-op (`pageable: false`). If a future operation adds a `PageSpec`, the shared dispatch automatically activates the guard without operation-specific code.

The `verbose` parameter is tool-layer only. Never forward it as a gateway query/body field.

## 6. `read_session`: superseding agent boundary and REST compatibility

### 6.1 Agent-bound enforcement

The original builtin extension still calls
`contextHeavyLimitError("read_session", params, true)` before its gateway
request. Bound Session Diagnostics added defense in depth because a server,
project, or Marketplace override can replace that handler:

1. A gateway-owned immutable pre-handler guard rejects `verbose`,
   `include_tool_results`, or the compatibility alias `includeToolResults` when
   true unless `limit` is an explicitly supplied numeric integer from 1 through
   10.
2. Once `x-bobbit-session-id` resolves to a real caller session, the transcript
   route repeats that check before transcript I/O.
3. The reader selects its agent projection: canonical Pi/Anthropic calls and
   results, bounded result handles/excerpts, provider-field scrubbing, work
   admission, and whole-response fitting.
4. A final immutable Pi result boundary keeps the tool return, lifecycle event,
   AgentSession state, and persisted JSONL row within the production 50 KiB
   ceiling.

A heavy request that passes the small-page guard therefore does **not** proceed
unchanged. `include_tool_results: true` adds only bounded, self-describing
excerpts; it never restores raw provider blocks or an unbounded result body.
`verbose` adds bounded semantic detail but cannot restore opaque provider replay
metadata. Prefer a compact page, then one targeted `result_handle` slice if its
metadata is insufficient.

Omitted/false `include_tool_results` remains the agent default, ordinary compact
reads retain the default `limit` of 20, and filtering does not waive the
explicit heavy-read limit. See [Bounded session diagnostics](../read-session.md)
for result slice parameters, continuations, work limits, and structured errors.

### 6.2 Ordinary direct REST remains compatible

The route name alone does not select agent policy. The
`GET /api/sessions/:id/transcript` route uses the bounded branch only when the
caller header resolves to a real session. An absent or unknown caller header
stays on the ordinary direct REST/UI branch; omitting result-inclusion flags
there retains legacy result inclusion, projection, author objects, and the
existing 200-message validation cap.

The server route and transcript reader must enforce safety for the authenticated
**agent-bound branch** while preserving the ordinary direct branch. In
particular:

- only agent-bound requests get the 10-message heavy guard, canonical result
  handles/slices, work admission, and complete Pi lifecycle response budget;
- direct REST/UI keeps its legacy response projection and result defaults;
- both branches use the common safe RE2 matching engine, so invalid or
  unsupported patterns return `invalid_regex` rather than entering a
  backtracking engine;
- the before-compaction transcript route is unaffected; and
- the agent guard is context safety, not an authorization boundary intended to
  prevent an authorized operator from using ordinary direct REST.

## 7. Tool schemas and documentation

### Bobbit YAML and TypeBox

Update all three TypeBox schemas in `defaults/tools/bobbit/extension.ts` with:

```ts
verbose: Type.Optional(Type.Boolean({
  description: "Full gateway JSON; default compact. Paged operations require explicit limit <= 10.",
}))
```

For orchestrate/admin, use wording that the limit condition applies only to paged operations so their current non-paged calls are not misleading.

Add `verbose?` to `params:` in:

- `defaults/tools/bobbit/bobbit_read.yaml`;
- `defaults/tools/bobbit/bobbit_orchestrate.yaml`;
- `defaults/tools/bobbit/bobbit_admin.yaml`.

Their `docs`/`detail_docs` must state compact is the default, `verbose: true` restores full successful gateway JSON, paged verbose reads require an explicit limit of at most 10, and large reads should be fetched in small batches with attention to token use. Replace the now-incorrect `bobbit_read` statement that non-list reads are unchanged. Document that cost payloads remain unchanged and orchestrate/admin currently have no paged operations.

### `read_session` YAML and prompt guidance

The original tool-description work was later superseded. Current
`read_session` YAML and prompt guidance must say:

- every heavy spelling requires an explicit numeric integer `limit` from 1
  through 10, even though ordinary compact reads default to 20;
- begin with a compact tail or regex page and avoid overlapping windows;
- `include_tool_results` returns bounded, self-describing excerpts rather than
  raw result bodies; and
- retrieve additional content only through a targeted result handle and its
  returned cursor.

Keep descriptions concise. Run `tests2/core/tool-description-budget.test.ts`; do not expand the short registered tool descriptions or operation-union descriptions unnecessarily. Put detailed explanation in `detail_docs`, not the hot tool description.

No REST API documentation change is required because the REST contract is intentionally unchanged. The design and tool docs should explicitly call this an agent-tool policy to prevent a later implementation from moving it server-side.

## 8. Verification plan

### 8.1 Bobbit projection tests

Add `tests2/core/bobbit-tool-verbosity.test.ts` using the existing `helpers/bobbit-harness.ts`.

Cover:

1. `list_goals` defaults compact: preserves goal ID/title/state/project/timestamps and pagination; truncates spec with the exact marker; removes workflow snapshot, paths, and universal drop fields.
2. `get_goal` follows the same profile and derives/preserves `workflowId` without emitting `workflow`.
3. `list_sessions` preserves the three error-turn diagnostics and identity/role fields while removing `cwd`, model/UI bookkeeping, and legacy assistant booleans.
4. `search` preserves ID/type/title/score and truncates snippet.
5. `list_tasks` and `list_gates` preserve action fields and pagination while removing `verify`/output bodies and truncating prose.
6. A compact response containing `error` and `code` retains both, and normalized pagination retains `total`, `hasMore`, and next offset/cursor.
7. `goal_cost` and `session_cost` remain byte-for-byte structurally equal.
8. `verbose: true, limit: 10` on a paged read returns full fixture fields, including full spec/workflow, while retaining pagination.
9. Compact and verbose behavior is exercised for `bobbit_orchestrate` and `bobbit_admin`: compact mutation responses project/truncate; `verbose: true` is allowed without `limit` because they have no `PageSpec` and returns the full fixture.
10. Map drift: each tier's projection keys exactly equal its exported operation catalogue.

Existing pagination, archive-filtering, and error tests must continue passing. Fixtures with opt-in `archivedSessions`/`archivedDelegates` should assert those auxiliary rows are compactly projected, not accidentally discarded or returned full.

### 8.2 Heavy-flag guard tests

For `bobbit_read`:

- `verbose: true` with missing limit rejects with `isError`, structured `{ error, code }`, no fetch, flag name, cap 10, and all four guidance concepts;
- `verbose: true, limit: 11` rejects identically;
- `verbose: true, limit: 10` succeeds and fetches;
- `verbose: false` keeps normal default paging;
- `verbose: true` on a non-paged read succeeds without a limit.

For `read_session`, extend `tests2/core/read-session-extension.test.ts`:

- each heavy flag independently rejects without a limit and above 10;
- both together name both flags in deterministic schema order;
- each succeeds at limit 10 and forwards the expected query parameters;
- rejected calls do not call fetch;
- the error code and canonical guidance phrases are asserted; and
- the existing default `include_tool_results=0` test remains unchanged.

Do not alter `tests2/integration/transcript-api.test.ts` expectations except, optionally, add an explicit assertion that direct REST still accepts `verbose=true&include_tool_results=true&limit=20`. That protects the compatibility boundary.

### 8.3 Registration and commands

Register the new native core test in `tests2/tests-map.json` under `v2Native`; editing an existing mapped test needs no new entry. Run:

```bash
npx vitest run --project core tests2/core/bobbit-tool-verbosity.test.ts tests2/core/read-session-extension.test.ts tests2/core/bobbit-tool-pagination.test.ts tests2/core/bobbit-tool-archive-filtering.test.ts tests2/core/bobbit-tool-errors.test.ts
npx vitest run --project core tests2/core/tool-description-budget.test.ts
npm run check
```

The full unit gate should follow before merge.

## 9. Risks and mitigations

### Projection silently removes a needed field

Allowlist projections are intentionally opinionated. Universal identity/state/error/paging/recency fields and the explicit domain action fields mitigate this. The truncation marker tells the agent how to recover. Full data remains available through a bounded `verbose` follow-up, and explicit detail operations (`get_goal`, `get_workflow`, `get_task`, `list_gates`) remain usable.

### Projection and paging interfere

Projecting before pagination could remove collection paths or REST page signals. The fixed order—post-process, page, then project—avoids this. Tests pin IDs, totals, `hasMore`, and next tokens.

### Full workflow snapshots leak through alternate response shapes

The goal/session profiles remove `workflow` both at the entity root and in their list/archival collections. Mutation operations returning goal/session entities reuse the same profiles. Tests include direct, list, and mutation fixtures. Generic projection additionally recognizes nested goal/session-shaped records before recursively sanitizing them.

### A newly added operation bypasses compact policy

There is no permissive map fallback. Projection-map keys are compared with `BOBBIT_OPERATIONS`; adding an operation requires choosing a profile. Future `PageSpec` additions automatically activate the heavy guard through shared dispatch.

### Guard is accidentally applied after fetch or after clamping

Tests assert zero fetches on rejection. Guarding before `buildPath`/`api` and validating raw `params.limit` prevents the existing paging normalizer from turning an unsafe request into a silent success.

### Inconsistent error text between tool families

Both extensions import the same flags, cap, code, template, and formatter from `_shared/context-heavy-guard.ts`. Tests compare structured code and canonical phrases for both families.

### REST/UI compatibility regression

The initial extension guard remains, but authenticated agent-bound requests now
repeat enforcement in the route and use the reader's bounded projection. Tests
must pin both sides of the policy selector: a real caller-session identity gets
agent guards before transcript I/O, while ordinary direct REST retains its
legacy result-inclusion default and projection. See
[Bounded session diagnostics — Direct REST and UI compatibility](../read-session.md#direct-rest-and-ui-compatibility).

### Tool-description budget growth

Keep registered descriptions short and move details to YAML `detail_docs`. Run the existing budget test. The new `verbose` schema descriptions should replace redundant prose rather than duplicating the full guidance message.

### Unicode truncation edge cases

The 200-unit slice is deterministic and JSON-safe, though it can split a surrogate pair. If implementation prefers code-point safety, use `Array.from(text).slice(0, 200).join("")`; tests should define the chosen behavior. Code-point slicing is recommended so previews never contain an unmatched surrogate.

## 10. Non-goals and superseded scope

For the still-current `bobbit_*` projection, gateway REST response shapes and
paging defaults remain unchanged, and no paging is added to non-paged
mutation/admin operations.

The old `read_session` non-goals are superseded: its agent-bound branch now
intentionally changes transcript parsing/projection, result retrieval, reader
work admission, rendering data, and lifecycle response fitting. It still does
not change transcript storage or the ordinary direct REST/UI projection, and it
does not try to prevent an authorized caller from using that direct surface.
Neither design hardcodes particular goals, sessions, projects, or response
fixtures.
