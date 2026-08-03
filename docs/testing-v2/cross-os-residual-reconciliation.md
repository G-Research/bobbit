# Cross-OS residual reconciliation ledger

**Reference extraction:** `e3051de63cf611143a989f7928bd9f9a7ed9beae^2..e3051de63cf611143a989f7928bd9f9a7ed9beae`
**Validation head:** `be8018b859d3688cf21ea44caa976be5cfe6b342` (current goal head; production baseline is `origin/main` `0299fe6b8268f01f136d2a6787983e662e0fdc94`).

This is a semantic reconciliation, not a cherry-pick plan. Categories are: **1** merged by a focused PR; **2** superseded by stronger current behavior; **3** intentionally obsolete/inapplicable; **4** genuinely missing. Each of the 50 unique reference files appears exactly once below. A file can contain multiple independently classified behaviors.

| # | Reference file | Category | Reconciled behavior and current-head validation |
|---:|---|:---:|---|
| 1 | `.gitignore` | 3 | The reference checkout-local `test-results-v2*` wildcard is obsolete: browser artifacts now live in each coordinator's system-temp root. Retaining the legacy fixed-path ignore is harmless; a broad checkout artifact policy would contradict run ownership. |
| 2 | `docs/testing-v2/fast-gate-design.md` | 4 | The historical `--retry=0` prose must be adapted to `BOBBIT_V2_RETRY_FREE=1`. `vitest.config.ts` still hard-codes `retry: 3`, so the required unit retry-free control and its documentation are missing. |
| 3 | `scripts/release-packed-consumer-audit.mjs` | 4 | `runPackedConsumerAudit()` still calls `mkdtemp(join(tmpdir(), ...))`. It must allocate only an atomic child of canonical `BOBBIT_V2_RUN_ROOT` when present, with OS-temp fallback, and never remove its parent. |
| 4 | `src/app/workflow-page.ts` | 1, 4 | #1076's revision-aware held-create/PUT preservation is present and pinned. Separately, `renderVerifyStepEditor().updateStep()` still calls `renderApp()` when `saveAttempted`; this can replace an active timeout input and close Advanced. Preserve #1076 and remove only that validation-triggered render. |
| 5 | `src/server/agent/pi-extension-contributions.ts` | 4 | `loadPiExtensionContributionsWithDiscovery()` still dynamically imports `pi-extension-discovery` after fixture setup. Statically bind `discoverPiExtensionTools` with the sync entry point and add one prebundle/fixture-order regression. This is the sole Pi item. |
| 6 | `src/server/agent/project-registry.ts` | 1, 2 | #1077 provides dialect-aware identity, bounded evidence, canonical registry dedupe, and component containment. Its conservative foreign-Windows descendant handling, directory-identity cache binding, and hard-link treatment supersede the reference's unsafe folding/fingerprint-only variants. |
| 7 | `src/server/agent/resolve-project.ts` | 1 | #1077's `realOrResolved()` longest-existing-prefix walk and `isSameOrDescendant()` relative-boundary check retain the reference contract. |
| 8 | `src/server/agent/session-manager.ts` | 1, 2 | #1076 retains echoed-steer settlement, exactly-once post-abort drain, and ordering. #1077's validated readable/canonical persisted transcript identity supersedes returning raw lexical spelling; replaying an echoed steer is intentionally not restored. |
| 9 | `src/server/agent/spawn-tree.ts` | 1, 2 | #1089 retains tracked POSIX/Windows ownership, readiness, root-exit finalization, and fail-closed survival. Its `/proc`/Darwin nonce identity and nonce-bound Windows completion proof supersede the reference sentinel record. |
| 10 | `src/server/agent/transcript-sanitizer.ts` | 1 | Trusted persisted file lexical and canonical spellings are retained with alias and CRLF coverage from #1077. |
| 11 | `src/server/agent/verification-command-runner.ts` | 1 | #1089 forwards nonce-bound POSIX sentinel identity through durable command spawning. |
| 12 | `src/server/agent/verification-harness.ts` | 1 | #1089 retains durable sentinel records, recovered-goal cleanup, exact group proof, payload-before-transport cleanup, lifecycle completion proof, and durable host/container reaping; current witnesses are stronger. |
| 13 | `src/server/agent/verification-logic.ts` | 1 | #1089 makes all Windows host-detached recovery pending-retry and retains separate container recovery. |
| 14 | `src/server/agent/worktree-inventory.ts` | 1 | Async discovery and lexical normalization before filesystem/Git identity remain; current path identity is the #1077 authority. |
| 15 | `src/server/agent/yaml-store.ts` | 1 | `YamlStore.itemPath()` keeps relative-path containment and rejects sibling-prefix/absolute traversal. |
| 16 | `src/server/extension-host/path-guard.ts` | 2 | Current strict containment preserves lexical/canonical roots and adds mixed-dialect and case-sensitive Windows descendant protection beyond the reference. |
| 17 | `src/server/preview/path-guard.ts` | 2 | Current missing-asset lexical-root handling and `isPathContained()` boundary check retain and harden the reference behavior. |
| 18 | `src/server/server.ts` | 4 | Sandbox bootstrap, status/build routes, and sandbox-session validation still call Docker helpers without the injected gateway `commandRunner`; pass the seam to every `checkDockerAvailability`, `buildSandboxImage`, and `ensureImageAgentVersion` call and pin fenced execution. |
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
| 35 | `tests2/core/session-manager-direct-prompt-lifecycle.test.ts` | 1 | #1076 retains non-replay, unechoed recovery, chronological ordering, and ordinary-queue priority coverage. |
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

The following are the complete missing set, validated against the head above rather than copied from the historical patch:

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
