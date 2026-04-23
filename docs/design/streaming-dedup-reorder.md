# Streaming Dedup/Reorder Fix — Design Doc

**Goal**: Fix live-streaming message duplication and reordering.
**Scope**: Live streaming only (not reload-replay). Agent execution is correct; this is a transport/rendering bug.

---

## 1. Reproduction

User-facing symptom: during live streaming, chat responses and tool results occasionally appear duplicated or out of order. The following conditions plausibly trigger it — the first two are the most likely root causes, the rest are secondary risks worth guarding against.

### 1.1 Reconnect mid-stream (highest signal)

The RE-07 harness (`tests/e2e/ui/stories-resilience.spec.ts:218`) covers reconnect *after* a full turn, but the bug surfaces when the socket drops **during** a turn. Flow:

1. Client connects, agent is streaming, `message_update` events arrive.
2. Socket drops (wifi blip, dev-server restart, tab resume from sleep).
3. Client reconnects. The server replays `getState()` + `get_messages` (`src/server/ws/handler.ts:167`, `src/server/ws/handler.ts:414`).
4. `get_messages` returns the *RPC-side* message list. The handler in `src/app/remote-agent.ts:762` re-emits every message as a synthetic `message_end` (line 800) and merges `_liveEventMessages` back in by **text equality** (line 775–786).
5. Meanwhile, the agent is still streaming — more `message_update` / `message_end` events arrive. The streaming container and the refreshed `messages[]` now hold overlapping state that only dedupes for user messages and only by text, not by identity.

Expected outcome today: duplicated assistant/toolResult messages and/or reordered tool results (a tool result arriving between `get_messages` request and response slots in after the refresh replays its own copy).

### 1.2 Rapid tool-use burst

The agent-CLI emits `message_update` roughly every output token. When tool use is dense (e.g. parallel `read`s) multiple `message_end` events fire in quick succession. Two failure modes:

- The "defer assistant message with tool calls" dance in `src/app/remote-agent.ts:1340–1365` holds one deferred message. If a *second* assistant `message_end` arrives before the next `message_update` flushes, the first deferred message is silently dropped (`this._deferredAssistantMessage = event.message;` overwrites).
- A toolResult `message_end` (line 1367 non-assistant branch) calls `flushDeferredMessage()` then appends. If two toolResults fire back-to-back from two parallel tool calls, their append order depends on socket delivery order, which has no server-assigned tiebreaker.

### 1.3 Multiple tabs

Two tabs subscribe to the same session via WebSocket. Each tab maintains its own `_state.messages`. The server `broadcast()` (`src/server/agent/session-manager.ts:145`) fans out one event to all clients. No double-delivery across tabs — but each tab independently runs the reconnect merge logic, so both tabs can independently ghost-duplicate a message.

### 1.4 Slow network / client back-pressure

WebSocket is ordered per-connection, so reordering is not possible on a single steady connection. But if the **client** is slow (long microtask queue during a big render), incoming events queue up. Current code mixes sync state mutations with async `await initAnnotationStore(...)` calls (`src/app/remote-agent.ts:820`) — any `get_messages` reply handler that awaits can interleave with `message_update` handlers processed later, which can clobber `streamingMessage` ordering relative to `messages[]`.

### 1.5 Restart harness

`npm run dev:harness` drops sockets on rebuild. The client reconnects and runs the same replay/merge path as §1.1. Same hazards.

---

## 2. Root-cause analysis — end-to-end trace

### 2.1 Server emit path

```
agent CLI stdout
  → RpcBridge (JSON-RPC over stdio)
  → rpcClient.onEvent((event) => { ... })   src/server/agent/session-manager.ts:2141
      eventBuffer.push(truncated)            line 2149   [no seq, no ts]
      broadcast(session.clients, {type:"event", data: truncated})  line 2150
```

`broadcast` (line 145) is a straight `JSON.stringify` + `client.send` loop. It assigns **no sequence number, no timestamp, no message id**. The same code path exists at four other call sites (`session-manager.ts:2742, 3081, 3236, 4096` and `session-setup.ts:420`).

### 2.2 EventBuffer

`src/server/agent/event-buffer.ts` — a 1000-entry ring of raw events:

```ts
push(event)   // FIFO append, shift when > 1000
getAll()      // returns a copy
```

