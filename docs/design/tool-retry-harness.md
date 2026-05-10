# Tool retry harness

**Status:** proposed (Generic tool-error retry goal)
**Branch:** `goal/generic-to-8a8afb16`
**Owners:** team-lead-8a8afb16

## Mission

Lift the `verification_result`-only schema-retry pattern out of
`verification-harness.ts` into a reusable helper applied to **any** tool
whose `tool_execution_end` arrives with a deterministic JSON / argument-
validation error. Today the agent is responsible for noticing such an
error and re-emitting a corrected call; if it doesn't, the user sees a
visible-but-errored `tool_use` + `tool_result` pair in the transcript
even when the call is ultimately fixed by self-correction.

The user-visible symptom for `ask_user_choices` is two question cards
(one errored, one correct) rendered for a single user-facing question.
The same shape applies to `propose_*` and any future structured-input
tool.

## Non-goals

- Hiding the errored `tool_use` / `tool_result` pair from the rendered
  transcript. Server-side suppression is a UI follow-up; this design
  only ensures retry happens.
- Generalising to non-validation errors (timeouts, provider 5xx). Those
  belong to the LLM stream watchdog (`docs/llm-stream-watchdog.md`).
- Modifying the message wire schema. Retry bookkeeping is server-only,
  in session metadata.
- Adding any new agent-visible tools. Retries happen via prompt
  injection, same as today's verification reminder.
- Touching the widget renderer (`AskUserChoicesRenderer.ts`,
  `AskUserChoicesWidget.ts`) — the error-chip collapse is correct.

## Architecture

### New module: `src/server/agent/tool-retry-harness.ts`

A small, instance-per-session helper. Lifecycle: created when a session
is constructed in `SessionManager`, disposed when the session is
terminated.

```
class ToolRetryHarness {
  constructor(opts: {
    sessionId: string;
    rpcClient: PiRpcClient;
    onMetadata?: (delta: { count: number; lastReason: string }) => void;
    maxRetries?: number;        // default 2
  });
  start(): void;                // subscribes to rpcClient.onEvent
  stop(): void;                 // unsubscribes
  // exposed for tests:
  classify(event: ToolExecutionEnd): "schema" | "domain" | "ignore";
  buildNudge(toolName: string, quotedError: string): string;
}
```

**Key invariants**

- The harness reads only events on the same `rpcClient.onEvent`
  channel that `verification-harness.ts` already uses.
- Retries are dispatched via `rpcClient.prompt(text)` — the same path
  used for verification reminders. Never through `_dispatchSteer`,
  never through `enqueuePrompt`. (`docs/design/steer-subsystem-rewrite.md`
  is explicit that system-issued retries must use `rpcClient.prompt`.)
- The harness never writes a user-visible message. The user-input
  position in the transcript is reserved for real users.
- Retry counts live in session metadata
  (`PersistedSession.toolAutoRetries: { count: number; lastReason: string }`),
  not on any wire message.

### Classifier rules

The classifier inspects `tool_execution_end` events and returns one of:

- `"schema"` — retry-eligible. Examples:
  - `event.isError === true` AND result text matches
    `detectJsonValidationError()` (the existing
    V8/Node `SyntaxError` family in `verification-logic.ts`).
  - `event.isError === false` AND the result body is a successful
    `ok({ error: "<message>" })` shape from a validation-rejecting
    extension. Concretely: result text parses as JSON containing only
    an `error` string, OR the textual result starts with one of the
    known validator prefixes:
    - `ask_user_choices: questions[`
    - `propose_goal:`, `propose_role:`, `propose_project:`,
      `propose_staff:`, `propose_tool:` (all `propose_*` extensions
      follow the same `<tool>: <message>` shape).

- `"domain"` — let the agent see and react. Examples:
  - Real-world failures: `bash` exit-code 1, `read` ENOENT,
    network errors, etc.
  - Tool-side errors that aren't structural ("permission denied",
    "file not found", "command not in allowlist", etc.).

- `"ignore"` — non-error event. Pass-through; no retry.

The rule of thumb: a `"schema"` error is one the model could fix
mechanically by re-emitting the same call with corrected arguments,
without re-running any analysis or rerunning a domain action.

### Retry loop

When the harness sees a `"schema"` error:

1. If `retries[toolUseId] >= maxRetries` (default 2), do nothing —
   the error stays visible and the agent decides what to do.
