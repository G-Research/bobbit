# Unified Worktree Cleanup UI

## Purpose

Replace the separate Settings → Maintenance worktree cards with one canonical **Worktree Cleanup** card powered by the unified inventory API:

- `GET /api/maintenance/worktrees`
- `POST /api/maintenance/cleanup-worktrees`

The card should preserve the current safety affordances from Archived Session Worktrees while also covering orphaned Git worktrees, pool entries, and filesystem-only leftovers without adding another maintenance surface.

## Current UI research

Settings → Maintenance currently renders two overlapping worktree surfaces in `src/app/settings-page.ts`:

1. **Orphaned Worktrees**
   - Calls `GET /api/maintenance/orphaned-worktrees`.
   - Stores rows in `maintenanceWorktrees: Array<{ path; branch }>`.
   - Displays a simple path + branch list.
   - Calls `POST /api/maintenance/cleanup-worktrees` for cleanup.
   - No row selection, no provenance, no troubleshooting grouping, no stable card-level test id.

2. **Archived Session Worktrees**
   - Calls `GET /api/maintenance/archived-session-worktrees`.
   - Has the stronger UX pattern and should be the basis for the unified card:
     - `data-testid="archived-worktree-maintenance"`
     - summary chips: ready, selected, already cleaned, needs attention;
     - actionable rows shown by default;
     - skipped/ineligible examples hidden behind a troubleshooting disclosure;
     - selected and clean-all flows;
     - cleanup result banner;
     - server-authoritative rescan after cleanup;
     - grouped diagnostic examples by reason.
   - Current browser tests pin this behavior in `tests/e2e/ui/settings-maintenance-archived-worktrees.spec.ts`, `tests/ui-fixtures/search-preview-maintenance.spec.ts`, and `tests/ui-fixtures/settings-admin-fixture.spec.ts`.

The unified design should keep the archived card’s actionable-first interaction model, but remove the confusing split between “Orphaned Worktrees” and “Archived Session Worktrees”.

## Unified card layout

Place the card in the existing Maintenance tab where the two old worktree cards are today, after Agent Directory and Search Index and before Orphaned Sessions.

```text
[Worktree Cleanup]                                      [Scan] [Clean all safe candidates (N)]
Find stale Bobbit worktrees across sessions, archives, goals, teams, delegates, staff, pools, Git metadata, and worktree roots.

[Ready to clean: N] [Selected: N] [Protected/in use: N] [Already cleaned: N] [Needs attention: N]
Scanned X projects, Y repos, Z worktree-root directories. Last scanned 10:42 AM.

Helper text / latest result banner

Selection presets / filters
[Select all safe] [Current project] [Archived-owned] [Git orphan] [Pool entries] [Clear]

Actionable safe rows only
[checkbox] Ready to clean  Archived cleanup target  default  app
           Safe to remove: no live or durable Bobbit record references this worktree or branch.
           repo: app     branch: session/archived-alpha
           worktree: C:/repo-wt/session-archived-alpha
           sources: Bobbit state, Git metadata
           Branch will be deleted

[Clean selected (N)]  N selected

[Show protected, already cleaned, and needs-attention diagnostics]
```

### Visual treatment

Use the same primitives already used by the Maintenance tab:

- Card: `flex flex-col gap-2 rounded-md border border-border p-4`.
- Primary actions: existing `actionBtnClass` (`bg-primary text-primary-foreground`).
- Secondary actions: existing `scanBtnClass` (`border border-input bg-background`).
- Rows: current archived row density (`rounded border border-border bg-background/70 p-2 text-xs`).
- Summary chips: current archived chip pattern (`rounded-md border border-border bg-secondary/30 px-3 py-2`).
- Status badges retain semantic color usage:
  - Ready: emerald treatment currently used by archived rows.
  - Protected / needs attention: amber treatment.
  - Failed: destructive treatment.
  - Already cleaned: secondary / muted treatment.

