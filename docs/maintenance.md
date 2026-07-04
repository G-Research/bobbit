# Maintenance

Bobbit's Maintenance settings collect safe, explicit cleanup tools for resources that can outlive the session or project that created them. These actions are intentionally preview-first: the UI scans, explains what it found, and only then enables cleanup.

The Maintenance tab is user-facing, but the same actions are exposed through REST routes for operators and tests. Cleanup endpoints return structured counts and per-item results so callers can distinguish cleaned, skipped, already-cleaned, and failed work.

## Agent Directory

**Settings → Maintenance → Agent Directory** controls where Bobbit stores agent transcripts, host credentials, model metadata, Google Code Assist cache data, and staged binaries. It is restart-gated: the current process keeps using the startup active directory, while Settings saves only the next-start directory.

The card shows the active path, startup source, default path, persisted/pending path, effective next-start path, restart guidance, and environment override impact. It also exposes a copy-only migration flow from the active/historical directory to the pending directory. See [Configurable agent directory](configurable-agent-directory.md) and [REST API — Agent directory](rest-api.md#agent-directory).

## Worktree Cleanup

**Settings → Maintenance → Worktree Cleanup** is the canonical surface for Bobbit-created host worktrees that outlive the active record that originally owned them. It replaces the older separate **Orphaned Worktrees** and **Archived Session Worktrees** cards while keeping their REST routes as compatibility adapters.

The scanner builds one inventory from Bobbit state, git metadata, filesystem worktree-root directories, and the in-memory worktree pool. It covers live and archived sessions, goals, teams, delegates/child sessions, staff worktrees, pool entries, `git worktree list --porcelain`, and directories under each visible project's resolved worktree root. Multi-repo projects are evaluated per component repo, and configured `worktree_root` values are resolved through the same helper used for worktree creation.

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
- filesystem-only directories under a worktree root default to **Needs attention** unless they also satisfy strict Bobbit-owned git worktree rules;
- branch-only leftovers for archived sessions are treated as already cleaned for worktree cleanup;
- non-object canonical cleanup bodies are rejected instead of being treated as a legacy orphan cleanup request.

The in-memory worktree pool uses the same resolved worktree-root and pool-branch classification helpers when reclaiming previous pool entries. Pool reclaim is conservative: it only reclaims Bobbit pool branches with git metadata, skips active paths, and does not delete arbitrary directories.

### Legacy compatibility

<a id="orphaned-worktrees"></a>
`GET /api/maintenance/orphaned-worktrees` still returns the legacy `{ worktrees }` shape for unowned Bobbit `session/*` git worktrees. It is now a filtered view of the unified inventory.

Legacy `POST /api/maintenance/cleanup-worktrees` requests without a `mode` are still accepted for orphan cleanup compatibility:

```json
{}
```

```json
{ "worktrees": [{ "path": "/path/to/worktree", "branch": "session/abc123", "repoPath": "/path/to/repo" }] }
```

These compatibility calls also re-scan through the unified inventory and clean only safe orphan candidates. Canonical callers should send `mode: "all-safe"` or `mode: "selected"`. If `itemIds` is present, `mode` is required.

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
| `GET` | `/api/maintenance/orphaned-worktrees` | Legacy compatibility view of safe unowned Bobbit `session/*` git worktrees. |
| `GET` | `/api/maintenance/archived-session-worktrees` | Legacy compatibility view of archived-session worktree candidates and UX grouping data. |
| `POST` | `/api/maintenance/cleanup-archived-session-worktrees` | Legacy compatibility cleanup for archived-session worktree candidates. |
| `GET` | `/api/maintenance/orphaned-sessions` | Preview non-interactive session records that can be terminated. |
| `POST` | `/api/maintenance/cleanup-sessions` | Terminate selected orphaned sessions. |
| `GET` | `/api/maintenance/expired-archives` | Preview expired archive purge counts. |
| `POST` | `/api/maintenance/purge-archives` | Purge expired archives. |
| `GET` | `/api/maintenance/orphaned-index-rows` | Preview search index rows whose parent records are gone. |
| `POST` | `/api/maintenance/cleanup-index-rows` | Delete orphaned search index rows. |

The legacy orphaned and archived-session routes are adapters over the unified inventory. Clients should prefer `GET /api/maintenance/worktrees` plus canonical `POST /api/maintenance/cleanup-worktrees` for new integrations, and should tolerate new classifications, reasons, groups, and sources over time.
