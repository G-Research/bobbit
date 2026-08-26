# Real-fidelity E2E tests

This subtree owns behavior whose defining requirement is real Git, worktree, process, restart, MCP, Docker, pack, port, or browser/process fidelity. Normal deterministic Chromium fixtures and app journeys belong under `tests/browser/`, not here. See [Testing strategy](../../docs/testing-strategy.md) for the complete placement table.

## Execution groups

`npm run test:e2e` discovers four groups directly from directory and suffix conventions:

| Group | Canonical pattern | Runner | Purpose |
|---|---|---|---|
| A | `tests/e2e/node/**/*.node-e2e.test.ts` | `tsx --test` | Real Git, worktree, and process behavior |
| B | `tests/e2e/api/**/*.api-e2e.spec.ts` | Playwright project `api` | API, MCP, port, restart, and Docker fidelity without a browser |
| C | `tests/e2e/browser/**/*.browser-e2e.spec.ts` | Playwright project `browser` | Real Chromium plus process/restart/pack/Docker fidelity |
| D | `tests/e2e/vitest/**/*.vitest-e2e.test.ts` | isolated Vitest project | Real-fidelity tests that need Vitest seams |

The coordinator serializes the gateway/worktree/browser-heavy A → B → C chain. The isolated one-worker D group runs independently. Use `node scripts/testing-v2/run-e2e-v2.mjs --list` to inspect discovery or `--group A|B|C|D` for focused development. A focused group is not complete gate evidence.

API E2E must not request Playwright's `page`, `browser`, or `context` fixtures or import browser-only helpers. The layout guard reports that mismatch and names `tests/e2e/browser/**/*.browser-e2e.spec.ts` as the destination.

## Harnesses and support

Shared E2E support is non-runnable and lives under `tests/e2e/_helpers/`:

- `in-process-harness.ts` — API tests that do not require a browser or spawned-process boundary;
- `gateway-harness.ts` — an in-process worker gateway plus the built UI for Chromium, restart fixtures, and opt-in MCP; use a test-local child process when process boundaries are themselves under test;
- `e2e-setup.ts` — shared API, WebSocket, project, session, goal, and polling helpers;
- `test-utils/` — cleanup, Docker capability, readiness, and other bounded utilities.

Import the closest harness that provides the fidelity under test. Do not give helpers a runnable suffix; broadly shared cross-lane support belongs in the relevant `tests/support/` category instead.

Every worker owns its Bobbit directory, temp space, token, ports, project registry, gateway state, caches, and output. A test must not depend on checkout `.bobbit/`, developer credentials/config, global Git state, or another worker's resources. Cleanup may remove only resources created by that test or coordinator.

## Qualification and retries

Ordinary developer and workflow runs retain the configured retry margin. It protects productivity under concurrent load; it is not evidence that a first-attempt failure is acceptable.

Retry-free qualification uses the repository wrapper:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:e2e
```

Groups B, C, and D then use zero retries. Group A is inherently retryless. Qualification evidence must report zero observed retries.

## Docker and external services

The automated E2E coordinator fences remote Git and outbound non-loopback services. Local bare repositories are allowed because real local push behavior is part of E2E fidelity. Docker-dependent cases report whether the daemon and required `bobbit-agent` image are available instead of silently disappearing.

Tests requiring real models, agents, credentials, or external services belong under `tests/manual/**/*.manual.spec.ts` and run only through `npm run test:manual`.

## No flake masking

Do not add quarantine projects, flaky tags, broad skips, retry overrides, sleeps, blind reloads, timeout increases, `force-exit`, or weaker assertions. Synchronize on the observable event that proves readiness or completion, and fix fixture ownership or lifecycle when that event does not arrive.

Use Playwright's retrying assertions for browser conditions and the bounded helpers under `_helpers/test-utils/` for process/API readiness. A known product defect may be skipped only with a precise issue/TODO and retained assertion; a timing-dependent failure is not a known-product-defect exemption.
