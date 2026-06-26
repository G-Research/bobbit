# Maintenance

Bobbit's Maintenance settings collect safe, explicit cleanup tools for resources that can outlive the session or project that created them. These actions are intentionally preview-first: the UI scans, explains what it found, and only then enables cleanup.

The Maintenance tab is user-facing, but the same actions are exposed through `/api/maintenance/*` routes for operators and tests. Cleanup endpoints return structured counts and per-item results so callers can distinguish cleaned, skipped, already-cleaned, and failed work.

## Archived Session Worktrees

**Settings → Maintenance → Archived Session Worktrees** finds git worktrees that are still recorded on archived session records. It solves a different problem from **Orphaned Worktrees**:

- **Orphaned Worktrees** are branch-centric git entries with no owning live session reference.
- **Archived Session Worktrees** are still referenced by archived session metadata, but the user may want to reclaim the checkout and branch while keeping the archive.

This cleanup removes only host git worktrees and, when safe, their corresponding local branches. It does **not** delete archived session rows, transcripts, proposal drafts, prompt records, search visibility, or archive list entries.

### Actionable-first scan

Click **Scan** or **Rescan** to call `GET /api/maintenance/archived-session-worktrees`. The default UI is organized around the question: "What can I clean up right now?"

The primary panel shows actionable rows first:

- rows classified as `Ready to clean` are selectable and checked by default unless the server says otherwise;
- skipped, ineligible, already-cleaned, and failed rows are hidden behind the troubleshooting disclosure;
- the historical metadata count is secondary and labelled as metadata, not as eligibility.

This avoids treating "has worktree metadata" as "safe to remove." A scan can find many archived sessions with old worktree-related fields and still have `Ready to clean: 0`.

### Summary labels

| Label | Meaning | User action |
|---|---|---|
| **Ready to clean** | Server-classified removable archived-session worktrees. These have a host path or git worktree entry and no protected references. | Use **Clean all safe candidates** or selection presets. |
| **Selected** | Current number of ready-to-clean rows selected in the UI. | Use **Clean selected** when non-zero. |
| **Already cleaned** | Archived records whose remembered worktree/git metadata is already gone. | No cleanup needed; inspect examples only when troubleshooting. |
| **Needs attention** | Non-actionable rows such as stale paths, scan errors, or protected references that may need manual inspection. | Open **Show skipped / ineligible items** or **Show why not removable**. |

`Has worktree metadata` may appear as secondary scan detail. It means Bobbit found historical worktree-related data on archived records; it does not mean those records are removable.

### Zero-removable empty state

When `Ready to clean` is zero, cleanup actions are disabled and the panel shows **Nothing safe to clean right now**. This is a successful scan, not an error.

Common explanations include:

- the worktree and git metadata are already gone;
- the archived record has no host worktree path;
- the recorded path is sandbox/container-internal, such as `/workspace` or `/workspace-wt`;
- the path or branch is still referenced by a live session, goal, delegate, team member, staff agent, or multi-repo sibling;
- the path exists on disk but is not a git worktree entry, so Bobbit leaves it for manual inspection.

Skipped, ineligible, already-cleaned, and failed examples stay hidden by default. The disclosure shows grouped examples by reason, capped to a small sample with a **Show all** option for each group.

### Troubleshooting examples

The scan response includes groups such as:

- **Ready to clean**;
- **Already cleaned**;
- **Missing worktree path**;
- **Missing repository path**;
- **Sandbox/container path**;
- **Shared delegate worktree**;
- **Stale worktree directory**;
- **Referenced by live session / goal / team / staff**;
- **Scan errors**.

Each group includes representative `sampleItems` so the UI can explain why records are not removable without rendering hundreds of skipped rows. Rows show practical details first: title, session id, project/repo, branch, worktree path, and a human-readable reason. Technical fields are secondary details.

### Cleanup flows

#### Clean all safe candidates

Use **Clean all safe candidates** when the scan reports `Ready to clean > 0`. The UI sends:

