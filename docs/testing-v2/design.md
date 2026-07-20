# Test Suite v2 Migration Design

> **Historical design.** This document records the migration decisions and measurements that produced Test Suite v2. Its lane, ledger, worker-allocation, retry, and daily-run descriptions are not the current unit-gate contract. See [`unit-gate.md`](unit-gate.md) and [`../../vitest.config.ts`](../../vitest.config.ts) for the implemented unit architecture.

This document was the authoritative architecture for the Test Suite v2 migration. It recorded the settled decisions D1-D6: Vitest forks with `isolate:false`, happy-dom for non-geometry component fixtures, one source-booted gateway per worker, hybrid IO with fenced command/fetch plus store `fsImpl`, browser-E2E consolidation, and automated review gates only.

## D7 — Budget / reliability decision (SETTLED with the user; supersedes the ≤3 min / ≤13 CPU-min figure)

The user accepted a budget increase in exchange for rock-solid reliability. The acceptance bar is now:

- **Single isolated `npm run test:v2` run: < 5 min wall (300 s).**
- **5 concurrent runs × 3 reps = 15/15 green, ZERO flakes, `retries: 0`, each run < 10 min wall (600 s) under mutual load.** Playwright flakes under load are HARD failures — that reliability is the point of the increase.
- `tests2/budgets.json` caps = honest measured stable values with modest headroom. **Never** padded with `test.slow()`/long timeouts, **never** met by relaxing/downgrading assertions or by dry-run proofs.
- **Primary mechanism to remove under-load flakes = reduce CPU exhaustion, not timeout padding.** The ledger must genuinely cap Σworkers ≤ cores (24) across all concurrent runs so 5-way load gives each run ~4 vitest / ~2 playwright workers instead of oversubscribing (~60 slots). Correct capping makes the suite both more reliable and faster under load.

(User quotes: "We can accept the budget increase if there are 0 flakes under load." / "High reliability, runs under 5 minutes in isolation, runs under 10 mins under load with 0 flakes." / "Eliminate flakes by reducing cpu exhaustion — this keeps the test performant when run in parallel and increases reliability and speed.") The goal-spec prose was not machine-editable from the team-lead sandbox token; this section is the authoritative record.

Authoritative inputs:

- Inventory: [`docs/testing-v2/inventory.md`](./inventory.md)
- Machine map: [`tests2/tests-map.json`](../../tests2/tests-map.json)
- Baseline metrics: [`docs/testing-metrics/`](../testing-metrics/)
- Validator run during this design pass: `node scripts/testing-v2/check-inventory.mjs` → PASS, 1105/1105 mapped once.

## 1. GatewayDeps DI seams

`createGateway(config, deps?)` becomes the single runtime wiring point. Missing deps always default to production implementations; the CLI boundary passes no test doubles.

**CLI contract phase scoping.** During migration, `cli.ts` MAY map legacy env flags to deps (the documented CLI-only bridge that keeps the legacy suite green) — the strict "no test doubles from the CLI" contract (`cli-real-deps.test.ts`) is enforced starting at the switchover gate: the CLI injects no test doubles or harness fences. **Accepted deviation at switchover (settled with the user):** the env→runtime-flag bridge (`src/server/legacy-test-runtime-flags.ts`) is RETAINED as a documented CLI-boundary / operator-feature exception — it feeds `GatewayConfig` fields and serves operator features (`qa_start_command`, `scripts/bench-server-cpu.mjs`) — rather than being fully deleted. `cli-real-deps.test.ts` pins the narrower live contract (no test doubles from the CLI). Concretely: the DI-runtime and mass-migration gates permit the CLI env bridge; the switchover gate accepts the documented bridge plus the two `NODE_ENV === "test"` conditionals (see §1.7). (An earlier plan proposed a standalone `check-no-test-flags.mjs` grep gate; that was dropped — the switchover gate is llm-review-only, so no production command needs it, and `cli-real-deps.test.ts` already pins the no-test-doubles CLI contract.) Intermediate migration commits therefore never conflict with the final no-deps CLI contract.

```ts
export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): TimerHandle;
  setInterval(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  clearInterval(handle: TimerHandle): void;
}

export interface CommandRunner {
  execFile(file: string, args: readonly string[], options?: ExecFileOptions): Promise<ExecFileResult>;
  execFileSync?(file: string, args: readonly string[], options?: ExecFileSyncOptions): Buffer | string;
  spawn?(file: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
}

export interface GatewayDeps {
  clock?: Clock;
  commandRunner?: CommandRunner;
  fetchImpl?: typeof fetch;
  agentBridgeFactory?: RpcBridgeFactory;
}
```

Default-real wiring:

- `clock` defaults to `Date.now`, global timers, and global clear functions.
- `commandRunner` defaults to Node `execFile` / `execFileSync` / `spawn` wrappers already used by production.
- `fetchImpl` defaults to `globalThis.fetch`.
- `agentBridgeFactory` defaults to the existing child-process `RpcBridge` path.
- Store/config classes receive `fsImpl: FsLike = nodeFs` in their constructors; gateway construction passes no `fsImpl` in production.

### 1.1 Clock seam audit

Audit command used:

```bash
git grep -n -E 'setInterval|setTimeout|clearInterval|clearTimeout' -- 'src/server/*.ts' 'src/server/**/*.ts'
```

Result: **271 matches in 48 files**. `src/server/harness.ts` and `src/server/watchdog.ts` are dev tooling and remain out of scope. The final production Clock seam is therefore **46 files**. This amends the goal spec's initial 14-file list by adding one-shot timeout owners and runtime helper modules that the grep proved are reachable under gateway tests; the only removals are the two dev-tooling files.

Final production files receiving `Clock` or a local `clock` option:

| File | Grep matches | Notes |
|---|---:|---|
| `src/server/agent/aigw-manager.ts` | 3 | timeout/backoff; also currently has test env skips |
| `src/server/agent/bg-process-manager.ts` | 22 | status/projection/kill timers |
| `src/server/agent/bg-process-store.ts` | 4 | debounced persistence |
| `src/server/agent/bg-wait-response.ts` | 2 | heartbeat |
| `src/server/agent/cpu-diagnostics.ts` | 3 | periodic flush |
| `src/server/agent/goal-manager.ts` | 1 | branch-operation wait |
| `src/server/agent/google-code-assist-provider-extension.ts` | 2 | abort timeout |
| `src/server/agent/google-code-assist.ts` | 7 | request timeout/retry sleep |
| `src/server/agent/inbox-nudger.ts` | 4 | periodic nudge sweep |
| `src/server/agent/mcp-gateway-source.ts` | 5 | request timeout |
| `src/server/agent/mcp-registry-source.ts` | 2 | request timeout |
| `src/server/agent/pi-extension-discovery.ts` | 2 | discovery timeout |
| `src/server/agent/plan-mutation-store.ts` | 2 | sweep interval |
| `src/server/agent/profiling.ts` | 1 | profiling flush |
| `src/server/agent/project-sandbox.ts` | 3 | health monitor |
| `src/server/agent/provider-bridge-extension.ts` | 2 | request timeout |
| `src/server/agent/review-model-override.ts` | 1 | sleep helper |
| `src/server/agent/rpc-bridge.ts` | 10 | RPC request/ping/kill timers |
| `src/server/agent/session-manager.ts` | 32 | purge, heartbeat, grants, auto-retry, waits |
| `src/server/agent/session-setup.ts` | 4 | retry/timeout waits |
| `src/server/agent/session-store.ts` | 4 | debounced persistence |
| `src/server/agent/spawn-tree.ts` | 6 | kill escalation and timeout |
| `src/server/agent/staff-trigger-engine.ts` | 3 | trigger poll |
| `src/server/agent/team-manager.ts` | 21 | stuck sweep and idle/no-worker nudges |
| `src/server/agent/verification-harness.ts` | 21 | command waits, cancellation sync, heartbeat |
| `src/server/auth/cookie.ts` | 0 | injected wall clock for signed expiry/renewal only; no timers or persistence I/O after the stateless-cookie migration |
| `src/server/auth/oauth.ts` | 3 | flow cleanup |
| `src/server/exec-file-safe.ts` | 1 | retry delay helper |
| `src/server/extension-host/action-dispatcher.ts` | 3 | request timeout |
| `src/server/extension-host/channel-module-host.ts` | 8 | request/control timeouts |
| `src/server/extension-host/channel-pty-helper.ts` | 3 | kill fallback |
| `src/server/extension-host/channel-registry.ts` | 6 | idle sweep and request timeout |
| `src/server/extension-host/module-host-worker.ts` | 2 | worker request timeout |
| `src/server/extension-host/pack-store.ts` | 4 | replace timeout/delay |
| `src/server/extension-host/route-dispatcher.ts` | 3 | route timeout |
| `src/server/mcp/mcp-client.ts` | 16 | MCP request/kill/reload timers |
| `src/server/mcp/mcp-manager.ts` | 6 | startup/reload timeouts |
| `src/server/pr-walkthrough/git-changeset.ts` | 3 | git timeout |
| `src/server/preview/mount.ts` | 2 | preview debounce |
| `src/server/replay-pacing.ts` | 1 | replay sleep |
| `src/server/search/flex-store.ts` | 2 | save debounce |
| `src/server/search/indexer.ts` | 2 | progress debounce |
| `src/server/search/search-service.ts` | 3 | rebuild debounce |
| `src/server/server.ts` | 13 | cleanup, progress, SSE heartbeats, shutdown |
| `src/server/skills/worktree-setup.ts` | 3 | command timeout wrapper |
| `src/server/ws/handler.ts` | 3 | auth timeout |

