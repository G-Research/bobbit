# Historical: Claude Agent SDK translator seam (G0)

> **Historical finding.** This G0 document records the translator-only slice
> before Claude Agent SDK session integration shipped. It is not the current
> runtime architecture. For the implemented lifecycle, selection, and security
> boundary, see [Claude Agent SDK sessions](../claude-agent-sdk-sessions.md) and
> [Session runtime identity](session-runtime-identity.md).

## Purpose

`src/server/agent/claude-sdk-event-translator.ts` is a pure, offline boundary between Claude Agent SDK-shaped messages and Pi `AgentEvent` values. `translateClaudeSdkEvent(state, input)` accepts untrusted input and immutable translator state, returning the next state, translated events, and diagnostics without changing its inputs.

The shipped SDK bridge now consumes this translator, but the translator remains
independently testable and has no process, filesystem, network, bridge, store,
tool-execution, or UI dependency. Keeping it pure prevents the runtime lifecycle
from leaking into event-shape and ordering tests.

## Translation contract

The translator selects a partition from `parent_tool_use_id` before looking up a UUID, message, or tool identity. The root uses an internal symbol rather than a string, while child events carry their `parentToolUseId` annotation.

Within each partition it translates assistant, streamed assistant, user tool-result, permission-denial, system, and terminal frames into typed Pi events:

- Streamed blocks emit `message_update` start, delta, and end events.
- A final assistant message emits `message_end` before its `tool_execution_start` events.
- A matching user tool result emits a ToolResult `message_end` before `tool_execution_end`.
- Terminal details that Pi does not model are attached only to root `agent_end` as `claudeSdk` metadata.

## Isolation and completion invariants

Each root or child partition independently owns partial assistants, open tools, finalized identities, duplicate fingerprints, and the active stream identity. Consequently, interleaved children, reused UUIDs, and hostile identity strings cannot merge state with root traffic or another child.

The translator safely normalizes malformed or cyclic values. Unsupported raw content blocks do not skew normalized content indexes, and parsed streamed tool input is exposed as arguments without leaking the internal partial JSON string. Non-stream frames are fingerprinted to bound duplicate processing, while equal stream deltas remain valid transitions. A stopped content block cannot replay.

Assistant completion reconciles envelope UUID, model message ID, and active stream ID once, removes finalized partials, and suppresses late frames. A root terminal frame drains every partition's unfinished assistant and dangling tool before emitting one root `agent_end`. A child terminal drains only that child partition, emits no root `agent_end`, and leaves the root partition live.

## Verification and current-main compatibility

Run the focused offline contract test with:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only tests2/core/claude-sdk-event-translator.test.ts
```

Then run:

```bash
npm run check
```

The translator test is registered in `tests2/tests-map.json`. The current-main compatibility commit `f5983b4631abc0dbbd14edaf186370173e981581` preserves that registration. The current-main affected-read audit commit `f2d07487bd7bfe938ff4e13b50e5fcd546e5a55c` declares the test's fixture and session-source reads so affected-test selection remains accurate.

The focused test covers lifecycle ordering, root and child partition isolation, terminal drains, duplicate and late-frame suppression, identity reconciliation, immutable and malformed input handling, streamed tool input, normalized indexes, thinking signatures, batched results, and translator purity independent of runtime lifecycle.

## Absorbed source series

The integrated translator slice absorbed these seven source commits from `goal/claude-sdk-eve-3503f7f8`:

- `8dca594d80bca12fb9b39dee17a11d9219ab9eb5`
- `544f799795fa745e8c60dbaf754e464b2b66c42e`
- `796cb3ce544e054ff478329575168426dffb9eda`
- `35cbea9e0681df09ee39294b44c075da4ac35b5c`
- `a459511c8e7f783ab27bbdea0e69db72d3303831`
- `d6a0bb8bd7cc40d9d297983f1f727796381497f2`
- `09ba67bbc6971766bdb7dcd3ee4702cb871ac14f`

The topology-only merge `2a52df73145e26dc7ab8c613203c4ed58d2079af` is not part of the replayed series because both of its parents are listed above.

## Historical boundary and retained constraint

The G0 slice did not adopt PR #841's raw local Claude CLI runtime design. That
CLI rejection remains: the implemented runtime uses the official SDK bridge, not
a CLI bridge or managed `claude` process. G0 itself added no lifecycle, runtime
selection, transcript hydration, WebSocket/UI, tool, permission, provider, or
`SessionManager` integration.

Those capabilities now exist outside this historical slice. Their current
contract is documented in [Claude Agent SDK sessions](../claude-agent-sdk-sessions.md)
and [Session runtime identity](session-runtime-identity.md); future changes must
preserve this translator's pure boundary and existing session ownership.
