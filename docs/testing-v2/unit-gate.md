# Unit gate operating model

`npm run test:unit` is Bobbit's fast, subprocess-free tier-1 gate. It runs the complete map-owned Vitest unit inventory in one coordinator so scheduling stays simple and three suites can run concurrently on the Windows acceptance host without a unit-specific resource broker.

The historical design and qualification evidence remain in [`fast-gate-design.md`](fast-gate-design.md) and [`fast-gate-progress.md`](fast-gate-progress.md).

## Command and workers

`test:unit` and `test:v2:core` both run Vitest directly:

```text
vitest run --config vitest.config.ts --silent=passed-only
```

`vitest.config.ts` applies a fixed suite-wide cap of three workers and `retry: 3`. `VITEST_MAX_WORKERS=1` or `2` may lower the cap for diagnosis; it cannot raise the cap above three.

Nothing on the unit command path reserves a test ledger slot or gateway-boot lease, launches a lane runner, writes lane logs, or cost-shards the inventory. Browser, E2E, and compatibility tooling may still use their own orchestration; that does not make it part of `test:unit`.

## Projects and ownership

Normal unit collection contains four explicit projects loaded from `tests2/tests-map.json`:

| Project | Runtime | Isolation | Purpose |
|---|---|---|---|
| `v2-core` | Node, forks | shared worker modules | pure and server decision coverage |
| `v2-dom` | happy-dom, threads | per file | DOM/component coverage |
| `v2-integration` | Node, forks | shared worker modules | in-process gateway and API coverage |
| `v2-isolated` | Node, forks, one worker | per file | documented module/environment bleeders only |

`v2-e2e-vitest` is conditional: it exists only when `BOBBIT_V2_E2E_VITEST=1` and is selected by E2E Group D, not by the unit gate.

Three Vitest files own real-fidelity E2E coverage:

- `tests2/core/marketplace-install.test.ts`
- `tests2/core/orphan-tool-result-rehydration-boundaries.test.ts`
- `tests2/core/team-manager.test.ts`

Fast decisions remain in tier 1 through `marketplace-install-decisions.test.ts`, `orphan-tool-result-recovery.test.ts`, `transcript-orphan-tool-results.test.ts`, and `team-manager-decisions.test.ts`. The E2E orphan owner retains real host/sandbox transcript bytes and lifecycle boundaries; the core orphan suites retain pure sanitizer and mocked bridge/respawn decisions. The inventory loader rejects any unapproved Vitest E2E owner.

## Transform caches

The unit coordinator prepares an esbuild ESM splitting graph before collection. `server-prebundle.mjs` keys it from the transitive local source graph, config, lockfile, and builder implementation; validates every emitted entry, chunk, and source map; and publishes atomically. The resolver maps server and high-fanout support imports to this content-addressed graph, reducing repeated Vite transformation while preserving source-mapped coverage and module identity.

Vitest's transformed-module cache is separate. Each coordinator uses a PID-scoped namespace under `.profiles/testing-v2/vitest-module-cache/process-<pid>`. Projects and workers in one run may share transformed code, while simultaneous Vitest coordinators cannot race on writable cache metadata.

## Hard boundaries

### Subprocesses

All four tier-1 projects install `tests2/harness/tier1-spawn-guard.ts`. It blocks the async and sync `child_process` APIs, including imports that occurred before setup, and tells the test to use a command seam or copied repository template. The one-time Git template is prepared before the guard closes the process APIs; tests copy it without invoking Git.

The inventory audit also rejects value imports or requires of `child_process` in unit-owned tests. This static check catches direct ownership mistakes, while the runtime guard catches transitive production calls.

### File wall budget

A tier-1 file has a hard 25-second wall budget from module start through hooks and retries. In an ordinary solo run, any overrun fails `test:unit` even when all assertions pass.

For the simultaneous load proof only, set:

```powershell
$env:BOBBIT_UNIT_CONCURRENT_PROOF = "1"
npm run test:unit
```

This mode makes **only loaded file-wall overruns report-only**. Failed suites, failed tests, setup errors, and all other Vitest failures remain fatal. A proof-mode run never qualifies as solo file-budget or solo wall-time evidence; qualification requires ordinary consecutive solo runs.

## Audits

Run the inventory audit after changing test ownership or fixtures:

```bash
npm run test:unit:inventory
```

It compares the current inventory with the merge-base inventory, verifies declaration-level semantic replacements, exact ownership of the two E2E files, complete/disjoint project scheduling, isolated-project policy, and the tier-1 child-process boundary.

The same audit scans mutable `v2-core` and `v2-integration` fixture paths. A timestamp alone is not a cross-process owner token: writable or cleaned paths must include a PID, UUID, `mkdtemp` result, or another clearly unique root. This prevents simultaneous `test:unit` processes from deleting or mutating each other's fixtures.

## Windows profiling

The Windows profiler invokes Vitest projects directly; it does not invoke a unit lane runner or acquire unit ledger/boot leases:

```bash
npm run test:v2:profile-windows
npm run test:v2:profile-windows -- --project v2-core --workers 1 tests2/core/example.test.ts
```

It profiles `v2-core`, `v2-integration`, `v2-dom`, and `v2-isolated` sequentially with process telemetry. `--workers` can only lower the three-worker cap. `--lane` remains accepted solely as a compatibility alias for `--project`; new usage should say `--project`.

See [`windows-unit-profile-2026-07-14.md`](windows-unit-profile-2026-07-14.md) for retained measurements and current profiler examples.
