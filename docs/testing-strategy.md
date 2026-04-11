# Testing Strategy — Assessment & Path Forward

## Current State

### Test Inventory

| Layer | Files | Tests | Runtime | Parallelism |
|-------|-------|-------|---------|-------------|
| Unit (file:// fixtures + Node) | ~105 | ~625 | <30s | Full (Playwright workers) |
| API E2E (in-process gateway) | 69 | ~438 | ~60s | 4 workers |
| Browser E2E (spawned gateway) | ~32 | ~140 | ~90s | 2 workers |
| Manual integration (real agent + Docker) | 1 | 8 serial steps | ~5 min | **None** |
| **Total** | **~207** | **~1,211** | **~3 min + 5 min manual** | |

### What Each Layer Actually Tests

**Unit tests** — Isolated UI components via `file://` fixtures. Good at catching rendering regressions (markdown, git-status-widget `.trim()` bug, mobile header). Cannot test anything involving server communication.

**API E2E** — Server-side CRUD and protocol correctness. Strong coverage of goals, gates, tasks, roles, tools, config cascade, sessions. Uses in-process gateway — fast but no browser, no Docker. Tests the *contract* but not the *wiring*.

**Browser E2E** — Full-stack user journeys through Playwright browser → WebSocket → spawned gateway → mock agent. Covers goal creation, project management, settings, team lifecycle, navigation. **This is where the gap is widest.**

**Manual integration** — The gold standard. Real agent, real Docker, real crash recovery. Tests 6 session variations × crash/restart cycle × browser verification. Catches bugs no other layer can reach.

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
| `personality-selector.spec.ts` | PI-22 | Personality selector chip UI |
| `personality-tool-renderer.spec.ts` | PI-22 | Personality tool renderers |
| `queue-dispatch.spec.ts` | PI-25, PI-21b | PromptQueue batching, resetDispatched, dequeueAllSteered, force-kill recovery, aborting status |
| `draft-persistence.spec.ts` | PI-04b, PI-04c | Draft flush promise return, rAF retry replacing queueMicrotask |
| `review-annotation-focus.spec.ts` | PI-24b | Focus restoration to message editor after annotation cancel |

**Browser E2E tests** cover flows that need a real server:

| Test file | Stories | What it tests |
|-----------|---------|---------------|
| `prompt-stats-e2e.spec.ts` | PI-15, PI-17, PI-18, PI-23 | Model selector persistence, context/cost stats with real usage data |
| `personality-e2e.spec.ts` | PI-22 | Personality selector with server-side config |
| `abort-status-e2e.spec.ts` | PI-21b, PI-25 | Aborting status broadcast via WS, steered message queue reorder on abort |

PI-10 (steer) has API-level coverage in `steer-midturn.spec.ts`. PI-05 has E2E coverage in `slash-skill-e2e.spec.ts`.

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

### Harness selection

The E2E suite provides two harnesses. Choose based on what your test needs:

- **`in-process-harness.js`** — Default for API-only tests (no browser, no MCP, no process-level behavior). Faster startup (~2s vs ~5-8s per worker). Exposes `sessionManager` on `GatewayInfo` for sandbox token testing. Import `test, expect` from `./in-process-harness.js`.
- **`gateway-harness.js`** — Required when the test uses a `page` fixture (browser), needs MCP servers enabled, or tests process-level behavior (port allocation, auth bypass). Import `test, expect` from `./gateway-harness.js`.

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

### Mock agent keywords

The mock agent in `tests/e2e/mock-agent.mjs` responds to keywords in the prompt. Send `GOAL_PROPOSAL` to trigger a `propose_goal` tool call response (with `options: "QA testing"`) — used to test the goal assistant flow without a real LLM.

## Manual Integration Tests

Full-stack resilience tests that use real agents and real Docker containers — no mocks. Defined in `tests/manual-integration/session-resilience.spec.ts`, configured by `playwright-manual.config.ts`. **Not included in `npm test`, `npm run test:unit`, or `npm run test:e2e`.**

```bash
npm run test:manual                 # Headless, API assertions only (~5 min)
SCREENSHOTS=1 npm run test:manual   # + browser screenshots + HTML report
```

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
