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

Module-level `BOBBIT_DIR` assignment files can be audited with a small Python heuristic: list files where `process.env.BOBBIT_DIR =` appears before the first `describe(`, `it(`, or `test(`. Use that as a triage list, then inspect each file before migrating.

```bash
python -c "
import subprocess, re
files = subprocess.check_output(['git','grep','-l','process.env.BOBBIT_DIR','--','tests2/core/*.test.ts'],text=True).split()
mod=[]
for f in files:
    src=open(f,encoding='utf-8').read()
    m=re.search(r'\b(describe|it|test)\s*\(',src)
    assign=re.search(r'process\.env\.BOBBIT_DIR\s*=',src)
    if assign and (not m or assign.start()<m.start()): mod.append(f)
print(len(mod)); [print(f) for f in sorted(mod)]
"
```

The tool used to gather these counts differs by worktree. `git grep` is available everywhere; on worktrees without ripgrep, substitute `git grep -l -E '<pattern>' -- 'tests2/core/*.test.ts' | sort -u | wc -l`.

### Before/after snapshot

Baseline is the pre-migration branch snapshot (commit `8d2b3601`, before any cluster landed). After is the current state with all coder branches merged.

| Metric (scoped to `tests2/core`) | Before | After |
| --- | --- | --- |
| Temp-dir marker files (`mkdtempSync` / `makeTmpDir` / `os.tmpdir(` / `tmpdir(`) | 242 | 209 |
| Files referencing `process.env.BOBBIT_DIR` | 75 | 62 |
| Heuristic module-level `BOBBIT_DIR` assignment files | 60 | 47 |
| Files importing `createMemFs()` | 4 | 43 |

`createMemFs()` adoption grew nearly 11x (4 → 43 files), which is the direct signal that fs-only store tests now run against the in-memory seam instead of real disk. The module-level heuristic count is tool-dependent (the exact figure varies by ~2–3 between `git grep` and ripgrep-based scans); treat it as an approximate triage signal, not a precise metric.

For before/after reporting on a future batch, run the same commands before a migration lands and after it lands. Report both the file count and the exact command, not just the delta.

## Migrated store clusters

These clusters are now fully or largely on `createMemFs()`. They no longer set `BOBBIT_DIR` at module scope and construct stores with an injected `fsImpl`.

### Cost and tree-cost store family — migrated

Migrated to memfs (`new CostTracker(stateDir, memfs)`):

- `tests2/core/cost-tracker.test.ts` (39 cases)
- `tests2/core/cost-tracker-backfill.test.ts`
- `tests2/core/cost-tracker-goal-stamp.test.ts`
- `tests2/core/tree-cost-rollup.test.ts`
- `tests2/core/tree-cost-purge-survival.test.ts`
- `tests2/core/api-goals-tree-cost.test.ts`

Two files in this family are intentional leftovers — see "Intentional leftovers" below.

### Session store family — migrated

All six session-store persistence tests moved to memfs (`new SessionStore(stateDir, memfs, fakeClock?)`), with real-disk fidelity relocated to `tests2/integration/session-store-real-fs.test.ts` (see "Integration fidelity coverage"):

- `tests2/core/session-store.test.ts` (46 cases)
- `tests2/core/session-store-stale-load-guard.test.ts`
- `tests2/core/session-store-atomic-write.test.ts`
- `tests2/core/session-store-orphan-cleanup.test.ts`
- `tests2/core/session-restore-last-activity.test.ts`
- `tests2/core/staff-session-staffid-persistence.test.ts`

### Model / preferences / PR-status / review-annotation stores — migrated

`tests2/core/store-fsimpl-contract.test.ts` now reuses `createMemFs()` and proves `PreferencesStore`, `PrStatusStore`, and `ReviewAnnotationStore` write and reload through the injected fs. Model-state and goal-adjacent store tests in Clusters D/E were migrated in the same pass. `tests2/core/reviewer-archive-metadata.test.ts` had its `SessionStore` case migrated to `createMemFs()`.

### Gate / inbox stores — migrated

Post-fix follow-ups moved three more store tests onto memfs:

- `tests2/core/gate-store-logic.test.ts` (each test now gets a fresh memfs; no `BOBBIT_DIR` env mutation)
- `tests2/core/inbox-manager.test.ts`
- `tests2/core/inbox-nudger.test.ts`

