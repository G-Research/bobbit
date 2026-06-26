# Archived Session Worktree UX Test Plan

## Scope

This plan covers the archived-session worktree maintenance reattempt. It is a test strategy only; implementation should update the test files named below after the API/UI contract lands.

Primary risks to pin:

- Users must see the actionable answer first: `Ready to clean`, not ambiguous `With worktrees`.
- Skipped/ineligible records must not dominate the default UI.
- Cleanup must remain server-authoritative and must never remove worktrees or branches still referenced by live sessions, goals, team/delegate records, staff, or multi-repo sibling records.
- Archived sessions, transcript files, and metadata must survive worktree cleanup.

## Existing coverage reviewed

- `tests/e2e/maintenance-api.spec.ts`
  - Already seeds archived sessions directly through the isolated gateway project context.
  - Already covers current scan/cleanup shape, selected cleanup, already-cleaned behavior, stale directories, key/session mismatch, sandbox container paths, multi-repo rows, and live-session guard.
  - Needs expansion for the new UX-oriented contract: action categories, machine-readable reason/category fields, grouped summary counts, category cleanup/selection support if added, and guard behavior in `mode: all` or category cleanup.
- `tests/e2e/ui/settings*.spec.ts`
  - Existing spawned-browser settings specs cover route/navigation-level behavior only.
  - There is no Settings -> Maintenance browser E2E coverage for archived worktree cleanup.
- `tests/ui-fixtures/settings-admin-fixture-*`
  - Existing fixture renders `renderSettingsPage()` with stubbed settings APIs.
  - Current maintenance stubs return `{ count: 0, sample: [] }`, so fixture support must be added for archived-session scan/cleanup responses.
  - Best fit for deterministic UI state matrices: zero-removable, actionable-only default, hidden skipped disclosure, selection presets, examples/grouping.
- `src/app/settings-page.ts` selectors
  - Current archived worktree section has `data-section="archived-session-worktrees"` plus scan/cleanup `data-action` attributes and row `data-archived-worktree-key`.
  - The reattempt should add stable `data-testid` hooks for summaries, filters/disclosures, group/example sections, selection presets, row categories, and cleanup buttons. Tests should not depend on Tailwind classes or incidental copy beyond acceptance-critical labels.
