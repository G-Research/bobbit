# Archived session worktree API/data contract plan

## Purpose

Define the API contract that supports the revised Settings → Maintenance archived worktree UX while preserving the existing cleanup safety model and current endpoint compatibility.

Primary UX question: **how many archived-session worktrees can be cleaned safely right now?** The API should make this answer explicit with `readyToClean` / `removableWorktrees`, while moving skipped and diagnostic data behind reasoned groups.

## Existing endpoints to preserve

### `GET /api/maintenance/archived-session-worktrees`

Current query:

- `includeAlreadyCleaned=1` — include `already-cleaned` rows for diagnostics. Default scans omit sessions whose rows are all already cleaned.

### `POST /api/maintenance/cleanup-archived-session-worktrees`

Current request support must remain valid:

```ts
type CleanupArchivedSessionWorktreesRequestV1 =
  | { mode: "all" }
  | {
      mode: "selected";
      sessionIds?: string[];
      worktrees?: Array<{
        sessionId: string;
        repo?: string;
        path?: string;
        key?: string;
      }>;
    };
```

Existing validation must remain:

- Missing/unknown `mode` returns `400`.
- `mode: "all"` rejects selectors.
- `mode: "selected"` accepts exactly one selector type: `sessionIds` or `worktrees`.
- Empty selected input is a zero-count no-op.
- Cleanup re-runs scan and does not trust stale client state.

## Scan response contract

Return the current `sessions` tree and legacy count names, then add flattened item and grouping metadata for the UX. Legacy fields remain authoritative for old clients; new fields are additive.

```ts
interface ArchivedSessionWorktreeScanResponseV2 {
  sessions: ArchivedSessionWorktreeSessionV2[];
  items: ArchivedSessionWorktreeItemV2[]; // flattened copy of every session.worktrees row included in this response
  counts: ArchivedSessionWorktreeScanCountsV2;
  groups: ArchivedSessionWorktreeGroup[];
  selectionPresets: ArchivedSessionWorktreeSelectionPreset[];
  generatedAt: number;
}

interface ArchivedSessionWorktreeScanCountsV2 {
  // Existing names; keep for compatibility.
  archivedSessions: number;
  sessionsWithWorktrees: number; // legacy label: has worktree metadata, not necessarily removable
  removableWorktrees: number; // same value as readyToClean
  skippedWorktrees: number;
  alreadyCleanedWorktrees: number;

  // UX-facing names.
  totalItems: number;
  readyToClean: number;
  defaultSelected: number; // rows the UI should select after scan; initially equals readyToClean
  alreadyCleaned: number;
  ineligible: number;
  needsAttention: number;
  failed: number;

  byDisposition: Record<ArchivedWorktreeDisposition, number>;
  byReason: Partial<Record<ArchivedWorktreeReason, number>>;
  bySelectionCategory: Partial<Record<ArchivedWorktreeSelectionCategory, number>>;
}
```

### Dispositions

`status` stays compatible with the current implementation. `disposition` is the UX grouping field.

```ts
type ArchivedWorktreeLegacyStatus = "removable" | "skipped" | "already-cleaned";

type ArchivedWorktreeDisposition =
  | "ready-to-clean"      // actionable now
  | "already-cleaned"     // no worktree remains; hidden by default unless diagnostics requested
  | "ineligible"          // safe skip; not actionable through this feature
  | "needs-attention"     // not safe to remove automatically, but may merit manual inspection
  | "failed";             // scan/evaluation failed
```

Mapping:

- `status: "removable"` → `disposition: "ready-to-clean"`.
- `status: "already-cleaned"` → `disposition: "already-cleaned"`.
- `status: "skipped"` with `reason: "stale-worktree-directory"` → `disposition: "needs-attention"`.
- Other `status: "skipped"` reasons → `disposition: "ineligible"`.
- Scan exceptions, if surfaced in the future, use `disposition: "failed"` and `reason: "scan-error"`.

### Reason codes

Use machine-readable reason codes in `reason`. Do not make the UI parse `detail` text.

