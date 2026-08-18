# Unit gate operating model

`npm run test:unit` is Bobbit's authoritative tier-1 gate. It runs the complete map-owned Vitest inventory through one coordinator. `npm run test:affected` is the default developer feedback command: it selects a conservative unit closure and may reuse checkout-local PASS results, but it never replaces full qualification.

The unit, DOM, and integration projects share the cross-suite isolation foundation with browser and E2E gates, so simultaneous workflow runs do not depend on host HOME, credentials, config, or mutable caches.

See [Cross-suite test runtime design](cross-os-unit-gate-design.md) for the full wiring, [Cross-OS test authoring](cross-os-test-authoring.md) before adding a fixture, and the [affected-runner reference](../../scripts/affected/README.md) for selection and cache semantics.

## Feedback and qualification commands

Use affected feedback while iterating, then run the complete gate required by the workflow:

```bash
npm run test:affected
BOBBIT_V2_RETRY_FREE=1 npm run test:unit
```

The affected command includes committed, staged, unstaged, and untracked changes relative to the remote-primary merge base. Its `SKIP-ALL`, bounded, and cache-hit results are optimization evidence only. A conservative `RUN-ALL` bypasses prior cache records and passes every unit-owned file to Vitest.

`test:unit` and `test:v2:core` run Vitest directly:

```text
vitest run --config vitest.config.ts --silent=passed-only
```

The suite has a fixed cap of three fork workers shared by every unit project. `VITEST_MAX_WORKERS=1` or `2` may lower that cap for diagnosis; it cannot raise it. The normal developer configuration retains `retry: 3` as developer/workflow protection, but it is not qualification evidence. Qualification uses the repository wrapper with the exact retry-free control:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:unit
```

The unit configuration consumes that flag and resolves every unit project to zero retries; a qualification record must show zero observed retries. Direct Vitest retry flags are diagnostic only, not qualification authority.

Affected testing is local developer feedback only and does not run in CI. Pull requests and pushes to the primary branch run the cross-platform full `npm run test:unit` job with Vitest's normal retry policy. Result files under `.profiles/test-cache/` are local only and are never uploaded or restored in CI. Browser and E2E gates remain separate authoritative phases.

The broader reliability proof may run retry-free coordinators from separate worktrees; see the cross-OS authoring guide.

## Projects and boundaries

Normal collection contains these explicit projects from `tests2/tests-map.json`:

| Project | Runtime | Isolation | Purpose |
|---|---|---|---|
| `v2-core` | Node, forks | shared worker modules | Pure and server decision coverage |
| `v2-dom` | happy-dom, forks | Per file | DOM/component coverage |
| `v2-integration` | Node, forks | shared worker modules | In-process gateway and API coverage |
| `v2-isolated` | Node, forks, one worker | Per file | Documented module/environment bleeders only |

`v2-e2e-vitest` exists only when `BOBBIT_V2_E2E_VITEST=1`; E2E Group D selects it rather than the unit gate.

All tier-1 projects install `tests2/harness/tier1-spawn-guard.ts`. It blocks async and sync `child_process` APIs, including imports that happened before setup. Use a command seam or copied repository template instead. The inventory audit also rejects direct value imports/requires of `child_process` in unit-owned tests.

A tier-1 file has a 25-second wall budget from module start through hooks and retries. `BOBBIT_UNIT_CONCURRENT_PROOF=1` makes only loaded file-wall overruns report-only for the simultaneous-load measurement; failed suites, tests, and setup remain fatal. Proof-mode output never qualifies as solo timing evidence.

## Canonical run ownership

Before prebundling, collection, or worker spawn, Vitest installs run isolation. The coordinator creates one canonical temporary root and redirects all mutable state beneath it: temporary files, HOME, Bobbit/config/agent/secrets, application/XDG paths, transform and V8 caches, coverage, reports, output, sockets, databases, and artifacts. Forks inherit the root but cannot clean it; only the allocating coordinator cleans a successful root after its reporters and children settle. Failed roots are retained.

The **machine-global concurrency ledger** is the sole mutable exception. It is captured before temp redirection so concurrent gates use the same capacity accounting. Browser binaries are also resolved before HOME is redirected, but that registry is a read-only installed dependency, not a shared writable test resource.

The shared environment sanitizer runs before imports and child construction. It removes credentials and ambient Bobbit discovery/runtime values such as pack paths, gateway/session/token values, command adapters, CLI/command overrides, and GitHub command selection. Deliberate `BOBBIT_TEST_*` and `BOBBIT_V2_*` controls remain unless they are a denied runtime input or a harness-owned root. Owned keys are replaced canonically and case-insensitively on Windows. Fixtures must provide any needed value locally and restore it; they must never rely on the developer shell.

## DOM and fixture portability

The DOM setup uses happy-dom's owning per-file window for local/session storage, clears those stores between tests, and restores the prior runtime descriptors. This avoids Node 26 globals that can be present but are not usable browser storage.

Fixtures create writable trees under the active run root (or receive explicit fixture-local paths). Use fixture Git identity/config and line-ending attributes, local `file://` pack/skill trees, loopback or in-process MCP/gateway stubs, explicit config roots, scoped credentials, and canonical LF/CRLF assertions. Do not use global Git configuration, developer HOME, remote services, host commands, or checkout state as fixture input.

