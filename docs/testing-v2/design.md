# Test Suite v2 Design

This document is the authoritative architecture for the Test Suite v2 migration. It implements the settled decisions D1-D6 from the goal spec without reopening them: vitest forks with `isolate:false`, happy-dom for non-geometry component fixtures, one source-booted gateway per worker, hybrid IO with fenced command/fetch plus store `fsImpl`, browser-E2E consolidation, and automated review gates only.

Authoritative inputs:

- Inventory: [`docs/testing-v2/inventory.md`](./inventory.md)
- Machine map: [`tests2/tests-map.json`](../../tests2/tests-map.json)
- Baseline metrics: [`docs/testing-metrics/`](../testing-metrics/)
- Validator run during this design pass: `node scripts/testing-v2/check-inventory.mjs` → PASS, 1105/1105 mapped once.

## 1. GatewayDeps DI seams

`createGateway(config, deps?)` becomes the single runtime wiring point. Missing deps always default to production implementations; the CLI boundary passes no test doubles.

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
| `src/server/auth/cookie.ts` | 2 | debounced write |
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

### 1.7 Env flags eliminated at switchover

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

`NODE_ENV === "test"` conditionals are also banned in `src/` after switchover, except a documented CLI-only mapping that is removed by the switchover gate.

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
- Stragglers that cannot safely share a worker move to a dedicated vitest project `singleFork` with `isolate:true`. Exit criterion at switchover: ≤10 files, each tracked in `tests2/tests-map.json` with a reason and owner.

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
- `tests/verification-dedup.spec.ts`

## 6. Budget arithmetic and ledger math

Budget targets live in `tests2/budgets.json`:

- Tier 1 (`vitest` core + dom + integration): ≤100 s wall, ≤8 CPU-min.
- Tier 2 (`playwright-v2` browser): ≤120 s wall, ≤6 CPU-min.
- Full `npm run test:v2`: ≤180 s wall, ≤13 CPU-min.

Projected tier-1 cost:

| Project | Files | Dominant cost removed | Projected wall | Projected CPU |
|---|---:|---|---:|---:|
| `v2-core` | 499 | node:test per-file `tsx` spawn/transform | 20-30 s | 1.5-2.0 CPU-min |
| `v2-dom` | 151 | Chromium for non-geometry fixtures | 15-25 s | 0.8-1.2 CPU-min |
| `v2-integration` | 198 | gateway per test file; now one source gateway per fork | 55-75 s | 3.5-4.5 CPU-min |
| Tier-1 total | 848 | shared transform + shared gateway | ≤100 s | ≤8 CPU-min |

Projection basis: the D1 spike measured a 12-test file at ~12 ms under vitest versus ~2.5 s under `tsx --test`; the D3 spike measured source server graph transform at ~9 s cold / ~6 s warm once per worker, amortized across integration files. If eight workers boot gateways, transform/boot is paid per fork, not per file.

Projected tier-2 cost:

| Suite | Count | Projected wall | Projected CPU |
|---|---:|---:|---:|
| Chromium adapters kept for geometry/browser fidelity | 62 specs | 50-70 s | 2.5-3.5 CPU-min |
| Consolidated smoke journeys | 31 journeys | 45-65 s | 2.0-2.5 CPU-min |
| Tier-2 total | 93 Playwright specs/journeys | ≤120 s | ≤6 CPU-min |

`test:v2` orchestration runs tier 1 and tier 2 as registered child runners. The full-run wall target is not the sum of tier walls because the children overlap when the ledger grants capacity; it is capped at 180 s. CPU target is additive with overlap: tier1 ≤8 + tier2 ≤6, with shared setup/cache overlap expected to keep full CPU ≤13.

Ledger formulas:

```ts
vitestMaxForks = clamp(Math.floor(cores / activeRuns), 2, 8);
playwrightWorkers = clamp(Math.floor(cores / activeRuns / 2), 2, 4);
```

`activeRuns` counts registered runner processes, not just parent `npm run test:v2` invocations. A full `test:v2` starts one vitest runner and one Playwright runner, so five concurrent full runs register ten active runner processes.

On the 24-core target machine with five concurrent `test:v2` invocations:

- `activeRuns = 10`
- vitest per runner: `clamp(floor(24 / 10), 2, 8) = 2`; total vitest workers if all five vitest runners are active: `5 × 2 = 10`.
- Playwright per runner: `clamp(floor(24 / 10 / 2), 2, 4) = 2`; total Playwright workers if all five browser runners are active: `5 × 2 = 10`.
- Worst-case unweighted worker sum: `10 + 10 = 20 ≤ 24`.

Single full run:

- `activeRuns = 2`
- vitest: `clamp(floor(24 / 2), 2, 8) = 8`
- Playwright: `clamp(floor(24 / 2 / 2), 2, 4) = 4`
- unweighted worker sum: `12 ≤ 24`.

The ledger sweeps stale entries by PID liveness before computing `activeRuns`; dead PIDs cannot permanently depress worker counts.

## 7. esbuild prebundle vs vitest SSR optimizer

Foundation gate decision procedure:

1. Tune vitest SSR optimizer first and measure per-fork source-server transform time for `createGateway` from `src/server/server.js`.
2. If warm per-fork transform is **≤5 s**, keep direct source imports; simpler and closer to production TypeScript graph.
3. If warm per-fork transform is **>5 s**, switch the gateway fixture to a content-hash-cached esbuild prebundle of the server graph. Target: ~1-2 s per worker after cache hit.
4. Record the measured cold/warm numbers and chosen path in the v2 foundation gate output. Do not change the decision later without a new measurement.

## 8. Sequencing and migration safety

1. Gate 2: land this design document only.
2. DI runtime gate: add `GatewayDeps`, fences, `fsImpl`, contracts; legacy tests stay green.
3. Foundation gate: add `tests2/` harness, vitest projects, Playwright v2 config, ledger, budgets, source-transform measurement, and a representative pilot.
4. Mass migration: copy/codemod core/dom/integration files into `tests2/`; originals remain untouched.
5. Browser tier: add Chromium keep adapters and 31 smoke journeys; retired specs stay in legacy until switchover.
6. Parity proof: coverage, story-registry, bucket guard, and mapping guard must pass.
7. Concurrency proof: 5 simultaneous `test:v2` runs × 3 reps, `retries: 0`.
8. Chaos proof: mutant comparison report proves v2 catches every legacy-caught mutant and at least matches kill rates.
9. Switchover: short freeze window; flip `.bobbit/config/project.yaml` commands to v2, delete/retire test env flags, update docs/AGENTS pointers.
10. Daily lane: run full tier-3 fidelity suite and staff-agent trigger.

Safety rules:

- Legacy suite remains the gate and green on every intermediate commit.
- Migration copies tests into `tests2/`; no legacy move/delete until switchover.
- From mass migration onward, the v2 guard fails new unmapped tests and requires new tests to land in `tests2/`.
- No assertion is weakened or skipped to meet budgets.

## 9. Spec-auditor edge cases

- **Windows 32k command-line limit:** runners enumerate files in Node and pass bounded argv chunks or config-driven project globs; no shell-expanded 1105-file command line.
- **Defender-scanned NTFS:** pure store tests use memfs through `fsImpl`; gateway tests keep real temp dirs but place them outside the repo and use bounded retry cleanup for file locks.
- **TIME_WAIT port races:** gateway fixture uses `port: 0` with `portExplicit: true`, avoiding auto-increment scans and stale ports.
- **Ledger stale PIDs:** every ledger read drops entries whose PID no longer exists; process exit also removes its own entry.
- **Env-mutating tests:** codemod reports `needs-withEnv`; `withEnv` restores in `finally`, preserving missing-vs-empty values. Single-fork stragglers are capped at ≤10 by switchover.
- **CSS imports under vitest:** dom project config treats CSS as inert modules or uses vitest CSS handling so Lit components importing CSS do not require Vite browser bundling.
- **Lit/happy-dom warnings:** lit dev-mode warnings are allowed only if they do not fail assertions; tests flush updates through `await el.updateComplete` / microtask helpers and avoid geometry APIs in happy-dom.
- **Geometry false positives:** inventory uses content-based API-shaped detection, not bare substrings; `bg-wait-timer.spec.ts` and `context-cost-stats.spec.ts` demonstrate corrected classification.
- **Browser-only APIs:** specs using bounding boxes, real scroll, `ResizeObserver`, `IntersectionObserver`, `visualViewport`, canvas, IME/composition, or real drag stay in Chromium.
- **Local git fidelity:** v2 continues to use real local git for non-network operations; only remote/network edges are fenced.
- **Docker fidelity:** v2 blocks Docker by default and uses fake ContainerRuntime maps; real Docker moves to daily tier.

## 10. Acceptance checklist for later gates

- `npm run test:v2` green within ≤180 s wall and ≤13 CPU-min, `retries: 0`.
- Five concurrent full v2 runs × three reps: 15/15 green, ledger worker proof attached.
- `scripts/testing-v2/parity.mjs` shows coverage non-regression and no unmapped/retired-without-replacement tests.
- `scripts/testing-v2/check-no-test-flags.mjs` finds no test-only env flags or `NODE_ENV === "test"` conditionals in `src/` at switchover.
- `docs/testing-v2/chaos-report.md` shows v2 catches 100% of legacy-caught mutants and matches/exceeds kill rate overall and per area.
