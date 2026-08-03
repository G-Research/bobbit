# Qualify Cross-OS Tests

## Authority, baseline, and scope

The sole semantic production baseline is `origin/main` at **`0299fe6b8268f01f136d2a6787983e662e0fdc94`**, confirmed by `git fetch origin main && git rev-parse origin/main`. The initial audit artifact, **`9e69181592df93f8d1be9014b06b3569886ec7dc`**, differs from that baseline only in these committed audit/design documents:

```text
docs/design/qualify-cross-os-tests.md
docs/testing-v2/cross-os-residual-reconciliation.md
```

It is not a semantic production baseline. The historical integration commit is a checklist only; this work neither cherry-picks it nor seeks textual equivalence. Focused PRs #1071, #1076, #1077, #1078, #1080, and #1089 and all newer `origin/main` behavior remain authoritative.

Implement only the 12 category-4 entries in [the ledger](../testing-v2/cross-os-residual-reconciliation.md). Preserve existing assertions, lifecycle contracts, and upstream changes. Do not add `test.skip`, weaker/deleted assertions, sleeps, polling, blind retry/reload, timeout increases, `force-exit`, global serialization, fixed ports, shared profiles/caches, checkout-local reports, or cleanup of a parent/shared root.

## Closed implementation manifest

This is the complete change allow-list. There are no implied adjacent helpers and no unresolved alternatives. New `tests2` entries are registered in `tests2/tests-map.json`; no test is moved or deleted.

| # | Production/document symbol | Exact regression file | Acceptance owner |
|---:|---|---|---|
| 1 | `vitest.config.ts::retryFreeQualificationEnabled` and `shared.retry`; `docs/testing-v2/fast-gate-design.md` | `tests2/core/unit-lanes-scheduling.test.ts` | Vitest config |
| 2 | `scripts/release-packed-consumer-audit.mjs::packedConsumerTempPrefix` and `runPackedConsumerAudit` | `tests2/core/release-skill-preflight-order.test.ts` | packed-consumer audit |
| 3 | `src/app/workflow-page.ts::renderVerifyStepEditor` local `updateStep` | `tests2/browser/workflow-review-timeout-editor.spec.ts` | workflow editor journey |
| 4 | `src/server/agent/pi-extension-contributions.ts::loadPiExtensionContributionsWithDiscovery` | `tests2/core/pi-extension-discovery-backend.test.ts` | Pi contribution loader |
| 5 | `src/server/server.ts::createGateway` sandbox bootstrap and `handleApiRoute` sandbox calls to `checkDockerAvailability`, `buildSandboxImage`, and `ensureImageAgentVersion` | `tests2/core/sandbox-status.test.ts` | gateway command-runner seam |
| 6 | `tests/e2e/README.md` | none; documentation-only exemption | E2E operator guide |
| 7 | `tests/e2e/pool-claim-restart-resume.spec.ts::test.describe.serial("pool claim restart-resume")` hooks | same E2E spec | restart/resume fixture |
| 8 | `scripts/testing-v2/run-browser-v2.mjs::{createBrowserRunPaths,createBrowserRunEnvironment,playwrightCommandArgs}` | `tests2/core/browser-run-wrapper.test.ts` | browser coordinator |
| 9 | `tests2/core/purge-preview-pool-shutdown-coder61c7.test.ts::{deferred,waitFor}` call sites | same core test | lifecycle test barriers |
| 10 | `tests2/core/team-manager.test.ts::{listedWorktreePaths,assertRegisteredWorktree}` | same core test | Git registration assertion |
| 11 | `tests2/dom/transient-draft-store.test.ts::{breakStorage,restoreStorage}` | same DOM test | storage fault fixture |
| 12 | `tests2/integration/skill-surface-consistency.test.ts` `beforeAll`/`afterAll` root lifecycle | same integration test | skill fixture roots |

The immutable qualification record path is **`docs/testing-v2/cross-os-qualification-record.md`**. It is created only after the final implementation/documentation commit is frozen; it contains concise evidence, never raw logs.

## Comparative designs and selected minimal compositions

Item 6 is documentation-only and deliberately exempt from comparative defect-surface accounting. Every other row below compares the selected composition with a materially different same-scope option before implementation. “Added surface” counts only new branch/state owner/transformation/API/dependency surface; all selections avoid new APIs unless the named helper is necessary.

