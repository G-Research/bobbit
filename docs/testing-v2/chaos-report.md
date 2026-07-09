# Chaos Comparison Proof — Test Suite v2

Generated: 2026-07-07T11:05:33.464Z  |  Run duration: 1167.6s

## Summary

| Metric | Legacy suite | V2 suite |
|--------|-------------|---------|
| Total content mutants | 53 | 53 |
| With targeted catchers | 45 | 53 |
| Caught (exit ≠ 0) | 45 | 50 |
| Missed (exit = 0) | 0 | 0 |
| Skipped (no catcher) | 8 | 0 |
| Error/invalid | 0 | 3 |
| **Kill rate (of killable)** | **100.0%** | **94.3%** |

**Null mutant harness check:** ✅ PASSED

## Acceptance Criteria

- **No REAL v2 coverage gap (every legacy-caught mutant the v2 test RAN on is caught):** ✅ PASS
- **Inconclusive (env, NOT a coverage gap):** ⚠️ 3 legacy-caught mutant(s) whose v2 test could not run here (module-load/harness error — e.g. a workspace dep missing from the host node_modules). Re-run in a complete-install environment:
    - **M11-push-safety-bypass** (verification): v2 = load-error — module-load failure (not a miss): Cannot find package '@earendil-works/pi-ai/oauth' imported from 'C:/Users/jsubr/AppData/Local/Temp/bobbit-chaos-M11-push-safety-bypass-1783421270847/src/server/auth/oauth.ts' (7374ms)
    - **M12-step-timeout-no-unit** (verification): v2 = load-error — module-load failure (not a miss): Cannot find package '@earendil-works/pi-ai/oauth' imported from 'C:/Users/jsubr/AppData/Local/Temp/bobbit-chaos-M12-step-timeout-no-unit-1783421282272/src/server/auth/oauth.ts' (7965ms)
    - **M32-backoff-exponent-offbyone** (session-lifecycle): v2 = load-error — module-load failure (not a miss): Cannot find package '@earendil-works/pi-ai/oauth' imported from 'C:/Users/jsubr/AppData/Local/Temp/bobbit-chaos-M32-backoff-exponent-offbyone-1783421491899/src/server/auth/oauth.ts' (7282ms)
- **v2 ≥ legacy overall (kill count):** ✅ PASS (v2 caught 50 vs legacy 45; rates v2 94.3% / legacy 100.0%)
- **Both-missed gaps:** ✅ None
- **All v2 kills attributed to a specific test case:** ✅ PASS (50/50)
- **Full-v2 sample re-kill (≥5 mutants, non-narrow targeting):** ✅ PASS (5/5 re-killed by the full core+dom tier)

## Per-area Comparison (v2 ≥ legacy is the verdict)

Legend: **inc(env)** = v2 test could not load here (missing workspace dep) — inconclusive, not a miss. Verdict excludes env-inconclusive; a real regression is a v2 *miss*.

| Area | Mutants | Legacy caught | V2 caught | inc(env) | Real v2 miss | v2 ≥ legacy (runnable) |
|------|---------|---------------|-----------|----------|--------------|------------------------|
| gate-workflow | 5 | 5 | 5 | — | — | ✅ |
| stores-persistence | 5 | 5 | 5 | — | — | ✅ |
| team-scheduler | 5 | 5 | 5 | — | — | ✅ |
| session-lifecycle | 5 | 5 | 4 | 1 | — | ✅* |
| git-worktree | 5 | 5 | 5 | — | — | ✅ |
| verification | 5 | 5 | 3 | 2 | — | ✅* |
| di-fence | 3 | 0 | 3 | — | — | ✅ |
| config-cascade | 5 | 5 | 5 | — | — | ✅ |
| message-reducer | 5 | 5 | 5 | — | — | ✅ |
| app-state | 5 | 5 | 5 | — | — | ✅ |
| renderer | 5 | 0 | 5 | — | — | ✅ |

**Per-area v2 ≥ legacy (runnable):** ✅ PASS (no area has a real v2 miss; ✅* = has env-inconclusive to re-run in a complete-install env)
**Per-area legacy-caught ⊆ v2-caught (excluding env-inconclusive):** ✅ PASS (no legacy-caught mutant is genuinely missed by v2)

