# Blocking tools — agent asks, user answers

Some builtin tools need to pause the agent turn and wait for something the user (or another subsystem) must produce before the tool can return. Bobbit implements these via a **harness** pattern: the tool extension makes a blocking HTTP call to an internal endpoint, the server parks a Promise keyed by `(sessionId, toolUseId)`, and a later HTTP call resolves that Promise so the original response can carry the result back to the agent.

The canonical examples today are:

- `ask_user_choices` — agent asks the user 1–5 multiple-choice questions via an inline widget; the widget POSTs answers.
- `verification_result` — a reviewer/QA agent submits a verdict; the signal that originally triggered verification resolves with the result.

This page uses `ask_user_choices` as the walkthrough. `verification_result` follows the same shape, just with a different UI surface and a different resolver target (a gate signal rather than a chat widget).

## Flow

```
  Agent                  Tool extension         Bobbit server                    UI (chat widget)
    │                          │                      │                                │
    │  tool_use                │                      │                                │
    ├─────────────────────────►│                      │                                │
    │                          │  POST /api/internal/ │                                │
    │                          │  user-question       │                                │
    │                          ├─────────────────────►│  register(sessionId,           │
    │                          │                      │           toolUseId) → Promise │
    │                          │                      │  broadcast                     │
    │                          │                      │  "user_question_pending" ─────►│ render widget
    │                          │    (blocking)        │                                │
    │                          │                      │                                │  user picks + submits
    │                          │                      │  POST /api/internal/           │
    │                          │                      │  user-question/submit  ◄───────┤
    │                          │                      │  submit(sessionId,             │
    │                          │                      │         toolUseId, answers)    │
    │                          │  { answers: [...] }  │  → resolves Promise            │
    │                          │◄─────────────────────┤  broadcast                     │
    │                          │                      │  "user_question_answered" ────►│ freeze widget
    │  tool_result             │                      │                                │
    │◄─────────────────────────┤                      │                                │
```

The agent-side block is a plain HTTP request — no special SDK support required. The tool extension is written exactly like any other builtin tool; the blocking is just an `await fetch(...)`.

## File layout

```
defaults/tools/ask/
  ask_user_choices.yaml              Tool manifest (name, description, input schema, docs).
  extension.ts                       Tool extension — registers the tool and POSTs to
                                     /api/internal/user-question.

src/server/agent/
  user-question-harness.ts           UserQuestionHarness class. Map of pending questions keyed
                                     by `${sessionId}:${toolUseId}`. Exposes register / submit /
                                     rejectAllForSession / listForSession. Also exports
                                     validateQuestions and validateAnswers.

src/server/server.ts
  /api/internal/user-question         POST  — blocking register() call from the tool extension.
  /api/internal/user-question/submit  POST  — UI widget submits answers here; resolves Promise.
  /api/internal/user-question/pending GET   — rehydrate pending list after reconnect.
  (session-termination listener calls userQuestionHarness.rejectAllForSession)

src/ui/components/AskUserChoicesWidget.ts
                                     Lit element <ask-user-choices-widget>. Renders tabs, auto-
                                     advances on selection, Submit calls /submit. Listens for
                                     the window event "user-question-answered" to finalize if
                                     another client submits first.

src/ui/tools/renderers/AskUserChoicesRenderer.ts
                                     ToolRenderer that mounts the widget, feeds it params,
                                     and — once the tool_result is present — parses
                                     { answers: [...] } and switches the widget to read-only.

src/ui/tools/index.ts                registerToolRenderer("ask_user_choices", ...)

src/app/remote-agent.ts              WS handler: forwards "user_question_pending" and
                                     "user_question_answered" server messages to the window
                                     as CustomEvents the widget listens for.
```

## Harness contract

`UserQuestionHarness` (and `VerificationHarness` for verdicts) both follow the same three-method contract:

| Method | When called | Purpose |
|---|---|---|
| `register(sessionId, toolUseId, payload)` | From the REST handler that the tool extension blocks on. Returns a Promise. | Park a pending entry and give the tool extension something to await. |
| `submit(sessionId, toolUseId, result)` | From a separate REST handler invoked by the UI (or a reviewer agent). | Resolve the parked Promise with the user-supplied result. |
| `rejectAllForSession(sessionId, reason?)` | From the session-termination listener. | Reject any outstanding Promises so the blocked tool extensions get a clean error back instead of hanging forever. |

