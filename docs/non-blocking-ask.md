# Non-blocking `ask_user_choices`

`ask_user_choices` posts 1–5 multiple-choice questions to the user as an inline chat widget. Unlike `verification_result`, it does **not** block the agent's turn. The tool returns a synchronous stub, the turn ends, and the user's answers arrive later as a tagged user message.

This page documents why the tool is non-blocking, the wire format of that tagged message, and how the UI and agent converge across restarts and multiple tabs.

## Why non-blocking

The tool was previously blocking: the extension POSTed to an internal REST endpoint, the server parked a Promise keyed by `(sessionId, toolUseId)`, and the UI widget's submit resolved it. That worked but had three concrete problems:

1. **Misleading UI state.** The session showed as "thinking…" while the agent was actually idle — just waiting on a human. Team leads polling subordinate sessions couldn't tell real work apart from human-wait.
2. **In-memory fragility.** The pending Promise lived only in process memory. A server restart severed the extension's HTTP connection and errored the tool; a reconnecting browser had to hit a special `/pending` endpoint to rehydrate widget state.
3. **Multi-tab drift.** "This widget was answered" lived only in RAM, not the transcript. If tab A submitted, tab B needed a custom WebSocket event (`user_question_answered`) to flip to read-only mode.

The fix is to use the chat transcript itself as the communication medium. The user's submission becomes a normal user message in the log — persisted, replayed, multi-tab-safe, restart-safe, all for free.

`verification_result` stays blocking because a reviewer/QA agent is **actually doing work** during the wait. That's a fundamentally different situation from "waiting on a human to click a button." See [docs/blocking-tools.md](blocking-tools.md) for that pattern.

## Flow

```
  Agent                Tool extension        Bobbit server                     UI (all tabs)
    │                       │                      │                               │
    │  tool_use             │                      │                               │
    ├──────────────────────►│                      │                               │
    │                       │ (no HTTP call)       │                               │
    │  { status: "posted",  │                      │                               │
    │    tool_use_id }      │                      │                               │
    │◄──────────────────────┤                      │                               │
    │                       │                      │  tool_use broadcast ─────────►│ render
    │  turn ends; agent idle                       │                               │ interactive
    │                       │                      │                               │ widget
    │                                              │                               │
    │                                              │                               │  user submits
    │                                              │  POST /api/internal/          │
    │                                              │  user-question/submit  ◄──────┤
    │                                              │  validate + enqueuePrompt     │
    │                                              │  envelope ─┐                  │
    │                                              │            │                  │
    │                                              │  append envelope user message │
    │                                              │  to .jsonl; broadcast ───────►│ all tabs
    │  wake on new user message                    │                               │ re-render
    │◄─────────────────────────────────────────────┤                               │ answered
    │  sees envelope, parses answers, continues    │                               │
```

Key property: the session is **idle** during the wait. Every UI sees it as idle. No special "pending widget" state exists server-side.

## Envelope format

When the UI submits answers, the server appends a `role: "user"` message whose text is:

```
[ask_user_choices_response tool_use_id=<ID>]
{"answers":[{"question":"...","selected":"...","other_text":null}, ...]}
```

The marker line is at position 0. The newline separates it from a JSON body with an `answers` array. For multi-select questions `selected` is an array; for single-select it's a string (including the literal `"Other"` when the user picked the free-text option, with `other_text` carrying the typed value).

The format is the single source of truth and lives in [`src/shared/ask-envelope.ts`](../src/shared/ask-envelope.ts), shared between server and UI:

- `ASK_ENVELOPE_REGEX` — full match, captures `tool_use_id` and JSON body.
- `ASK_ENVELOPE_PREFIX_REGEX` — cheap prefix test (used by the render filter).
- `buildAskResponseEnvelope(toolUseId, answers)` — server-side construction.
- `parseAskResponseEnvelope(text)` — parse + validate (returns `null` on any malformed field).
- `isAskResponseEnvelope(msg)` — transcript-message predicate (role + text shape).
- `findAskResponseAnswers(messages, toolUseId)` — scan transcript for an envelope matching a given tool_use.

## Idempotency

`POST /api/internal/user-question/submit` is idempotent by `(sessionId, toolUseId)`. If the transcript already contains an envelope for that `tool_use_id`, the server returns:

```json
{ "ok": true, "alreadySubmitted": true }
```

without appending a second envelope. This handles two realistic cases:

- **Multi-tab submit.** Tab A submits, tab B's submit button was already clickable and the user clicks it too. Tab B gets `alreadySubmitted: true` and flips to answered mode from the broadcast.
- **Network retry.** The widget's fetch call times out and retries; the second request is a no-op.