Do not introduce a new visual component unless implementation discovers an existing shared primitive that should replace these ad hoc classes.

## Inventory shape expected by UI

The UI should not infer safety from path text. It should render server classifications directly.

Minimum row fields needed:

```ts
type WorktreeMaintenanceItem = {
  id: string;
  classification:
    | "ready-to-clean"
    | "protected-in-use"
    | "archived-owned"
    | "unowned-git-worktree"
    | "pool-entry"
    | "already-cleaned"
    | "stale-filesystem-only"
    | "scan-error";
  disposition: "ready-to-clean" | "protected" | "already-cleaned" | "needs-attention" | "failed";
  actionable: boolean;
  selectable: boolean;
  defaultSelected: boolean;
  projectId?: string;
  projectName?: string;
  repo?: string;
  repoPath?: string;
  repoDisplayName?: string;
  path: string;
  branch?: string;
  sources: Array<"runtime-session" | "persisted-live-session" | "archived-session" | "goal" | "team" | "delegate" | "staff" | "pool" | "git-worktree" | "filesystem">;
  owners?: Array<{ type: string; id: string; title?: string; archived?: boolean }>;
  reason: string;
  detail: string;
  willDeleteBranch: boolean;
  branchDeleteBlockedReason?: string;
};
```

This is the public REST DTO consumed by the UI. The UI may group sources into display labels such as “Bobbit state” or “Git metadata”, but it must keep the server-provided `classification`, `reason`, `id`, and owner/source provenance intact for cleanup requests and troubleshooting.

Counts should be additive and stable for summary chips:

```ts
type WorktreeMaintenanceCounts = {
  totalItems: number;
  readyToClean: number;
  defaultSelected: number;
  protectedInUse: number;
  alreadyCleaned: number;
  needsAttention: number;
  failed: number;
  byClassification: Record<string, number>;
  byReason: Record<string, number>;
  bySource: Record<string, number>;
};
```

## Summary chips

Render after scan only. Chips are both summary and navigation affordances.

1. **Ready to clean**
   - Count: server `readyToClean`.
   - Click focuses the actionable list if count > 0.
2. **Selected**
   - Count: current selected safe rows.
   - Non-clickable.
3. **Protected/in use**
   - Count: protected live/durable references.
   - Click opens troubleshooting and focuses the first protected group.
4. **Already cleaned**
   - Count: items where Bobbit remembers metadata but no cleanup remains.
   - Click opens troubleshooting and focuses the already-cleaned group.
5. **Needs attention**
   - Count: filesystem-only leftovers, scan errors, failed cleanup, or other non-actionable rows.
   - Click opens troubleshooting and focuses the first attention group.

Keep “Ready to clean” first. Operators should not have to parse protected diagnostics before seeing the safe action.

## Actionable-first row behavior

Default view shows only rows where `actionable === true` and `selectable !== false`.

Safe row content:

- Status badge: “Ready to clean”.
- Primary label: best available owner title, branch slug, or folder name.
- Secondary chips: project, repo/component, classification label.
- Reason line: server-provided `detail`, not client-generated safety claims.
- Metadata grid:
  - `repo`
  - `repo path`
  - `branch`
  - `worktree`
  - `sources`
  - owner ids when relevant.
- Branch outcome:
  - “Branch will be deleted” when `willDeleteBranch` is true.
  - “Branch will be kept: {reason}” when blocked.
  - “No branch recorded” when absent.
- `<details>` technical section with classification, disposition, reason, source list, item id, and raw owner ids.

Selection behavior:

- On scan, preselect all actionable rows where `defaultSelected !== false`.
- Keep row checkboxes enabled only for safe candidates.
- Hidden/protected rows are never selectable.
- “Clean selected” disabled when selected count is 0.
- Preserve selection by `id` across a rescan when the row still exists and remains selectable; drop stale ids.

## Cleanup flows

### Scan

