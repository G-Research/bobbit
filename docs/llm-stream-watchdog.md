# LLM Stream Watchdog

Per-session inactivity timer that detects silent LLM-stream stalls and converts
them from forever-hangs into a recoverable errored turn — automatically and,
where possible, transparently.

## Motivation

Sessions occasionally wedged in `status: "streaming"` indefinitely. The
diagnostic signature was always the same:

- Agent process alive, event loop idle.
- One `Established` TCP socket to the model provider.
- No JSONL frames out of the agent for several minutes.
- No pending tool grant, no error, no exit.
- UI showed the Stop spinner forever; only a manual Stop / restart-agent / kill
  cleared it.

Root cause is upstream: the agent (`@mariozechner/pi-coding-agent` /
`pi-ai`) `await fetch(...)`s the streaming model response and reads chunks
with no inactivity timeout. When the upstream stream goes silent (provider
hiccup, silently half-closed TLS, NAT/keep-alive death), `reader.read()`
never resolves and never rejects.

The watchdog turns this into a finite failure mode.

## Design choice: bobbit boundary, not pi-ai

Two layers were viable:

1. **Patch `pi-ai`** to wrap the network read in a `Promise.race([read, sleep])`
   and bubble an `AbortError`. Cleanest — the abort fires on actual byte-level
   silence.
2. **Watch JSONL frames at the bobbit ↔ agent boundary** and abort via the
   existing RPC abort path.

We took option 2. The trade-off — frame inactivity is a coarser proxy than
network inactivity, because a long-running tool call (e.g. a 5-minute test
suite) would also produce a frame gap — is solved by an `awaitingLlmFrame`
flag. The watchdog only fires when the agent is waiting on the LLM, never
while a tool is executing.

This avoided a cross-repo PR and kept the recovery story self-contained.

## Lifecycle

The watchdog is armed and disarmed by `onAgentEvent()` in
`src/server/agent/stream-watchdog.ts`, called from `handleAgentLifecycle`.

| Agent event           | `awaitingLlmFrame` | Timer        | Notes                                       |
|-----------------------|--------------------|--------------|---------------------------------------------|
| `agent_start`         | `true`             | armed        | New turn — start watching.                  |
| `message_update`      | unchanged          | unchanged    | Activity — refreshes `lastLlmFrameAt`.      |
| `message_end`         | unchanged          | unchanged    | Activity — refreshes `lastLlmFrameAt`.      |
| `tool_execution_start`| `false`            | running, idle| Don't abort while a tool is doing real work.|
| `tool_execution_end`  | `true`             | re-armed     | Back to waiting on the LLM.                 |
| `agent_end`           | `false`            | running, idle| Resets `streamStallRetries` if not mid-retry.|
| `process_exit`        | `false`            | disposed     | Idempotent cleanup.                         |

The timer ticks on `setInterval(max(50, timeoutMs/2))`, is `unref()`'d so it
doesn't keep the process alive, and is disposed on `process_exit` or when
`isAlive(sessionId)` reports the session has been removed.

## Stall handling

When the watchdog tick observes `awaitingLlmFrame === true` and
`Date.now() - lastLlmFrameAt >= timeoutMs`, it calls `handleStreamStall()`.

### Silent retry (attempts 1..maxRetries)

1. `streamStallRetries` is incremented.
2. `suppressNextDrainForStallRetry` and `suppressNextErrorMessageEnd` are set
   so the upcoming `message_end{stopReason:"error", errorMessage:"Request
   aborted"}` (the real agent emits this on every abort) does NOT advance
   `consecutiveErrorTurns` and does NOT broadcast idle / drain the queue.
3. `rpcClient.abort()` cancels the in-flight request.
4. On the next tick the watchdog re-issues `lastPromptText` /
   `lastPromptImages` via `rpcClient.prompt(...)`, refreshes
   `lastLlmFrameAt`, and re-arms.

The session never leaves `streaming`. The transcript shows nothing.

