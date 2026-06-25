# Design: Archived session worktree cleanup

**Goal:** add an explicit Settings → Maintenance tool that previews and removes git worktrees owned by archived sessions without deleting archived session metadata, transcripts, proposals, or archive visibility.

**Status:** design.

**Scope:** production/API/UI/test plan for archived-session worktree cleanup. This is separate from the existing branch-centric orphaned worktree cleanup.

## Existing behavior

Current maintenance endpoints in `src/server/server.ts` expose:

- `GET /api/maintenance/orphaned-worktrees`
- `POST /api/maintenance/cleanup-worktrees`
- `GET /api/maintenance/orphaned-sessions`
- `POST /api/maintenance/cleanup-sessions`
- `GET /api/maintenance/expired-archives`
- `POST /api/maintenance/purge-archives`

`SessionManager.listOrphanedSessionWorktrees(repoPath)` and `cleanupOrphanedSessionWorktrees(repoPath)` scan `git worktree list --porcelain` for `session/*` branches that have no non-archived session branch/path reference. That is useful for truly orphaned git entries, but it does not explain that an archived session still owns a removable worktree.

`SessionManager.purgeOneSession(ps)` already removes worktrees through `cleanupWorktree(repoPath, worktreePath, branch, true)`, including `repoWorktrees`, but purge is destructive: it also deletes transcripts, search index entries, prompts, proposal drafts, colors, and the persisted session row. The new maintenance action must reuse only the worktree/branch cleanup semantics, not purge semantics.

## New REST endpoints

Add archived-session-specific endpoints near the existing maintenance routes in `src/server/server.ts`.

### `GET /api/maintenance/archived-session-worktrees`

Runs a safe preview scan. Response:

```ts
interface ArchivedSessionWorktreeScanResponse {
  sessions: ArchivedSessionWorktreeSession[];
  counts: {
    archivedSessions: number;
    sessionsWithWorktrees: number;
    removableWorktrees: number;
    skippedWorktrees: number;
  };
}

interface ArchivedSessionWorktreeSession {
  id: string;
  title: string;
  archivedAt?: number;
  projectId?: string;
  projectName?: string;
  goalId?: string;
  teamGoalId?: string;
  delegateOf?: string;
  parentSessionId?: string;
  childKind?: string;
  sandboxed?: boolean;
  branch?: string;
  repoPath?: string;
  worktreePath?: string;
  worktrees: ArchivedSessionWorktreeItem[];
}

interface ArchivedSessionWorktreeItem {
  key: string; // `${sessionId}:${repo}:${normalizedPath}`
  sessionId: string;
  repo: string; // "." for single-repo
  repoPath: string;
  path: string;
  branch?: string;
  exists: boolean; // false is still cleanable; cleanupWorktree can prune stale git metadata
  status: "removable" | "skipped";
  reason: ArchivedSessionWorktreeSkipReason | "safe-archived-session-worktree";
  detail: string;
  willDeleteBranch: boolean;
  branchDeleteBlockedReason?: string;
}

type ArchivedSessionWorktreeSkipReason =
  | "no-worktree-path"
  | "missing-repo-path"
  | "sandbox-container-path"
  | "delegate-shared-worktree"
  | "referenced-by-live-session"
  | "referenced-by-live-goal"
  | "referenced-by-live-team"
  | "invalid-selection";
```

### `POST /api/maintenance/cleanup-archived-session-worktrees`

Cleans selected or all currently removable archived-session worktrees. The handler must re-run the scan immediately before cleanup and must not trust stale UI state.

Request:

```ts
interface CleanupArchivedSessionWorktreesRequest {
  // Omitted means all currently removable worktrees.
  sessionIds?: string[]; // all removable worktrees for these archived sessions
  worktrees?: Array<{
    sessionId: string;
    repo?: string;
    path?: string;
    key?: string;
  }>;
}
```

Response:

```ts
interface CleanupArchivedSessionWorktreesResponse {
  counts: {
    requested: number;
    cleaned: number;
    branchDeleted: number;
    skipped: number;
    failed: number;
  };
  results: ArchivedSessionWorktreeCleanupResult[];
}

interface ArchivedSessionWorktreeCleanupResult {
  key: string;
  sessionId: string;
  title: string;
  repo: string;
  repoPath: string;
  path: string;
  branch?: string;
  status: "cleaned" | "skipped" | "failed";
  reason?: string;
  error?: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}
```

Validation rules:

- `sessionIds`, `worktrees`, and `worktrees[*].*` must be strings when present; otherwise return `400`.
- A specified item that is no longer in the fresh scan is returned as `skipped` with `reason: "invalid-selection"`.
- Cleanup is best-effort per item. One failure must not abort the whole request.