| # | Control/data flow and failure propagation | Selected minimal composition | Same-scope alternative rejected | Files, seams, and added defect surface |
|---:|---|---|---|---|
| 1 | Environment is read during config construction → `shared.retry` is copied into every Vitest project. An unset/non-`1` value follows the developer default; a config-load error fails Vitest before discovery. | `retryFreeQualificationEnabled()` returns `process.env.BOBBIT_V2_RETRY_FREE === "1"`; use it once in `shared.retry`. Test snapshots/restores the exact env descriptor and reloads config. | Append `--retry=0` in every npm script. This misses direct/project invocations, duplicates policy, and lets a caller’s script choice become load-bearing. | `vitest.config.ts`, `tests2/core/unit-lanes-scheduling.test.ts`, fast-gate doc. One boolean branch; no state, API, dependency, or transformation beyond boolean→number. |
| 2 | `BOBBIT_V2_RUN_ROOT` → prefix selection → `mkdtemp` child → audit directories/env → `rm(child)` in `finally`. Invalid/uncreatable root rejects before audit; operation and cleanup errors remain aggregated. | `packedConsumerTempPrefix()` validates/canonicalizes the supplied root, creates only `join(root, "bobbit-release-packed-audit-")`, otherwise uses `tmpdir`; existing `runPackedConsumerAudit` cleans only its returned child. | Reuse the supplied run root directly and recursively remove it. This makes a coordinator parent an owned child, permitting concurrent audit destruction. | Script and existing release preflight test. One source-selection branch and a root→child transformation; no persistent state/API/dependency. The existing `npmRunner` seam proves child-only cleanup. |
| 3 | Input event → draft patch → `notifyControlledChange`; only a structural patch invokes `renderApp`. Failed save sets `saveAttempted`, so validation feedback is derived on the next render without replacing the focused input. Invalid workflow requests remain suppressed and focused in the current editor. | Change `if (rerender || saveAttempted)` to `if (rerender)`, preserving the existing `rerender` parameter and validation derivation. Browser test submits invalid input, keeps Advanced open/focus/value, then changes type and proves structural rerender and stale timeout suppression. | Introduce per-control DOM patching after every input. It adds a second renderer/state synchronization path and can diverge from held create/PUT revision behavior. | `workflow-page.ts` and one mapped browser spec. Removes one render branch; no new owner/API/dependency. The browser fixture is the UI seam; validation/network errors stay in existing save handling. |
| 4 | Module graph binds discovery implementation → contribution rows load → each eligible row awaits discovery → per-row diagnostic carries discovery failure. Loader/import errors reject the caller as today. | Static named import of `discoverPiExtensionTools` beside existing `discoverPiExtensionToolsSync`; retain the existing per-row await and options object. | Add a separate injected discovery callback to `loadPiExtensionContributionsWithDiscovery`. This expands the public options API and creates divergent production/test code paths. | Pi contribution module and existing backend test. One import dependency only; no new branch/state/API/transformation. Fixture-order test proves the prebundle seam. |
| 5 | Gateway dependency injection supplies `gatewayDeps.commandRunner` → bootstrap, status, build, and session validation pass it into sandbox-status helpers → Docker errors return existing status/error responses or bootstrap failure. | Thread the already-owned runner as the existing third argument at every named call site; leave `sandbox-status.ts` defaults intact for standalone callers. Fenced runner asserts all Docker invocations remain inside the gateway seam. | Set a process-global command runner inside `sandbox-status.ts`. That races concurrent servers, hides call ownership, and changes standalone helper behavior. | `server.ts`, existing `sandbox-status` core test. No new API/dependency/state; argument propagation only. Every error preserves existing helper/route propagation. |
| 7 | Per-test `mkdtemp` root → repo/project/session creation → restart restore → `finally` deletes session, project, then the owned root. Any setup/test failure still enters cleanup; cleanup failure fails the test rather than removing a parent. | Replace suite `Date.now()` base with awaited per-test `mkdtemp`; move mutable IDs/root into the test lifecycle and use ordered awaited `finally` cleanup. | Retain suite root and suffix names with a random string. It still couples tests to suite lifetime and leaves partial setup cleanup ambiguous. | One E2E spec. One per-test root state owner and ordered cleanup branches; no API/dependency. Existing gateway API and Git/reflog/inode seams remain the proof. |
| 8 | Coordinator allocates owned root → derives report/env → preserves forwarded args → runner/report budget completes → successful root cleanup. Discovery/runner/report errors retain only that root. | Add direct unit coverage of the three exported wrapper functions, injecting temporary roots/environment and checking the command vector. | Run two nested Playwright coordinators from the core test. It multiplies browser process ownership and obscures the wrapper’s pure allocation/argument seam. | New mapped `browser-run-wrapper.test.ts` plus tests map. Test-only addition; no production branch/state/API/dependency. The process spawn is intentionally not crossed. |
| 9 | Test double signals exact operation start → test starts overlap → test double holds/release signals completion → assertions observe causal state. A rejected operation rejects the awaited promise normally. | Use existing `deferred()` for every current `waitFor` and blind-turn site, then remove `waitFor`. | Add a generalized polling scheduler/helper with configurable turns. It retains timing dependence and adds scheduler state/options. | One core test. Test-local promises only; no production/API/dependency changes. Barriers cover purge, listener, expiry, preview, mount cleanup, and initial reclaim batch. |
| 10 | `git worktree list --porcelain` paths and asserted path → canonicalize each with `fs.realpathSync.native` when it exists → compare; missing/stale path uses `path.resolve`. Git/list errors propagate from `runGit`. | Add local `canonicalWorktreePath()` and use it in `listedWorktreePaths`/`assertRegisteredWorktree`; create an owned symlink/junction alias and require registration without skip. | Canonicalize all worktree paths in production `TeamManager`. This changes persisted/path-display semantics to fix only a test assertion and broadens runtime risk. | One core test. One local fallback branch and path transformation; no product API/state/dependency. Real Git and filesystem aliases are the seams. |
| 11 | Fixture captures descriptors for `globalThis` and `window` storage aliases → installs throwing proxy aliases → store catches storage access error → `finally` restores the exact descriptors. Restoration failure is surfaced. | Replace method patching with alias-level throwing `Proxy` descriptors and record/restore each original descriptor exactly. | Monkey-patch `Storage.prototype`. happy-dom aliases can bypass it and it mutates shared prototype state across tests. | One DOM test. Test-local descriptor records and proxies only; no production/API/dependency changes. Both alias sets are exercised. |
| 12 | `beforeAll` allocates P/Q/R/custom roots independently → endpoints consume registered project paths → `afterAll` deletes projects and all four roots even after partial registration. Discovery/runner errors fail the integration test. | Use four `mkdtempSync(join(tmpdir(), prefix))` allocations and explicit root cleanup after API deletion attempts. | One shared `mkdtemp` parent with P/Q/R children. A partial cleanup or concurrent fixture can consume a sibling/parent. | One integration test. Four independent root owners and cleanup branches; no production/API/dependency changes. Real REST/discovery cache paths are retained. |