### Surfaced stall (attempt maxRetries + 1)

1. `streamStallRetries` resets to 0.
2. `consecutiveErrorTurns` increments by exactly 1.
3. `lastTurnErrored` set to `true`; `lastTurnErrorMessage` set to the
   stalled-stream text.
4. `suppressNextErrorMessageEnd` is set so the abort's "Request aborted"
   frame doesn't double-bump the counter or clobber the error message.
5. A synthetic `message_end{stopReason:"error", errorMessage:"Model stream
   stalled — no frames for Xs (attempted N× before giving up)."}` is
   broadcast via `session.emitSyntheticEvent`, so the UI renders the
   stalled-stream text in the transcript (the UI's `Messages.ts` reads
   `errorMessage` off the `message_end` frame — `lastTurnErrorMessage`
   alone is not enough).
6. `rpcClient.abort()` runs.

The session leaves `streaming` via the standard idle broadcast and the user
sees a normal errored turn. They can prompt again — the existing implicit
unstick path (see [debugging.md → Session wedged after errored turn](debugging.md#session-wedged-after-errored-turn))
will dispatch the next message with the usual `[SYSTEM: previous turn failed
with: …]` stub.

### Counter semantics

- **Silent retries do not bump `consecutiveErrorTurns`.** This is the design
  invariant — silent recovery must be invisible to the implicit-unstick cap.
- **Surfaced stalls bump `consecutiveErrorTurns` by exactly 1.** Three
  back-to-back surfaced stalls trip `MAX_CONSECUTIVE_ERROR_TURNS = 3` and
  the next incoming prompt is parked in `promptQueue` until the user clicks
  Retry. This is the same path as any other repeated upstream failure.

### User-Stop race

If the user clicks Stop while a silent retry is in-flight,
`session.status === "aborting"`. `shouldSuppressDrainForStallRetry()` clears
the suppression flag and returns `false`, letting the standard `wasAborting`
cleanup path broadcast idle and drain the queue. The user's Stop always
wins; the session never gets stuck in `aborting`.

## Configuration

| Env var                          | Default | Effect                                  |
|----------------------------------|---------|-----------------------------------------|
| `BOBBIT_LLM_STREAM_TIMEOUT_MS`   | `30000` | Inactivity threshold. `0` disables the watchdog entirely. |
| `BOBBIT_LLM_STREAM_MAX_RETRIES`  | `2`     | Silent retries before surfacing. Total attempts = `MAX_RETRIES + 1`. |

Resolution lives in `resolveWatchdogConfigFromEnv()` and is called on every
agent event, so operators can flip the threshold without a server restart
(env mutation requires `BOBBIT_LLM_STREAM_*` to be exported in the gateway's
process environment).

NaN-guarded: a non-numeric env value (`""`, `"foo"`, etc.) collapses to the
default rather than disabling the watchdog by accident.

## Telemetry

Every stall emits one greppable line per attempt:

```
[stream-watchdog] session=c3d43268 pid=12345 last-frame-age=30041ms attempt=1/3 — aborting turn
[stream-watchdog] session=c3d43268 silent-retry 1/2
[stream-watchdog] session=c3d43268 pid=12345 last-frame-age=30022ms attempt=2/3 — aborting turn
[stream-watchdog] session=c3d43268 silent-retry 2/2
[stream-watchdog] session=c3d43268 pid=12345 last-frame-age=30015ms attempt=3/3 — aborting turn
```

Grep recipes:

```bash
# All stalls across all sessions
grep '\[stream-watchdog\]' server.log

# Surfaced stalls (3rd+ attempt) for a given session
grep '\[stream-watchdog\] session=c3d43268.*attempt=3/' server.log

# Sessions that recovered silently (saw a retry but never a surfaced one)
grep '\[stream-watchdog\]' server.log | grep -v attempt=3/
```

`pid` is best-effort: it reads through to the production `RpcBridge`'s
child-process handle, falling back to `?` for in-process test mocks.

## Interaction with other systems

- **`MAX_CONSECUTIVE_ERROR_TURNS = 3` implicit-unstick** — the watchdog
  participates as one error source among others. See above and
  [debugging.md → Session wedged after errored turn](debugging.md#session-wedged-after-errored-turn).
- **`broadcastStatus()` (single status writer)** — the watchdog never writes
  `session.status` directly. Status transitions follow naturally from the
  abort path's `agent_end` and the surfaced `message_end`. See
  [docs/design/unify-session-status.md](design/unify-session-status.md).
- **In-place agent respawn** — the synthetic-event bridge
  (`session.emitSyntheticEvent`) is reinstalled in `session-setup.ts
  subscribeToEvents()` and at every respawn site in `session-manager.ts`
  (`_respawnAgentInPlace`, `recoverSandboxSessions`, the in-memory
  `ensureSessionAlive` branch). Without that wiring, a respawned agent
  would lose the surfaced-stall transcript path. See
  [docs/design/sandbox-recovery-frame-of-reference.md](design/sandbox-recovery-frame-of-reference.md).
- **Prompt queue / drain** — silent retry uses
  `suppressNextDrainForStallRetry` to keep the watchdog as the sole
  re-dispatcher; queued prompts that arrived while the retry was in flight
  are dispatched on the eventual successful `agent_end` (or surfaced
  failure) via the standard drain. See
  [docs/design/steer-subsystem-rewrite.md](design/steer-subsystem-rewrite.md).

## Manual repro

Two ways to inject a silent stall on a live session:

1. **TCP-level drop (Linux):**
   ```bash
   # Find the agent's outbound socket to the provider
   ss -tnp | grep <agent-pid>
   # Drop further packets to the provider's IP
   sudo iptables -A OUTPUT -d <provider-ip> -j DROP
   ```
   The `Established` socket stays open from the kernel's POV; no FIN/RST
   reaches the agent. Within `BOBBIT_LLM_STREAM_TIMEOUT_MS`, the watchdog
   should fire and (after retries) surface the stall.

2. **Pause the agent process:** `kill -STOP <agent-pid>` then
   `kill -CONT <agent-pid>` after `> timeoutMs * (maxRetries + 1)`. Crude
   but works for smoke tests.

Verify:
- `[stream-watchdog]` lines in server logs as described above.
- After surfacing, the UI transcript shows the stalled-stream message.
- Session leaves `streaming` (Stop spinner clears).
- A subsequent prompt dispatches normally.
- A long-but-progressing turn (e.g. a 5-minute streaming response with
  regular tokens) is **not** aborted — `lastLlmFrameAt` keeps refreshing.

## Test coverage

Unit (`tests/llm-stream-watchdog.test.ts`):

- `silent-retry then surface` — full counter-bookkeeping check across all
  three attempts.
- `tool execution gate` — no abort while `awaitingLlmFrame === false`
  (long tool call should not look stalled).
- `long-but-progressing stream` — `message_update` heartbeats keep the
  watchdog idle.
- `disabled mode (timeoutMs <= 0)` — no timer, no abort, no log lines.
- `env NaN guard` — `""`, `"foo"`, etc. collapse to defaults.
- `race vs user Stop` — concurrent `aborting` clears the suppression flag
  and lets idle broadcast through.
- `production-shape abort frames` — the real `message_end{errorMessage:
  "Request aborted"}` does not advance `consecutiveErrorTurns` for silent
  retries and does not clobber the surfaced error.
- `user-Stop race during silent retry` — Stop wins; session never gets
  stuck in `aborting`.
- `end-to-end production-shape flow` — full sequence with the agent's
  real abort frames interleaved.

E2E (`tests/e2e/ui/llm-stream-watchdog.spec.ts`):

- `stalled stream surfaces an error after MAX_RETRIES+1 attempts; session
  unwedges` — drives a real session with a controllable stall, asserts the
  user-visible transcript message and that the session leaves `streaming`
  and accepts a follow-up prompt.
