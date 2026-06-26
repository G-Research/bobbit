# Maintenance

Bobbit's Maintenance settings collect safe, explicit cleanup tools for resources that can outlive the session or project that created them. These actions are intentionally preview-first: the UI scans, explains what it found, and only then enables cleanup.

The Maintenance tab is user-facing, but the same actions are exposed through `/api/maintenance/*` routes for operators and tests. Cleanup endpoints return structured counts and per-item results so callers can distinguish cleaned, skipped, already-cleaned, and failed work.

## Archived Session Worktrees

**Settings → Maintenance → Archived Session Worktrees** finds git worktrees that are still owned by archived session records. It solves a different problem from **Orphaned Worktrees**:

- **Orphaned Worktrees** are branch-centric git entries with no owning live session reference.
- **Archived Session Worktrees** are still referenced by archived session metadata, but the user may want to reclaim the checkout and branch while keeping the archive.

This cleanup removes only git worktrees and, when safe, their corresponding branches. It does **not** delete archived session rows, transcripts, proposals, prompt records, search visibility, or archive list entries.

### Scan behavior

Click **Scan** to call `GET /api/maintenance/archived-session-worktrees`. The scan groups results by archived session and shows:

- session title and id;
- project and repo/component;
- branch;
- worktree path;
- status and explanatory detail.

Rows can have three statuses:

| Status | Meaning | UI behavior |
|---|---|---|
| `removable` | The worktree path or git worktree metadata still exists, and no guard references it. | Checked by default and eligible for cleanup. |
| `skipped` | The row is not safe or actionable, with `reason`/`detail` explaining why. | Disabled. |
| `already-cleaned` | The worktree path and git worktree metadata are already gone. A remaining branch alone does not make the row actionable. | Hidden by default; diagnostics may show it disabled. |

The default scan omits sessions whose rows are all `already-cleaned`. Add `?includeAlreadyCleaned=1` to the API request for diagnostics.

### Cleanup behavior

The UI posts selected rows to `POST /api/maintenance/cleanup-archived-session-worktrees` as:

```json
{
  "mode": "selected",
  "worktrees": [
    { "sessionId": "archived-session-id", "key": "...", "repo": ".", "path": "/path/to/worktree" }
  ]
}
```

The server re-runs the scan before deleting anything, so stale UI selections cannot bypass safety checks. It cleans only rows that are still `removable` in the fresh scan. One item failure does not abort the rest of the request.

Successful cleanup removes the host git worktree. Branch deletion is best-effort and only happens when the branch is local to the same repo and not referenced by any protected live or durable owner. If branch deletion is blocked, the worktree can still be removed and the result reports `branchDeleted: false`.

### Safety rules

A candidate is skipped rather than removed when any protected owner still references the same worktree path or branch. Guards include:

- non-archived persisted sessions and current runtime sessions;
- persisted goals, including archived goals that still exist in the goal store;
- team entries and team agents;
- staff records, including paused staff;
- multi-repo sibling `repoWorktrees` entries;
- delegate/shared-worktree records without an independent worktree;
- container-internal sandbox paths such as `/workspace` or `/workspace-wt`.

Multi-repo archived sessions are evaluated per repo item. One component worktree may be removable while another is skipped.

### What is preserved

Archived-session worktree cleanup never purges the archived session. After cleanup, the archived session can still appear in archive/search surfaces and its transcript/proposals remain available. The archived metadata may still display the historical worktree path, but that path can now point to a removed directory.

## REST API

See [REST API — Maintenance](rest-api.md#maintenance) for request and response shapes.

Key routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/maintenance/archived-session-worktrees` | Preview archived-session worktree candidates. |
| `POST` | `/api/maintenance/cleanup-archived-session-worktrees` | Clean selected or all currently removable archived-session worktrees. |
| `GET` | `/api/maintenance/orphaned-worktrees` | Preview git worktrees not owned by live session references. |
| `POST` | `/api/maintenance/cleanup-worktrees` | Clean selected orphaned worktrees. |
| `GET` | `/api/maintenance/orphaned-sessions` | Preview non-interactive session records that can be terminated. |
| `POST` | `/api/maintenance/cleanup-sessions` | Terminate selected orphaned sessions. |
| `GET` | `/api/maintenance/expired-archives` | Preview expired archive purge counts. |
| `POST` | `/api/maintenance/purge-archives` | Purge expired archives. |
| `GET` | `/api/maintenance/orphaned-index-rows` | Preview search index rows whose parent records are gone. |
| `POST` | `/api/maintenance/cleanup-index-rows` | Delete orphaned search index rows. |
