# Unit gate operating model

`npm run test:unit` is Bobbit's authoritative tier-1 gate and the normal local unit-feedback command. It runs the complete convention-discovered Vitest inventory through one coordinator, so local feedback cannot drift from a separately maintained registry or change-impact model.

The unit, DOM, and integration projects share the cross-suite isolation foundation with browser and E2E gates, so simultaneous workflow runs do not depend on host HOME, credentials, config, or mutable caches.

See [Cross-suite test runtime design](cross-os-unit-gate-design.md) for the full wiring and [Cross-OS test authoring](cross-os-test-authoring.md) before adding a fixture.

## Feedback and qualification commands

Use the complete unit lane while iterating:

```bash
npm run test:unit
```

`test:unit` and `test:v2:core` run Vitest directly:

```text
vitest run --config vitest.config.ts --silent=passed-only
```

The suite has a fixed cap of three workers. `VITEST_MAX_WORKERS=1` or `2` may lower that cap for diagnosis; it cannot raise it. The normal developer configuration retains `retry: 3` as developer/workflow protection, but it is not qualification evidence. Qualification uses the repository wrapper with the exact retry-free control:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:unit
```

The unit configuration consumes that flag and resolves every unit project to zero retries; a qualification record must show zero observed retries. Direct Vitest retry flags are diagnostic only, not qualification authority.

Pull requests and pushes to the primary branch run the same cross-platform complete `npm run test:unit` lane with Vitest's normal retry policy. Browser and E2E gates remain separate authoritative phases.

The broader reliability proof may run retry-free coordinators from separate worktrees; see the cross-OS authoring guide.

## Projects and boundaries

Normal collection contains these projects, derived from path and suffix conventions:

| Project | Runtime | Isolation | Purpose |
|---|---|---|---|
| `v2-core` | Node, forks | shared worker modules | Pure and server decision coverage |
| `v2-dom` | happy-dom, threads | Per file | DOM/component coverage |
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

## Prebundle and audits

The server prebundle is content-addressed and atomically published. Vitest transformed modules use a PID-scoped directory below the coordinator root, allowing one run's projects/workers to share transformed code without concurrent coordinators racing on writable metadata.

Run the inventory audit after changing test ownership or fixtures:

```bash
npm run test:unit:inventory
```

It verifies convention-based ownership and declaration semantics, exact E2E ownership, project scheduling, isolated-project policy, the child-process boundary, and cross-process ownership tokens for writable or cleaned shared-worker fixture paths.

## Authoring rule

A new test must synchronize on an exact observable lifecycle event, not elapsed time. Do not add sleeps, polling, retries, skips, `force-exit`, timeout increases, blind reloads, incidental fetch interception, or weaker assertions. Repair fixture ownership, teardown, or the real completion event instead.

Place and name every new test according to the [test placement table](../testing-strategy.md#test-placement-and-automatic-discovery). The path and semantic suffix are its runner, tier, and project metadata; no separate registration or path-impact registry is allowed.

Historical design and qualification evidence remain in [fast-gate design](fast-gate-design.md), [fast-gate progress](fast-gate-progress.md), and [Windows profiling](windows-unit-profile-2026-07-14.md).
