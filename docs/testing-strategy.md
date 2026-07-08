# Testing Strategy — Assessment & Path Forward

## The phase invariant (read this first)

Bobbit runs its tests through **workflow gates**, not `npm test`. The implementation gate runs four command steps against the goal branch — `build`, `check`, `unit`, `e2e` — whose commands live in `.bobbit/config/project.yaml`. Whatever the `unit:` / `e2e:` commands execute IS the test suite; anything they don't run is invisible and lets failures slip onto `master`.

To make that a no-brainer, exactly one rule is enforced: **every test file under `tests/` except those under `tests/manual-integration/**` runs in exactly one phase — `unit` or `e2e`.** Three buckets, two runners in the unit phase:

| Bucket | What | Runner / source of truth | Gate command |
|--------|------|---------------------------|--------------|
| **unit · node** | fast logic tests, no real LLM | `tsx --test` over `NODE_UNIT_GLOBS` in [`scripts/test-phase-config.mjs`](../scripts/test-phase-config.mjs) (`tests/*.test.ts` + `tests/contract/*.test.ts`) | `unit:` → `npm run test:unit` |
| **unit · browser** | `file://` component fixtures, no server | `tests/playwright.config.ts` (`tests/*.spec.ts`, minus `e2e/`, `manual-integration/`) | `unit:` → `npm run test:unit` |
| **e2e** | all remaining non-LLM integration | `playwright-e2e.config.ts` (union across its `api` / `api-realpush` / `browser` projects) | `e2e:` → `npx playwright test --config playwright-e2e.config.ts` |
| **manual-integration** *(gate-exempt)* | real LLM / Docker | `playwright-manual.config.ts` | `npm run test:manual` only |

`npm run test:unit` runs the two unit runners **concurrently** via [`scripts/run-unit.mjs`](../scripts/run-unit.mjs), splitting the cores between them and capping each runner at 6 workers by default (node `--test-concurrency=min(6,N/2)`, browser `--workers=min(6,N/2)`) so they run genuinely in parallel without oversubscribing or starving file:// browser fixtures. Env overrides are available for intentional local stress runs.

**Affected-only iteration**: `npm run test:unit -- <paths...>` runs only the given files instead of the full ~90s phase. Each path is routed to its owning sub-phase — a `tests/*.test.ts` (or `tests/contract/*.test.ts`) arg to the node runner, a `tests/*.spec.ts` fixture arg to the browser runner — and the other sub-phase is skipped entirely when it has no matching args. A path outside both unit sub-phases (e.g. `tests/e2e/**`) is a hard, non-zero-exit error rather than a silent no-op. Zero args is unchanged: both phases run their full default glob/suite. See [`scripts/test-unit-args.mjs`](../scripts/test-unit-args.mjs) for the pure selection logic and [`tests/test-unit-args.test.ts`](../tests/test-unit-args.test.ts) for the pinned seam.

**Convention purity**: `*.test.ts` ⇒ node:test runner; `*.spec.ts` ⇒ Playwright. A `*.test.ts` must never import `@playwright/test`; a `*.spec.ts` must never import `node:test`. This is what keeps the two unit runners cleanly separable.

**The guard**: [`tests/test-phase-invariant.test.ts`](../tests/test-phase-invariant.test.ts) enumerates every `tests/**/*.{test,spec}.ts`, derives the bucket globs from the same configs/constant the runners use, and fails if any file is claimed by zero phases (orphan) or more than one (double-claim), or violates the runner convention. There is **no fourth bucket**: a spec that some other config (e.g. the manual `docker` project) happens to collect but that does not physically live under `tests/manual-integration/` is treated as an orphan — which is why the real-Docker and real-LLM specs physically live under `tests/manual-integration/` rather than under `tests/e2e/` with an ignore.

