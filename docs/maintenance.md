# Maintenance

Bobbit's Maintenance settings collect safe, explicit cleanup tools for resources that can outlive the session or project that created them. These actions are intentionally preview-first: the UI scans, explains what it found, and only then enables cleanup.

The Maintenance tab is user-facing, but the same actions are exposed through REST routes for operators and tests. Cleanup endpoints return structured counts and per-item results so callers can distinguish cleaned, skipped, already-cleaned, and failed work.

## Agent Directory

**Settings → Maintenance → Agent Directory** controls where Bobbit stores agent transcripts, host credentials, model metadata, Google Code Assist cache data, and staged binaries. It is restart-gated: the current process keeps using the startup active directory, while Settings saves only the next-start directory.

The card shows the active path, startup source, default path, persisted/pending path, effective next-start path, restart guidance, and environment override impact. It also exposes a copy-only migration flow from the active/historical directory to the pending directory. See [Configurable agent directory](configurable-agent-directory.md) and [REST API — Agent directory](rest-api.md#agent-directory).

## Worktree Cleanup

**Settings → Maintenance → Worktree Cleanup** is the canonical surface for Bobbit-created host worktrees that outlive the active record that originally owned them. It replaces the older separate **Orphaned Worktrees** and **Archived Session Worktrees** cards while keeping their REST routes as compatibility adapters.

The scanner builds one inventory from Bobbit state, git metadata, filesystem worktree-root directories, and the in-memory worktree pool. It covers live and archived sessions, goals, teams, delegates/child sessions, staff worktrees, pool entries, `git worktree list --porcelain`, and directories under each visible project's resolved worktree root. Multi-repo projects are evaluated per component repo, and configured `worktree_root` values are resolved through the same helper used for worktree creation.

### Command-runner isolation

Maintenance worktree scans and cleanup use the gateway/request-scoped `CommandRunner` resolved when the gateway is constructed. This keeps concurrent in-process gateways isolated: each gateway's injected command fixture supplies only its own Git-probe results, so one gateway cannot affect another's worktree classification or cleanup decisions.

The module default runner is an outer-construction fallback only. Request handling must use its resolved runner rather than shared module state, preserving the gateway's dependency boundary for both production and injected environments.

### Actionable-first scan

Click **Scan** or **Rescan** to call `GET /api/maintenance/worktrees`. The default response includes safe candidates plus troubleshooting rows; the UI shows safe candidates first and hides protected or diagnostic rows behind a disclosure.

Summary chips map to server dispositions:

| Label | Meaning | User action |
|---|---|---|
| **Ready to clean** | Fresh server-classified candidates that Bobbit may remove now. | Use **Clean all safe candidates** or select rows. |
| **Protected/in use** | Worktrees or branches still referenced by live/durable Bobbit records. | Do not clean from Maintenance. Inspect only for troubleshooting. |
| **Already cleaned** | Archived-owned records whose worktree path and git metadata are already gone. | No action needed. |
| **Needs attention** | Pool entries, filesystem-only directories, stale paths, or other rows that are not automatic cleanup targets. | Inspect and resolve manually if needed. |

Each row includes provenance: project, component/repo, repo path, worktree root, path, branch, source list, owning record ids, classification, reason/detail text, and cleanup booleans.

### Cleanup flows

**Clean all safe candidates** sends the canonical cleanup request:

```json
{ "mode": "all-safe" }
```

**Clean selected** sends item ids from the latest scan:

```json
{ "mode": "selected", "itemIds": ["worktree-item-id"] }
```

Cleanup always re-runs the unified inventory immediately before deleting anything. The server deletes only candidates that are still fresh, actionable, and selected by the request. Stale selections, protected rows, already-cleaned rows, and invalid ids are reported as skipped or already-cleaned; they do not widen the deletion set.

Canonical cleanup responses include aggregate counts and per-item results with `status`, `reason`, `detail`, `worktreeRemoved`, and `branchDeleted`. Branch deletion is best-effort and narrower than worktree deletion. Bobbit deletes a branch only when no live or durable Bobbit record still references it; a successful worktree removal can therefore report `branchDeleted: false`.

### Safety guarantees

The server is the source of truth for cleanup eligibility. UI selection cannot bypass guards.

Cleanup protects worktrees and branches referenced by:

- runtime sessions and persisted live sessions;
- archived session records when they block branch deletion for another row;
- persisted goals;
- teams and team agents;
- delegates and child sessions, including shared delegate worktrees;
- staff records, including paused staff;
- in-memory pool entries;
- multi-repo sibling component worktrees.

Additional guards:

- primary repository worktrees are never cleanup targets;
- sandbox/container-internal paths are not host cleanup targets;
- every Git-metadata worktree without an exact archived-session repository, path, and non-empty branch match is ownership-unverified **Needs attention** work;
- branch-only leftovers for archived sessions are treated as already cleaned for worktree cleanup;
- non-object canonical cleanup bodies are rejected instead of being treated as a legacy orphan cleanup request.

Pool-shaped leftovers discovered at startup are reported diagnostically rather than adopted or automatically cleaned. A pool may re-adopt only entries authorized by its exact durable record in `state/worktree-pools.json` and revalidated against Git; shape alone is never authority.

### Startup and graceful shutdown

Boot scanning is non-destructive for discovered worktrees. Branch prefixes, worktree-root placement, and Git metadata can explain a diagnostic row, but cannot authorize repair, cleanup, or pool adoption. Re-adoption additionally requires the pool's v1 durable project/repository/path/branch record. Single-repository entries must match `git worktree list` exactly. Multi-repository entries are all-or-nothing: every unique member must still match the current component repository, expected container-relative path, and that repository's exact Git path and branch. Any live persisted or runtime session reference excludes the entry. Invalid, malformed, future-version, mismatched, or unrecorded entries are left untouched and their adoption authority is dropped.

During orderly gateway shutdown, Bobbit fences new work, waits for boot initialization, stops every pool with a 15-second bound, and flushes the durable record. It does not drain ready entries; the next start can revalidate and reuse them. Successful claims already left both the pool and its durable record and survive under session or goal ownership. A stop or record-flush failure is logged without blocking later teardown.

`WorktreePool.drain()` remains the explicit project-deletion path. It revokes durable pool ownership before locally deleting only entries held by that pool; tracked claim-failure and drain cleanup never performs remote Git operations. Crashes and forced exits may leave unrecorded or unverifiable worktrees, which remain non-actionable **Needs attention** diagnostics.

### Legacy compatibility

<a id="orphaned-worktrees"></a>
Legacy orphan discovery and cleanup retain their compatibility shapes but neither advertise nor remove ownership-unverified worktrees.

Legacy `POST /api/maintenance/cleanup-worktrees` requests without a `mode` are still accepted for orphan cleanup compatibility:

```json
{}
```

```json
{ "worktrees": [{ "path": "/path/to/worktree", "branch": "session/abc123", "repoPath": "/path/to/repo" }] }
```

These compatibility calls re-scan through the unified inventory, exclude ownership-unverified Git worktrees, and skip them without mutation if explicitly selected. Canonical callers should send `mode: "all-safe"` or `mode: "selected"`. If `itemIds` is present, `mode` is required.

<a id="archived-session-worktrees"></a>
`GET /api/maintenance/archived-session-worktrees` still returns the archived-session grouped response with `sessions`, flattened `items`, `groups`, `selectionPresets`, and additive `counts`. It is backed by the same unified inventory and preserves the older archived-session UI/test contract during migration.

`POST /api/maintenance/cleanup-archived-session-worktrees` still accepts its legacy modes (`all`, `selected`, `category`, and `preset`). These requests are compatibility filters over the fresh unified scan and preserve archived session rows, transcripts, proposals, prompt records, search records, and archive visibility.

## Orphaned non-interactive sessions

Verification reviewer and QA sessions are non-interactive: users cannot safely prompt them directly, and `verification_result` only matters while the verification harness has a pending resolver for that session. If a live non-interactive session is no longer referenced by active verification state, Bobbit treats it as an orphaned session.

Gateway boot surfaces these orphans deterministically before the verification harness enters any long reviewer-resume wait. The maintenance scan is still explicit and preview-first: `GET /api/maintenance/orphaned-sessions` lists candidates, and `POST /api/maintenance/cleanup-sessions` terminates only sessions that are still orphaned at cleanup time.

## REST API

See [REST API — Maintenance](rest-api.md#maintenance) and [REST API — Agent directory](rest-api.md#agent-directory) for request and response shapes.

Key routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agent-dir` | Inspect active and next-start agent-directory state. |
| `POST` | `/api/agent-dir/validate` | Validate/probe an agent-directory target. |
| `PUT` | `/api/agent-dir/pending` | Save or clear the next-start agent directory. |
| `POST` | `/api/agent-dir/migrate` | Copy allowlisted data to the pending directory. |
| `GET` | `/api/maintenance/worktrees` | Preview the canonical unified worktree inventory. |
| `POST` | `/api/maintenance/cleanup-worktrees` | Clean all safe or selected canonical worktree inventory items; also accepts legacy orphan cleanup bodies. |
| `GET` | `/api/maintenance/orphaned-worktrees` | Legacy `{ worktrees }` compatibility shape; excludes ownership-unverified Git worktrees. Inspect those through the canonical troubleshooting inventory. |
| `GET` | `/api/maintenance/archived-session-worktrees` | Legacy compatibility view of archived-session worktree candidates and UX grouping data. |
| `POST` | `/api/maintenance/cleanup-archived-session-worktrees` | Legacy compatibility cleanup for archived-session worktree candidates. |
| `GET` | `/api/maintenance/orphaned-sessions` | Preview non-interactive session records that can be terminated. |
| `POST` | `/api/maintenance/cleanup-sessions` | Terminate selected orphaned sessions. |
| `GET` | `/api/maintenance/expired-archives` | Preview expired archive purge counts. |
| `POST` | `/api/maintenance/purge-archives` | Purge expired archives. |
| `GET` | `/api/maintenance/orphaned-index-rows` | Preview search index rows whose parent records are gone. |
| `POST` | `/api/maintenance/cleanup-index-rows` | Delete orphaned search index rows. |

The legacy orphaned and archived-session routes are adapters over the unified inventory. Clients should prefer `GET /api/maintenance/worktrees` plus canonical `POST /api/maintenance/cleanup-worktrees` for new integrations, and should tolerate new classifications, reasons, groups, and sources over time.
