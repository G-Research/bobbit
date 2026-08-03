# Qualify Cross-OS Tests

## Purpose and authority

This design implements only category-4 items in the [residual reconciliation ledger](../testing-v2/cross-os-residual-reconciliation.md). Current `origin/main` behavior—especially focused PRs #1071, #1076, #1077, #1078, #1080, and #1089—is authoritative. The historical integration commit is a behavior checklist only; never cherry-pick it or make the tree textually identical to it.

## Scope ledger

| Scope | Work |
|---|---|
| **Must** | Implement and pin every one of the 12 validated category-4 subsystems below; preserve all existing assertions and newer behavior; publish the reconciliation ledger and one immutable-head qualification record. |
| **Allowed** | Only the named production, test, mapping, and documentation files below, plus a small directly adjacent helper when required for one listed invariant. Update `tests2/tests-map.json` for every new v2 test. |
| **Deferred** | Any new performance effort, broad test migration, refactor, retry-policy redesign beyond retry-free qualification, historical-branch cleanup, and defects not directly reproduced by this scope. Create a separate goal only for an independent defect that cannot be safely fixed here. |

## Implementable category-4 plan

| Subsystem | Production/change symbols | Regression location | Required invariant |
|---|---|---|---|
| Unit retry-free control | `vitest.config.ts`: add a small environment-aware retry resolver used by `shared.retry`; `docs/testing-v2/fast-gate-design.md` | `tests2/core/unit-lanes-scheduling.test.ts` | Default stays `retry: 3`; `BOBBIT_V2_RETRY_FREE=1` makes every unit project `retry: 0`. The test restores environment state. |
| Packed-consumer ownership | `scripts/release-packed-consumer-audit.mjs`: `packedConsumerTempPrefix()` and `runPackedConsumerAudit()` | Extend `tests2/core/release-skill-preflight-order.test.ts` | Use canonical `BOBBIT_V2_RUN_ROOT` when supplied, atomically create only an audit child, fall back to OS temp, and clean only that child. |
| Workflow validation render | `src/app/workflow-page.ts`: `renderVerifyStepEditor().updateStep()` | `tests2/browser/workflow-review-timeout-editor.spec.ts` | Failed validation never rerenders an active text/number control; structural changes still rerender. The held create/PUT revision behavior remains unchanged. |
| Pi discovery import order | `src/server/agent/pi-extension-contributions.ts`: `loadPiExtensionContributionsWithDiscovery()` | Extend `tests2/core/pi-extension-discovery-backend.test.ts` or add a narrowly mapped core test | Bind async `discoverPiExtensionTools` in the initial module graph before an isolated prebundle/filesystem fixture can alter discovery resolution. |
| Sandbox command seam | `src/server/server.ts`: sandbox bootstrap and `/api/sandbox-status`, `/api/sandbox-image/build`, sandbox-session validation call sites; `sandbox-status.ts` call signature is already seam-capable | Add/extend `tests2/core/sandbox-status.test.ts` and, if route wiring requires it, one mapped integration route test | Every Docker availability/build/version call receives the injected gateway command runner; a fenced runner proves no host Docker spawn escapes. |
| E2E guide | `tests/e2e/README.md` | Existing documentation/source-contract coverage if present; otherwise the smallest mapped core source-contract test | Document API `workers: 2` and `BOBBIT_V2_RETRY_FREE=1`; default retries are workflow protection, never qualification evidence. |
| Pool restart fixture | `tests/e2e/pool-claim-restart-resume.spec.ts` | The same E2E spec | Allocate canonical per-test `mkdtemp` fixture state; await deletion of session, project, and owned root in `finally`; retain branch/reflog/inode assertions. |
| Browser coordinator pin | No production change expected: validate `scripts/testing-v2/run-browser-v2.mjs::{createBrowserRunPaths,playwrightCommandArgs,createBrowserRunEnvironment}` and `playwright-v2.config.ts` | Add `tests2/core/browser-run-wrapper.test.ts` and map it | Two allocations have distinct owned roots/reports outside the checkout; caller flags survive; global ledger capture precedes temp isolation; retry-free browser config remains supported. |
| Causal lifecycle tests | `tests2/core/purge-preview-pool-shutdown-coder61c7.test.ts`: test-local `deferred()` barriers | The same core test | Replace `waitFor`/`setImmediate` polling and blind turns with exact start/finish barriers for purge, listener, expiry, preview, mount cleanup, and initial reclaim batch. |
| Worktree alias regression | `tests2/core/team-manager.test.ts`: `canonicalWorktreePath()`, `listedWorktreePaths()`, `assertRegisteredWorktree()` | The same core test | Compare real Git registrations by realpath when available; retain lexical fallback for missing/stale registrations; exercise a symlink or junction alias without a skip. |
| Draft storage failure fixture | `tests2/dom/transient-draft-store.test.ts`: `breakStorage()` / `restoreStorage()` | The same DOM test | Install throwing `Proxy` storage aliases on `globalThis` and active `window`; restore descriptors exactly so happy-dom cannot bypass the simulated failure or poison following tests. |
| Skill fixture roots | `tests2/integration/skill-surface-consistency.test.ts` | The same integration test | Allocate P/Q/R/custom roots independently with `mkdtempSync`; do not rely on PID/time names; retain cleanup and all skill-surface assertions. |

