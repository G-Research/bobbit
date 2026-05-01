# Delegate restart resilience

Status: Design — pending implementation
Goal: `goal/delegates--32db56b9`
Author: architect-1c4646ce

## 1. Problem statement & current behavior

Delegate sessions — created by the `delegate` tool in `defaults/tools/agent/extension.ts` — do **not** survive a server restart, even though normal sessions, team leads, team members, and verification (review/QA) reviewer sessions all do.

Two layers cause this on `master` HEAD `2fd9ad2b`:

### 1.1 Restore loop deliberately skips delegates

`SessionManager.restoreSessions()` in `src/server/agent/session-manager.ts` (~L2118–2141):

```ts
const regular = persisted.filter(ps => !ps.delegateOf);
const delegates = persisted.filter(ps => !!ps.delegateOf);
…
for (const ps of delegates) {
    if (!ps.agentSessionFile) {
        try { this.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
        continue;
    }
    this.addDormantSession(ps);   // ← never spun back up automatically
}
```

A dormant session has a placeholder `RpcBridge` and no agent process. It is revived only when a user navigates into it (via `addClient` → revive path). The agent making no further progress until then is fine for an idle archived session, but fatal for an in-flight delegate whose parent is awaiting a tool result.

### 1.2 Parent ↔ child rendezvous is in-process and ephemeral

`runDelegateSession()` in `defaults/tools/agent/extension.ts` calls `createDelegateSession()` (POST `/api/sessions`, `delegateOf: parent`) followed by `waitForDelegate()`, which holds open a `POST /api/sessions/:id/wait` connection until the child becomes idle. The server handler:

```ts
const waitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/wait$/);
…
await sessionManager.waitForIdle(id, timeoutMs);
const output = await sessionManager.getSessionOutput(id);
res.end(JSON.stringify({ status, output }));
```

On restart the long-poll TCP connection dies. There is no persisted record of "parent X is waiting for delegate Y in tool-use Z," so even if Y were eagerly revived there is no path back to X's tool-use. The parent's tool call is lost and the parent turn wedges on the abandoned `await fetch`.

### 1.3 Categories that **do** survive restart

- **Normal / team leads / team members** — coordinated via persisted goal/task state (`goal-store.ts`, `team-store.ts`). Restored eagerly by `restoreSessions()`. PR #406 added a `kind: 'worker' | 'reviewer'` discriminator on `TeamAgent`/`PersistedTeamEntry.agents[]` so restart logic can branch correctly per role.
- **Verification (LLM review / QA)** — `VerificationHarness` in `src/server/agent/verification-harness.ts` parks Promises keyed by `sessionId`, persists in-flight state to `<stateDir>/active-verifications.json`, and calls `resumeInterruptedVerifications()` after `restoreSessions()`. The reviewer session is registered as a team agent with `kind: "reviewer"` (`registerReviewerSession`) so `notifyTeamLead`/`resubscribeTeamEvents` skip it.

Delegates are the only category whose rendezvous is purely an in-memory `await fetch(…)` with no persisted state.

## 2. Architecture overview

### 2.1 New harness — `DelegateHarness`

Mirror `VerificationHarness`. Located at `src/server/agent/delegate-harness.ts`.