- Button label before first scan: “Scan”.
- Button label after scan: “Rescan”.
- Loading label: “Scanning…”.
- On success:
  - normalize counts;
  - initialize default selection;
  - clear old cleanup result unless scan was triggered by cleanup rescan;
  - collapse troubleshooting.
- On failure:
  - show an assertive error message;
  - render an empty failed scan state;
  - keep cleanup buttons disabled.

### Clean all safe candidates

- Button: `Clean all safe candidates (N)`.
- Enabled only after scan and `readyToClean > 0`.
- Opens confirmation dialog before POST:
  - Title: `Clean N worktree(s)?`
  - Body: `Bobbit will rescan before deleting and will remove only server-classified safe candidates. Transcripts, archived sessions, goals, proposals, prompts, and search records are preserved.`
  - Confirm label: `Clean worktrees`.
- POST body: `{ mode: "all-safe" }`.
- Server must rescan before deleting; UI should say this explicitly in helper text.
- After success, immediately rescan and keep the cleanup result banner visible.

### Clean selected

- Button: `Clean selected (N)`.
- Enabled only when `selectedCount > 0`.
- POST body:

```json
{
  "mode": "selected",
  "itemIds": ["..."]
}
```

The canonical UI must use item ids from the fresh inventory. Legacy `{ worktrees: [...] }` selectors are reserved for compatibility adapters and should not be used by the unified card.

After success:

- Show cleanup result banner.
- Rescan.
- Removed rows disappear from the actionable list.
- Failed/skipped cleanup results appear in troubleshooting, auto-expanded when attention is needed.

## Troubleshooting disclosure

Disclosure label should adapt to state:

- When safe candidates exist: `Show protected, already cleaned, and needs-attention diagnostics`.
- When no safe candidates exist: `Show why not removable`.
- Expanded label: `Hide diagnostics`.

Panel copy:

> These records are not cleanup actions. They are shown for troubleshooting and audit only.

Group by server `reason` or `classification`, not by client-derived status. Recommended group order:

1. Protected/in use
2. Needs attention
3. Already cleaned
4. Scan errors / cleanup failures

Each group includes:

- Group heading and count.
- Server detail/description.
- First five examples by default.
- “Show all (N)” when more than five.
- Non-selectable rows using the same row renderer, without checkbox.

Filesystem-only directories should appear in troubleshooting as **Needs attention**, unless the server classifies them with strict Bobbit-owned safety rules. The row should explain why manual inspection is required.

## Empty states

### Before scan

Show no rows. Helper text:

> Scan first to find safe cleanup candidates.

Both cleanup buttons are disabled.

### Scan complete, no safe candidates

Card body:

> Nothing safe to clean right now.
>
> Bobbit scanned known sessions, archives, goals, teams, delegates, staff, pool entries, Git worktree metadata, and worktree-root directories. No server-classified safe worktree cleanup candidates were found.

If `alreadyCleaned > 0` or `needsAttention > 0`, keep the troubleshooting disclosure visible below this message.

### All clean

When all counts except `alreadyCleaned` are zero:

> Worktree inventory is clean.
>
> No active cleanup or attention items were found.

### Error state

Show an assertive inline error above helper text:

> Worktree scan failed: {message}

If partial results are available, render them with a `Scan incomplete` warning chip and disable cleanup unless the server explicitly marks candidates actionable from a complete fresh scan.

### Cleanup finished with attention needed

Use the existing cleanup result banner pattern, with `aria-live="assertive"`:

> Cleanup finished with attention needed.
> Cleaned: X, branches deleted: Y, skipped: Z, already cleaned: A, failed: F.

Automatically expand troubleshooting if skipped or failed is non-zero.

## Accessibility

- Card container:
  - `role="region"`
  - `aria-labelledby="worktree-cleanup-title"`
  - `data-testid="worktree-cleanup-maintenance"`
- Summary chips:
  - Buttons only when interactive.
  - Use visible text labels plus counts; color is not the only signal.
  - Clickable chips must have focus rings and `aria-controls` for the target list/panel.