```ts
type ArchivedWorktreeReason =
  | "safe-archived-session-worktree"
  | "already-cleaned"
  | "no-worktree-path"
  | "missing-repo-path"
  | "sandbox-container-path"
  | "delegate-shared-worktree"
  | "stale-worktree-directory"
  | "referenced-by-live-session"
  | "referenced-by-live-goal"
  | "referenced-by-live-team"
  | "referenced-by-staff"
  | "scan-error";

type ArchivedWorktreeReasonCategory =
  | "safe"
  | "already-cleaned"
  | "missing-metadata"
  | "container-path"
  | "shared-delegate"
  | "stale-path"
  | "referenced-record"
  | "error";
```

Reason category mapping:

| Reason | Category | Default UX treatment |
| --- | --- | --- |
| `safe-archived-session-worktree` | `safe` | visible/actionable |
| `already-cleaned` | `already-cleaned` | hidden by default |
| `no-worktree-path` | `missing-metadata` | troubleshooting only |
| `missing-repo-path` | `missing-metadata` | troubleshooting only |
| `sandbox-container-path` | `container-path` | troubleshooting only |
| `delegate-shared-worktree` | `shared-delegate` | troubleshooting only |
| `stale-worktree-directory` | `stale-path` | needs-attention troubleshooting |
| `referenced-by-live-session` | `referenced-record` | troubleshooting only |
| `referenced-by-live-goal` | `referenced-record` | troubleshooting only |
| `referenced-by-live-team` | `referenced-record` | troubleshooting only |
| `referenced-by-staff` | `referenced-record` | troubleshooting only |
| `scan-error` | `error` | needs-attention troubleshooting |

### Session and item metadata

`ArchivedSessionWorktreeSessionV2` keeps the existing session envelope and uses the same item shape as the flattened `items` array.

```ts
interface ArchivedSessionWorktreeSessionV2 {
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
  worktrees: ArchivedSessionWorktreeItemV2[];
}
```

Each row should contain enough metadata for a flat actionable list, grouped examples, and selected cleanup without consulting parent session objects.

```ts
interface ArchivedSessionWorktreeItemV2 {
  // Stable selector identity.
  key: string; // `${sessionId}:${repo}:${normalizedPath}`
  sessionId: string;

  // Duplicated session metadata for flat rendering.
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

  // Worktree/repo metadata.
  repo: string; // `.` for root repo; component key for multi-repo rows
  repoPath: string;
  repoDisplayName: string; // `.` becomes project/repo name; component keys remain readable
  path: string;
  branch?: string;
  source: "repoWorktrees" | "sessionWorktree";

  // Existing safety/evaluation fields.
  pathExists: boolean;
  gitWorktreeMetadataExists: boolean;
  localBranchExists: boolean;
  status: ArchivedWorktreeLegacyStatus;
  reason: ArchivedWorktreeReason;
  detail: string;
  willDeleteBranch: boolean;
  branchDeleteBlockedReason?: "branch-referenced-by-live-record";

  // UX/action fields.
  disposition: ArchivedWorktreeDisposition;
  reasonCategory: ArchivedWorktreeReasonCategory;
  actionable: boolean; // true only for disposition `ready-to-clean`
  selectable: boolean; // true only when cleanup can be requested for this row
  defaultSelected: boolean; // true for actionable rows after scan
  selectionCategories: ArchivedWorktreeSelectionCategory[];
}
```

`selectionCategories` are non-exclusive tags used for one-click selection presets:

```ts
type ArchivedWorktreeSelectionCategory =
  | "archived-session"
  | "goal-session"
  | "team-session"
  | "delegate-session"
  | "child-session"
  | "single-repo"
  | "multi-repo";
```

Category derivation:

- Always include `archived-session`.
- Include `goal-session` when `goalId` is present.
- Include `team-session` when `teamGoalId` is present.
- Include `delegate-session` when `delegateOf` is present.
- Include `child-session` when `parentSessionId` or `childKind` is present.
- Include `multi-repo` when the item came from `repoWorktrees`; otherwise include `single-repo`.

