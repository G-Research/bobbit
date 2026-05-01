# Blocking tools — agent pauses while another party produces a result

Some builtin tools need to pause the agent turn and wait for something another subsystem must produce before the tool can return. Bobbit implements these via a **harness** pattern: the tool extension makes a blocking HTTP call to an internal endpoint, the server parks a Promise keyed by `(sessionId, toolUseId)`, and a later HTTP call resolves that Promise so the original response can carry the result back to the agent.

The canonical examples are:

- `verification_result` — a reviewer/QA agent submits a verdict; the signal that originally triggered verification resolves with the result. When a QA agent submits a report via `report_html_file`, the server automatically rewrites `<img src="file://...">` references under the session cwd (including the `.bobbit-qa/` subtree) to inline base64 data URIs, with a 20 MB cumulative cap. See [docs/qa-testing.md — Screenshots in QA reports](qa-testing.md#screenshots-in-qa-reports).
- `delegate` — a parent agent spawns one or more child sessions and blocks on each child's terminal status. The `DelegateHarness` (`src/server/agent/delegate-harness.ts`) parks Promises keyed by `(parentSessionId, toolUseId)` (with `${toolUseId}#${i}` for parallel slots), persists in-flight entries to `<stateDir>/active-delegates.json`, and is resumed after server restart by `resumeInterruptedDelegates()`. The tool extension POSTs `/api/internal/delegate/wait` instead of the legacy `/api/sessions/:id/wait`, and fires `/api/internal/delegate/cancel` on `AbortSignal` abort. Full design: [docs/design/delegate-restart-resilience.md](design/delegate-restart-resilience.md).

Blocking is the right shape here because **another agent is actively doing work** (running reviews, executing QA steps) while the requesting agent waits. The requesting agent genuinely cannot make progress until the verdict lands.

Contrast: `ask_user_choices` used to use this pattern but was moved to a non-blocking design. Waiting on a human is not "work in progress" — holding the turn open misleads the UI ("thinking…") and creates fragile in-memory state. See [docs/non-blocking-ask.md](non-blocking-ask.md) for the alternative pattern used there.

## Flow (verification_result)

```
  Reviewer agent        Tool extension         Bobbit server                     Gate signal (caller)
    │                          │                      │                                │
    │                          │                      │  signal triggers verification  │
    │                          │                      │  register(sessionId,           │
    │                          │                      │           toolUseId) → Promise │
    │                          │                      │                                │ (awaits)
    │  tool_use                │                      │                                │
    ├─────────────────────────►│                      │                                │
    │                          │  POST /api/internal/ │                                │
    │                          │  verification/submit │                                │
    │                          ├─────────────────────►│  submit(sessionId,             │
    │                          │                      │         toolUseId, verdict)    │
    │                          │                      │  → resolves Promise ──────────►│ gate passes/fails
    │                          │  { ok: true }        │                                │
    │                          │◄─────────────────────┤                                │
    │  tool_result             │                      │                                │
    │◄─────────────────────────┤                      │                                │
```

The agent-side block is a plain HTTP request — no special SDK support required. The tool extension is written exactly like any other builtin tool; the blocking is just an `await fetch(...)`.

## File layout

```
defaults/tools/tasks/
  verification_result.yaml             Tool manifest (name, description, input schema, docs).
  extension.ts                         Tool extension — registers the tool and POSTs to
                                       the verification submit endpoint.

src/server/agent/
  verification-harness.ts              VerificationHarness class. Map of pending verifications
                                       keyed by `${sessionId}:${toolUseId}`. Exposes register /
                                       submit / rejectAllForSession plus persistence for in-
                                       flight verifications and phased step execution.

src/server/server.ts
  POST /api/internal/verification/submit
                                       UI-or-agent facing endpoint: validates the verdict,
                                       calls harness.submit(...), returns { ok: true }.
  (session-termination listener calls verificationHarness.rejectAllForSession)

src/ui/components/...                  Gate/task UI surfaces (not a chat widget — verdicts flow
                                       through gate signals, not inline transcript cards).
```

Exact file paths may evolve; search for `VerificationHarness` to find the live wiring.

## Harness contract

A blocking-tool harness exposes these methods:

| Method | When called | Purpose |
|---|---|---|
| `register(sessionId, toolUseId, payload)` | From the code that starts a wait (e.g. when a gate signal triggers verification, or when the parent's `delegate` tool POSTs `/wait`). Returns a Promise. | Park a pending entry; give the caller something to await. If a result was latched while the caller was disconnected, drain it immediately. |
| `submit(sessionId, toolUseId, result)` | From the REST handler invoked when the external party produces a result, OR from the server-side completion listener. | Resolve the parked Promise. If no `register()` is currently parked (caller is reconnecting), latch the result for the next register. |
| `acknowledge(sessionId, toolUseId)` | From the `/wait` (or equivalent) handler, AFTER the HTTP response body has been flushed to the caller. | Drop the latched entry from disk and mark the key fully completed so a straggler `submit` is a no-op. |
| `rejectAllForSession(sessionId, reason?)` | From the session-termination listener. | Reject any outstanding Promises and drop matching latched entries so blocked callers get a clean error instead of hanging forever. |

Keying by `(sessionId, toolUseId)` means concurrent waits against the same session do not collide, and re-registration of the same `toolUseId` is idempotent — it drains a latched result if one exists, else parks fresh.

### Durability invariant

A latched terminal result must survive the window between the moment the caller's `/wait` POST resolves a Promise and the moment the HTTP response body actually reaches the caller's process. If the gateway crashes mid-flush, the on-disk latch lets a retried `/wait` re-drain the same result — nothing is lost.

The contract therefore is:

1. `submit` writes the latch to disk **before** resolving the parked Promise.
2. `register` reads (and resolves with) any latched result without deleting it.
3. `acknowledge` is called **after** `res.end()` has flushed the response body, and only then is the latch removed from disk and the key promoted into the `completed` Set.

Removing the latch synchronously from `register` (or `submit`) breaks this invariant — see `DelegateHarness` for the canonical implementation.

### Idempotency contract — first-write-wins

A harness key has three terminal states tracked in memory:

- **`pending`** — a `register()` parked a resolver and is awaiting a result.
- **`latched`** — a result arrived but no `register()` was parked; the result is on disk awaiting drain.
- **`completed`** — the result was drained AND acknowledged; the key is closed.

First write to either `latched` or `completed` wins. Subsequent `submit()` calls for the same key (e.g. parent termination cascade firing after the child's own `agent_end`) drop on the floor and return `{ drained: false }`. This keeps the contract robust against the multiple paths that can independently observe a child's terminal state (RPC `agent_end`, `process_exit`, global termination listener) without producing duplicate tool_results.

The `completed` Set is in-memory only — it is wiped by `_loadFromDisk()` on restart. This is intentional: once the gateway restarts, every key is either dormant (no pending, no latch — already acknowledged) or has its disk state to drive the next round-trip.

## Session termination & replay behavior

- **Termination.** `sessionManager.addTerminationListener` wires the harness's `rejectAllForSession` in `server.ts`. When a session is terminated or aborted, every pending `register()` Promise rejects with a "Session terminated" error. The caller sees a clean rejection and can surface it.
- **Server restart.** In-flight verifications are persisted to `active-verifications.json`; in-flight delegates to `active-delegates.json`. After `restoreSessions()`, each harness's resume helper (`resumeInterruptedVerifications` / `resumeInterruptedDelegates`) re-attaches completion listeners to the restored sessions so terminal status flows back to the harness, then re-drives the parked HTTP response when the caller reconnects. Purely transient blocking calls that are not persisted will see the open HTTP connection severed and return an error; if that matters for your new tool, mirror the persistence pattern.

## Concrete instances

| Tool | Harness | Persistence file | Internal endpoints | Reference |
|---|---|---|---|---|
| `verification_result` | `VerificationHarness` (`src/server/agent/verification-harness.ts`) | `<stateDir>/active-verifications.json` | `POST /api/internal/verification/submit` | This page; [docs/goals-workflows-tasks.md](goals-workflows-tasks.md) |
| `delegate` | `DelegateHarness` (`src/server/agent/delegate-harness.ts`) | `<stateDir>/active-delegates.json` | `POST /api/internal/delegate/{wait,submit,cancel}` | [docs/design/delegate-restart-resilience.md](design/delegate-restart-resilience.md), [docs/internals.md — Delegate restart resilience](internals.md#delegate-restart-resilience) |

Delegate keying additionally synthesizes `${toolUseId}#${i}` for the `parallel` array so independent waits from the same parent tool call never collide.

## Adding your own blocking tool

1. **Write the tool manifest and extension.** Put them under `defaults/tools/<group>/`. The extension resolves the gateway URL and token from env vars (`BOBBIT_GATEWAY_URL`, `BOBBIT_TOKEN`, `BOBBIT_SESSION_ID`) or the state directory, then POSTs to an internal endpoint and awaits the response. Mirror `defaults/tools/tasks/extension.ts`.
2. **Add a harness.** New file under `src/server/agent/`. Keep the shape: a `Map<key, Pending>` plus `register` / `submit` / `rejectAllForSession`. Add input validators alongside so HTTP handlers can share them.
3. **Wire the REST endpoint(s)** in `handleApiRoute()` in `src/server/server.ts`:
   - A POST that validates the submission, calls `harness.submit(...)`, and returns `{ ok: true }`.
   - If the caller is external (e.g. a chat widget), also wire whatever start-side trigger calls `harness.register(...)`.
   - Construct the harness in `createServer()` and register a `sessionManager.addTerminationListener` that calls `rejectAllForSession`.
4. **UI surface (if needed).** Most blocking tools today drive non-chat UI (gate panels, task dashboards). If your tool needs an inline chat widget, see `src/ui/components/` and `src/ui/tools/renderers/` for the patterns; register the renderer in `src/ui/tools/index.ts`.
5. **Tests.** Unit-test the harness directly (no server needed). For the full round-trip, add an API E2E test in `tests/e2e/` using the in-process harness.

## Before choosing blocking

Ask: **"Is another agent or subsystem actively working on producing this result?"**

- **Yes** (reviewer agent running, QA session executing steps, background worker computing): blocking is correct. The requesting agent cannot proceed and the "thinking" indicator is accurate.
- **No — we're waiting on a human** (pick options, approve, answer a question): use the non-blocking pattern. The agent should end its turn and resume later when the human's input arrives as a normal transcript message. See [docs/non-blocking-ask.md](non-blocking-ask.md).

## See also

- [docs/non-blocking-ask.md](non-blocking-ask.md) — `ask_user_choices` non-blocking flow and when to use it instead.
- [docs/rest-api.md](rest-api.md) — full REST surface, including the `/api/internal/*` endpoints.
- [docs/goals-workflows-tasks.md](goals-workflows-tasks.md) — how `verification_result` plugs into gate verification.