Do not add reference-only tests where a stronger focused-PR test already exists, including the stale gate-verification UX projection. New test files must be registered in `tests2/tests-map.json`; no legacy test is moved or deleted.

## Regression strategy

Each test proves the ownership or causal boundary, not merely a source string. Use real temporary roots, injected command runners, held browser requests, proxy aliases, Git worktree aliases, and deferred promises as appropriate. Keep all existing assertions. If an existing test is made deterministic, replace only its observation mechanism; preserve destructive-owner, no-recreation, ordering, exact cleanup, and behavior assertions.

## Forbidden stability fixes

Never introduce `test.skip`, weakened/deleted assertions, sleeps, polling, blind retries or reloads, timeout increases, `force-exit`, global serialization, fixed ports, shared browser profiles/caches, checkout-local reports, or cleanup of a parent/shared root. Default retries may remain for developer workflow resilience, but are never load-bearing qualification evidence.

## Exact-head qualification

After all implementation and documentation commits are merged, record one immutable SHA. Every evidence row must use that SHA. Any later code, test, harness, configuration, or documentation change invalidates all earlier evidence; rerun every affected command, and rerun the complete matrix if the changed file can affect coordinator behavior, test selection, configuration, or reporting.

Write concise evidence (not raw logs) to `docs/testing-v2/` with this schema:

```text
sha | command | suite | attempt/coordinator | worktree | retryFree | retriesObserved | exit | durationMs | artifactOrCIUrl | notes
```

`retriesObserved` must be zero for every retry-free row. Record failed roots/log locations only as diagnostics; do not commit bulky logs. For each failed run, document root cause and whether it is goal-caused, acceptance-blocking upstream, or infrastructure-only. Never mask a failure.

### Required matrix

| Order | Command / setup | Required proof |
|---:|---|---|
| 1 | `npm run check` | One green exact-head type check. |
| 2 | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` | One serial full unit pass, zero retries. |
| 3 | `BOBBIT_V2_RETRY_FREE=1 npm run test:browser` | One serial wrapper-provided browser pass, zero retries. |
| 4 | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit -- --project=v2-integration` | One serial integration-project pass, zero retries. The repository has no separate `test:integration` wrapper; this is its workflow-provided Vitest lane. |
| 5 | `BOBBIT_V2_RETRY_FREE=1 npm run test:e2e` | One serial repository-wrapper E2E pass, zero retries. |
| 6 | Five consecutive `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` runs | Five green full gates, each zero retries. |
| 7 | Three clean worktrees at the same SHA; run `npm ci` in each, then start `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` simultaneously | Three green independent coordinators, no cross-talk. Each worktree and coordinator identity is recorded. |
| 8 | From one worktree, start two simultaneous `BOBBIT_V2_RETRY_FREE=1 npm run test:browser` wrapper invocations | Both green; distinct owned artifacts/reports and no cross-talk. |
| 9 | From one worktree, start two simultaneous `BOBBIT_V2_RETRY_FREE=1 npm run test:e2e` wrapper invocations | Both green; distinct owned artifacts/reports and no cross-talk. |
| 10 | Native CI at the exact SHA | Windows Node 22, Ubuntu Node 22 and Node 26, macOS Node 22, and CodeQL are green. Link the runs. |

Use repository coordinator wrappers only—never direct Playwright commands. Fresh concurrency worktrees must run `npm ci` before their test command. If native Windows/macOS is unavailable locally, record the local emulation precisely (for example, Linux-only code-path/unit seams); CI is the native proof and cannot be substituted by a host-spelling claim.

## Completion condition

The final PR describes category 1/2/3/4 outcomes, all verified commands/platforms, any unavailable native platform, and confirms that no tests/assertions were weakened or removed. The historical draft PR #1068 is eligible to close only after this PR merges and the ledger has no unclassified intended behavior.