## Caches and audits

The server prebundle is content-addressed and atomically published. Vitest transformed modules use a PID-scoped directory below the coordinator root, allowing one run's projects/workers to share transformed code without concurrent coordinators racing on writable metadata.

The affected-result cache is separate. It stores per-file PASS verdicts under `.profiles/test-cache/`, keyed by runner identity and hashes of each test's complete code/non-code dependency closure. It snapshots those hashes before execution and certifies PASS only when they remain unchanged afterward. Failures and ambiguous reports do not remain cached; `RUN-ALL` bypasses reads. The cache is checkout-local optimization state, not a coordinator input or qualification artifact.

The affected runner collects Git records before constructing the graph. Exact deleted paths and rename old sides become tombstones, so declared shipped-input, scan, and indirect-reader ownership survives removal from the current tree. Unknown or deleted executable sources still `RUN-ALL` with cache bypass because a tombstone cannot reconstruct the former static import closure. Graph claims are also checked before documentation skipping: shipped prompt, skill, and pack Markdown remains test-affecting, while ordinary unclaimed documentation deletion may skip.

Historical correctness evidence has a stricter contract than the local PASS cache. Each plan is built from exact revision files, a revision-local execution-map loader, and that revision's unit inventory; current selector declarations are compatibility-audited against the old tree. Absent future declarations may be ignored, live unresolved/dynamic unit consumers are quarantined into bounded plans, and unreconcilable live graph or ownership drift becomes `RUN-ALL`. Only revision loader or graph-construction incompatibility may deliberately fall back; later classification, compatibility, or selector exceptions fail qualification.

Changed and clean-baseline full reports must each cover exactly the authoritative unit inventory from their own checked-out revision. Native `--changed` reports may be subsets but cannot name files outside that inventory, and every report must agree with its process exit. Missing, partial, crashed, or contradictory reports fail qualification before affected-set comparison.

Run the inventory audit after changing test ownership or fixtures:

```bash
npm run test:unit:inventory
```

It verifies map ownership and declaration semantics, exact E2E ownership, project scheduling, isolated-project policy, the child-process boundary, and cross-process ownership tokens for writable/cleaned shared-worker fixture paths.

## Authoring rule

A new test must synchronize on an exact observable lifecycle event, not elapsed time. Do not add sleeps, polling, retries, skips, `force-exit`, timeout increases, blind reloads, incidental fetch interception, or weaker assertions. Repair fixture ownership, teardown, or the real completion event instead.

Register every new test in `tests2/tests-map.json`. If a test or production loader discovers repository files through a computed path, scan, copy, worker entry, dynamic import, or shipped configuration family, declare and pin that dependency in the affected impact inventory. Selection and cache hashing share this inventory; leaving out the edge would weaken both.

Historical design and qualification evidence remain in [fast-gate design](fast-gate-design.md), [fast-gate progress](fast-gate-progress.md), and [Windows profiling](windows-unit-profile-2026-07-14.md).
