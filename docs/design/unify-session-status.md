# Unify Session Status — Design Doc

**Goal**: `goal-unify-sess-d3fd6b8d` ("Unify Session Status")
**Author**: coder-b7d954c9
**Status**: design

This doc covers the implementation plan for the goal spec at `goal-unify-sess-d3fd6b8d`. It is the single source of truth for the implementer; every subsequent diff should land at one of the file:line citations below.

---

## 1. Current state

### 1.1 Two indicators, two sources

| Indicator | Source | Reader |
|---|---|---|
| Stop button visibility, abort gating, blob spinner | `RemoteAgent._state.isStreaming` (client-local boolean) | `src/ui/components/AgentInterface.ts` lines 322, 855, 864-865, 1098, 1200, 1214, 1232, 1642, 1646; `MessageEditor.ts` line 752 |
| Bobbit sprite "busy" / "idle" / "aborting" | `gatewaySessions[i].status` (REST `/api/sessions` snapshot) | `src/app/sidebar.ts:598, 612, 1124, 1134` via `statusBobbit(sessionStatus, …)` |

The active session's `_state.isStreaming` and the polled REST `session.status` for the same session id are written by **independent code paths** that can drift.

### 1.2 The four divergent writers of `_state.isStreaming`

All citations are in `src/app/remote-agent.ts`:

| # | Line | Path | Action |
|---|---|---|---|
| W1 | **917** | `case "state"` (`get_state` response handler) | `this._state.isStreaming = msg.data.isStreaming` (gated on `msg.data?.isStreaming !== undefined`) |
| W2 | **1069 / 1076 / 1080** | `case "session_status"` | branch on `status`: archived/preparing → `false`; otherwise `msg.status === "streaming"` |
| W3 | **1582** (`agent_start`) and **1590** (`agent_end`) | `handleAgentEvent` | sets `true` on start, `false` on end |
| W4 | **1272** | `case "error"` (server-pushed `{type:"error"}` frame) | sets `false` |

Plus two **non-event-driven** writers, both legitimate but worth documenting:

- Line **313** — initial value in the constructor (`isStreaming: false`).
- Line **762** — `reset()`, called on session navigate / role-change to clear the agent shell.

### 1.3 Readers (must be enumerated before refactor)

- `remote-agent.ts:187` — visibility-resync **skip-while-streaming** branch (the bug magnet).
- `remote-agent.ts:484` — the 3-second `_stateRetryTimer` that re-issues `get_state` if the model context window never arrived. Not a status reader, but is removed in this work because the heartbeat replaces it.
- `remote-agent.ts:648` — optimistic-prompt branch (`if (!this._state.isStreaming)` decides whether to render the user message immediately or wait for the server echo). **This is the one that produces the duplicate-message bug** when the flag is stuck `true`.
- `remote-agent.ts:746` — `waitForIdle()` early-out.
- `AgentInterface.ts:322, 855, 864–865, 1098, 1200, 1214, 1232, 1642, 1646` — Stop button, blob spinner, retry-button gating, message-editor enabled state, splash gating.
- `MessageEditor.ts:349, 752` — Escape-to-abort handler, Stop button label.
- `MessageList.ts:147, 195, 200`, `Messages.ts:251, 273, 279, 312, 350, 372, 374, 604`, `StreamingMessageContainer.ts:46, 54` — render-time visual affordances.
- `sidebar.ts:598, 612, 1124, 1134` — sprite (reads `session.status` from `state.gatewaySessions`, **not** `_state.isStreaming`). Already the canonical field; not changed by this work.

### 1.4 Bugs caused by drift

#### Bug A — Stuck Stop button without busy sprite

When `_state.isStreaming` ends up stuck `true` while the server's `session.status` is `idle`, the Stop button stays visible and the sprite is idle. Reproducer: any path where `agent_end` (W3) is **missed** and the client is **not** reconciled by a subsequent `session_status` (W2) or `state` snapshot (W1):

