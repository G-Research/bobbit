# Design: `bobbit_read` pagination

Status: **implemented** · Goal: Page Bobbit Tools · Author: coder-861a

## 1. Problem

`defaults/tools/bobbit/extension.ts` previously returned gateway JSON verbatim. For list-style `bobbit_read` operations this could emit unbounded arrays into the agent context, especially sessions, goals, tools, MCP servers, and maintenance probes. The implemented fix makes tool calls bounded by default while keeping REST/UI behaviour backward-compatible unless a caller explicitly opts into paging.

## 1.1 Implemented behaviour

- `bobbit_read` list operations default to `limit=50`, `offset=0`, and clamp list limits to `200`; `search` defaults to `20` and clamps to `100`.
- The tool forwards REST paging only for `list_sessions`, `list_goals`, and `search`. These are the high-volume endpoints where the gateway returns page fields such as `total`, `hasMore`, `nextOffset`, or `nextCursor`.
- When a gateway response already includes REST paging fields or a `pagination` object, the tool adds normalized `pagination` metadata and marks `pagedBy: "rest"`; it does **not** re-slice the returned array. This matters for responses such as `include=archived` sessions, where the REST payload can include live sessions plus an archived page.
- Other list-style operations use tool-side fallback paging after the endpoint has applied semantic filters (`projectId`, `goalId`, `view`, `q`, `include`, or `archived` as applicable). Fallback responses are marked `pagedBy: "tool"`.
- Tool-side fallback preserves ancillary fields such as `generation`, `archivedDelegates`, `archivedSessions`, diagnostics, summary counts, and maintenance probe counts.
- Cursor inputs use `cursor` as the generic alias and `after` as the gateway query name for archived session/goal paths. Cursor mode wins over offset mode only when the operation is cursor-backed and a cursor value is supplied.

## 2. Scope

In scope:

- Add shared paging params to `bobbit_read`: `limit`, `offset`, and `after`/`cursor` for cursor-backed endpoints.
- Return page metadata for every paged list-style `bobbit_read` operation.
- Preserve semantic filters and forward missing supported filters.
- Add REST-level pagination where it is useful and safe; otherwise page the tool response after fetch.
- Update `bobbit_read` YAML/schema docs and core tests.

Out of scope:

- Changing non-list read operations (`get_*`, costs, git status, health, connection info).
- UI migration to paged list endpoints. UI callers remain unpaged unless they pass paging params.
- Replacing `read_session`; transcript pagination stays in the dedicated tool.

## 3. Implementation surface

### Tool extension

- `defaults/tools/bobbit/extension.ts`
  - Extend `Params` use with `limit`, `offset`, `after`, `cursor`.
  - Extend `OpSpec` with pagination metadata:
    - `page?: PageSpec`
    - optional `semanticQuery?: string[]` if the implementation chooses a declarative query builder.
  - Add helpers near `withQuery()`:
    - `normalizePaging(params, mode?)`
    - `appendPagingQuery(entries, params, spec)`
    - `pageResult(operation, data, params, spec)`
    - `sliceByPath(data, path, page)`
  - Update `READ_OPS` paths to forward `projectId` for `list_goals`, `list_staff`, `list_mcp_servers`, `list_roles`, and paging params where REST supports or will support them.
  - Change `dispatch()` so `bobbit_read` list operations return normalized paged payloads instead of raw JSON. Keep orchestrate/admin raw.
  - Update registered `bobbit_read` parameter schema descriptions for shared paging.

### Tool manifest

- `defaults/tools/bobbit/bobbit_read.yaml`
  - Update `params` to include `limit?`, `offset?`, `after?`, `cursor?`, `type?`, `archived?`, `include?`.
  - Replace “returns JSON verbatim” for list operations with the bounded page contract.
  - Document default page size, max page size, metadata, and semantic filters per operation.

### Gateway REST endpoints

REST-level changes are optional and must not change default responses for callers that omit paging params. The implemented `bobbit_read` tool forwards paging only where it relies on REST-paged output; otherwise it uses tool-side fallback after semantic filters have run.

