# Test Suite v2 hook profiling

See the committed before/after summary and measurement caveats in [unit-test-optimization-report.html](unit-test-optimization-report.html).

Run from a checkout with dependencies installed:

```bash
npm run test:v2:profile-hooks -- [vitest file/project args]
```

The command writes artifacts to `.profiles/testing-v2/hook-profile/<timestamp>/`:

- `vitest.json` — raw Vitest JSON reporter output.
- `report.json` — normalized machine-readable summary.
- `report.md` — before/after-friendly summary with wall time, summed file time, slowest files, largest file residuals, and slowest tests.

Examples:

```bash
npm run test:v2:profile-hooks -- tests2/core/team-manager.test.ts
npm run test:v2:profile-hooks -- --project v2-integration tests2/integration/gateway-fixture-leak.test.ts
node scripts/testing-v2/profile-hooks.mjs --from-json .profiles/testing-v2/hook-profile/<run>/vitest.json
```

## Reading the report

Use `report.md` for review comments and `report.json` for scripted comparisons. Compare wall time, summed file runtime, summed file residual, slowest files, largest residual files, slowest tests, and integration cleanup counters before changing fixtures or cleanup behavior. Commit distilled summaries or HTML reports under `docs/`; do not commit raw `.profiles/` artifacts.

## Hook attribution limits

Vitest's stable JSON reporter exposes file and test durations, but not reliable `beforeAll` / `beforeEach` / `afterEach` / `afterAll` timings. The profiler therefore reports a conservative **file residual** value:

```text
file residual = file runtime - summed reported test runtime
```

Residual time is useful for spotting hook/setup/teardown hotspots, but it may also include module evaluation, fixtures, collection/runtime overhead, and reporter overhead. If the integration harness writes cleanup stats into the directory named by `BOBBIT_V2_HOOK_PROFILE_DIR`, the profiler automatically merges counters such as snapshots, sweeps, skipped sweeps, default resets/restores, and entity deletes into the report.

## Prebundle evaluation

A server/verification graph prebundle was evaluated but not landed in this workstream. The previous feasibility probe in [gateway-cost-feasibility.md](gateway-cost-feasibility.md) showed a potentially large transform/collect win, but also found unsafe path-resolution differences in a naive esbuild bundle, especially around `import.meta.url`-derived defaults/pack paths and generated AI gateway metadata.

Landing a prebundle safely would require `vitest.config.ts` aliasing plus a parity guard proving bundled-vs-source behavior for defaults discovery, pack resolution, verification exports, and coverage mapping. That would overlap the fake-runner configuration workstream and carries higher risk than the fixture cleanup optimizations. The fallback for this goal is the low-risk profiling command above plus fixture/process-spawn optimizations in the other workstreams.