No per-entry metadata. **`getAll()` has zero callers in the codebase today** (`grep -rn "eventBuffer\.getAll" src/` returns nothing). `EventBuffer.size` is read in exactly one place (`src/server/ws/handler.ts:166`) as a heuristic to decide whether to call `getState()` on reconnect. **There is no event-replay-on-reconnect today.** The buffer is dead weight as far as catch-up is concerned.

### 2.3 Reconnect catch-up path (today)

`src/server/ws/handler.ts:143–190` — on a fresh WebSocket connection:

1. Register client, send `auth_ok` (line 153).
2. If `eventBuffer.size > 0`, call `rpcClient.getState()` and send `{type:"state", data}` (line 167).
3. Client separately calls `get_messages` (triggered inside `src/app/remote-agent.ts:570` and on `messages` receipt at line 762).
4. Client merges server messages with `_liveEventMessages` by **text equality** (line 775).

The server does **not** replay buffered `{type:"event"}` frames. The client relies on `get_messages` (authoritative snapshot from the agent CLI) + live events that arrive after reconnect. The overlap between "snapshot taken at time T" and "live events post-T" is handled heuristically:

- Assistant messages in the snapshot: `for (const m of this._state.messages) this.emit({type:"message_end", message: m})` (line 800). This **re-fires message_end for every historical message** — downstream handlers (proposals, reviews) already guard against re-processing by id, but message ordering is only preserved if the snapshot is internally sorted correctly.
- Live events arriving after the snapshot request but before its response: if they are `message_end` user messages, they are pushed into `_liveEventMessages` (line 1408) and re-appended after snapshot merge (line 781) — but only if not text-equal to any snapshot user message. Assistant and toolResult live events have **no equivalent guard**: if they arrive between the `get_messages` request and response, the snapshot overwrites them (`this._state.messages = msgs.map(enrichUserMessage);` — line 764).