2. Increment `retries[toolUseId]`.
3. Emit `console.debug("[tool-retry] event=", { name, isError, classifier: "schema" })`
   (temporary; removed before final PR per the goal's instrumentation
   plan).
4. Build a targeted nudge via `buildNudge(toolName, quotedError)`.
   The nudge tells the model:
   - the previous `<toolName>` call failed with this exact error;
   - it is a streaming/validation glitch, not an analysis problem;
   - re-emit the call with the corrected arguments;
   - do **not** re-run any analysis.
5. `await rpcClient.prompt(nudge)`.
6. Update session metadata via the optional `onMetadata` callback so
   the SessionStore can persist the new `{ count, lastReason }`.

The loop terminates when:
- the same `tool_use_id` is no longer retried (model fixed it on a
  fresh `tool_use`);
- a subsequent `tool_execution_end` for the new `tool_use_id` is
  not in the `"schema"` class (success or domain error);
- `maxRetries` is reached for a single `tool_use_id`.

### Idempotency

The harness keys retry counts by `tool_use_id`. Two consecutive errored
calls to the same tool with **different** `tool_use_id`s are independent
retries; same `tool_use_id` (which can occur on resume / replay) does
not double-charge.

### Wiring

`SessionManager` constructs one `ToolRetryHarness` per session at
spawn time and calls `start()` after the `rpcClient` becomes
available (same lifecycle as the existing tool-execution event sink).

`verification-harness.ts` keeps its existing wiring. Its targeted
JSON-retry logic is left in place at the four call sites
(verification, retry-resume, qa, legacy) — the new harness is a
**peer**, not a replacement. Reasoning:

- The verification harness's retry runs in a verification *step*
  context with bespoke pass/fail bookkeeping. Replacing it inline
  would require threading verification state through the new helper.
- Both harnesses use `detectJsonValidationError`, so logic stays
  shared via `verification-logic.ts`.
- Each harness keys on a different scope: verification retries only
  while a verification step is in flight; the generic retry harness
  always observes the session.

If both fire on the same tool call (verification's
`verification_result` schema retry + generic schema retry), the
generic harness's `tool_use_id` cap prevents amplification — the
verification harness is the one that owns the `verification_result`
nudge content; the generic harness will see the validation error,
classify it, but skip the retry because verification has already
retried (lookup: verification harness sets a flag on the session
saying "I'm handling this `tool_use_id`"). Concrete coordination:

```ts
// On the session object:
session._verificationOwnedToolUses?: Set<string>;
```

The verification harness adds the `tool_use_id` it's about to retry
to that set; the generic harness skips any `tool_use_id` already in
the set. Both clear entries on success.

### Interaction with the LLM stream watchdog

`stream-watchdog.ts` aborts and re-prompts on **stream inactivity**
(no frames for N seconds). It is orthogonal:

- Stream watchdog triggers on **no events**.
- Tool retry harness triggers on **specific event content**
  (`tool_execution_end` with schema-class error).

They cannot fire on the same event, but the watchdog's silent re-prompt
could in principle cause a fresh `tool_execution_end` that the harness
then re-retries. That's the desired behaviour: each is fixing a
distinct transient class.

## Session metadata

`PersistedSession` (in `src/server/agent/session-store.ts`) gains:

```ts
toolAutoRetries?: {
  count: number;       // total retries this session has issued
  lastReason: string;  // brief one-line summary of the last retry
};
```

Updated via the existing `SessionStore.update(sessionId, partial)`
path. Surfaced in `GET /api/sessions/:id` automatically because the
endpoint already returns the full persisted shape. The UI does not
render this initially — the field exists for the observe-loop
detector to assert on.

## Observe-loop integration

### Scenario `tool-error-retry`

Added to `tests/observe/scenarios.ts`. Sends a prompt that's known
to make the agent fumble the first JSON (the agreed-on prompt is a
multi-question `ask_user_choices` ask where the model has historically
forgotten `tab_label` on the first attempt). Runs to idle. Outcome
asserted by the new detector below.

### Detector `detectVisibleToolErrors`

Pure function added to `tests/observe/detectors.ts`. Walks
`state.messages` (i.e. `t.session.messages`) for any `tool_result`
with `isError=true` whose `tool_use_id` is **not** followed within
30 s by a successful retry to the same tool. Flags those as a
finding (kind `"visible-tool-error"`).

The new finding kind is added to `Finding["kind"]` in
`tests/observe/types.ts` (currently lists `"hang"`, `"out-of-order"`).

### Detector wiring

