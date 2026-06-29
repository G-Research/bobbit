# Unified worktree cleanup backend design

## Purpose

Unify Bobbit's backend worktree cleanup paths behind one inventory/classification service and one cleanup executor. The service must preserve existing safety behavior from orphaned worktrees, archived session worktrees, boot sweeping, and pool reclaim while removing duplicate scanners and root/branch classification drift.

This document is backend-only. UI design and implementation are intentionally out of scope.

## Current backend paths

### Maintenance orphaned session worktrees

- Routes: `src/server/server.ts`
  - `GET /api/maintenance/orphaned-worktrees` at `handleApiRoute()` scans `projectContextManager.visible()` and calls `sessionManager.listOrphanedSessionWorktrees(repoPath)` for `ctx.project.rootPath` only.
  - `POST /api/maintenance/cleanup-worktrees` validates selected rows by re-calling `listOrphanedSessionWorktrees(repoPath)`, then calls `cleanupWorktree(repoPath, wt.path, wt.branch, true)`. Without selectors it calls `sessionManager.cleanupOrphanedSessionWorktrees(repoPath)` per visible project.
- Logic: `src/server/agent/session-manager.ts`
  - `listOrphanedSessionWorktrees(repoPath)` and `cleanupOrphanedSessionWorktrees(repoPath)` parse `git worktree list --porcelain`.
  - They only consider branches matching `session/.+`.
  - They skip legacy pool branches beginning `session/_pool-`.
  - They protect worktrees referenced by live persisted sessions or runtime sessions via `isWorktreePathReferencedByLiveSession()` and by matching live persisted branches.
- Blind spots:
  - Uses `ctx.project.rootPath`; multi-repo component repos are not scanned.
  - Does not resolve `worktree_root` or filesystem-only children under worktree roots.
  - Protection is session-centric; goals, teams, delegates, and staff are partially protected only if represented by sessions.

### Archived session worktrees

- Routes: `src/server/server.ts`
  - `GET /api/maintenance/archived-session-worktrees` calls `sessionManager.listArchivedSessionWorktrees(includeAlreadyCleaned)`.
  - `POST /api/maintenance/cleanup-archived-session-worktrees` validates request shapes, then calls `sessionManager.cleanupArchivedSessionWorktrees(request)`.
- Types and logic: `src/server/agent/session-manager.ts`
  - Types: `ArchivedSessionWorktreeScanResponse`, `ArchivedSessionWorktreeItem`, `ArchivedWorktreeDisposition`, `ArchivedWorktreeReason`, `CleanupArchivedSessionWorktreesRequest`, `CleanupArchivedSessionWorktreesResponse`.
  - `buildArchivedWorktreeScanContext()` gathers visible/all project contexts, live/runtime sessions, archived sessions, goals, teams, staff, branch guards, and git worktree caches.
  - `archivedSessionWorktreeItems()` expands `PersistedSession.repoWorktrees` for multi-repo sessions; otherwise uses `worktreePath`.
  - `archivedSessionWorktreeItem()` classifies rows as `removable`, `skipped`, or `already-cleaned`, with UX dispositions such as `ready-to-clean`, `needs-attention`, and `ineligible`.
  - `cleanupArchivedSessionWorktrees()` re-runs the scan before cleanup, cleans only `status === "removable"`, calls `cleanupWorktree(..., false)`, verifies removal, then calls `deleteArchivedWorktreeBranchIfAllowed()`.
  - `deleteArchivedWorktreeBranchIfAllowed()` rebuilds scan context before local/remote branch deletion and blocks if any live or archived guard still references that branch.
- Strong parts to reuse:
  - Re-scan-before-delete behavior.
  - Container-internal path skip in `isContainerInternalWorktreePath()`.
  - Live goal/team/staff/delegate branch/path guards.
  - Branch deletion split from worktree removal.
- Blind spots:
  - Starts from archived session metadata only; unowned git worktrees and filesystem-only root children are invisible.
  - Classification lives inside `SessionManager`, making it hard for boot/pool paths to reuse.