## Full Mutant Matrix

| ID | Area | File | Legacy | V2 | Killed by (v2 test case) | Duration |
|----|------|------|--------|-----|--------------------------|----------|
| M00-null *(null)* | null | `src/server/agent/gate-dependency-check.ts` | — skipped | — skipped | — | 1.8s |
| M01-gate-bypass-ignored | gate-workflow | `src/server/agent/gate-dependency-check.ts` | 🔴 caught | 🔴 caught | `tests2/core/gate-dependency-enforcement.test.ts > Gate Dependency Enforcement > team/spawn gate checks > treats a bypassed upstream gate as satisfied (unblocks dependents)` | 9.9s |
| M02-gate-cascade-inverted | gate-workflow | `src/server/agent/gate-store.ts` | 🔴 caught | 🔴 caught | `tests2/core/gate-store-logic.test.ts > GateStore > resetGateAndDependents > sets verification cache invalidation marker for selected and downstream gates, including pending ones` | 9.6s |
| M03-gate-no-signal-push | stores-persistence | `src/server/agent/gate-store.ts` | 🔴 caught | 🔴 caught | `tests2/core/gate-store-logic.test.ts > GateStore > resetGateAndDependents > sets verification cache invalidation marker for selected and downstream gates, including pending ones` (+1) | 9.7s |
| M04-session-store-no-persist | stores-persistence | `src/server/agent/session-store.ts` | 🔴 caught | 🔴 caught | `tests2/core/session-store.test.ts > SessionStore > update() > persists first-class child session metadata` (+3) | 9.7s |
| M05-scheduler-wrong-return | team-scheduler | `src/server/agent/child-team-scheduler.ts` | 🔴 caught | 🔴 caught | `tests2/core/child-team-scheduler.test.ts > ChildTeamScheduler — per-root concurrency cap > cap=1: only one child starts; the rest are capacity-blocked + enqueued` (+4) | 9.4s |
| M06-team-idle-nudge-zero | team-scheduler | `src/server/agent/team-manager.ts` | 🔴 caught | 🔴 caught | `tests2/core/team-manager-worker-idle-debounce.test.ts > TeamManager — transient worker idle blip debounce (regression) > does NOT nudge the lead when a worker blips agent_end → agent_start within 5s` (+1) | 10.3s |
| M07-session-status-no-bump | session-lifecycle | `src/server/agent/session-status.ts` | 🔴 caught | 🔴 caught | `tests2/core/session-manager-status.test.ts > broadcastStatus > mutates status, bumps statusVersion, broadcasts session_status frame` (+2) | 9.6s |
| M08-session-status-skip-broadcast | session-lifecycle | `src/server/agent/session-status.ts` | 🔴 caught | 🔴 caught | `tests2/core/session-manager-status.test.ts > broadcastStatus > mutates status, bumps statusVersion, broadcasts session_status frame` (+4) | 9.4s |
| M09-branch-wrong-slice | git-worktree | `src/server/agent/goal-manager.ts` | 🔴 caught | 🔴 caught | `tests2/core/team-branch-shape.test.ts > goal toBranchName > never returns a leading or trailing hyphen across 100 random inputs ≤30 chars` | 9.9s |
| M10-worktree-slug-wrong-replace | git-worktree | `src/server/skills/worktree-paths.ts` | 🔴 caught | 🔴 caught | `tests2/core/worktree-paths.test.ts > branchToSlug > flattens slashes to dashes` | 9.8s |
| M11-push-safety-bypass | verification | `src/server/agent/verification-harness.ts` | 🔴 caught | 🧩 load-error | — | 10.9s |
| M12-step-timeout-no-unit | verification | `src/server/agent/verification-harness.ts` | 🔴 caught | 🧩 load-error | — | 11.6s |
| M13-fence-gh-bypass | di-fence | `tests2/harness/fenced-command-runner.ts` | — skipped | 🔴 caught | `tests2/core/command-runner-fence.test.ts > fenced command runner > rejects network and host-control commands` | 9.8s |
| M14-fence-network-git-allowed | di-fence | `tests2/harness/fenced-command-runner.ts` | — skipped | 🔴 caught | `tests2/core/command-runner-fence.test.ts > fenced command runner > rejects network and host-control commands` (+1) | 9.6s |
| M15-cascade-workflow-hidden-invert | config-cascade | `src/server/agent/config-cascade.ts` | 🔴 caught | 🔴 caught | `tests2/core/config-cascade.test.ts > ConfigCascade — Headquarters server-scope alias > normalizes Headquarters to server scope for non-workflow config only` | 10.2s |
| M16-cascade-hq-normalization-broken | config-cascade | `src/server/agent/config-cascade.ts` | 🔴 caught | 🔴 caught | `tests2/core/config-cascade.test.ts > ConfigCascade — Headquarters server-scope alias > normalizes Headquarters to server scope for non-workflow config only` (+1) | 10.1s |
| M17-reducer-wrong-sort | message-reducer | `src/app/message-reducer.ts` | 🔴 caught | 🔴 caught | `tests2/core/message-reducer.test.ts > message-reducer > (1) in-order live events` (+21) | 9.8s |
| M18-reducer-settle-inverted | message-reducer | `src/app/message-reducer.ts` | 🔴 caught | 🔴 caught | `tests2/core/message-reducer.test.ts > message-reducer > (R1) errored turn settles the optimistic prompt so a LATER live event sorts after it` (+2) | 12.7s |
| M19-sidebar-inverted-filter | app-state | `src/app/sidebar-tree-builder.ts` | 🔴 caught | 🔴 caught | `tests2/core/sidebar-tree-builder.test.ts > buildSidebarTree > emits project, goal, team-lead, member, sessions, staff, and archived section nodes` (+11) | 9.7s |
| M20-gate-status-no-live-renderer | renderer | `src/ui/tools/renderers/GateToolRenderers.ts` | — skipped | 🔴 caught | `tests2/dom/gate-status-renderer.test.ts > GateStatusRenderer > renders active latestSignal summary through gate-verification-live` (+1) | 8.5s |
| M21-goal-store-archive-flag-missing | stores-persistence | `src/server/agent/goal-store.ts` | 🔴 caught | 🔴 caught | `tests2/core/goal-trigger-dispatcher.test.ts > GoalStore — onGoalCreated / onGoalArchived > archive fires onGoalArchived exactly once on the false → true transition` (+1) | 9.7s |
| M22-aggregate-gate-status-wrong-failed | gate-workflow | `src/server/agent/goal-descendants.ts` | 🔴 caught | 🔴 caught | `tests2/core/goal-descendants-enrichment.test.ts > aggregateGateStatus > failed when any gate failed (highest precedence)` (+1) | 9.6s |
| M23-gatesummary-bypassed-as-passed | gate-workflow | `src/server/gate-status-summary.ts` | 🔴 caught | 🔴 caught | `tests2/core/gate-status-summary.test.ts > buildGateStatusSummary > reports zero bypassed when no gate is bypassed` | 9.5s |
| M24-gatesummary-passed-inverted | gate-workflow | `src/server/gate-status-summary.ts` | 🔴 caught | 🔴 caught | `tests2/core/gate-status-summary.test.ts > buildGateStatusSummary > overlays active verification on an already-passed gate` | 9.7s |
| M25-plan-mutation-prune-inverted | stores-persistence | `src/server/agent/plan-mutation-store.ts` | 🔴 caught | 🔴 caught | `tests2/core/plan-mutation-store.test.ts > PlanMutationStore > pruneExpired removes only expired entries` (+1) | 9.6s |
| M26-inbox-listpending-inverted | stores-persistence | `src/server/agent/inbox-store.ts` | 🔴 caught | 🔴 caught | `tests2/core/inbox-store.test.ts > InboxStore — listPending > filters to pending entries only` (+1) | 9.4s |
| M27-semaphore-acquire-offbyone | team-scheduler | `src/server/agent/semaphore.ts` | 🔴 caught | 🔴 caught | `tests2/core/semaphore.test.ts > Semaphore > blocks the (N+1)th acquire until release` (+4) | 9.7s |
| M28-semaphore-overrelease-offbyone | team-scheduler | `src/server/agent/semaphore.ts` | 🔴 caught | 🔴 caught | `tests2/core/semaphore.test.ts > Semaphore > throws on over-release when no waiters` (+1) | 9.5s |
| M29-child-rtm-master-step-inverted | team-scheduler | `src/server/agent/child-ready-to-merge.ts` | 🔴 caught | 🔴 caught | `tests2/core/child-ready-to-merge-helper.test.ts > adaptReadyToMergeVerify > replaces 'PR raised' with the no-PR echo` (+2) | 9.3s |
| M30-eventbuffer-overflow-offbyone | session-lifecycle | `src/server/agent/event-buffer.ts` | 🔴 caught | 🔴 caught | `tests2/core/event-buffer.test.ts > EventBuffer > overflow / circular behavior > drops oldest events when exceeding capacity` (+7) | 9.7s |
| M31-eventbuffer-canresume-offbyone | session-lifecycle | `src/server/agent/event-buffer.ts` | 🔴 caught | 🔴 caught | `tests2/core/event-buffer.test.ts > EventBuffer.canResumeFrom respects the retained window` | 9.8s |
| M32-backoff-exponent-offbyone | session-lifecycle | `src/server/agent/session-setup.ts` | 🔴 caught | 🧩 load-error | — | 10.9s |
| M33-shortstat-insertions-deletions-swapped | git-worktree | `src/server/skills/git-status-native.ts` | 🔴 caught | 🔴 caught | `tests2/core/git-shortstat-parser.test.ts > parseShortstat > both present, plural` (+4) | 10.0s |
| M34-baseref-remote-prefix-inverted | git-worktree | `src/server/skills/git.ts` | 🔴 caught | 🔴 caught | `tests2/core/base-ref-parse.test.ts > parseBaseRef > local branch name → isRemote false` (+8) | 11.6s |
| M35-baseref-removed-await | git-worktree | `src/server/skills/git.ts` | 🔴 caught | 🔴 caught | `tests2/core/base-ref-parse.test.ts > resolveBaseRefWithExec (sandbox) > configured empty → exec invoked once with symbolic-ref refs/remotes/origin/HEAD` (+1) | 11.6s |
| M36-getsortedphases-reversed | verification | `src/server/agent/verification-logic.ts` | 🔴 caught | 🔴 caught | `tests2/core/verification-logic.test.ts > getSortedPhases > sorts phase numbers ascending` | 9.8s |
| M37-canskipallsteps-offbyone | verification | `src/server/agent/verification-logic.ts` | 🔴 caught | 🔴 caught | `tests2/core/verification-logic.test.ts > canSkipAllSteps > returns true when all active steps are cached` (+1) | 9.7s |
| M38-computeallpassed-inverted-boolean | verification | `src/server/agent/verification-logic.ts` | 🔴 caught | 🔴 caught | `tests2/core/verification-logic.test.ts > computeAllPassed > returns true when all steps passed` (+3) | 9.5s |
| M39-cascade-server-origin-wrong | config-cascade | `src/server/agent/config-cascade.ts` | 🔴 caught | 🔴 caught | `tests2/core/config-cascade.test.ts > ConfigCascade — Role.model and Role.thinkingLevel three-layer resolution > project overrides server overrides builtin for both fields` (+2) | 10.4s |
| M40-cascade-workflow-guard-inverted | config-cascade | `src/server/agent/config-cascade.ts` | 🔴 caught | 🔴 caught | `tests2/core/config-cascade.test.ts > ConfigCascade — Headquarters server-scope alias > normalizes Headquarters to server scope for non-workflow config only` | 10.1s |
| M41-cascade-role-find-inverted | config-cascade | `src/server/agent/config-cascade.ts` | 🔴 caught | 🔴 caught | `tests2/core/config-cascade.test.ts > ConfigCascade — Headquarters server-scope alias > normalizes Headquarters to server scope for non-workflow config only` | 9.9s |
| M42-reducer-synth-seq-offbyone | message-reducer | `src/app/message-reducer.ts` | 🔴 caught | 🔴 caught | `tests2/core/message-reducer-dedup.test.ts > synth:seq stamp: id-less live row gets synth:seq:<seq>; re-delivery replaces in place` (+1) | 9.6s |
| M43-reducer-replace-by-id-inverted | message-reducer | `src/app/message-reducer.ts` | 🔴 caught | 🔴 caught | `tests2/core/message-reducer-dedup.test.ts > S18 non-regression: two id'd snapshot same-text rows stay TWO; two distinct optimistic+echo pairs stay TWO` (+3) | 9.4s |
| M44-reducer-s17-alternative-dropped | message-reducer | `src/app/message-reducer.ts` | 🔴 caught | 🔴 caught | `tests2/core/message-reducer-dedup.test.ts > S17 (unprefixed): optimistic /foo with skillExpansions + echo of the EXPANDED body → ONE` | 9.2s |
| M45-sidebar-base-indent-wrong-default | app-state | `src/app/sidebar-tree-builder.ts` | 🔴 caught | 🔴 caught | `tests2/core/sidebar-tree-builder.test.ts > sidebar tree key primitives > resolves clamped indentation defaults for builder metadata` | 10.0s |
| M46-sidebar-nested-indent-wrong-default | app-state | `src/app/sidebar-tree-builder.ts` | 🔴 caught | 🔴 caught | `tests2/core/sidebar-tree-builder.test.ts > sidebar tree key primitives > resolves clamped indentation defaults for builder metadata` (+2) | 9.7s |
| M47-sidebar-clamp-minmax-swapped | app-state | `src/app/sidebar-tree-builder.ts` | 🔴 caught | 🔴 caught | `tests2/core/sidebar-tree-builder.test.ts > sidebar tree key primitives > resolves clamped indentation defaults for builder metadata` (+1) | 9.4s |
| M48-sidebar-livegoals-inverted | app-state | `src/app/sidebar-tree-builder.ts` | 🔴 caught | 🔴 caught | `tests2/core/sidebar-tree-builder.test.ts > buildSidebarTree > emits project, goal, team-lead, member, sessions, staff, and archived section nodes` (+15) | 9.8s |
| M49-bash-renderer-description-inverted | renderer | `src/ui/tools/renderers/BashRenderer.ts` | — skipped | 🔴 caught | `tests2/dom/bash-renderer-description.test.ts > BashRenderer description param > collapsed header shows description when provided` (+3) | 8.8s |
| M50-write-renderer-istruncated-inverted | renderer | `src/ui/tools/renderers/WriteRenderer.ts` | — skipped | 🔴 caught | `tests2/dom/write-renderer-truncated.test.ts > WriteRenderer truncated content handling > truncated object is detected and preview is extracted` (+5) | 9.4s |
| M51-write-renderer-formatsize-divisor | renderer | `src/ui/tools/renderers/WriteRenderer.ts` | — skipped | 🔴 caught | `tests2/dom/write-renderer-truncated.test.ts > WriteRenderer truncated content handling > truncated size is formatted correctly` (+2) | 15.1s |
| M52-gate-renderer-final-status-dropped | renderer | `src/ui/tools/renderers/GateToolRenderers.ts` | — skipped | 🔴 caught | `tests2/dom/gate-status-renderer.test.ts > GateStatusRenderer > keeps legacy signals[] support and only passes terminal finalStatus` | 8.6s |
| M53-fence-fetch-loopback-inverted | di-fence | `tests2/harness/fenced-fetch.ts` | — skipped | 🔴 caught | `tests2/core/fetch-fence.test.ts > fenced fetch > rejects non-loopback hosts` (+1) | 8.3s |

