# Reduce Server CPU — diagnostics and benchmark research

## Scope read

Read-only review covered:

- `src/server/agent/profiling.ts`
- `src/server/server.ts`
- `package.json` scripts
- E2E harness/config docs under `tests/e2e/` and Playwright configs

No production code or tests were changed.

## Existing profiling/timing surfaces

### `BOBBIT_E2E_PROFILE=1`

`src/server/agent/profiling.ts` is a process-local, env-gated timing helper.
When disabled, `profile()`, `profileAsync()`, `recordElapsed()`, and `bumpCount()` are direct passthroughs or no-ops.
When enabled, it keeps per-label samples and flushes a table to stderr every `BOBBIT_E2E_PROFILE_FLUSH_MS` milliseconds, defaulting to 5s, and again on process exit.

Current rows include `calls`, `p50`, `p95`, `p99`, `max`, `total`, and optional `extra` count.
Existing wrapped server paths include session creation/setup, prompt assembly/config discovery, tool-definition loading, and FlexSearch flushes.

Limitations for this goal:

- It measures wall-clock duration, not CPU.
- It stores all samples until reset/exit, which is fine for E2E diagnosis but not ideal for high-QPS CPU benchmarks.
- It writes to stderr. `npm run test:e2e` currently redirects Playwright stderr to `/dev/null`, so profile rows can be hidden. Use direct Playwright commands or scripts without stderr redirection for profiling.

Useful current commands:

```powershell
npm run build
$env:BOBBIT_E2E_PROFILE="1"; $env:BOBBIT_E2E_PROFILE_FLUSH_MS="10000"; npx playwright test --config playwright-e2e-standard.config.ts
$env:BOBBIT_E2E_PROFILE="1"; $env:BOBBIT_E2E_PROFILE_FLUSH_MS="10000"; npm run test:e2e:real
```

```bash
npm run build
BOBBIT_E2E_PROFILE=1 BOBBIT_E2E_PROFILE_FLUSH_MS=10000 npx playwright test --config playwright-e2e-standard.config.ts
BOBBIT_E2E_PROFILE=1 BOBBIT_E2E_PROFILE_FLUSH_MS=10000 npm run test:e2e:real
```

### `BOBBIT_TIMING_LOG=1`

`src/server/server.ts` wraps API request handling and logs slow REST calls:

```text
[timing] METHOD /api/path?query 123.4ms
```

It only prints calls taking at least 100ms. That is useful for slow endpoints but misses high-frequency fast routes that can still burn CPU.

Useful current command:

```powershell
$env:BOBBIT_TIMING_LOG="1"; npm run dev:harness
```

```bash
BOBBIT_TIMING_LOG=1 npm run dev:harness
```

## Minimal CPU diagnostics design

Add a new env-gated CPU diagnostics mode rather than a permanent endpoint.
Keep it disabled by default and safe to leave in tree.

Suggested flags:

- `BOBBIT_CPU_DIAG=1` — enable diagnostics.
- `BOBBIT_CPU_DIAG_FLUSH_MS=1000` — interval, default 1000ms.
- `BOBBIT_CPU_DIAG_JSONL=/path/report.jsonl` — optional file target; otherwise stderr.

Interval metrics:

- `pid`, timestamp, interval wall ms.
- `process.cpuUsage()` delta split into user/system ms.
- CPU percent normalized to one core: `(cpuMs / wallMs) * 100`.
- `performance.eventLoopUtilization()` delta.
- Event-loop delay from `monitorEventLoopDelay()`: mean, p95, max.
- Memory: RSS, heap used/total, external.
- Active handle/request counts, best-effort and sampled only on flush, with categories such as `Timeout`, `Socket`, `Server`, `ChildProcess`.
- REST counters by normalized route: count, status buckets, total/p95 duration.
- WebSocket counters: connected clients, sends, bytes, broadcasts by event type, stringify/send time.
- Session/goal state gauges: live sessions by status, active goals, team agents, active verifications.

Output format should be JSONL for reproducible reports, with optional human summary rows. Example shape:

```json
{"kind":"cpu","ts":1779220000000,"pid":1234,"wallMs":1001,"cpuUserMs":42,"cpuSystemMs":8,"cpuPct":5.0,"elu":0.031,"delayP95Ms":7.2,"rssMb":210,"handles":{"Socket":7,"Timeout":5}}
```

Implementation notes for a later PR:

- Put the sampler next to `profiling.ts` or extend that module; compute the env constant once at module load.
- When disabled, exported recorders must return immediately without allocating.
- Use interval aggregation, not unbounded per-event sample arrays, for high-volume routes/events.
- Do not expose a user-facing REST endpoint in the first PR. Logs/files are enough for benchmark evidence.

## Low-risk instrumentation points

In `src/server/server.ts`:

1. Request handler around `handleApiRoute()`
   - Normalize route labels, count every API call, record duration/status.
   - Keep `BOBBIT_TIMING_LOG` behavior intact.

2. WebSocket broadcast helpers
   - `broadcastToAll`, `broadcastToGoal`, `broadcastToProject`, and `broadcastToSession` can record event type, clients scanned, clients sent, bytes, and stringify/send elapsed time.
   - This is a strong candidate because these helpers are centralized and already stringify once per broadcast.