```ts
type DelegateKey = string;                                  // `${parentSessionId}:${toolUseId}`

export interface DelegateResultPayload {
    /** "completed" | "failed" | "timeout" | "terminated" */
    status: "completed" | "failed" | "timeout" | "terminated";
    output: string;
    error?: string;
}

export interface ActiveDelegate {
    parentSessionId: string;
    toolUseId: string;             // tool_use_id of the parent's `delegate` call
    delegateSessionId: string;     // child session id
    cwd: string;                   // child cwd (for restart-side spawn parity)
    title?: string;
    sandboxed?: boolean;           // mirrored from child PersistedSession
    instructions: string;          // first-line title + restart re-prompt fallback
    timeoutMs: number;             // budget remaining is wall-clock vs createdAt
    createdAt: number;
    /** Latched terminal result. Set when child terminates before parent re-registers. */
    latchedResult?: DelegateResultPayload;
}

export class DelegateHarness {
    private pending = new Map<DelegateKey, {
        resolve: (r: DelegateResultPayload) => void;
        reject: (err: Error) => void;
        active: ActiveDelegate;
    }>();
    private latched = new Map<DelegateKey, DelegateResultPayload>();
    private readonly persistPath: string;

    constructor(stateDir: string, private sessionManager: SessionManager,
                private broadcastFn: (sessionId: string, event: any) => void) {
        this.persistPath = path.join(stateDir, "active-delegates.json");
        this._loadFromDisk();   // populates `pending` shells with rejected resolvers if entries exist
        sessionManager.addTerminationListener((sessionId) => this._onSessionTerminated(sessionId));
    }

    /** Called by parent's `delegate` tool extension via internal endpoint. Idempotent on (parent, toolUseId). */
    register(active: ActiveDelegate): Promise<DelegateResultPayload> {
        const key = `${active.parentSessionId}:${active.toolUseId}`;
        // Idempotency: if a result was latched while we were down or between calls, drain it.
        const latched = this.latched.get(key);
        if (latched) { this.latched.delete(key); this._persist(); return Promise.resolve(latched); }
        // If there's already a pending entry, replace its resolver (re-register on reconnect).
        return new Promise<DelegateResultPayload>((resolve, reject) => {
            this.pending.set(key, { resolve, reject, active });
            this._persist();
        });
    }

    /** Called by internal /api/internal/delegate-result endpoint when child finishes. */
    submit(parentSessionId: string, toolUseId: string, result: DelegateResultPayload): boolean {
        const key = `${parentSessionId}:${toolUseId}`;
        const entry = this.pending.get(key);
        if (entry) {
            this.pending.delete(key);
            this._persist();
            entry.resolve(result);
            return true;
        }
        // Parent not yet (re-)registered — latch.
        this.latched.set(key, result);
        this._persist();
        return false;
    }

    /** Reject every pending wait whose parent session matches. Called when parent terminated/archived. */
    rejectAllForSession(parentSessionId: string, reason = "Parent session terminated"): string[] {
        const killed: string[] = [];
        for (const [key, entry] of this.pending) {
            if (entry.active.parentSessionId !== parentSessionId) continue;
            this.pending.delete(key);
            killed.push(entry.active.delegateSessionId);
            entry.reject(new Error(reason));
        }
        // Drop any latched results for this parent — they will never be drained.
        for (const key of [...this.latched.keys()]) {
            if (key.startsWith(`${parentSessionId}:`)) this.latched.delete(key);
        }
        this._persist();
        return killed;   // caller terminates these delegate sessions
    }

    /** Used by SessionManager.restoreSessions to keep delegates eagerly restored. */
    getActiveDelegateSessionIds(): Set<string> { /* … from persistPath … */ }

    private _onSessionTerminated(sessionId: string): void { /* see §6 */ }
    private _persist(): void { /* atomic write of pending+latched to active-delegates.json */ }
    private _loadFromDisk(): void { /* hydrate; rebuild empty pending shells whose resolvers throw on submit-late */ }
}
```

**Key choice — per-delegate keying.** Verification keys by `sessionId` only because at most one verification per reviewer session is in-flight. Delegates are different: a single parent can have N concurrent delegates (`parallel` array). We therefore key on `(parentSessionId, toolUseId)` from the start. This is also the natural idempotency key: re-`register()` against the same key replaces the resolver and drains any latched result.

**Broadcast `seq` wrapper.** Reuse the `seq`-stamping wrapper from PR #393. The harness only emits one UI-visible event — `delegate_result_delivered` — for telemetry; the substantive transcript update is the agent's tool_result, which is already `seq`-stamped through the agent's existing event flow.

### 2.2 Persistence — `active-delegates.json`

Sibling of `active-verifications.json`, at `<stateDir>/active-delegates.json`:

```json
{
  "pending": [
    { "parentSessionId": "…", "toolUseId": "tu_…", "delegateSessionId": "…",
      "cwd": "…", "sandboxed": false, "instructions": "…",
      "timeoutMs": 600000, "createdAt": 1730486400000, "title": "…" }
  ],
  "latched": [
    { "parentSessionId": "…", "toolUseId": "tu_…",
      "result": { "status": "completed", "output": "…" } }
  ]
}
```

