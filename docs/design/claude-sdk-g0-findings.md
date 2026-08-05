# Claude Agent SDK translator seam

## Purpose

`src/server/agent/claude-sdk-event-translator.ts` is a pure, offline boundary between Claude Agent SDK-shaped messages and Pi `AgentEvent` values. `translateClaudeSdkEvent(state, input)` accepts untrusted input and immutable translator state, returning the next state, translated events, and diagnostics without changing its inputs.

The seam makes SDK event shapes testable without adopting an SDK runtime. It is not imported by session setup or `SessionManager`, and has no process, filesystem, network, bridge, store, tool-execution, or UI dependency.

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

The focused test covers lifecycle ordering, root and child partition isolation, terminal drains, duplicate and late-frame suppression, identity reconciliation, immutable and malformed input handling, streamed tool input, normalized indexes, thinking signatures, batched results, and the absence of runtime coupling.

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

## Explicit boundary

This slice does not adopt PR #841's raw local Claude CLI runtime design. It adds no CLI bridge or process lifecycle, runtime selection or settings, transcript hydration, websocket or UI work, tool execution or permission plumbing, provider registration, or `SessionManager` dispatch/steer integration. Any future SDK runtime must be designed as a separate, explicitly approved integration that preserves this translator boundary and existing session ownership.