- Actionable list:
  - `id="worktree-cleanup-actionable-list"`
  - `tabindex="-1"` for chip focus navigation.
  - Checkboxes use explicit `aria-label` including title, repo, branch, and path.
- Troubleshooting panel:
  - Disclosure button uses `aria-expanded` and `aria-controls="worktree-cleanup-troubleshooting-panel"`.
  - Panel has `tabindex="-1"` for summary-chip focus.
- Loading and results:
  - Scan/cleanup result region uses `aria-live="polite"`.
  - Errors and cleanup-with-failures use `aria-live="assertive"`.
- Keyboard:
  - All buttons and row checkboxes are reachable by Tab.
  - Row `<details>` technical sections use native summary keyboard behavior.
- Text must remain readable at current Maintenance density (`text-xs` is acceptable only for metadata; primary row labels stay at least current archived-card size).

## Proposed test IDs

Use new IDs for the canonical card. Keep old IDs only in compatibility tests if legacy wrappers remain temporarily.

| Element | Test id / attribute |
| --- | --- |
| Card | `worktree-cleanup-maintenance` |
| Title | `worktree-cleanup-title` |
| Scan button | `worktree-cleanup-scan` |
| Clean all button | `worktree-cleanup-clean-all` |
| Clean selected button | `worktree-cleanup-clean-selected` |
| Helper text | `worktree-cleanup-helper` |
| Cleanup result | `worktree-cleanup-result` |
| Error | `worktree-cleanup-error` |
| Empty state | `worktree-cleanup-empty-state` |
| Actionable list | `worktree-cleanup-actionable-list` |
| Row | `worktree-cleanup-row` |
| Row item id | `data-worktree-id` |
| Row disposition | `data-disposition` |
| Row classification | `data-classification` |
| Row reason | `data-reason` |
| Summary ready | `worktree-cleanup-summary-ready` |
| Summary selected | `worktree-cleanup-summary-selected` |
| Summary protected | `worktree-cleanup-summary-protected` |
| Summary already cleaned | `worktree-cleanup-summary-already-cleaned` |
| Summary needs attention | `worktree-cleanup-summary-needs-attention` |
| Select all safe | `worktree-cleanup-select-all-safe` |
| Select current project | `worktree-cleanup-select-current-project` |
| Select archived-owned | `worktree-cleanup-select-archived-owned` |
| Select Git orphan | `worktree-cleanup-select-git-orphan` |
| Select pool entries | `worktree-cleanup-select-pool-entry` |
| Clear selection | `worktree-cleanup-clear-selection` |
| Troubleshooting toggle | `worktree-cleanup-show-diagnostics` |
| Troubleshooting panel | `worktree-cleanup-troubleshooting` |
| Troubleshooting group | `worktree-cleanup-group-{sanitized-reason}` |
| Show all group examples | `worktree-cleanup-show-all-{sanitized-reason}` |

Also set stable action attributes for fixture tests:

- `data-action="scan-worktrees"`
- `data-action="cleanup-all-worktrees"`
- `data-action="cleanup-selected-worktrees"`

## Compatibility migration for old cards

1. **Backend compatibility**
   - Existing endpoints remain:
     - `GET /api/maintenance/orphaned-worktrees`
     - `GET /api/maintenance/archived-session-worktrees`
     - `POST /api/maintenance/cleanup-archived-session-worktrees`
   - They should delegate to/filter the unified inventory and preserve current response shapes while tests and external callers migrate.

2. **UI migration**
   - Replace the visible “Orphaned Worktrees” and “Archived Session Worktrees” cards with one “Worktree Cleanup” card.
   - Do not render old cards hidden in the DOM; that creates duplicate screen-reader regions and duplicate actions.
   - During the PR that changes UI tests, update fixtures to route the unified API. Keep a small API E2E suite for legacy endpoint response shapes.

