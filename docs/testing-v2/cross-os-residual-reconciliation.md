# Cross-OS residual reconciliation ledger

**Reference extraction:** `e3051de63cf611143a989f7928bd9f9a7ed9beae^2..e3051de63cf611143a989f7928bd9f9a7ed9beae`

**Authoritative production baseline:** `origin/main` at **`89ec9bbd73e076a40321e282583f1a1c180b2513`**, refreshed and confirmed with `git fetch origin main && git rev-parse origin/main`. This exact production commit—not the goal branch—is the authority for the delivered tree. The original 50-row classification was semantically rechecked against `fd25842abf5fe982946ef397fe5b5698c6fea950`; the earlier delivery base `186781fc4d534fbde47d5fd1c56e92ae53ab98c4`, that commit, and `5c7c2e4997ba78cb7c9268443a52a6427a97ca17`, `a870161aad23a704761a4528f43d898c2792c800`, and `0299fe6b8268f01f136d2a6787983e662e0fdc94` remain provenance for earlier refreshes only.

**Refresh validation:** all 50 extracted file rows, including every mixed-category row, were semantically rechecked against `fd25842a`. The upstream delta `0299fe6b..a870161a` was explicitly inspected for rows 8 (`session-manager.ts`), 18 (`server.ts`), and 35 (`session-manager-direct-prompt-lifecycle.test.ts`): #1093 strengthens prompt recovery and its lifecycle pins, #1092 hardens transactional project-config/secret persistence, and #1094 guards background-process spawning. In the follow-up delta `a870161a..5c7c2e49` (#1095), row 18 is the only overlapping reference row. Its default, request-scoped `CommandRunner` makes the sandbox-status route use the received/defaulted runner; category 4 supplies that same injected runner to the remaining bootstrap, build, image-version, and session-validation Docker helpers. The changes are compatible, and #1095's default remains authoritative. The `5c7c2e49..fd25842a` delta (#1097) changes only optional Windows supervisor file handling and its regression pin (reference rows 9 and 36); it is retained, non-conflicting upstream hardening and changes no classification or allow-list item. The first delivery rebase retained #1098's threat-model-scoped CodeQL configuration and #1111's Windows base-path run-root fixture ownership and exact-once sandbox-network cleanup; the only overlapping test block combines #1111's gateway-fixture assertions with the goal's owned E2E-output assertion. The follow-up delivery rebase retains #1099's lifecycle hook-scope context, #1106's durable Hindsight reads, and #1110's session connection-timeout handling. These upstream changes do not alter a residual classification or allow-list item. #1095's credential-lock bounds, source-contract guard, mixed-fixture isolation, and unit-flake diagnostics likewise remain authoritative outside the historical rows. None authorizes regressing newer contracts. This is a semantic reconciliation, not a cherry-pick plan. Categories are: **1** merged by a focused PR; **2** superseded by stronger current behavior; **3** intentionally obsolete/inapplicable; **4** genuinely missing. Each of the 50 unique reference files appears exactly once below. A file can contain multiple independently classified behaviors.

**Category-4 allow-list:** only the exact implementation/test/document paths and symbols in `docs/design/qualify-cross-os-tests.md` may change for this residual. The closed set is items 2, 3, 4, 5, 18, 19, 20, 24, 34, 37, 39, 42, and 49 in the table below (13 reference rows implementing 12 behaviors; rows 2 and 39 are the one retry-free behavior). No category 1/2/3 row is implementation authority. The separately documented native-CI acceptance enablement is excluded from this historical residual and does not change the 50-file or 12-behavior counts.