### Groups and examples

The server should return stable groups so the UI can show representative examples without rendering hundreds of skipped rows.

```ts
interface ArchivedSessionWorktreeGroup {
  key: string; // e.g. `ready-to-clean`, `reason:no-worktree-path`, `reason:referenced-by-live-session`
  label: string;
  description: string;
  disposition: ArchivedWorktreeDisposition;
  reason?: ArchivedWorktreeReason;
  reasonCategory?: ArchivedWorktreeReasonCategory;
  count: number;
  sampleKeys: string[]; // first five matching item keys, stable scan order
  hasMore: boolean;
  actionable: boolean;
}
```

Required groups when count is non-zero:

- `ready-to-clean`
- `already-cleaned`
- `reason:no-worktree-path`
- `reason:missing-repo-path`
- `reason:sandbox-container-path`
- `reason:delegate-shared-worktree`
- `reason:stale-worktree-directory`
- `reason:referenced-by-live-session`
- `reason:referenced-by-live-goal`
- `reason:referenced-by-live-team`
- `reason:referenced-by-staff`
- `reason:scan-error`

The UI default view should render only `ready-to-clean` rows. Other groups power “Why not removable?” / “Show skipped or ineligible items”.

### Selection presets

The server should describe available one-click presets from the fresh scan. Presets select only `actionable` items.

```ts
interface ArchivedSessionWorktreeSelectionPreset {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  count: number;
  worktreeKeys: string[]; // actionable item keys matching this preset
  cleanupRequest: CleanupArchivedSessionWorktreesRequestV2;
}
```

Required presets:

- `all-removable` — all actionable rows; cleanup request `{ mode: "all" }`.
- `category:archived-session` — all actionable archived-session rows.
- `category:goal-session` — actionable goal-linked archived sessions, only when present.
- `category:team-session` — actionable team-linked archived sessions, only when present.
- `category:delegate-session` — actionable delegate archived sessions with independent worktrees, only when present.
- `project:<projectId>` — actionable rows for each project represented in the scan.
- `repo:<normalizedRepoPath>` — actionable rows for each repository represented in the scan.

## Cleanup request additions

Keep current `mode: "all"` and `mode: "selected"`. Add category/preset modes only as additive support; older clients can keep posting selected `worktrees`.

```ts
type CleanupArchivedSessionWorktreesRequestV2 =
  | CleanupArchivedSessionWorktreesRequestV1
  | {
      mode: "category";
      categories: ArchivedWorktreeSelectionCategory[];
      projectId?: string;
      repoPath?: string;
    }
  | {
      mode: "preset";
      presetId: string;
    };
```

Semantics:

- `mode: "all"` means clean every fresh-scan item with `status: "removable"`.
- `mode: "selected"` with `sessionIds` means clean every fresh-scan removable item for those archived sessions.
- `mode: "selected"` with `worktrees` means clean exactly matched fresh-scan rows by `key`, or by `sessionId` + `repo` + `path` when no key is provided.
- `mode: "category"` means clean fresh-scan removable rows whose `selectionCategories` include at least one requested category, then apply optional `projectId` and normalized `repoPath` filters.
- `mode: "preset"` means resolve `presetId` against the same preset definitions as the fresh scan. Dynamic project/repo presets must be re-derived from the fresh scan, not trusted from the client.
- Invalid category/preset values return `400`.
- Empty category/preset matches return a zero-cleaned success response, not an error.

## Cleanup response contract

Preserve current counts and result fields, then add reason/disposition summaries.

