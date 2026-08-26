# Windows unit-gate base-path audit

> **Historical layout notice.** This document preserves migration, incident, or measurement
> evidence from before Bobbit adopted the canonical `tests/` hierarchy. Old `tests2/`
> and non-semantic test paths, map/affected-selector references, commands, counts, and
> lane names below describe the recorded revision; they are not current instructions.
> Keep measured citations unchanged. For current placement and discovery, use [Testing
> Strategy](../testing-strategy.md) and [`scripts/testing/layout-policy.mjs`](../../scripts/testing/layout-policy.mjs).

## Context

This audit records the Windows diagnosis and qualification for the base-path gateway integration coverage. The governing constraints remain the [unit-gate operating model](unit-gate.md), including its 25-second per-file wall budget, and the fixture ownership rules in [Cross-OS test authoring](cross-os-test-authoring.md).

## Failure evidence

In GitHub Actions [run 30812190708, job 91681321263](https://github.com/G-Research/bobbit/actions/runs/30812190708/job/91681321263), every assertion passed, but the reporter measured `tests2/integration/base-path-gateway-routes.test.ts` at about 29,200 ms. The five sandbox-network shutdown phases took 10,297, 10,077, 7,734, 294, and 83 ms: 28,539 ms in total. Their corresponding gateway startups took only 5–13 ms.

The imbalance identified shutdown ownership, rather than startup or cumulative assertion cost, as the cause of the file-budget breach.

## Lifecycle fix

Successful sandbox-network creation is now owned by the `SessionManager` instance that created it. An `already-exists` result does not grant ownership to another manager. The successful creator publishes synchronously consumed, exact-once cleanup, preventing a later manager from waiting on or removing a resource it did not create.

The integration fixture uses `createRunChild` for its mutable child and `removeOwnedRunChild` only after gateway shutdown and restoration of the process state. This retains exact cleanup ownership under the harness run root.

## Regression and qualification

Retry-free focused qualification ran the base-path coverage three consecutive times on native Windows. Each run completed in about 1.2 seconds, with shutdown phases of 1–7 ms, providing substantial headroom below the 25-second file budget.

Historical focused timings for other reported files were:

| Coverage | Native Windows timing |
| --- | ---: |
| Message author | 2.23 s |
| Stateless cookie | 4.69 s |
| WebSocket frame | 4.54 s |
| Gate reset | 8.22 s |

The focused regression and full gate were qualified with the repository commands, including:

```powershell
npm run check
npm run test:unit -- --retry=0
$env:BOBBIT_V2_RETRY_FREE = '1'; npm run test:browser -- --retries=0
$env:BOBBIT_V2_RETRY_FREE = '1'; npm run test:e2e
```

The full implementation gate passed build, check, focused reproduction, unit, browser, and E2E qualification after the OAuth restart issue described below was fixed.

## Recent Windows failure audit

| Run | Disposition | Evidence |
| --- | --- | --- |
| [30812190708](https://github.com/G-Research/bobbit/actions/runs/30812190708) | Actionable; fixed here | Base-path assertions passed, but non-owned sandbox-network shutdown consumed 28,539 ms and breached the file budget. |
| [30806487088](https://github.com/G-Research/bobbit/actions/runs/30806487088) | Duplicate of PR #1096 | The packed-audit `ENOENT` failure is already covered by the cross-OS reliability work. |
| [30760780858](https://github.com/G-Research/bobbit/actions/runs/30760780858) | Sandbox fixed by PR #1095; intermittent cases still actionable | Message-author and stateless-cookie failures remain separate intermittent work; focused native timings were 2.23 s and 4.69 s. |
| [30800679923](https://github.com/G-Research/bobbit/actions/runs/30800679923) | Sandbox fixed by PR #1095; intermittent cases still actionable | WebSocket-frame and gate-reset failures remain separate intermittent work; focused native timings were 4.54 s and 8.22 s. |
| [30759710982](https://github.com/G-Research/bobbit/actions/runs/30759710982) | Fixed by PR #1077 | No remaining duplicate in this change. |
| [30799500277](https://github.com/G-Research/bobbit/actions/runs/30799500277) | Fixed by PRs #1092 and #1095 | No remaining duplicate in this change. |

## PR #1096 non-overlap

PR #1096, **Qualify cross-OS test reliability**, owns the Windows packed-audit `ENOENT` fix. This change does not duplicate it: it repairs sandbox-network lifecycle ownership and the base-path fixture cleanup ordering. The two changes can therefore be rebased in either order without sharing a causal fix.

## OAuth restart regression

Faster gateway shutdown exposed a latent `ECONNRESET` in OAuth restart coverage: a pooled fetch connection could be reused across the restart boundary. The restart probe now uses a dedicated `node:http` request with `agent: false` and `Connection: close`, preserving the assertion that the first attempt succeeds without adding retries or weakening the restart check.

## Rejected alternatives

Partitioning the base-path suite was rejected. The scenarios were not independently expensive; one lifecycle ownership defect accounted for nearly the entire file time. Splitting the file would have hidden that defect while scattering cohesive base-path coverage.

No `docs/debugging.md` entry was added. The diagnosis is fixture-specific, while the reusable rule—exact resource ownership and cleanup after owned children settle—is already documented in the unit-gate and cross-OS authoring guides linked above.