### Boot sweeper

- Entry: `src/server/server.ts` startup around the `sweepOrphanedWorktrees()` import and call.
- Logic: `src/server/agent/worktree-sweeper.ts`
  - `sweepOrphanedWorktrees({ projects, goals, sessions, staff })` builds owned branches/paths from non-archived records.
  - Scans `git worktree list --porcelain` per project repo.
  - Skips primary repo worktrees and pool branches via `isPoolBranch()`.
  - Keeps owned records by branch or path; attempts `git worktree repair` when branch is owned but path differs.
  - Calls `cleanupWorktree(wt.repoPath, wt.path, branch, true)` for unowned branch worktrees.
  - Test seam: `classifyWorktrees()`.
- Blind spots:
  - Only sees git metadata, not filesystem-only root children.
  - Owns a separate branch/path classifier from maintenance.
  - Boot project input currently carries `rootPath` and `repos`, not resolved `worktree_root` roots.

### Worktree pool reclaim

- Logic: `src/server/agent/worktree-pool.ts`
  - `WorktreePool.reclaimOrphaned(activeWorktreePaths?)` is private and runs from `startFilling()`.
  - It hardcodes `wtRoot = path.resolve(this.repoPath, "..", `${path.basename(this.repoPath)}-wt`)`.
  - Scans directories named `pool-_pool-*` or `session-_pool-*`, skips active paths, checks `.git`, verifies current branch with `git rev-parse --abbrev-ref HEAD`, and pushes matching `isPoolBranch(branch)` entries into the in-memory pool.
- Blind spots:
  - Does not use `skills/worktree-paths.ts::worktreeRoot()` even though the constructor stores `worktreeRoot`.
  - Single-repo directory assumptions do not generalize cleanly to configured roots or multi-repo containers.
  - Pool entry discovery is not visible to maintenance inventory.

### Path helpers and cleanup primitive

- `src/server/skills/worktree-paths.ts`
  - `worktreeRoot({ rootPath, worktreeRoot })` resolves configured roots: absolute as-is, relative against `rootPath`, unset to sibling `<rootPath>-wt`.
  - `branchContainer()`, `repoWorktreePath()`, and `branchToSlug()` define branch/container layouts.
- `src/server/skills/git.ts`
  - `createWorktree()` and `createWorktreeSet()` already accept `worktreeRoot`.
  - `cleanupWorktree(repoPath, worktreePath, branchName?, deleteBranch?)` removes git worktree metadata/path, then optionally deletes local/remote branch best-effort.
- `src/server/agent/worktree-reference-guard.ts`
  - `normalizeWorktreeHostPath()` normalizes paths for comparisons.
  - `isWorktreePathReferencedByLiveSession()` and `collectLiveSessionWorktreePaths()` protect live sessions by `worktreePath`, `cwd`, and `repoWorktrees`.

## Proposed service

Create `src/server/agent/worktree-inventory.ts` as the canonical backend service. Keep pure classification helpers in the same file or split to `src/server/agent/worktree-inventory-classifier.ts` if tests need a smaller import graph.

### Construction

```ts
export interface WorktreeInventoryDeps {
  projectContextManager: ProjectContextManager;
  sessionManager: SessionManager;
  getWorktreePoolEntries?: (projectId: string) => WorktreePoolSnapshot | undefined;
  clock?: () => number;
  fs?: Pick<typeof import("node:fs"), "existsSync" | "readdirSync" | "statSync">;
  execGit?: (repoPath: string, args: readonly string[], opts?: { timeoutMs?: number }) => Promise<string>;
}

export class WorktreeInventoryService {
  constructor(deps: WorktreeInventoryDeps);
  scan(opts?: WorktreeInventoryScanOptions): Promise<WorktreeInventoryReport>;
  cleanup(request: CleanupWorktreeInventoryRequest): Promise<CleanupWorktreeInventoryResponse>;
  legacyOrphanedWorktrees(): Promise<{ worktrees: Array<{ path: string; branch: string; repoPath: string }> }>;
  legacyArchivedSessionWorktrees(includeAlreadyCleaned?: boolean): Promise<ArchivedSessionWorktreeScanResponse>;
  cleanupLegacyArchivedSessionWorktrees(request: CleanupArchivedSessionWorktreesRequest): Promise<CleanupArchivedSessionWorktreesResponse>;
}
```

