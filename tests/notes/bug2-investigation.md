# Bug 2 Investigation — bash_bg.wait toolResult duplicates after snapshot replay

## Summary

The Tier-2.5 prototype scenario `08-stream-burst-transient-bug` (in
`tests/prototype/scenario-runner.spec.ts`, NOT in this branch — lives on
`session/interrupt-steering-tests-a86df1c6` in the pool worktree) reports:

```
[stream-burst] DUPLICATE @10367ms: "bash_bg wait long task (bg-3) · …" x2
[stream-burst] live snapshot has 16 messages
[stream-burst] refresh snapshot has 15 messages
```

The duplicate is the **toolResult** card for the third bash_bg.wait cycle
(bg-3). Live DOM has 16 rows; the post-refresh server snapshot has 15. A
hard reload clears the dup, so the bug is purely transient client-side state.

## Root cause (reducer-level)

The bug reproduces deterministically at the `reduce()` boundary in
`src/app/message-reducer.ts` — no DOM, no rAF, no remote-agent dispatch,
no chunked-stream timing — given a representative action sequence from
the bg-3 cycle:

1. `live-event` for the wait toolCall assistant `message_end`. The mock
   (`tests/e2e/mock-agent-core.mjs::_handleRealBgWait`) sends this
   without a string `id`. `RemoteAgent.handleAgentEvent` (`src/app/remote-agent.ts`
   ~L1591) stamps a synthetic `synth:tc:<toolCallId>` id from
   `computeStreamingMessageId` so the visible-messages filter can hide the
   in-flight row by id-equality.
2. `live-event` for the bash_bg toolResult `message_end`. The mock sends
   this with **no `id` field at all** — it's an unkeyed `toolResult`
   message. The reducer's `live-event` branch unconditionally pushes it
   onto `messages` as a server-origin row with no id.
3. `snapshot` (triggered by the prototype's nav-away/nav-back stress
   pattern → `requestMessages` → server replay). The server's stored copy
   of the same toolResult **does** carry an id (assigned at persist time).
   The snapshot survivor filter at `message-reducer.ts:118-128`:

   ```ts
   if (m._origin === "server") {
       if (typeof m.id === "string" && serverIds.has(m.id)) continue;
       survivors.push(m);
       continue;
   }
   ```

   only drops live-event server rows whose **string id** is present in
   the snapshot. The live toolResult row from step 2 has no id — so it
   passes through as a survivor — and the snapshot then **adds its own
   id'd copy** of the same toolResult on top. Net: **two toolResult rows
   in `state.messages` representing the same logical message**.

The same hazard applies to the assistant wait toolCall row, where the
live row has the synthetic id `synth:tc:<toolCallId>` and the snapshot
has whatever real id the server assigned — different strings, both pass
the survivor filter, both end up in `messages`. (The visible-messages
filter at the render layer sometimes papers this over for the in-flight
case, but the underlying reducer state is duplicated.)

## Reproduced action sequence

This is the exact sequence the test drives:

```ts
let s = initialState();
// 1. Live: assistant wait toolCall (synth-id'd at remote-agent)
s = reduce(s, { type: "live-event", frame: { type: "message_end", message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc-bg3", name: "bash_bg", input: { action: "wait", id: "bg-3" } }],
    id: "synth:tc:tc-bg3",
}}, seq: 100 });
// 2. Live: id-less toolResult (matches mock-agent-core.mjs:_handleRealBgWait)
s = reduce(s, { type: "live-event", frame: { type: "message_end", message: {
    role: "toolResult", toolCallId: "tc-bg3", toolName: "bash_bg",
    content: [{ type: "text", text: "bg-3 done" }], isError: false,
}}, seq: 101 });
// 3. Snapshot: server has its own ids
s = reduce(s, { type: "snapshot", messages: [
    { role: "assistant", id: "server-assist-bg3", content: [...] },
    { role: "toolResult", id: "server-tr-bg3", toolCallId: "tc-bg3", ... },
]});

// On master:
//   s.messages.length === 4   (2 from step 2 surviving + 2 from snapshot)
//   toolResult rows for tc-bg3 === 2
// Expected post-fix:
//   s.messages.length === 2
//   toolResult rows for tc-bg3 === 1
```

Live probe output (master, current branch):

```
after live count = 2
after snapshot count = 4
toolResult bg-3 rows = 2  ← BUG: should be 1
```

## Why this layer

The repro is purely reducer-level — pure-function inputs in, pure-function
outputs out. The bug does not require:

- the StreamingMessageContainer rAF batching (Bug 1's territory),
- chunked streaming timing,
- proposal panel races,
- nav-stress in particular.

The nav-stress in scenario 08 is just a convenient **trigger** for the
`requestMessages` snapshot replay; what *causes* the duplicate is the
combination of (id-less live toolResult) + (id'd snapshot toolResult) at
the reducer's snapshot-merge step. So the test is filed at the reducer
layer per the goal spec's preferred location.

## Likely fix surfaces (NOT applied in this commit — test only)

1. **At the reducer**: when `live-event` ingests a `message_end` with no
   string `id`, derive a synthetic id from `toolCallId` (toolResult) or
   `toolCall.id` (assistant) — the same pattern `computeStreamingMessageId`
   already uses for assistant rows. Then `serverIds.has(...)` at snapshot
   time can match by toolCallId-equivalent.

2. **At remote-agent dispatch**: stamp a synthetic id onto every
   `message_end` that lacks one before calling `apply({ type: "live-event" })`,
   not just the assistant-with-toolCalls path. Symmetric with the existing
   Bug-1 fallback.

3. **Snapshot survivor filter**: also drop live-event server rows whose
   `toolCallId` matches a snapshot `toolCallId` (broader equivalence than
   id-only). Riskier — needs an audit of every message shape that survives
   the filter today.

Option (1) or (2) is recommended; (3) has the largest blast radius.

## Files touched by this investigation

- `tests/dual-render-bg3.test.ts` — Node test runner repro at the reducer
  boundary. Fails on master with `toolResult duplicate count = 2 (expected 1)`.
- `tests/notes/bug2-investigation.md` — this note.

No production source files were modified. The temporary diagnostic
console.log probe (`/tmp/probe.mjs`) used during investigation was
discarded; reducer code was NOT touched.