```ts
interface CleanupArchivedSessionWorktreesResponseV2 {
  counts: CleanupArchivedSessionWorktreeCountsV2;
  results: ArchivedSessionWorktreeCleanupResultV2[];
  generatedAt: number;
}

interface CleanupArchivedSessionWorktreeCountsV2 {
  // Existing names; keep for compatibility.
  requested: number;
  cleaned: number;
  branchDeleted: number;
  skipped: number;
  alreadyCleaned: number;
  failed: number;

  // UX diagnostics.
  worktreeRemoved: number; // successful physical/git worktree removals; normally equals cleaned
  invalidSelection: number;
  notActionable: number;
  byStatus: Partial<Record<ArchivedWorktreeCleanupStatus, number>>;
  byReason: Partial<Record<ArchivedWorktreeCleanupReason, number>>;
}

type ArchivedWorktreeCleanupStatus = "cleaned" | "skipped" | "already-cleaned" | "failed";

type ArchivedWorktreeCleanupReason =
  | "worktree-and-branch-cleaned"
  | "worktree-cleaned"
  | "already-cleaned"
  | "invalid-selection"
  | ArchivedWorktreeReason;

interface ArchivedSessionWorktreeCleanupResultV2 {
  key: string;
  sessionId: string;
  title?: string;
  repo?: string;
  repoPath?: string;
  path?: string;
  branch?: string;
  status: ArchivedWorktreeCleanupStatus;
  reason?: ArchivedWorktreeCleanupReason;
  detail?: string;
  error?: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}
```

Result rules:

- A fresh removable item that cleans successfully returns `status: "cleaned"` and reason `worktree-and-branch-cleaned` or `worktree-cleaned`.
- A stale selected item with no remaining worktree path/git metadata returns `status: "already-cleaned"`, `reason: "already-cleaned"`.
- A selected item that is matched but no longer removable returns `status: "skipped"` and the fresh scan reason.
- A selector that cannot be matched returns `status: "skipped"`, `reason: "invalid-selection"`.
- Per-item failures return `status: "failed"`, preserve selector metadata, and increment only `failed`.

## Server-side guard invariants

The server remains the source of truth. UI selection, category, or preset requests must never bypass these guards.

1. Cleanup always starts with a fresh `listArchivedSessionWorktrees(true)` scan.
2. Only items whose fresh scan status is `removable` may call git cleanup.
3. Archived session metadata, transcripts, proposals, prompts, colors, search/archive visibility, and persisted session rows are never deleted or mutated by this feature.
4. Candidate sessions come from archived sessions in visible project contexts; hidden/synthetic contexts are not cleanup candidates.
5. Guard references come from all project contexts, not only visible contexts.
6. Never remove a worktree referenced by any non-archived persisted session, runtime session, persisted goal, team entry/agent, staff record, delegate parent, or multi-repo sibling record.
7. `repoWorktrees` are evaluated one repo item at a time; never fall back to the flat `worktreePath` when `repoWorktrees` exists.
8. Container-internal paths under `/workspace` or `/workspace-wt` are skipped with `sandbox-container-path` unless a host worktree path is explicitly recorded.
9. Existing directories without matching git worktree metadata are `stale-worktree-directory` and are not removed by archived-session cleanup.
10. Branch-only residue is `already-cleaned`; archived-session cleanup must not call git solely to delete a branch.
11. Branch deletion is allowed only after the worktree is removed and the same branch is absent from branch guard sets for the same `repoPath`.
12. Branch deletion failure must not turn a successful worktree removal into a failed cleanup; report `branchDeleted: false`.
13. Cleanup is best-effort per item; one failure must not abort the request.
14. `mode: "preset"` and `mode: "category"` must resolve against the fresh scan and then apply the same removable-only filtering.

## UI usage guidance

- Primary summary: `Ready to clean: counts.readyToClean`.
- Secondary summary: `Already cleaned`, `Needs attention`, and `Ineligible` from v2 counts.
- Do not use `sessionsWithWorktrees` as a primary label. If shown, label it “Has worktree metadata, not necessarily removable”.
- If `readyToClean === 0`, disable cleanup actions and show an empty state: “There are no archived-session worktrees that are safe to clean right now.”
- Render skipped/ineligible/needs-attention rows only after an explicit troubleshooting disclosure or group jump.
- “Clean all safe candidates” should post `{ mode: "all" }`.
- “Clean selected” can post existing selected `worktrees` keys for maximum compatibility, even when the selection came from a server preset.