`WorktreeInventoryService` should be owned by `server.ts` next to `SessionManager` and injected with existing managers. Do not put new scanning logic inside `SessionManager`.

### Public report shape

```ts
export type WorktreeInventorySource =
  | "runtime-session"
  | "persisted-live-session"
  | "archived-session"
  | "goal"
  | "team"
  | "delegate"
  | "staff"
  | "pool"
  | "git-worktree"
  | "filesystem";

export type WorktreeInventoryClassification =
  | "ready-to-clean"
  | "protected-in-use"
  | "archived-owned"
  | "unowned-git-worktree"
  | "pool-entry"
  | "already-cleaned"
  | "stale-filesystem-only"
  | "scan-error";

export type WorktreeInventoryReason =
  | "safe-archived-session-worktree"
  | "safe-unowned-session-worktree"
  | "safe-pool-entry"
  | "referenced-by-live-session"
  | "referenced-by-live-goal"
  | "referenced-by-live-team"
  | "referenced-by-delegate"
  | "referenced-by-staff"
  | "referenced-by-pool"
  | "branch-referenced-by-live-record"
  | "branch-referenced-by-archived-record"
  | "git-worktree-metadata-missing"
  | "filesystem-only-needs-attention"
  | "sandbox-container-path"
  | "primary-worktree"
  | "missing-repo-path"
  | "missing-worktree-path"
  | "git-scan-error"
  | "fs-scan-error";

export interface WorktreeInventoryItem {
  id: string;                     // stable public item id: projectId:repo:path or record-specific archived id
  projectId: string;
  projectName: string;
  componentName?: string;
  repo: string;                   // "." for single-repo
  repoPath: string;
  worktreeRoot?: string;
  path: string;
  branch?: string;
  sources: WorktreeInventorySource[];
  owners: Array<{ type: WorktreeInventorySource; id: string; archived?: boolean; title?: string }>;
  classification: WorktreeInventoryClassification;
  disposition: "ready-to-clean" | "protected" | "already-cleaned" | "needs-attention" | "failed";
  reason: WorktreeInventoryReason;
  detail: string;
  actionable: boolean;
  selectable: boolean;
  defaultSelected: boolean;
  pathExists: boolean;
  gitWorktreeMetadataExists: boolean;
  localBranchExists?: boolean;
  willDeleteBranch: boolean;
  branchDeleteBlockedReason?: "branch-referenced-by-live-record" | "branch-referenced-by-archived-record";
  legacy?: {
    archivedSession?: Pick<ArchivedSessionWorktreeItem, "sessionId" | "repo" | "source" | "selectionCategories">;
    orphanedWorktree?: true;
  };
}

export interface WorktreeInventoryReport {
  items: WorktreeInventoryItem[];
  counts: {
    total: number;
    readyToClean: number;
    protectedInUse: number;
    archivedOwned: number;
    unownedGitWorktrees: number;
    poolEntries: number;
    alreadyCleaned: number;
    needsAttention: number;
    scanErrors: number;
    defaultSelected: number;
    byClassification: Partial<Record<WorktreeInventoryClassification, number>>;
    byReason: Partial<Record<WorktreeInventoryReason, number>>;
    bySource: Partial<Record<WorktreeInventorySource, number>>;
  };
  generatedAt: number;
}
```

This is also the canonical public REST DTO returned by `GET /api/maintenance/worktrees`. The unified UI must use `id`, `classification`, detailed `sources`, `owners`, `reason`, and `detail` directly. Any coarser display labels such as “Bobbit state” or “Git metadata” are presentation-only and must not change the cleanup request contract.

