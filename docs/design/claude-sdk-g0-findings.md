# Claude Agent SDK G0 findings

## Purpose and evidence boundary

This is a G0 evidence record for a possible Claude Agent SDK runtime. It is not a runtime integration guide and does not change Bobbit behavior. The accompanying translator is deliberately offline: `src/server/agent/claude-sdk-event-translator.ts` accepts SDK-shaped values and returns Pi-compatible events without importing it from session setup or dispatch.

The SDK evidence below comes from the published declarations for `@anthropic-ai/claude-agent-sdk` 0.3.220 (Claude Code 2.1.220), inspected without installing the package or running a Claude process. The JSON records in `tests2/fixtures/claude-sdk-event-translator/` are hand-authored captured-shape fixtures traceable to those declarations, not live recordings. They make the evidence auditable while keeping this slice offline.

## SessionStore is not an SDK transcript store

Bobbit's `SessionStore` persists gateway session metadata in `sessions.json` so sessions can survive a gateway restart. Its `PersistedSession` contract includes the gateway session identity, working-directory and agent-session-file references, queue and in-flight-steer recovery state, project and goal relationships, model selection, and lifecycle metadata. It does not model an SDK transcript tree.

The SDK alpha session-store declarations describe a different responsibility: a mirror of transcript entries and subkeys, including subagent state. That data has different identity, ownership, retention, and recovery semantics from Bobbit's gateway session metadata and prompt queue.

**Finding:** the two stores are not interchangeable. A future runtime needs a separate, explicitly designed adapter at the transcript/resume boundary; it must not substitute the SDK store for `SessionStore` or write SDK transcript records into Bobbit's gateway metadata store. This PR adds no adapter or store integration.

## Steer ordering remains owned by SessionManager

`SessionManager._dispatchSteer()` establishes the existing recovery ordering:

1. It records the accepted steer in the in-flight shadow ledger.
2. It persists that ledger with removal of the prompt-queue row, before awaiting `rpcClient.steer()`.
3. It calls the bridge's `steer()` method.
4. `_consumeSteerEcho()` removes only the matching user-role terminal echo from the ledger.
5. Restore and abort reconciliation re-enqueue unresolved entries at the front, preserving their order for exactly-once redispatch.

This protects the dispatch-to-echo crash window: an accepted steer is not silently lost after a reconnect or restart, while a duplicate or already-settled echo cannot consume a later same-text steer. The coverage in `tests2/integration/steer-midturn.test.ts`, `steer-reconnect.test.ts`, `steer-gateway-restart.test.ts`, and `steer-snapshot-continuity.test.ts` exercises immediate dispatch, reconnect continuity, restart recovery, and the visibility gap respectively. `tests2/core/splice-inflight-steer-occurrence.test.ts` protects the matching/occurrence boundary used when snapshotting in-flight steers.

**Finding:** the translator must preserve incoming event order and must not interpret, settle, or reorder user echoes. It has no session, queue, bridge, or store access; future bridge wiring must retain `SessionManager` as the ordering owner.

## Numeric effort is unspecified

The published declarations expose numeric `effort` on agent definitions, while top-level query options accept named effort levels. Neither those declarations nor the published README specifies a numeric range, units, permitted granularity, or a conversion between numeric and named values.

**Decision:** numeric effort support is withheld. Do not pass numeric effort values until a future live SDK spike establishes their valid range, units, semantics, and behavior across the intended models. This PR does not add model or thinking control.

## Subagent stream shape and partitioning

The declarations show `parent_tool_use_id` on assistant, partial-assistant (`stream_event`), and user/tool-result messages. Forwarded subagent traffic also includes task and tool-progress shapes with task, tool, and subagent identities. Tool traffic is available by default; forwarding child text and thinking is option-dependent.

The fixtures record both kinds of child evidence:

- `interleaved-subagents.json` interleaves root traffic with two child streams that deliberately reuse the same UUID. It includes child text, a child tool use, and its matching child result.
- `root-tool-lifecycle.json` records text, thinking, tool use, and a user tool result in the root partition.
- `streamed-tool-input.json` records streamed tool JSON and its truncated form.
- `terminal-and-permission.json` records success, error, abort, permission-denial, and unknown-message shapes.

The translator chooses `parent_tool_use_id` (or an internal root sentinel) before any UUID, message, or tool lookup. Its partition-local state means child output cannot merge with root output or another child's output, even when identities collide. Child events retain `parentToolUseId`; rendering those spans is intentionally deferred.

**Finding:** a future subagent renderer must consume the partition identity already preserved by the translator rather than reconstructing parentage from UUIDs or message text.

## Product recommendations requiring approval

The following are recommendations for a later runtime design. **None is applied by this PR, and each requires explicit user approval before it changes Bobbit behavior.**

| Topic | Recommendation only | Rationale | Status in this PR |
|---|---|---|---|
| Native Claude tools | Initially suppress native Claude tool execution. | Bobbit needs one accountable tool, permission, and event lifecycle; allowing a second native executor before that boundary risks duplicate or untracked side effects. | Not applied; no runtime or tool plumbing exists. |
| Slash commands | Intercept slash commands in Bobbit first. | Bobbit can retain its command semantics, authorization, and UI behavior instead of relying on an SDK command path with different ownership. | Not applied; no dispatch behavior changes. |
| Bundled skills | Resolve bundled skills through Bobbit's pack resolver. | The existing pack system provides the project-scoped source of truth and avoids diverging skill selection or precedence. | Not applied; no skill adoption or pack changes. |
| Built-in `Agent` and `Task` | Initially withhold the SDK's built-in subagent tools. | Bobbit must first define supervision, isolation, lifecycle, and rendering for child work; the partitioned stream evidence is necessary but not sufficient for that product behavior. | Not applied; no subagent runtime or rendering exists. |

## Scope confirmation

This G0 slice adds only the pure translator, typed captured-shape fixtures, focused tests, and this findings record. It does not spawn a runtime, register a provider or dependency, change session setup/dispatch, install permissions, execute tools, expose skills, persist transcripts, or render subagents. The recommendations above remain documentation, not implementation.