## Given/When/Then acceptance and error contracts

| # | Given / When / Then | Error contract |
|---:|---|---|
| 1 | **Given** flag unset, **when** config loads, **then** every unit project remains retry 3. **Given** flag `1`, **when** config loads, **then** every unit project is retry 0. | Any other/unset value is default, not truthy retry-free. Config-load failure aborts discovery; test restores the prior environment descriptor. |
| 2 | **Given** a usable run root, **when** audit starts, **then** it receives one unique child and cleanup removes only that child. **Given** no root, **when** audit starts, **then** it uses an OS-temp child. | Unusable root fails allocation before audit; operation plus cleanup failure remains an `AggregateError`; cleanup-only failure remains an error and never deletes the parent. |
| 3 | **Given** an invalid verification step with Advanced open, **when** save is rejected and timeout input changes, **then** focus, input node/value, and open state persist; a type change still rerenders and removes stale timeout. | Invalid workflow request remains locally suppressed with existing validation/focus behavior; held create/PUT failures retain their #1076 revision handling. |
| 4 | **Given** a fixture can disturb post-load resolution, **when** async contributions load, **then** discovery was bound in the initial module graph and eligible rows discover tools. | Discovery failure remains a per-row diagnostic; module/load failure rejects the existing async caller. |
| 5 | **Given** a fenced gateway runner, **when** bootstrap, sandbox status/build, or session validation invokes Docker, **then** every command crosses that runner. | Docker availability/build/version failures preserve existing bootstrap/route/session error responses; no fallback host spawn occurs. |
| 6 | **Given** an E2E operator, **when** reading the guide, **then** it states API workers 2 and retry-free qualification flag 1. | It declares retries developer protection only; no executable behavior changes. |
| 7 | **Given** a restart-resume test, **when** it creates a repo/project/session and restores, **then** its root is unique and branch/reflog/inode assertions remain byte-stable. | Partial setup and assertion failure still await session/project/root cleanup in `finally`; cleanup failure is visible and cannot remove an unowned root. |
| 8 | **Given** two allocations and caller flags, **when** wrapper helpers run, **then** roots/reports are distinct and outside checkout, flags survive, and ledger capture occurs before isolated artifacts. | Missing CLI, runner, or report remains existing nonzero failure with only that coordinator root retained; retry-free browser behavior is asserted. |
| 9 | **Given** held destructive/lifecycle operations, **when** overlaps are introduced at named causal barriers, **then** existing ordering/no-recreation/cleanup assertions hold without polling. | Any held operation rejection propagates through its awaited promise; barriers have no timeout/retry fallback. |
| 10 | **Given** a registered realpath and an owned symlink/junction spelling, **when** registration is asserted, **then** they compare equal; stale/missing registrations compare lexically. | Git listing errors remain failures; unavailable canonicalization falls back only for missing/stale paths, not a skipped alias test. |
| 11 | **Given** storage aliases on global and window, **when** throwing proxies are installed, **then** the real store handles the fault and later tests see exactly restored descriptors. | Install failure restores already changed descriptors; restoration failure surfaces rather than poisoning independent cleanup. |
| 12 | **Given** P/Q/R/custom fixture roots, **when** projects/endpoints run, **then** each root is independently unique and current skill-surface assertions hold. | Registration/discovery failure still independently deletes successfully created projects and every owned root; no shared parent cleanup exists. |

