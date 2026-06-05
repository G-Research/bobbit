# E2E Speed Buffer Report

This is the point-in-time report for the `goal/e2e-speed--6d1ec0ec` follow-up. The goal was to create runtime headroom for the full E2E suite without weakening product-owner story coverage.

## Strategy

`npm run test:e2e` spans three Playwright projects:

- `api` — in-process gateway tests.
- `api-realpush` — isolated real-push API coverage.
- `browser` — spawned gateway plus Chromium for user journeys.

The bottleneck remains browser-tier setup, not raw worker count. Browser workers are expensive because each owns a spawned gateway and Chromium process, and higher worker counts previously increased Windows filesystem and CPU contention. The safe speed lever was therefore: keep conservative workers, fold duplicated browser setup, move static assertions to cheaper tiers where equivalent, and retain browser smokes for real user journeys.

## Measurement sources

Measurements came from persisted, uncommitted artifacts under `.bobbit/tmp/e2e-speed-buffer/` in the test worktrees, plus the final verification task for `3ae181cd`.

All exact-command timings below include the build step from `npm run test:e2e`. The Playwright duration is reported separately when available so build/global-setup time is not confused with test execution time.

## Baseline versus accepted final

| Metric | Fresh baseline at `b8863eda` | Accepted final at `3ae181cd` |
|---|---:|---:|
| Exact command | `npm run test:e2e` | `npm run test:e2e` |
| Exact wall time, including build | 329.0s | 263s |
| Playwright test phase | not separated | 4.0m |
| Target margin | 59s over 270s | 7s under 270s |
| Result shape | 964 passed / 7 skipped / 4 flaky / 0 failed | 944 passed / 6 skipped / 0 flaky / 0 failed |
| Retries | recovered flakes present | 0 |
| Listed tests / files | 975 / 257 | 950 / 256 |
| `api` split | 690 tests / 138 files | 690 tests / 138 files |
| `api-realpush` split | 1 test / 1 file | 1 test / 1 file |
| `browser` split | 284 tests / 118 files | 259 tests / 117 files |

Final verification also recorded:

- `npm run check` passed in 10s.
- `npm run test:unit` passed with 1198 passed / 2 skipped, wall 170s.
- `npx playwright test --config playwright-e2e.config.ts --list` reported 950 tests / 256 files.
- The E2E run mutated `tests/e2e/ui/screenshots/verification-progress-indicator.png`; it was restored before final status.

Baseline slowest targets were `dynamic-chat-tabs.spec.ts`, `repro-h3-snapshot-live-interleave.spec.ts`, `sidebar-keyboard-nav.spec.ts`, `session-recovery.spec.ts`, and `project-assistant-saved-state.spec.ts`. No test files were added between prior head `17f80bccbc52821e27dcc206125ce8823dfb0723` and the fresh baseline. The final file-count reduction came from folding `add-project-preflight-directory-picker.spec.ts` into `add-project-preflight.spec.ts`.

## Worker configuration

The worker layout stayed on the measured stable configuration:

- Top-level Playwright workers: `4`.
- `api`: `4` workers.
- `api-realpush`: `1` worker, `fullyParallel=false`.
- `browser`: `3` workers, `fullyParallel=false`.

Do not increase workers to chase the remaining runtime gap. The prior `--workers=5` experiment was slower and flakier; future speed work should continue reducing browser setup cost or cold-cache contention.

## Implemented reductions and coverage mapping