| # | Reference file | Category | Reconciled behavior and production-baseline validation |
|---:|---|:---:|---|
| 1 | `.gitignore` | 3 | The reference checkout-local `test-results-v2*` wildcard is obsolete: browser artifacts now live in each coordinator's system-temp root. Retaining the legacy fixed-path ignore is harmless; a broad checkout artifact policy would contradict run ownership. |
| 2 | `docs/testing-v2/fast-gate-design.md` | 4 | The historical `--retry=0` prose must be adapted to `BOBBIT_V2_RETRY_FREE=1`. `vitest.config.ts` still hard-codes `retry: 3`, so the required unit retry-free control and its documentation are missing. |
| 3 | `scripts/release-packed-consumer-audit.mjs` | 4 | `runPackedConsumerAudit()` still calls `mkdtemp(join(tmpdir(), ...))`. It must allocate only an atomic child of canonical `BOBBIT_V2_RUN_ROOT` when present, with OS-temp fallback, and never remove its parent. |
| 4 | `src/app/workflow-page.ts` | 1, 4 | #1076's revision-aware held-create/PUT preservation is present and pinned. Separately, `renderVerifyStepEditor().updateStep()` still calls `renderApp()` when `saveAttempted`; this can replace an active timeout input and close Advanced. Preserve #1076 and remove only that validation-triggered render. |
| 5 | `src/server/agent/pi-extension-contributions.ts` | 4 | `loadPiExtensionContributionsWithDiscovery()` still dynamically imports `pi-extension-discovery` after fixture setup. Statically bind `discoverPiExtensionTools` with the sync entry point and add one prebundle/fixture-order regression. This is the sole Pi item. |
| 6 | `src/server/agent/project-registry.ts` | 1, 2 | #1077 provides dialect-aware identity, bounded evidence, canonical registry dedupe, and component containment. Its conservative foreign-Windows descendant handling, directory-identity cache binding, and hard-link treatment supersede the reference's unsafe folding/fingerprint-only variants. |
| 7 | `src/server/agent/resolve-project.ts` | 1 | #1077's `realOrResolved()` longest-existing-prefix walk and `isSameOrDescendant()` relative-boundary check retain the reference contract. |
| 8 | `src/server/agent/session-manager.ts` | 1, 2 | #1076 retains echoed-steer settlement, exactly-once post-abort drain, and ordering. #1077's validated readable/canonical persisted transcript identity supersedes returning raw lexical spelling; replaying an echoed steer is intentionally not restored. The inspected #1093 delta additionally distinguishes narrow external cancellation from provider failure, deduplicates terminal boundaries, and persists manual-retry state; those newer recovery contracts remain authoritative. |
| 9 | `src/server/agent/spawn-tree.ts` | 1, 2 | #1089 retains tracked POSIX/Windows ownership, readiness, root-exit finalization, and fail-closed survival. Its `/proc`/Darwin nonce identity and nonce-bound Windows completion proof supersede the reference sentinel record. |
| 10 | `src/server/agent/transcript-sanitizer.ts` | 1 | Trusted persisted file lexical and canonical spellings are retained with alias and CRLF coverage from #1077. |
| 11 | `src/server/agent/verification-command-runner.ts` | 1 | #1089 forwards nonce-bound POSIX sentinel identity through durable command spawning. |
| 12 | `src/server/agent/verification-harness.ts` | 1 | #1089 retains durable sentinel records, recovered-goal cleanup, exact group proof, payload-before-transport cleanup, lifecycle completion proof, and durable host/container reaping; current witnesses are stronger. |
| 13 | `src/server/agent/verification-logic.ts` | 1 | #1089 makes all Windows host-detached recovery pending-retry and retains separate container recovery. |
| 14 | `src/server/agent/worktree-inventory.ts` | 1 | Async discovery and lexical normalization before filesystem/Git identity remain; current path identity is the #1077 authority. |
| 15 | `src/server/agent/yaml-store.ts` | 1 | `YamlStore.itemPath()` keeps relative-path containment and rejects sibling-prefix/absolute traversal. |
| 16 | `src/server/extension-host/path-guard.ts` | 2 | Current strict containment preserves lexical/canonical roots and adds mixed-dialect and case-sensitive Windows descendant protection beyond the reference. |
| 17 | `src/server/preview/path-guard.ts` | 2 | Current missing-asset lexical-root handling and `isPathContained()` boundary check retain and harden the reference behavior. |
| 18 | `src/server/server.ts` | 4 | At `fd25842a`, #1095 already makes `handleApiRoute()` default and use its request-scoped `commandRunner` for sandbox status. The remaining bootstrap, build, image-version, and sandbox-session validation Docker helpers still need that injected seam; pass it to every `checkDockerAvailability`, `buildSandboxImage`, and `ensureImageAgentVersion` call and pin fenced execution. This extends rather than replaces #1095's authoritative default. The explicitly inspected #1092 transactional config/secret persistence and #1094 background-process spawn guards are separate newer `server.ts` behavior and must remain intact. |
| 19 | `tests/e2e/README.md` | 4 | It incorrectly says API uses four workers while `playwright-e2e.config.ts` uses two, and it describes retried concurrent runs as acceptable proof. Update to the two-worker and retry-free `BOBBIT_V2_RETRY_FREE=1` contract. |
| 20 | `tests/e2e/pool-claim-restart-resume.spec.ts` | 4 | The suite-scoped `Date.now()` directory can collide and is never owned-cleaned. Make the fixture per-test canonical `mkdtemp` state with awaited session/project/root cleanup, retaining byte-stable branch, reflog, and inode assertions. |
| 21 | `tests/spawn-tree-shutdown-survival.test.ts` | 1 | #1089 retains public `markSurvival`, pre-ready reaping, ownership-ready survival, and native Windows Job closure coverage. |
| 22 | `tests/ui-fixtures/goal-workflow-editor-entry.ts` | 1 | The nullable fixture workflow/create-editor support is already subsumed by current #1076 held-create fixture helpers. |
| 23 | `tests2/browser/fixtures/goal-workflow-editor.spec.ts` | 1 | Current held-create, held-PUT, and navigation draft tests are stronger than the reference and pin #1076's generation/revision protocol. |
| 24 | `tests2/core/browser-run-wrapper.test.ts` | 4 | Production `createBrowserRunPaths()`, argument forwarding, ledger capture ordering, and browser retry-free support exist, but the reference regression file is absent. Add a focused core pin for distinct owned roots, outside-checkout reports, forwarded flags, and capture-before-isolation. |
| 25 | `tests2/core/component-path-traversal.test.ts` | 1 | #1077 retains POSIX/Windows component traversal coverage. |
| 26 | `tests2/core/extension-host-path-guard.test.ts` | 1 | Current tests retain alias, escaping-symlink, dual-dialect, and no-permission-skip coverage, with later case-sensitive hardening. |
| 27 | `tests2/core/extension-host-terminal.test.ts` | 2, 3 | #1080's source-and-packaged drain/reconnect/ordering test supersedes the reference output-before-exit test. Its generic test-only flush waits are obsolete because the explicit host drain contract is stronger. |
| 28 | `tests2/core/gate-verification-ux.test.ts` | 2 | The exact Windows-with-Git-Bash assertion is absent here, but #1089's verification lifecycle suite covers the authoritative all-Windows pending-retry contract more directly; do not duplicate a stale projection test. |
| 29 | `tests2/core/ledger-lease-bridge-interop.test.ts` | 2 | #1071's explicit per-file ledger root and two-process distinct-temp-root assertion supersede the reference's local empty-ledger check. |
| 30 | `tests2/core/preview-path-guard.test.ts` | 1 | The portable escaping-symlink seam and POSIX/Windows containment coverage are retained and strengthened. |
| 31 | `tests2/core/project-preflight.test.ts` | 1 | #1077 retains host-independent case-folded project identity warning coverage. |
| 32 | `tests2/core/project-registry-provisional-dedupe.test.ts` | 1 | #1077 retains missing-suffix, native-sensitive/insensitive Windows, and provisional/Headquarters alias coverage. |
| 33 | `tests2/core/project-registry-root-paths.test.ts` | 1, 2 | The POSIX/drive/UNC/APFS/probe/cache matrix is retained; the old all-components foreign-Windows fold is deliberately replaced by per-directory evidence. |
| 34 | `tests2/core/purge-preview-pool-shutdown-coder61c7.test.ts` | 4 | It still uses a 1,000-turn `setImmediate` polling helper and blind scheduling turns. Replace each observation with one-shot deferred causal barriers without reducing lifecycle assertions. |
| 35 | `tests2/core/session-manager-direct-prompt-lifecycle.test.ts` | 1 | #1076 retains non-replay, unechoed recovery, chronological ordering, and ordinary-queue priority coverage. The inspected #1093 additions pin external-abort classification, terminal-frame deduplication, manual-retry persistence, and provider-backoff parking; they strengthen rather than replace the retained #1076 invariants. |
| 36 | `tests2/core/spawn-tree-process-cleanup.test.ts` | 1 | #1089's current suite covers native descendant reaping, recovered sentinel identity, readiness, PID/PGID reuse, Windows Job closure, and no persisted-PID fallback. |
| 37 | `tests2/core/team-manager.test.ts` | 4 | `assertRegisteredWorktree()` compares only lexical `path.resolve()` values. Add canonical realpath-with-lexical-fallback comparison and an owned symlink/junction alias regression. |
| 38 | `tests2/core/transcript-sanitizer.test.ts` | 1 | Current portable symlink seam, lexical/canonical alias, and CRLF persisted transcript coverage retain the reference. |
| 39 | `tests2/core/unit-lanes-scheduling.test.ts` | 4 | It currently asserts retry three for all projects and has no retry-free unit configuration contract. Pin `BOBBIT_V2_RETRY_FREE=1` resolving to zero retries while default remains three; retain the fixed worker cap. |
| 40 | `tests2/core/verification-command-restart-lifecycle.test.ts` | 1 | #1089 retains Windows rejection and payload-before-transport recovery assertions, with stronger witness retries. |
| 41 | `tests2/core/verification-harness-timeout.test.ts` | 1 | #1089 retains manual-clock failure when cleanup is unproven, including zero exit and open descendants. |
| 42 | `tests2/dom/transient-draft-store.test.ts` | 4 | It patches `Storage` methods directly, which happy-dom can bypass. Replace it with throwing storage proxy aliases installed on both `globalThis` and the active window, with descriptor restoration. |
| 43 | `tests2/harness/fake-verification-command-runner.ts` | 2 | The fake's current `closed` `waitForTreeExit()` result correctly models the stronger #1089 completion boundary. |
| 44 | `tests2/integration/_e2e/fake-cmd-setup.ts` | 2 | The manual integration fake likewise returns `closed`, superseding unconditional-success completion. |
| 45 | `tests2/integration/abort-status-e2e.test.ts` | 1 | #1076's deterministic suppressed-echo post-abort recovery assertion is retained. |
| 46 | `tests2/integration/base-ref-api.test.ts` | 1 | Canonical fixture root capture and pre-canonical warning construction are retained. |
| 47 | `tests2/integration/helpers/local-mock-agent-clock.ts` | 1 | #1076 retains restore-boundary session-local clock attachment before queue drain. |
| 48 | `tests2/integration/project-ui-api.test.ts` | 1 | The API project-listing expectation uses the canonical registered fixture root. |
| 49 | `tests2/integration/skill-surface-consistency.test.ts` | 4 | P/Q/R/custom fixture roots still derive from PID/time and recursive mkdir. Allocate each with atomic `mkdtempSync` and retain existing cleanup and behavior assertions. |
| 50 | `tests2/integration/steer-gateway-restart.test.ts` | 1 | #1076 retains the restore-boundary mock clock for user and agent steer restart paths. |

