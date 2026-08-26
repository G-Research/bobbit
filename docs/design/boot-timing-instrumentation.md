# Boot/reload performance instrumentation

Opt-in instrumentation that measures full-page reload and session transcript
hydration costs with hard numbers, so reload and cold-navigation changes can be
evaluated with data instead of estimates.

## Why

A full reload under Vite dev re-does two expensive things: re-evaluating the
unbundled module graph (the dev module waterfall) and rehydrating session state
(WebSocket reconnect + `get_messages` transcript snapshot replay + full
`MessageList` re-render). Cold session navigation uses the same transcript path.
Both resist a small time budget, and snapshot rendering scales with transcript
length. Rather than guess, this feature records named milestones and writes them
somewhere agents can inspect.

## Surface

- **Toggle**: Settings header, next to **Restart Server**
  (`renderPerfInstrumentationToggle` in `src/app/settings-page.ts`). Gated to
  **dev-harness mode only** — same gate as Restart Server
  (`/api/harness-status` → `BOBBIT_DEV_HARNESS === "1"`).
- **Persistence**: server preference `devPerfInstrumentation`, mirrored to the
  `bobbit-perf-instrumentation` localStorage key. The localStorage mirror is the
  synchronous source of truth that **arms the next reload** (it must be readable
  before the module graph finishes evaluating); the server preference is the
  durable record and seeds a fresh browser's mirror via `loadHarnessStatus`.

## Client (`src/app/boot-timing.ts`)

- Gated at runtime by the localStorage mirror — **no `__BOBBIT_DEV__`
  compile-time gate**, so it ships in production but is a cheap boolean
  early-return when disarmed.
- `bootMark(name)` records `performance.now()` (ms since navigation start) at:
  `modules-evaluated` (main.ts, after the eager graph evaluates),
  `initApp-start`, `first-render-call` (main.ts), `first-paint`
  (`pwa-lifecycle.ts::finalizeBoot`, when `#app` actually paints), `ws-open`,
  `auth-ok` (WS auth handshake done — splits the ws-open→snapshot window into
  handshake vs. server-side snapshot wait), `get-messages-sent`,
  `snapshot-received(N msgs)`, `snapshot-applied`, `post-snapshot-paint`
  (`remote-agent.ts`). The raw snapshot frame size is captured as `snapshotChars`
  to distinguish payload transfer cost from server-side assembly.
- **Server-side snapshot breakdown** (dev harness only): the `get_messages`
  handler attaches a `SnapshotServerTiming` (`rpcMs` agent assembly /
  `pipelineMs` server transform / `stampMs` / `stringifyMs` / `bytes` /
  `msgCount`) to the `messages` frame, captured into the sample's `serverTiming`
  field — so the ws-open→snapshot gap is fully attributed end to end.
- One terminal report per load (idempotent): logs a `console.table` and POSTs
  the sample to the sink. Triggered immediately after the session snapshot
  paints, with a 3s idle-debounce fallback for no-session views.
- `window.__bobbitBootTimings` always holds the latest sample for ad-hoc
  devtools inspection (`copy(window.__bobbitBootTimings)`).

## Server sink

- `src/server/dev-boot-timing.ts`: `recordBootTiming` / `readBootTimings`. The
  log is capped append-only JSONL — trimmed to the most recent 300 entries once
  it passes 1 MB; oversized (>64 KB) or non-object samples are rejected.
- Routes in `server.ts`, both **harness-gated** (403 otherwise):
  - `POST /api/dev/boot-timing` → appends one sample, returns the file path.
  - `GET  /api/dev/boot-timing?limit=N` → recent samples (newest last).
- **Known location for agents**: `<stateDir>/boot-timing.jsonl`
  (i.e. `.bobbit/state/boot-timing.jsonl` in the server cwd). Inspect with
  `tail -f .bobbit/state/boot-timing.jsonl` or `GET /api/dev/boot-timing`.

## Reading a sample

Each JSONL line carries `reason`, `isReload`, `total_ms`, `route`, `sessionId`,
`transcriptMessages`, `marks[]`, and a `rows[]` table with per-phase
`Δ prev (ms)` deltas — the delta column shows where the time actually goes
(module waterfall vs. first paint vs. snapshot replay).

## Cold session navigation invariant