### Cleanup API

Canonical routes in `src/server/server.ts`:

- `GET /api/maintenance/worktrees?include=all|actionable|troubleshooting`
  - Default should include safe/actionable rows and summary counts; protected/stale/error rows can be present for troubleshooting if requested.
- `POST /api/maintenance/cleanup-worktrees`
  - Reuse this existing path as canonical. Accept both old orphaned-worktree body and new selectors.

```ts
type CleanupWorktreeInventoryRequest =
  | { mode: "all-safe" }
  | { mode: "selected"; itemIds: string[] }
  | { mode: "legacy-orphaned"; worktrees?: Array<{ path: string; branch: string; repoPath: string }> };

interface CleanupWorktreeInventoryResponse {
  counts: {
    requested: number;
    cleaned: number;
    skipped: number;
    failed: number;
    branchDeleted: number;
    worktreeRemoved: number;
    notActionable: number;
    byStatus: Partial<Record<"cleaned" | "skipped" | "already-cleaned" | "failed", number>>;
    byReason: Partial<Record<WorktreeInventoryReason | "invalid-selection", number>>;
  };
  results: Array<{
    itemId: string;
    path?: string;
    repoPath?: string;
    branch?: string;
    status: "cleaned" | "skipped" | "already-cleaned" | "failed";
    reason?: WorktreeInventoryReason | "invalid-selection";
    detail?: string;
    worktreeRemoved: boolean;
    branchDeleted: boolean;
    error?: string;
  }>;
  generatedAt: number;
}
```

## Source reconciliation model

The scan should build indexes first, then classify one normalized candidate per physical worktree path per repo.

### Project and repo discovery

For each `ProjectContextManager.visible()` context:

1. Read project metadata from `ctx.project` and `ctx.projectConfigStore`.
2. Resolve components via `ctx.projectConfigStore.getComponents()`.
3. Resolve worktree root with `worktreeRoot({ rootPath: ctx.project.rootPath, worktreeRoot: ctx.projectConfigStore.get("worktree_root") || undefined })`.
4. Build component repos:
   - Single repo: `repo = "."`, `repoPath = ctx.project.rootPath` if it is a git repo.
   - Multi-repo/polyrepo: each component with a git repo gets `repoPath = repo === "." ? rootPath : path.join(rootPath, repo)`.
5. Exclude hidden/system projects by using `visible()` for filesystem and git scanning. Use `all()` only for protective ownership guards where a hidden record could still reference a path.

### Record sources

Collect owner references from all durable and runtime state:

- Runtime sessions: `SessionManager.sessions` equivalent accessor, including `SessionInfo.worktreePath`, `cwd`, `repoPath`, `branch`, `repoWorktrees`, `delegateOf`, `parentSessionId`, `childKind`, `staffId`.
- Persisted live sessions: `ctx.sessionStore.getLive()`.
- Archived sessions: `ctx.sessionStore.getArchived()`.
- Goals: `ctx.goalStore.getAll()` with `PersistedGoal.worktreePath`, `cwd`, `repoPath`, `branch`, `repoWorktrees`, `archived`.
- Team leads and team agents: `ctx.teamStore.getAll()` with `teamLeadSessionId` and `agents[].worktreePath/branch` from `PersistedTeamEntry`.
- Delegates/child sessions: represented by session fields `delegateOf`, `parentSessionId`, and `childKind`; add explicit `delegate` source labels for auditability.
- Staff: `ctx.staffStore.getAll()` with `PersistedStaff.worktreePath`, `cwd`, `repoPath`, `branch`, `repoWorktrees`.
- Pool: expose an in-memory snapshot from `WorktreePool`, e.g. `snapshotEntries(): WorktreePoolSnapshot`, returning ready entries and per-repo worktrees without allowing mutation.

Each reference should add:

- Exact normalized path owners for `worktreePath` and every `repoWorktrees` value.
- `cwd` as a child-path owner: if `cwd` is inside a candidate worktree, protect the candidate.
- Branch guards keyed by normalized repo path and branch.
- Archived branch guards separately, so branch deletion can be blocked by other archived rows without preventing worktree removal.