| Area reduced | Browser coverage retained | Replacement or folded coverage | Equivalence rationale |
|---|---|---|---|
| Dynamic chat tabs / preview workspace | `tests/e2e/ui/dynamic-chat-tabs.spec.ts` keeps real gateway journeys for proposal + HTML preview coexistence, legacy v1/v2 preview snapshots across reload, and same-content v3 content-hash collapse to the live preview tab. | `tests/ui-fixtures/dynamic-panel-workspace-fixture.spec.ts` covers multi-preview tab switching, per-session isolation, reserved review titles, different-content v3 previews across reload, source labels, proposal/review/preview tab mixes, and mobile tab accessibility. | Broad tab-state combinations are renderer/state behavior and do not need a spawned gateway. Browser still owns preview mount, reload, transcript hydration, and live preview behavior. |
| H3 snapshot/live interleave stress | `tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts` keeps smoke-level full-stack B/C/D journeys with `H3_BROWSER_ITER` defaulting to a smaller value. | `tests/message-reducer.test.ts` and `tests/session-manager-getmessages-splice.test.ts` own the exhaustive reducer and server-splice invariants. Manual stress can use `H3_BROWSER_ITER=5`. | The product risk is the reducer/server invariant; full browser repetition only amplified timing variance. Unit coverage is deterministic and cheaper, while browser smoke still proves wiring. |
| Sidebar archived keyboard cycle | `tests/e2e/ui/sidebar-keyboard-nav.spec.ts` now includes the archived cycle inside the existing real-app keyboard journey: Show Archived off/on, archived row navigation, reload persistence, and cleanup back to hidden. | `tests/ui-fixtures/sidebar-keyboard-nav-fixture.spec.ts` and entry fixture keep dense DOM/nav-order assertions. | The fixture covers pure ordering, while the browser path proves the filter popover, localStorage persistence, archived data loading, and cleanup in the real app without a separate browser setup. |
| Project assistant API basics | `tests/e2e/ui/project-assistant.spec.ts` retains the registration/promote UX journey and proposal panel flows. | `tests/e2e/project-assistant-api.spec.ts` covers assistant session creation, provisional flags, and project API state. | API-only data shape checks do not need Chromium; the browser smoke still owns add-project UI, proposal acceptance, sidebar transition, and cleanup. |
| Proposal/review parity | Browser proposal and review specs retain normal-session opening, visible annotation hydration, reload behavior, and cleanup. | `tests/ui-fixtures/proposal-review-fixture.spec.ts` covers per-type dismissal, restart/reload persistence, and proposal renderer parity. | Renderer persistence can run in `file://` fixture coverage; browser remains responsible for user-visible hydration and normal navigation entry points. |
| `ask_user_choices` widget setup | `tests/e2e/ui/ask-user-choices-ui.spec.ts` keeps the composite widget lifecycle and cross-client finalization journeys. | Separate happy-path, reload, cleanup, read-only, and keyboard-only browser tests were folded into two full-stack journeys. | The same browser widget states are still asserted, but repeated session/tool setup was removed. |
| Base-ref settings validation | `tests/e2e/ui/base-ref-settings.spec.ts` keeps happy-path persistence across reload and inline errors for tag, grammar, sandbox-local, multi-repo missing refs, plus stale-error clearing. | Multiple validation rows were folded into one browser journey with shared project setup. | Every user-visible validation message and persistence behavior remains browser-owned; only duplicate setup and navigation were removed. |
| Add-project symlink confirmation | `tests/e2e/ui/add-project-symlink.spec.ts` keeps cancel behavior, no-registration verification, canonical storage, and reload persistence. | The previous cancel-only browser test was folded into the canonical storage journey. | Cancel and accept paths use the same modal and project setup, so one journey covers both without losing assertions. |
| Project drag reorder | `tests/e2e/ui/project-drag-reorder.spec.ts` keeps desktop affordances, pointer reorder persistence, live WebSocket sync, cancel, collapsed-sidebar order, and mobile reorder coverage. | Desktop affordance and live-sync journeys were folded into the main desktop reorder journey. | Reorder behavior remains full-stack; the change removes duplicate project/session setup while preserving visible affordance, persistence, sync, and cancel checks. |
| Add-project preflight picker | `tests/e2e/ui/add-project-preflight.spec.ts` now covers Browse -> Select triggering preflight, ready checks, enabled Continue, and archive CTA behavior. | Deleted `tests/e2e/ui/add-project-preflight-directory-picker.spec.ts`; its directory-picker regression assertion moved into the preflight happy path. | The picker and typed-path flows exercise the same preflight panel. The folded browser journey still proves Browse -> Select starts preflight without an extra spawned gateway. |
| Proposal tools | `tests/e2e/ui/proposal-tools.spec.ts` keeps goal proposal card rendering, completed `Open proposal` button, persistence after navigation, and panel reopen. | Four proposal-tool browser tests were folded into one smoke. | The visible product contract is one proposal card lifecycle; the folded journey preserves render, persistence, and reopen assertions with one setup. |

## Retained browser smokes

Keep these browser journeys intact when making future reductions:

- Project assistant registration/promote — `tests/e2e/ui/project-assistant.spec.ts` covers add-project, provisional assistant session, proposal acceptance, project promotion with config, sidebar transition, and cleanup.
- Project assistant saved-state — `tests/e2e/ui/project-assistant-saved-state.spec.ts` covers panel-scoped Apply Changes, Changes Saved, reload persistence, replacement by a new proposal, Terminate, and navigation cleanup.
- Dynamic preview/chat — `tests/e2e/ui/dynamic-chat-tabs.spec.ts` covers real preview mount, legacy preview snapshots, content-hash dedupe, reload, and tab accessibility.
- Sidebar keyboard/navigation — `tests/e2e/ui/sidebar-keyboard-nav.spec.ts` covers real gateway keyboard navigation, search filtering, collapse/expand, goal auto-open, and the archived Show Archived cycle.
- Review annotations — `tests/e2e/ui/review-annotations-persistence.spec.ts` retains RP-05/RP-16/RP-18 visible hydration, reload, cross-context/session isolation, and cleanup.
- Staff/sidebar behavior — `tests/e2e/ui/staff-sub-section.spec.ts` retains SB-31 visible sidebar behavior; API tests cover staff reassignment data paths.
- Proposal opening/parity — browser proposal smokes retain normal-session opening while `tests/ui-fixtures/proposal-review-fixture.spec.ts` owns per-type renderer persistence.
- `ask_user_choices` — `tests/e2e/ui/ask-user-choices-ui.spec.ts` retains interactive pending state, Other handling, submitted read-only restore, keyboard submission, and cross-client finalization.
- Base-ref settings — `tests/e2e/ui/base-ref-settings.spec.ts` retains persistence and user-visible validation errors.
- Add Project preflight/symlink — `tests/e2e/ui/add-project-preflight.spec.ts` and `tests/e2e/ui/add-project-symlink.spec.ts` retain directory picker, preflight panel, symlink cancel, canonical storage, and reload persistence.
- Project drag reorder — `tests/e2e/ui/project-drag-reorder.spec.ts` retains desktop/mobile reorder, persistence, sync, cancel, and collapsed-sidebar order.
- Proposal tools — `tests/e2e/ui/proposal-tools.spec.ts` retains the completed tool-card lifecycle and reopen path.

## Flake status

Accepted final verification at `3ae181cd` had 0 failures, 0 flaky tests, and 0 retries.

Resolved or reduced:

- Saved-state registered-panel timeout: did not reproduce in final runs; targeted repeat passed 10/10.
- Project-assistant sidebar cleanup: fixed by waiting on server and hydrated client state before asserting the assistant row is removed, then scoping the DOM assertion to the promoted project section.
- Abort-status false ESM missing-export class: did not reproduce in final runs after cache isolation; targeted evidence included 25/25 parallel, 50/50 serial, and 5/5 focused npm E2E runs.
- Preview happy-path iframe readiness: targeted repeat passed 10/10.
- Draft reload/autosave flakes: fixed in `src/app/session-manager.ts` by binding draft autosave before the editor can become interactive, tracking user edits after bind, and preventing late server draft restores from overwriting fresh local input.

Remaining risk:

- The final margin is 7s. This meets the target, but future test additions should prefer API/UI-fixture coverage or folded browser setup before adding new spawned-gateway journeys.
- ~~Search index `ENOENT`/corrupt-index log noise has appeared in some runs without failing final exact commands. Treat new failures from this class as harness/filesystem contention until proven otherwise.~~ **Superseded (goal "Stabilize flaky E2E suite").** The search flush-on-close path is now fully awaitable and the empty-tag export/import round-trip is fixed, so this noise no longer appears in a clean run. A fresh `[search] flex flush error: ENOENT … __docs__.json.tmp` or `Skipping corrupt index file 1.tag.json` is now a **teardown-ordering / round-trip regression**, not generic contention — debug it per [docs/debugging.md](debugging.md#search-flex-flush-error-enoent--__docs__jsontmp-spew-esp-during-e2e-teardown) and [docs/internals.md — Close & teardown ordering](internals.md#close--teardown-ordering).

## Coverage and story audit

Latest recorded aggregate coverage for this goal remained non-regressive after the broad reductions:

- Lines: 63.44% -> 63.44%.
- Functions: 60.34% -> 60.34%.
- Branches: 75.36% -> 75.38%.

The later setup folds reduced browser count by merging assertions into retained journeys, not by removing product-owner behavior. The accepted final list moved from 975 to 950 tests overall, with API counts unchanged and browser coverage reduced from 284 to 259 tests.

Restored coverage blockers from the prior speed pass remain covered:

- RP-05/RP-16/RP-18 via review annotation browser hydration and fixture/API persistence coverage.
- SB-31 via staff/sidebar browser coverage plus API staff data paths.
- Proposal parity via fixture renderer coverage plus browser opening smoke.

Known pre-existing story-matrix ambiguities remain unchanged and should not be counted as regressions from this goal: CT-02-b, CT-15, and SB-15.

## Follow-up risks

1. Keep worker counts at the measured stable layout unless a new controlled experiment proves otherwise.
2. Protect the retained browser smokes listed above; fold setup or move static assertions before deleting any user-journey coverage.
3. Improve cold-cache/runtime margin further. The final accepted run is under target, but only by 7s.
4. Keep `tests/e2e/ui/screenshots/verification-progress-indicator.png` restored after E2E runs; it mutated during final verification and was reset.