```json
{ "mode": "all" }
```

The server re-scans before cleanup and removes only rows that are still classified as removable. If a row became unsafe or already cleaned after the UI scan, it is skipped or reported as already cleaned in the result.

#### Clean selected

The scan selects ready-to-clean rows by default. The user can narrow that set with row checkboxes or presets, then use **Clean selected**. The UI sends selected worktree selectors, usually including `sessionId`, `key`, `repo`, and `path`.

```json
{
  "mode": "selected",
  "worktrees": [
    { "sessionId": "archived-session-id", "key": "...", "repo": ".", "path": "/path/to/worktree" }
  ]
}
```

Empty selected cleanup is a no-op. Invalid or stale selectors are reported as skipped; they do not make the server delete anything outside the fresh scan's removable set.

### Selection presets and categories

The UI provides one-click selection controls for common cleanup choices:

- **Select all removable**;
- **Archived sessions only**;
- **Current project** when the active project matches scan data;
- **Goal/team/delegate worktrees** when represented in the scan;
- **Clear selection**.

The API also exposes `selectionPresets` and `selectionCategories` so clients can render equivalent controls without hardcoding every rule. Categories are descriptive filters over already-removable rows, such as `archived-session`, `goal-session`, `team-session`, `delegate-session`, `child-session`, `single-repo`, and `multi-repo`.

### Safety guarantees

The server is the source of truth for cleanup eligibility. UI selection can only request cleanup; it cannot bypass guards.

Before deleting anything, cleanup re-runs the archived-session worktree scan and only acts on fresh `removable` / `ready-to-clean` rows. Protected rows are skipped.

Cleanup preserves:

- archived session metadata and archive visibility;
- transcripts and prompt history;
- proposal drafts and proposal history;
- search/index records until their normal maintenance paths handle them.

Cleanup refuses to remove worktrees or branches still referenced by:

- non-archived persisted sessions or current runtime sessions;
- persisted goals;
- delegates or shared-worktree parent/child records;
- team entries and team agents;
- staff records, including paused staff;
- multi-repo sibling `repoWorktrees` entries;
- sandbox/container-internal paths that do not identify a host worktree.

Branch deletion is best-effort and narrower than worktree deletion. Bobbit deletes an eligible local branch only when it belongs to the same repo and no protected live or durable record still references it. A cleanup result can therefore report `worktreeRemoved: true` and `branchDeleted: false`.

Multi-repo archived sessions are evaluated per repo item. One component worktree may be removable while another component is skipped.

## API shape

See [REST API — Maintenance](rest-api.md#maintenance) for the route table and interface sketch.

Key routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/maintenance/archived-session-worktrees` | Preview archived-session worktree candidates and UX grouping data. |
| `POST` | `/api/maintenance/cleanup-archived-session-worktrees` | Clean all, selected, category-filtered, or preset-filtered removable archived-session worktrees. |
| `GET` | `/api/maintenance/orphaned-worktrees` | Preview git worktrees not owned by live session references. |
| `POST` | `/api/maintenance/cleanup-worktrees` | Clean selected orphaned worktrees. |
| `GET` | `/api/maintenance/orphaned-sessions` | Preview non-interactive session records that can be terminated. |
| `POST` | `/api/maintenance/cleanup-sessions` | Terminate selected orphaned sessions. |
| `GET` | `/api/maintenance/expired-archives` | Preview expired archive purge counts. |
| `POST` | `/api/maintenance/purge-archives` | Purge expired archives. |
| `GET` | `/api/maintenance/orphaned-index-rows` | Preview search index rows whose parent records are gone. |
| `POST` | `/api/maintenance/cleanup-index-rows` | Delete orphaned search index rows. |

The archived-session scan keeps the older `sessions` and `counts` fields while adding flattened `items`, `groups`, `sampleItems`, reason categories, selection categories, and `selectionPresets`. These additive fields exist for UX filtering and examples; clients should tolerate new reasons, groups, and presets over time.