## Integration fidelity coverage

Real-disk fidelity was preserved, not deleted. Coverage moved to the integration lane so unit tests stay fs-free.

### Session store real filesystem — `tests2/integration/session-store-real-fs.test.ts`

New file (registered in `tests2/tests-map.json`) with three canonical real-fs cases against the default `realFs`:

- `saveNow` persists `sessions.json` through real fs and leaves no `.tmp` after the atomic rename.
- Real `.bak.N` backup rotation, and restore from `.bak.1` after a corrupt primary.
- Real nested transcript directory traversal (orphan-cleanup walk), ignoring tracked/old `.jsonl` files by real `mtime`.

### CostTracker real filesystem — `tests2/integration/cost-tracker-real-fs.test.ts`

`CostTracker`'s default `realFs` persistence now has a dedicated canonical integration test (registered in `tests2/tests-map.json`): it constructs a `CostTracker` against a real temp dir with the default (uninjected) fs and asserts `session-costs.json` is persisted and reloaded through `realFs`. This is the fidelity proof the design plan called for after `cost-tracker.test.ts` moved to memfs.

The gateway-backed integration tests `tests2/integration/compact-cost-ws.test.ts` and `tests2/integration/cost-update-cache-hit.test.ts` additionally exercise the default filesystem path end to end via a real gateway. The memfs unit tests in `cost-tracker.test.ts` therefore cover the store logic without duplicating disk fidelity.

The generic injected-fs contract is additionally pinned by `tests2/core/store-fsimpl-contract.test.ts`, and the omitted-`fsImpl` real-fs default is asserted by `tests2/core/gateway-deps-default-real.test.ts` (`deps.fsImpl === realFs`).

## Intentional leftovers

These files still touch real IO on purpose. They are out of scope for a mechanical memfs swap and are documented here so future batches do not migrate them blindly.

### Cost backfill — needs a production env/state seam first

- `tests2/core/cost-backfill.test.ts`
- `tests2/core/cost-backfill-transcript-pass.test.ts`

These exercise the transcript-backfill path, which discovers state and transcript files through environment-derived paths at module load (`process.env.BOBBIT_DIR = ...`) rather than through an injected `fsImpl`. Migrating them requires first adding a production seam so the backfill helper accepts an injected state dir + `fsImpl` instead of reading env. Until that refactor lands (a separate coding goal), they remain on real disk. `cost-tracker.test.ts` already covers the store's read/write logic on memfs, so the store surface is not under-tested — only the backfill entrypoint's path resolution stays on disk.

### Image / auth / model-file tests — `BOBBIT_AGENT_DIR`, `auth.json`, model files

These intentionally exercise agent-directory resolution, OAuth credential files, and on-disk model registries. The behavior under test *is* the real filesystem layout (path remapping, credential discovery, container path translation), so an in-memory fs would remove the thing being verified. Representative files:

- `tests2/core/agent-dir-migration.test.ts`, `tests2/core/agent-dir-validation.test.ts`, `tests2/core/bobbit-dir-agent-dir.test.ts`, `tests2/core/session-recovery-agent-dir.test.ts`, `tests2/core/transcript-sanitizer-agent-dir.test.ts`
- `tests2/core/oauth-google.test.ts`, `tests2/core/sandbox-codex-auth.test.ts`, `tests2/core/sandbox-google-auth.test.ts`, `tests2/core/google-code-assist*.test.ts`, `tests2/core/bobbit-tool-credentials.test.ts`
- `tests2/core/image-from-url-cap.test.ts`, `tests2/core/image-generation-registry.test.ts`, `tests2/core/model-state-meta-resolver.test.ts`, `tests2/core/openai-model-additions-merge.test.ts`
- `tests2/core/container-path-translation.test.ts`, `tests2/core/project-sandbox-agent-dir-mounts.test.ts`, `tests2/core/docker-args.test.ts`, `tests2/core/spawn-env.test.ts`

Regenerate the full list with:

```bash
git grep -l -E 'BOBBIT_AGENT_DIR|auth\.json|models\.json|model-state' -- 'tests2/core/*.test.ts' | sort -u
```

### Other non-store real IO