A cold switch to an existing session must start transcript transfer before
unrelated REST work. `connectToSession` in the session manager therefore owns
the initial sequence:

1. After initial WebSocket authentication resolves, call
   `RemoteAgent.requestMessages()` as the first post-auth action. This emits
   `get-messages-sent` and sends `get_messages`.
2. Only then may side-panel workspace, proposal, draft, git, project/goal, or
   session-list REST hydration start.
3. Bind the transcript-bearing agent to the chat panel, then perform the single
   initial side-panel workspace hydration.

This ordering matters because the transcript is the primary session content;
side-panel latency must not hold it behind an independent REST request. The
initial `RemoteAgent` auth handler does not hydrate the workspace. `RemoteAgent`
retains ownership of workspace hydration after non-initial authentication, so
reconnects still refresh server state without duplicating the normal cold-load
fetch.

Workspace responses remain session-keyed. They can refresh the abandoned
session's keyed cache, but compatibility/foreground mirrors update only when
that session is still active. The session manager also checks the captured
switch generation and selected session after asynchronous boundaries. Together,
these guards prevent a late A response from overwriting B during an A→B switch,
while preserving the exact cached agent and panel on A→B→A switch-back. The
scheduling change does not remove hydration: side-panel tabs, active tab, size
mode, proposals, and review documents still restore through their existing
guarded paths. Workspace revision and conflict rules are unchanged.

`tests/dom/cold-session-workspace-ordering-repro.dom.test.ts` pins this contract. It
holds workspace hydration open while verifying that all 321 transcript rows
render, `get_messages` precedes relevant REST requests, and only one initial
workspace GET occurs. It also covers rapid navigation, pre-bind stale responses,
workspace/review restoration, reconnect hydration, and cached switch-back. The
committed test pins the 321-row render-before-workspace and single-fetch behavior;
it does not run the seven timing samples, impose the benchmark's 250 ms delay, or
assert the measurements below.

## Controlled one-off cold-navigation evidence

The following numbers are controlled one-off benchmark evidence, not a
repository-reproducible benchmark or a timing threshold for arbitrary hosts. The
fixed tree was `a4a811d75d05c76aabdab2108863a42c2b058cb5`; the measured
pre-fix tree was `3ee000bb06b12e1f3bc5b80573cca9a67bafa427`. In the pre-fix
tree, `connectToSession` awaited workspace hydration before requesting messages,
while the initial `RemoteAgent` auth handler independently started a second
workspace hydration.

The exact source SHAs, environment, raw values, and method keep the result
interpretable. However, the measurement harness and Vitest config lived under
ignored `.bobbit/tmp` paths and were not retained in the repository. Re-running
this comparison requires recreating that temporary fixture from the committed
DOM regression test and running it against the actual fixed and pre-fix source
trees; the commands below are therefore historical invocation records, not
turnkey repeat commands.

### Environment and method

- Windows 11 `10.0.26200` x64; AMD Ryzen AI 9 HX 370; 24 logical CPUs; 63.1 GiB
  RAM.
- Node 24.13.1 / V8 13.6; Vitest 4.1.10 with happy-dom; one worker and
  `retry: 0`.
- The ignored fixture was derived from
  `tests/dom/cold-session-workspace-ordering-repro.dom.test.ts`. It used a
  321-record transcript and a real 250 ms `setTimeout` in the workspace endpoint
  for seven sequential cold samples per variant.
- Controlled WebSocket snapshots were delivered in a microtask. This excludes
  real network latency, server assembly, and transport time so the comparison
  isolates client request ordering and local rendering.
- The clock started immediately before `connectToSession`, so this was a DOM cold
  session switch—not a full app reload or deep-link. In contrast, the normal
  full reload/deep-link instrumentation described above begins at browser
  navigation, includes module and app boot, and writes its completed samples to
  the JSONL sink.
- Production code emitted `auth-ok`, `get-messages-sent`,
  `snapshot-received(321 msgs)`, and `snapshot-applied`. Ready meant transcript
  row 321 was present in the DOM and two `requestAnimationFrame` turns had
  completed, matching the post-snapshot-paint boundary.
- Baseline assertions required auth→request to be at least 235 ms and observed
  two workspace GETs in every baseline sample. This proved the fixture exercised
  the blocking and duplicate-hydration regression rather than merely comparing
  noisy runs.

### Recorded commands