## SessionManager API

Add public methods to `src/server/agent/session-manager.ts`:

```ts
async listArchivedSessionWorktrees(): Promise<ArchivedSessionWorktreeScanResponse>;

async cleanupArchivedSessionWorktrees(
  selection?: CleanupArchivedSessionWorktreesRequest,
): Promise<CleanupArchivedSessionWorktreesResponse>;
```

Implementation helpers:

```ts
private buildArchivedWorktreeScanContext(): ArchivedWorktreeScanContext;
private archivedSessionWorktreeItems(
  ps: PersistedSession,
  ctx: ArchivedWorktreeScanContext,
): ArchivedSessionWorktreeItem[];
private isContainerInternalWorktreePath(path: string): boolean;
private branchDeletionAllowed(branch: string | undefined, ctx: ArchivedWorktreeScanContext): boolean;
```

`ArchivedWorktreeScanContext` should include:

- visible project contexts only (`projectContextManager.visible()`), matching existing maintenance worktree behavior;
- all non-archived persisted sessions plus current runtime `this.sessions` records;
- live goals from `goalStore.getLive()` converted to `WorktreeReferenceRecord` shape;
- live team worktree references from `teamStore.getAll()` where the owning goal is not archived;
- live branch names from non-archived sessions, live goals, and live team agents.

## Candidate discovery

For each archived session from visible project contexts:

1. Preserve the session row; never call `purge`, `archive`, transcript deletion, proposal cleanup, search cleanup, or prompt cleanup.
2. Build worktree items from `repoWorktrees` when present. For each `[repo, path]`, compute `repoPath` as `repo === "." ? ps.repoPath : path.join(ps.repoPath, repo)`.
3. If there is no `repoWorktrees`, use the flat `ps.worktreePath` and `ps.repoPath` as repo `"."`.
4. Skip and explain missing `repoPath`, missing worktree path, and container-internal sandbox paths. Do not skip solely because the path is missing on disk; keep `exists: false` and let `cleanupWorktree` prune stale git metadata and delete the branch when branch guards allow it.
5. Mark an item `removable` only when no live-reference guard blocks it.

The scan should include skipped rows so users can see why an archived session is not currently removable.

## Live-reference guards

Worktree deletion is allowed only if all guards pass at scan time and again at cleanup time.

### Sessions

Use the existing `isWorktreePathReferencedByLiveSession(candidatePath, records, { ignoreSessionId })` from `worktree-reference-guard.ts` with records from:

- all non-archived persisted sessions across visible projects;
- current runtime `SessionInfo` objects converted to `{ id, worktreePath, cwd, repoWorktrees }`.

This protects flat `worktreePath`, `cwd` inside a worktree, and exact `repoWorktrees` roots.

### Goals

Live/non-archived goals may own goal worktrees independently of sessions. Convert live goals to `WorktreeReferenceRecord`-compatible objects using `id`, `worktreePath`, `cwd`, `repoWorktrees`, and `archived`, then check the same path guard. Also add live goal `branch` values to the branch guard set.

### Teams

For each `PersistedTeamEntry` whose goal is missing or non-archived, treat every agent `worktreePath` as live. Add every agent `branch` to the branch guard set and include `teamLeadSessionId` through the persisted-session records. If any live team agent references the candidate path, skip with `referenced-by-live-team`.

### Delegates and parent/child sessions

Delegates usually share the parent worktree. If an archived session has `delegateOf` and no independent `repoWorktrees` or branch, skip with `delegate-shared-worktree`. If a delegate-like archived session does have an independently persisted worktree/branch, evaluate it with the same path and branch guards as any other candidate. Parent/child safety otherwise comes from the generic path guard over `delegateOf`, `parentSessionId`, `childKind`, `cwd`, and `worktreePath` records; do not assume a relationship is safe just because the archived session is the owner.

### Multi-repo sessions

When `ps.repoWorktrees` exists, scan and clean each repo item independently. One repo may be removable while another is skipped. Never fall back to flat `worktreePath` for multi-repo sessions unless `repoWorktrees` is absent.

### Sandboxed paths

Skip paths that are container-internal, currently any normalized path starting with `/workspace` or `/workspace-wt`. Sandboxed sessions can still have host-side worktrees; those are eligible when the path is not container-internal and all other guards pass.

### Branch deletion

`cleanupWorktree` can delete the local and remote branch when called with `deleteBranch=true`. Pass `true` only when:

- `branch` is present;
- the same branch is not referenced by any non-archived session, live goal, or live team agent;
- the selected item is still removable in the fresh cleanup scan.

If the worktree is removable but the branch is still referenced, call `cleanupWorktree(repoPath, path, branch, false)` and return `branchDeleted: false` plus `branchDeleteBlockedReason` in the scan item.

## Cleanup semantics

For each selected fresh-scan item with `status: "removable"`:

```ts
const { cleanupWorktree } = await import("../skills/git.js");
await cleanupWorktree(item.repoPath, item.path, item.branch, item.willDeleteBranch);
```

Then return a per-item result. Do not mutate `PersistedSession` fields by default. The archived transcript remains visible, but the worktree path shown in archived session details may point to a removed directory; the maintenance result is the source of truth for cleanup history. A later enhancement may add non-destructive metadata such as `worktreeCleanedAt`, but that is not required for this goal.

## Settings UI changes

Extend `src/app/settings-page.ts` Maintenance state:

```ts
type ArchivedSessionWorktreeScan = ArchivedSessionWorktreeScanResponse;
let maintenanceArchivedWorktrees: ArchivedSessionWorktreeScan | null = null;
let maintenanceArchivedWorktreeSelection = new Set<string>();
let maintenanceArchivedWorktreeResult: CleanupArchivedSessionWorktreesResponse | null = null;
let maintenanceLoading: "worktrees" | "archivedWorktrees" | "sessions" | "archives" | "search" | "orphanRows" | null = null;
```

Add functions:

```ts
async function scanArchivedSessionWorktrees(): Promise<void>;
async function cleanupArchivedSessionWorktrees(): Promise<void>;
function toggleArchivedWorktreeSelection(key: string, checked: boolean): void;
function selectAllArchivedWorktrees(): void;
```

Render a separate card after **Orphaned Worktrees** titled **Archived Session Worktrees**:

- description: "Archived sessions that still have removable git worktrees. Session archives and transcripts are preserved.";
- scan button calling `GET /api/maintenance/archived-session-worktrees`;
- list rows grouped by archived session title/id;
- each row shows project/repo, branch, path, and status detail;
- removable rows have checkboxes and are selected by default after scan;
- skipped rows are disabled and show the reason text;
- action button says `Clean Up Selected (N)` and posts `{ worktrees: selectedItems }`;
- after cleanup, show counts for cleaned, skipped, failed, and branchDeleted, then rescan.

Add stable selectors for fixture tests:

- `data-section="archived-session-worktrees"`
- `data-action="scan-archived-session-worktrees"`
- `data-action="cleanup-archived-session-worktrees"`
- `data-archived-worktree-key="..."`

## Test plan

### API E2E: `tests/e2e/maintenance-api.spec.ts`

Add coverage for:

1. `GET /api/maintenance/archived-session-worktrees` returns `{ sessions, counts }` with arrays/numeric counts.
2. Empty cleanup `POST /api/maintenance/cleanup-archived-session-worktrees` returns structured `{ counts, results }`.
3. An archived worktree-backed session appears in scan with title/id, branch, path, repo/project, and `status: "removable"`.
4. Cleanup removes the git worktree and branch where safe, returns `cleaned: 1`, and the archived session remains returned by archived-session APIs.
5. A candidate sharing its path with a non-archived session is skipped and cleanup does not remove it.
6. A `repoWorktrees` archived session returns one item per repo and cleans each independently.
7. A sandbox/container-internal path like `/workspace-wt/session/x` is skipped with `sandbox-container-path`.

### UI fixture: `tests/ui-fixtures/search-preview-maintenance.spec.ts` and entry

Update the fixture entry to mock:

- `GET /api/maintenance/archived-session-worktrees`
- `POST /api/maintenance/cleanup-archived-session-worktrees`

Add tests for:

1. the Archived Session Worktrees card renders and cleanup is disabled before scan;
2. scan renders empty state;
3. scan renders removable and skipped rows, including title/id, branch, repo, path, and skip reason;
4. selected cleanup posts only checked removable rows, displays result counts, clears cleaned fixture rows, and rescans;
5. state persists when switching tabs and back, matching the existing orphaned worktree persistence test.

### Type/check commands

Implementation should run:

```bash
npm run check
npm run test:unit
npm run test:e2e
```

Manual QA:

1. Create a worktree-backed session.
2. Archive it.
3. Open Settings → Maintenance → Archived Session Worktrees.
4. Confirm the scan lists the archived session title/id, branch, repo/project, path, and safe-removal detail.
5. Clean it up.
6. Confirm the git worktree/branch are gone and the archived session transcript remains accessible.