- `src/server/server.ts::handleApiRoute()`
  - `GET /api/sessions` block: add offset pagination for live/default sessions when `limit` or `offset` is present; keep existing archived `limit + after` path, and optionally accept `offset` for archived too.
  - `GET /api/goals` block: live goals currently support `projectId` only; add optional `limit`/`offset` paging after `listGoalsAcrossProjects({ projectId })`. Existing archived path already supports `limit + after`.
  - `GET /api/projects`: add optional `limit`/`offset` around `listProjectsForApi()`.
  - `GET /api/goals/:goalId/tasks`: add optional `limit`/`offset` after `view=summary`/full projection is chosen.
  - `GET /api/goals/:goalId/gates`: add optional `limit`/`offset` after `view=summary`/full projection is chosen.
  - Optional, low-risk forwards: `GET /api/staff`, `GET /api/mcp-servers`, `GET /api/workflows`, `GET /api/roles`, `GET /api/tools` can accept paging, but tool-side fallback is sufficient if UI risk or route complexity is high.
  - Maintenance probes: add paging to probes that already materialize arrays (`orphaned-worktrees`, `orphaned-sessions`, `orphaned-index-rows` sample) only if straightforward; otherwise keep REST as-is and page in the tool.

## 4. Paging contract

### Defaults

- Default `bobbit_read` list page size: **50**.
- Max page size: **200** for list-style operations.
- `search` keeps the existing REST default/max (`20` default, `100` max) unless the caller passes a `limit`; normalize metadata around its existing response.
- `offset` defaults to `0`.
- Cursor params are accepted as aliases:
  - `cursor` is a generic alias.
  - `after` is forwarded to existing archived session/goal REST paths.

### Response shape

For all list-style `bobbit_read` operations, return the original response fields plus a `pagination` object:

```ts
interface PageMetadata {
  limit: number;
  offset?: number;
  total?: number;
  hasMore: boolean;
  nextOffset?: number;
  cursor?: string | number;
  nextCursor?: string | number;
  mode: "offset" | "cursor";
  itemKey: string;
  pagedBy: "rest" | "tool";
}
```

Rules:

- Preserve the endpoint’s top-level shape and primary array key (`sessions`, `goals`, `projects`, `tools`, etc.).
- Add `pagination` at top level.
- If REST already returns `total`, `hasMore`, or `nextCursor`, mirror those into `pagination` and leave the original fields intact for compatibility.
- For tool-side fallback, compute:
  - `total = fullArray.length`
  - `items = fullArray.slice(offset, offset + limit)`
  - `hasMore = offset + items.length < total`
  - `nextOffset = hasMore ? offset + limit : undefined`
- For cursor-backed fallback, prefer REST cursor metadata; do not invent stable cursors from unordered arrays.

## 5. Helper shape

Add small, pure helpers in `defaults/tools/bobbit/extension.ts`.

```ts
type PageMode = "offset" | "cursor";

type PageSpec = {
  itemKey: string;                 // e.g. "sessions"
  defaultLimit?: number;           // default 50; search may set 20
  maxLimit?: number;               // default 200; search may set 100
  mode?: PageMode;                 // default "offset"
  restPaging?: boolean;            // true when buildPath forwards paging
  cursorParam?: "after" | "cursor";
  preserveKeys?: string[];         // ancillary fields to keep untouched
};

type NormalizedPage = {
  limit: number;
  offset: number;
  cursor?: string | number;
};
```

Implementation notes:

- `normalizePaging()` clamps invalid, missing, or negative values.
- `appendPagingQuery()` appends `limit`, `offset`, and cursor params only for operations with `restPaging: true`.
- `pageResult()` handles three cases:
  1. REST-paged response with metadata: only add/normalize `pagination`.
  2. REST-paged response without full metadata: infer from returned item count when possible.
  3. Tool fallback: slice the primary array and add metadata.
- `dispatch()` can call `pageResult()` only for `bobbit_read` by adding an optional postprocessor parameter:

```ts
async function dispatch(ops: Record<string, OpSpec>, params: Params, opts?: { pageLists?: boolean }) {
  // existing validation/buildPath/api flow
  const data = await api(method, urlPath, body);
  return ok(opts?.pageLists ? pageIfConfigured(params.operation, data, params, spec) : data);
}
```

## 6. Operation-by-operation behaviour