## Prompt-injection guard

The envelope format is reserved for the user/UI layer. Two guards prevent an agent from spoofing an answer:

1. **Role check.** `isAskResponseEnvelope` and `findAskResponseAnswers` in `ask-envelope.ts` only accept messages whose role is `user` or `user-with-attachments`. An assistant message whose text happens to contain the marker is ignored.
2. **Causality check.** `findAskResponseAnswers` first locates the `ask_user_choices` tool_use block matching the `tool_use_id`. An envelope without a preceding tool_use with that id is rejected. This prevents a transcript-only attack where an earlier message claims to answer a question that was never asked.

The tool documentation (`defaults/tools/ask/ask_user_choices.yaml`) also instructs the LLM never to emit the marker itself. Combined with the role gate this makes spoofing a non-issue.

## Multi-tab behavior

Both tabs render the same transcript. The `ask_user_choices` renderer picks its mode from `ctx.getAskResponseAnswers(toolUseId)`:

- **Interactive** when no matching envelope is present later in the transcript.
- **Answered (read-only)** when one is. Selections come straight from the parsed envelope.

When one tab submits, the server broadcasts the new user message. The other tab receives it, dispatches a `bobbit-transcript-message` DOM event, and the tool card re-renders in answered mode. No custom WS event types are needed — the normal message broadcast is enough.

## Server restart behavior

The envelope is a regular user message persisted to the session `.jsonl`. Everything survives a restart:

- **Pending widget before restart.** The assistant's tool_use is in the transcript; on reload the UI renders it as interactive (because no envelope follows it). The user can still submit.
- **Submit after restart.** The REST call appends a user message through `sessionManager.enqueuePrompt`, which also wakes the agent. Works exactly the same as a cold submit.
- **Already-answered widget.** The envelope is in the transcript; all tabs render it as answered on first paint.

No `/pending` endpoint, no in-memory map, no rejection listener. The transcript is the state.

## Widget UX

The interactive widget is a Lit component (`<ask-user-choices-widget>`) rendered inside the `ask_user_choices` tool card. Its shape is driven entirely by the tool input — see `defaults/tools/ask/ask_user_choices.yaml` for the agent-facing contract. Summary for docs readers:

### Labels

- **Tabs** (multi-question asks only): `A. <tab_label>`, `B. <tab_label>`, … The letter prefix doubles as the tab-jump shortcut (see below); `tab_label` is required on every question when `questions.length > 1` and must be 2–4 words, ≤24 chars. The server rejects the call with a clear error if any question is missing it. Single-question asks hide the tab strip and ignore `tab_label`.
- **Options**: every option is prefixed with a numeric badge (`1.`, `2.`, …) matching the number-key shortcut. An "Other" free-text choice is always rendered automatically and takes the next number in sequence; agents cannot opt out. The free-text input is **always visible inline** beside the Other row — the user can start typing immediately without first selecting Other. Submission is gated on Other-with-empty-text: if the user picks Other (or includes it in a multi-select) the text field must be non-empty.
- **Primary button**: on a multi-question ask, every tab except the last shows **Next** (advances to the next tab, disabled until the current question has a valid selection). The last tab shows **Submit**. Single-question asks keep the existing behaviour — single-select auto-submits on pick, multi-select / Other shows **Submit**.

### Keyboard map

A single keydown listener on the widget root handles shortcuts. While focus is inside the "Other" text field, only Enter and Escape are intercepted so normal typing works.

| Key | Effect |
|---|---|
| Arrow Up / Down | Move focus between options (wraps at ends). |
| Arrow Left / Right | On tab buttons, move across tabs (standard ARIA tablist). |
| Enter | Click the primary button (Next / Submit). On a single-question single-select ask, picks the focused option and auto-submits. |
| Escape | Clear the current question's selection and any "Other" text. Does not submit or close. |
| 1–9 | Pick the option at that 1-based index on the active question. Single-select auto-submits (single-question) or auto-advances (multi-question); multi-select toggles. |
| A–Z | Jump to the corresponding tab. Multi-question asks only. |

The widget uses ARIA `role="radiogroup"` / `role="radio"` for options and the standard tablist pattern for tabs, with roving `tabindex` so screen readers announce selection state correctly. Mouse/touch behaviour is unchanged.

## Error results render as a minimal chip

The renderer distinguishes three tool-result envelope shapes from the extension and routes each to a different UI:

| Result shape | UI |
|---|---|
| `{status:"posted", tool_use_id}` (synchronous stub) | Interactive widget — full tabs, options, Submit. |
| `{answers:[...]}` (legacy / pre-non-blocking transcripts) | Read-only answered card. |
| `isError: true` **or** any other completed-but-unknown shape | Minimal destructive-coloured chip (`<div class="ask-error">`), no clickable options. |