1. **Pending-events overflow** (`remote-agent.ts:1034`) — when `_pendingEvents.length > _pendingEventsMax (500)`, the client wipes the buffer, sets `_inResumeFallback = true`, and calls `requestMessages()`. The snapshot reply (`case "messages"`) **does not touch `isStreaming`**. If a real `agent_end` was inside the discarded gap and no `session_status` is sent post-snapshot, the flag stays `true`.
2. **Tab-suspend miss + visibility resync skip** — mobile OS freezes the WS layer; on wake, line 187 short-circuits the resync precisely because `_state.isStreaming` is true. So the very condition that needs healing prevents healing.
3. **Optimistic server flip with no follow-up** — `session_status` frames sometimes flip `streaming → idle` then immediately back to `streaming` on rapid retries; if a network hiccup drops the second frame the client lands on `false` but server sends no resync trigger.

#### Bug B — Duplicate user message on second send

The optimistic-prompt branch at `remote-agent.ts:648` (`if (!this._state.isStreaming)`) decides whether to push an `optimistic-prompt` message into the reducer. Sequence when the flag is stuck:

1. User sends prompt #1. `isStreaming === true` → branch skipped → no optimistic echo. Server receives prompt, queues it (because **server** also thinks streaming → enqueue, no echo back to client until current turn ends). Result: prompt #1 renders **nothing** until either turn end or echo.
2. User sends prompt #2. Same branch skipped. Server enqueues prompt #2.
3. Eventually server echoes both as it processes them — they appear back-to-back. **Two identical user messages** if the user retyped, or one ghost if not.

The duplicate is the visible symptom; the root cause is the divergence at line 648.

---

## 2. Proposed state

### 2.1 Single source of truth

Replace the boolean `_state.isStreaming` field with a canonical string `status`:

```ts
// src/app/remote-agent.ts (constructor)
this._state = {
  ...
  status: "idle" as ClientSessionStatus,         // new canonical
  // isStreaming removed as a stored field
  isCompacting: false,
  isArchived: false,                              // derived now (status === "archived")
  isPreparing: false,                             // derived now (status === "preparing")
  ...
};

export type ClientSessionStatus =
  | "idle"
  | "streaming"
  | "aborting"
  | "preparing"
  | "archived";
```

`isStreaming` becomes a **getter** so existing readers compile unchanged:

```ts
// src/app/remote-agent.ts — replaces stored field
get isStreaming(): boolean { return this._state.status === "streaming"; }
// AND on the inner _state proxy, for the .state.isStreaming readers in AgentInterface
get state() {
  return new Proxy(this._state, {
    get: (t, k) => k === "isStreaming"
      ? t.status === "streaming"
      : k === "isArchived"
        ? t.status === "archived"
        : k === "isPreparing"
          ? t.status === "preparing"
          : (t as any)[k],
  });
}
```

(Or — simpler alternative — keep `state` returning the bare object but add `Object.defineProperty(this._state, "isStreaming", { get: () => this._state.status === "streaming" })` once in the constructor. The implementer should pick whichever is shorter; the contract is the same.)

### 2.2 The single-writer rule

Every non-constructor mutation of `_state.status` must come from exactly one of:

| Source | What it does | Notes |
|---|---|---|
| `case "session_status"` (W2 today) | `this._state.status = msg.status` | **Sole writer** for live transitions. `_isAborting` derived: `status === "aborting"`. `turnStartTime` set when transitioning into `streaming`, cleared otherwise. |
| `case "state"` (W1 today) | If `msg.data.status` present, `this._state.status = msg.data.status` | Only at attach / explicit `get_state`. Server starts sending `data.status` instead of `data.isStreaming` (back-compat below). |
| `reset()` | `this._state.status = "idle"` | Local-only (session navigate). |

`agent_start` (W3 line 1582), `agent_end` (W3 line 1590), and `case "error"` (W4 line 1272) become **read-only signals**. They keep firing the existing side effects (beep, favicon badge, `taskStartTime` clear, error message append) but **must not write `status`**. The server is responsible for emitting a matching `session_status` frame at the same transition — and already does (`session-manager.ts:1641, 1781, 1641` on idle; 1364, 1620, 1734 on streaming).

### 2.3 Self-healing via monotonic version + heartbeat