## System journeys beyond the command matrix

**Browser workflow journey.** `workflow-review-timeout-editor.spec.ts` loads a workflow fixture, opens Advanced, causes validation failure, edits the active timeout control, and verifies its focus/value and Advanced state survive. It then changes the verification type and verifies the structural rerender removes stale timeout state. This complements coordinator concurrency: it proves the user-visible invalid-request suppression/focus boundary that a process-level matrix cannot observe.

**Restart/resume system journey.** `pool-claim-restart-resume.spec.ts` creates a real Git project through the API, waits for a pool claim, records branch/reflog/inode identity, reinvokes restore, and re-reads the API state. It proves session lifecycle and process-resume semantics while the matrix proves isolated wrapper concurrency. Its per-test owned fixture cleanup is part of the journey, not an external afterthought.

## Exact-head qualification

After all allowed changes are committed, freeze one immutable SHA and write `docs/testing-v2/cross-os-qualification-record.md` using:

```text
sha | command | suite | attempt/coordinator | worktree | retryFree | retriesObserved | exit | durationMs | artifactOrCIUrl | notes
```

Every retry-free row has `retriesObserved = 0`. A code, test, harness, configuration, or documentation change after freezing invalidates affected evidence; a coordinator, selection, or reporting change invalidates the complete matrix. Failed runs are diagnosed and classified as goal-caused, acceptance-blocking upstream, or infrastructure-only; none is masked.

| Order | Command / setup | Proof |
|---:|---|---|
| 1 | `npm run check` | green exact-head type check |
| 2–5 | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit`; `BOBBIT_V2_RETRY_FREE=1 npm run test:browser`; `BOBBIT_V2_RETRY_FREE=1 npm run test:unit -- --project=v2-integration`; `BOBBIT_V2_RETRY_FREE=1 npm run test:e2e` | one serial green wrapper/lane pass each |
| 6 | five consecutive `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` runs | five green gates, zero retries each |
| 7 | three clean same-SHA worktrees; `npm ci`, then simultaneous `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` wrappers | three green isolated coordinators |
| 8 | two simultaneous `BOBBIT_V2_RETRY_FREE=1 npm run test:browser` wrappers in one worktree | two green, distinct owned reports/artifacts |
| 9 | two simultaneous `BOBBIT_V2_RETRY_FREE=1 npm run test:e2e` wrappers in one worktree | two green, distinct owned artifacts |
| 10 | native CI at the SHA | Windows Node 22, Ubuntu Node 22/26, macOS Node 22, and CodeQL green |

Use repository wrappers, never direct Playwright. If Windows/macOS is unavailable locally, record precisely what Linux seams were emulated; CI is the native proof.

## PR delivery and closure guard

The focused PR against current `main` lists every category 1/2/3/4 result, each newly implemented item, verified commands/platforms, unavailable native platforms, the exact record path/SHA, and confirmation that no assertions/tests were weakened or removed. Its description ends with the required Bobbit footer. Do not close historical draft PR #1068 until this PR has merged and the ledger confirms every intended #1068 behavior is merged, superseded, intentionally dropped, or implemented with no unclassified row.