**Measured unit wall time (24-core dev box): ~90s** (down from ~135s when the two runners were chained with `&&`). This is above the <1min aspiration. Binding constraint: both unit runners are CPU-bound and parallelise internally; the node logic suite alone is ~6.4k tests (grown from ~3.4k as the suite has grown — see the updated [Test Inventory](#test-inventory) below), and at a half-core split (`--test-concurrency=12`) it is the long pole while the browser fixtures finish faster. Giving either runner all cores oversubscribes the box and reintroduces contention-induced timeouts, so the split is the fastest **green** configuration. Sharding the node suite across processes is the next lever if the box shrinks. See the parallelism-ladder discussion in `docs/design/test-phase-invariant.md`. The ~90s/~76s wall-time figures above are the original measurement and have not been re-measured against the current, larger test count — re-measure before relying on them for a specific budget decision.

**Measured e2e wall time (24-core dev box): ~6.5–7 min**, dominated by the `browser` project (~5.2 min when run standalone). Retries do **not** inflate this: back-to-back runs measured `--retries=3` at ~6.5 min and `--retries=0` at ~6.5–7.1 min — the retry budget is flake *insurance*, not steady-state cost. The number is above the ~5 min aspiration. Binding constraint: the `browser` project runs an in-process gateway + Chromium per worker; the worker budget below is deliberately conservative to avoid the cross-worker filesystem/CPU contention that historically produced flakes, and the spec mandated folding the previously `--grep-invert`-excluded `mcp-integration` + `session-lifecycle-ui` specs back into this project. Raising the worker budget to chase <5 min reintroduces exactly the contention flakes the budget exists to prevent, and would also degrade robustness when up to ~4 suites run concurrently — so it is not a free lever. A sub-5-min single-suite wall is a deliberately-superseded non-goal; see [E2E suite parallelism budget](#e2e-suite-parallelism-budget).

## Current State

### Test Inventory

| Layer | Files | Tests | Runtime | Parallelism |
|-------|-------|-------|---------|-------------|
| Unit · node (node:test logic) | ~650 | ~6.4k | long pole of the unit wall | `--test-concurrency=N/2` |
| Unit · browser (file:// fixtures) | ~150 | ~1.3k | finishes within the unit wall | `--workers=N/2` |
| E2E (in-process API + spawned browser) | ~440 | ~1.8k | ~6.5–7 min typical, longer under verification/concurrent load | api 2 / browser 3 workers |
| Manual integration (real agent/LLM + Docker) | ~14 | serial | ~5 min | **None** |

(Counts are order-of-magnitude; the authoritative membership is the phase-invariant guard, not this table.)

### What Each Layer Actually Tests

**Unit tests** — Isolated UI components via `file://` fixtures. Good at catching rendering regressions (markdown, git-status-widget `.trim()` bug, mobile header). Cannot test anything involving server communication.

**API E2E** — Server-side CRUD and protocol correctness. Strong coverage of goals, gates, tasks, roles, tools, config cascade, sessions. Uses in-process gateway — fast but no browser, no Docker. Tests the *contract* but not the *wiring*.

**Browser E2E** — Full-stack user journeys through Playwright browser → WebSocket → spawned gateway → mock agent. Covers goal creation, project management, settings, team lifecycle, navigation. **This is where the gap is widest.**

**Manual integration** — The gold standard. Real agent, real Docker, real crash recovery. Tests 6 session variations × crash/restart cycle × browser verification. Catches bugs no other layer can reach.

### Browser E2E placement policy

Spawned-gateway browser E2E is the most expensive automated layer. Add it only when the behavior needs real app integration: browser routing, WebSocket/server wiring, persistence across reload, cross-client state, or layout that cannot be represented in deterministic fixtures.

Default new coverage to the cheapest layer that can catch the bug:

1. node unit tests for pure logic and data transforms;
2. `file://` Playwright fixtures for renderer, panel, geometry, sidebar, and component-state matrices;
3. API E2E for gateway contracts without a browser;
4. spawned-gateway browser E2E for one or a few integration journeys.

When reducing browser rows, add replacement fixture/API/unit coverage first, keep a small full-stack smoke, and update the split-suite coverage map in [`docs/testing-metrics/coverage-map.md`](testing-metrics/coverage-map.md). The metrics command reference and baseline rules live in [`docs/testing-metrics/README.md`](testing-metrics/README.md).

### Split-suite metric reporting

Use split-suite metrics to prove browser E2E changes without running expensive tiers repeatedly:

- Use `npm run metrics:e2e:all` for final E2E validation. It runs the full E2E tier once and emits aggregate plus project-split artifacts under `.profiles/metrics/`.
- Use `metrics:slice:renderer`, `metrics:slice:scroll`, or `metrics:slice:sidebar` for focused feedback before the full run.
- Use `metrics:coverage` and scoped `metrics:check` when validating coverage non-regression without requiring every current metric file.
- Compare current `.profiles/metrics/*.json` artifacts against committed `docs/testing-metrics/baseline-*.json` files. Update baselines only after intentional coverage movement is reviewed and documented.

### The Gap

The manual integration tests catch bugs that the automated suite misses because they exercise **three things simultaneously** that no other test layer combines:

1. **Real Docker containers** — sandbox worktree recovery, branch reconciliation, container death/reconnect
2. **Crash resilience** — hard-kill gateway, verify persistence, restart on fresh port, confirm sessions survive
3. **Cross-cutting browser verification** — git status widget rendering, session navigation post-restart, agent follow-up messages

The automated E2E tests skip all three: Docker is unavailable (72+ `test.skip(!hasDocker)` guards), no crash simulation exists, and the mock agent can't exercise real sandbox paths.

### Prompt Interaction Coverage

Prompt interaction user stories (PI-01 through PI-25 plus sub-stories, defined in `userstories/prompt-interactions.md`) have automated test coverage. The stories cover every interactive element in the message editor, status bar, and context bar.

**Unit fixture tests** cover isolated component behavior:

| Test file | Stories | What it tests |
|-----------|---------|---------------|
| `message-editor-send.spec.ts` | PI-01, PI-02 | Enter to send, Shift+Enter multiline, empty prevention |
| `message-editor-arrows.spec.ts` | PI-02, PI-03 | Arrow key navigation, history recall |
| `command-history.spec.ts` | PI-03 | Command history up/down cycling |
| `message-editor-queue.spec.ts` | PI-04, PI-11–14 | Draft preservation, queue dispatch, reorder, edit, remove |
| `message-editor-slash.spec.ts` | PI-05 | Slash skill autocomplete |
| `message-editor-attach.spec.ts` | PI-06, PI-07, PI-08 | File attach button, drag-drop, paste edge cases |
| `voice-input.spec.ts` | PI-09 | Voice input with mocked SpeechRecognition API |
| `model-thinking-selectors.spec.ts` | PI-15, PI-16 | Model selector dropdown, thinking level toggle |
| `context-cost-stats.spec.ts` | PI-17, PI-18, PI-23 | Context usage bar, cost display, stats overview |
| `git-status-interactions.spec.ts` | PI-19 | Git status widget expand/collapse, file list, action buttons |
| `bg-process-states.spec.ts` | PI-20 | Background process pill states, log popup |
| `abort-and-focus.spec.ts` | PI-21, PI-24 | Abort streaming (Stop button + Escape), textarea focus management |
| `queue-dispatch.spec.ts` | PI-25, PI-21b | PromptQueue batching, `dequeueAllSteered`, `enqueueAtFront`, force-kill recovery via shadow-ledger reconciliation, aborting status |
| `draft-persistence.spec.ts` | PI-04b, PI-04c | Draft flush promise return, rAF retry replacing queueMicrotask |
| `review-annotation-focus.spec.ts` | PI-24b | Focus restoration to message editor after annotation cancel |

**Browser E2E tests** cover flows that need a real server:

| Test file | Stories | What it tests |
|-----------|---------|---------------|
| `prompt-stats-e2e.spec.ts` | PI-15, PI-17, PI-18, PI-23 | Model selector persistence, context/cost stats with real usage data |
| `abort-status-e2e.spec.ts` | PI-21b, PI-25 | Aborting status broadcast via WS, steered message queue reorder on abort |

PI-10 (steer) has API-level coverage in `steer-midturn.spec.ts`. PI-05 has E2E coverage in `slash-skill-e2e.spec.ts`.

### Session & Resilience Coverage

Session lifecycle, reload, and reconnect stories (`userstories/sessions.md`, `userstories/resilience.md`, and the session-related subset of `userstories/projects.md`) have spec-framework coverage for contracts **CT-05** (reload/reconnect restore state) and **CT-16** (projects organize sessions).

| Test file | Stories | What it tests |
|-----------|---------|---------------|
| `stories-sessions.spec.ts` | S-01–S-12 | Session create/switch/rename/delete, draft isolation, rapid switching, worktree-backed sessions, persistence, messaging |
| `stories-resilience.spec.ts` | RE-01–RE-08 | All run in standard E2E via the in-process crash/restart harness (see [Writing crash/restart E2E tests](#writing-crashrestart-e2e-tests)). RE-05 (Docker sandbox container recovery) auto-skips when Docker is unavailable. |
| `stories-projects.spec.ts` | PR-01, PR-04, PR-09, PR-10 | Projects organize sessions; project switching |

All three files register their stories in `tests/e2e/ui/story-registry.ts`, the central registry that `tools/spec-check.ts` walks to report per-contract variation coverage.

#### Writing crash/restart E2E tests

The worker-scoped `gateway` fixture in `tests/e2e/gateway-harness.ts` exposes two lifecycle hooks for tests that need to assert what survives a server bounce:

- `gateway.crash()` — calls the in-process gateway's `shutdown()`. The browser page's WebSocket fires `close` and the client begins its reconnect loop.
- `gateway.restart()` — re-invokes `createGateway` against the **same port** with `portExplicit: true`, anchored at the **same `bobbitDir`**. On-disk state (`SessionStore` v2 atomic writes + `.bak.N` rotation, projects, drafts, goals) carries over because the second boot reads what the first wrote. A small `EADDRINUSE` retry loop handles Windows TIME_WAIT races on the listener socket; the call throws if the OS assigns a different port.

**Why same-port re-bind.** The browser page is bound to `http://127.0.0.1:<port>` for the lifetime of the test. The client's WebSocket reconnect logic resumes against the same origin without `page.reload()`, so the test asserts the production reconnect path rather than a navigation.

**Wiring it into a spec.** Pass the `gateway` fixture into the per-test `SpecContext`:

```ts
test.beforeEach(async ({ page, gateway }) => {
  s = new SpecContext(page, gateway);
  // ...
});

test("RE-02: session survives server restart", async () => {
  await s.event.server_crash();
  await s.event.server_restart();
  // assertions on entities owned by this test
});
```

`event.server_crash()` waits up to 5s for the client to observe disconnect (best-effort). `event.server_restart()` waits for `/api/health` to come back and, on a session route, for `connectionStatus === "connected"` — reconnect failure is fatal. The canonical example is `tests/e2e/ui/stories-resilience.spec.ts`.

**Docker-gated variants.** Sandbox-dependent resilience stories (RE-05) skip themselves when Docker isn't reachable using the shared helper:

```ts
import { isDockerAvailable } from "../test-utils/docker.js";

test("RE-05: sandbox container recovery", async () => {
  test.skip(!isDockerAvailable(), "Docker not available");
  // ...
});
```

See `tests/e2e/sandbox-recovery-docker.spec.ts` for the same pattern in API-level specs.

**Limitations.** The `gateway` fixture is worker-scoped, so a crash/restart in test N affects every later test on that worker. Tests should assert only on entities they own (sessions/projects/goals they created in this test) and avoid global state assumptions. Playwright groups tests with matching `enableMcp` / `enableWorktreePool` options onto the same worker, so each spec file in practice gets its own gateway lifecycle.

#### Worker-scoped project state and helper self-healing

Every E2E worker starts with its own temp `BOBBIT_DIR`, token, port, project registry, and gateway state. Startup auto-ensures Headquarters. The harnesses also register one normal visible project named `default` beside Headquarters through the REST API. That normal project is test scaffolding only: production has Headquarters as the built-in server workspace, and normal project work requires an explicit `projectId` — cwd-based project inference has been removed (see [rest-api.md — Project resolution contract](rest-api.md#project-resolution-contract)). Tests must not depend on the developer's real `.bobbit/` state or on a global fallback project.

The shared helpers in `tests/e2e/e2e-setup.ts` keep this worker default healthy for high-level test setup:

- `defaultProjectId()` reads the live project list for the current worker before returning an id. It skips Headquarters and returns the normal harness default. If the cached normal id disappeared, or the `default` project was deleted, it re-registers the worker default with `upsert: true` and `acceptCanonical: true`.
- `createSession()` and `createGoal()` inject that ensured normal-project id when the caller does not pass `projectId`. Tests that intentionally exercise first-run Headquarters behavior should pass `projectId: "headquarters"` or use the Headquarters-specific helpers.
- Non-201 helper failures include the response body plus request, port/base, `bobbitDir`, cached default id, and live project list. A `POST /api/sessions` 400 should therefore identify the actual server rejection instead of reporting `body=<empty>`.

Keep the self-healing targeted. Do not add broad sleeps or weaken server validation when a later helper follows a project-deletion spec; the helper should restore only the worker default prerequisite it owns. API validation specs should issue their own direct `apiFetch()` calls and continue asserting intentional 4xx responses. Use `rawApiFetch()` only when the test must bypass harness request shaping, such as missing-`projectId` coverage or symlink-root rejection.

**Framework extensions** added to `tests/e2e/ui/spec-framework.ts` to support these stories:

- `ProjectHandle` — entity handle for asserting against projects.
- `SpecContext.createTestSession(name, opts)` — accepts `opts.cwd` to put the session in a real git worktree (needed for worktree assertions) and `opts.goalId` for goal-scoped sessions.
- `SpecContext.create_session_via_ui()` and `rename_session(name, newTitle)` — sidebar-driven session creation and the double-click-to-rename flow, for UI-first stories.
- `SpecContext.event.disconnect()` — force-closes the WebSocket so RE-07 can observe reconnect behavior without killing the server.
- `SpecContext.event.server_crash()` / `server_restart()` — bounce the in-process gateway via the worker-scoped `gateway` fixture. Pass `gateway` to the `SpecContext` constructor (`new SpecContext(page, gateway)`) to enable; calls without a fixture throw a clear error. See [Writing crash/restart E2E tests](#writing-crashrestart-e2e-tests).

#### Flake-stabilization patterns

Specs that pass in isolation but fail their retries only under full-suite load are almost always one of these. Each was a real root cause behind the suite's historical flake cluster (`goal-accept-failure-keeps-assistant`, `marketplace`, etc.) — root-cause fixes, not retry bumps. Prefer them in this order when triaging a new flake:

- **Clean up any project a spec creates directly.** The gateway is worker-scoped, so a project a spec POSTs to `/api/projects` outlives the test and leaks into every later spec sharing that worker. A later single-project spec then sees 2+ projects and pops an unexpected "Select a project" dialog mid-flow — the root cause of the goal-accept flake. Specs that register their own projects (e.g. `at-mention.spec.ts`) must delete them in `afterEach` **and** `afterAll` (belt-and-braces: `afterEach` between tests, `afterAll` to guarantee the worker is back to exactly one project). This is separate from the helper self-healing above, which only restores the worker *default* — it does not remove extra projects a spec created.
- **Re-render after reactive UI state changes.** Bobbit's app shell renders from module-closure state, not a reactive framework. A `@input` handler that mutates closure state (e.g. `newSourceUrl`) **must call `renderApp()`**, or bindings that depend on it (`?disabled=${!newSourceUrl.trim()}`) lag the keystroke. The marketplace add-source button looked disabled to the test even after `fill()` because the handler updated state without re-rendering — a real product bug surfaced by the flake, not a test-only artifact.
- **Synchronize on real preconditions, never optimistic clicks or immediate count asserts.** Wait for the button to be *enabled* before clicking (`toBeEnabled()`), wait for the full expected step/element set to render before asserting on it, and poll exact counts with `expect.poll(...)` rather than reading a count once right after an async mutation. A single visibility check or an immediate `count()` races the async render/browse under load; the assertion isn't weakened, just synchronized on the condition the UI actually guarantees. See `registerSource()` in `tests/e2e/ui/marketplace.spec.ts` for the canonical pattern.

## Root Causes of Escaped Bugs

### 1. UI Code Is Largely Untested in Isolation

The application shell (`src/app/`) is ~8,000 lines across 5 files:

| File | Lines | Responsibility |
|------|-------|---------------|
| `render.ts` | 2,863 | Main render function — imports from everything |
| `session-manager.ts` | 1,824 | WebSocket lifecycle, session cache, drafts, palettes |
| `remote-agent.ts` | 1,387 | Agent protocol bridge, tool proposals, streaming |
| `api.ts` | 1,365 | All REST calls to gateway |
| `state.ts` | 557 | Global mutable state singleton |

These files have **zero unit tests**. They are only tested through full-stack E2E (browser → WebSocket → server → mock agent → browser). This means:

- A change to `render.ts` can only be verified by clicking through the full app
- The config cascade UI broke goal creation — but no test exercises "open goal form after config change"
- Sandbox toggle wiring bugs require Docker to reproduce — E2E skips them

### 2. The Mock Agent Is Too Simple

The mock agent (449 lines) responds to keyword patterns (`GOAL_PROPOSAL`, `bash`, `write tool`). It cannot:

- Simulate sandbox behavior (container paths, branch reconciliation)
- Simulate slow operations (worktree setup, dependency install)
- Simulate failure modes (agent crash, tool timeout, permission denial beyond basic)
- Simulate git operations (commit, push, branch creation)
- Vary behavior between test runs to catch race conditions

### 3. No Server Restart Testing in Automated Suite

The E2E suite starts a clean gateway per worker and never restarts it. This means:

- Session persistence bugs are invisible
- State file corruption goes undetected
- Restore-from-disk logic is untested
- Worktree reuse after restart is untested

### 4. Feature Isolation Creates Blind Spots

Each E2E test file tests one feature. But bugs emerge from feature *interactions*:

- Sandbox + git status widget
- Config cascade + goal creation (role resolution)
- Worktree pool + session creation + project isolation
- PR status + sandbox branch reconciliation

No test exercises a multi-feature user journey like: "create a project → create a sandboxed goal → verify team starts → check git status widget → navigate to settings → change config → go back to goal → verify nothing broke."

## Strategy

The goal is to reach manual-integration-level confidence in an automated, parallelizable suite that runs in <5 minutes. This requires changes across four dimensions.

### Dimension 1: API Contract Layer (decouple UI from server)

**Problem:** `gatewayFetch()` is called directly from components. No abstraction, no mock point.

**Solution:** Extract a typed `GatewayClient` interface that encapsulates all server communication:

```typescript
// src/app/gateway-client.ts
export interface GatewayClient {
  // Sessions
  listSessions(): Promise<GatewaySession[]>;
  createSession(opts: CreateSessionOpts): Promise<GatewaySession>;
  getSession(id: string): Promise<SessionInfo>;
  terminateSession(id: string): Promise<void>;
  
  // Goals
  listGoals(): Promise<Goal[]>;
  createGoal(opts: CreateGoalOpts): Promise<Goal>;
  getGoalGates(goalId: string): Promise<Gate[]>;
  signalGate(goalId: string, gateId: string, content: string): Promise<void>;
  
  // Projects
  listProjects(): Promise<Project[]>;
  getProjectConfig(id: string): Promise<ProjectConfig>;
  
  // WebSocket
  connectSession(id: string): WebSocketConnection;
  connectViewer(): WebSocketConnection;
  
  // ... etc for every API surface
}
```

**Implementation:**
1. `RealGatewayClient` wraps `gatewayFetch()` — production path unchanged
2. `MockGatewayClient` returns canned responses — enables UI-only testing
3. Components receive the client via a simple module-level setter (no framework DI needed)

**Effort:** Medium. Mechanical refactor of `api.ts` + `session-manager.ts`. No behavior change.

**Payoff:** Enables Dimension 3 (UI component tests against mock client). Also makes the API surface explicit and documentable.

### Dimension 2: Enhanced E2E Infrastructure

#### 2a. Gateway Restart Testing

Add a `RestartableGateway` harness that can kill and restart the gateway mid-test:

```typescript
// tests/e2e/restartable-harness.ts
export class RestartableGateway {
  async start(): Promise<GatewayInfo>;
  async kill(): Promise<void>;       // hard-kill, like manual tests
  async restart(): Promise<GatewayInfo>; // fresh port, same data dir
}
```

This enables writing E2E tests like:
```typescript
test('session survives gateway crash', async ({ page }) => {
  const gw = new RestartableGateway(dataDir);
  await gw.start();
  // Create session, send message via browser
  await gw.kill();
  // Assert persistence files exist
  await gw.restart();
  // Verify session restored, send follow-up via browser
});
```

**Effort:** Small. The manual integration test already has this logic — extract it into a reusable harness.

#### 2b. Docker-Optional Sandbox Testing

For sandbox coverage without Docker:
- **Option A: Docker-in-E2E** — Run a subset of E2E tests with `hasDocker` gate, similar to manual tests but parallelized. Mark them as a separate Playwright project (`sandbox-integration`) that only runs when Docker is available.
- **Option B: Sandbox simulation** — Create a `MockSandboxManager` that mimics container paths (`/workspace-wt/...`), branch behavior, and recovery logic without Docker. Less realistic but fast and always available.

Recommendation: **Both.** Option B for fast CI, Option A as a "thorough" mode.

#### 2c. Smarter Mock Agent

Extend the mock agent with a **scenario system**:

```javascript
// In test: configure the mock agent's behavior for this specific test
await gw.configureMockAgent({
  onPrompt: [
    { match: /create.*file/, tool: 'Write', input: { path: '$CWD/test.txt', content: 'hello' } },
    { match: /git status/, tool: 'Bash', input: { command: 'git status' }, output: '## master\n M src/app.ts' },
    { delay: 5000, then: 'OK' },  // simulate slow response
  ],
  onSteer: 'acknowledge',
  failAfter: 3,  // crash after 3 turns
});
```

This lets individual tests define agent behavior without a real LLM.

**Effort:** Medium. The mock agent already handles keywords — add a configurable dispatch table loaded from a file or environment variable.

### Dimension 3: UI Component Testing (the biggest gap)

#### Current state: zero tests for `src/app/`

The 93 unit tests cover `src/ui/` components (standalone web components). The application shell in `src/app/` — routing, session management, rendering, state — has no tests at all.

#### Approach: Playwright Component Test Fixtures

Create `file://` test fixtures that load the app shell with a `MockGatewayClient` (from Dimension 1):

```html
<!-- tests/fixtures/goal-creation.html -->
<script type="module">
  import { MockGatewayClient } from './mock-gateway-client.js';
  import { initApp } from '../../src/app/init.js';
  
  const client = new MockGatewayClient({
    projects: [{ id: 'p1', name: 'Test', rootPath: '/test' }],
    sessions: [],
    goals: [],
    workflows: [{ id: 'feature', name: 'Feature', gates: [...] }],
  });
  
  initApp(client);
  location.hash = '#/new-goal';
</script>
```

```typescript
// tests/goal-creation-ui.spec.ts
test('goal form shows workflow options', async ({ page }) => {
  await page.goto('file://.../goal-creation.html');
  await expect(page.locator('[data-testid="workflow-select"]')).toBeVisible();
  await page.selectOption('[data-testid="workflow-select"]', 'feature');
  await expect(page.locator('.gate-toggle')).toHaveCount(3);
});
```

**What this tests that E2E doesn't:**
- UI rendering logic in isolation (fast, no server)
- Component interactions (sidebar + main panel + state)
- State management (draft persistence, cache eviction, palette switching)
- Error states (network failures, malformed responses)
- Rapid user interactions (fast clicks, navigation during loading)

**Effort:** High initial investment (Dimension 1 is prerequisite), then incremental per component.

### Dimension 4: Cross-Feature Integration Scenarios

Add a new test category: **integration scenarios** that exercise multi-feature user journeys.

```typescript
// tests/e2e/ui/integration-scenarios.spec.ts

test('full project lifecycle', async ({ page, gw }) => {
  // 1. Create project via UI
  // 2. Create goal with sandbox toggle
  // 3. Verify team starts (mock agent)
  // 4. Navigate to dashboard, check gates
  // 5. Navigate to settings, change config
  // 6. Go back to goal, verify nothing broke
  // 7. Check git status widget renders
  // 8. Terminate session, verify cleanup
});

test('config cascade affects running goal', async ({ page, gw }) => {
  // 1. Create goal with default role
  // 2. Customize role at project level
  // 3. Create new session — should use customized role
  // 4. Revert customization
  // 5. Create another session — should use builtin role
});

test('rapid navigation stress test', async ({ page, gw }) => {
  // 1. Create 5 sessions
  // 2. Click between them rapidly (no waiting)
  // 3. Assert no console errors
  // 4. Assert final session state is correct
  // 5. Assert sidebar reflects correct active session
});
```

**Effort:** Medium per scenario. Requires Dimension 2a (restart harness) for crash scenarios.

## Implementation Plan

### Phase 1: Quick Wins (1-2 days)

1. **Extract `RestartableGateway` harness** from manual integration test code. Add 2-3 crash/restart E2E tests.
2. **Add cross-feature integration scenarios** to existing browser E2E suite (5-10 tests covering the known blind spots).
3. **Add `data-testid` attributes** to key UI elements that tests currently locate by fragile CSS selectors.

**Impact:** Catches crash-resilience bugs and cross-feature interaction bugs in the automated suite. Directly addresses the cascade-broke-goals and sandbox-broke-git-status classes of bugs.

### Phase 2: API Contract Layer (3-5 days)

1. Define `GatewayClient` interface covering all REST + WebSocket endpoints.
2. Implement `RealGatewayClient` wrapping existing `gatewayFetch()` calls.
3. Refactor `api.ts`, `session-manager.ts`, `remote-agent.ts` to use the interface.
4. Implement `MockGatewayClient` for test use.
5. Wire production app to use `RealGatewayClient`.

**Impact:** Decouples UI from server. Enables Phase 3.

### Phase 3: UI Component Tests (ongoing, 1-2 weeks initial)

1. Create test fixtures for each major UI surface:
   - Sidebar (session list, project folders, collapse/expand)
   - Goal creation form (workflow selection, optional toggles, QA tooltip)
   - Goal dashboard (gates, team, verification modal)
   - Settings pages (scope tabs, config cascade badges)
   - Session view (messages, context bar, git status widget)
2. Target: 50+ UI component tests covering the `src/app/` shell.

**Impact:** Catches UI wiring bugs without server. Tests run in <10s via file:// fixtures.

### Phase 4: Docker-Integrated E2E (1-2 days)

1. Add `sandbox-integration` Playwright project that runs when Docker is available.
2. Move the 72+ skipped Docker tests into this project.
3. Add it as a "thorough" test mode: `npm run test:thorough` (E2E + sandbox integration).

**Impact:** Sandbox bugs caught automatically when Docker is available. CI can optionally enable it.

### Phase 5: Retire Manual Integration Tests (when Phase 1-4 complete)

Once the automated suite covers:
- [x] Crash/restart (Phase 1)
- [x] Cross-feature journeys (Phase 1)
- [x] UI component wiring (Phase 3)
- [x] Docker sandbox paths (Phase 4)

...the manual integration tests become redundant. Keep them as a smoke test for new developers but remove them from the critical path.

## Architecture Decision: Why Not Just Fix Manual Tests?

Making manual tests parallelizable and faster is tempting but fundamentally limited:

1. **Real agents are slow.** Each LLM round-trip is 2-10s. A 6-variation test with 3 messages each = 36 round-trips = 1-5 minutes minimum, even parallelized.
2. **Real agents are non-deterministic.** Tests can't assert exact responses. Flaky by nature.
3. **Docker startup is slow.** Container provisioning adds 10-30s per test that needs sandbox.
4. **Serial dependencies.** The crash/restart cycle is inherently serial — you can't parallelize "crash → verify → restart → verify."

The right answer is to **extract what makes manual tests valuable** (crash resilience, Docker paths, cross-feature verification) **into the automated suite** using deterministic mock agents and controlled infrastructure.

## Test Infrastructure Reference

### Node compile cache for the unit node-logic phase (opt-in, measured no-win)

`scripts/run-unit.mjs` can point `NODE_COMPILE_CACHE` (Node >= 22.1, persists
V8 bytecode across runs) at `.cache/node-compile/` for the node-logic runner
and everything it spawns, via `BOBBIT_TEST_COMPILE_CACHE=1`. It defaults OFF
because measurement did not show a reliable win on this machine:

| Run | Wall time (node-logic phase, ~1540 tests, `--test-concurrency=6`) |
|---|---|
| baseline (no cache), run 1 | 74.7s |
| baseline (no cache), run 2 | 83.0s |
| baseline (no cache), run 3 | 97.7s |
| cold cache, run 1 | 82.2s |
| cold cache, run 2 | 117.6s |
| warm cache, run 1 | 132.6s |
| warm cache, run 2 | 76.0s |
| warm cache, run 3 (fully warm) | 124.0s |

The spread within each condition (baseline: 74.7-97.7s; warm: 76.0-132.6s) is
larger than any difference between conditions — this machine runs a
merge-gate conveyor and multiple language-server/dev processes concurrently
(1-minute loadavg sat at 12-21 throughout, never near idle), which dominates
node-phase wall time far more than V8 bytecode compilation does for ~1540
small test files. Re-measure on a quiet or much larger machine before
considering a default flip.

### Cross-lane test mutex (fleet-parallel machines)

On a machine that also runs other test lanes concurrently (e.g. a merge-gate
conveyor plus dev/agent loops), two full `npm run test:unit` invocations
racing for the same cores at once produces contention-induced timeouts that
look like regressions but aren't — see [`scripts/lib/adaptive-concurrency.mjs`](../scripts/lib/adaptive-concurrency.mjs)
for the load-aware concurrency scale-down `run-unit.mjs` already applies, and
[`scripts/test-mutex.sh`](../scripts/test-mutex.sh) for a stronger guarantee:
a machine-wide, `mkdir`-based lock (with 90-minute stale reclaim) that
serializes an arbitrary wrapped command.

When running in a fleet-parallel context, use the queued variant instead of
the bare command:

```bash
npm run test:unit:queued   # scripts/test-mutex.sh npm run test:unit
```

It waits (foreground, with a progress line every 60s) for any other lane's
test run to finish before starting, then behaves identically to
`npm run test:unit`. Not needed for a single interactive dev loop — only when
you know another lane may be running tests at the same time.

### Harness selection

The E2E suite provides two harnesses. Choose based on what your test needs:

- **`in-process-harness.js`** — Default for API-only tests (no browser, no MCP, no process-level behavior). Faster startup (~2s vs ~5-8s per worker). Exposes `sessionManager` on `GatewayInfo` for sandbox token testing. Import `test, expect` from `./in-process-harness.js`.
- **`gateway-harness.js`** — Required when the test uses a `page` fixture (browser), needs MCP servers enabled, or tests process-level behavior (port allocation, auth bypass). Import `test, expect` from `./gateway-harness.js`.

### Temp dirs used as project / pack / worktree roots

Use `makeTmpDir(prefix)` from [`tests/helpers/tmp.ts`](../tests/helpers/tmp.ts)
(not a raw `fs.mkdtempSync`) for any temp directory a test passes to production as
a project, pack, or worktree root; use its `canonical(p)` to compare such paths.
The helper `fs.realpathSync`-canonicalizes the directory. This matters because
production canonicalizes project/pack roots, and on macOS `os.tmpdir()` resolves
under the `/var → /private/var` symlink — a non-canonical temp root then trips
`SymlinkProjectRootError` and produces false extension-host confinement
"escapes". Canonicalizing in the helper keeps these tests green on macOS, Linux,
and Windows alike. (This is distinct from the E2E scratch-space relocation under
[Windows temp root](#windows-temp-root).)

### UI E2E page-object helpers

Reusable helpers in `tests/e2e/ui/ui-helpers.ts`. Import from `./ui-helpers.js`:

- `openApp(page)` — navigate with token auth, wait for sidebar to load
- `createSessionViaUI(page)` — click "New session", wait for textarea
- `sendMessage(page, text)` — fill textarea, press Enter
- `waitForAgentResponse(page, opts?)` — wait for assistant message (default: "OK")
- `navigateToHash(page, hash)` — set `location.hash`, wait for transition
- `navigateToGoalDashboard(page, goalId)` — navigate to `#/goal/<id>`, wait for dashboard
- `clickSidebarItem(page, label)` — click sidebar entry by text
- `getVisibleSessions(page)` — return sidebar session titles
- `waitForSessionIdle(sessionId)` — poll API until session is idle

### Test-only window hooks

Three properties are attached to `window` in `src/app/main.ts` for browser E2E use. All three are harmless in production — the state object is already mutable from devtools, the render trigger is the same function the production code paths invoke, and the expanded-goals hook is a compatibility writer for sidebar tree expansion. None contain secrets.

| Hook | What it is | Why tests need it |
|---|---|---|
| `window.__bobbitState` | The mutable `state` singleton from `src/app/state.ts` | Patch in-memory session/goal/cache fields to drive deterministic predicate scenarios that would otherwise require a real backend (team-lead role flips, fabricated goals, gate verification flags). |
| `window.__bobbitRenderApp` | The `renderApp()` function | Force a fresh paint after patching state, without relying on viewport-resize side effects (which are unreliable under Playwright). |
| `window.__bobbitExpandedGoals` | Legacy-compatible `Set<string>` facade that writes goal expansion into the unified sidebar tree state | Inject synthetic goals into `state.goals` and force them into the expanded state — the production auto-expand path in `api.ts` only fires for server-confirmed goals. |

Usage pattern (from `tests/e2e/ui/notification-policy.spec.ts`):

```ts
await page.evaluate(({ sessionId, patch }) => {
  const state: any = (window as any).__bobbitState;
  const s = state.gatewaySessions.find((x: any) => x.id === sessionId);
  Object.assign(s, patch);
  (window as any).__bobbitRenderApp();
}, { sessionId, patch });
```

When using these hooks, also call `clearInterval(state.sessionPollTimer)` if the test runs long enough for the 5s session-list poll to land — otherwise the poll overwrites `state.gatewaySessions` with the server's un-patched view and the test flakes. See `stopPolling()` in `tests/e2e/ui/notification-policy.spec.ts` for the reference helper.

### Mock agent keywords

The mock agent in `tests/e2e/mock-agent.mjs` responds to keywords in the prompt. Send `GOAL_PROPOSAL` to trigger a `propose_goal` tool call response (with `options: "QA testing"`) — used to test the goal assistant flow without a real LLM. The full trigger contract (busy/wait, bursts, real fs/shell tools, proposals, UI primitives, steer round-trip) is documented in the header comment of `tests/e2e/mock-agent-core.mjs` — single source of truth.

### Tier 2.5 — opt-in video capture

A layer **on top of** Tier 2 browser E2E. Tests opt in by importing `tests/e2e/ui/fixtures.ts` (instead of `../gateway-harness.js`) and sprinkling `await rec.capture(label)` at user-visible moments; running with `RECORDSCREEN=1` produces a self-contained scrubbable HTML report at `tests/results/tier-2-5/report.html` (per-test WebM + thumbnail strip). Default off; zero overhead when `RECORDSCREEN` is unset. See [docs/testing-tier-2-5.md](testing-tier-2-5.md).

### Tail-chat / scroll-pin assertions

The tail-chat E2E suite (`tests/e2e/ui/tail-chat-*.spec.ts`) covers the user-facing contract "if I am at the bottom when content arrives, I stay at the bottom" across streaming bursts, tool-result expansion, session-navigate, image / iframe reflows, and user-scroll-up release. The suite exists as its own pattern because the chat scroll surface is uniquely susceptible to test illusions:

- **Outcome-only assertions.** Helpers in `tests/e2e/ui/tail-chat-helpers.ts` — `expectLatestMessagePinned` and `disableScrollAnchoring` — read only `getBoundingClientRect()` of the last rendered message vs the scroll container. Tests must NEVER assert on `_stickToBottom`, `_programmaticEchoes`, `_settleWindowActive`, or any other private field. The previous suite's private-field assertions kept passing even after production paths were neutered to no-ops; the rewritten suite proved sensitive to each path being broken (see the sensitivity matrix in [docs/design/tail-chat-redesign.md](design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port)).
- **Force Chromium ≡ Safari.** Always call `disableScrollAnchoring(page)` at the top of a tail-chat test. CSS `overflow-anchor` is Chromium-only; without disabling it inside the test scope, Chromium's default `auto` transparently masks broken JS pin behaviour. Production also sets `overflow-anchor: none` on `agent-interface .overflow-y-auto`, but the helper is belt-and-braces against any nested `auto` reset.
- **Drive real preconditions.** Use `STREAM_BURST:N`, `STAY_BUSY:Nms`, real tool-result rendering, and *trusted* `page.mouse.wheel` events. Never `dispatchEvent(new WheelEvent)`, never poke `_stickToBottom`, never seed the echo buffer. The canonical pattern is `tests/e2e/ui/tail-chat-real-stream.spec.ts`.
- **Opt into Tier 2.5 video.** Tail-chat regressions are easiest to diagnose visually; importing `fixtures.ts` and sprinkling `rec.capture("after-burst")` lets a reviewer scrub the failure in seconds when `RECORDSCREEN=1`.

If a test needs a new fact, add a named outcome helper to `tail-chat-helpers.ts` rather than reaching through to a private field. The chat scroll lock contract is documented in [docs/internals.md — Chat scroll lock invariant](internals.md#chat-scroll-lock-invariant).

## Manual Integration Tests

Full-stack resilience tests that use real agents and real Docker containers — no mocks. Defined in `tests/manual-integration/session-resilience.spec.ts`, configured by `playwright-manual.config.ts`. **Not included in `npm test`, `npm run test:unit`, or `npm run test:e2e`.**

```bash
npm run test:manual                 # Headless, API assertions only (~5 min)
SCREENSHOTS=1 npm run test:manual   # + browser screenshots + HTML report
```

### Real-LLM tests live under `tests/manual-integration/`

Any test that needs a real LLM call lives under `tests/manual-integration/` and runs only via `npm run test:manual` (real agent / Docker). There is **no** separate real-LLM e2e config or `test:e2e:real` script — those were retired so the only gate-exempt path is `tests/manual-integration/**` (see the phase invariant at the top of this doc). Compaction's manual `/compact` and auto/threshold paths are both covered deterministically (mock agent, no LLM) by the `@live-compaction-affordance` tests in `tests/e2e/ui/pre-compaction-history.spec.ts`. The former real-LLM manual specs (`compaction.spec.ts`, `compaction-pressure.spec.ts`) were removed because they seeded auth by copying a static `auth.json` OAuth snapshot whose short-lived access token expired mid-run (`invalid_grant`), so they could not authenticate reliably. See [compaction.md](compaction.md) for the feature-level walkthrough.

**Prerequisites**: `npm run build`, a working agent CLI in PATH (claude, etc.), Docker running for sandbox tests.

**What it tests**: Creates 6 session variations on a single gateway, sends messages through the browser, hard-kills the gateway (simulating a crash), restarts on a fresh port, and verifies each session survives:

| Variation | Worktree | Sandbox | Interrupt |
|---|---|---|---|
| Plain (no worktree) | no | no | no |
| Worktree | yes | no | no |
| Worktree + interrupt | yes | no | yes (kill mid-tool-call) |
| Sandbox plain | no | yes | no |
| Sandbox worktree | yes | yes | no |
| Sandbox worktree + interrupt | yes | yes | yes |

**Assertions per variation**:

- Session creation timing (create → idle, message round-trip)
- `sessions.json` persisted to disk after crash
- Session restores as `idle` (not archived)
- `cwd` preserved across restart (exact path match)
- Git working copy valid after restart (branch unchanged, `rev-parse --is-inside-work-tree`)
- Agent responds to follow-up message after restart
- Git status widget renders in the UI

**HTML report**: When run with `SCREENSHOTS=1`, generates `test-results/manual-integration/report.html`.

**Architecture**: The test creates an isolated git repo in a temp directory, pre-configures `project.yaml` (sandbox + worktree pool size), starts a gateway process, and manages its lifecycle. Sessions are created via API (worktree/sandbox flags aren't in the UI), but all agent messages go through the Playwright browser.

**When to run**: After changes to session lifecycle, restore logic, sandbox wiring, worktree management, git status polling, or any server restart behavior. Not needed for UI-only or prompt-only changes.

### Agent tool-use canary

The canary for `--tools` allowlist regressions has two layers, both pinning the post-`fdfee7c5` activation contract:

- **Unit contract pin** — `tests/tool-activation-contract.test.ts`. Runs in seconds under `npm run test:unit`; asserts `computeToolActivationArgs()` emits `--no-builtin-tools`, `--no-extensions`, the `_builtins/extension.ts` re-register shim, and the sorted `BOBBIT_BUILTIN_TOOLS` env list, with no stray `--tools` flag.
- **Manual-integration canary** — `tests/manual-integration/agent-tool-use.spec.ts`. Real agent in a sandboxed session, seven scenarios covering pi builtins (bash, edit, find), the steer/interrupt path, a tool-error path, a Bobbit extension tool (`web_fetch`), and an MCP meta-tool (`mcp_describe`). Tool-card assertions are tool-name-specific (`data-tool-name="<name>"` on the shared wrapper in `src/ui/components/Messages.ts`); substitute tools that produce the same visible side-effect no longer pass.

Run the unit pin on every commit and the integration canary before and after any `@earendil-works/pi-*` version bump. See [testing-coverage.md — Agent tool-use canary](testing-coverage.md#agent-tool-use-canary-two-layers) for the full scenario list, rationale, and the recipe for adding a new tool category.

## Testing with local/cheap models

Anthropic credentials are **not** required to use or test Bobbit — see [docs/internals.md](internals.md) ("Custom local providers" section) for the full investigation (there is no hard gate anywhere; `isSetupComplete()` is unrelated to provider credentials). For manual/exploratory testing — especially integration flows that don't need to assert on exact model output — pointing a real session at a local or cheap model avoids Anthropic rate limits, cost, and the OAuth/API-key hoop entirely.

**When to use which:**

| Need | Use |
|---|---|
| Unit/E2E CI assertions on agent behavior (tool calls, streaming, retries, …) | The RPC-protocol mock agent (`tests/e2e/mock-agent-core.mjs`) — see "Mock agent keywords" above. No real model call, deterministic, fast. Do **not** point CI tests at a real local model; `set_model` on the mock agent accepts any provider/id string without validating it against `models.json`, so it cannot catch model-registry wiring bugs — only a real agent binary does that (see the manual recipe below). |
| Manual smoke-testing a real session end-to-end without burning Anthropic credits/limits | A local model via Ollama/LM Studio/vLLM (recipe below), or the NVIDIA aigw alternative. Good for `qa-spot`/exploratory passes where you need a **real** completion loop but don't care which model answers. |
| Asserting on real model behavior/quality (real reasoning, real tool-choice quality) | `npm run test:manual` (`tests/manual-integration/**`) — the only gate-exempt real-LLM path; typically still uses your configured default provider, not a local model. |
| A cheap-but-real model for `test:manual` runs to control cost | Configure `default.sessionModel` to a cheap/small model of whichever provider you already use, or an aigw/local model — `tests/manual-integration/**` doesn't hardcode a provider. |

**Recipe: local Ollama, config-only, no code changes.** Ollama exposes an OpenAI-compatible surface at `<host>/v1`. Register it as a custom local provider (see [docs/internals.md](internals.md) for the full `customProviders` shape and the `models.json` bridge that makes the model actually session-selectable, not just visible in the picker):

```bash
ollama serve &                      # if not already running
ollama pull qwen3:0.6b              # any small tool-use-capable model

curl -X POST http://localhost:3001/api/custom-providers \
  -H "Authorization: Bearer $(bobbit --show-token)" \
  -H "Content-Type: application/json" \
  -d '{"id":"local-ollama","name":"local-ollama","type":"vllm","baseUrl":"http://localhost:11434"}'

curl -X PUT http://localhost:3001/api/preferences \
  -H "Authorization: Bearer $(bobbit --show-token)" \
  -H "Content-Type: application/json" \
  -d '{"default.sessionModel":"local-ollama/qwen3:0.6b"}'
```

New sessions now spawn against the local model with zero Anthropic credentials anywhere in the process. Verified live against a real `ollama serve` instance for this change (see the PR description for the transcript) — not something CI asserts on, since it's a real network call to a real local process.

**NVIDIA aigw alternative.** If you already run an AI Gateway (`aigw.url` configured, see the "AI Gateway" sections in [docs/internals.md](internals.md)), any OpenAI-compatible or Bedrock-routed model it exposes works the same way — configure `default.sessionModel` to `aigw/<model-id>` instead of standing up a local server. Prefer this when you want a shared, team-wide cheap-model config rather than a per-machine local server.

## Target State

| Layer | Tests | Runtime | Confidence |
|-------|-------|---------|------------|
| Unit (file:// fixtures) | ~500 | <30s | UI components correct in isolation |
| UI Component (file:// + mock client) | ~100 | <30s | App shell wired correctly |
| API E2E (in-process) | ~450 | <60s | Server contract correct |
| Browser E2E (spawned + restartable) | ~150 | <90s | Full-stack journeys work |
| Sandbox E2E (Docker, optional) | ~30 | <120s | Docker paths verified |
| **Total** | **~1,230** | **<5 min** | **Manual-integration-level** |

The manual integration tests remain as an optional "nuclear option" (`npm run test:manual`) for validating real-agent behavior, but the automated suite provides equivalent confidence for code changes.

## E2E suite parallelism budget

The E2E suite historically produced suite-level contention flakes: specs passed
in isolation, but full runs failed when many workers each spun up a gateway,
WebSocket stack, and, for browser tests, a Chromium instance on a constrained
Windows host. The current budget is intentionally conservative so speed gains do
not come from over-parallelising a shared filesystem.

### Worker and retry counts

Configured in `playwright-e2e.config.ts`:

- Top-level: adaptive workers — base 6 at idle, scaled down by 1-min loadavg
  via `computeAdaptiveConcurrency` (`scripts/lib/adaptive-concurrency.mjs`,
  the same formula as the unit phase; floors at 2). `BOBBIT_E2E_WORKERS`
  always wins as an explicit override. Historically a fixed 4 (lowered from
  6 for FS-contention flakes); re-validated at 6 on 2026-07-05 with two full
  mutex-serialised runs under loadavg ~12–18 showing zero new failures vs
  the 4-worker baseline — evidence in the comment at the `workers` field.
  `retries: 3`, `fullyParallel: true`.
- `api` project: `workers: 2` and inherited `fullyParallel: true`.
- `api-realpush` project: `workers: 1`, `fullyParallel: false`.
- `browser` project: `workers: 3`, `fullyParallel: false`.

Each worker owns a full gateway state directory; browser workers add Chromium
and static UI serving. The browser and real-push projects stay spec-serial
inside their project workers because their setup costs and filesystem side
effects are heavier. The API project remains fully parallel because it uses the
in-process harness, but its worker budget is capped at two to avoid stacking too
many gateway/git-heavy setup paths on Windows.

**`retries: 3` is the deliberate current policy, not debt.** The flake-hardening
effort root-caused the browser flake floor in place (see [Flake hardening](#flake-hardening-deterministic-waits)),
removed every `@quarantine` label, and un-skipped the one flake-skipped spec.
The config nonetheless **keeps** `retries: 3` and the current worker budget on
purpose. Rationale: the dev box must support running up to ~4 e2e suites
**concurrently** (overlapping worktrees / parallel goals). Under that mutual
contention a suite can hit a transient cross-suite race — CPU/FS pressure, a
goal-assistant cold-start timeout — unrelated to any real bug. `retries: 3`
absorbs those transients so one suite's blip does not red-light an otherwise
green concurrent run. The deterministic-wait hardening keeps the
**first-attempt** failure rate low, so retries are a resilience margin, **not**
a crutch for un-root-caused flakes.

The original goal's `retries: 0` + sub-5-min asks are explicitly **superseded**
by this decision. Retries are not being reduced to 0, and worker counts are not
being raised: raising parallelism to chase a sub-5-min single-suite wall would
manufacture the very contention this budget avoids and degrade concurrent-suite
robustness. A sub-5-min single-suite wall was therefore not achieved and is out
of scope under this policy.

Measured evidence:

- A single retries-free full suite runs ~6.5–7.0 min wall (~1270–1279 passed,
  ~6 skipped).
- **Two** full suites run concurrently at the committed `retries: 3` both passed
  (exit 0): suite 1 with 0 failed / 1 flaky-retried (`qa-seed`), suite 2 with
  0 failed / 2 flaky-retried (`dynamic-chat-tabs`, `repro-h3-snapshot-live-interleave`);
  ~9.5–10.0 min each under mutual contention. So under concurrency the suite
  absorbs ~1–2 transient flakes each with 0 hard failures.

When a clearly root-causable flake is found it is fixed in place rather than
masked — e.g. `open-session-new-window`'s middle-click was rewritten to dispatch
the `auxclick` event its handler contracts on, because Playwright's real
middle-click intermittently latched Chromium autoscroll and swallowed the
`auxclick`.

#### Flake hardening (deterministic waits)

The hardening effort eliminated the browser flake floor across 15+ specs by
replacing optimistic clicks and rAF-spin waits with **deterministic synchronization**:
`toBeEnabled()` before clicking, `expect.poll(...)` on exact counts,
`waitForResponse(...)`, and concrete data-attribute / element-count waits. Key fixes:

- **Split the 60s `sidebar-keyboard-nav` mega-test into 6 budgeted tests**, each
  well under the per-test timeout instead of one test racing a single 60s budget.
- **Fixed a worker-scoped `prw-session` leak**: `pr-walkthrough-api` now cleans up
  in `afterEach`/`afterAll` so a leaked session does not perturb later specs on
  the same worker (the worker-scoped-leak pattern — see
  [Flake-stabilization patterns](#flake-stabilization-patterns)).
- **Id-scoped the `search-orphan-filter` orphan-drop assertions** (goal / session /
  staff / message) to the inserted orphan row. The previous broad `type===`
  assertion also counted unrelated real rows surfaced by `suggest: true` fuzzy
  matching, so it flaked whenever live data happened to match.
- **Un-skipped PPS-06** (proposal dismiss during streaming) after fixing a real
  product bug: a mid-stream proposal dismiss did not stick.
- **Removed every `@quarantine` label.** 11 non-flaking specs were exercised at
  `repeat-each=20` to confirm stability before de-labelling; the genuinely flaky
  ones were hardened first, then de-labelled. Zero `@quarantine` labels remain.

The inventory also corrected a stale suspect list: `goal-creation`,
`stories-goal-routing`, and `verification-progress-indicator` were named as
intermittent offenders but did **not** flake under retry-free runs; all
previously-named specs are now hardened and de-labelled.

#### RCA-driven infra fixes

Recent stabilization work addressed contention at the scheduler, fixture, and
suite-layout layers:

- **Verification command scheduling.** Verification phases are the sole ordering
  mechanism: same-phase steps run concurrently by default, including command
  steps, and explicit sequencing should use different `phase` values.
  Component-linked `command: unit` steps also default to 1200s when no explicit
  timeout is set; other command steps keep the generic 300s default. Pinned by
  `tests/verification-harness-command-scheduling.test.ts`.
- **Activate-skill renderer fixture readiness.** The fixture used to let
  fully-parallel workers rebuild the same esbuild output file in place. A worker
  could load the bundle while another had truncated but not finished writing it,
  then hang waiting for `window.__ready`. The test now builds to a per-worker
  temp bundle and atomically replaces the shared bundle with retry-on-Windows
  rename handling.
- **E2E hotspot serialization.** The API project worker budget is two. Specs
  that create many git repositories or slow verification commands, such as the
  base-ref API/pinning specs and cancel-verification specs, opt into
  file-local serial mode so broad runs do not stack their hottest filesystem and
  child-process work.

For pack-specific UI changes, keep durable validation tied to the persistent
coverage contract: prefer node, fixture, or API coverage for matrices and add a
focused browser E2E only when the changed interaction needs real app integration.
The implementation gate should still run build, type-check, unit, and the full
E2E command before merge.

### Playwright transform-cache isolation

Run the root E2E suite through the npm wrapper:

```bash
npm run test:e2e
```

`npm run test:e2e` builds first, then calls `scripts/run-playwright-e2e.mjs`
before Playwright's CLI imports transform-cache modules. The wrapper creates a
run-scoped Playwright transform-cache root, injects
`scripts/playwright-e2e-cache-bootstrap.cjs` through `NODE_OPTIONS`, and gives
the runner plus each Playwright worker its own process-local `PWTEST_CACHE_DIR`.
It also disables Node's compile cache for the run.

This isolation matters because Bobbit agents often run E2E commands from
overlapping worktrees. Playwright's default transform cache is shared by temp
root, so concurrent cold imports can reuse partial or stale transforms and show
false startup errors such as missing ESM exports. Setting the cache before
Playwright imports its cache code avoids that cross-worktree sharing.

Supported knobs:

- `BOBBIT_E2E_PWTEST_CACHE_ROOT` — canonical base root override. The wrapper
  creates `pwtest-transform-cache/<run-id>` below this root.
- `BOBBIT_PWTEST_CACHE_ROOT` — legacy alias for the same base root. The
  E2E-prefixed variable wins when both are set.
- `BOBBIT_E2E_RUN_ID` — optional run-id segment for deterministic cache paths.
- `BOBBIT_KEEP_PWTEST_CACHE=1` — keep an owned run cache after the command for
  inspection.
- `BOBBIT_DEBUG_PWTEST_CACHE=1` — print the run cache root at startup.

Direct Playwright invocations are fallback-only:

```bash
npx playwright test --config playwright-e2e.config.ts
```

`playwright-e2e.config.ts` sets a run cache if `PWTEST_CACHE_DIR` is missing,
and the bootstrap can derive one when preloaded with the cache-root env vars.
That protects worker startup, but it is weaker than the npm wrapper because the
direct `npx` runner may have already imported Playwright's default transform
cache before the config executes.

### E2E summary and exit code (masked-failure guard)

`scripts/run-playwright-e2e.mjs` spawns Playwright with `stdio: "inherit"` and
its exit code is **exactly** Playwright's own process exit code (or the
re-raised signal) — nothing in the wrapper changes pass/fail based on parsed
output. The reason that matters: on a run with heavy scrollback, an ANSI
cursor-movement/erase sequence can land immediately before Playwright's own
human-readable `list`/`line` reporter's "N failed" line, so a naive
substring/regex match over raw stdout can see nothing where a human eye sees
the failure plainly — this silently masked real failures across five merge
windows before it was root-caused.

The fix is a second, independent signal, never used to gate the exit code but
always used for the human-facing pass/fail summary: the wrapper also asks
Playwright for its built-in `json` reporter (written to a run-scoped file via
`BOBBIT_E2E_JSON_REPORT_PATH`, wired in `playwright-e2e.config.ts`), reads that
file back after the child exits, and derives one plain, ANSI-free line —
`[e2e-summary] passed=<n> failed=<n> flaky=<n> skipped=<n> didNotRun=<n>
total=<n>` — via the pure `summarizePlaywrightReport()` /
`formatE2ESummaryLine()` functions in
[`scripts/playwright-json-summary.mjs`](../scripts/playwright-json-summary.mjs)
(unit-tested in `tests/playwright-json-summary.test.ts`). `didNotRun` is split
out from Playwright's own `stats.skipped` by walking the suite tree for tests
with zero results — an interrupted run (e.g. `--max-failures`) otherwise gets
conflated with genuinely `.skip()`-marked tests. Reading and parsing the JSON
report is best-effort: a parse failure logs `[e2e-summary] status=unavailable
reason=...` (never the `passed=/failed=...` shape, so a gate parser can't
mistake "unavailable" for "zero everywhere") and never changes the wrapper's
exit code. The same summary line, plus an
`exitCode`/`signal`/`generatedAt` artifact, is also written under
`test-results/e2e-summary/<runId>.json` for gate tooling that wants
machine-readable counts without re-parsing stdout.

The unit phase has its own analogue in `scripts/run-unit.mjs`: it derives a
`[unit-summary] node=<pass|fail|skip> browser=<pass|fail|skip>` line from the
two spawned sub-runners' exit codes (`computeUnitSummary()` /
`formatUnitSummaryLine()` in
[`scripts/unit-summary.mjs`](../scripts/unit-summary.mjs), pinned by
`tests/unit-summary.test.ts`). On top of that, a **masked-failure
cross-check** runs in the opposite direction from the E2E mechanism: a
sub-runner reporting exit 0 is not trusted blindly — its captured output tail
is scanned by `detectMaskedFailureCount()` for an unambiguous failure count
(node's TAP `# fail N` for `node-logic`, Playwright's `N failed` for
`browser-fixtures`), and a reported-0 result is promoted to a failing exit
with a `[run-unit] ... masked-failure guard` warning if one is found. It
never overrides an already-failing code. The motivating incident: 13 real
browser-fixture failures were observed alongside a 0 exit code on a loaded
shared machine (pinned by `tests/run-unit-wrapper.test.ts` and
`tests/unit-summary.test.ts`).

### Windows temp root

Windows `%LOCALAPPDATA%\Temp\` is scanned by Defender and has historically been
the hottest filesystem path on the machine. The E2E harnesses relocate their
scratch space:

- On Windows, the default temp root is `C:\bobbit-e2e\` (not `%LOCALAPPDATA%\Temp\bobbit-e2e\`).
- Override with `BOBBIT_E2E_TMP_ROOT` for ramdisks or CI runners with a
  dedicated scratch volume.
- Keep the temp-root logic in the harnesses and `tests/e2e/e2e-teardown.ts` in
  sync when editing.

### Teardown strategy

Per-worker teardown uses **fire-and-forget async `rm`** to release the worker as
soon as its tests finish. Global teardown (`tests/e2e/e2e-teardown.ts`) is a
safety net only:

- It removes the current run's legacy `BOBBIT_DIR` shapes when the env var
  identifies one.
- It removes old project-root `.e2e-worker-*` directories.
- Under the shared E2E temp root, it removes only modern `.e2e-inproc-*` and
  `.e2e-browser-*` harness directories whose encoded owner PID has exited.
- It removes an owned Playwright transform cache unless `BOBBIT_KEEP_PWTEST_CACHE=1` is set.

Per-worker teardown (in both `gateway-harness.ts` and `in-process-harness.ts`)
also calls `cleanupWorkerTempCwds()` (`tests/e2e/e2e-setup.ts`) to remove the
worker's memoized `nonGitCwd()`/`gitCwd()` directories. These live directly
under the shared E2E temp root (not under `bobbitDir`/`defaultProjectRoot`)
and were never removed before this fix (Finding W2.R) — every worker in every
run left one or two directories behind permanently, which is safe to delete
unconditionally at worker teardown since only that worker ever created them.

Do **not** change global teardown to sweep every `.e2e-*` directory under the
shared temp root. Overlapping worktrees and active E2E runs use the same root;
unknown or live directories must be left alone. Also do **not** re-add
synchronous `rmSync` to per-worker teardown. It serialises under filesystem
pressure and was one of the original causes of the flake pattern.

### Measurement protocol

Acceptance timing must use the exact command, including build and wrapper cache
isolation:

```bash
npm run test:e2e
```

For flake experiments, prefer the same wrapper with retries disabled:

```bash
npm run test:e2e -- --retries=0
```

If the build is already known fresh and you only need the Playwright portion,
this wrapper-backed equivalent is acceptable:

```bash
npm run test:e2e:run -- --retries=0
```

Run flake experiments repeatedly enough to distinguish suite-level contention
from one-off noise; three consecutive retry-free runs is the usual target for
changes to worker counts, temp/cache roots, teardown, or webServer hooks. Direct
`npx playwright test --config playwright-e2e.config.ts --retries=0` is only a
fallback when the npm wrapper is unavailable, and its runner-cache isolation is
weaker for the reason described above.

`--retries=0` is a measurement flag only. The committed E2E config keeps
`retries: 3` for normal runs as a deliberate resilience margin for concurrent
suites (see [Worker and retry counts](#worker-and-retry-counts)), so a transient
cross-suite race does not red-light an otherwise green run. Use `--retries=0`
only to surface first-attempt flakes during hardening or measurement, not as a
target for the committed config.

### What not to change without re-measuring

- Don't raise the top-level worker budget above 4, the `api` budget above 2, or
  the `browser` budget above 3 as a speed strategy. The budget is sized so up
  to ~4 suites can run
  concurrently without mutual contention; raising it to chase a faster
  single-suite wall manufactures exactly the cross-suite flakes the budget
  exists to prevent. A sub-5-min single-suite wall is explicitly out of scope.
- Don't reduce `retries: 3` to 0 in the committed config. It is the deliberate
  concurrent-robustness margin, not temporary debt — see
  [Worker and retry counts](#worker-and-retry-counts).
- Don't set `fullyParallel: true` on the `browser` or `api-realpush` projects.
- Don't serialise the whole `api` project; keep targeted hotspot specs serial
  instead. The in-process lane still benefits from limited parallelism at its
  current worker budget.
- Don't remove the wrapper-backed `npm run test:e2e` path or replace it with raw
  `npx` as the primary command.
- Don't remove `BOBBIT_E2E_TMP_ROOT`, `BOBBIT_E2E_PWTEST_CACHE_ROOT`, or the
  Windows `C:\bobbit-e2e\` default without measuring the filesystem impact.

If a future change must violate any of the above, re-run the measurement
protocol and update this section with the new numbers.