Test handle: `manualClock.advance(ms)` drains due timers in deterministic order and returns after all callbacks scheduled for or before the target time have run. Re-entrant timers scheduled during an advance are run if their due time is within the advanced window.

### 1.2 CommandRunner seam audit

Audit commands used:

```bash
git grep -n -E 'execFile|execFileAsync|execFileSafe|execGitSafe|execGitArgsSafe' -- 'src/server/*.ts' 'src/server/**/*.ts'
git grep -n -E 'execFileSync|spawn\(' -- 'src/server/*.ts' 'src/server/**/*.ts'
```

The broad exec/spawn audit found **29 `execFile*` files** and **14 `spawn(` files**. Most are intentionally not in scope because they launch user shell commands, MCP servers, extension workers, or Bobbit agent subprocesses. The CommandRunner seam covers every direct `git`, `gh`, or `docker` chokepoint. This amends the goal spec by adding files the grep proved contain direct `git`/`gh`/`docker` calls outside the initial list.

Final CommandRunner files:

| File | Commands covered | Rationale / amendment |
|---|---|---|
| `src/server/agent-dir-config.ts` | `git rev-parse --show-toplevel` | added; direct git discovery |
| `src/server/agent/docker-args.ts` | `git config --global` | in goal list |
| `src/server/agent/goal-manager.ts` | `git push` | in goal list |
| `src/server/agent/host-tokens.ts` | `gh auth token` | added; gh must be structurally blocked in v2 |
| `src/server/agent/marketplace-install.ts` | `git` clone/fetch style pack operations | added; external git path |
| `src/server/agent/project-sandbox.ts` | `docker`, `docker exec git`, `git clone` in container | in goal list |
| `src/server/agent/sandbox-clone-source.ts` | `git init`, `checkout`, `add`, `commit`, `check-ref-format` | added; sandbox clone source preparation |
| `src/server/agent/sandbox-status.ts` | `docker build/info/inspect` | added; docker availability/build path |
| `src/server/agent/session-manager.ts` | `docker`, `git`, `gh` | added; cleanup, archive, PR merge, sandbox repair |
| `src/server/agent/staff-manager.ts` | `git fetch/rebase` | added; staff branch maintenance |
| `src/server/agent/staff-trigger-engine.ts` | `git` schedule trigger checks | added; git trigger polling |
| `src/server/agent/task-manager.ts` | `git rev-parse HEAD` | added; task HEAD capture |
| `src/server/agent/team-manager.ts` | `git show-ref`, `git rev-parse` | added; team merge/HEAD checks |
| `src/server/agent/verification-harness.ts` | `git`, `docker`, spawned docker killer | in goal list |
| `src/server/agent/worktree-inventory.ts` | `git worktree`, `branch`, `push --delete` | in goal list |
| `src/server/agent/worktree-pool.ts` | `git worktree`, sync and async git | in goal list |
| `src/server/agent/worktree-sweeper.ts` | `git worktree` cleanup | in goal list |
| `src/server/pr-walkthrough/git-changeset.ts` | `git` via `execFileSafe` and `spawn` | in goal list |
| `src/server/pr-walkthrough/github-adapter.ts` | `git`, `gh` | added; PR adapter direct CLI path |
| `src/server/pr-walkthrough/routes.ts` | `git diff/rev-parse` | added; local PR walkthrough route |
| `src/server/pr-walkthrough/walkthrough-agent-manager.ts` | `git remote get-url` | added; origin inference |
| `src/server/server.ts` | `execGitSafe`, `execGitArgsSafe`, direct `git`/`gh`/`docker` helpers | in goal list |
| `src/server/skills/git-status-native.ts` | `git`, `docker exec git` | in goal list |
| `src/server/skills/git.ts` | all shared git helpers | in goal list |
| `src/server/skills/worktree-setup.ts` | setup command timeout wrapper; npm install policy | in goal list |

Not routed through CommandRunner: `agent/shell-util.ts`, `agent/bg-process-manager.ts`, `agent/orchestration-core.ts`, `agent/rpc-bridge.ts`, `agent/spawn-tree.ts`, `mcp/mcp-client.ts`, extension-host worker/pty launchers, `harness.ts`, and `watchdog.ts`. They launch user-requested processes, MCP/extension/agent subprocesses, or dev tooling rather than git/gh/docker chokepoints; v2 tests keep them disabled, mocked, or in the daily lane unless a test explicitly targets process fidelity.

### 1.3 fetchImpl seam audit

Audit command:

```bash
git grep -n -E 'fetch[[:space:]]*\\(' -- 'src/server/*.ts' 'src/server/**/*.ts'
```

Result: **27 matches in 9 files**. This matches the goal spec exactly.

| File | Matches | Notes |
|---|---:|---|
| `src/server/agent/google-code-assist-provider-extension.ts` | 2 | gateway callback + provider request |
| `src/server/agent/google-code-assist.ts` | 1 | provider request path |
| `src/server/agent/image-generation.ts` | 5 | image provider requests and URL probes |
| `src/server/agent/name-generator.ts` | 2 | title/name provider request and retry |
| `src/server/agent/provider-bridge-extension.ts` | 1 | gateway callback |
| `src/server/agent/title-generator.ts` | 7 | model discovery and LLM providers |
| `src/server/auth/desec.ts` | 1 | DNS update |
| `src/server/auth/oauth.ts` | 6 | token/userinfo/revoke calls |
| `src/server/server.ts` | 2 | AI gateway model/chat proxy checks |

Test default: `fencedFetch` rejects every URL whose hostname is not loopback (`localhost`, `127.0.0.0/8`, `::1`, `[::1]`) unless the test installs an explicit response fixture. Rejection happens before DNS resolution.
### 1.4 agentBridgeFactory seam

Current source audit: `src/server/agent/rpc-bridge.ts` defines `RpcBridgeFactory` and the module global `registerRpcBridgeFactory(factory)`. v2 promotes that factory to `GatewayDeps.agentBridgeFactory` so `createGateway` passes it to session/runtime construction. `registerRpcBridgeFactory` remains as a deprecated compatibility alias until switchover; the new harness never calls the global setter.

### 1.5 Store/config fsImpl seam

Final `fsImpl` list. Each class already takes a directory path and performs local JSON/YAML/NDJSON IO, so constructor DI is low-risk and test-only store units can run on memfs.

| Class / file | Constructor today | IO shape | Decision |
|---|---|---|---|
| `GoalStore` — `src/server/agent/goal-store.ts` | `constructor(stateDir: string)` | JSON load/save under state dir | add `fsImpl` |
| `SessionStore` — `src/server/agent/session-store.ts` | `constructor(stateDir: string)` | JSON, backups, atomic write, transcript scan | add `fsImpl`; goal spec path `agent/store` resolves to this file |
| `GateStore` — `src/server/agent/gate-store.ts` | `constructor(stateDir: string)` | JSON load/save | add `fsImpl` |
| `InboxStore` — `src/server/agent/inbox-store.ts` | `constructor(stateDir: string)` | per-staff JSON files | add `fsImpl` |
| `PlanMutationStore` — `src/server/agent/plan-mutation-store.ts` | `constructor(stateDir: string, opts?)` | JSON files plus sweep timer | add `fsImpl`; `Clock` also injected |
| `PrStatusStore` — `src/server/agent/pr-status-store.ts` | `constructor(stateDir: string)` | JSON cache | add `fsImpl` |
| `PreferencesStore` — `src/server/agent/preferences-store.ts` | `constructor(stateDir: string)` | JSON preferences | add `fsImpl` |
| `MarketplaceSourceStore` — `src/server/agent/marketplace-source-store.ts` | `constructor(configDir: string)` | YAML config | add `fsImpl` |
| `ContextTraceStore` — `src/server/agent/context-trace-store.ts` | `constructor(stateDir: string)` | append/read/compact NDJSON | add `fsImpl` |
| `CostTracker` — `src/server/agent/cost-tracker.ts` | `constructor(stateDir: string)` | JSON cost ledger | add `fsImpl` |
| `ProjectConfigStore` — `src/server/agent/project-config-store.ts` | `constructor(configDir: string)` | YAML project config | add `fsImpl` |
| `ReviewAnnotationStore` — `src/server/review-annotation-store.ts` | `constructor(private stateDir: string)` | per-session JSON annotations | add `fsImpl` |

Other stores remain out of this phase unless a migrated test needs them; the goal's exact memfs scope is determinism for existing directory-owned stores, not full fs DI across all server IO.

### 1.6 Seam contract tests

Contract tests to add under `tests2/`:

