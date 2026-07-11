# Memfs unit store migration report

## Summary

The memfs migration reduces real filesystem IO in the `tests2/core` unit lane by moving fs-only store and persistence tests from temp directories to the existing `FsLike` seam. Unit tests should exercise store logic against `tests2/harness/mem-fs.ts::createMemFs()`; real-disk behavior stays covered by small integration proofs.

Why this split matters:

- Unit lane: fast, broad, deterministic, minimal real IO.
- Integration lane: canonical real filesystem fidelity for atomic writes, backup restore, rename semantics, recursive cleanup, and mtime-sensitive behavior.
- E2E lane: full gateway journeys with git, Docker, child processes, and real worktrees.

## Migration recipe

For each fs-only store test:

1. Replace temp directory setup with a memfs fixture:

   ```ts
   const memfs = createMemFs();
   const stateDir = path.join("/state", "case-name");
   ```

2. Pass the fixture into the store constructor or helper under test:

   ```ts
   new SessionStore(stateDir, memfs, fakeClock);
   new CostTracker(stateDir, memfs);
   new GoalStore(stateDir, memfs);
   ```

3. Replace direct `node:fs` writes and assertions with `memfs` operations.
4. Keep assertions unchanged; only the backing filesystem changes.
5. Remove `guardProcessEnv()` only when the test no longer mutates `process.env`.
6. Keep real-disk fidelity cases in `tests2/integration` and register new files in `tests2/tests-map.json`.

Do not migrate tests that use temp dirs because they are proving git, Docker, child-process, extension-host, build, symlink, path-guard, or real fs behavior.

## Classifier availability

Confirmed on this branch: `scripts/profiling/io-classify.mjs` is absent, and there is no `scripts/profiling/` directory. Do not record classifier output for this branch.

If the classifier is restored on another branch, run:

```bash
node scripts/profiling/io-classify.mjs tests2/core fsonly-list
```

## Scoped `rg` audit methodology

Use scoped searches under `tests2/core`; never search the whole repository for these counts.

Temp-dir marker files:

```bash
rg -l 'mkdtempSync|makeTmpDir|os\.tmpdir\(|tmpdir\(' tests2/core | sort -u | wc -l
```

`BOBBIT_DIR` reference files:

```bash
rg -l 'process\.env\.BOBBIT_DIR' tests2/core | sort -u | wc -l
```

Module-level `BOBBIT_DIR` assignment files can be audited with a small heuristic: list files where `process.env.BOBBIT_DIR =` appears before the first `describe(`, `it(`, or `test(`. Use that as a triage list, then inspect each file before migrating.

Current branch snapshot from the scoped audit:

- Temp-dir marker files in `tests2/core`: 242
- Files referencing `process.env.BOBBIT_DIR` in `tests2/core`: 75
- Heuristic module-level `BOBBIT_DIR` assignment files: 60

For before/after reporting, run the same commands before a migration batch and after it lands. Report both the file count and the exact command, not just the delta.

## Remaining module-level `BOBBIT_DIR` tests

These files still set `BOBBIT_DIR` at module scope on this branch. Buckets describe why they remain and where the next seam should be considered.

### Cost and tree-cost store candidates

Likely fs-only or mostly store-backed. Migrate mechanically when each test can construct stores with `fsImpl` instead of relying on `BOBBIT_DIR`.

- `tests2/core/api-goals-tree-cost.test.ts`
- `tests2/core/cost-backfill-transcript-pass.test.ts`
- `tests2/core/cost-backfill.test.ts`
- `tests2/core/cost-tracker-backfill.test.ts`
- `tests2/core/cost-tracker-goal-stamp.test.ts`
- `tests2/core/cost-tracker.test.ts`
- `tests2/core/tree-cost-purge-survival.test.ts`
- `tests2/core/tree-cost-rollup.test.ts`

### Session store and persistence candidates

Store-only assertions should move to memfs. Real atomic-write, backup-restore, stale-load, transcript traversal, and orphan cleanup semantics should stay as canonical integration coverage.

- `tests2/core/session-restore-last-activity.test.ts`
- `tests2/core/session-store-atomic-write.test.ts`
- `tests2/core/session-store-orphan-cleanup.test.ts`
- `tests2/core/session-store-stale-load-guard.test.ts`
- `tests2/core/session-store.test.ts`
- `tests2/core/staff-session-staffid-persistence.test.ts`

### Session manager and runtime boot tests

These tests usually boot manager/runtime helpers that still discover state through environment-derived paths. They need helper-level injection before they can stop mutating global env; some may belong in integration if they intentionally cover runtime restore or process behavior.

