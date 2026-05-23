# E2E Speed Buffer Report

This is the point-in-time report for the `goal/e2e-speed--6d1ec0ec` follow-up. The goal was to add headroom after the first E2E speed-stability pass without weakening product-owner story coverage.

## Strategy

`npm run test:e2e` spans three Playwright projects:

- `api` — in-process gateway tests.
- `api-realpush` — isolated real-push API coverage.
- `browser` — spawned gateway plus Chromium for user journeys.

The bottleneck remains browser-tier work, not raw worker count. Browser workers are expensive because each owns a spawned gateway and Chromium process, and higher worker counts previously increased Windows filesystem and CPU contention. The safe speed lever is therefore: keep conservative workers, move non-browser assertions to API/UI-fixture tiers, and retain browser smokes for real user journeys.

## Measurement sources

The current measurements came from persisted, uncommitted artifacts under `.bobbit/tmp/e2e-speed-buffer/` in the test worktrees:

- Baseline: `baseline-exact-e2e.log`, `baseline-report.json`, `baseline-list.txt`, `baseline-report.md`.
- Final: `final3-exact-e2e.log`, `final3-exact-e2e-run2.log`, `final3-exact-e2e-run3.log`.

All exact-command timings below include the build step from `npm run test:e2e`.

## Baseline versus final

| Metric | Fresh baseline at `b8863eda` | Final measured state at `686de26e` |
|---|---:|---:|
| Exact command | `npm run test:e2e` | `npm run test:e2e` |
| Best exact wall time | 329.0s | 261.316s |
| Additional exact wall time | JSON run: 321.877s | 262.877s |
| Cold/post-install exact wall time | n/a | 276.792s |
| Final result shape | 964 passed / 7 skipped / 4 flaky / 0 failed | 958 passed / 7 skipped / 0 flaky / 0 failed |
| Cold/post-install result shape | n/a | 957 passed / 7 skipped / 1 flaky / 0 failed |
| Listed tests / files | 975 / 257 | 965 / 257 |
| `api` split | 690 tests / 138 files | 690 tests / 138 files |
| `api-realpush` split | 1 test / 1 file | 1 test / 1 file |
| `browser` split | 284 tests / 118 files | 274 tests / 118 files |

Baseline slowest targets were `dynamic-chat-tabs.spec.ts` (~91.4s), `repro-h3-snapshot-live-interleave.spec.ts` (~46.3s), `sidebar-keyboard-nav.spec.ts` (~26.2s), `session-recovery.spec.ts` (~14.4s), and `project-assistant-saved-state.spec.ts` (~13.7s). No test files were added between prior head `17f80bccbc52821e27dcc206125ce8823dfb0723` and the fresh baseline.

## Worker configuration

The worker layout is retained from the measured stable configuration:

- Top-level Playwright workers: `4`.
- `api`: `4` workers.
- `api-realpush`: `1` worker, `fullyParallel=false`.
- `browser`: `3` workers, `fullyParallel=false`.

Do not increase workers to chase the remaining runtime gap. The prior `--workers=5` experiment was slower and flakier; further speed work should reduce browser cost or fix cold-cache contention.

## Implemented reductions and coverage mapping

| Area reduced | Browser coverage retained | Cheaper replacement coverage | Equivalence rationale |
|---|---|---|---|
| Dynamic chat tabs / preview workspace | `tests/e2e/ui/dynamic-chat-tabs.spec.ts` keeps real gateway journeys for proposal + HTML preview coexistence, legacy v1/v2 preview snapshots across reload, and same-content v3 content-hash collapse to the live preview tab. | `tests/ui-fixtures/dynamic-panel-workspace-fixture.spec.ts` and entry fixture cover multi-preview tab switching, per-session isolation, reserved review titles, different-content v3 previews across reload, source labels, proposal/review/preview tab mixes, and mobile tab accessibility. | Broad tab-state combinations are renderer/state behavior and do not need a spawned gateway. Browser still owns preview mount, reload, transcript hydration, and live preview behavior. |
| H3 snapshot/live interleave stress | `tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts` keeps smoke-level full-stack B/C/D journeys with `H3_BROWSER_ITER` defaulting to a smaller value. | `tests/message-reducer.test.ts` and `tests/session-manager-getmessages-splice.test.ts` own the exhaustive reducer and server-splice invariants. Manual stress can use `H3_BROWSER_ITER=5`. | The product risk is the reducer/server invariant; full browser repetition only amplifies timing variance. Unit coverage is deterministic and cheaper, while browser smoke still proves the wiring. |
| Sidebar archived keyboard cycle | `tests/e2e/ui/sidebar-keyboard-nav.spec.ts` retains the real-app keyboard navigation contract. The implementation-gate follow-up restores the archived `Show Archived` browser journey in this spec: open filters, toggle Show Archived, verify archived rows enter/leave the `Ctrl+Arrow` cycle, verify reload persistence, and clean up. | `tests/ui-fixtures/sidebar-keyboard-nav-fixture.spec.ts` and entry fixture keep dense on/off archived-cycle assertions. | The fixture is enough for pure DOM/nav ordering, but the restored browser journey is required because the filter popover, localStorage persistence, archived data loading, and cleanup are user-visible real-app behavior. |
| Project assistant API basics | `tests/e2e/ui/project-assistant.spec.ts` retains the registration/promote UX journey and proposal panel flows. | `tests/e2e/project-assistant-api.spec.ts` covers assistant session creation, provisional flags, and project API state. | API-only data shape checks do not need Chromium; the browser smoke still owns add-project UI, proposal acceptance, sidebar transition, and cleanup. |
| Proposal/review parity | Browser proposal and review specs retain normal-session opening, visible annotation hydration, reload behavior, and cleanup. | `tests/ui-fixtures/proposal-review-fixture.spec.ts` covers per-type dismissal, restart/reload persistence, and proposal renderer parity. | Renderer persistence can run in `file://` fixture coverage; browser remains responsible for user-visible hydration and normal navigation entry points. |