`tests/observe/detectors.ts` already exports `detectHangs` and
`detectOutOfOrder`. We add `detectVisibleToolErrors` next to them and
register it in `tests/observe/run.ts` next to the existing detector
calls. (No wiring change is needed in scenarios; detectors run at
report time.)

## Tests

### Unit: `tests/tool-retry-harness.test.ts`

Fixture-driven, mirrors `tests/verification-reminder-race.test.ts`.

- A `FakeSession` exposing `rpcClient = { prompt, onEvent }`.
- Test 1 — schema-class error triggers exactly one nudge prompt.
- Test 2 — domain error (e.g. `bash` exit-code 1) does **not** nudge.
- Test 3 — three consecutive schema errors with the same `tool_use_id`
  result in exactly two nudges (cap = 2), then the harness gives up.
- Test 4 — `ask_user_choices`-style `ok({ error })` body is
  classified as `"schema"` even though `isError === false`.
- Test 5 — `verification_result` `tool_use_id` already in
  `_verificationOwnedToolUses` is skipped.
- Test 6 — successful tool execution after the nudge clears the
  retry count for that `tool_use_id`.

### E2E: `tests/e2e/tool-error-retry.spec.ts`

API E2E using `in-process-harness.js`. Drives a mock-agent session
that issues an invalid `ask_user_choices` payload, waits for idle,
and asserts:

- `GET /api/sessions/:id` returns `toolAutoRetries.count >= 1`.
- The transcript contains exactly **one** `ask_user_choices` `tool_use`
  whose paired `tool_result` has no `error` body. (Errored intermediate
  calls are not suppressed by this goal — the assertion verifies that
  the model did self-correct after the nudge.)

### Observe scenario

`tests/observe/scenarios.ts` gains a `tool-error-retry` entry per the
DoD. Run as part of the harness's report pipeline; the new detector
flags any visible errored `tool_result` left in the transcript.

## Reproduction recipe

The original goal spec describes the manual repro: post
`ask_user_choices` with two questions and omit `tab_label`. After
this goal lands, the regression test is the observe scenario plus
the unit tests above.

## Files touched

New:
- `src/server/agent/tool-retry-harness.ts`
- `docs/design/tool-retry-harness.md` (this doc)
- `tests/tool-retry-harness.test.ts`
- `tests/e2e/tool-error-retry.spec.ts`

Modified:
- `src/server/agent/session-manager.ts` — instantiate / wire the harness.
- `src/server/agent/session-store.ts` — add `toolAutoRetries` to
  `PersistedSession`.
- `src/server/agent/verification-harness.ts` — populate
  `_verificationOwnedToolUses` so the generic harness defers to it on
  the four existing schema-retry call sites.
- `tests/observe/detectors.ts` — add `detectVisibleToolErrors`.
- `tests/observe/types.ts` — add `"visible-tool-error"` finding kind.
- `tests/observe/scenarios.ts` — add `tool-error-retry` scenario.
- `tests/observe/run.ts` — register the new detector.
- `AGENTS.md` — one-line Recipes entry under Server / API.

Deliberately untouched:
- `src/ui/components/AskUserChoicesWidget.ts`,
  `src/ui/tools/renderers/AskUserChoicesRenderer.ts` — already correct.
- The on-wire tool / message schemas.
- `_dispatchSteer` and the steer subsystem.

## Risks

- **Double-retry amplification**: addressed by the
  `_verificationOwnedToolUses` set + per-`tool_use_id` cap.
- **False positives in the classifier**: a domain tool whose error
  message coincidentally matches `Validation failed for tool` could
  trigger a schema retry. Mitigated by the strict prefixes for
  `propose_*` and `ask_user_choices:`, and by the
  `detectJsonValidationError` regex set being narrow.
- **`maxRetries=2` masking real bugs**: visible after the cap, so
  the user still sees a persistent failure. The session metadata
  also records the count for offline analysis.

## Open questions (resolved before implementation)

1. *Should `propose_*` tools' `ok({ error })` body be classified the
   same as `ask_user_choices`?* — Yes. They share the
   `<tool>: <message>` shape; goal spec lists them explicitly under
   classifier coverage.
2. *Default cap?* — 2 retries per `tool_use_id`. Same envelope the
   verification harness uses today.
3. *Where is the metadata callback wired?* — Through
   `SessionStore.update(sessionId, { toolAutoRetries: ... })`.
   `session-manager.ts` provides the callback when constructing the
   harness.