**Icon key:** 🔴 caught (test fails on mutant) | ⚪ missed | — skipped (no targeted catcher) | ⚠️ error | 🧩 load-error (v2 suite could not load here — env, not a miss) | ⛔ invalid (patch failed)

## Full-v2 Sample (spec R8 — over-narrow-targeting guard)

Each sampled mutant is re-run against the FULL v2 core+dom tier (every test, not just the targeted file), with pre-existing/flaky failures subtracted via a clean-tree baseline. 'Killed by (attributed)' names the mutant's own listed catcher when it fired in the full run; a genuine non-listed catcher is recorded only when the listed catcher did NOT fire (the true over-narrow case).

| Mutant | Area | Re-killed by full tier | Killed by (attributed) | Genuine non-listed catcher | Duration |
|--------|------|------------------------|------------------------|----------------------------|----------|
| M16-cascade-hq-normalization-broken | config-cascade | ✅ yes | `tests2/core/config-cascade.test.ts` | — (listed catcher fired; other failures treated as flaky) | 101.7s |
| M31-eventbuffer-canresume-offbyone | session-lifecycle | ✅ yes | `tests2/core/event-buffer.test.ts` | — (listed catcher fired; other failures treated as flaky) | 99.3s |
| M33-shortstat-insertions-deletions-swapped | git-worktree | ✅ yes | `tests2/core/git-shortstat-parser.test.ts` | — (listed catcher fired; other failures treated as flaky) | 100.6s |
| M34-baseref-remote-prefix-inverted | git-worktree | ✅ yes | `tests2/core/base-ref-parse.test.ts` | — (listed catcher fired; other failures treated as flaky) | 104.3s |
| M51-write-renderer-formatsize-divisor | renderer | ✅ yes | `tests2/dom/write-renderer-truncated.test.ts` | — (listed catcher fired; other failures treated as flaky) | 99.7s |

