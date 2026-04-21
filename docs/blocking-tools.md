# Blocking tools — agent pauses while another party produces a result

Some builtin tools need to pause the agent turn and wait for something another subsystem must produce before the tool can return. Bobbit implements these via a **harness** pattern: the tool extension makes a blocking HTTP call to an internal endpoint, the server parks a Promise keyed by `(sessionId, toolUseId)`, and a later HTTP call resolves that Promise so the original response can carry the result back to the agent.

The canonical example is:

- `verification_result` — a reviewer/QA agent submits a verdict; the signal that originally triggered verification resolves with the result. When a QA agent submits a report via `report_html_file`, the server automatically rewrites `<img src="file://...">` references under the session cwd (including the `.bobbit-qa/` subtree) to inline base64 data URIs, with a 20 MB cumulative cap. See [docs/qa-testing.md — Screenshots in QA reports](qa-testing.md#screenshots-in-qa-reports).

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

A blocking-tool harness exposes three methods:

| Method | When called | Purpose |
|---|---|---|
| `register(sessionId, toolUseId, payload)` | From the code that starts a wait (e.g. when a gate signal triggers verification). Returns a Promise. | Park a pending entry; give the caller something to await. |
| `submit(sessionId, toolUseId, result)` | From the REST handler invoked when the external party produces a result. | Resolve the parked Promise with the result. |
| `rejectAllForSession(sessionId, reason?)` | From the session-termination listener. | Reject any outstanding Promises so blocked callers get a clean error instead of hanging forever. |

Keying by `(sessionId, toolUseId)` means concurrent waits against the same session do not collide, and re-registration of the same `toolUseId` is idempotent — it latches onto the existing entry instead of creating a duplicate.

## Session termination & replay behavior

- **Termination.** `sessionManager.addTerminationListener` wires the harness's `rejectAllForSession` in `server.ts`. When a session is terminated or aborted, every pending `register()` Promise rejects with a "Session terminated" error. The caller sees a clean rejection and can surface it.
- **Server restart.** In-flight verifications are persisted (see `active-verifications.json`) so the harness can resume them after restart. Purely transient blocking calls that are not persisted will see the open HTTP connection severed and return an error; if that matters for your new tool, mirror the persistence pattern in `verification-harness.ts`.

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