### Git metadata

For each component repo:

- Run `git worktree list --porcelain` with timeout.
- Parse `worktree` path and `branch refs/heads/<name>`.
- Skip the primary worktree whose path equals the component repo path.
- Add `source: "git-worktree"` for each path/branch.
- Record scan errors as `scan-error` items scoped to project/repo so the UI can surface diagnostics.

### Filesystem directories

For each resolved `worktreeRoot`:

- If missing: no item.
- Read immediate child directories only.
- Single-repo candidates are children like `<worktreeRoot>/<branchSlug>`.
- Multi-repo candidates are branch containers; map children under the container to component repo paths where possible.
- Add `source: "filesystem"` for directories that do not have git metadata but are under a resolved Bobbit worktree root.
- Default filesystem-only candidates to `stale-filesystem-only` / `filesystem-only-needs-attention`, not actionable.
- Promote to actionable only when all strict Bobbit-owned safety rules pass:
  - child name equals `branchToSlug(branch)` for a Bobbit-owned branch known from an archived record or pool entry;
  - path is under the resolved `worktreeRoot` for that project;
  - branch/path is unreferenced by live/durable records;
  - deleting it cannot affect a component sibling outside the same branch container.

## Classification rules

Apply rules in this order. First safety match wins unless a later rule only adds provenance.

1. **Scan error**: git or filesystem source failed in a way that prevents safe evaluation → `scan-error`, not actionable.
2. **Container-internal path**: `/workspace`, `/workspace/*`, `/workspace-wt`, `/workspace-wt/*` → `protected-in-use` or `scan-error` with `sandbox-container-path`, not actionable as host cleanup.
3. **Primary worktree**: candidate path equals a component repo path → protected, not actionable.
4. **Live/durable owner**:
   - Any non-archived session, runtime session, live goal, team, delegate, or staff path/cwd/repoWorktrees match → `protected-in-use`, not actionable.
   - Any branch guard from live/durable records in the same repo also protects branch deletion.
5. **Pool entry**:
   - In-memory pool entry or git branch matching `isPoolBranch()` → `pool-entry`.
   - For maintenance UI, pool entries are not default cleanup candidates; pool reclaim may absorb them.
   - If the pool path is stale and not active, pool integration can mark it `ready-to-clean` only for pool-owned deletion/reclaim flows.
6. **Archived-owned git worktree**:
   - Archived session/archived goal metadata owns the path and git metadata still exists → `archived-owned` and `ready-to-clean` if no live owner exists.
   - Preserve archived-session legacy reason `safe-archived-session-worktree`.
7. **Unowned git worktree**:
   - Git metadata exists, branch is a Bobbit branch (`session/*`, `goal/*`, `staff-*`, `pool/_pool-*`, legacy `session/_pool-*`) and no owner exists → `unowned-git-worktree` and actionable if branch deletion guards pass.
   - Detached or non-Bobbit branch worktrees should be `stale-filesystem-only` or protected/needs attention unless an explicit Bobbit record owns them.
8. **Already cleaned**:
   - Durable archived record points at a path, but neither path nor matching git metadata exists → `already-cleaned`.
9. **Filesystem-only**:
   - Directory exists under resolved worktree root without matching git metadata or owner → `stale-filesystem-only`, not default actionable.

`actionable` means the backend is willing to delete the worktree path/git metadata on a cleanup request. `defaultSelected` should be true only for high-confidence safe rows: archived-owned removable rows and unowned Bobbit git worktrees that pass all branch/path guards.

## Cleanup behavior

`WorktreeInventoryService.cleanup()` must never trust a stale client scan.