- `tests2/core/cold-restart-reprompt.test.ts`
- `tests2/core/image-only-prompt-dispatch.test.ts`
- `tests2/core/image-only-prompt-unstick-recovery.test.ts`
- `tests2/core/missing-live-messages-repro.test.ts`
- `tests2/core/revive-window-prompt-dispatch.test.ts`
- `tests2/core/session-id-clobber-guard.test.ts`
- `tests2/core/session-manager-archived-messages-active-tools.test.ts`
- `tests2/core/session-manager-delegate-restore.test.ts`
- `tests2/core/session-manager-direct-prompt-lifecycle.test.ts`
- `tests2/core/session-manager-force-abort-grace.test.ts`
- `tests2/core/session-manager-heartbeat.test.ts`
- `tests2/core/session-manager-no-precreate.test.ts`
- `tests2/core/session-manager-orphan-keep.test.ts`
- `tests2/core/session-manager-respawn-provider-bridge.test.ts`
- `tests2/core/session-manager-restore-prompt-order.test.ts`
- `tests2/core/session-manager-restore.test.ts`
- `tests2/core/session-manager-skills-catalog-empty-allowlist.test.ts`
- `tests2/core/skill-sidecar.test.ts`
- `tests2/core/staff-accessory-store.test.ts`
- `tests2/core/staff-orphan-reassign.test.ts`
- `tests2/core/staff-sandboxed-persistence.test.ts`
- `tests2/core/system-prompt-order.test.ts`
- `tests2/core/system-prompt.test.ts`

### Team, gate, task, and orchestration tests

These cover higher-level orchestration state. Direct store cases can use memfs; manager/team lifecycle cases need injected state roots or should remain outside the fs-only bucket.

- `tests2/core/auto-retry-policy.test.ts`
- `tests2/core/gate-store-logic.test.ts`
- `tests2/core/multi-project.test.ts`
- `tests2/core/task-state-machine.test.ts`
- `tests2/core/team-manager-boot-respawn.test.ts`
- `tests2/core/team-manager-ghost-workers.test.ts`
- `tests2/core/team-manager-idle-nudge-backoff.test.ts`
- `tests2/core/team-manager-reviewer-resume.test.ts`
- `tests2/core/team-manager-worker-idle-debounce.test.ts`
- `tests2/core/team-manager.test.ts`

### Headquarters, agent-dir, path, and extension behavior

These intentionally exercise environment resolution, agent/headquarters paths, path remapping, extension cache repair, tool loading, or sandbox/verification wiring. Do not convert them mechanically; first decide whether the behavior is unit-seamable or a real-IO integration proof.

- `tests2/core/container-path-translation.test.ts`
- `tests2/core/gateway-deps-default-real.test.ts`
- `tests2/core/headquarters-no-worktree-runtime.test.ts`
- `tests2/core/openrouter-glm-thinking.test.ts`
- `tests2/core/openrouter-key-bridge-repro.test.ts`
- `tests2/core/preview-content-route.test.ts`
- `tests2/core/rpc-bridge-pack-path-remap.test.ts`
- `tests2/core/session-recovery-agent-dir.test.ts`
- `tests2/core/tool-description-budget.test.ts`
- `tests2/core/transcript-sanitizer-agent-dir.test.ts`
- `tests2/core/verification-harness-timeout.test.ts`
- `tests2/core/verification-sandbox-exec.test.ts`
- `tests2/core/verification-tool-activation.test.ts`

## Validation commands

Run targeted tests for the files touched by a migration batch:

```bash
npx vitest run tests2/core/cost-tracker.test.ts tests2/core/cost-tracker-goal-stamp.test.ts tests2/core/cost-tracker-backfill.test.ts --config vitest.config.ts
npx vitest run tests2/core/session-store.test.ts tests2/core/session-store-stale-load-guard.test.ts tests2/core/session-restore-last-activity.test.ts --config vitest.config.ts
npx vitest run <touched core files> --config vitest.config.ts
npx vitest run <new integration files> --config vitest.config.ts
```

Final validation for implementation branches:

```bash
npm run check
npm run test:unit
```

The known unrelated `bundle-size.test.ts` failure should not be worsened by this workstream.

## Profiling references

The older `scripts/profiling/vitest.profile.config.ts` reference is also absent on this branch. Use the current hook/file residual profiler:

```bash
npm run test:v2:profile-hooks -- <representative tests2/core files>
node scripts/testing-v2/profile-hooks.mjs --from-json .profiles/testing-v2/hook-profile/<run>/vitest.json
```

The profiler writes artifacts under `.profiles/testing-v2/hook-profile/<timestamp>/`. Commit only distilled summaries or reports under `docs/`; do not commit raw `.profiles/` output.
