# Boot/reload performance instrumentation

Opt-in instrumentation that measures the cost of a full page reload with hard
numbers, so we can reason about reload disruption (e.g. while an agent is
editing UI code under Vite) with data instead of estimates.

## Why

A full reload under Vite dev re-does two expensive things: re-evaluating the
unbundled module graph (the dev module waterfall) and rehydrating session state
(WebSocket reconnect + `get_state` snapshot replay + full `MessageList`
re-render). Both resist a small time budget, and the snapshot replay scales with
transcript length. Rather than guess, this feature records named milestones
across a reload and writes them somewhere agents can inspect.

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
  handshake vs. server-side snapshot wait), `snapshot-received(N msgs)`,
  `snapshot-applied`, `post-snapshot-paint` (`remote-agent.ts`). The raw
  snapshot frame size is captured as `snapshotChars` to distinguish payload
  transfer cost from server-side assembly.
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

## Tests

- `tests/dev-boot-timing.test.ts` — sink: append/parse, dir creation, limit,
  rejection of non-object/oversized samples, byte-cap trimming, malformed-line
  skipping.
- `tests/e2e/dev-boot-timing-api.spec.ts` — endpoint gating (403 off-harness),
  write+read-back under the harness, 422 on a non-object body.
- `tests/e2e/ui/perf-instrumentation-toggle.spec.ts` — toggle hidden without the
  harness; visible/toggles/persists-across-reload and arms reload
  instrumentation under the harness.