1. Re-run `scan({ includeAll: true })` at the start of every cleanup call.
2. Resolve requested selectors against the fresh item map.
3. Delete only rows whose fresh classification is actionable and whose `defaultSelected` or explicit-selection policy allows cleanup.
4. For git-known worktrees, call `cleanupWorktree(repoPath, path, branch, false)` first.
5. Verify removal by checking both filesystem path and fresh `git worktree list --porcelain` metadata.
6. Delete branch separately only if `willDeleteBranch` remains true after a fresh guard rebuild.
7. For filesystem-only rows, do not delete by default. If a future manual force action is added, it must be a separate endpoint or explicit mode with a stronger audit trail.
8. Return per-item statuses. Failed or skipped rows should include machine-readable reasons; do not hide partial failures behind a single count.

## Branch deletion guards

Branch deletion is best-effort but must be blocked when any live or durable Bobbit record still references the branch.

Guard key: normalized `repoPath` plus exact `branch`.

Block local and remote branch deletion when any of these references exist in the same repo:

- non-archived persisted session branch;
- runtime session branch;
- live or archived goal branch;
- team lead or team agent branch;
- delegate/child session branch;
- staff branch;
- pool branch/entry;
- another archived session/archived record with the same branch and a different item key.

Implementation should reuse the archived cleanup split:

- Worktree removal can proceed for a safe archived-owned item even when branch deletion is blocked by another archived record.
- Branch deletion requires a fresh guard rebuild immediately before `git branch -D`.
- Remote branch deletion stays best-effort and should continue respecting `shouldSkipRemotePushForTests()`/existing git-test safety from `skills/git.ts`.

## Legacy endpoint adapter plan

### `GET /api/maintenance/orphaned-worktrees`

Delegate to `WorktreeInventoryService.scan()` and filter:

- `classification === "unowned-git-worktree"`
- `actionable === true`
- branch matches current legacy scope initially: `session/*` excluding pool branches

Return the current shape exactly:

```ts
{ worktrees: Array<{ path: string; branch: string; repoPath: string }> }
```

This keeps old UI/tests stable while the canonical inventory can see multi-repo and configured-root cases.

### `POST /api/maintenance/cleanup-worktrees`

Promote this endpoint to canonical cleanup while preserving old requests:

- Old selected body `{ worktrees: [{ path, branch, repoPath }] }` maps to `{ mode: "legacy-orphaned", worktrees }`.
- Empty body `{}` maps to `{ mode: "legacy-orphaned" }` initially, preserving the old `cleaned` count behavior.
- New body `{ mode: "all-safe" }` or `{ mode: "selected", itemIds }` returns the richer cleanup response.

For strict compatibility, when the request is legacy-shaped, respond with `{ cleaned: number }`.

### `GET /api/maintenance/archived-session-worktrees`

Delegate to inventory and transform back to `ArchivedSessionWorktreeScanResponse`:

- Rows with `legacy.archivedSession` become `ArchivedSessionWorktreeItem`.
- Preserve existing names: `status`, `reason`, `disposition`, `selectionCategories`, `willDeleteBranch`, `branchDeleteBlockedReason`, `groups`, `selectionPresets`, and additive `counts`.
- Honor `includeAlreadyCleaned=1` exactly.

### `POST /api/maintenance/cleanup-archived-session-worktrees`

Keep existing validation in `server.ts` or move it to an adapter helper, then call inventory cleanup using archived item keys. Return `CleanupArchivedSessionWorktreesResponse` exactly.

## Boot sweeper integration

Refactor `src/server/agent/worktree-sweeper.ts` in two phases:

1. Replace `classifyWorktrees()` internals with pure helpers exported by `worktree-inventory-classifier.ts`. Keep the current function signature for tests.
2. Replace `sweepOrphanedWorktrees()` scanning with `WorktreeInventoryService.scan({ mode: "boot" })` once the service can be constructed at startup without circular imports.

Boot mode should remain conservative:

- Continue repairing branch-owned path drift with `git worktree repair` where current behavior does so.
- Continue skipping pool branches for pool reclaim unless the pool integration explicitly owns that path.
- Only auto-clean git-known unowned Bobbit worktrees that match the current sweeper's established safe behavior.
- Do not auto-delete filesystem-only directories at boot.