## Validated category-4 implementation list

The following are the complete missing set, initially validated against `fd25842abf5fe982946ef397fe5b5698c6fea950` rather than copied from the historical patch and retained by the follow-up delivery rebase onto `89ec9bbd73e076a40321e282583f1a1c180b2513`:

1. Unit retry-free configuration and its fast-gate/unit-lane documentation and pin.
2. Packed-consumer run-root child allocation and ownership pin.
3. Workflow verification-step validation must not render active controls, with timeout-editor regression.
4. Eager Pi discovery import and prebundle/fixture-order regression.
5. Gateway Docker helper command-runner propagation and fenced-runner regression.
6. E2E README worker/retry policy correction.
7. Pool restart fixture atomic ownership and cleanup.
8. Browser coordinator regression coverage for existing run-root/retry implementation.
9. Deferred causal barriers replacing purge/preview/pool/diagnostics polling.
10. Team-manager realpath alias registration regression with missing-path fallback.
11. Transient draft storage failure proxy-alias regression.
12. Skill-surface fixture atomic temporary roots.

No duplicate Pi work exists. No category-1 or category-2 implementation is to be reverted, and no assertion, test, or behavior is to be weakened or removed.

## Native CI acceptance enablement (outside the reference residual)

The following three paths are final-qualification plumbing, not rows from the 50-file extraction and not category-4 authority. They preserve existing PR/main triggers, the CodeQL schedule, and native matrices while adding no-input manual dispatch so both workflows can prove the final pushed qualification branch's exact `head_sha`. `tests2/core/build-unit-gate-ci.test.ts` pins that contract.