`BOBBIT_DIR` also appears in tests whose subject is not a persistence store: gateway-deps defaults, MCP/extension discovery, path remapping, sandbox/verification wiring, tool loading, and headquarters/runtime boot. These are either real-IO integration proofs that belong in `tests2/core` by design, or manager/runtime boot tests that need helper-level state injection before they can drop env mutation. They are listed in the buckets below and remain migration candidates only where the subject is genuinely a store.

## Remaining migration candidates

These files still set `BOBBIT_DIR` at module scope. Buckets describe why they remain and where the next seam should be considered. Regenerate the current module-level list with the Python heuristic above.

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
- `tests2/core/multi-project.test.ts`
- `tests2/core/task-state-machine.test.ts`
- `tests2/core/team-manager-boot-respawn.test.ts`
- `tests2/core/team-manager-ghost-workers.test.ts`
- `tests2/core/team-manager-idle-nudge-backoff.test.ts`
- `tests2/core/team-manager-reviewer-resume.test.ts`
- `tests2/core/team-manager-worker-idle-debounce.test.ts`
- `tests2/core/team-manager.test.ts`

### Headquarters, agent-dir, path, and extension behavior

These intentionally exercise environment resolution, agent/headquarters paths, path remapping, extension cache repair, tool loading, or sandbox/verification wiring. Do not convert them mechanically; first decide whether the behavior is unit-seamable or a real-IO integration proof. Several of these (`container-path-translation`, `session-recovery-agent-dir`, `transcript-sanitizer-agent-dir`, `gateway-deps-default-real`) are documented as intentional leftovers above — their subject *is* the real filesystem layout.

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

### Final validation result

The migration was validated with a targeted vitest run over the touched core and new integration files plus a type-check:

- Targeted run: **42 files / 394 tests passed** (all migrated `tests2/core` store tests and the two new `tests2/integration` real-fs fidelity tests).
- `npm run check` passed (no type regressions from the seam refactors and test moves).

These are the pass signals for this workstream; the full `npm run test:unit` gate still carries the pre-existing, unrelated `bundle-size.test.ts` failure noted above.

## Profiling references and evidence

The older `scripts/profiling/vitest.profile.config.ts` reference is absent on this branch. The current hook/file-residual profiler is `scripts/testing-v2/profile-hooks.mjs`, invoked via:

```bash
npm run test:v2:profile-hooks -- <representative tests2/core files>
node scripts/testing-v2/profile-hooks.mjs --from-json .profiles/testing-v2/hook-profile/<run>/vitest.json
```

The profiler writes artifacts under `.profiles/testing-v2/hook-profile/<timestamp>/`. Commit only distilled summaries or reports under `docs/`; do not commit raw `.profiles/` output.

### Branch limitation for this report

The profiler could not be executed from the docs worktree used to write this report: that worktree has no installed `node_modules`, so `npx vitest` fails to resolve the `vitest` package (`ERR_MODULE_NOT_FOUND` from `vitest.config.ts`). This is a docs-worktree limitation, not a defect in the profiler or the migration — run the profiler from a fully installed checkout (e.g. the primary worktree after `npm install`) to capture per-file hook/residual timings.

### Substitute metrics

Because a per-hook wall-time run was not feasible here, this report relies on structural substitute metrics that are deterministic and reproducible from `git grep`:

- **Real-IO surface reduction** — the before/after table above: temp-dir marker files 242 → 209, `BOBBIT_DIR` files 75 → 62, module-level `BOBBIT_DIR` assignments 60 → 47.
- **Seam adoption** — `createMemFs()` importers 4 → 43. Every migrated store test replaced per-case `mkdtemp` + recursive `rm` teardown (a real syscall pair per test) with in-memory maps, eliminating that fixed setup/teardown cost from the affected files.
- **Coverage preservation** — assertion counts held across the migration: `cost-tracker.test.ts` 39 cases, `session-store.test.ts` 46 cases; the moved real-fs fidelity is re-proven by the 3 cases in `session-store-real-fs.test.ts` and the CostTracker case in `cost-tracker-real-fs.test.ts`.

To produce the wall-time before/after when tooling is available, profile a representative migrated subset (e.g. `cost-tracker.test.ts session-store.test.ts store-fsimpl-contract.test.ts`) on the current branch, then again on the pre-migration baseline (`git stash` / a checkout of `8d2b3601`), and diff the summed file-residual bucket.