3. Gateway startup/shutdown
   - Record boot/background-task spans for `restoreSessions`, verification resume, sweeper, and worktree-pool init.
   - Existing `[boot]` logs already give wall time; CPU sampler would add CPU attribution.

4. Long-poll wait endpoint
   - Count active `/api/sessions/:id/wait` requests and heartbeat writes so idle CPU from many waits is visible.

5. Existing `profiling.ts` call sites
   - Keep the current timing wrappers for setup hot paths and correlate their totals with CPU intervals.

Avoid first-pass instrumentation in deep agent internals unless the benchmark points there. Start with process-level CPU plus centralized REST/WS counters.

## Benchmark harness design

Use a driver that spawns the gateway as a child process so gateway CPU is not mixed with Playwright/test-driver CPU.
The existing in-process E2E harness is excellent for functional tests but cannot cleanly attribute `process.cpuUsage()` to the gateway alone because gateway and test code share a Node process.

Suggested future command surface:

```powershell
npm run build:server
node scripts/bench-server-cpu.mjs --workload idle --duration 60 --runs 3 --out artifacts/cpu/idle.jsonl
node scripts/bench-server-cpu.mjs --workload stream --sessions 1 --duration 60 --runs 3 --out artifacts/cpu/stream.jsonl
node scripts/bench-server-cpu.mjs --workload multi-tabs --tabs 5 --duration 60 --runs 3 --out artifacts/cpu/multi-tabs.jsonl
node scripts/bench-server-cpu.mjs --workload goal-team --agents 3 --runs 3 --out artifacts/cpu/goal-team.jsonl
```

The driver should launch:

```bash
BOBBIT_CPU_DIAG=1 \
BOBBIT_CPU_DIAG_FLUSH_MS=1000 \
BOBBIT_E2E_PROFILE=1 \
BOBBIT_TIMING_LOG=1 \
BOBBIT_SKIP_MCP=1 \
BOBBIT_SKIP_AIGW_DISCOVERY=1 \
BOBBIT_SKIP_TITLE_GEN=1 \
BOBBIT_NO_OPEN=1 \
node dist/server/cli.js --host 127.0.0.1 --port 0 --cwd <temp-project> --no-ui --no-tls --auth --agent-cli tests/e2e/mock-agent.mjs
```

Then read `<temp-project>/.bobbit/state/gateway-url` and token, drive HTTP/WS workload traffic, collect JSONL, and terminate the child cleanly.

## Workload definitions

Run each workload at least 3 times on the same machine/commit. Report median plus min/max or IQR. Record OS, Node version, CPU core count, commit SHA, env flags, duration, and whether child agents/browsers were included.

1. **Idle gateway / no agents**
   - Start gateway with `BOBBIT_SKIP_MCP=1`, `BOBBIT_SKIP_WORKTREE_POOL=1`, no browser.
   - Wait 60s after boot.
   - Primary metrics: CPU%, ELU, event-loop delay, active handles/timers.

2. **Boot/background tasks**
   - Run once with worktree pool disabled and once enabled on a git fixture.
   - Measure boot to listen, background-task completion, CPU burst, git child-process count if available.

3. **Active chat/session streaming**
   - Create one session using `tests/e2e/mock-agent.mjs`.
   - Open session WS, send a prompt, wait for idle, repeat for a fixed count or duration.
   - Metrics: gateway CPU%, REST latency, WS sends/sec, bytes/sec, event-loop delay, prompt round-trip latency.

4. **Multiple open sessions/browser tabs**
   - Create N sessions and connect N session WebSockets plus one viewer/dashboard WS.
   - Optionally use headless Chromium only for a browser-specific variant.
   - Keep mostly idle for 60s, then trigger one streaming session.
   - Metrics: idle CPU with many sockets, broadcast fan-out counts, reconnect/errors.

5. **Goal/team workflow activity**
   - Create a workflow goal, start team, spawn 2–3 mock role agents, steer/prompt them, and signal a gate.
   - Metrics: CPU during team state changes, gate verification broadcasts, REST latency, active verification gauges.

6. **E2E-like load**
   - Use existing suites for regression context, not primary CPU attribution:
     - `BOBBIT_CPU_DIAG=1 BOBBIT_E2E_PROFILE=1 npx playwright test --config playwright-e2e-standard.config.ts`
     - `BOBBIT_CPU_DIAG=1 BOBBIT_E2E_PROFILE=1 npm run test:e2e:real`
   - Treat in-process harness CPU as mixed gateway/test-driver CPU unless the gateway is spawned separately.

## Report format for the eventual PR

For each workload:

- Workload command and env.
- Baseline commit and candidate commit.
- Median gateway CPU%, p95 event-loop delay, REST p95, WS sends/sec/bytes/sec.
- Functional assertions: no missed WS events, stale session state, or failed tests.
- Hypothesis tested, result, and decision: kept or rejected.

Suggested meaningful-improvement threshold for small changes: at least 10–15% lower median gateway CPU under a representative workload with no more than 5% regression in REST latency/event-loop delay elsewhere.