- `tests2/core/gateway-deps-default-real.test.ts`: constructing `createGateway(config)` without deps uses real timer functions, Node command runner, global fetch, and default child-process bridge behavior.
- `tests2/core/cli-real-deps.test.ts`: static/source contract that `src/server/cli.ts` calls `createGateway(config)` with no deps and imports no v2 test doubles.
- `tests2/core/command-runner-fence.test.ts`: rejects disallowed `git push/fetch/clone/ls-remote`, all `gh`, and all docker without a fake ContainerRuntime map; allows local/file remotes.
- `tests2/core/fetch-fence.test.ts`: rejects non-loopback hosts before DNS; allows loopback and explicit response fixtures.
- `tests2/core/store-fsimpl-contract.test.ts`: each listed store works with memfs and defaults to Node fs when omitted.
- `tests2/integration/gateway-fixture-leak.test.ts`: deliberate-leak negative test for the fixture leak detector.

### 1.7 Env flags at switchover (accepted CLI-boundary exception)

**Accepted deviation (settled with the user):** full deletion of the env→flag bridge was NOT completed at switchover. `src/server/legacy-test-runtime-flags.ts` is retained as the documented CLI-boundary / operator-feature bridge — it feeds `GatewayConfig` fields and still serves operator features (`qa_start_command`'s `BOBBIT_LLM_REVIEW_SKIP`/`BOBBIT_SKIP_NPM_CI`, and `scripts/bench-server-cpu.mjs`). The table below records the *intended* end-state per flag; the bridge that reads them is the accepted exception. Fully eliminating it (convert to `GatewayConfig`/CLI options + migrate the operator consumers) is a tracked follow-up. `cli-real-deps.test.ts` pins the narrower live contract (the CLI injects no test doubles / harness fences).

Audit command over `src/server src/app src/ui` found these files still reference test-only env behavior: `aigw-manager.ts`, `profiling.ts`, `project-assistant.ts`, `session-eager-branch-delete.ts`, `title-generator.ts`, `verification-harness.ts`, `pr-walkthrough/export-mapper.ts`, `pr-walkthrough/github-adapter.ts`, `replay-pacing.ts`, `server.ts`, `skills/git.ts`, and `skills/worktree-setup.ts`.

| Env flag | Switchover outcome |
|---|---|
| `BOBBIT_TEST_NO_PUSH` | deleted; CommandRunner remote fence structurally blocks non-local push |
| `BOBBIT_TEST_NO_REMOTE` | deleted; CommandRunner remote fence blocks non-local fetch/ls-remote/clone |
| `BOBBIT_TEST_NO_EXTERNAL` | deleted; `fetchImpl` and CommandRunner fences block external network/CLI |
| `BOBBIT_SKIP_MCP` | converted to explicit `GatewayConfig.mcp.enabled: false` operator/test option |
| `BOBBIT_SKIP_WORKTREE_POOL` | converted to `GatewayConfig.worktreePool.enabled/prefill` |
| `BOBBIT_SKIP_AIGW_DISCOVERY` | converted to `GatewayConfig.aigwDiscovery.enabled` |
| `BOBBIT_SKIP_TITLE_GEN` | converted to `GatewayConfig.titleGeneration.enabled` |
| `BOBBIT_SKIP_NPM_CI` | deleted; `CommandRunner`/worktree setup policy supplies fake or explicit setup behavior |
| `BOBBIT_LLM_REVIEW_SKIP` | deleted; verification tests inject llm-review fakes through deps |
| `BOBBIT_E2E` | deleted; behavior becomes explicit config/deps or normal production path |

`NODE_ENV === "test"` conditionals in `src/` are minimized; two remain as part of the accepted CLI-boundary exception — `cli.ts` (suppress auto-opening a browser) and `gate-diagnostics.ts` (log-retention behavior). These are documented and accepted at switchover; removing them is part of the tracked follow-up.

## 2. Tier-1 harness

`tests2/harness/gateway.ts` is a vitest fixture that boots one gateway per fork from `src/server/server.js`, mirroring the durable parts of `tests/e2e/in-process-harness.ts` while removing env flags.

Worker setup:

1. Create a unique temp `BOBBIT_DIR` outside any git repo. On Windows, default to an OS temp root that avoids repo-relative git false positives and Defender-heavy project paths.
2. Seed `state/projects.json`, `state/setup-complete`, default preferences, and test workflows exactly as the current harness does.
3. Import `setProjectRoot`, `scaffoldBobbitDir`, `loadOrCreateToken`, and `createGateway` from `src/`, not `dist/`.
4. Call `createGateway(config, deps)` with `manualClock`, fenced `CommandRunner`, fenced `fetchImpl`, and in-process mock `agentBridgeFactory`.
5. Start on `host: "127.0.0.1"`, `port: 0`, `portExplicit: true` to avoid auto-increment loops.
6. Register the default project through the API and seed workflows, preserving the current self-healing default-project contract.

`scope()` cleanup contract:

- Every test receives `scope()` and creates sessions/goals/projects through scoped helpers.
- Scope records entity IDs as they are created.
- `afterEach` dismisses/stops live sessions, deletes goals, deletes projects, clears pending bg waits, restores the default project, and drains clock timers that the cleanup itself scheduled.
- Cleanup is idempotent and bounded-retry for Windows file locks.
- Fixture snapshots entity counts at file start/end; any unowned delta is a hard failure. `tests2/integration/gateway-fixture-leak.test.ts` deliberately leaks an entity and asserts the detector fails.

Env mutation:

- Vitest fork workers run test files sequentially within a fork, so env-mutating migrated files use `withEnv(patch, fn)`.
- `withEnv` snapshots existing values, applies the patch, runs `fn`, and restores in `finally`, including deletion-vs-empty distinction.
- The codemod emits `needs-withEnv` for files that mutate `process.env`.
- Stragglers that cannot safely share a worker move to a dedicated Vitest project with `maxWorkers:1` and `isolate:true`. Exit criterion at switchover: ≤10 files, each tracked in `tests2/tests-map.json` with a reason and owner.

## 3. Fenced CommandRunner and fetch rules

Fail-closed means the default v2 test doubles reject unknown behavior unless the test explicitly installs a fixture.

Command predicate:

- Normalize executable basename case-insensitively and strip `.exe`, `.cmd`, `.bat` on Windows.
- `gh`: always rejected in v2 tests. Tests that need GitHub behavior use API/CLI fixture responses.
- `docker` / `podman`: rejected unless the test supplies a fake ContainerRuntime response map for the exact argv signature.
- `git push`, `git fetch`, `git clone`, and `git ls-remote`: inspect the remote operand before execution.
  - A remote is allowed if it is a `file://` URL.
  - A remote name such as `origin` is resolved with local config (`git config --get remote.<name>.url`) and then checked.
  - A path is allowed if it has no URL scheme, is not scp-like (`host:path` or `user@host:path`), resolves under the test temp area or to an explicitly registered local bare repo, and exists as a local git repository/bare repository.
  - HTTP(S), SSH, `git://`, scp-like, and unresolved remote names are rejected.
- Non-network local git commands (`rev-parse`, `status`, `diff`, `worktree`, local `branch`, local `commit-tree`) run against real git, preserving worktree fidelity.

Fetch predicate:

- Parse every input as a URL before calling `fetchImpl`.
- Allow loopback only: `localhost`, `127.0.0.0/8`, `::1`, `[::1]`.
- Reject all other hosts before DNS lookup.
- Allow non-loopback only when the test registers an exact URL fixture; unmatched requests still fail.

## 4. Codemod mapping table

`scripts/testing-v2/codemod.mjs` copies legacy tests into `tests2/`; it never moves or edits legacy files. It is idempotent and emits a per-file report: `clean`, `needs-withEnv`, or `needs-manual`.

| Legacy pattern | v2 output | Notes |
|---|---|---|
| `import { test, describe, before, after, beforeEach, afterEach, mock } from "node:test"` | `import { describe, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"` | `test()` maps to `it()` unless the surrounding style keeps `test` alias for readability |
| `before(...)` | `beforeAll(...)` | node:test lifecycle parity |
| `after(...)` | `afterAll(...)` | node:test lifecycle parity |
| `mock.fn`, `mock.method`, `mock.module`, `mock.timers`, `mock.restoreAll` | `vi.*` where 1:1; otherwise `needs-manual` | manual review required for module mocks, timer mocks, getters/setters, `mock.method` restore semantics, `mock.reset`, `mock.mocked`, and any reliance on node:test call-tracking shapes |
| `t.skip(...)`, `t.todo(...)` | `it.skip(...)`, `it.todo(...)` | preserves skipped/todo status |
| `node:assert/strict` | unchanged | assert API stays stable |
| imports from `dist/server/**` | imports from `src/server/**` | tier-1 imports source; no build prerequisite |
| `mkdtemp` store-only patterns | optional memfs fixture | only for final fsImpl store list; gateway fixture keeps real temp dirs |
| direct `process.env` mutation | wrap in `withEnv()` | report as `needs-withEnv` |
| fixture/browser `.spec.ts` without geometry | rewrite to happy-dom helpers | tracked as `rewrite`, not mechanical codemod |

## 5. Tier-2 browser journeys and Chromium keep-list

Inventory reconciliation: `tests2/tests-map.json` defines **31 journeys**, maps **153 retired non-geometry browser-E2E specs** to at least one journey, and keeps **62 browser-fidelity specs** as Chromium adapters. Together these account for the `v2-browser` bucket count of 215 (`153 + 62`).


### `journey-session-lifecycle` — Session create / actions / status / fork / navigate (2)
- `tests/e2e/ui/fork-session-history.spec.ts`
- `tests/e2e/ui/tail-chat-session-navigate.spec.ts`

### `journey-crash-restart` — Gateway crash, restart, reconnect, resilience, persistence-across-reload (5)
- `tests/e2e/ui/dormant-revive-live-reply.spec.ts`
- `tests/e2e/ui/preparing-ux.spec.ts`
- `tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts`
- `tests/e2e/ui/session-created-push-sync.spec.ts`
- `tests/e2e/ui/session-status-recovery.spec.ts`

### `journey-goal-team-gates-verification` — Goal creation → team → gates → verification dashboard (1)
- `tests/e2e/ui/plan-tab-gate-status.spec.ts`

### `journey-goal-editing` — Goal edit modal / form / tabs / metadata / role wiring (5)
- `tests/e2e/ui/goal-archive-always-on.spec.ts`
- `tests/e2e/ui/goal-creation.spec.ts`
- `tests/e2e/ui/goal-empty-workflows-banner.spec.ts`
- `tests/e2e/ui/goal-form-tooltips.spec.ts`
- `tests/e2e/ui/goal-metadata.spec.ts`

### `journey-subgoals` — Subgoal creation, nesting limits, parent picker, experimental toggle (4)
- `tests/e2e/ui/subgoal-existing-goal-settings.spec.ts`
- `tests/e2e/ui/subgoal-nesting-limit.spec.ts`
- `tests/e2e/ui/subgoal-parent-picker-repro.spec.ts`
- `tests/e2e/ui/subgoals-experimental-toggle.spec.ts`

### `journey-project-onboarding` — Add-project flows, project management, splash, remove-project (13)
- `tests/e2e/ui/add-project-browse-modal.spec.ts`
- `tests/e2e/ui/add-project-multi-repo-subset.spec.ts`
- `tests/e2e/ui/add-project-post-archive.spec.ts`
- `tests/e2e/ui/add-project-preflight.spec.ts`
- `tests/e2e/ui/add-project-select-all.spec.ts`
- `tests/e2e/ui/add-project-symlink.spec.ts`
- `tests/e2e/ui/add-project-typeahead.spec.ts`
- `tests/e2e/ui/per-project-native-yaml-fields.spec.ts`
- `tests/e2e/ui/project-management.spec.ts`
- `tests/e2e/ui/remove-first-project.spec.ts`
- `tests/e2e/ui/single-project-sidebar.spec.ts`
- `tests/e2e/ui/splash-multi-project.spec.ts`
- `tests/e2e/ui/splash-no-projects.spec.ts`

### `journey-project-settings` — Settings cascade, system-prompt, agent-dir, model fallback, maintenance (5)
- `tests/e2e/ui/settings-agent-dir.spec.ts`
- `tests/e2e/ui/settings-maintenance-archived-worktrees.spec.ts`
- `tests/e2e/ui/settings-model-fallback.spec.ts`
- `tests/e2e/ui/settings-restart-button.spec.ts`
- `tests/e2e/ui/system-prompt-customise.spec.ts`

### `journey-project-assistant` — Project/role assistant, saved state, reattempt/binding recovery (4)
- `tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts`
- `tests/e2e/ui/goal-reattempt-project-binding.spec.ts`
- `tests/e2e/ui/project-assistant.spec.ts`
- `tests/e2e/ui/role-assistant-new.spec.ts`

### `journey-proposals` — Goal/project proposal panel flows, revisions, dismiss/reload (12)
- `tests/e2e/ui/failed-goal-proposal-ux.spec.ts`
- `tests/e2e/ui/goal-proposal-dismiss-reload.spec.ts`
- `tests/e2e/ui/goal-proposal-invalid-workflow.spec.ts`
- `tests/e2e/ui/goal-proposal-offscreen-return.spec.ts`
- `tests/e2e/ui/goal-proposal-revision-autoupdate.spec.ts`
- `tests/e2e/ui/goal-proposal-subgoal-prefill.spec.ts`
- `tests/e2e/ui/goal-proposal-workflow-tab.spec.ts`
- `tests/e2e/ui/mid-session-project-proposal.spec.ts`
- `tests/e2e/ui/proposal-edit-flow.spec.ts`
- `tests/e2e/ui/proposal-open-all-types.spec.ts`
- `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`
- `tests/e2e/ui/proposal-tools.spec.ts`

### `journey-sidebar-nav-search-keyboard` — Sidebar navigation, filters, search, keyboard nav, resize (21)
- `tests/e2e/ui/search-e2e.spec.ts`
- `tests/e2e/ui/search-result-navigation.spec.ts`
- `tests/e2e/ui/sidebar-archived-delegates-e2e.spec.ts`
- `tests/e2e/ui/sidebar-archived-layout.spec.ts`
- `tests/e2e/ui/sidebar-archived-per-project.spec.ts`
- `tests/e2e/ui/sidebar-archived-search-repro.spec.ts`
- `tests/e2e/ui/sidebar-child-loading.spec.ts`
- `tests/e2e/ui/sidebar-filters.spec.ts`
- `tests/e2e/ui/sidebar-goal-group-filters.spec.ts`
- `tests/e2e/ui/sidebar-goal-staff.spec.ts`
- `tests/e2e/ui/sidebar-keyboard-nav.spec.ts`
- `tests/e2e/ui/sidebar-mobile-archived-per-project.spec.ts`
- `tests/e2e/ui/sidebar-mobile-archived-search.spec.ts`
- `tests/e2e/ui/sidebar-navigation.spec.ts`
- `tests/e2e/ui/sidebar-refresh-agent.spec.ts`
- `tests/e2e/ui/sidebar-search-filter.spec.ts`
- `tests/e2e/ui/sidebar-session-actions.spec.ts`
- `tests/e2e/ui/sidebar-spawned-children-dedupe.spec.ts`
- `tests/e2e/ui/sidebar-staff-loading.spec.ts`
- `tests/e2e/ui/sidebar-tree-restart.spec.ts`
- `tests/e2e/ui/sidebar-unified-tree.spec.ts`

### `journey-marketplace-packs` — Marketplace, pack install/activation, skills, extension host (8)
- `tests/e2e/ui/artifacts-pack.spec.ts`
- `tests/e2e/ui/extension-host.spec.ts`
- `tests/e2e/ui/market-activation.spec.ts`
- `tests/e2e/ui/marketplace-conflicts.spec.ts`
- `tests/e2e/ui/marketplace-mcp.spec.ts`
- `tests/e2e/ui/marketplace.spec.ts`
- `tests/e2e/ui/skill-multifile.spec.ts`
- `tests/e2e/ui/skills-chip.spec.ts`

### `journey-pr-walkthrough` — PR-walkthrough panel and pack (0)
- No retired legacy spec maps here yet; retained as required smoke journey.

### `journey-prompt-interaction` — Prompt send, at-mention, queue, steer/abort, tool/skill policy (11)
- `tests/e2e/ui/ask-user-choices-ui.spec.ts`
- `tests/e2e/ui/at-mention.spec.ts`
- `tests/e2e/ui/escape-aborts-anywhere.spec.ts`
- `tests/e2e/ui/queue-ui.spec.ts`
- `tests/e2e/ui/session-interactions.spec.ts`
- `tests/e2e/ui/session-prompt-grant-replay.spec.ts`
- `tests/e2e/ui/steer-during-bash-tool-abort-toolend.spec.ts`
- `tests/e2e/ui/steer-during-bash-tool-busy-race.spec.ts`
- `tests/e2e/ui/steer-during-bash-tool.spec.ts`
- `tests/e2e/ui/tool-ask-policy.spec.ts`
- `tests/e2e/ui/tool-assistant-system-scope.spec.ts`

### `journey-preview-artifacts` — Preview panel, artifacts, image attach/model selection (3)
- `tests/e2e/ui/image-attach-roundtrip.spec.ts`
- `tests/e2e/ui/image-model-selector-lock.spec.ts`
- `tests/e2e/ui/preview-happy-path.spec.ts`

### `journey-mobile-layout` — Mobile layout smoke, mobile tabs, PWA lifecycle (1)
- `tests/e2e/ui/mobile-staff-sidebar.spec.ts`

### `journey-notification-policy` — Notification policy, unseen activity, auto-retry, error modal (4)
- `tests/e2e/ui/api-error-modal.spec.ts`
- `tests/e2e/ui/auto-retry-banner.spec.ts`
- `tests/e2e/ui/notification-policy.spec.ts`
- `tests/e2e/ui/unseen-activity.spec.ts`

### `journey-bg-wait-steer` — Background-process wait/steer flows and persistence (4)
- `tests/e2e/ui/bg-process-persistence.spec.ts`
- `tests/e2e/ui/bg-wait-no-dup.spec.ts`
- `tests/e2e/ui/bg-wait-steer-flow.spec.ts`
- `tests/e2e/ui/bg-wait-steer-stop-flow.spec.ts`

### `journey-compaction` — Compaction, pre-compaction history, persistence (2)
- `tests/e2e/ui/compact-cost.spec.ts`
- `tests/e2e/ui/compaction-persistence.spec.ts`

### `journey-cost-tracking` — Cost popover/cache, tree cost rollup, prompt stats (3)
- `tests/e2e/ui/cost-popover-cache-hit.spec.ts`
- `tests/e2e/ui/prompt-stats-e2e.spec.ts`
- `tests/e2e/ui/tree-cost-rollup.spec.ts`

### `journey-staff` — Staff sidebar, roles, triggers, inbox, accessories, indicators (5)
- `tests/e2e/ui/staff-accessory.spec.ts`
- `tests/e2e/ui/staff-role.spec.ts`
- `tests/e2e/ui/staff-sandbox-indicator.spec.ts`
- `tests/e2e/ui/staff-sub-section.spec.ts`
- `tests/e2e/ui/staff-triggers.spec.ts`

### `journey-workflow-editor` — Workflow editor/page, optional steps, gate status/bypass (4)
- `tests/e2e/ui/gate-bypass.spec.ts`
- `tests/e2e/ui/optional-steps.spec.ts`
- `tests/e2e/ui/workflow-editor.spec.ts`
- `tests/e2e/ui/workflow-page-scope.spec.ts`

### `journey-stories-registry` — Story-registry driven UI stories smoke (7)
- `tests/e2e/ui/stories-drafts.spec.ts`
- `tests/e2e/ui/stories-goal-routing.spec.ts`
- `tests/e2e/ui/stories-projects.spec.ts`
- `tests/e2e/ui/stories-resilience.spec.ts`
- `tests/e2e/ui/stories-sessions.spec.ts`
- `tests/e2e/ui/stories-sidebar.spec.ts`
- `tests/e2e/ui/stories-streaming.spec.ts`

### `journey-dashboard-fanout` — Goal dashboard fanout, mutation-pending, status widgets, progress (4)
- `tests/e2e/ui/dashboard-mutation-pending.spec.ts`
- `tests/e2e/ui/goal-dashboard-fanout.spec.ts`
- `tests/e2e/ui/goal-status-widget.spec.ts`
- `tests/e2e/ui/verification-progress-indicator.spec.ts`

### `journey-review-commenting` — Review pane, inline comments, mobile review commenting (1)
- `tests/e2e/ui/review-pane.spec.ts`

### `journey-multi-repo` — Multi-repo flow and per-repo git status (3)
- `tests/e2e/ui/git-status-untracked-race.spec.ts`
- `tests/e2e/ui/multi-repo-flow.spec.ts`
- `tests/e2e/ui/session-git-status-multi-repo.spec.ts`

### `journey-session-sharing` — Copy/open session link, new window/tab, page title, palette (5)
- `tests/e2e/ui/copy-session-link.spec.ts`
- `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts`
- `tests/e2e/ui/open-session-new-window.spec.ts`
- `tests/e2e/ui/page-title.spec.ts`
- `tests/e2e/ui/palette-session.spec.ts`

### `journey-debug-tools` — Debug-mode toggle, instant loader, tool renderers, text replace (4)
- `tests/e2e/ui/children-tool-renderers.spec.ts`
- `tests/e2e/ui/debug-mode-toggle.spec.ts`
- `tests/e2e/ui/instant-loader.spec.ts`
- `tests/e2e/ui/replace-bobbit-text.spec.ts`

### `journey-dynamic-panels` — Side/dynamic panel tabs, tab wiring (1)
- `tests/e2e/ui/goal-role-tabs-wiring.spec.ts`

### `journey-headquarters` — Headquarters view and staff inbox (1)
- `tests/e2e/ui/headquarters.spec.ts`

### `journey-team-delegate` — Team delegate, child cascade/loading, archived children (4)
- `tests/e2e/ui/archive-child-cascade.spec.ts`
- `tests/e2e/ui/plan-archived-children.spec.ts`
- `tests/e2e/ui/plan-tab-archived-children.spec.ts`
- `tests/e2e/ui/team-delegate.spec.ts`

### `journey-app-smoke` — General application smoke (catch-all for cross-cutting UI specs) (6)
- `tests/e2e/ui/base-ref-detect.spec.ts`
- `tests/e2e/ui/base-ref-settings.spec.ts`
- `tests/e2e/ui/draft-loss.spec.ts`
- `tests/e2e/ui/github-trusted-hosts.spec.ts`
- `tests/e2e/ui/local-only-policy-status.spec.ts`
- `tests/e2e/ui/project-palette-none.spec.ts`

### Geometry / browser-fidelity specs kept in Chromium (62)
- `tests/agent-interface-scroll-hardening.spec.ts`
- `tests/agent-interface-scroll.spec.ts`
- `tests/ask-user-choices-widget.spec.ts`
- `tests/bg-process-pills.spec.ts`
- `tests/bg-process-popover.spec.ts`
- `tests/canvas-eye-getanimations.spec.ts`
- `tests/collapse-scroll-bugs.spec.ts`
- `tests/default-tool-renderer.spec.ts`
- `tests/defer-offscreen-render.spec.ts`
- `tests/e2e/ui/add-project-flow.spec.ts`
- `tests/e2e/ui/add-project-footer-stability.spec.ts`
- `tests/e2e/ui/archived-blob.spec.ts`
- `tests/e2e/ui/archived-session-actions.spec.ts`
- `tests/e2e/ui/dynamic-chat-tabs.spec.ts`
- `tests/e2e/ui/gate-status-cross-surface.spec.ts`
- `tests/e2e/ui/goal-edit-modal.spec.ts`
- `tests/e2e/ui/goal-tabs-wiring.spec.ts`
- `tests/e2e/ui/jump-to-last-prompt.spec.ts`
- `tests/e2e/ui/mobile-review-commenting.spec.ts`
- `tests/e2e/ui/pill-overflow-promotion.spec.ts`
- `tests/e2e/ui/pr-walkthrough-pack.spec.ts`
- `tests/e2e/ui/pre-compaction-history.spec.ts`
- `tests/e2e/ui/preview-durable-restart.spec.ts`
- `tests/e2e/ui/project-assistant-saved-state.spec.ts`
- `tests/e2e/ui/project-drag-reorder.spec.ts`
- `tests/e2e/ui/proposal-inline-comments.spec.ts`
- `tests/e2e/ui/proposal-panel-streaming.spec.ts`
- `tests/e2e/ui/proposal-revision-snapshots.spec.ts`
- `tests/e2e/ui/pwa-lifecycle.spec.ts`
- `tests/e2e/ui/session-actions.spec.ts`
- `tests/e2e/ui/settings-mobile-tabs.spec.ts`
- `tests/e2e/ui/side-panel-tabs.spec.ts`
- `tests/e2e/ui/sidebar-actions-menu.spec.ts`
- `tests/e2e/ui/sidebar-font-scale.spec.ts`
- `tests/e2e/ui/sidebar-indent.spec.ts`
- `tests/e2e/ui/sidebar-resize.spec.ts`
- `tests/e2e/ui/staff-inbox.spec.ts`
- `tests/e2e/ui/stories-navigation.spec.ts`
- `tests/e2e/ui/tail-chat-real-stream.spec.ts`
- `tests/e2e/ui/terminal-pack.spec.ts`
- `tests/follow-tail.spec.ts`
- `tests/git-status-widget.spec.ts`
- `tests/git-widget-portal.spec.ts`
- `tests/message-editor-attach.spec.ts`
- `tests/message-editor-ime.spec.ts`
- `tests/message-editor-queue.spec.ts`
- `tests/message-editor-send.spec.ts`
- `tests/message-editor-size-guard.spec.ts`
- `tests/mobile-goal-preview.spec.ts`
- `tests/mobile-header.spec.ts`
- `tests/mobile-review-annotation.spec.ts`
- `tests/mobile-scroll-keyboard.spec.ts`
- `tests/pack-entrypoints-reconcile.spec.ts`
- `tests/pr-walkthrough-panel-parity.spec.ts`
- `tests/scroll-anchor-shrink.spec.ts`
- `tests/sidebar-bobbit-datauri-cache.spec.ts`
- `tests/streaming-bobbit-canvas-ref.spec.ts`
- `tests/ui-fixtures/chat-scroll.spec.ts`
- `tests/ui-fixtures/dynamic-panel-workspace-fixture.spec.ts`
- `tests/ui-fixtures/preview-panel.spec.ts`
- `tests/ui-fixtures/sidebar-actions-menu-fixture.spec.ts`
- `tests2/browser/fixtures/verification-dedup.spec.ts`

## 6. Budget arithmetic, full-run CPU enforcement, and atomic ledger

Budget targets live in `tests2/budgets.json` and are hard caps, not projections:

- Tier 1 (`vitest` core + dom + integration): ≤100 s wall, ≤7.5 CPU-min.
- Tier 2 (`playwright-v2` browser): ≤120 s wall, ≤5.5 CPU-min.
- Full `npm run test:v2`: ≤180 s wall, ≤13.0 CPU-min.

The tier CPU caps intentionally sum to the full cap (`7.5 + 5.5 = 13.0`). A full run is not allowed to pass by satisfying two looser tier caps; `scripts/testing-v2/assert-budget.mjs --scope full` measures the actual process-tree CPU consumed by the whole `npm run test:v2` invocation and fails above 13.0 CPU-min.

Projected tier-1 cost:

| Project | Files | Dominant cost removed | Projected wall | Projected CPU |
|---|---:|---|---:|---:|
| `v2-core` | 499 | node:test per-file `tsx` spawn/transform | 20-30 s | 1.5-2.0 CPU-min |
| `v2-dom` | 151 | Chromium for non-geometry fixtures | 15-25 s | 0.8-1.2 CPU-min |
| `v2-integration` | 198 | gateway per test file; now one source gateway per fork | 55-75 s | 3.5-4.3 CPU-min |
| Tier-1 total | 848 | shared transform + shared gateway | ≤100 s | ≤7.5 CPU-min |

Projection basis: the D1 spike measured a 12-test file at ~12 ms under vitest versus ~2.5 s under `tsx --test`; the D3 spike measured source server graph transform at ~9 s cold / ~6 s warm once per worker, amortized across integration files. If eight workers boot gateways, transform/boot is paid per fork, not per file.

Projected tier-2 cost:

| Suite | Count | Projected wall | Projected CPU |
|---|---:|---:|---:|
| Chromium adapters kept for geometry/browser fidelity | 62 specs | 50-70 s | 2.2-3.1 CPU-min |
| Consolidated smoke journeys | 31 journeys | 45-65 s | 1.8-2.4 CPU-min |
| Tier-2 total | 93 Playwright specs/journeys | ≤120 s | ≤5.5 CPU-min |

`test:v2` orchestration runs tier 1 and tier 2 as registered child runners. The full-run wall target is not the sum of tier walls because the children overlap when the ledger grants capacity; it is capped at 180 s. CPU target is additive and measured directly: no shared-work or overlap deduction is credited unless the process-tree sampler observes lower CPU time in the full invocation.

### 6.1 `assert-budget.mjs` CPU measurement contract

`scripts/testing-v2/assert-budget.mjs` consumes runner JSON reports for wall time, but CPU enforcement comes from a direct process-tree sampler started by the parent command:

1. `npm run test:v2` launches `node scripts/testing-v2/run-v2.mjs`, which starts the sampler before spawning tier children.
2. The sampler records the root PID, descendant PIDs, and per-process user+system CPU from the platform APIs already used by `scripts/metrics/`; on Windows it samples process times via CIM/PowerShell, and on POSIX it samples `/proc` or `ps`.
3. Sampling continues until every descendant exits; final CPU is the monotonic sum of observed user+system deltas plus exit snapshots for short-lived children.
4. `assert-budget --scope tier1` and `--scope tier2` check their tier caps; `assert-budget --scope full` checks the actual whole-run CPU against 13.0 CPU-min and fails even if both child reports individually passed.
5. Each result writes `.profiles/testing-v2/budgets/<timestamp>-<scope>.json` with `wallMs`, `cpuMs`, `rootPid`, sampled process count, worker reservations, command argv, git SHA, and the budget used. The concurrency and switchover gates attach these artifacts.

### 6.2 Atomic lockfile reservation ledger

The ledger is a reservation system, not an `activeRuns` estimator. This removes the start-stagger race where early runners see too few peers and over-allocate.

State lives under the OS temp root, e.g. `<tmp>/bobbit-test-v2-ledger/`:

- `ledger.lock` — acquired with atomic exclusive create/open (`O_CREAT|O_EXCL` / Node `fs.open(..., "wx")`). Lock acquisition retries with jitter and treats a lock as stale only if its owner PID is dead and its mtime is older than 30 s. On POSIX a losing contender sees `EEXIST`; on **Windows**, an `O_EXCL` create against a lock file that a concurrent holder is deleting/recreating surfaces as `EPERM`/`EACCES` (the NTFS *delete-pending* state) instead of `EEXIST`. `acquireLock` therefore treats all three codes as "contended — back off and retry within the timeout" rather than hard-throwing; before this, a busy shared ledger on Windows would abort the whole integration bucket on the first delete-pending race. The same guard lives in `scripts/testing-v2/ledger.mjs` and the lease-bridge probe `tests/e2e/ledger-lease-bridge.mjs`, and the timeout error now reports the last error code for diagnosis.
- `reservations.json` — authoritative shared budget: `{ totalCores, generation, reservations: [{ id, parentRunId, pid, kind, workerSlots, startedAt, heartbeatAt }] }`.
- `<id>.heartbeat` — touched every 2 s by live runners; used with PID liveness to sweep stale reservations.

Reservation algorithm, always under `ledger.lock`:

1. `run-v2.mjs` creates a parent-suite reservation before launching tier children, then waits a short coalescing window (default 1500 ms, configurable only by the concurrency-proof script) so simultaneous suites are visible before slots are assigned.
2. Sweep dead/stale reservations first.
3. Compute `remaining = totalCores - sum(active child reservation.workerSlots)`.
4. For all waiting parent-suite reservations, compute `targetParentSlots = clamp(floor(totalCores / activeParentSuites), 4, 12)`, then grant from the shared remaining-core budget while holding the lock. A parent that cannot receive the minimum 4 slots waits with jitter and retries; no tier child starts before the parent has a committed bundle.
5. Split a committed parent bundle into child reservations: 4 slots → vitest 2 + Playwright 2; 12 slots → vitest 8 + Playwright 4; intermediate bundles preserve both minima and cap vitest at 8 / Playwright at 4. The exact split is recorded in `reservations.json` before spawning children.
6. The granted child `workerSlots` become Vitest `maxWorkers` and Playwright `workers`. The parent and children remove their reservations on exit; stale reservations are swept on every read.

Because every bundle subtracts from the same persisted remaining-core budget while holding an atomic lock, `sum(child.workerSlots) <= totalCores` is an invariant even if runs start milliseconds or minutes apart. A staggered late suite may receive fewer slots or wait for a phase to finish, but it can never cause oversubscription. The concurrency proof records every reservation generation and asserts this invariant for the whole run.

For the 24-core target, five synchronized full runs settle to 20 reserved child slots: each parent sees five active suites, receives 4 slots, and splits them into vitest 2 + Playwright 2. A single full run may reserve up to 12 slots (8 vitest + 4 Playwright). If additional runs arrive while that single run is already active, they consume only remaining slots or wait; the invariant remains structural rather than arithmetic-by-assumption.

## 7. esbuild prebundle vs vitest SSR optimizer

Foundation gate decision procedure:

1. Tune vitest SSR optimizer first and measure per-fork source-server transform time for `createGateway` from `src/server/server.js`.
2. If warm per-fork transform is **≤5 s**, keep direct source imports; simpler and closer to production TypeScript graph.
3. If warm per-fork transform is **>5 s**, switch the gateway fixture to a content-hash-cached esbuild prebundle of the server graph. Target: ~1-2 s per worker after cache hit.
4. Record the measured cold/warm numbers and chosen path in the v2 foundation gate output. Do not change the decision later without a new measurement.

## Foundation measurement (Gate 4)

Measured on the 24-core dev laptop with the Gate-4A harness (vitest 3.2.6, `pool:"forks"`, `isolate:false`), booting `createGateway` from `src/` (no dist build).

**Per-fork source transform / gateway boot** (single gateway-booting file, 3 boots + assertions):

| Condition | vite transform | collect (transform + top-level graph exec) | file wall |
|---|---:|---:|---:|
| Cold (`node_modules/.vite` removed) | 1.86 s | 3.15 s | 4.02 s |
| Warm run 1 | 1.84 s | 3.10 s | 3.97 s |
| Warm run 2 | 1.83 s | 3.12 s | 3.99 s |

Cold ≈ warm: the SSR transform of the `src/server` graph dominates and is paid per fork process (~1.85 s), but is already comfortably under the R5 threshold. Vite's on-disk dep cache does not meaningfully change it because the cost is source SSR transform, not dep pre-bundling.

**Historical R5 decision:** direct source imports were retained when the graph cost was 1.85 s per fork. A later Windows profile measured approximately 11 s of transform/import work per integration worker versus approximately 0.4 s for a bundled import, crossing the threshold. The implemented unit config now prepares a content-addressed, source-mapped esbuild splitting graph directly and resolves server/high-fanout support imports through it. A PID-scoped Vitest transform cache prevents simultaneous coordinators from sharing writable cache state.

**Historical foundation run:** the early representative inventory completed in approximately 10 seconds with retries disabled. It was a migration checkpoint, not a current inventory or retry-policy claim.

**Current pool policy:** Vitest 4 removes the old worker transport constraint. `npm run test:unit` now has one coordinator and a fixed suite-wide cap of three workers; `VITEST_MAX_WORKERS` may lower that cap only. It does not call the retired unit-lane runner or reserve ledger/boot leases.

## 8. Parity proof mechanics

`scripts/testing-v2/parity.mjs` is the gate command for the parity-proof gate. It fails closed and writes `.profiles/testing-v2/parity/<timestamp>.{json,md}`.

Coverage comparison:

1. Run v2 with V8 coverage enabled for all tier-1 projects and Playwright v2 coverage collection for browser journeys/adapters.
2. Normalize paths to repo-relative source files and exclude generated/build outputs using the same filters as the refreshed baseline metrics.
3. Aggregate line and branch coverage separately for the named areas `src/server`, `src/app`, and `src/ui`.
4. Compare each area's line and branch percentages against the named baseline files in `docs/testing-metrics/` refreshed by the baseline-inventory gate. A regression in any area/metric fails the gate.
5. Emit exact numerator/denominator deltas, not only percentages, so missing files cannot be hidden by rounding.

Story-registry contract coverage:

- Port the `tools/spec-check.ts` story-registry walk into parity as a reusable module instead of shelling to the legacy checker.
- Enumerate every registered story, scenario id, required fixture, and route contract.
- Assert each registry entry is covered by a v2 DOM test, a v2 browser adapter, or one of the 31 smoke journeys listed in `tests2/tests-map.json`.
- Any new story without a v2 bucket entry fails with the missing story id and suggested bucket.

Bucket and mapping guard:

- Read `tests2/tests-map.json` and the live file tree.
- Assert every legacy test file is claimed by exactly one bucket: `v2-core`, `v2-dom`, `v2-integration`, `v2-browser`, `daily`, or `legacy-pending` before switchover.
- Assert every retired browser spec has at least one replacement journey id and every replacement path/id exists.
- From the mass-migration gate onward, assert new tests land in `tests2/` unless explicitly classified as daily or legacy-pending with a reason.

Baseline-history honesty check:

- Read git history for the named baseline files with `git log --follow -- docs/testing-metrics/...`.
- Verify the baseline commit SHA matches the baseline-inventory gate artifact or a later commit that explicitly contains `Baseline refresh` in the subject and includes the raw command output artifact.
- Fail if a baseline denominator drops, a file disappears from a named area, or percentages are lowered without an accompanying inventory/gate artifact explaining the change.
- The parity gate report includes the baseline file SHAs and the comparison commit range so review can detect bar-lowering.

## 9. Chaos comparison proof

The chaos proof is a switchover-blocking confidence check, not part of `npm run test:v2`. It consists of a curated mutant corpus, an ephemeral-worktree runner, integrity checks, reports, and a remediation loop.

### 9.1 Mutant corpus

`tests2/chaos/mutants.json` contains 50-70 curated entries. Schema:

```json
{
  "id": "workflow-dependency-invert-001",
  "area": "gate-workflow",
  "file": "src/server/agent/gate-store.ts",
  "patch": "unified diff text",
  "description": "Invert dependency satisfaction check",
  "operators": ["negated-conditional"],
  "expectedLegacyCatchers": ["tests/e2e/gates.spec.ts"],
  "expectedV2Catchers": ["tests2/integration/gates.test.ts"],
  "fullV2SampleEligible": true
}
```

Required area coverage: gate/workflow dependency logic, goal/session stores and persistence, team scheduler/orchestration, session lifecycle and WebSocket broadcast, git/worktree logic, verification harness, config cascade, message reducer/app state (`src/app`), and 2-3 renderer components (`src/ui`). Each major area has at least five mutants unless the area has fewer viable source files, in which case the report records the exception.

Required operator diversity: negated conditional, off-by-one, swapped arguments, removed `await`, dropped event emit/broadcast, inverted boolean return, swallowed error, removed persistence write, wrong default value. At least one mutant per DI seam disables or weakens its fence (`CommandRunner`, `fetchImpl`, `Clock`, `agentBridgeFactory`, `fsImpl`) and must be caught by seam contract tests.

Invalid mutants are allowed only as runner output, never as counted evidence. A mutant is `invalid` if the patch no longer applies, TypeScript cannot parse the changed file, or both suites fail to start before reaching the expected catcher. Invalid entries are excluded from kill-rate denominators and must be fixed or replaced before switchover acceptance.

### 9.2 `chaos.mjs` ephemeral-worktree runner

`scripts/testing-v2/chaos.mjs` runs each mutant in an isolated git worktree created from the current branch:

1. Assert the source tree is clean.
2. Create an ephemeral worktree at the current HEAD as a SIBLING of a campaign-scoped "chaos root" (`os.tmpdir()/bobbit-chaos-root-<pid>-<ts>`). The chaos root holds ONE shared `node_modules` link (Windows junction / POSIX dir symlink → the complete toolchain `node_modules`), created once via `ensureChaosRoot()`; the worktree itself contains **no** `node_modules` link and resolves modules by walking up to `<chaos-root>/node_modules`. This keeps every resolvable `node_modules` outside every deletion root — see [node-modules-corruption-rca.md](node-modules-corruption-rca.md).
3. Apply the mutant patch with `git apply --index` and assert only the intended files changed.
4. Run the targeted legacy catchers from `expectedLegacyCatchers` and targeted v2 catchers from `expectedV2Catchers` with retries disabled.
5. Record `caught` when the targeted command fails with the expected test failure pattern; record `missed` when it passes; record `invalid` for patch/compile/harness failures unrelated to the mutant behavior.
6. For at least five randomly selected valid mutants marked `fullV2SampleEligible`, also run the full `npm run test:v2`; if a non-listed v2 test catches the mutant, update the corpus/report so targeted catcher lists do not become over-narrow.
7. Remove the worktree (junction-safe: reparse points are unlinked before any recursive delete) and assert the main branch remains clean so no mutant can leak into normal development. At campaign end, `cleanupChaosRoot()` (in `main()`'s `finally`) unlinks the shared `node_modules` reparse point *first* and then removes the whole chaos root, refusing the recursive delete if the reparse point still survives.

Integrity checks:

- A null mutant entry applies no source change and must pass both legacy and v2 targeted commands. If it fails, the runner is broken and no chaos results are accepted.
- The ≥5 full-v2 sample must include at least one server, one app, one UI, one DI-fence, and one browser/journey mutant when such mutants exist.
- Targeted commands run with `retries: 0`; a flaky catcher is a test failure, not a mutant kill.

### 9.3 Reports and acceptance loop

`chaos.mjs` writes `.profiles/chaos/comparison-report.json` and `.profiles/chaos/comparison-report.md`; the switchover gate commits the stable summary to `docs/testing-v2/chaos-report.md`.

Report contents:

- Matrix of mutant id × area × operator × legacy result × v2 result × targeted commands × duration.
- Overall and per-area kill rates, excluding invalid mutants.
- List of legacy-caught/v2-missed mutants.
- List of both-missed mutants with remediation status.
- Null-mutant result and full-v2 sample ids/results.

Acceptance loop:

1. If any legacy-caught mutant is missed by v2, add or strengthen v2 coverage and rerun that mutant until v2 catches it.
2. If v2 overall or per-area kill rate is below legacy, add v2 coverage in that area and rerun affected mutants.
3. If both suites miss a mutant, add a v2 test within this goal or record a concrete justification in `docs/testing-v2/chaos-report.md` with owner and follow-up. Unjustified both-missed mutants fail switchover.
4. Switchover requires: null mutant passed, invalid mutants fixed/replaced or excluded with reason, v2 catches 100% of legacy-caught mutants, and v2 kill rate is ≥ legacy overall and per area.

## 10. Daily full-fidelity lane

`npm run test:daily` is the one-command tier-3 lane. It runs after switchover as the daily real-fidelity backstop and also includes the legacy suite until the retirement rule is satisfied.

### 10.1 Command composition and order

`npm run test:daily` runs `node scripts/testing-v2/run-daily.mjs`, which executes in this order and stops on first failure:

1. `npm run test:manual` — existing manual integration suite unchanged, including real agents/LLM/Docker paths where configured.
2. `npm run test:daily:relocated` — relocated real-fidelity specs from `tests2/daily/`: worktree pool/lifecycle/continue-archived-worktree cluster, sandbox/Docker recovery, realpush bare-repo branch cleanup, spawned-process crash/restart and port auto-increment, real MCP subprocess integration, and per-project config-dir fidelity.
3. `npm run test:unit && npm run test:e2e` — full legacy suite while `legacyRetired` is false in the daily state file.
4. `npm run test:v2` — confirms the gate suite still passes in the daily environment and captures a comparable v2 budget artifact.

The relocated daily list is generated from `tests2/tests-map.json` entries with bucket `daily`; the runner fails if a daily-mapped file is missing or if an unlisted file appears in `tests2/daily/`.

### 10.2 Fourteen-green legacy retirement rule

Daily state persists in `.bobbit/state/testing-v2/daily-lane.json`:

```json
{
  "consecutiveGreen": 0,
  "legacyRetired": false,
  "lastRunAt": "ISO timestamp",
  "lastGreenSha": "git sha",
  "history": [{ "sha": "...", "status": "green|red", "legacyIncluded": true }]
}
```

A run increments `consecutiveGreen` only when all enabled daily phases pass on the same SHA with retries disabled. Any red phase resets the counter to 0. When the counter reaches 14 after v2 is the project gate, `run-daily.mjs` flips `legacyRetired` to true, writes an evidence artifact, and opens/reminds the switchover follow-up to delete the daily legacy step. Until that flag is true, the legacy `test:unit` + `test:e2e` phase remains mandatory.

### 10.3 Staff-agent daily trigger and triage

The daily-lane gate creates a Bobbit staff agent named `testing-v2-daily` with a daily trigger. Its prompt is constrained to:

- Run `npm run test:daily` from the project root.
- Attach `.profiles/testing-v2/daily/<timestamp>.json` and the markdown summary to its report.
- Classify failures as product regression, test flake, infrastructure/environment, or invalid daily mapping.
- File a goal for product regressions and deterministic test bugs; include command, failing phase, log excerpt, SHA, and owner suggestion.
- Never mark a red daily run green manually and never increment the retirement counter outside `run-daily.mjs`.

### 10.4 Runbook and evidence artifact

`docs/testing-v2.md` is the operator runbook. It includes manual invocation, required local services/secrets for real-fidelity phases, how to read daily artifacts, how to triage each failure class, how the 14-green retirement counter works, and how to reset only after an explicitly documented invalid run.

Every daily run writes `.profiles/testing-v2/daily/<timestamp>.json` and `.profiles/testing-v2/daily/<timestamp>.md` with phase order, commands, exit codes, durations, budget artifacts, git SHA, daily counter before/after, legacy-included flag, and staff triage status. The daily-lane gate requires one full green artifact with `legacyIncluded: true` unless the 14-green retirement evidence already exists.

## 11. Sequencing and migration safety

1. Gate 2: land this design document only.
2. DI runtime gate: add `GatewayDeps`, fences, `fsImpl`, contracts; legacy tests stay green.
3. Foundation gate: add `tests2/` harness, vitest projects, Playwright v2 config, atomic reservation ledger, budgets, source-transform measurement, and a representative pilot.
4. Mass migration: copy/codemod core/dom/integration files into `tests2/`; originals remain untouched.
5. Browser tier: add Chromium keep adapters and 31 smoke journeys; retired specs stay in legacy until switchover.
6. Parity proof: V8 coverage, story-registry walk, bucket guard, mapping guard, and baseline-history honesty check must pass.
7. Concurrency proof: 5 simultaneous `test:v2` runs × 3 reps, `retries: 0`; asserts 15/15 green, **each run's wall time ≤ `full.maxWallMs` × 1.25 tolerance under mutual load** (i.e. ≤ 3 min × 1.25 = 225 s while contending), and reservation-ledger artifacts proving `sum(workerSlots) <= cores` for every generation. The `perRunWallToleranceFactor` lives in `tests2/budgets.json`.
8. Chaos proof: mutant comparison report proves v2 catches every legacy-caught mutant and at least matches kill rates overall and per area.
9. Switchover: short freeze window; flip `.bobbit/config/project.yaml` commands to v2, delete/retire test env flags, update docs/AGENTS pointers.
10. Daily lane: create the staff-agent trigger, land `docs/testing-v2.md`, run one full green `test:daily`, and persist the retirement counter.

Safety rules:

- Legacy suite remains the gate and green on every intermediate commit.
- Migration copies tests into `tests2/`; no legacy move/delete until switchover.
- From mass migration onward, the v2 guard fails new unmapped tests and requires new tests to land in `tests2/`.
- No assertion is weakened or skipped to meet budgets.

## 12. Spec-auditor edge cases

- **Windows 32k command-line limit:** runners enumerate files in Node and pass bounded argv chunks or config-driven project globs; no shell-expanded 1105-file command line.
- **Defender-scanned NTFS:** pure store tests use memfs through `fsImpl`; gateway tests keep real temp dirs but place them outside the repo and use bounded retry cleanup for file locks.
- **TIME_WAIT port races:** gateway fixture uses `port: 0` with `portExplicit: true`, avoiding auto-increment scans and stale ports.
- **Ledger stale PIDs and staggered starts:** every reservation read drops entries whose PID no longer exists; process exit also removes its own entry; atomic lockfile grants from a shared remaining-core budget make `sum(workerSlots) <= cores` structural.
- **Env-mutating tests:** codemod reports `needs-withEnv`; `withEnv` restores in `finally`, preserving missing-vs-empty values. Single-fork stragglers are capped at ≤10 by switchover.
- **CSS imports under vitest:** dom project config treats CSS as inert modules or uses vitest CSS handling so Lit components importing CSS do not require Vite browser bundling.
- **Lit/happy-dom warnings:** lit dev-mode warnings are allowed only if they do not fail assertions; tests flush updates through `await el.updateComplete` / microtask helpers and avoid geometry APIs in happy-dom.
- **Geometry false positives:** inventory uses content-based API-shaped detection, not bare substrings; `bg-wait-timer.spec.ts` and `context-cost-stats.spec.ts` demonstrate corrected classification.
- **Browser-only APIs:** specs using bounding boxes, real scroll, `ResizeObserver`, `IntersectionObserver`, `visualViewport`, canvas, IME/composition, or real drag stay in Chromium.
- **Local git fidelity:** v2 continues to use real local git for non-network operations; only remote/network edges are fenced.
- **Docker fidelity:** v2 blocks Docker by default and uses fake ContainerRuntime maps; real Docker moves to daily tier.

## 13. Acceptance checklist for later gates

- `npm run test:v2` green within ≤180 s wall and ≤13 CPU-min measured by full process-tree CPU, `retries: 0`.
- Five concurrent full v2 runs × three reps: 15/15 green, **each run's wall ≤ 3 min × 1.25 tolerance under mutual load**, reservation-ledger proof attached and `sum(workerSlots) <= cores` in every generation.
- `scripts/testing-v2/parity.mjs` shows V8 per-area line+branch coverage non-regression against named baselines, story-registry non-regression, no unmapped tests, no retired-without-replacement tests, and a clean baseline-history honesty check.
- No test-only env flags or `NODE_ENV === "test"` conditionals remain in `src/` at switchover — verified by the switchover llm-review (the standalone `check-no-test-flags.mjs` grep script was dropped as redundant; `cli-real-deps.test.ts` pins the no-test-doubles CLI contract).
- `docs/testing-v2/chaos-report.md` shows v2 catches 100% of legacy-caught mutants, matches/exceeds kill rate overall and per area, passes the null-mutant check, includes the ≥5 full-v2 sample, and remediates or justifies every both-missed mutant.
- `npm run test:daily` has one full green evidence artifact, the staff-agent daily trigger exists, `docs/testing-v2.md` documents the runbook, and the 14-green legacy-retirement counter is persisted.

## D8 — Browser-consolidation coverage confidence is a switchover prerequisite (SETTLED with user)

The chaos mutation proof is node-tier only (0/54 mutants touch the browser/Playwright dimension), and
parity-proof checks only aggregated per-area line+branch coverage — neither adversarially validates the
184→~35 browser-e2e journey consolidation (151 `legacy-pending` specs "covered by" journeys). Before the
gate is flipped to v2 (switchover), ALL THREE must pass and be committed:

1. **Browser-dimension adversarial mutation** — inject mutants into code covered only by browser e2e; run
   the targeted legacy spec(s) AND the replacement journey(s); any legacy-caught-but-journey-missed mutant
   is a real hole to close by strengthening the journey. v2 (journeys) ≥ legacy per area, 0 unexplained misses.
2. **Assertion-parity audit of the 151 consolidated specs** — for each `legacy-pending` spec, confirm its
   replacement journey asserts the same behaviors (not just executes the code); add missing assertions.
3. **Per-file coverage-delta report** — parity emits per-FILE line/branch deltas (not just per-area
   aggregate) so localized drops in consolidated journeys are surfaced.

Switchover is BLOCKED until 1–3 pass. Legacy remains the gate until then.

## D9 — Concurrency target capped at 3 (5-way spun off) (SETTLED with user)

Measured on the 24-core dev box: a single test:v2 run is 251s (green); but 5 concurrent FULL runs hit
~800–960s/run and one integration test starves past its 60/90s timeout. Root cause is per-test/per-fork
GATEWAY BOOT cost (each integration + browser test boots a full real gateway), NOT worker/fork count — so
the ledger worker-cap cannot bring 5 full suites under the 600s bar. This is deterministic CPU starvation,
not a flake.

Decision: the concurrency-proof target is **3 concurrent** for now (honest, fits <600s, retries:0, Σ≤24, 0
flakes). Restoring 5-way is deferred to a **spin-off goal** that reduces per-test gateway cost (e.g. share a
gateway across integration tests / cut boot cost). No assertions weakened, no timeouts padded. Supersedes the
"5 concurrent" figure in requirement #2 for this goal's acceptance.
