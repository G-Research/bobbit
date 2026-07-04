# Design: Archived session worktree cleanup

**Goal:** add an explicit Settings → Maintenance tool that previews and removes git worktrees owned by archived sessions without deleting archived session metadata, transcripts, proposals, or archive visibility.

**Status:** implemented, then superseded by unified Worktree Cleanup. See [Maintenance](../maintenance.md#worktree-cleanup) for the durable user/developer reference.

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
  sessions: ArchivedSessionWorktreeSession[]; // default excludes sessions with only already-cleaned items
  counts: {
    archivedSessions: number;
    sessionsWithWorktrees: number;
    removableWorktrees: number;
    skippedWorktrees: number;
    alreadyCleanedWorktrees: number;
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
  pathExists: boolean;
  gitWorktreeMetadataExists: boolean; // true when `git worktree list --porcelain` still references `path` or `branch`
  localBranchExists: boolean; // true when `refs/heads/${branch}` still exists in `repoPath`
  status: "removable" | "skipped" | "already-cleaned";
  reason: ArchivedSessionWorktreeSkipReason | "safe-archived-session-worktree" | "already-cleaned";
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
  | "referenced-by-staff"
  | "invalid-selection";
```

By default, the scan filters out sessions whose items are all `already-cleaned`; these still contribute to `counts.alreadyCleanedWorktrees`. Add `?includeAlreadyCleaned=1` only for diagnostics; then already-cleaned items appear as disabled rows with `status: "already-cleaned"`.

### `POST /api/maintenance/cleanup-archived-session-worktrees`

Cleans selected or all currently removable archived-session worktrees. The handler must re-run the scan immediately before cleanup and must not trust stale UI state.

Request:

```ts
type CleanupArchivedSessionWorktreesRequest =
  | {
      mode: "all";
    }
  | {
      mode: "selected";
      // Exactly one selector type is allowed. Empty selected input is a no-op.
      sessionIds?: string[]; // all removable worktrees for these archived sessions
      worktrees?: Array<{
        sessionId: string;
        repo?: string;
        path?: string;
        key?: string;
      }>;
    };
```

Response:

```ts
interface CleanupArchivedSessionWorktreesResponse {
  counts: {
    requested: number;
    cleaned: number;
    branchDeleted: number;
    skipped: number;
    alreadyCleaned: number;
    failed: number;
  };
  results: ArchivedSessionWorktreeCleanupResult[];
}

interface ArchivedSessionWorktreeCleanupResult {
  key: string;
  sessionId: string;
  title?: string;
  repo?: string;
  repoPath?: string;
  path?: string;
  branch?: string;
  status: "cleaned" | "skipped" | "already-cleaned" | "failed";
  reason?: string;
  error?: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}
```

Validation and selection rules:

- `mode` is required. Unknown or missing mode returns `400`.
- `mode: "all"` must not include `sessionIds` or `worktrees`; it intentionally cleans all currently removable items from the fresh scan.
- `mode: "selected"` accepts exactly one selector type: either `sessionIds` or `worktrees`. Mixing both returns `400` rather than taking a surprising union.
- Empty `mode: "selected"` input (`sessionIds: []`, `worktrees: []`, or neither field) is a no-op returning zero counts and an empty `results` array.
- `sessionIds`, `worktrees`, and `worktrees[*].*` must be strings when present; otherwise return `400`.
- A specified item with no remaining worktree path/git metadata is returned with `status: "already-cleaned"` and `reason: "already-cleaned"` even if a branch remains. Branch-only stale items are not actionable in this feature.
- A specified item that cannot be matched to an archived session/worktree is returned as `skipped` with `reason: "invalid-selection"`.
- Cleanup is best-effort per item. One failure must not abort the whole request.

## SessionManager API

Add public methods to `src/server/agent/session-manager.ts`:

```ts
async listArchivedSessionWorktrees(): Promise<ArchivedSessionWorktreeScanResponse>;

async cleanupArchivedSessionWorktrees(
  request: CleanupArchivedSessionWorktreesRequest,
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
private branchDeletionAllowed(branch: string | undefined, repoPath: string, ctx: ArchivedWorktreeScanContext): boolean;
private readGitWorktreeRefs(repoPath: string): Promise<GitWorktreeRefs>;
private localBranchExists(repoPath: string, branch: string | undefined): Promise<boolean>;
```

`ArchivedWorktreeScanContext` should distinguish candidate scope from guard scope:

- **Cleanup candidates:** archived sessions from visible project contexts only (`projectContextManager.visible()`), matching existing maintenance worktree behavior. The endpoints are global maintenance endpoints, not current-project-scoped; "visible" means configured user projects returned by the context manager and excludes hidden/synthetic system contexts that have no host worktrees.
- **Guard references:** every store that can still own a worktree or branch, gathered from `projectContextManager.all()` rather than only visible contexts:
  - all non-archived persisted sessions by iterating `for (const ctx of projectContextManager.all()) ctx.sessionStore.getLive()` plus current runtime `this.sessions` records;
  - all persisted goals with worktree/branch metadata via each `ctx.goalStore`, including archived goals unless the goal has been purged and no longer exists in the store;
  - all persisted team entries via `ctx.teamStore.getAll()`, including each `agents[*].worktreePath`, `agents[*].branch`, and the team lead session from `teamLeadSessionId`; do not infer safety from the owning goal being archived;
  - staff records via `ctx.staffStore.getAll()`; any staff record with `worktreePath`, `repoWorktrees`, `cwd`, or `branch` is authoritative because paused staff still owns its worktree and staff cleanup is outside this feature;
  - every `repoWorktrees` entry from sessions, goals, and staff, preserving the component repo key so sibling multi-repo paths/branches are protected independently.
- **Branch guards:** branch names keyed by `repoPath`, collected from non-archived sessions, all persisted goals, all team agents, staff records, and multi-repo sibling records. A branch can be deleted for a candidate repo only when the same branch is absent from that repo's guard set.

## Candidate discovery and already-cleaned derivation

For each archived session from visible project contexts:

1. Preserve the session row; never call `purge`, `archive`, transcript deletion, proposal cleanup, search cleanup, or prompt cleanup.
2. Build worktree items from `repoWorktrees` when present. For each `[repo, path]`, compute `repoPath` as `repo === "." ? ps.repoPath : path.join(ps.repoPath, repo)`.
3. If there is no `repoWorktrees`, use the flat `ps.worktreePath` and `ps.repoPath` as repo `"."`.
4. For each candidate repo, derive cleanup state from git and the filesystem:
   - `pathExists = fs.existsSync(path)`;
   - `gitWorktreeMetadataExists = git worktree list --porcelain` contains the candidate `worktree` path or its `branch refs/heads/<branch>` in that `repoPath`;
   - `localBranchExists = git show-ref --verify --quiet refs/heads/<branch>` succeeds in that `repoPath`.
5. Separate worktree cleanup state from branch cleanup state, but keep this feature worktree-focused:
   - `worktreePresent = pathExists || gitWorktreeMetadataExists`;
   - `branchDeletionAllowedForPresentWorktree = worktreePresent && localBranchExists && branchDeletionAllowed(branch, repoPath, ctx)`.
6. If `worktreePresent` is false, classify the archived-session worktree as `already-cleaned` regardless of `localBranchExists`. It must not appear in the default candidate list or default cleanup count, so archived metadata can retain historical `worktreePath`/`repoWorktrees` without causing cleaned worktrees to reappear forever. It may appear only when `includeAlreadyCleaned=1` or when reporting a stale selected cleanup request. Branch-only cleanup is out of scope for this feature because it is generic orphan-branch cleanup and cannot safely route through `cleanupWorktree`.
7. Skip and explain missing `repoPath`, missing worktree path, container-internal sandbox paths, and guard references.
8. Mark an item `removable` only when `worktreePresent` is true and no guard reference blocks the worktree path. `willDeleteBranch` is true only when `branchDeletionAllowedForPresentWorktree` is true. A retained branch by itself must never keep a worktree-cleaned item actionable.

The default scan should include removable rows plus skipped rows that explain blocked cleanup. It should exclude sessions whose only rows are `already-cleaned` unless diagnostics request them.

## Live-reference guards

Worktree deletion is allowed only if all guards pass at scan time and again at cleanup time.

### Sessions

Use the existing `isWorktreePathReferencedByLiveSession(candidatePath, records, { ignoreSessionId })` from `worktree-reference-guard.ts` with records from:

- all non-archived persisted sessions across all project contexts (`ctx.sessionStore.getLive()` from `projectContextManager.all()`);
- current runtime `SessionInfo` objects converted to `{ id, worktreePath, cwd, repoWorktrees }`.

This protects flat `worktreePath`, `cwd` inside a worktree, and exact `repoWorktrees` roots, including multi-repo sibling roots.

### Goals

Goals may own worktrees independently of sessions, and the safety requirement forbids deleting a worktree referenced by any goal. Convert every persisted goal with worktree metadata to `WorktreeReferenceRecord`-compatible objects using `id`, `worktreePath`, `cwd`, `repoWorktrees`, and `archived`, then check the same path guard. Also add every goal `branch` value to the branch guard set. Archived goals still guard paths/branches because their metadata and archive visibility are preserved.

### Teams

For each `PersistedTeamEntry` from `ctx.teamStore.getAll()`, treat every agent `worktreePath` as guarded. Add every agent `branch` to the branch guard set and include `teamLeadSessionId` through the persisted-session records. Do not infer safety from the owning goal being archived; the team record remains authoritative until it is removed. If any team agent references the candidate path, skip with `referenced-by-live-team`.

### Staff

Staff agents have independent durable worktree metadata in `PersistedStaff` (`ctx.staffStore.getAll()`): `cwd`, `worktreePath`, `branch`, `repoPath`, and `repoWorktrees`. Collect these as guard records for every staff record, including paused staff, because staff cleanup is out-of-scope here and a staff worktree must not be removed through archived-session maintenance. If a staff record references the candidate path, skip with `referenced-by-staff`; if it references the candidate branch in the same repo, block branch deletion.

### Delegates and parent/child sessions

Delegates usually share the parent worktree. If an archived session has `delegateOf` and no independent `repoWorktrees` or branch, skip with `delegate-shared-worktree`. If a delegate-like archived session does have an independently persisted worktree/branch, evaluate it with the same path and branch guards as any other candidate. Parent/child safety otherwise comes from the generic path guard over `delegateOf`, `parentSessionId`, `childKind`, `cwd`, and `worktreePath` records; do not assume a relationship is safe just because the archived session is the owner.

### Multi-repo sessions

When `ps.repoWorktrees` exists, scan and clean each repo item independently. One repo may be removable while another is skipped. Never fall back to flat `worktreePath` for multi-repo sessions unless `repoWorktrees` is absent.

### Sandboxed paths

Skip paths that are container-internal, currently any normalized path starting with `/workspace` or `/workspace-wt`. Sandboxed sessions can still have host-side worktrees; those are eligible when the path is not container-internal and all other guards pass.

### Branch deletion

`cleanupWorktree` can delete the local and remote branch when called with `deleteBranch=true`. Pass `true` only when:

- a worktree is present (`pathExists || gitWorktreeMetadataExists`);
- `branch` is present;
- the same branch is not referenced in the same `repoPath` by any non-archived session, runtime session, persisted goal, team agent, staff record, or multi-repo sibling guard;
- the selected item is still removable in the fresh cleanup scan.

If the worktree is removable but branch deletion is blocked, call `cleanupWorktree(repoPath, path, branch, false)` and return `branchDeleted: false` plus `branchDeleteBlockedReason` in the scan item. If the worktree is already gone, do not call `cleanupWorktree` only to delete a branch.

## Cleanup semantics

Cleanup always starts by running the same scan derivation again, including already-cleaned diagnostics, then applying the explicit request mode:

- `mode: "all"`: clean every fresh-scan item with `status: "removable"`.
- `mode: "selected"` + `sessionIds`: clean every fresh-scan removable item for those archived sessions.
- `mode: "selected"` + `worktrees`: clean exactly matching fresh-scan removable items by `key` when present, otherwise by `sessionId` + `repo` + `path`.
- stale selected rows that now derive to `already-cleaned` return `status: "already-cleaned"` and do not call git;
- stale selected rows that cannot be matched to an archived session/worktree return `status: "skipped"`, `reason: "invalid-selection"`.

For each selected fresh-scan item with `status: "removable"`, `worktreePresent` must be true, so cleanup always uses the worktree helper for a real worktree cleanup:

```ts
const { cleanupWorktree } = await import("../skills/git.js");
await cleanupWorktree(item.repoPath, item.path, item.branch, item.willDeleteBranch);
```

Never route branch-only cleanup through `cleanupWorktree`; branch-only rows are `already-cleaned` (or skipped diagnostics) and no git call is made for them. Then return a per-item result. A successful cleanup will not mutate `PersistedSession`; on the next scan the retained archived paths derive as `already-cleaned` when the path and git worktree metadata are gone. If branch deletion was blocked, the remaining branch does not make the archived worktree reappear in the default candidate list. The archived transcript remains visible, but the worktree path shown in archived session details may point to a removed directory. A later enhancement may add non-destructive metadata such as `worktreeCleanedAt`, but that is not required for this goal.

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
- action button says `Clean Up Selected (N)` and posts `{ mode: "selected", worktrees: selectedItems }`;
- optional secondary action `Clean Up All` posts `{ mode: "all" }` only after a scan and with confirmation;
- after cleanup, show counts for cleaned, skipped, alreadyCleaned, failed, and branchDeleted, then rescan.

Add stable selectors for fixture tests:

- `data-section="archived-session-worktrees"`
- `data-action="scan-archived-session-worktrees"`
- `data-action="cleanup-archived-session-worktrees"`
- `data-archived-worktree-key="..."`

## Test plan

### API E2E: `tests/e2e/maintenance-api.spec.ts`

Add coverage for:

1. `GET /api/maintenance/archived-session-worktrees` returns `{ sessions, counts }` with arrays/numeric counts.
2. `POST /api/maintenance/cleanup-archived-session-worktrees` rejects missing `mode`, rejects mixed `sessionIds` + `worktrees`, treats empty `mode: "selected"` as a zero-count no-op, and accepts `mode: "all"`.
3. An archived worktree-backed session appears in scan with title/id, branch, path, repo/project, and `status: "removable"`.
4. Cleanup removes the git worktree and branch where safe, returns `cleaned: 1`, and the archived session remains returned by archived-session APIs.
5. A second scan after cleanup does not list the archived session by default; with `includeAlreadyCleaned=1` it reports `status: "already-cleaned"`, and a stale selected cleanup request reports `already-cleaned` rather than failing.
6. A removable item whose branch deletion is blocked by a live guard cleans the worktree, leaves the branch, and is excluded from the next default scan.
7. A branch-only archived-session item is classified already-cleaned/skipped and is never repeatedly actionable.
8. A candidate sharing its path with a non-archived session is skipped and cleanup does not remove it.
9. Guard tests cover all persisted goals (including archived goals), all team entries (`teamStore.getAll()`), staff records (`staffStore.getAll()`), runtime sessions, and multi-repo sibling `repoWorktrees`/branch references.
10. A `repoWorktrees` archived session returns one item per repo and cleans each independently.
11. A sandbox/container-internal path like `/workspace-wt/session/x` is skipped with `sandbox-container-path`.

### UI fixture: `tests/ui-fixtures/search-preview-maintenance.spec.ts` and entry

Update the fixture entry to mock:

- `GET /api/maintenance/archived-session-worktrees`
- `POST /api/maintenance/cleanup-archived-session-worktrees`

Add tests for:

1. the Archived Session Worktrees card renders and cleanup is disabled before scan;
2. scan renders empty state;
3. scan renders removable and skipped rows, including title/id, branch, repo, path, and skip reason;
4. selected cleanup posts `{ mode: "selected", worktrees: [...] }` with only checked removable rows, displays result counts, clears cleaned fixture rows, and rescans;
5. empty selected cleanup stays disabled/no-op, and an all-clean action posts `{ mode: "all" }` only after confirmation;
6. already-cleaned rows are absent from the default scan fixture but can be shown disabled in a diagnostic fixture state;
7. state persists when switching tabs and back, matching the existing orphaned worktree persistence test.

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