Atomic-write via `writeFileSync` to a `.tmp` file then `rename` (same pattern as `_persistActive` in verification-harness.ts; recreate parent dir if missing). Cleanup on shutdown is **not** required — restart-resume is the whole point.

## 3. Tool-side changes — `defaults/tools/agent/extension.ts`

### 3.1 Replace `/wait` rendezvous

`waitForDelegate()` becomes a registration POST plus optional reconnect resilience:

```ts
async function waitForDelegate(
    sessionId: string,
    parentSessionId: string,
    toolUseId: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<{ status: string; output: string; error?: string }> {
    // POST is long-poll, but the SERVER persists registration first. If the
    // socket dies (restart, transient network), the server already has a
    // persisted entry; we can re-POST to /reconnect and pick up the same wait.
    const fetchTimeout = AbortSignal.timeout(timeoutMs + 30_000);
    const combinedSignal = signal ? AbortSignal.any([signal, fetchTimeout]) : fetchTimeout;

    const resp = await gatewayFetch(`/api/internal/delegate/wait`, {
        method: "POST",
        body: JSON.stringify({
            parentSessionId, toolUseId,
            delegateSessionId: sessionId, timeoutMs,
        }),
        signal: combinedSignal,
    });
    if (!resp.ok) {
        if (resp.status === 408) return { status: "timeout", output: "" };
        return { status: "failed", output: `API error: ${resp.status}`, error: await resp.text() };
    }
    const data = JSON.parse((await resp.text()).trim());
    return data;          // shape: DelegateResultPayload
}
```