| operation | primary array | semantic filters | paging behaviour |
|---|---:|---|---|
| `list_sessions` | `sessions` | `include`, `q`, `projectId` | Forwards filters plus `limit`; forwards `offset` for offset mode and `after` for archived cursor mode. REST-paged results are not re-sliced. |
| `list_goals` | `goals` | `archived`, `q`, `projectId` | Forwards filters plus `limit`; forwards `offset` for live/offset mode and `after` for archived cursor mode. REST-paged results are not re-sliced. |
| `list_projects` | `projects` or bare array | hidden/system/HQ preference filter inside `listProjectsForApi()` | Tool fallback pages the filtered response and normalizes tool output to `{ projects, pagination }` when needed. |
| `list_workflows` | `workflows` | `projectId` required | Forwards `projectId`; tool fallback pages after workflow resolution. |
| `list_roles` | `roles` | `projectId` config scope | Forwards `projectId`; tool fallback pages after config-scope resolution. |
| `list_tools` | `tools` | `projectId` config scope | Forwards `projectId`; tool fallback pages `tools` and preserves `diagnostics`/`toolDiagnostics`. |
| `list_gates` | `gates` | `goalId`, `view` | Path-scoped by `goalId`; tool fallback pages the selected `view` output and preserves summary fields. |
| `list_tasks` | `tasks` | `goalId`, `view` | Path-scoped by `goalId`; tool fallback pages the selected `view` output. |
| `list_staff` | `staff` | `projectId` supported by REST | Forwards `projectId`; tool fallback pages `staff`. |
| `list_mcp_servers` | bare array | `projectId` supported by REST; `cwd`/`ensure` exist in REST but not schema | Forwards `projectId`; tool fallback normalizes the array to `{ servers, pagination }`. Does not expose `ensure`, because it can initialize managers. |
| `maintenance_inspect` | varies | `probe`, sometimes `projectId` | See §7. Tool fallback pages probes with large arrays/samples; scalar/stat probes return unchanged unless an array key is present. |
| `search` | `results` | `q`, `type`, `limit`, `offset`, `projectId` | Forwards paging. Adds normalized `pagination` from REST results without re-slicing. |

Non-list read operations are unchanged and do not receive pagination metadata.

## 7. Maintenance probe handling

`PROBE_PATHS` currently maps:

- `orphaned_worktrees` → `/api/maintenance/orphaned-worktrees` returns a collection from `worktreeInventory().legacyOrphanedWorktrees()`.
- `orphaned_sessions` → `{ sessions }`.
- `expired_archives` → stats; likely not paged.
- `orphaned_index_rows` → `{ count, sample }` and requires `projectId`.
- `worktrees` → `/api/maintenance/worktrees` (verify route before implementation; if absent, existing operation already errors through REST).
- `archived_session_worktrees` → `/api/maintenance/archived-session-worktrees`.
- `worktree_pool` → `/api/worktree-pool` returns either one status object or `{ pools }`; page `pools` only if it is large by converting entries to a page in a `pools` object plus metadata, otherwise leave unchanged.
- `sandbox_pool` → scalar stats; unchanged.
- `sandbox_status` → scalar status; should forward `projectId` because REST supports it.
- `search_stats` → scalar stats; requires/forwards `projectId`.

Probe page specs should be keyed by probe, not just operation:

```ts
const MAINTENANCE_PAGE_SPECS: Record<string, PageSpec | undefined> = {
  orphaned_worktrees: { itemKey: "worktrees" },
  orphaned_sessions: { itemKey: "sessions" },
  orphaned_index_rows: { itemKey: "sample" },
  archived_session_worktrees: { itemKey: "worktrees" },
};
```

If a probe returns a bare array, normalize it to `{ items: [...], pagination: { itemKey: "items", ... } }` unless a better key is known. Preserve counts such as `count` from `orphaned_index_rows`; for a paged sample, `count` remains total orphan count reported by the REST endpoint and `pagination.total` should use that when available.

## 8. Semantic filter forwarding audit

- `projectId`
  - Add to `list_goals` query.
  - Add to `list_roles` query because `/api/roles` requires explicit config scope.
  - Add to `list_staff` query because `/api/staff` already supports it.
  - Add to `list_mcp_servers` query because `/api/mcp-servers` already supports it.
  - Add to `maintenance_inspect` probes whose REST supports/requires it: `worktree_pool`, `sandbox_status`, `orphaned_index_rows`, `search_stats`; keep existing for `orphaned_index_rows`/`search_stats`.
- `goalId`
  - `list_gates` and `list_tasks` remain path-scoped by `goalId`; apply paging only after this scope.
- `q`
  - `list_sessions` uses `q` only for archived sessions today; keep this behaviour and document it.
  - `list_goals` uses `q` only for archived goals today; keep this unless a separate live-goal search is intentionally added.
  - `search` keeps `q` required.
- `type`
  - Only `search` uses `type`; validate/forward as today.