Fixed variant:

```bash
MEASURE_VARIANT=fixed MEASURE_SOURCE_SHA=a4a811d75d05c76aabdab2108863a42c2b058cb5 MEASURE_TRANSCRIPT_SIZE=321 MEASURE_SAMPLE_COUNT=7 MEASURE_WORKSPACE_DELAY_MS=250 node node_modules/vitest/vitest.mjs run --config .bobbit/tmp/cold-load-measure/vitest.measure.config.ts
```

Baseline variant, run from a temporary detached worktree at the pre-fix SHA:

```bash
MEASURE_ROOT=.bobbit/tmp/cold-baseline MEASURE_VARIANT=baseline MEASURE_SOURCE_SHA=3ee000bb06b12e1f3bc5b80573cca9a67bafa427 MEASURE_TRANSCRIPT_SIZE=321 MEASURE_SAMPLE_COUNT=7 MEASURE_WORKSPACE_DELAY_MS=250 node node_modules/vitest/vitest.mjs run --config .bobbit/tmp/cold-baseline/.bobbit/tmp/cold-load-measure/vitest.measure.config.ts
```

The referenced configs, generated measurement test, and temporary baseline
worktree are absent from the repository. Recreate them before using these
invocations.

### Raw samples

All timing values are milliseconds; values within each cell are in run order.

| Metric | Pre-fix | Fixed |
|---|---|---|
| auth→request | `[255.375, 251.248, 253.282, 255.059, 259.189, 254.873, 261.206]` | `[0.471, 0.017, 0.011, 0.015, 0.015, 0.022, 0.014]` |
| auth→snapshot | `[255.935, 251.566, 254.032, 255.401, 259.689, 255.894, 261.578]` | `[1.063, 0.290, 0.256, 0.254, 0.260, 0.543, 0.329]` |
| navigation→ready | `[271.247, 258.330, 260.970, 259.569, 267.590, 269.112, 267.751]` | `[16.519, 5.747, 7.079, 3.856, 6.813, 5.835, 4.090]` |
| Workspace GETs | `2` in every sample | `1` in every sample |

### Median result

| Metric | Pre-fix | Fixed | Change |
|---|---:|---:|---:|
| auth→request | 255.059 ms | 0.015 ms | −255.044 ms |
| auth→snapshot | 255.894 ms | 0.290 ms | −255.605 ms (−99.9%) |
| navigation→ready | 267.590 ms | 5.835 ms | −261.756 ms (−97.8%) |
| Workspace GETs | 2 | 1 | one initial owner |

The fixed transcript became ready about 244 ms before the delayed workspace
response. For the fixed 321-record case, the median request→receipt time was
0.273 ms, snapshot receipt→apply was 0.252 ms, and receipt→ready was 4.862 ms.
The result isolates the intended change: transcript startup no longer inherits
workspace latency, and duplicate initial hydration is gone.

### Transcript-size scaling

Fixed-tree medians from the same controlled setup show the remaining local cost:

| Records | request→receipt | receipt→apply | receipt→ready | navigation→ready |
|---:|---:|---:|---:|---:|
| 1 | 0.084 ms | 0.025 ms | 0.565 ms | 1.057 ms |
| 101 | 0.174 ms | 0.104 ms | 1.939 ms | 2.558 ms |
| 321 | 0.273 ms | 0.252 ms | 4.862 ms | 5.835 ms |
| 641 | 0.430 ms | 0.440 ms | 12.840 ms | 13.681 ms |

This controlled DOM benchmark excludes real server assembly and network transfer
latency, both of which remain after the request is sent immediately. Within the
controlled path, rendering is now the dominant transcript-size-dependent local
cost. This fix intentionally makes no snapshot protocol change. If real large
histories show material latency, evaluate pagination or streaming for transfer
and virtualized rendering for local paint as follow-up work.

## Tests

- `tests/dom/cold-session-workspace-ordering-repro.dom.test.ts` — cold transcript
  ordering, one initial workspace owner, stale navigation, reconnect, and cache
  preservation.
- `tests/unit/core/dev-boot-timing.unit.test.ts` — sink append/parse, directory creation,
  limits, malformed entries, and trimming.
- `tests/integration/gateway/dev-boot-timing-api.gateway.test.ts` — endpoint gating, write/read
  under the harness, and invalid-body rejection.