| Paths | Acceptance contract |
|---|---|
| `.github/workflows/build-unit-gate.yml`; `.github/workflows/codeql.yml`; `tests2/core/build-unit-gate-ci.test.ts` | Dispatch both workflows from the final pushed qualification branch and record each GitHub run's `head_sha`; it must equal the frozen qualification SHA. |

## Qualification-discovered blockers

These changes were found while preparing the required exact-head matrix. They preserve the reliability contract; no assertion was weakened or removed, and none adds retries, skips, timeout increases, sleeps, polling, or global serialization.

| Blocker | Resolution and ownership | Residual-manifest relationship |
|---|---|---|
| Simultaneous E2E coordinators could overwrite Playwright's checkout-local `test-results/.last-run.json`. | `playwright-e2e.config.ts` puts `outputDir` beneath the coordinator root; `tests2/core/run-isolation.test.ts` pins two distinct owned outputs. | Both paths are net-new qualification-blocker paths. |
| Pi's process-global Anthropic callback listener binds fixed loopback port `53692`, so physical listener coverage cannot run concurrently in unit or integration coordinators. | The installed Pi source contract remains authoritative for redirect URI and scopes. Core retains Pi callback, lease, and compare-and-swap coverage through a non-listening HTTP harness; integration retains real gateway routes with a deterministic Pi-shaped facade for callback parsing, state validation, cancellation, and credential persistence. The browser journey uses deterministic UI routes. | The convention-discovered browser journey, Pi source-contract repro, OAuth adapter, and gateway lifecycle paths are focused qualification-blocker coverage. |
| Windows reports `ENOENT` as well as `ENOTDIR` when an invalid packed-consumer audit root is used. | `tests2/core/release-skill-preflight-order.test.ts` accepts only those two platform-equivalent errors and retains explicit assertions that neither the supplied root nor its parent is removed. | Existing residual-manifest path for item 2; no net-new path. |

