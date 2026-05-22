# E2E Speed Stability Report

This is a point-in-time record of the E2E speed-stability work completed on 2026-05-22. The numbers below are verified at `801ba2159b3964a7699000915939e0f27fab70ad`; re-measure after large test moves.

## Goal and strategy

`npm run test:e2e` covers API, real-push API, and browser projects. The bottleneck was not raw Playwright parallelism; it was the amount of browser-tier work. Each browser worker owns a spawned gateway and Chromium process, so increasing workers raised Windows filesystem/CPU contention and created flakes.

The safe strategy was therefore:

1. Make the exact npm command portable.
2. Move non-browser coverage out of the spawned-gateway browser project.
3. Consolidate browser stories without deleting product-owner intent.
4. Fix high-confidence flakes exposed by the lower-work suite.
5. Keep worker counts conservative rather than hiding runtime with more parallelism.

## Baseline versus final

| Metric | Baseline | Final at `801ba215` |
|---|---:|---:|
| Exact `npm run test:e2e` | blocked by non-portable stderr redirection | passed |
| Wall time including build | 474–566s via equivalent shell command | 298s |
| Playwright result | 1164 expected / 8 skipped / 11 flaky / 0 unexpected | 962 passed / 7 skipped / 3 flaky / 0 failed |
| Listed tests / files | 1183 / 275 | 972 / 257 |
| `api` tests | 668 | 690 |
| `api-realpush` tests | 1 | 1 |
| `browser` tests | 514 | 281 |

The final exact command passed under the 300s target by only 2s, so the result meets the goal but has little headroom.

## Final worker configuration

Final verified worker counts:

- Top-level Playwright workers: `4`
- `api`: `4`
- `api-realpush`: `1`
- `browser`: `3`

A `--workers=5` experiment was slower and flakier, including runs around 20 minutes with many flaky/failed attempts and filesystem-contention signatures. Do not raise workers to chase runtime; reduce browser work or fix contention instead.

## Implemented reductions

- Removed non-portable `2>/dev/null` suppression from `test:e2e` and `test:e2e:standard`, so the exact npm acceptance command works on Windows/Git Bash.
- Moved pure `file://` renderer specs out of full E2E and into the lightweight UI fixture/unit tier.
- Split API-only assertions out of browser specs into in-process API specs, including optional steps, multi-repo data paths, project assistant API basics, unseen-activity endpoint checks, goal/workflow routing, project/search/sidebar stories, and session/story data paths.
- Consolidated high-volume browser story files so one browser journey covers multiple related assertions where the UI path is the product behavior.
- Moved mocked or DOM-only UI suites to fixture tests when they did not need a real gateway, Chromium navigation, websocket replay, or spawned-agent behavior.
- Kept real browser coverage for user-visible flows such as proposal opening, review annotation hydration, staff/sidebar behavior, streaming/resync, project assistant, and session navigation.

## Flake fixes completed

High-confidence fixes landed during the effort:

- Project assistant saved-state stabilization.
- Cancel-verification workflow setup stabilization.
- Abort-status ordering stabilization.
- Sidebar keyboard navigation stabilization.
- Dynamic preview tab fixture stabilization.
- Coverage-restoration fixes for review annotations, staff sidebar, and proposal parity after reductions.

Final first-attempt flakes still passed on retry:

| Project | Spec | First-attempt signature |
|---|---|---|
| `api` | `tests/e2e/abort-status-e2e.spec.ts` | missing `ROLE_ASSISTANT_PROMPT` export from `role-assistant.js` |
| `api` | `tests/e2e/abort-status-e2e.spec.ts` | missing `ProjectContext` export from `project-context.js` |
| `browser` | `tests/e2e/ui/project-assistant.spec.ts` | `Project Assistant` sidebar row still visible after the happy-path promotion flow |

These are the remaining stability floor; they should not be masked by more retries or higher worker counts.

## Coverage and story audit evidence

Coverage and product-story audits were used as blockers for deletions and consolidations.

Evidence recorded during final verification:

- Unit coverage aggregate had no line or function drop:
  - Lines: `63.44% (33637/53021) -> 63.44% (33637/53021)`
  - Functions: `60.34% (1193/1977) -> 60.34% (1193/1977)`
  - Branches: `75.36% (4916/6523) -> 75.38% (4917/6523)`
- RP coverage blockers were restored: review annotation browser hydration again pins `RP-05`, `RP-16`, and `RP-18`, while pure REST persistence remains covered in the API tier.
- SB coverage blockers were restored: the staff sub-section browser spec again pins the dedicated staff/sidebar behavior, with staff reassignment data paths covered in the API tier.
- Proposal parity blockers were restored: per-type post-reload dismissal and restart-survival behavior is covered in fixture tests, with a normal-session browser smoke retained for opening proposal types.
- Objective story matrix result after restores: `88/91` covered; the remaining ambiguities are pre-existing annotation-only cases, not regressions from this work: `CT-02-b`, `CT-15`, and `SB-15`.

## Follow-up plan

Priority order:

1. **Create runtime headroom.** The final 298s result is too close to the 300s target. Aim for at least 20–30s of margin before treating the suite as comfortably stable.
2. **Fix remaining first-attempt flakes.** Investigate the abort-status transient missing-export failures and the project-assistant sidebar cleanup/promotion race with targeted repeats before changing retries or timeouts.
3. **Continue reducing browser-tier work.** Prefer fixture or API coverage for tests that do not require a spawned gateway, real websocket replay, or Chromium navigation. Keep browser tests for actual user journeys.
4. **Re-test lower worker counts after more reductions.** The verified config is top-level `4`; `--workers=5` is worse. Lower counts should be reconsidered only after the suite has enough runtime margin.
5. **Track filesystem contention signatures.** Repeated search-index `ENOENT`, role-store save, git config lock, or temp-file rename errors under heavier parallelism should be treated as real contention bugs, not noise.