- `docs/testing-strategy.md`
  - Put deterministic UI matrices in `tests/ui-fixtures/*.spec.ts` (unit browser / file://).
  - Put server contracts in API E2E.
  - Use spawned browser E2E only for the small full-stack Settings -> Maintenance journey and persistence/archived-session preservation path.

## Proposed API contract coverage

### File: `tests/e2e/maintenance-api.spec.ts`

Extend the existing `archived session worktree maintenance` describe block. Keep using isolated temp git repos and direct session-store seeding.

#### Shared shape assertions

Update or add helpers so every scan row asserts:

- `status`: one of `removable`, `already-cleaned`, `skipped`, `failed` if scan failures are represented as rows.
- `category`: machine-readable group used by UI selection/examples, e.g. `ready`, `already-cleaned`, `missing-worktree-path`, `sandbox-container-path`, `referenced`, `stale`, `failed`.
- `reason`: stable machine-readable reason code.
- `reasonLabel` or `detail`: human-readable explanation.
- `isActionable` or equivalent boolean for UI filtering.
- Required metadata: `key`, `sessionId`, `title`, `repo`, `repoPath`, `path`, `branch`, `projectId/projectName` when known, and branch deletion flags.

Update counts assertions to include action-oriented and troubleshooting counts. Minimum expected shape:

- `readyToClean`
- `selected` is UI-only unless server returns selected state; do not require from scan API if the server is stateless.
- `alreadyCleaned`
- `needsAttention`
- `skipped` / `ineligible`
- existing legacy counts may remain, but tests must not let `sessionsWithWorktrees` be the primary actionable count.

#### Scenario: scan categories and reason codes

Seed one archived session for each representative reason, then call:

`GET /api/maintenance/archived-session-worktrees?includeAlreadyCleaned=1`

Assert grouped categories/reasons are stable:

- removable host worktree -> `status: "removable"`, `reason: "safe-archived-session-worktree"`, category/actionable true.
- missing worktree path -> `reason: "no-worktree-path"`, non-actionable.
- missing repo path -> `reason: "missing-repo-path"`, non-actionable.
- sandbox/container path -> `reason: "sandbox-container-path"`, non-actionable.
- delegate shared worktree -> `reason: "delegate-shared-worktree"`, non-actionable.
- already removed path/git metadata -> `status: "already-cleaned"`, `reason: "already-cleaned"`.
- stale non-git directory -> `reason: "stale-worktree-directory"`, non-actionable.
- live session reference -> `reason: "referenced-by-live-session"`, non-actionable.
- live goal/team/staff references, where practical with lightweight store seeding -> `referenced-by-live-goal`, `referenced-by-live-team`, `referenced-by-staff`.
- multi-repo session -> one row per `repoWorktrees` entry with per-repo `repo`, `repoPath`, `path`, and category.

Also assert default scan without `includeAlreadyCleaned=1` excludes already-cleaned rows from displayed `sessions` while still reporting counts.

#### Scenario: cleanup response shape and selected guards

Extend the selected cleanup tests to assert:

- Response counts include `requested`, `cleaned`, `branchDeleted`, `skipped`, `alreadyCleaned`, `failed`.
- Each result carries `key`, `sessionId`, `repo`, `path`, `branch`, `status`, `reason` or `error`, `worktreeRemoved`, `branchDeleted`.
- Invalid key/session selector returns a skipped `invalid-selection` result and does not remove the real worktree.
- Selecting an ineligible row returns skipped with the same row reason and does not remove directory, git worktree metadata, or branch.
- Selecting an already-cleaned row returns `already-cleaned` and does not delete branch-only residue.

#### Scenario: clean all safe candidates remains guarded

Seed at least:

- one removable archived worktree,
- one archived worktree referenced by a live session,
- one sandbox/container path,
- one already-cleaned row,
- one stale directory.

Call:

`POST /api/maintenance/cleanup-archived-session-worktrees` with `{ "mode": "all" }`

Assert only the removable row is cleaned. All ineligible rows remain untouched and appear as skipped/already-cleaned only if the response includes them; if `mode: all` intentionally returns only attempted removable rows, assert counts/documented shape matches that contract and add a separate category cleanup test.

#### Scenario: category-based cleanup, if implemented

If the API supports category selectors, add validation and guard tests for:

- `{ "mode": "category", "categories": ["ready"] }` cleans only actionable rows.
- Unsupported categories return `400` with a useful error.
- Mixed selected IDs and categories return `400` unless explicitly supported.
- Category cleanup still re-scans server-side and skips rows whose safety changed after the UI scan.

#### Scenario: archived session preservation

Keep and strengthen the existing preservation test:

- After cleanup, `GET /api/sessions/:id?include=archived` returns the archived session.
- Persisted session metadata still includes title, archive flags, branch/repo/worktree metadata.
- Transcript/proposal/archive files remain present.
- A follow-up archived-session list/search path still shows the session if an existing API supports it.

## Proposed UI fixture coverage

### Files

- Add or extend: `tests/ui-fixtures/settings-admin-fixture-entry.ts`
- Add tests in: `tests/ui-fixtures/settings-admin-fixture.spec.ts`

The fixture should expose deterministic controls:

- `__setArchivedWorktreeScan(response)`
- `__getSettingsAdminFetchLog()` already exists and should capture cleanup request bodies.
- Optional `__setArchivedWorktreeCleanup(response)` or make the POST handler mutate fixture state from removable to already-cleaned.

### Required stable selectors

Implementation should expose selectors before tests are added:

- `data-testid="archived-worktree-maintenance"`
- `data-testid="archived-worktree-summary-ready"`
- `data-testid="archived-worktree-summary-selected"`
- `data-testid="archived-worktree-summary-already-cleaned"`
- `data-testid="archived-worktree-summary-needs-attention"`
- `data-testid="archived-worktree-empty-state"`
- `data-testid="archived-worktree-scan"`
- `data-testid="archived-worktree-clean-all"`
- `data-testid="archived-worktree-clean-selected"`
- `data-testid="archived-worktree-select-all-removable"`
- `data-testid="archived-worktree-select-archived-sessions"`
- `data-testid="archived-worktree-select-current-project"` if current-project filtering is supported.
- `data-testid="archived-worktree-clear-selection"`
- `data-testid="archived-worktree-show-skipped"`
- `data-testid="archived-worktree-group-<category-or-reason>"`
- `data-testid="archived-worktree-show-all-<category-or-reason>"`
- `data-testid="archived-worktree-row"` with `data-status`, `data-reason`, `data-category`, and `data-archived-worktree-key`.

### Scenario: default actionable-only view

Fixture scan data: two removable rows, ten skipped rows, one already-cleaned row.

Assert after clicking Scan:

- `Ready to clean: 2` is the prominent count.
- `Selected: 2` appears if default selection is all safe candidates.
- Visible rows are only `data-status="removable"` by default.
- Skipped/ineligible reason text such as `no-worktree-path` and `sandbox-container-path` is not visible until the troubleshooting disclosure is opened.
- `With worktrees` is not shown as a primary summary label. If retained, it must be secondary copy like `Has worktree metadata, not necessarily removable`.

### Scenario: zero-removable empty state

Fixture scan data: zero removable, many skipped/already-cleaned rows.

Assert:

- Summary shows `Ready to clean: 0`.
- Empty state explains there is nothing safe to remove.
- `Clean all safe candidates` and `Clean selected` are disabled or absent.
- Helper text explains why cleanup is unavailable.
- Skipped details remain hidden by default.

### Scenario: hidden skipped disclosure

Using the zero/actionable fixture data:

- Before opening disclosure, skipped rows are not visible.
- Click `Show skipped / ineligible items`.
- Representative grouped sections appear by reason/category.
- Each group shows a small sample, default max 5 rows.
- `Show all` expands only that group.
- Closing the disclosure hides skipped details again without changing selected removable rows.

### Scenario: one-click selection presets

Fixture scan data: removable rows across categories/project/repo plus ineligible rows.

Assert:

- `Select all removable` selects only actionable rows.
- `Clear selection` sets `Selected: 0` and disables `Clean selected`.
- `Select archived session worktrees only` selects only matching actionable rows.
- `Select current project/repo only`, if supported by scan data, selects only actionable rows for the active project/repo.
- Presets never select skipped or already-cleaned rows.

### Scenario: clean selected flow

- Start with two removable rows.
- Clear selection; select one row.
- Click `Clean selected`.
- Assert the POST body uses `mode: "selected"` and includes only that row key/session selector.
- Mock cleanup result with `cleaned: 1` and rescan with remaining rows.
- Assert cleanup result summary reports cleaned/skipped/failed/already-cleaned counts concisely and the cleaned row is no longer actionable.

### Scenario: clean all safe candidates flow

- Start with removable rows selected or not selected.
- Click `Clean all safe candidates`.
- Assert the POST body uses either `{ mode: "all" }` or the documented category/actionable request, not a fragile client-built skipped-row list.
- Assert server-side result summary appears and the UI rescans.
- Assert cleanup buttons become disabled when rescan returns `Ready to clean: 0`.

### Scenario: grouped examples by reason/category

Fixture scan data: groups for `ready`, `already-cleaned`, `missing-worktree-path`, `sandbox-container-path`, `referenced-by-live-session`, and `stale-worktree-directory`.

Assert:

- Summary count affordances jump/filter to the matching group.
- Each group title uses human-readable wording.
- Rows show useful default fields only: title, short session id, project/repo, branch, worktree path when present, and reason label.
- Raw/technical details are behind per-row expansion.

## Proposed spawned-browser E2E coverage

### File: `tests/e2e/ui/settings-maintenance-archived-worktrees.spec.ts`

Use the real gateway only for one or two full-stack journeys. Avoid duplicating the full fixture matrix.

#### Scenario: Settings -> Maintenance full cleanup journey

- Seed an archived, worktree-backed session in an isolated temp git repo. Prefer extracting a helper from the API spec only if it can be shared cleanly; otherwise duplicate a small setup helper in this spec.
- Open app with `openApp(page)`.
- Navigate to `#/settings/system/maintenance` using `navigateToHash`.
- Click Scan.
- Assert `Ready to clean: 1`, actionable row visible, skipped details hidden.
- Click `Clean all safe candidates` or select the row and click `Clean selected` depending on final UX.
- Assert cleanup result summary and rescan show `Ready to clean: 0`.
- Assert the git worktree path and eligible branch are gone.
- Assert `GET /api/sessions/:id?include=archived` still returns the archived session and the title is visible in the archived-session UI path if a stable navigation exists.

#### Scenario: zero-removable empty state with skipped hidden by default

This can be either real-gateway seeded data or a Playwright `page.route()` response stub for the maintenance endpoints. Prefer route stubbing if the goal is pure UI wiring.

- Route `GET /api/maintenance/archived-session-worktrees` to return zero removable plus many skipped rows.
- Navigate to Maintenance and scan.
- Assert empty state, disabled cleanup buttons, no visible skipped rows by default, and disclosure reveals grouped examples.

## Manual QA checklist

Run once after implementation on a real development project:

1. Create or identify a worktree-backed session.
2. Archive it.
3. Open Settings -> Maintenance.
4. Scan archived session worktrees.
5. Confirm the row appears under `Ready to clean` with a clear safe-to-remove reason.
6. Use `Clean all safe candidates`.
7. Confirm the git worktree and eligible branch are removed.
8. Confirm the archived session remains visible/readable, including transcript/proposal/archive metadata.
9. Confirm skipped details are hidden by default and representative examples are available without scrolling through all rows.

## Commands

Focused feedback while developing tests:

```bash
npx playwright test --config playwright-e2e.config.ts --project=api tests/e2e/maintenance-api.spec.ts
npx playwright test --config tests/playwright.config.ts tests/ui-fixtures/settings-admin-fixture.spec.ts
npx playwright test --config playwright-e2e.config.ts --project=browser tests/e2e/ui/settings-maintenance-archived-worktrees.spec.ts
```

Required final verification for the goal branch:

```bash
npm run check
npm run test:unit
npm run test:e2e
```

Manual QA command is not automated; run the checklist above after `npm run dev:harness` or against the packaged app.

## Acceptance mapping

| Acceptance item | Primary test location |
| --- | --- |
| Clear whether any archived worktrees can be cleaned | UI fixture + browser E2E |
| No implication that `With worktrees` means eligible | UI fixture text assertion |
| Zero removable disables/omits cleanup with reason | UI fixture + browser E2E |
| Skipped/ineligible hidden by default | UI fixture + browser E2E |
| Clean all safe candidates in one/two clicks | Browser E2E + API `mode: all` |
| One-click category selection | UI fixture |
| Representative examples by status/reason/category | UI fixture |
| Cleanup result summary counts | API shape + UI fixture |
| Archived sessions remain visible/readable | API E2E + browser E2E/manual QA |
| Live/goals/delegates/team/staff/multi-repo safeguards | API E2E |