3. **Copy migration**
   - Old “Orphaned Worktrees” meaning becomes a classification/filter: `Unowned Git worktree`.
   - Old “Archived Session Worktrees” meaning becomes `Archived-owned` plus owner/source fields.
   - The unified card description should mention both so existing users can find the feature:
     > Reclaim safe Bobbit worktrees from archived sessions, orphaned Git metadata, pool entries, and known worktree roots.

4. **Test migration**
   - Tests that only validate archived-card behavior should be rewritten against the unified test IDs and fixture data containing mixed classifications.
   - Keep legacy endpoint tests in `maintenance-api.spec.ts` to prove adapters still return `worktrees`, `sessions/items/groups`, and current cleanup validation shapes.

## Browser E2E scenarios

Add/replace browser E2E coverage for Settings → Maintenance.

1. **Initial state and scan**
   - Navigate to `#/settings/system/maintenance`.
   - Assert one visible `worktree-cleanup-maintenance` card.
   - Assert no visible “Orphaned Worktrees” or “Archived Session Worktrees” cards/headings.
   - Cleanup buttons disabled before scan.
   - Click scan; assert `GET /api/maintenance/worktrees`.

2. **Actionable-first mixed inventory**
   - Fixture includes:
     - one archived-owned ready candidate;
     - one unowned Git worktree ready candidate;
     - one pool entry ready candidate;
     - one protected live-session row;
     - one filesystem-only needs-attention row;
     - one already-cleaned row.
   - After scan:
     - summary chips show all counts;
     - only three ready rows are visible;
     - protected/attention/already-cleaned rows are hidden;
     - ready rows are checked by default and have enabled checkboxes;
     - branch outcome text is visible.

3. **Troubleshooting disclosure**
   - Click `worktree-cleanup-show-diagnostics`.
   - Assert protected, filesystem-only, and already-cleaned groups appear.
   - Assert diagnostic rows have no checkbox.
   - Assert “Show all (N)” expands groups over five examples.

4. **Selected cleanup**
   - Uncheck one ready row.
   - Assert selected chip and `Clean selected (N)` update.
   - Click clean selected.
   - Assert POST body uses `{ mode: "selected", itemIds: [...] }` with only selected item ids.
   - Assert UI rescans and removed rows disappear.
   - Assert cleanup result banner remains visible.

5. **Clean all safe candidates**
   - Mixed fixture with two ready rows.
   - Click clean all.
   - Confirm dialog.
   - Assert POST body `{ mode: "all-safe" }`.
   - Assert rescan occurs and ready count becomes zero.
   - Assert cleanup buttons disabled.

6. **Zero safe candidates**
   - Fixture has only protected, already-cleaned, and needs-attention rows.
   - Assert empty state says “Nothing safe to clean right now”.
   - Assert cleanup buttons disabled.
   - Assert diagnostics disclosure is available and reveals reasons.

7. **Error and partial failure**
   - Scan returns 500: assert `worktree-cleanup-error`, cleanup disabled.
   - Cleanup response has skipped/failed results: assert assertive result banner and auto-expanded diagnostics.

8. **Persistence across tab switch / reload refresh**
   - Scan and verify rows.
   - Switch to another Settings tab and back; existing in-memory scan remains visible during the same app session.
   - Reload page; scan state resets to pre-scan and requires a fresh server inventory.

9. **Legacy endpoint compatibility in UI fixtures**
   - Fixture no longer expects the UI to call old worktree endpoints.
   - Separate API E2E still asserts old routes return compatible shapes while backed by unified inventory.

## Consistency rationale

This design deliberately reuses the existing Archived Session Worktrees primitives because that card already solved the hard interaction problems: safe defaults, auditability, grouped diagnostics, selected/all cleanup, and rescan-after-cleanup. The only new surface is the unified classification vocabulary and added provenance fields. The implementation should move forward by generalizing those patterns, not by inventing a third maintenance scanner.