- `include`
  - Only `list_sessions`; `include=archived` includes live sessions plus archived page/delegates. Preserve archived delegate enrichment.
- `archived`
  - Only `list_goals`; `archived=true` selects archived path.
- `view`
  - Only `list_gates`/`list_tasks`; compute summary/full projection first, then page the displayed list.

## 9. REST vs tool fallback policy

Use REST paging when:

- The endpoint already supports paging and the tool forwards page params (`search`, `list_sessions`, `list_goals`).
- The endpoint returns page fields (`total`, `hasMore`, `nextOffset`, `nextCursor`, or `pagination`); the tool treats these responses as already paged and does not re-slice them.

Use tool fallback when:

- The endpoint is primarily used by UI and changing response shape would be risky.
- The endpoint returns small config lists but can still be noisy in agent context (`roles`, `tools`, `workflows`).
- The endpoint returns a bare array and REST-level shape changes might break consumers (`mcp-servers`, possibly `projects`).
- The implemented `bobbit_read` path does not forward paging for that operation; fallback still happens after forwarded semantic filters are applied.

Backward compatibility rule: REST endpoints must keep their existing response shape when no paging params are present. If REST receives `limit`, `offset`, `after`, or `cursor`, it may return page metadata. The `bobbit_read` tool should always request or apply paging for list operations, so agents get bounded output by default without forcing UI changes.

## 10. Backward compatibility and edge cases

- Existing API consumers that do not pass paging params see current unpaged responses.
- Existing `bobbit_read.search` callers keep working; new metadata is additive.
- Existing `limit`/`offset` params in the `bobbit_read` schema become shared, not search-only.
- Invalid `limit`/`offset` should be clamped, not surfaced as validation errors, matching existing REST style.
- If a caller asks for `limit` larger than max, return the clamped `limit` in metadata.
- Cursor and offset should not both drive the same request. If both are supplied for a cursor operation, cursor wins and metadata uses `mode: "cursor"`.
- Tool-side fallback must preserve ancillary fields (`generation`, `archivedDelegates`, `archivedSessions`, diagnostics, counts, summaries).
- Avoid exposing `cwd`/`ensure` on `list_mcp_servers` in this goal; `ensure=true` has initialization side effects and `bobbit_read` should stay read-only.

## 11. Focused test plan

Update or add core tests only under `tests2/core/` and register any new file in `tests2/tests-map.json` if needed.

- `tests2/core/bobbit-tool-dispatch.test.ts`
  - `list_sessions` default call appends `limit=50&offset=0` or otherwise returns a default page through the postprocessor.
  - `list_sessions` explicit `{ projectId: "p1", limit: 10, offset: 20 }` forwards `projectId`, `limit`, and `offset` together.
  - `list_goals` forwards `projectId` plus paging and preserves `archived`/`q`.
  - `list_staff`, `list_roles`, and `list_mcp_servers` forward `projectId`.
  - Archived goals/sessions forward cursor (`after` or `cursor`) when supplied.
- New or expanded `tests2/core/bobbit-tool-pagination.test.ts`
  - Tool fallback pages a stubbed `{ tools: [..], diagnostics: ... }` response and returns `{ tools: firstPage, diagnostics, pagination }`.
  - Bare-array fallback for `list_mcp_servers` normalizes to a bounded keyed payload.
  - `search` response `{ results, total }` gains correct `pagination.hasMore`/`nextOffset`.
  - Maintenance probe fallback pages `{ sessions: [...] }` and `{ count, sample: [...] }` without losing `count`.
- `tests2/core/bobbit-tool-validation.test.ts`
  - Schema exposes shared `limit`, `offset`, `after`, and `cursor` with non-search descriptions.
- `tests2/core/bobbit-tool-tiers.test.ts`
  - Keep operation catalogue unchanged unless adding no new operations.
  - Add a YAML/detail-doc drift assertion if practical: docs mention shared paging and `projectId` filters for the affected operations.
- REST-focused tests if helpers are extracted/pure:
  - Optional paging helper clamps limits and computes metadata.
  - Live sessions/goals filter by `projectId` before slicing.
  - Task/gate `view=summary` counts remain full-board counts while `gates`/`tasks` array is paged.

Verification commands:

```bash
npm run check
npx vitest run tests2/core/bobbit-tool-dispatch.test.ts tests2/core/bobbit-tool-validation.test.ts tests2/core/bobbit-tool-tiers.test.ts tests2/core/bobbit-tool-pagination.test.ts
```

If no new test file is added, omit it from the Vitest command.