Server attaches `statusVersion: number` to **every** `session_status` frame (and to the `state` snapshot's `data.statusVersion`). Bumped on every transition.

Client tracks `lastStatusVersion` (init 0). On each `session_status`:

- `frame.statusVersion <= lastStatusVersion` → **idempotent**, drop the write but still process side effects (`onStatusChange?` callback, grant-replay).
- `frame.statusVersion === lastStatusVersion + 1` → normal increment, apply.
- `frame.statusVersion > lastStatusVersion + 1` → **gap**: apply the frame *then* fire `{ type: "status_resync" }` so the server returns a fresh `session_status` baseline. Heartbeat will close any further drift within ~15s anyway.

Server emits a status **heartbeat** every 15s (configurable) per active session: same `session_status` frame shape, **same** `statusVersion` (no bump). The frame is idempotent on the client per the rule above. This makes any stale state self-heal within ≤15s without explicit user action.

The 3-second `_stateRetryTimer` (line 484) and the visibility-skip-while-streaming branch (line 187) are **deleted** — the heartbeat covers both.

---

## 3. Server changes (`src/server/`)

### 3.1 New field on `SessionInfo`

`src/server/agent/session-manager.ts:113` — add to `SessionInfo`:

```ts
/** Monotonic version of `session.status`. Bumped on every status transition.
 *  Carried on every `session_status` broadcast (live + heartbeat) so the
 *  client can detect dropped frames and request a one-shot resync. */
statusVersion: number;
```

Initialized to `0` at every session-create site (alongside the existing `status: "idle"` / `"preparing"` initialization).

### 3.2 Centralised `broadcastStatus` helper

Replace every site that mutates `session.status` and broadcasts `session_status` with a single helper. Lives near `broadcast()` at `src/server/agent/session-manager.ts:306`:

```ts
/**
 * Mutate session.status, bump statusVersion, and broadcast the new status
 * to every connected client. Single source of truth for status transitions —
 * never write `session.status = …` directly.
 *
 * `extras` lets transition sites attach `streamingStartedAt` (only on the
 * "streaming" branch) and `archivedAt` (only on the "archived" branch).
 */
function broadcastStatus(
  session: SessionInfo,
  status: SessionStatus,
  extras?: { streamingStartedAt?: number; archivedAt?: number },
): void {
  session.status = status;
  session.statusVersion += 1;
  broadcast(session.clients, {
    type: "session_status",
    status,
    statusVersion: session.statusVersion,
    ...(extras?.streamingStartedAt ? { streamingStartedAt: extras.streamingStartedAt } : {}),
    ...(extras?.archivedAt ? { archivedAt: extras.archivedAt } : {}),
  });
}
```

### 3.3 Migration of existing transition sites

All `session.status = X; broadcast(...session_status...)` pairs become single `broadcastStatus(session, X, …)` calls. Sites in `src/server/agent/session-manager.ts`:

| Line | Current code | New code |
|---|---|---|
| 543–544 | `session.status = "terminated"; broadcast(...)` | `broadcastStatus(session, "terminated")` |
| 576 | bare `broadcast(... idle ...)` (after `session.status = "idle"` elsewhere) | wrap into `broadcastStatus` |
| 582–587 | `session.status = "terminated"; broadcast(...)` | `broadcastStatus(session, "terminated")` |
| 1361–1364 | streaming start | `broadcastStatus(session, "streaming", { streamingStartedAt })` |
| 1617–1620 | streaming start | same |
| 1640–1641 | idle | `broadcastStatus(session, "idle")` |
| 1728–1734 | streaming start | same |
| 1777–1781 | idle | same |
| 1811 | `session.status = "terminated"` (no broadcast nearby — keep for now if intentional, else add `broadcastStatus`) | `broadcastStatus(session, "terminated")` |
| 2152, 2197 | restored idle | `broadcastStatus(restored, "idle")` |
| 2704 | `session.status = "idle"` (no broadcast) | `broadcastStatus(session, "idle")` |
| 3520 | terminated | `broadcastStatus(session, "terminated")` |
| 3844–3851 | role-restart idle | `broadcastStatus(session, "idle")` |
| 4095 | terminated | same |
| 4703–4704 | aborting | `broadcastStatus(session, "aborting")` |
| 4765–4767 | post-abort idle | `broadcastStatus(session, "idle")` |
| 4859–4860, 4867–4868, 4894 | terminate paths | same |

All `session.status = "preparing"` (around `2772`) **must also bump `statusVersion`** even though there are no clients yet — done by going through `broadcastStatus`. The `broadcast()` call is a no-op on an empty client set.

After migration, **no other code path is allowed to write `session.status` directly**. Add an ESLint rule or a one-liner unit test asserting the source-string `session\.status\s*=` matches only inside `broadcastStatus`.

### 3.4 Heartbeat timer

Single timer at `SessionManager` level (not per-WS). Fires every `STATUS_HEARTBEAT_INTERVAL_MS = 15_000`:

```ts
// src/server/agent/session-manager.ts (constructor / start)
private _statusHeartbeatTimer: NodeJS.Timeout | null = null;
private static readonly STATUS_HEARTBEAT_INTERVAL_MS = 15_000;

private _startStatusHeartbeat(): void {
  this._statusHeartbeatTimer = setInterval(() => {
    for (const session of this._sessions.values()) {
      if (session.clients.size === 0) continue;        // nobody listening
      if (session.status === "terminated") continue;   // no point
      // Send the CURRENT status, do NOT bump statusVersion.
      broadcast(session.clients, {
        type: "session_status",
        status: session.status,
        statusVersion: session.statusVersion,
        ...(session.streamingStartedAt ? { streamingStartedAt: session.streamingStartedAt } : {}),
      });
    }
  }, SessionManager.STATUS_HEARTBEAT_INTERVAL_MS);
  // unref so it doesn't block process exit in tests
  (this._statusHeartbeatTimer as any).unref?.();
}
```

Started in constructor, cleared in `shutdown()` / `dispose()`.

### 3.5 `auth_ok` baseline (already happens; adjust for `statusVersion`)

`src/server/ws/handler.ts:323` already sends `session_status` after `auth_ok`. Update to include `statusVersion`. The archived branch at line 262 must also include `statusVersion: 0` (or whatever the persisted session carries — for archived sessions the version is meaningless but a number must be present for client typing).

`buildArchivedStateData()` at `src/server/ws/handler.ts:133` should include `statusVersion: 0` and `status: "archived"` in the snapshot data. The server-side `state` payload from `getState()` for live sessions should include `statusVersion: session.statusVersion` and `status: session.status` so the client can prime `lastStatusVersion` from the snapshot.

### 3.6 New `status_resync` WS command

`src/server/ws/protocol.ts` — add to `ClientMessage` union:

```ts
| { type: "status_resync" }
```

`src/server/ws/handler.ts` — handle in the message switch:

```ts
case "status_resync": {
  const session = sessionManager.getSession(sessionId);
  if (!session) break;
  send(ws, {
    type: "session_status",
    status: session.status,
    statusVersion: session.statusVersion,
    ...(session.streamingStartedAt ? { streamingStartedAt: session.streamingStartedAt } : {}),
  });
  break;
}
```

No new server message type is needed — the response is just a `session_status` frame, indistinguishable from a heartbeat or transition frame. Client treats it through the same handler.

---

## 4. Client changes (`src/app/remote-agent.ts`)

### 4.1 Constructor diff (line 305-330 area)

```diff
 this._state = {
   ...
-  isStreaming: false,
+  status: "idle" as ClientSessionStatus,
   isCompacting: false,
-  isArchived: false,
-  isPreparing: false,
+  // isArchived / isPreparing become getters on the proxy / defined on _state
   archivedAt: null as number | null,
   ...
 };
+Object.defineProperty(this._state, "isStreaming", {
+  get: () => this._state.status === "streaming",
+  enumerable: true,
+});
+Object.defineProperty(this._state, "isArchived", {
+  get: () => this._state.status === "archived",
+  enumerable: true,
+});
+Object.defineProperty(this._state, "isPreparing", {
+  get: () => this._state.status === "preparing",
+  enumerable: true,
+});
```

### 4.2 `lastStatusVersion` tracking

Add private field:

```ts
/** Monotonic statusVersion of last applied session_status frame. Used to
 *  detect dropped frames (gap → request resync) and ignore duplicates
 *  (heartbeat with same version = idempotent no-op). */
private _lastStatusVersion = 0;
```

### 4.3 `case "session_status"` rewrite (lines 1067-1098)

```ts
case "session_status": {
  const v = typeof (msg as any).statusVersion === "number" ? (msg as any).statusVersion : undefined;

  // Idempotent / heartbeat: same or stale version → side effects only.
  if (v !== undefined && v <= this._lastStatusVersion) {
    // grant-replay still needs to fire on observed-idle even if heartbeat repeats it
    this._maybeReplayGrant(msg.status);
    this.onStatusChange?.(msg.status);
    break;
  }

  // Gap: apply this frame but ask for a resync to close further drift.
  if (v !== undefined && v > this._lastStatusVersion + 1) {
    console.warn(`[RemoteAgent] session_status gap (${this._lastStatusVersion} → ${v}); requesting resync`);
    this.send({ type: "status_resync" });
    // fall through and apply this frame
  }

  if (v !== undefined) this._lastStatusVersion = v;

  // Sole writer of _state.status.
  this._state.status = msg.status;

  if (msg.status === "archived" && msg.archivedAt) this._state.archivedAt = msg.archivedAt;
  this._state.turnStartTime =
    msg.status === "streaming"
      ? (msg.streamingStartedAt ?? this._state.turnStartTime ?? Date.now())
      : null;

  // _isAborting is now derived; remove the separate field if simple,
  // or keep it as a one-line mirror for the existing `isAborting` getter:
  this._isAborting = msg.status === "aborting";

  this._maybeReplayGrant(msg.status);
  this.onStatusChange?.(msg.status);
  break;
}
```

Where `_maybeReplayGrant` is the extracted form of the existing pending-grant block at lines 1090-1097.

### 4.4 `case "state"` patch (line 916-918)

```diff
-if (msg.data?.isStreaming !== undefined) {
-  this._state.isStreaming = msg.data.isStreaming;
-}
+if (typeof msg.data?.status === "string") {
+  this._state.status = msg.data.status;
+  if (typeof msg.data.statusVersion === "number") {
+    this._lastStatusVersion = msg.data.statusVersion;
+  }
+}
+// Back-compat: an older server might still send `isStreaming`. Ignore it
+// — `session_status` (sent by handler.ts:323 immediately after auth_ok)
+// will carry the canonical value and version.
```

### 4.5 `case "error"` patch (line 1272)

```diff
-this._state.isStreaming = false;
-this._state.turnStartTime = null;
+// Status mutation is the server's job — it will broadcast `session_status: idle`
+// in the same termination path. We only clear local-only fields here.
+this._state.turnStartTime = null;
```

### 4.6 `agent_start` / `agent_end` patches (lines 1582, 1590)

```diff
 case "agent_start":
-  this._state.isStreaming = true;
   this._state.error = undefined;
   this._taskStartTime = Date.now();
   this._state.turnStartTime = this._taskStartTime;
   break;

 case "agent_end": {
   this.streamingMessageId = undefined;
-  this._state.isStreaming = false;
-  this._isAborting = false;
   this._state.streamingMessage = null;
   this._state.pendingToolCalls = new Set();
   for (const k of Object.keys(state.proposalStreamingByTag)) {
     state.proposalStreamingByTag[k] = false;
   }
   RemoteAgent.playNotificationBeep();
   showFaviconBadge();
   this._taskStartTime = null;
   this._state.turnStartTime = null;
   break;
 }
```

`isStreaming` is now derived — `agent_end` is a *signal* (beep, badge, cleanup) but not a state writer. The matching `session_status: idle` from the server is what flips the canonical status.

### 4.7 `reset()` (line 762)

```diff
 reset(): void {
   ...
-  this._state.isStreaming = false;
+  this._state.status = "idle";
+  this._lastStatusVersion = 0;
```

### 4.8 Visibility-resync simplification (line 187)

```diff
-// Skip resync while a turn is streaming — the server is actively
-// pushing events and a wholesale message replacement can interleave...
-if (this._state.isStreaming) return;
```

Delete the branch entirely. Heartbeat keeps `status` honest; the message-snapshot code path (line 195+) is unaffected.

### 4.9 `_stateRetryTimer` removal

Delete:
- field declaration (line ~135 area)
- the 3s `setTimeout` block at lines 484-491
- the `clearTimeout(this._stateRetryTimer)` at line ~895 (`case "state"` happy path) and at `disconnect()` (line ~573)

Heartbeat closes the gap.

### 4.10 Optimistic-prompt branch (line 648)

No code change — the read `if (!this._state.isStreaming)` keeps working through the getter. The bug it caused is gone because the underlying flag can no longer drift.

### 4.11 All readers stay unchanged

Stop button, sprite, splash gating, abort gating, optimistic-prompt branch, queued-prompt rendering, archived footer — all read `isStreaming` (or `isArchived`/`isPreparing`) which are now backed by the canonical `status`. **Net change to `src/ui/components/*.ts` and `src/app/sidebar.ts`: zero.**

---

## 5. Protocol diff (verbatim TypeScript)

`src/server/ws/protocol.ts` — modify the `session_status` frame and add the resync request:

```diff
 export type ClientMessage =
   | { type: "auth"; token: string }
   | { type: "prompt"; ... }
   ...
   | { type: "resume"; fromSeq: number }
+  | { type: "status_resync" };

 export type ServerMessage =
   ...
-  | { type: "session_status"; status: string; streamingStartedAt?: number; archivedAt?: number; /* status includes "aborting" */ }
+  | {
+      type: "session_status";
+      status: "idle" | "streaming" | "aborting" | "preparing" | "archived" | "starting" | "terminated";
+      /** Monotonic, bumped on every transition. Heartbeats reuse the
+       *  current value (no bump) so the client treats them as idempotent. */
+      statusVersion: number;
+      streamingStartedAt?: number;
+      archivedAt?: number;
+    }
```

The `state` server frame carries an unstructured `data: unknown`, so no protocol change is needed there — the server simply includes `status` and `statusVersion` keys in the snapshot payload.

---

## 6. Tests

### 6.1 Unit — `tests/remote-agent-status.test.ts` (new)

Drives a `RemoteAgent` against a scripted in-memory WS and asserts the canonical status after each event sequence. Setup mirrors the existing `tests/remote-agent.spec.ts` harness.

| # | Sequence | Expected after replay |
|---|---|---|
| 1 | `auth_ok` → `session_status{idle, v:1}` → `agent_start` → `session_status{streaming, v:2}` → `agent_end` → `session_status{idle, v:3}` | `status === "idle"`, `lastStatusVersion === 3`, `isStreaming === false` |
| 2 | Same as #1 but **drop `agent_end`** (still receives `session_status{idle, v:3}`) | `status === "idle"`, `isStreaming === false` (proves status not driven by `agent_end`) |
| 3 | Same as #1 but **drop `session_status{idle, v:3}`** then send `session_status{idle, v:4}` | `status === "idle"`, `lastStatusVersion === 4`, **`status_resync` request was sent on v→4 gap** (assert via mock outbound queue) |
| 4 | `session_status{streaming, v:5}` arrives **with v < lastStatusVersion (=10)** | Frame ignored: `status` unchanged from prior. Side effects (`onStatusChange`) still fire. |
| 5 | Heartbeat: receive `session_status{streaming, v:5}` twice consecutively | `status === "streaming"`, no extra writes (assert via spy on `onStatusChange` called twice but `_state.status` reference equals only updated once) |
| 6 | Pending-events overflow path: synthesise 501 buffered events to trigger `requestMessages()`, then receive `session_status{idle, v:N}` | After heartbeat tick (simulated), `status === "idle"` — proves status survives the snapshot-fallback path |
| 7 | `case "error"` frame → assert `status` **unchanged** (must come from `session_status`) | proves `agent_start`/`agent_end`/`error` are signals only |
| 8 | Stuck-flag scenario: drive client into `status === "streaming"`, then send `session_status{idle, v:N}` from heartbeat | `status === "idle"` and `isStreaming === false` (acceptance criterion 2) |

Each test asserts both the Stop-button predicate (`agent.isStreaming`) and a mock `statusBobbit()` spy (sprite predicate `session.status === "streaming"`) are **always equal** after each frame — the divergence-impossibility invariant.

### 6.2 E2E — `tests/e2e/ui/session-status-recovery.spec.ts` (new)

Browser test against spawned gateway. Pattern follows `tests/e2e/ui/session-interactions.spec.ts`.

```ts
test("recovers from missed agent_end via heartbeat", async ({ page, gateway }) => {
  await page.goto(gateway.url);
  // open a session, send a prompt, mock agent that streams and then *silently dies*
  // (kill RPC bridge before agent_end / session_status are sent).
  // Assert: within 15s + buffer, Stop button disappears AND sprite returns to idle.
  await expect(page.locator('[data-testid="stop-button"]')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('[data-testid="sprite-busy"]')).toBeHidden({ timeout: 20_000 });
});

test("no duplicate user message after stuck-flag recovery", async ({ page, gateway }) => {
  // 1. Force the client into status=streaming via a synthetic ws.send (test hook
  //    on window.__bobbitTest exposes a "fakeSessionStatus" helper for this spec).
  // 2. Send prompt #1 — assert exactly one user message renders (after heartbeat heals).
  // 3. Send prompt #2 — assert exactly one further user message renders (total 2).
  await expect(page.locator('[data-testid="user-message"]')).toHaveCount(2);
});
```

Both tests reuse `tests/e2e/ui/gateway-harness.ts`. The fake-status hook is a 5-line addition to `RemoteAgent` guarded by `import.meta.env.MODE !== "production"`.

### 6.3 Server unit — `tests/session-manager-status.test.ts` (new)

- Construct a `SessionManager`, simulate a session, call every transition (start, end, abort, terminate, archive). Assert `statusVersion` increments **monotonically** and **broadcasts include the current version**.
- Assert heartbeat timer broadcasts the current frame **without bumping `statusVersion`**.
- Assert `status_resync` handler returns the current frame.

---

## 7. Migration / back-compat

**No persisted-format changes.** `statusVersion` is in-memory only; on server restart everyone resets to 0 — clients re-attach, receive `auth_ok` then a fresh `session_status{statusVersion: 0/1}`, and reset their `lastStatusVersion`. The only persisted bit (`wasStreaming` in the session store at line 1363, etc.) is unchanged.

**Mixed-version concerns.** Server and client are released together (same artefact); rollout flips both. We still defensively guard the client:

- `case "session_status"` treats `statusVersion === undefined` as "old server" and applies the frame unconditionally (no gap detection, no version tracking) — same behaviour as today.
- `case "state"` treats `data.status === undefined` as "old server" and falls back to `data.isStreaming` (the existing behaviour at line 916) — guarded behind a deprecation log.

This means an old client against a new server still works (the `statusVersion` field is just ignored), and a new client against an old server falls back to today's behaviour minus the heartbeat (and minus the bug fix). Acceptable for one release window.

---

## 8. Net code reduction

### Deletions

| File | Lines | Reason |
|---|---|---|
| `src/app/remote-agent.ts` | line 187 (single-line skip-while-streaming branch — actually 3-line block 184-187) | replaced by heartbeat |
| `src/app/remote-agent.ts` | lines 484-491 (`_stateRetryTimer` setup) | replaced by heartbeat |
| `src/app/remote-agent.ts` | lines ~570-573 (`clearTimeout(_stateRetryTimer)` in `disconnect`) | field gone |
| `src/app/remote-agent.ts` | line 135 (`_stateRetryTimer` field decl) | field gone |
| `src/app/remote-agent.ts` | line 893-896 (clearTimeout in `case "state"` after model arrives) | field gone |
| `src/app/remote-agent.ts` | lines 1069, 1076, 1080 (three branches setting `isStreaming`) | one writer (`_state.status = msg.status`) |
| `src/app/remote-agent.ts` | line 1272 (`error` writer) | signal only |
| `src/app/remote-agent.ts` | line 1582 (`agent_start` writer) | signal only |
| `src/app/remote-agent.ts` | line 1590 (`agent_end` writer) | signal only |
| `src/app/remote-agent.ts` | line 762 (`reset` writer of `isStreaming`) | replaced by single `status = "idle"` |
| `src/app/remote-agent.ts` | line 313 (constructor `isStreaming: false`) | replaced by `status: "idle"` |
| `src/app/remote-agent.ts` | line 916-918 `case "state"` `isStreaming` block | replaced by `status` block (same length, cleaner) |

**Approximate deleted LOC: ~30**

### Additions

| File | Lines | Reason |
|---|---|---|
| `src/app/remote-agent.ts` | `_lastStatusVersion` field + 3 `Object.defineProperty` calls in constructor | derived getters |
| `src/app/remote-agent.ts` | new `case "session_status"` body with version handling | ~25 lines (replaces ~30) |
| `src/app/remote-agent.ts` | extracted `_maybeReplayGrant()` helper | ~10 lines |
| `src/server/agent/session-manager.ts` | `broadcastStatus()` helper | ~15 lines |
| `src/server/agent/session-manager.ts` | heartbeat timer setup | ~20 lines |
| `src/server/agent/session-manager.ts` | `statusVersion` field on `SessionInfo` + initialization | ~3 lines |
| `src/server/ws/handler.ts` | `case "status_resync"` | ~10 lines |
| `src/server/ws/protocol.ts` | union extension + frame field | ~5 lines |

**Approximate added LOC: ~88. Migration of ~14 transition sites collapses ~28 lines (each site: 2 lines → 1 line) → -14 LOC at the call sites.**

**Net (rough): +88 added, -30 (client) - 14 (server collapse) = +44 LOC**, but the *number of independently mutating writers* drops from **4 → 1** on the client and **~14 → 1** on the server. The doc's "net code reduction" acceptance criterion #5 is best read as "writer reduction" — the line count is dominated by new comments and the heartbeat, both of which are essential. We'll annotate this in the implementation PR.

If criterion #5 is interpreted strictly as "raw LOC negative", additional deletions are available:
- collapse `_isAborting` field (kept as mirror today, line 121-ish) into the getter `get isAborting() { return this._state.status === "aborting" }` (~5 lines).
- remove the four `console.log` debug lines at 1012, 1047, 1067, 1582-area that exist precisely to debug this divergence (~4 lines).

That brings the net to roughly break-even or slightly negative. Implementer's call.

---

## 9. Acceptance-criteria mapping

| AC | Criterion | Mapped to |
|---|---|---|
| 1 | No two-flag divergence is reachable. | §4.1 derived getter; §6.1 unit tests #1–8 (every test asserts Stop-predicate ≡ sprite-predicate). |
| 2 | Bounded staleness (≤1 heartbeat). | §3.4 server timer; §4.3 client gap detection; §6.1 test #6 + §6.2 first E2E. |
| 3 | Duplicate-message bug gone. | §4.1 + §4.10 (line 648 unchanged but underlying bug eliminated); §6.2 second E2E. |
| 4 | All existing user-visible behaviour preserved. | §4.6 keeps beep/favicon/turnStartTime side effects in `agent_end`; §4.11 zero changes to readers; existing `tests/e2e/ui/session-interactions.spec.ts`, `tail-chat-real-stream.spec.ts`, `copy-session-link.spec.ts` must pass unchanged in CI. |
| 5 | Net code reduction. | §8 — writer count drops 4→1 (client) and 14→1 (server). LOC roughly neutral; tightened further by collapsing `_isAborting` and removing debug logs. |

---

## 10. Implementation order (for the coder)

1. **Server**: add `statusVersion` field + `broadcastStatus()` helper (§3.1, §3.2). Migrate all 14 transition sites (§3.3). `npm run check`.
2. **Server**: add heartbeat timer (§3.4). Add `status_resync` handler + protocol type (§3.6, §5). Update `auth_ok` + `buildArchivedStateData` to emit `statusVersion` (§3.5). `npm run test:e2e`.
3. **Client**: add `_lastStatusVersion`, rewrite `case "session_status"` (§4.2, §4.3). `npm run check`.
4. **Client**: convert `isStreaming` to derived getter via `Object.defineProperty` (§4.1). Patch `case "state"` (§4.4), `case "error"` (§4.5), `agent_start` / `agent_end` (§4.6), `reset()` (§4.7). `npm run test:unit`.
5. **Client**: delete visibility skip (§4.8) and `_stateRetryTimer` (§4.9). `npm run test:unit + test:e2e`.
6. **Tests**: add §6.1 unit suite, §6.2 E2E spec, §6.3 server unit. `npm test`.
7. Commit per logical unit, push, mark task complete.

---

## 11. Out of scope (flagged for follow-up)

- **Sidebar real-time status (Option 3 from the goal spec).** REST polling (`/api/sessions` every 5s) for sprite states of *other* sessions stays. If the contrast post-merge is jarring, file `goal-sidebar-realtime-status` to push status frames over a global subscription channel.
- **Persistence of `statusVersion` across server restarts.** Not needed today — clients re-attach and adopt the fresh version. If we ever introduce mobile-client state sync across restarts (offline → online), revisit.