Startup in `server.ts` should pass resolved project/component repo metadata and `worktree_root` through the service rather than hand-building a partial `SweepProject` list.

## Worktree pool integration

Update `src/server/agent/worktree-pool.ts` to stop hardcoding `<repo>-wt` in `reclaimOrphaned()`.

Short-term implementation:

- Do not re-resolve a relative project `worktree_root` against a component repo path. The pool constructor should retain either the project root plus component repo path, or preferably a pre-resolved `resolvedWorktreeRoot` computed once from `worktreeRoot({ rootPath: project.rootPath, worktreeRoot: project.worktreeRoot })` by the project/session setup code.
- `reclaimOrphaned()` should scan `this.resolvedWorktreeRoot` (or the constructor-supplied equivalent) and never fall back to hardcoded `<repo>-wt`.
- For multi-repo entries, recognize branch containers and per-repo `.git` files from `PoolEntry.worktrees` layout.
- Add a read-only `snapshotEntries()` method returning ready pool entries:

```ts
interface WorktreePoolSnapshot {
  entries: Array<{
    branchName: string;
    worktreePath: string;
    worktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>;
    createdAt: number;
  }>;
  target: number;
  filling: boolean;
}
```

Long-term integration:

- Let `WorktreeInventoryService` classify pool-shaped filesystem/git entries.
- Keep `WorktreePool.reclaimOrphaned()` responsible for mutating the in-memory pool, but feed it candidates from shared classification helpers so pool and maintenance agree on branch/root/path rules.
- Pool reclaim may absorb safe pool entries; maintenance cleanup should not steal pool entries that the pool can reuse unless the user explicitly asks to clean pool-owned residue in a future mode.

## Test seams

### Unit tests

Add tests around pure helpers in `tests/worktree-inventory.test.ts` or equivalent:

- Live referenced worktree is `protected-in-use` by exact `worktreePath`.
- Live referenced worktree is protected when `cwd` is inside the candidate.
- Archived-session-owned git worktree is `ready-to-clean` and maps to legacy `removable`.
- Git-known orphan `session/*` worktree is `unowned-git-worktree` and legacy orphan adapter includes it.
- Pool branch/worktree entry is classified as `pool-entry` and not default-selected by maintenance.
- Configured `worktree_root` is honored via `worktreeRoot()` for filesystem discovery, including a relative `worktree_root` in a multi-repo project where the pool repo path is a component subdirectory.
- Filesystem-only directory under a worktree root is `stale-filesystem-only` and not actionable.
- Multi-repo/polyrepo component repos produce separate repo-scoped candidates under one branch container.
- Branch deletion is blocked by live session/goal/team/staff references.
- Branch deletion is blocked by another archived record but worktree removal remains allowed.
- Container-internal paths are never actionable host cleanup targets.

Keep `tests/worktree-sweeper.test.ts` and `tests/worktree-sweeper-multi.test.ts` green by adapting `classifyWorktrees()` to the shared classifier.

### API E2E

Extend `tests/e2e/maintenance-api.spec.ts`:

- `GET /api/maintenance/worktrees` returns summary counts and item provenance.
- Legacy `GET /api/maintenance/orphaned-worktrees` still returns `{ worktrees }` and is backed by the same fixture classification.
- Legacy `GET /api/maintenance/archived-session-worktrees` still returns sessions/items/groups/presets/counts.
- Legacy `POST /api/maintenance/cleanup-worktrees` still returns `{ cleaned }` for old bodies.
- New cleanup modes re-run inventory and skip rows that became protected between scan and cleanup.
- Multi-repo project with configured `worktree_root` is discovered through the canonical route.

### Integration/manual checks

- Boot with stale unowned git worktree: sweeper logs cleanup as before.
- Boot with stale filesystem-only directory under worktree root: inventory reports needs attention; boot does not delete.
- Pool restart with leftover `pool/_pool-*`: pool reclaim uses configured root and reclaims without maintenance duplication.