The extension sets `isError: true` on its validation failures (currently the two `tab_label` rules — missing/empty, and >24 chars — on multi-question asks). The renderer also treats *any* completed result that is neither the posted stub nor a legacy answers payload as errored, as a defense-in-depth fallback against future failure paths that forget the flag.

Why a chip instead of the full widget: when an ask call fails the agent typically retries with a corrected call, producing a second `tool_use_id`. Rendering the failed call as an interactive widget would leave two clickable question cards in the transcript and the user could not tell which one is live. Collapsing the failed call to a small inline error chip means only the retry is interactive.

Invariants pinned by tests (treat these as the source of truth):

- [`tests/ask-extension-execute.test.ts`](../tests/ask-extension-execute.test.ts) — the extension returns `isError: true` on each validation failure path.
- [`tests/ask-user-choices-renderer.spec.ts`](../tests/ask-user-choices-renderer.spec.ts) — the renderer routes `isError: true` and unknown-shape completed results to the `ask-error` chip and never to the interactive widget.
- [`tests/e2e/ui/ask-user-choices-ui.spec.ts`](../tests/e2e/ui/ask-user-choices-ui.spec.ts) — failure-then-retry scenario shows exactly one interactive widget, preceded by the minimal chip for the failed call.

The `tab_label` validation rules themselves are documented in `defaults/tools/ask/ask_user_choices.yaml` (the agent-facing tool contract) and summarised in the [Widget UX → Labels](#labels) section above. This page intentionally does not duplicate them.

## Rendering note

Envelope user messages are hidden from the **rendered** transcript by `src/ui/components/AgentInterface.ts` (via `isAskResponseEnvelope`). They're still present in the `.jsonl` and still sent to the LLM — the agent sees them on its next turn as part of history. The UI omits them because the answered widget card is the human-readable representation; showing both would be redundant.

## File map

| File | Role |
|---|---|
| `src/shared/ask-envelope.ts` | Envelope format: regex, build, parse, find, predicate. |
| `defaults/tools/ask/extension.ts` | Tool extension. Returns `{status:"posted", tool_use_id}` synchronously. |
| `defaults/tools/ask/ask_user_choices.yaml` | Tool manifest + detail_docs describing the non-blocking contract. |
| `src/server/server.ts` — `POST /api/internal/user-question/submit` | Validate, cross-check against transcript, idempotency check, enqueue envelope via `sessionManager.enqueuePrompt`. |
| `src/server/agent/ask-user-choices-validation.ts` | Input validators (`validateQuestions`, `validateAnswers`, `crossValidate`) shared by the submit handler. |
| `src/ui/tools/renderers/AskUserChoicesRenderer.ts` | Two-mode rendering (interactive vs answered) via `ctx.getAskResponseAnswers(toolUseId)`. |
| `src/ui/components/AskUserChoicesWidget.ts` | Interactive Lit widget: tabs, numbered option badges, keyboard navigation, ARIA radiogroup/tablist. |
| `src/ui/components/AgentInterface.ts` | Filters envelope user messages out of the rendered transcript. |
| `src/app/remote-agent.ts` | Exposes `findAskResponseAnswers` to renderers; dispatches `bobbit-transcript-message` on new user messages so tool cards re-render. |

Removed in the non-blocking redesign (mentioned here so searches don't mislead):

- `src/server/agent/user-question-harness.ts` — deleted.
- `GET /api/internal/user-question/pending` and `POST /api/internal/user-question` — removed.
- WS event types `user_question_pending` / `user_question_answered` — removed.

## Contrast with `verification_result`

| | `ask_user_choices` | `verification_result` |
|---|---|---|
| Who produces the result | A human clicking a widget | A reviewer/QA agent doing work |
| Agent turn while waiting | Ends; session idle | Stays open; session "thinking" |
| Server-side wait state | None (transcript is state) | In-memory Promise + persisted active-verification |
| Multi-tab convergence | Transcript broadcast | Custom WS events |
| Restart semantics | Works unchanged (transcript persists) | Persistence layer resumes in-flight verifications |

Both are legitimate patterns. Pick based on whether the counterparty is actively computing or just a human we're waiting on.

## See also

- [docs/blocking-tools.md](blocking-tools.md) — the other pattern (for `verification_result`).
- [docs/rest-api.md](rest-api.md) — REST surface, including `/api/internal/*`.
- [`src/shared/ask-envelope.ts`](../src/shared/ask-envelope.ts) — canonical envelope code.