Keying by `(sessionId, toolUseId)` means concurrent questions against the same session do not collide, and agent replay of the same `toolUseId` is idempotent — a re-registration latches onto the existing entry instead of creating a duplicate.

## Session termination & replay behavior

- **Termination.** `sessionManager.addTerminationListener` wires each harness's `rejectAllForSession` in `server.ts`. When a session is terminated or aborted, every pending `register()` Promise rejects with `"Session terminated"`. The tool extension's `fetch` resolves with an HTTP error, the `execute()` wrapper returns `isError: true`, and the agent sees a regular tool-error result.
- **Server restart.** Pending entries are **not persisted**. If the server restarts while a question is outstanding, the tool extension's open HTTP connection is severed and the tool returns an error. On the UI side, any `user_question_pending` widget rendered before the restart is still in the replayed message history — but because the server no longer has a pending entry, a late `submit` returns `404 "No pending question for this session/toolUseId"`. The widget surfaces this as an error. This is the same tradeoff `VerificationHarness` makes for in-flight verifications.
- **Reconnect.** A fresh client can call `GET /api/internal/user-question/pending?sessionId=...` to rehydrate the list of outstanding questions (used to drive widget state on cold load).
- **Multiple clients.** When one client submits, the server broadcasts `user_question_answered` over WS. Other clients receive the event, dispatch `user-question-answered` on `window`, and the widget listens for it to freeze into the read-only final state — so all connected browsers converge.

## Adding your own blocking tool

1. **Write the tool manifest and extension.** Put them under `defaults/tools/<group>/`. The extension resolves the gateway URL and token from env vars (`BOBBIT_GATEWAY_URL`, `BOBBIT_TOKEN`, `BOBBIT_SESSION_ID`) or the state directory, then POSTs to an internal endpoint and awaits the response. Mirror `defaults/tools/ask/extension.ts`.
2. **Add a harness.** New file under `src/server/agent/`. Keep the shape of `UserQuestionHarness`: a `Map<key, Pending>` plus `register` / `submit` / `rejectAllForSession`. Add input validators alongside (as `validateQuestions` / `validateAnswers` do) so both HTTP handlers can share them.
3. **Wire the REST endpoints** in `handleApiRoute()` in `src/server/server.ts`:
   - A POST that validates input, calls `harness.register(...)`, optionally broadcasts a `*_pending` WS event, and sends the resolved value as the response body.
   - A POST that validates the submission, calls `harness.submit(...)`, broadcasts `*_answered`, and returns `{ ok: true }`.
   - Optionally a GET for reconnect rehydrate.
   - Construct the harness in `createServer()` and register a `sessionManager.addTerminationListener` that calls `rejectAllForSession`.
4. **Broadcast WS events.** Add the two message types to the WS protocol and forward them to the UI from `remote-agent.ts` (dispatch as DOM `CustomEvent`s on `window` — keeps the widgets decoupled from the WS transport).
5. **UI surface.** If the tool needs an in-chat widget, add a Lit element under `src/ui/components/` plus a `ToolRenderer` under `src/ui/tools/renderers/` and register it in `src/ui/tools/index.ts`. The renderer should:
   - Render the widget while `result` is absent.
   - Parse the final result text once the tool returns and flip the widget to read-only.
   - Forward `sessionId` and `toolUseId` from `ToolRenderContext` so the widget can submit.
6. **Tests.** Unit-test the harness directly (no server needed). For the full round-trip, add an API E2E test in `tests/e2e/` using the in-process harness, and a browser E2E test in `tests/e2e/ui/` that drives the widget.

## See also

- `verification_result` tool in `defaults/tools/tasks/` and `src/server/agent/verification-harness.ts` — the sibling pattern, used to deliver reviewer/QA verdicts to gate signals. Its harness carries more state (persisted active verifications, phased step execution, sandbox-aware command execution) because verification is a long-lived workflow step rather than a single chat prompt, but the register/submit/reject core is the same.
- [docs/rest-api.md](rest-api.md) — full REST surface, including the `/api/internal/*` endpoints.
- [docs/goals-workflows-tasks.md](goals-workflows-tasks.md) — how `verification_result` plugs into gate verification.