The tool extension passes its `_toolCallId` (already a parameter to `execute()` in pi-coding-agent's tool API) as `toolUseId`.

### 3.2 New internal endpoints (server-side, see §5 for restore wiring)

| Endpoint | Method | Body | Returns | Purpose |
|---|---|---|---|---|
| `/api/internal/delegate/wait` | POST | `{ parentSessionId, toolUseId, delegateSessionId, timeoutMs }` | `DelegateResultPayload` (chunked, heartbeat newlines like current `/wait`) | Parent's tool registers and blocks. Idempotent on `(parentSessionId, toolUseId)`: re-POST replaces resolver and immediately drains any latched result. |
| `/api/internal/delegate/submit` | POST | `{ parentSessionId, toolUseId, result }` | `{ ok: true, drained: boolean }` | Called by the **server-side completion listener** (not by the delegate tool/agent itself) when the child session goes terminal. `drained=false` means parent not yet re-registered → latched. |
| `/api/internal/delegate/cancel` | POST | `{ parentSessionId, toolUseId, reason? }` | `{ ok: true }` | Called by parent on `AbortSignal` (Stop/Steer) to drop the wait without waiting for the child to finish. Server then terminates the child session. |

Idempotency key is `(parentSessionId, toolUseId)`. The parent never directly POSTs `/submit` — only the server's own delegate-completion listener does, in §6.

### 3.3 `runDelegateSession` flow

```ts
const sessionId = await createDelegateSession(parentSessionId, instructions, cwd, opts);
// Server-side: the createSession path now calls delegateHarness.register(...) BEFORE returning,
// so even if we crash before reaching waitForDelegate, the entry is persisted.
const result = await waitForDelegate(sessionId, parentSessionId, toolUseId, timeoutMs, signal);
// Terminate child as before (DELETE archives it).
try { await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }); } catch { /* ignore */ }
return mapResult(result);
```

**Parallel array** — N independent `(parentSessionId, toolUseId_i)` keys. The tool extension already `Promise.all`s the waits; nothing changes structurally except each wait posts to the new endpoint with its own `toolUseId`.

### 3.4 `delete` semantics on success/abort

Unchanged: parent still terminates the child via `DELETE /api/sessions/:id` after the wait resolves. The DELETE path triggers the same `addTerminationListener` callback that `submit`s on terminal child status, so the harness sees the result regardless of whether the trigger was the child going idle on its own or a parent-driven cleanup. The harness `submit` is idempotent — second-arrival is a no-op (returns `false`/already drained).

## 4. Restore changes — `SessionManager.restoreSessions()`

### 4.1 New `kind` discriminator on `PersistedSession`

Add `kind?: "delegate" | "worker" | "reviewer"` to `PersistedSession` in `session-store.ts` (sibling of the existing fields). Backward compat: pre-`kind` records keep behaving as before — code reads `kind ?? (delegateOf ? "delegate" : "worker")`.

The discriminator is **set** at delegate-session-creation time in `createDelegateSession()` (`session-manager.ts`) when persisting metadata, and at `registerReviewerSession()` (already done indirectly via team-store's `kind` field for reviewer team agents — we mirror it onto the session row too for symmetry). For ordinary sessions, `kind` defaults to `"worker"` on first persist.

### 4.2 Drop the dormant-only branch when a parent is waiting

```ts
const regular   = persisted.filter(ps => !ps.delegateOf);
const delegates = persisted.filter(ps => !!ps.delegateOf);

const activeDelegateIds = this.delegateHarness.getActiveDelegateSessionIds();   // from active-delegates.json

// Restore regular sessions in parallel as before
for (let i = 0; i < regular.length; i += CONCURRENCY) {
    await Promise.all(regular.slice(i, i + CONCURRENCY).map(ps => this.restoreOneSession(ps)));
}

// Delegates: eager-restore those whose parent has a registered (un-drained) wait.
const eagerDelegates = delegates.filter(ps => activeDelegateIds.has(ps.id) && !ps.archived);
const dormantDelegates = delegates.filter(ps => !eagerDelegates.includes(ps));

for (let i = 0; i < eagerDelegates.length; i += CONCURRENCY) {
    await Promise.all(eagerDelegates.slice(i, i + CONCURRENCY).map(ps => this.restoreOneSession(ps)));
}
for (const ps of dormantDelegates) {
    if (!ps.agentSessionFile) {
        try { this.getSessionStore(ps.projectId).archive(ps.id); } catch {}
        continue;
    }
    this.addDormantSession(ps);
}
```

Archived delegates remain dormant (we already filter `!ps.archived`). Eager-restored delegates flow through `restoreOneSession` → `restoreSession` → existing replay path. Replay sets `lastActivity` from disk (PR #385) — already correct.

`BOBBIT_SESSION_ID` is already injected at `restoreSession` line ~2275 (`bridgeOptions.env = { BOBBIT_SESSION_ID: ps.id }`). Eager restore reuses the same path so PR #397 holds.

### 4.3 Parent-side recovery when child can't be revived

If `restoreOneSession` throws for an eager delegate (e.g. agent-session-file gone, sandbox container can't be re-attached), the failure path is:

1. Persist the harness with a synthetic `submit(parent, toolUseId, { status: "failed", output: "", error: "delegate session lost across restart" })`. The latched result drains to the parent on next register.
2. The parent's already-running tool wait (if it survived restart on the agent process side — only true if agent process didn't restart, which it usually does since the gateway restart kills its child) returns the failed result and the tool emits a normal tool_result.
3. If the parent agent process *also* restarted, its restored turn re-runs the `delegate` tool? No — the agent's transcript already has the `tool_use` block; on restart the agent process resumes and the harness drains the latched failure to the in-flight wait when the parent re-POSTs. If the parent's underlying turn errored mid-restart, **PR #367 implicit-unstick** ensures the next user nudge clears `lastTurnErrored` and prepends `[SYSTEM: previous turn failed…]`. No extra change needed beyond ensuring the harness emits a synthetic failure rather than dangling.

## 5. Replay / resume on startup

Order in `createServer()` startup:

1. `projectContextManager.openAll()` — existing.
2. `sessionManager.restoreSessions()` — uses `delegateHarness.getActiveDelegateSessionIds()` to know which delegates to eager-restore.
3. `delegateHarness.resumeInterruptedDelegates()` — new method, mirrors `verificationHarness.resumeInterruptedVerifications()`.

Algorithm for `resumeInterruptedDelegates()`:

```ts
async resumeInterruptedDelegates(): Promise<void> {
    const persisted = this._loadFromDisk();
    for (const entry of persisted.pending) {
        const childId = entry.delegateSessionId;
        const child = this.sessionManager.getSession(childId);

        // Case A: child session is gone or never restored → synthesize failure result
        if (!child) {
            this.submit(entry.parentSessionId, entry.toolUseId, {
                status: "failed", output: "",
                error: "delegate session not restorable after restart",
            });
            continue;
        }

        // Case B: child is already terminal (status `terminated` or process exited)
        if (child.status === "terminated") {
            const output = await this.sessionManager.getSessionOutput(childId).catch(() => "");
            this.submit(entry.parentSessionId, entry.toolUseId,
                { status: "completed", output });
            continue;
        }

        // Case C: child is alive — attach a one-shot listener for terminal status
        this._attachCompletionListener(entry, child);
    }
    // Latched results stay on disk; they drain on next /wait POST.
}
```

`_attachCompletionListener` subscribes to the child's `RpcBridge` events (`agent_end` / `process_exit` / termination from `addTerminationListener`). On terminal, it calls `getSessionOutput` and `submit()`. **Crucially**, before posting any reminder-style nudge to the child (e.g. "you went idle without finishing"), the listener uses `await sessionManager.waitForStreaming(childId, 10_000).catch(() => {})` then `waitForIdle` — same pattern as PR #406 verification reminder. For the delegate case the simpler shape (just listen for `agent_end`/`process_exit`) is enough; we do **not** send reminders to delegates because delegates don't have a "must call X tool" obligation — they just run to idle and we capture their output. So the `waitForStreaming` requirement only applies if a future revision nudges the delegate.

**Persisted-but-no-pending-resolver shells.** When `_loadFromDisk` runs and re-creates the `pending` Map, the resolver functions are gone (they were closures in v8 heap). The harness rebuilds the Map with **placeholder rejecting resolvers**: any `submit()` that arrives before the parent re-registers gets latched into `latched`. On the parent's next `/api/internal/delegate/wait` POST, the registration replaces the placeholder and immediately drains the latched result if present. This makes the round-trip idempotent across restart.

## 6. Termination wiring

### 6.1 Parent terminated/archived

In `createServer()`:

```ts
sessionManager.addTerminationListener((sessionId, info) => {
    const killedDelegates = delegateHarness.rejectAllForSession(sessionId,
        info.reason === "archived" ? "Parent session archived" : "Parent session terminated");
    for (const childId of killedDelegates) {
        sessionManager.terminateSession(childId).catch(() => {});
    }
});
```

`rejectAllForSession` rejects every parked Promise so any still-connected `/api/internal/delegate/wait` HTTP handler returns 5xx — the client tool gets a clean error instead of hanging. Cascade-termination of children was already in place (`session-manager.ts` ~L3961); this listener adds the **harness** cleanup.

### 6.2 Delegate (child) terminated

The same `addTerminationListener` fires when a child terminates. The completion listener installed by `_attachCompletionListener` (or the live path in §6.3) catches it and submits a structured "terminated" result:

```ts
delegateHarness.submit(parentSessionId, toolUseId, {
    status: "terminated",
    output: await sessionManager.getSessionOutput(childId).catch(() => ""),
    error: info.reason === "archived" ? "Delegate archived" : "Delegate terminated",
});
```

The parent's `delegate` tool then returns this as a normal tool_result with `status: "terminated"`. The transcript thread continues cleanly.

### 6.3 Live-path completion listener

For non-restart-resume waits, we still need the same completion plumbing. Best place: in `createDelegateSession` after `await sendDelegatePrompt(…)`, install the listener via `_attachCompletionListener`. This keeps the live path and the resume path identical — both are `_attachCompletionListener` driven.

## 7. Concurrency — parallel delegates

- Each `params.parallel[i]` invocation produces a unique `toolUseId` (the pi-coding-agent tool runtime emits one per tool call; parallel children share the parent's tool_use_id? **No** — the `parallel` array is one tool call with N delegates. We synthesize `${toolUseId}#${i}` for the harness key.) The tool extension passes the synthesized key in the `/wait` body.
- `register()` keyed by `(parent, ${toolUseId}#${i})` ensures collision-free tracking.
- `submit()` is idempotent per key — late-arriving `submit` (e.g. parent termination cascade fires after the child already submitted on its own) is a no-op.
- `rejectAllForSession(parent)` walks **all** keys with that prefix and rejects each.

## 8. Sandbox

Docker delegates: `createDelegateSession` already inherits `sandboxed` from the parent (`session-manager.ts` ~L2747). On restart, `restoreSession` rebuilds the `RpcBridge` for sandboxed sessions and the existing path in `rpc-bridge.ts` (~L426–427) injects `BOBBIT_SESSION_ID` into the `docker exec -e` args. **No sandbox-specific code changes are required** — eager-restoring a delegate routes through the same `restoreOneSession` → `restoreSession` path as any other sandboxed session.

The completion listener attaches to the restored `RpcBridge` exactly as for host sessions; `agent_end` / `process_exit` events propagate identically across the docker-exec boundary.

Caveat: if the **project sandbox container** itself is gone after restart (rare; only if `docker rm` happened during downtime), `restoreSession` will fail and §4.3's failure path drains a synthetic failure to the parent. This is the correct behavior — there is no recovery.

## 9. Client-side — message reducer

The new transcript message produced when a delegate completes is the parent agent's `tool_result` block emitted by `RpcBridge` after the tool's `await fetch` returns. This already flows through:

- **Live path:** event-buffer's `pushFrame` stamps `seq` on the wrapping `message_end` frame, which the client receives and routes through `reduce(state, { type: "live-event", frame, seq })`. Sort key `(_order, _insertionTick)` places it correctly relative to surrounding events. **No new reducer action.**
- **Snapshot replay path** (user navigates away and back, or session reload): the message is read from `.jsonl` and dispatched as part of the `{ type: "snapshot", messages }` action; reducer assigns `_order = SNAPSHOT_ORDER_FLOOR + i` (existing logic in `message-reducer.ts`).

The `delegate_result_delivered` telemetry broadcast (optional, useful for dashboard) is **not** a transcript message — it goes to the per-session WS and is consumed by the delegate-card renderer (`src/ui/tools/renderers/DelegateRenderer.ts`, if present) for status-pill updates only. It does not touch `state.messages`.

This satisfies PR #412: every transcript-mutating path remains one of the 13 reducer actions; we add nothing new.

## 10. Test plan

### 10.1 Unit tests — `tests/delegate-harness.test.ts` (new)

- `register` then `submit` resolves the Promise with the supplied result.
- `submit` before `register` latches; subsequent `register` drains immediately and clears the latch.
- `register` against an existing key replaces the resolver; old Promise rejects with "superseded".
- `rejectAllForSession(parent)` rejects every pending key with that parent prefix and clears matching latched entries.
- Persistence round-trip: `register` → write → reconstruct from disk → `submit` from new instance latches; subsequent `register` drains.
- `_loadFromDisk` tolerates absent / malformed file (returns empty).
- Atomic write: persistPath is rewritten on every mutation; partial-write recovery via `.tmp` rename.

### 10.2 API E2E tests — `tests/e2e/delegate-restart.spec.ts` (new)

Use `in-process-harness.js`. Test cases:

- **D-RST-01** Single delegate, no restart — happy path baseline. POST `/wait`, mock child terminates, parent receives `completed` result.
- **D-RST-02** Single delegate, restart while child running. Drive: register, kill in-process server, restart, `resumeInterruptedDelegates` re-attaches listener, mock child finishes, latched result drains on parent re-POST.
- **D-RST-03** Single delegate, child completed during downtime. Drive: register, terminate child, kill server before resolver fires; on restart the child is terminal → resume immediately latches `completed` result.
- **D-RST-04** Parallel (N=3) delegates, restart mid-flight; each `(parent, toolUseId#i)` survives independently.
- **D-RST-05** Parent termination cascade: register, terminate parent → all keyed waits reject with "Parent session terminated"; child sessions terminated.
- **D-RST-06** Idempotent submit: two `/api/internal/delegate/submit` calls for the same key — second returns `{ ok: true, drained: false }`, no double-resolve.

### 10.3 Browser E2E test — `tests/e2e/ui/delegate-restart.spec.ts` (new)

Use `gateway-harness.js` (full server spawn + Playwright). Mandatory per AGENTS.md E2E coverage requirement.

Scenarios:

- **DUI-01 single restart-mid-delegate.** Open session, send a prompt that triggers a single `delegate` (use the harness's mock-agent fixture so the child's "work" is deterministic). Wait for the delegate card to render with status "running". Restart gateway via `gateway.restart()`. After reconnect, drive the mock child to idle. Assert: parent transcript receives a tool_result; delegate card transitions to "completed"; no duplicate cards; no orphan dormant entry in sidebar.
- **DUI-02 parallel restart.** Same as DUI-01 but with `parallel: [..., ..., ...]`. Restart mid-flight. Assert: all three children resume independently; each lands a tool_result; transcript ordering correct (no out-of-order proposals — PR #412 invariant).
- **DUI-03 persistence across reload.** After successful completion (no restart), reload the page. Assert: completed delegate cards still render correctly from snapshot.
- **DUI-04 parent abort cleanup.** Trigger Stop on the parent mid-delegate. Assert: `/api/internal/delegate/cancel` fires; child sessions terminate; no leaked entries in `active-delegates.json`.

### 10.4 Existing tests to preserve

- `tests/e2e/sandbox-token.spec.ts` already asserts `/api/sessions/:id/wait` is sandbox-allowed. The new `/api/internal/delegate/wait` and `/submit` endpoints must be added to the same sandbox allow-list (`src/server/auth/sandbox-guard.ts`); update that test correspondingly.

## 11. File-by-file change list

In dependency order (new files first, then modifications):

1. **`src/server/agent/delegate-harness.ts`** — new. `DelegateHarness` class, `ActiveDelegate` interface, `DelegateResultPayload` interface. ~250 LoC. Mirror structure of `verification-harness.ts`'s persistence helpers.
2. **`src/server/agent/session-store.ts`** — add `kind?: "delegate" | "worker" | "reviewer"` to `PersistedSession`. Default to `"worker"` on persist if absent (or `"delegate"` when `delegateOf` is set; keep cascading for legacy records via `kind ?? (delegateOf ? "delegate" : "worker")` reader helper).
3. **`src/server/agent/session-manager.ts`** —
   - In `createDelegateSession()`, set `kind: "delegate"` when persisting; before returning, call `delegateHarness.register(activeDelegateRecord)` so the persisted entry is on disk before any failure window.
   - Install the live-path completion listener on the new child session (subscribe to `agent_end`/`process_exit`/termination), call `delegateHarness.submit(...)`. This is the same listener the resume path uses.
   - Rework `restoreSessions()` per §4.2 — eager-restore delegates whose parent has a registered wait.
4. **`src/server/server.ts`** —
   - Construct `delegateHarness` in `createServer()` after `sessionManager`.
   - Wire `sessionManager.addTerminationListener` per §6.1.
   - Add three internal endpoints (`/wait`, `/submit`, `/cancel`) per §3.2. The `/wait` endpoint mirrors the existing `/api/sessions/:id/wait` chunked-heartbeat pattern.
   - In startup sequence, after `sessionManager.restoreSessions()`, call `delegateHarness.resumeInterruptedDelegates()` (parallel to the existing `verificationHarness.resumeInterruptedVerifications()`).
   - Keep the legacy `POST /api/sessions/:id/wait` endpoint working for the bg-process path (`/api/sessions/:id/bg-processes/:pid/wait` is unrelated). Optionally mark the legacy delegate-`/wait` path deprecated; we don't need to remove it in this change since only the delegate tool calls it.
5. **`src/server/auth/sandbox-guard.ts`** — add `/api/internal/delegate/wait`, `/submit`, `/cancel` to the sandbox allow-list (same justification as `/wait` at L48).
6. **`defaults/tools/agent/extension.ts`** —
   - `waitForDelegate` rewritten per §3.1; takes `parentSessionId` and `toolUseId`.
   - `runDelegateSession` and the `parallel` loop: thread `_toolCallId` through and synthesize `${toolUseId}#${i}` for parallel keys.
   - `AbortSignal` handler: on abort, fire-and-forget `/api/internal/delegate/cancel` before the `DELETE /api/sessions/:id`.
7. **`tests/delegate-harness.test.ts`** — new unit tests per §10.1.
8. **`tests/e2e/delegate-restart.spec.ts`** — new API E2E tests per §10.2.
9. **`tests/e2e/ui/delegate-restart.spec.ts`** — new browser E2E per §10.3.
10. **`tests/e2e/sandbox-token.spec.ts`** — extend with new endpoints.
11. **`AGENTS.md`** — add a "Debugging" entry: "Delegate not resumed across restart — check `active-delegates.json`, harness `_loadFromDisk` log line, eager-restore branch in `restoreSessions`." Plus a Recipes line: "Add a new restart-resilient delegate-style tool → mirror `DelegateHarness` and the `/api/internal/delegate/*` endpoints; see `docs/design/delegate-restart-resilience.md`."
12. **`docs/blocking-tools.md`** — append a paragraph noting `DelegateHarness` as a second concrete instance of the pattern.
13. **`docs/internals.md`** — short "Delegate restart resilience" subsection cross-linking to this doc.

## 12. Out-of-scope reminders

- **Recursive delegation stays disabled.** `defaults/tools/agent/extension.ts` short-circuits when `BOBBIT_DELEGATE_OF` is in the env — unchanged. No restored delegate gets the `delegate` tool registered.
- **Tool schema and observable semantics unchanged.** `delegate` still takes `instructions`/`parallel`/`context`/`timeout_minutes`; still returns the same markdown summary + `details.delegates[]` shape. Restart resilience is purely mechanism, not surface.
- **No changes** to non-delegate session persistence/restore.
- **No UI redesign** of the sidebar delegate listing beyond making sure restored delegates appear correctly (they will — the eager-restore path uses the same code as worker session restore).

## 13. Acceptance-criteria mapping

| Criterion | Section addressing it |
|---|---|
| Parent with in-flight delegate survives restart; delegate restored (not dormant); result flows back to tool-use; parent turn resumes cleanly | §4.2 (eager-restore), §5 (resume), §3.1 (re-register and drain) |
| Idempotent submit; result delivered on next wake if delegate completed during downtime | §2.1 (latched map), §5 (Case B & C), §10.1 (round-trip test), §10.2 D-RST-03 |
| Parent termination/archive while delegate running → delegate cleanly terminated, no orphan promises | §6.1, §10.2 D-RST-05 |
| Multiple concurrent delegates from same parent (`parallel`) survive restart independently | §2.1 (key shape), §7, §10.2 D-RST-04, §10.3 DUI-02 |
| Sandboxed delegates survive restart on same terms | §8 |
| Reminder/wake paths use `waitForStreaming` not `waitForIdle` alone | §5 (delegates don't get reminders today; if added, must use `waitForStreaming` first per §5 last paragraph) |
| `lastActivity` for restored delegates preserved per PR #385 | §4.2 (eager restore reuses `restoreSession`, which already gates `lastActivity = Date.now()` on the `restoring` flag) |
| Implicit-unstick (PR #367) still applies to parent whose delegate failed across restart | §4.3 (failure path drains structured failure → parent's tool_result is errored → next user prompt clears `lastTurnErrored` per existing PR #367 logic) |
| New transcript messages flow through unified reducer (PR #412): server `seq` for live, `SNAPSHOT_ORDER_FLOOR + i` for snapshot | §9 |
| Every revived delegate spawn injects `BOBBIT_SESSION_ID` (PR #397) | §4.2 last paragraph; existing `restoreSession` + `rpc-bridge` paths handle host and Docker uniformly |
| Remote branch cleanup (PR #378) not regressed | Delegates don't have their own worktrees — they share the parent's worktree (`session-manager.ts::cleanupWorktreeAndBranch` already early-returns on `delegateOf` per existing logic ~L3960–4080). No change in this PR touches that path; eager restore does not create worktrees. |
| New browser E2E test covers restart-mid-delegate (single + parallel) | §10.3 DUI-01, DUI-02 |