**This is the core live-streaming duplication surface**: assistant/toolResult events that arrived in the gap are either lost (dropped by snapshot overwrite) or duplicated (if the agent's `get_messages` reply already includes them AND the live event re-arrives). Which of the two happens depends on whether the agent had already committed the message to its internal state when `get_messages` ran — a race.

### 2.4 `.jsonl` persistence

The `.jsonl` transcript is owned entirely by the agent CLI (pi-coding-agent), not by Bobbit's server. Grep shows **no `appendFile`/`createWriteStream` calls** in `src/server/agent/` touching the transcript (`grep -rn "appendFile\|createWriteStream" src/server/agent/` returns nothing). Bobbit only reads the `.jsonl` for archived-session replay (`src/server/agent/session-manager.ts:3518`). So:

- The broadcast event and the `.jsonl` write are **independent** — the agent writes via its own path, the server fans out via RPC event.
- Bobbit cannot double-emit the "same logical event" by re-reading the jsonl — nothing re-reads it during a live session. The duplication risk is purely broadcast-vs-snapshot, not broadcast-vs-jsonl.
- This matters for decision (c) below: stamping the `.jsonl` with seq/ts would require cooperation from the agent CLI, which we don't own.

### 2.5 Multiple WS clients

`broadcast()` (`session-manager.ts:145`) iterates `session.clients` and sends to each. Each tab gets one copy per logical event — no double-delivery. But each tab independently runs the merge heuristics in §2.3, so symptoms are tab-local.

### 2.6 On-wire shape

`src/server/ws/protocol.ts:49`: `| { type: "event"; data: unknown }`. `data` is whatever the agent emitted — `message_update`, `message_end`, `tool_execution_start`, etc. No `seq`, no `ts` at the envelope level. `message_end.message.id` exists (assigned by the agent CLI) but is not used for dedup; the client dedupes user messages by text only (`src/app/remote-agent.ts:775`).

### 2.7 Summary of defects

| # | Defect | Location |
|---|--------|----------|
| D1 | No monotonic server-assigned sequence — client cannot tell "already seen" from "arrived twice" | `session-manager.ts:145, 2150, 2742, 3081, 3236, 4096`; `session-setup.ts:420` |
| D2 | No logical timestamp — client cannot order events arriving out of order or across a reconnect gap | same |
| D3 | Reconnect catch-up uses `get_messages` snapshot + text-based merge instead of replay-from-seq | `handler.ts:167`; `remote-agent.ts:762, 775` |
| D4 | EventBuffer stores no metadata; `getAll()` is unused; size-check is only a heuristic | `event-buffer.ts` |
| D5 | Client dedups user messages by text, not by id; assistant/toolResult messages are not deduped at all | `remote-agent.ts:775, 1388` |
| D6 | Deferred assistant message can be silently overwritten when two assistant `message_end` fire back-to-back | `remote-agent.ts:1344` |

---

## 3. Decision — **(b) monotonic seq + logical ts on broadcast envelope**

### Chosen

**(b)**: Every `{type:"event"}` frame gets two additive fields — `seq` (per-session monotonic uint, assigned at broadcast time) and `ts` (wall-clock ms). `EventBuffer` stores `{seq, event}` pairs. On reconnect the client sends `?resumeFromSeq=N` (or an equivalent WS message); server replies with the buffered tail `> N`. Client dedupes by `(sessionId, seq)` and orders by `seq` before rendering.

### Why not (a) — client-only fix

(a) would patch dedup by `message.id` on the client, but does nothing for **reordering** (client can't know the intended order without a server-assigned key), nothing for the **reconnect gap** (snapshot overwrite still drops live-arrived events), and nothing for the **deferred-assistant overwrite** bug (D6). It also leaves the EventBuffer dead code. Net: partially papers over symptoms, doesn't fix the class of bug.

### Why not (c) — also stamp `.jsonl`

The `.jsonl` is written by the agent CLI (pi-coding-agent), not by Bobbit (§2.4). Reload-replay comes from the agent CLI's own state via `switch_session` + `get_messages` RPCs — Bobbit never re-reads the transcript line-by-line during live sessions. Stamping the `.jsonl` would either (i) require a fork of pi-coding-agent to add seq fields (large blast radius, out of scope for a transport bug) or (ii) require Bobbit to intercept-and-rewrite, which adds a second persistence path racing the agent's own. The reload flow already uses a snapshot API (`get_messages`) that returns a **self-consistent ordered list** — it doesn't have the broadcast-vs-snapshot gap problem that live streaming has. No seq/ts is needed there.

If future work needs cross-reload dedup (e.g. re-opening an archived session while a staff agent still writes), we can extend to (c) then. For the current goal the additional cost (fork coordination) buys no test-covered benefit.

### Constraints satisfied

- Additive on-wire fields (`seq`, `ts`) — existing clients ignore unknown keys (`JSON.parse` → extra properties are tolerated; no consumer checks for strict equality). ✔
- EventBuffer stays bounded (1000 entries) — adding `{seq, event}` tuples vs raw events is O(1) overhead per entry. ✔
- RE-07 reconnect catch-up is strengthened, not regressed — the new code path is the one RE-07 exercises. ✔
- Backward-compat: if client doesn't send `resumeFromSeq`, server falls back to today's `getState()` + `get_messages` behaviour. ✔

---

## 4. Implementation sketch

### 4.1 Server — event-buffer.ts

Replace the event type with a `{seq, ts, event}` triple:

```ts
export interface BufferedEvent { seq: number; ts: number; event: unknown }

export class EventBuffer {
  private buffer: BufferedEvent[] = [];
  private nextSeq = 1;
  constructor(private maxSize = 1000) {}

  push(event: unknown): BufferedEvent {
    const entry: BufferedEvent = { seq: this.nextSeq++, ts: Date.now(), event };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxSize) this.buffer.shift();
    return entry;
  }

  /** Return all entries with seq > fromSeq (inclusive upper). */
  since(fromSeq: number): BufferedEvent[] {
    // Fast path: fromSeq is before our oldest entry → return all
    if (this.buffer.length === 0 || fromSeq < this.buffer[0].seq - 1) return [...this.buffer];
    // Linear scan from the front — buffer is small (≤1000)
    return this.buffer.filter(e => e.seq > fromSeq);
  }

  /** True if fromSeq falls inside our retained window. */
  canResumeFrom(fromSeq: number): boolean {
    return this.buffer.length === 0 || fromSeq >= this.buffer[0].seq - 1;
  }

  getAll(): BufferedEvent[] { return [...this.buffer]; }
  clear(): void { this.buffer = []; this.nextSeq = 1; }
  get size(): number { return this.buffer.length; }
  get lastSeq(): number { return this.nextSeq - 1; }
}
```

### 4.2 Server — session-manager.ts broadcast

Wrap broadcast so every `{type:"event"}` frame carries `seq` and `ts`:

```ts
// Replace the bare `eventBuffer.push(truncated); broadcast(session.clients, {type:"event", data: truncated});`
// pattern at each of the 5 call sites with one helper:

function emitEvent(session: SessionInfo, event: unknown) {
  const truncated = truncateLargeToolContent(event);
  const entry = session.eventBuffer.push(truncated);              // assigns seq, ts
  broadcast(session.clients, { type: "event", data: truncated, seq: entry.seq, ts: entry.ts });
}
```

Call sites to update:
- `src/server/agent/session-manager.ts:2149–2150` (restore path)
- `src/server/agent/session-manager.ts:2742–2743` (continue-archived)
- `src/server/agent/session-manager.ts:3081–3082` (fresh session)
- `src/server/agent/session-manager.ts:3236` (team-spawn)
- `src/server/agent/session-manager.ts:4096` (continue-archived alt path)
- `src/server/agent/session-setup.ts:420`

Other broadcast sites (`session_status`, `session_title`, `messages`, `state`, `queue_update`, etc.) do **not** carry `seq` — they are snapshot-like, not stream deltas. Keep them unchanged.

### 4.3 Server — ws/protocol.ts

Extend the `event` variant additively:

```ts
| { type: "event"; data: unknown; seq?: number; ts?: number }
```

Add a client → server resume command:

```ts
| { type: "resume"; fromSeq: number }
```

Add a server → client gap signal (when `canResumeFrom` is false):

```ts
| { type: "resume_gap"; lastSeq: number }   // client should fall back to snapshot
```

### 4.4 Server — ws/handler.ts

After `auth_ok` (line 153), **before** the `getState()`/`get_messages` fallback, accept a `resume` message from the client:

```ts
case "resume": {
  const session = sessionManager.getSession(sessionId);
  if (!session) { /* reject */ return; }
  if (!session.eventBuffer.canResumeFrom(msg.fromSeq)) {
    send(ws, { type: "resume_gap", lastSeq: session.eventBuffer.lastSeq });
    break;
  }
  for (const entry of session.eventBuffer.since(msg.fromSeq)) {
    send(ws, { type: "event", data: entry.event, seq: entry.seq, ts: entry.ts });
  }
  break;
}
```

Keep the existing `getState()` heuristic at line 166 as the "cold connect" path. Clients that send `resume` skip it; clients that don't (old clients) still work as before.

### 4.5 Client — remote-agent.ts

Track the highest seen seq; dedup and order on ingest:

```ts
// new fields on RemoteAgent
private _highestSeq = 0;
private _pendingEvents: Array<{seq:number; ts:number; event:any}> = [];

// in case "event":
const seq = msg.seq;
const ts = msg.ts;
if (typeof seq === "number") {
  if (seq <= this._highestSeq) break;            // D1/D5: drop duplicate
  if (seq !== this._highestSeq + 1) {
    // out-of-order (D2): buffer, don't dispatch yet
    this._pendingEvents.push({seq, ts, event: msg.data});
    this._pendingEvents.sort((a,b) => a.seq - b.seq);
    this._drainOrderedEvents();
    break;
  }
  this._highestSeq = seq;
}
this.handleAgentEvent(msg.data);
this._drainOrderedEvents();
```

`_drainOrderedEvents` pops entries from `_pendingEvents` whose `seq === _highestSeq + 1`, dispatching in order.

On reconnect (when the WS opens), if `_highestSeq > 0`, send `{type:"resume", fromSeq: this._highestSeq}` **before** any other traffic. On `resume_gap`, fall back to today's `get_messages` path (reset `_highestSeq` from the server's reported `lastSeq`).

`_liveEventMessages` text-merge hack (`remote-agent.ts:775`) becomes unnecessary for the resume path (events arrive in order, no snapshot-vs-live gap). Keep it for the `resume_gap` fallback only, but gate it behind the gap flag so the happy path doesn't pay its cost.

### 4.6 Client — `.seq` is the identity key

Wherever the client currently dedupes by text or by `message.id`, add `seq` as the primary key. For UI rendering of `messages[]`, no changes needed — `messages[]` is already authoritative and ordered. The dedup only affects the event-to-state reducer path.

### 4.7 Tests

#### Unit — `tests/event-buffer.spec.ts` (new)

- `push()` assigns monotonic seq starting at 1.
- `push()` eviction: after 1001 pushes, `buffer[0].seq === 2`.
- `since(N)` returns entries with `seq > N`.
- `canResumeFrom(N)` is false when N is older than the retained window.
- `lastSeq` reports the highest assigned seq.

#### Unit — `tests/remote-agent-seq-dedup.spec.ts` (new, Playwright file:// fixture)

Drive `RemoteAgent` via synthetic WS messages:
1. Emit `{type:"event", data:{type:"message_end", message:{...id:"m1"}}, seq:1, ts:100}`.
2. Emit the **same** event with `seq:1` again → assert `messages[]` still has one entry.
3. Emit `seq:3` before `seq:2` → assert neither fires yet.
4. Emit `seq:2` → assert both 2 and 3 dispatch in order.

#### E2E — `tests/e2e/ui/stories-streaming.spec.ts` (extend or new CT-01 story)

**Reproducing test — must fail on master, pass after fix:**

```
ST-DEDUP-01: "Reconnect mid-stream does not duplicate or reorder events"
  setup: session A, send a prompt that triggers a tool call
         (use the mock agent harness that can emit events on command).
  act:   emit message_update + tool_execution_start + toolResult message_end
         in a burst; drop the WS mid-burst (event.disconnect()); reconnect.
         Mock-emit the same burst tail after reconnect.
  assert: message_list has exactly N entries in the expected order,
          no duplicates by id or text.
```

The test uses the existing spawned-gateway harness (`tests/e2e/ui/gateway-harness.ts`) + the `event.disconnect()` hook added for RE-07. The burst is produced by a mock agent driver that can be told "emit these events now"; if none exists, add a thin test-only RPC in `src/server/agent/session-manager.ts` behind `BOBBIT_E2E=1` that injects a canned event stream into `session.eventBuffer` + broadcast.

#### RE-07 regression guard

`tests/e2e/ui/stories-resilience.spec.ts:218` already covers reconnect-after-finish; no changes needed. Re-run as part of the PR. The new `resume` path is exercised on every reconnect; if `_highestSeq === 0` it no-ops server-side.

### 4.8 Rollout / compat

- Old clients that never send `resume` get the existing behaviour (get_messages snapshot). No regression.
- New clients on old servers: server ignores unknown `resume` message type (already logs "unknown command" — harmless). `seq`/`ts` are undefined on incoming events → client falls back to the pre-seq path (dedup by id/text as today). No breakage.
- Both ends upgraded → new path active.

### 4.9 Non-goals

- `.jsonl` stamping (reserved for a future (c) extension — see §3).
- Dedup across archived/restored sessions (covered by the snapshot-based `get_messages` path which is already consistent).
- Cross-session ordering (seq is per-session; session A's seq 5 has no relation to session B's seq 5).

---

## 5. Acceptance checklist (for the implementer)

- [ ] `EventBuffer` stores `{seq, ts, event}` with `since()`, `canResumeFrom()`, `lastSeq`.
- [ ] All five `eventBuffer.push(…); broadcast(…)` call sites routed through a single `emitEvent(session, event)` helper.
- [ ] `ServerMessage.event` carries optional `seq` and `ts`; `ClientMessage` gains `resume`.
- [ ] `ws/handler.ts` honours `resume` and emits `resume_gap` when the seq is evicted.
- [ ] `RemoteAgent` tracks `_highestSeq`, dedups, orders, and sends `resume` on reconnect.
- [ ] Unit tests for `EventBuffer` and the client reducer.
- [ ] E2E test `ST-DEDUP-01` fails on master, passes after fix.
- [ ] RE-07 still passes.
- [ ] `npm run check` clean; `npm run test:unit` + `npm run test:e2e` green.

---

## 6. Risk register

| Risk | Mitigation |
|------|------------|
| `seq` wraps (uint overflow) after 2^53 events | Session lifetime is finite; seq resets on session restart. `Number.MAX_SAFE_INTEGER` ≫ any realistic session. |
| 1000-entry ring evicts mid-reconnect on a very busy session | Server sends `resume_gap`; client falls back to snapshot. Consider bumping to 5000 if telemetry shows frequent gaps — separate tuning change, not blocking. |
| Out-of-order buffer grows unbounded on a permanently-gapped client | Drain on every ingest; if `_pendingEvents.length > 500`, abandon and force a snapshot reload. |
| Other broadcast types (`session_status`, etc.) also race | Out of scope — they're idempotent snapshots. The bug is about `{type:"event"}` only. |