## Retained browser smokes

Keep these browser journeys intact when making future reductions:

- Project assistant registration/promote — `tests/e2e/ui/project-assistant.spec.ts` covers add-project, provisional assistant session, proposal acceptance, project promotion with config, sidebar transition, and cleanup.
- Project assistant saved-state — `tests/e2e/ui/project-assistant-saved-state.spec.ts` covers panel-scoped Apply Changes, Changes Saved, reload persistence, replacement by a new proposal, Terminate, and navigation cleanup.
- Dynamic preview/chat — `tests/e2e/ui/dynamic-chat-tabs.spec.ts` covers real preview mount, legacy preview snapshots, content-hash dedupe, reload, and tab accessibility.
- Sidebar keyboard/navigation — `tests/e2e/ui/sidebar-keyboard-nav.spec.ts` covers real gateway keyboard navigation, with the restored archived `Show Archived` cycle as the required browser smoke for archived rows.
- Review annotations — `tests/e2e/ui/review-annotations-persistence.spec.ts` retains RP-05/RP-16/RP-18 visible hydration, reload, cross-context/session isolation, and cleanup.
- Staff/sidebar behavior — `tests/e2e/ui/staff-sub-section.spec.ts` retains SB-31 visible sidebar behavior; API tests cover staff reassignment data paths.
- Proposal opening/parity — browser proposal smokes retain normal-session opening while `tests/ui-fixtures/proposal-review-fixture.spec.ts` owns per-type renderer persistence.

## Flake status

Final steady-state exact runs had 0 failures and 0 flaky tests. The cold post-install run had 1 recovered flaky attempt.

Resolved or reduced:

- Saved-state registered-panel timeout: did not reproduce in final runs; targeted repeat passed 10/10.
- Abort-status false ESM missing-export class: did not reproduce in final runs after cache isolation; targeted evidence includes 25/25 parallel, 50/50 serial, and 5/5 focused npm E2E runs.
- Preview happy-path iframe readiness: targeted repeat passed 10/10.

Remaining risk:

- Project-assistant sidebar cleanup reproduced once in the cold exact run, then did not reproduce in two under-target reruns. Treat this as a real lifecycle readiness risk until the follow-up fix is verified, not as a reason to add retries or broad timeouts.
- Search index `ENOENT`/corrupt-index log noise still appears in some runs but did not fail the final exact commands. Treat new failures from this class as harness/filesystem contention until proven otherwise.

## Cold-cache risk

The current steady-state buffer is real but not complete:

- Two consecutive exact reruns were under 270s: 261.316s and 262.877s.
- The cold post-install run was 276.792s and had 1 flaky retry.

This means the suite has warm-cache headroom but can still miss the target after dependency install, cold transform caches, or concurrent filesystem pressure. Future work should target cold-cache performance and contention rather than increasing worker counts.

## Coverage and story audit

Aggregate coverage remained non-regressive after the reductions:

- Lines: 63.44% -> 63.44%.
- Functions: 60.34% -> 60.34%.
- Branches: 75.36% -> 75.38%.

Restored coverage blockers from the prior speed pass remain covered:

- RP-05/RP-16/RP-18 via review annotation browser hydration and fixture/API persistence coverage.
- SB-31 via staff/sidebar browser coverage plus API staff data paths.
- Proposal parity via fixture renderer coverage plus browser opening smoke.

Known pre-existing story-matrix ambiguities remain unchanged and should not be counted as regressions from this goal: CT-02-b, CT-15, and SB-15.

## Follow-up risks

1. Close the project-assistant cleanup race with deterministic lifecycle readiness.
2. Re-run exact E2E after the archived keyboard browser journey and cache-teardown fixes are merged; the measured count should remain 965 tests / 257 files if the journey is restored inside the existing sidebar keyboard spec.
3. Improve cold-cache runtime so the first exact run also lands under 270s.
4. Keep `tests/e2e/ui/screenshots/verification-progress-indicator.png` restored after E2E runs; it mutated during verification and was reset before final status.
