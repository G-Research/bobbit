# Chaos Comparison Proof — Test Suite v2

Generated: 2026-07-07T04:40:13.346Z  |  Run duration: 62.7s

## Summary

| Metric | Legacy suite | V2 suite |
|--------|-------------|---------|
| Total content mutants | 22 | 22 |
| With targeted catchers | 20 | 22 |
| Caught (exit ≠ 0) | 20 | 22 |
| Missed (exit = 0) | 0 | 0 |
| Skipped (no catcher) | 2 | 0 |
| Error/invalid | 0 | 0 |
| **Kill rate (of killable)** | **100.0%** | **100.0%** |

**Null mutant harness check:** ✅ PASSED

## Acceptance Criteria

- **v2 catches every legacy-caught mutant:** ✅ PASS
- **v2 kill rate ≥ legacy overall:** ✅ PASS (v2 100.0% vs legacy 100.0%)
- **Both-missed gaps:** ✅ None

## Per-area Kill Rates

| Area | Mutants | Legacy caught | V2 caught |
|------|---------|---------------|-----------|
| gate-workflow | 3 | 3 | 3 |
| stores-persistence | 3 | 3 | 3 |
| team-scheduler | 2 | 2 | 2 |
| session-lifecycle | 2 | 2 | 2 |
| git-worktree | 2 | 2 | 2 |
| verification | 2 | 2 | 2 |
| di-fence | 2 | 0 | 2 |
| config-cascade | 2 | 2 | 2 |
| message-reducer | 2 | 2 | 2 |
| app-state | 1 | 1 | 1 |
| renderer | 1 | 1 | 1 |

## Full Mutant Matrix

| ID | Area | File | Legacy | V2 | Duration |
|----|------|------|--------|-----|----------|
| M00-null *(null)* | null | `src/server/agent/gate-dependency-check.ts` | — skipped | — skipped | 1.8s |
| M01-gate-bypass-ignored | gate-workflow | `src/server/agent/gate-dependency-check.ts` | 🔴 caught | 🔴 caught | 1.9s |
| M02-gate-cascade-inverted | gate-workflow | `src/server/agent/gate-store.ts` | 🔴 caught | 🔴 caught | 1.8s |
| M03-gate-no-signal-push | stores-persistence | `src/server/agent/gate-store.ts` | 🔴 caught | 🔴 caught | 1.7s |
| M04-session-store-no-persist | stores-persistence | `src/server/agent/session-store.ts` | 🔴 caught | 🔴 caught | 1.7s |
| M05-scheduler-wrong-return | team-scheduler | `src/server/agent/child-team-scheduler.ts` | 🔴 caught | 🔴 caught | 1.7s |
| M06-team-idle-nudge-zero | team-scheduler | `src/server/agent/team-manager.ts` | 🔴 caught | 🔴 caught | 2.0s |
| M07-session-status-no-bump | session-lifecycle | `src/server/agent/session-status.ts` | 🔴 caught | 🔴 caught | 1.9s |
| M08-session-status-skip-broadcast | session-lifecycle | `src/server/agent/session-status.ts` | 🔴 caught | 🔴 caught | 1.9s |
| M09-branch-wrong-slice | git-worktree | `src/server/agent/goal-manager.ts` | 🔴 caught | 🔴 caught | 1.6s |
| M10-worktree-slug-wrong-replace | git-worktree | `src/server/skills/worktree-paths.ts` | 🔴 caught | 🔴 caught | 1.8s |
| M11-push-safety-bypass | verification | `src/server/agent/verification-harness.ts` | 🔴 caught | 🔴 caught | 1.8s |
| M12-step-timeout-no-unit | verification | `src/server/agent/verification-harness.ts` | 🔴 caught | 🔴 caught | 1.9s |
| M13-fence-gh-bypass | di-fence | `tests2/harness/fenced-command-runner.ts` | — skipped | 🔴 caught | 2.0s |
| M14-fence-network-git-allowed | di-fence | `tests2/harness/fenced-command-runner.ts` | — skipped | 🔴 caught | 1.7s |
| M15-cascade-workflow-hidden-invert | config-cascade | `src/server/agent/config-cascade.ts` | 🔴 caught | 🔴 caught | 1.9s |
| M16-cascade-hq-normalization-broken | config-cascade | `src/server/agent/config-cascade.ts` | 🔴 caught | 🔴 caught | 1.7s |
| M17-reducer-wrong-sort | message-reducer | `src/app/message-reducer.ts` | 🔴 caught | 🔴 caught | 2.0s |
| M18-reducer-settle-inverted | message-reducer | `src/app/message-reducer.ts` | 🔴 caught | 🔴 caught | 2.0s |
| M19-sidebar-inverted-filter | app-state | `src/app/sidebar-tree-builder.ts` | 🔴 caught | 🔴 caught | 1.9s |
| M20-gate-status-no-live-renderer | renderer | `src/ui/tools/renderers/GateToolRenderers.ts` | 🔴 caught | 🔴 caught | 1.8s |
| M21-goal-store-archive-flag-missing | stores-persistence | `src/server/agent/goal-store.ts` | 🔴 caught | 🔴 caught | 1.8s |
| M22-aggregate-gate-status-wrong-failed | gate-workflow | `src/server/agent/goal-descendants.ts` | 🔴 caught | 🔴 caught | 2.1s |

**Icon key:** 🔴 caught (test fails on mutant) | ⚪ missed | — skipped (no targeted catcher) | ⚠️ error | ⛔ invalid (patch failed)

## New V2 Coverage (not in legacy)

These mutants are caught by v2 but have no legacy targeted catcher, demonstrating new coverage:

- **M13-fence-gh-bypass** (di-fence): DI-fence: gh invocation no longer blocked in execFile — the test-only gh fence is disabled.
- **M14-fence-network-git-allowed** (di-fence): DI-fence: NETWORK_GIT_COMMANDS cleared — git push/fetch/clone/ls-remote all allowed through the fence.

## Methodology

- Each mutant is a single search/replace change to a `src/` or `tests2/harness/` file
- Applied in an ephemeral git worktree (`git worktree add --detach`), never leaking to the branch
- Targeted test runs (one file each for legacy and v2) — not full-suite × mutant
- `caught` = test file exits non-0; `missed` = test file exits 0 (bug not detected)
- Null mutant: no-op patch; both suites must EXIT 0 (guards against a broken harness)

*Run by: chaos.mjs  |  Corpus: tests2/chaos/mutants.json*