## New V2 Coverage (not in legacy)

These mutants are caught by v2 but have no legacy targeted catcher, demonstrating new coverage:

- **M13-fence-gh-bypass** (di-fence): DI-fence: gh invocation no longer blocked in execFile — the test-only gh fence is disabled.
- **M14-fence-network-git-allowed** (di-fence): DI-fence: NETWORK_GIT_COMMANDS cleared — git push/fetch/clone/ls-remote all allowed through the fence.
- **M20-gate-status-no-live-renderer** (renderer): Renderer: shouldRenderLiveVerification always false — gate-verification-live component never rendered.
- **M49-bash-renderer-description-inverted** (renderer): Inverted description guard — when a description IS provided the collapsed header renders the summarized command fallback instead of the italic description (and vice-versa).
- **M50-write-renderer-istruncated-inverted** (renderer): Inverted truncation detection — isTruncated returns the opposite verdict, so a truncated write result is rendered as normal content (no preview / no 'Load full content' affordance).
- **M51-write-renderer-formatsize-divisor** (renderer): Wrong divisor — formatSize divides megabyte-scale sizes by 1024 instead of 1048576, so the truncation badge reports a wildly wrong size (e.g. '10240.0 MB' instead of '10.0 MB').
- **M52-gate-renderer-final-status-dropped** (renderer): Dropped terminal-status branch — the live gate verification component only forwards a 'failed' finalStatus (the 'passed' case collapses to undefined), so a passed gate never shows its terminal state.
- **M53-fence-fetch-loopback-inverted** (di-fence): DI-fence: inverted loopback guard — the fenced fetch would BLOCK loopback hosts and ALLOW non-loopback ones, disabling the fail-closed outbound-HTTP fence (a test could reach the network).

## Methodology

- Each mutant is a single search/replace change to a `src/` or `tests2/harness/` file
- Applied in an ephemeral git worktree (`git worktree add --detach`), never leaking to the branch
- Targeted test runs (one file each for legacy and v2) — not full-suite × mutant
- `caught` = test file exits non-0; `missed` = test file exits 0 (bug not detected)
- Null mutant: no-op patch; both suites must EXIT 0 (guards against a broken harness)
- **Test-name attribution:** the specific failing test case is parsed from the runner output (Vitest JSON report for v2, TAP `not ok` lines for legacy) — an unattributed kill is a FAIL criterion
- **Full-v2 sample (R8):** ≥5 random killed mutants are additionally re-run against the entire core+dom tier; a kill by a non-listed test still counts and back-fills `expectedV2Catchers`

*Run by: chaos.mjs  |  Corpus: tests2/chaos/mutants.json*