Final qualification evidence is recorded in [the qualification record](cross-os-qualification-record.md). Its predecessor broad matrix is historical evidence; the focused final proof is at `8c15c37407ed177d7f114af11a3db8151e0aa5cb` after the fixed-port correction.

## Goal-branch implementation status

This status records implementation against the category-4 allow-list only. It does not change the `origin/main` baseline classifications above. The historical manifest recheck with `git diff --name-only fd25842a...HEAD` found 36 paths. The follow-up delivery rebase preserves that closed residual implementation/documentation manifest while taking the current `origin/main` baseline at `89ec9bbd`; it adds no residual implementation entry. The manifest contains the design, ledger, and qualification record; the three exact-head native-CI enablement paths; and the focused qualification-blocker paths (owned E2E output plus OAuth browser/source-contract/adapter/integration coverage). Every path is listed in the closed residual manifest, this status, the separate acceptance-enablement manifest, or the blocker table above, and each named symbol was verified present. The 50 reference rows remain exactly once in the reconciliation table.

| # | Category-4 behavior | Implemented and pinned paths |
|---:|---|---|
| 1 | Unit retry-free configuration | `vitest.config.ts::shared.retry` contains the inline exact-flag expression; `tests2/core/{unit-lanes-scheduling,unit-file-budget-reporter}.test.ts`; `docs/testing-strategy.md` and `docs/testing-v2/{fast-gate-design,unit-gate,cross-os-test-authoring}.md`. |
| 2 | Packed-consumer owned run-root child | `scripts/release-packed-consumer-audit.mjs::{packedConsumerTempPrefix,runPackedConsumerAudit}`; `tests2/core/release-skill-preflight-order.test.ts`. |
| 3 | Verification editor validation preserves active input | `src/app/workflow-page.ts::renderVerifyStepEditor`; `tests2/browser/workflow-review-timeout-editor.spec.ts`. |
| 4 | Pi discovery binds before fixture resolution | `src/server/agent/pi-extension-contributions.ts::loadPiExtensionContributionsWithDiscovery`; `tests2/core/pi-extension-discovery-backend.test.ts`. |
| 5 | Gateway Docker calls retain the injected command runner | `src/server/server.ts::{createGateway,handleApiRoute}` and `src/server/agent/sandbox-status.ts::ensureImageAgentVersion`; `tests2/core/sandbox-status.test.ts`. |
| 6 | E2E worker and qualification policy | `tests/e2e/README.md` states two API workers and the retry-free wrapper contract. |
| 7 | Restart/resume fixture owns and cleans its root | `tests/e2e/pool-claim-restart-resume.spec.ts`; the same E2E journey retains its lifecycle assertions. |
| 8 | Browser coordinator run ownership and retry-free forwarding | `scripts/testing-v2/run-browser-v2.mjs::{createBrowserRunPaths,createBrowserRunEnvironment,playwrightCommandArgs}` and convention-discovered `tests2/core/browser-run-wrapper.test.ts`. |
| 9 | Lifecycle observations use causal deferred barriers | `tests2/core/purge-preview-pool-shutdown-coder61c7.test.ts`; its local deferred barriers pin ordering and cleanup without polling. |
| 10 | Worktree registration compares canonical aliases | `tests2/core/team-manager.test.ts::{listedWorktreePaths,assertRegisteredWorktree}`; its owned alias regression. |
| 11 | Draft storage fault fixture covers both storage aliases | `tests2/dom/transient-draft-store.test.ts::{breakStorage,restoreStorage}`. |
| 12 | Skill-surface fixtures allocate independent atomic roots | `tests2/integration/skill-surface-consistency.test.ts`; its `beforeAll`/`afterAll` root lifecycle. |
