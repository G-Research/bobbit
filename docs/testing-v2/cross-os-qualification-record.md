# Cross-OS qualification record

> **Historical layout notice.** This document preserves migration, incident, or measurement
> evidence from before Bobbit adopted the canonical `tests/` hierarchy. Old `tests2/`
> and non-semantic test paths, map/affected-selector references, commands, counts, and
> lane names below describe the recorded revision; they are not current instructions.
> Keep measured citations unchanged. For current placement and discovery, use [Testing
> Strategy](../testing-strategy.md) and [`scripts/testing/layout-policy.mjs`](../../scripts/testing/layout-policy.mjs).

## Scope and evidence boundaries

- **Final executable/test SHA:** `8c15c37407ed177d7f114af11a3db8151e0aa5cb`
- **Historical reconciled production base:** `origin/main` `fd25842abf5fe982946ef397fe5b5698c6fea950`
- **Current delivery base:** `origin/main` `89ec9bbd73e076a40321e282583f1a1c180b2513` (follow-up rebase only)
- **Reporting commit:** this document is a documentation-only descendant of the final executable/test SHA.

This record preserves the chronology rather than treating earlier results as final-head proof. The broad matrix at `8947fa67e88de90d3d24cb9b4d2425f3532c38c7` established the predecessor reliability result. Its first durable three-worktree unit attempt then exposed a real fixed-port blocker. The final delta through `8c15c374` removes physical `53692` binding from unit and integration coverage. The user approved the focused final proof below instead of repeating the complete matrix after that bounded correction. The delivery rebases retain #1098's CodeQL configuration, #1099's lifecycle hook-scope context, #1106's durable Hindsight reads, #1110's session connection-timeout handling, and #1111's Windows base-path stability changes, but record no new qualification evidence; the historical results below are not proof for the rebased head.

All listed test commands use `BOBBIT_V2_RETRY_FREE=1`; runner retries observed were zero. Repository wrappers were used for full-suite commands. Raw logs are deliberately not committed.

## Historical predecessor evidence

The merged-base predecessor `8947fa67e88de90d3d24cb9b4d2425f3532c38c7` passed `npm run check`, one serial retry-free pass of unit, browser, integration, and E2E, five additional retry-free full-unit gates, and exact native Windows Node 22, Ubuntu Node 22/26, and macOS Node 22 CI. Those results are retained as historical broad coverage only; they are not represented as proof for `8c15c374`. The older `0ffb3e41de62a6de4bb95285b8ed83946c84291a` evidence is likewise a historical precursor, not final-head proof.

The initial durable three-clean-worktree unit attempt at that predecessor found the remaining fixed loopback-port contention. It was diagnosed rather than retried or masked: final unit/integration ownership no longer starts Pi's process-global listener.

## Final focused proof

| SHA | Command | Scope / coordinator | Exit | Duration | Totals | Retries | Notes |
|---|---|---|---:|---:|---|---:|---|
| `8c15c374` | `npm run build` | generated-artifact prerequisite | 0 | — | complete | 0 | Required before checking the clean worktree's generated modules. |
| `8c15c374` | `npm run check` | type check | 0 | — | complete | 0 | Passed after the build prerequisite. |
| `8c15c374` | `BOBBIT_V2_RETRY_FREE=1 npm exec -- vitest run --config vitest.config.ts --silent=passed-only tests2/core/anthropic-oauth-pi-callback-contract-repro.test.ts tests2/core/anthropic-oauth-adapter.test.ts tests2/integration/anthropic-oauth-lifecycle.test.ts` | Pi source contract, adapter, and gateway lifecycle | 0 | 4,040ms | 3 files; 34 tests | 0 | Covers the fixed-port reproduction, non-listening adapter harness, and real-route facade. |
| `8c15c374` | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` | clean worktree unit-1 | 0 | 169,449ms | 1,020 files; 9,183 tests; 3/11 skipped | 0 | Isolated HOME/TMP/XDG/npm cache/run root; `npm ci` completed first. |
| `8c15c374` | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` | clean worktree unit-2 | 0 | 169,679ms | 1,020 files; 9,183 tests; 3/11 skipped | 0 | Isolated HOME/TMP/XDG/npm cache/run root; `npm ci` completed first. |
| `8c15c374` | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` | clean worktree unit-3 | 0 | 174,523ms | 1,020 files; 9,183 tests; 3/11 skipped | 0 | Isolated HOME/TMP/XDG/npm cache/run root; `npm ci` completed first. |

The three full-unit coordinators overlapped for 168,548ms. Each used an independently owned temporary root and was cleaned after completion. Foreign-root scans, `53692` scans, and `EADDRINUSE` scans were all zero. No test was rerun after a test failure.

## OAuth ownership contract

The installed Pi source remains the authority for the redirect URI and requested scopes. The core adapter suite retains Pi callback, lease, and compare-and-swap behavior through a non-listening HTTP harness. The integration suite retains real gateway routes with a deterministic Pi-shaped facade, exercising callback parsing, state validation, cancellation, and credential persistence without claiming Pi's process-global listener. This division removes physical `53692` binding from concurrent unit/integration coordinators without weakening the provider contract.

## Native CI and CodeQL

[Build & Unit Gate run 30831490676](https://github.com/G-Research/bobbit/actions/runs/30831490676) is an exact-head PR #1096 run for `8c15c37407ed177d7f114af11a3db8151e0aa5cb`. Its Ubuntu Node 22, Ubuntu Node 26, Windows Node 22, and macOS Node 22 jobs all concluded `success`.

CodeQL retains the earlier qualification exception: its Actions analysis succeeded, while JavaScript/TypeScript remained in progress or repeated the known hosted-analysis behavior. This record makes **no** claim of a green exact-head JavaScript/TypeScript CodeQL result.

## Integrity statement

No assertion or test was removed or weakened. The final correction adds no `test.skip`, sleep, polling loop, blind retry/reload, timeout increase, force-exit, or global serialization. It does not rely on test retries.
