# WebSocket Protocol

Bobbit exposes two WebSocket entrypoints. Both require the first frame to be `auth` and close unauthenticated sockets.

## Endpoints

### Session sockets: `/ws/<session-id>`

Connect to `wss://<host>:<port>/ws/<session-id>`. First message must be `{ "type": "auth", "token": "<token>" }`. After `auth_ok`, the client can send session commands and receives streaming session events.

### Viewer sockets: `/ws/viewer`

The goal dashboard uses `wss://<host>:<port>/ws/viewer` when no agent session is active. First message is `{ "type": "auth", "token": "<token>", "goalId": "<optional-goal-id>" }`; the optional `goalId` seeds the viewer's goal-subscription set before `auth_ok`.

After `auth_ok`, a viewer socket is authenticated but not associated with a session and is not added to `SessionManager` clients. It accepts only viewer subscription messages and `ping`; messages outside that set have no effect.

Goal-scoped broadcasts (`gate_*`, `team_*`, `goal_*`) reach viewer sockets only when they are subscribed to the matching `goalId`. Session sockets for agents that belong to that goal still receive those same events. Search/index broadcasts (`index:*`) are project broadcasts rather than goal broadcasts, so they still reach authenticated viewer sockets regardless of goal subscription.

### Gateway readiness and retry

A valid session or viewer upgrade received while the gateway is still restoring state completes the WebSocket upgrade only to send a credential-free error frame, then closes with `1013`. This is intentional: browsers do not expose HTTP Upgrade response headers to WebSocket clients, so a frame is the only way to distinguish a starting gateway from a network failure.

```json
{
  "type": "error",
  "code": "SERVER_STARTING",
  "message": "Gateway is starting. Retrying automatically…",
  "retryAfterMs": 1000
}
```

The frame contains no session, project, or credential information and is sent before `auth`. Clients must treat `SERVER_STARTING` as retryable and show a temporary starting status. `retryAfterMs` is advisory metadata only: because this frame is pre-auth, `RemoteAgent` intentionally ignores it for scheduling; its own bounded, capped exponential backoff is authoritative.

`SERVER_STARTING` is the only unavailable-upgrade frame currently emitted: it represents the gateway readiness boundary. `SERVER_SATURATED` is reserved for the same retry contract when a future admission path has a real temporary-capacity signal; the client already handles it, but the gateway does not currently emit it. Event-loop-lag observations are diagnostics of completed blocking work, not a capacity signal. They must not reject a ready, runnable session or viewer upgrade. Other pre-auth errors and an ordinary connection timeout remain real connection/auth failures rather than an instruction to retry forever.

Gateway boot also returns HTTP `503` with `Retry-After: 1` for mounted HTTP routes until the same readiness boundary opens. Search indexing does not delay this boundary because its worker starts lazily; see [Search worker and persistence](search-worker-persistence.md#diagnostics-and-session-admission).

Session-list invalidations (`session_created`, `sessions_changed`, and `session_removed`) are global. The browser keeps a lightweight `/ws/viewer` connection open even when no session `RemoteAgent` is active, so desktop sidebars, mobile landing pages, and dashboards can refresh `GET /api/sessions` promptly instead of waiting for the periodic poll. Session sockets also handle the same invalidations for already-open chats. Every frame remains a refresh trigger and the session list REST response remains authoritative. A `sessions_changed` frame may additionally carry `sessionId` and `user_tags` so an idle client can patch a loaded row before refresh; a client with a newer queued pin intent defers that additive payload until its mutation queue settles.

## Frame size routing and limits

Bobbit has separate limits for the socket transport, the chat composer, and Extension Host channel envelopes. They are intentionally layered so normal chat prompts can carry large legitimate payloads while channel traffic stays bounded.

| Limit | Source of truth | Scope | Current default | Why it exists |
|---|---|---|---|---|
| WebSocket transport payload | `WS_MAX_PAYLOAD_BYTES` in `src/server/server.ts` | All inbound frames accepted by the gateway WebSocket server | 256 MiB | Keeps the `ws` transport bounded, but high enough that the composer can reject oversized prompt sends with a clear UI error before the socket is torn down. |
| Composer serialized-send guard | `MessageEditor.MAX_SERIALIZED_SEND_BYTES` in `src/ui/components/MessageEditor.ts` | User prompt sends assembled by the message editor, especially attachment/image sends whose serialized prompt frame can include multiple base64 copies | 200 MiB | Gives users an actionable inline error and preserves the draft/attachments instead of relying on transport-level close behavior. |
| Extension-channel envelope cap | `MAX_EXTENSION_CHANNEL_WS_ENVELOPE_BYTES` in `src/server/ws/handler.ts` | Authenticated client messages whose `type` is `ext_channel_*` | 1 MiB | Keeps generic Extension Host channel operation envelopes cheap to parse and route; channel handlers still enforce their own contribution quotas. |

Routing rules:

- The first unauthenticated frame is only expected to authenticate. Oversized unauthenticated frames are rejected before command routing to avoid parsing arbitrary large unauthenticated input.
- After authentication, non-extension session commands such as `prompt`, `steer`, queue edits, `ext_session_write_permit`, and `ext_session_post` are governed by the WebSocket transport limit plus their feature-specific validation. They are **not** rejected solely because the serialized frame is larger than the 1 MiB extension-channel envelope cap.
- Prompt frames sent from the browser composer should stay below `MessageEditor.MAX_SERIALIZED_SEND_BYTES`, which is deliberately lower than `WS_MAX_PAYLOAD_BYTES`. This ordering makes the composer error the common failure mode for oversized attachment sends, not a socket close.
- Extension-channel operations (`ext_channel_open_grant`, `ext_channel_open`, `ext_channel_attach`, `ext_channel_list`, `ext_channel_send`, `ext_channel_close`, `ext_channel_detach`) remain capped by `MAX_EXTENSION_CHANNEL_WS_ENVELOPE_BYTES`. If one is too large, the server returns a structured size error and leaves the socket usable. With a `requestId`, callers receive an `ext_channel_result` or `ext_channel_open_grant_result` failure; without one, the fallback is a normal `error` frame with code `FRAME_TOO_LARGE`.
- The 1 MiB cap is only an envelope guard. It does not replace per-channel quotas such as declared frame and inbound-byte limits, pack identity checks, open grants, attachment checks, or session-write permits.

## Outbound payload bounding and backpressure

Bobbit keeps normal streaming responsive by bounding payloads before they enter the session EventBuffer or high-fanout goal broadcasts. The goal is not to hide diagnostic data; it is to keep the live socket path small and make large data available through explicit inspection endpoints.

- **Session events and history** — agent `message_update` / `message_end` events pass through large-content truncation before `emitSessionEvent()` pushes them into the EventBuffer and broadcasts them. The same truncation is applied to `get_messages` snapshots. Large tool text, preview snapshots, and `verification_result.summary` / `verification_result.report_html` are replaced with preview descriptors while the full transcript remains in the agent history or artifact store.
- **Gate verification output** — `gate_verification_step_output.text` is capped to a live preview, and `gate_verification_step_complete.output` is capped separately. Truncated events carry `textTruncated` / `outputTruncated` plus original and preview byte counts. Use `gate_inspect(section="verification", mode=...)` or retained diagnostics for full logs.
- **Goal broadcasts** — gate/team/goal events fan out to every matching goal session socket plus subscribed `/ws/viewer` sockets. This path uses the same overflow guard as per-session broadcasts and logs whether the backed-up recipient was a `goal-session` or `goal-viewer`.
- **Overflow guard** — when `bufferedAmount` exceeds the warning threshold, the server logs payload diagnostics. When it exceeds the overflow threshold, the server sends the current frame, waits for a short drain window, and terminates only if the socket remains backed up. The reconnect/resume path then recovers with either a bounded replay or `resume_gap`.

Overflow diagnostics include `outerType`, `innerType` for `{ type: "event" }` frames, serialized `bytes`, recipient kind, and context such as `goalId`. These fields are the first place to look when a reconnect storm follows verification or reviewer activity.

## Cumulative assistant stream compaction

Pi `0.84.1` JSON/RPC emits delta-only assistant `message_update` frames. `RpcBridge` first reconstructs Bobbit's cumulative internal event from the preceding assistant start, while preserving `message_end.message` as terminal authority. Repeating those growing cumulative copies to every browser would make WebSocket serialization and wire traffic grow with transcript length, so Bobbit compacts only the live browser projection for clients that negotiate it. Replay and snapshots remain cumulative and authoritative.

### Negotiation and compatibility

An app client requests version 1 in its authentication frame:

```json
{
  "type": "auth",
  "token": "<token>",
  "capabilities": { "assistantStreamDelta": 1 }
}
```

The gateway echoes `capabilities.assistantStreamDelta: 1` in `auth_ok` only when it accepts that version. A negotiated session socket receives compact live updates for supported assistant text, thinking, and progressive tool-call JSON events. The compact event carries `assistantStreamDelta: 1` plus the semantic fragment and any baseline or block checkpoint required to reconstruct Bobbit's cumulative internal shape exactly.

Compatibility is fail-safe:

- Clients that omit the capability continue to receive cumulative events.
- Unsupported or non-convergent event shapes remain cumulative even on a capable socket.
- A socket attaching during a stream receives a self-contained first compact update. This baseline is recipient-specific and is not shared with already-synchronized sockets.
- Equivalent capable recipients share compact-frame construction and serialization. Legacy and baseline-needing recipients remain separate output classes.
- Updates are emitted immediately. There is no process-global timer that coalesces, replaces, or defers `message_update` delivery.

The client reconstructs the cumulative `message` and `assistantMessageEvent.partial` before normal reducer processing. It keeps reconstruction state only for the active assistant stream and clears it on an explicit client reset, snapshot application, reconstruction failure, `process_exit`, `agent_end`, and `message_end`. Normal socket teardown does not clear that state: reconnect may continue the same logical stream through cumulative replay. Progressive tool JSON is rebuilt from fragments while preserving the useful parseable prefix. A replacement socket independently starts its compact live projection with a self-contained baseline. If exact reconstruction cannot be proven, the client clears the invalid state, discards the compact frame, and reconnects; cumulative replay or a snapshot remains the authoritative recovery path.

### Sources of truth and replay

Compaction is deliberately not a storage format. The following contracts prevent live, replayed, and reloaded transcripts from drifting:

- Durable Pi JSONL is unchanged and contains the complete original events.
- `EventBuffer` retains the original cumulative event, never the compact client projection.
- Snapshots and resume replay remain cumulative and authoritative. Proposals, permissions, compaction notices, verification cards, and event categories outside the supported assistant fragments continue through their existing state and pass-through paths.
- Per-session sequence numbers stay monotonic even when retention evicts an event, rejects an oversized or unserializable event, or assigns a sequence to an intentionally unretained frame.

The default `EventBuffer` is bounded by both 1,000 events and 2 MiB of estimated serialized UTF-8 data. Eviction is head-only. The 2 MiB retention budget matches the resume replay byte budget; retaining a larger tail would add heap pressure without making it replayable.

A cursor is replayable only when the buffer covers a contiguous suffix beginning at `fromSeq + 1`. Count or byte eviction advances that safe window. Oversized events and unretained sequenced frames create explicit holes. A request that crosses any hole receives `resume_gap` and recovers from `get_messages`; the server never sends a plausible-looking partial suffix with missing history. Replay is paced and checks socket sendability before and during the loop.

### Slow-client isolation and egress fencing

A replaceable assistant update is not allowed to make a slow recipient degrade healthy recipients. When a socket's `bufferedAmount` reaches the 1 MiB soft cutover threshold at an assistant update, the gateway marks that socket as cut over before terminating it. The marker is the durable in-memory fence: all later authenticated send boundaries reject the socket even if transport termination throws or `readyState` temporarily remains open. This includes ordinary events, late snapshots, state, resume responses, and paced replay sends. Other sockets continue independently.

This cutover is narrower than the general overflow guard documented above. The general guard still warns at 1 MiB and protects non-replaceable traffic with its 4 MiB overflow threshold; stream cutover avoids growing a replaceable cumulative-update queue to that point.

After reconnect authentication, IndexedDB-backed local intent is resent before resume or snapshot traffic. The FIFO resend keeps the original `intentId`; socket acceptance records only the connection epoch and does not remove the occurrence. Server admission is idempotent, its authoritative projection replaces local ownership by ID, and correlated transcript surfacing or explicit cancellation is the settlement boundary.

### Diagnostics and lifecycle

Detailed metrics remain opt-in through `BOBBIT_CPU_DIAG=1`; set `BOBBIT_CPU_DIAG_JSONL=<path>` for a JSONL artifact and `BOBBIT_CPU_DIAG_FLUSH_MS` to override the one-second default interval. Disabled diagnostics use no-op recorders.

Stream broadcast diagnostics report retained buffer bytes, recipient/cutover counters, and the normalization, retention, compaction, serialization, and send phases separately. The always-on event-loop lag monitor records named operation breadcrumbs around these phases, making a warning attributable to work such as retention or broadcast rather than only to a delayed timer. Diagnostic labels and timing samples are bounded to prevent the observer from becoming a new unbounded workload.

Each interval also reports GC count, major-GC count, cumulative duration, and maximum duration. Shutdown first drains queued GC observer records, then disconnects the observer and writes the final snapshot after earlier queued writes. This ordering avoids losing terminal GC data or retaining observer/process listeners across lifecycle teardown.

### MVP evidence and qualification

The measurements below apply to the qualified cumulative-replay MVP, not to a semantic-delta replay design:

| Workload | Observation |
|---|---|
| Synthetic production shape: 35 sessions, 1,000 updates each, 32 KiB final text | Capable-client wire traffic fell 99.37%, retained replay data fell 93.76%, and median MVP processing time fell 27.22%. |
| Same-sequence live A/B: 3,401 `message_update` frames | Legacy traffic was 24,049,444 bytes and compact traffic was 831,591 bytes, a 96.54% reduction. Reconstruction reported no failures or final-message hash mismatches. |
| Workload-matched live windows | Delay-max p95 changed from 146.8 to 70.9 ms, CPU median from 15.5% to 8.5%, and heap p95 from 831.8 to 734.4 MiB. |

The live-window comparison was not randomized and did not control host or client load; the worst single delay also did not improve. Treat those latency, CPU, and heap changes as indicative rather than causal. The same-sequence byte and reconstruction comparison is the stronger protocol-specific evidence.

An exact PR candidate is qualified with:

```bash
npm run check
npm run test:unit
npm run test:browser
npm run test:e2e
git diff --check
```

Focused contract coverage exercises buffer eviction and resume floors, mixed capable/legacy recipients, mid-stream text/thinking/tool baselines, terminal convergence, reconstruction failure, post-cutover egress fencing, reconnect outbox FIFO, and GC observer cleanup. Any correction to these contracts requires a pinning regression test.

Hold or roll back the candidate on transcript divergence, reconstruction loops, silent prompt loss, sequence stalls, reconnect storms, any send after slow-client cutover, or degradation of healthy clients. Do not respond by switching replay storage to semantic delta chains or by adding global timer-based update coalescing; either change requires a separate design and proof.

## Authenticated session work policy

Live session sockets enforce `readOnly` and `nonInteractive` at the authenticated
transport boundary, not only in the browser UI. The server checks both the live
session and its persisted row; `true` in either source activates the restriction.
This closes the window where one representation has updated before the other.
If both restrictions apply, `readOnly` takes precedence.

The guarded work classifier contains these frames:

- Agent and queue work: `prompt`, `steer`, `steer_queued`, `remove_queued`,
  `reorder_queue`, `retry`, `restart_agent`, `compact`.
- Metadata and model writes: `set_title`, `generate_title`,
  `summarize_goal_title`, `set_model`, `set_image_model`,
  `set_thinking_level`.
- Durable task and permission writes: `task_create`, `task_update`,
  `task_delete`, `grant_tool_permission`.
- Extension session writes: `ext_session_write_permit`, `ext_session_post`.

### Read-only sessions

Every guarded frame is rejected with `SESSION_READ_ONLY`. Ordinary guarded
frames receive the generic error envelope:

```json
{ "type": "error", "code": "SESSION_READ_ONLY", "message": "..." }
```

Extension session-write callers require a correlated response so their Host API
call does not wait for a generic error until timeout. They receive:

```json
{ "type": "ext_session_write_permit_result", "requestId": "...", "ok": false, "error": "SESSION_READ_ONLY" }
```

or:

```json
{ "type": "ext_session_post_result", "requestId": "...", "ok": false, "error": "SESSION_READ_ONLY" }
```

A read-only session has no streaming-steer exception.

### Non-interactive sessions

The response code identifies the rejected class:

| Frame | Policy code |
|---|---|
| `prompt` | `NON_INTERACTIVE_PROMPT` |
| `steer` while the current status is not `streaming` | `NON_INTERACTIVE_STEER` |
| `steer_queued`, `remove_queued`, `reorder_queue` | `NON_INTERACTIVE_QUEUE_CONTROL` |
| Every other guarded frame | `NON_INTERACTIVE_WORK_CONTROL` |

A direct `steer` is permitted only while the session's current status is
`streaming`; this allows an active automated review to be redirected without
starting or queueing new reviewer work. The exception does not extend to
`retry`, queue controls, extension posts, or any other guarded frame.

Ordinary frames receive `{ "type": "error", "code": "<policy-code>",
"message": "..." }`. As with read-only policy, `ext_session_write_permit` and
`ext_session_post` instead return their respective request-correlated result
envelope with the policy code in `error`.

### Classifier scope

`get_state`, `get_messages`, and `ping` remain available under these policies.
`abort` and `deny_tool_permission` also remain outside the guarded work
classifier because they decrease or stop active work. `resume` and the
separately authorized extension channel and surface operations are likewise not
classified here. This section documents only the session-work policy; those
frames can still be rejected by their own authentication, authorization,
lifecycle, validation, size, or replay rules.

## Client → Server

| Type | Fields | Description |
|---|---|---|
| `auth` | `token`, `goalId?`, `capabilities?` | Authenticate the connection. `goalId` is only used by `/ws/viewer` to subscribe immediately after auth. Session clients may request `capabilities.assistantStreamDelta: 1`; see [Cumulative assistant stream compaction](#cumulative-assistant-stream-compaction). |
| `subscribe_goal` | `goalId` | `/ws/viewer` only: add a goal subscription for goal-scoped broadcasts. |
| `unsubscribe_goal` | `goalId` | `/ws/viewer` only: remove one goal subscription. |
| `clear_goal_subscriptions` | — | `/ws/viewer` only: remove all goal subscriptions. |
| `prompt` | `text`, `intentId?`, `images?`, `attachments?` | Admit one prompt occurrence; replay by ID is idempotent. |
| `steer` | `text`, `intentId?` | Admit one steer occurrence; it may target the current or next turn. |
| `retry_intent` | `intentId` | Retry one definitely failed occurrence without changing its stable ID. |
| `steer_queued` | `messageId` | Promote an accepted queued prompt to steer intent. |
| `remove_queued` | `messageId` | Durably dismiss one queued or uncertain occurrence. |
| `reorder_queue` | `messageIds` | Reorder the prompt queue to match the given ID order |
| `abort` | — | Abort the current agent turn |
| `retry` | — | Retry the last failed turn |
| `restart_agent` | — | Restart the agent process for this socket's session. This is the active-session path; the sidebar `Refresh agent` action uses `POST /api/sessions/:id/restart` to target any live row by id. Both paths call the same session-manager restart implementation. |
| `grant_tool_permission` | `toolName`, `scope`, `group?`, `mode?` | Grant the active `ask`-gated tool request for one tool or a tool group. `mode` is `persistent`, `session-only`, or `one-time`; see [Permission Card UX](permission-card-ux.md). |
| `deny_tool_permission` | `toolName` | Deny the active `ask`-gated tool request so the guard long-poll returns immediately. |
| `set_model` | `provider`, `modelId`, `thinkingLevel?` | Switch the exact AI provider/model and, when supplied, its effective thinking level as one request. The session picker always supplies the clamped level; the field remains optional for older clients. See [Model and thinking selection](#model-and-thinking-selection). |
| `set_thinking_level` | `level` | Change only the current model's thinking level. The server clamps and verifies the resulting complete tuple; this remains separate from a model-picker request. |
| `set_image_model` | `provider`, `modelId` | Switch the per-session image generation model. Server validates `(provider, modelId)` against `getAvailableImageModels()`; on unknown the server replies with `{ type: "error", message: "unknown image model", code: "UNKNOWN_IMAGE_MODEL" }` and does **not** mutate session state. On valid, persists `imageModelProvider`/`imageModelId` to the session row and broadcasts the updated state to all attached clients. |
| `compact` | — | Trigger context compaction |
| `get_state` | — | Request current agent state |
| `get_messages` | — | Request full message history |
| `set_title` | `title` | Set session title |
| `generate_title` | — | Auto-generate title from conversation |
| `resume` | `fromSeq` | Resume streaming after a reconnect — server replays only events with `seq > fromSeq` (see [Streaming resume](#streaming-resume)) |
| `ping` | — | Keepalive ping |
| `task_create` | `goalId`, `title`, `taskType`, `parentTaskId?`, `spec?`, `dependsOn?` | Create a task |
| `task_update` | `taskId`, `updates` | Update a task (title, spec, state, assignment, deps) |
| `task_delete` | `taskId` | Delete a task |
| `summarize_goal_title` | `goalTitle` | Auto-generate a shorter goal title |

### Model and thinking selection

A model-picker choice is one exact provider/model/effective-thinking request:

```ts
{ type: "set_model"; provider: string; modelId: string; thinkingLevel?: string }
```

The picker always includes `thinkingLevel`. Before sending, it clamps the
session's current level against the chosen catalog row, optimistically updates
both fields, and emits no follow-up `set_thinking_level`. For example, if the
current level is `max` and the user selects Opus 4.8, whose metadata advertises
`xhigh` but not `max`, the only picker frame is:

```json
{
  "type": "set_model",
  "provider": "anthropic",
  "modelId": "claude-opus-4-8",
  "thinkingLevel": "xhigh"
}
```

The optional field preserves compatibility with older clients. When it is
absent, the gateway reuses the previous durable effective level when available,
otherwise the current authoritative level, and clamps it against the exact new
model. It does not infer `max`: that level is selectable only when the model's
`thinkingLevelMap` explicitly contains a non-null `max` entry. Pi `0.84.1`'s
direct Anthropic and supported Amazon Bedrock Opus 5 rows publish
`{ xhigh: "xhigh", max: "max" }`, so both levels—and the ordinary
`off` through `high` levels retained by the map rules—are available for those
exact rows. Opus 4.8 publishes `xhigh` only. `max` is unavailable without an
explicit map entry; `xhigh` may additionally come from the narrow map-less
family fallbacks documented in the thinking-level guide.

On success, the gateway:

1. Requires the exact `provider`/`modelId` to be session-selectable.
2. Clamps thinking against that selected catalog model.
3. Applies the model and verifies exact provider/model read-back before applying
   thinking.
4. Applies thinking and verifies the complete provider/model/effective-thinking
   tuple.
5. Persists and broadcasts only that verified tuple in one authoritative
   `state` frame containing both `model` and `thinkingLevel`.

For an ordinary live session, `set_model` and `set_thinking_level` use the
existing per-session command FIFO, so a prompt or later selection cannot
overtake an in-flight tuple mutation.

#### Recovering an unavailable persisted model

When `state.data.condition` is
`{ code: "MODEL_SELECTION_REQUIRED", provider, modelId }`, `set_model` is a
recovery request rather than an ordinary live mutation. The gateway accepts
only an exact currently session-selectable tuple, clamps thinking, starts a
replacement pinned to that tuple, rehydrates the existing transcript, and
verifies model read-back. It persists and publishes the replacement tuple with
`condition: null` only after activation succeeds.

An ordinary retryable activation failure returns
`MODEL_SELECTION_RECOVERY_FAILED` with a sanitized message that says to choose
another available model or retry. It preserves the unavailable durable tuple,
transcript, and condition. A second `set_model` while activation is running
returns the same code instead of waiting behind the first request.

An unverified transcript rollback also returns
`MODEL_SELECTION_RECOVERY_FAILED`, but its sanitized fail-closed message says
that the original conversation transcript could not be restored and **Do not
retry model selection**. The unavailable durable tuple and
`MODEL_SELECTION_REQUIRED` condition remain authoritative, but transcript
integrity is not guaranteed. The user must stop selecting models and ask an
administrator to inspect server logs and restore the transcript before
continuing; clients must not reinterpret this same-code message as the ordinary
retryable case.

While the condition remains, `prompt`, `steer`, `retry`, `restart_agent`, and
`set_thinking_level` return `MODEL_SELECTION_REQUIRED`. Before activation and
after an ordinary retryable failure, `get_state` and `get_messages` remain
available so the session stays navigable and readable. See
[Restored session requires a model](debugging.md#restored-session-requires-a-model).

#### Failed selection and correction

For ordinary live model or thinking changes, the client treats `state` as
authoritative over its optimistic values. If either write fails, the gateway
keeps the previous durable tuple unchanged and broadcasts a complete
correction—both `model` and `thinkingLevel`—from live read-back when available,
otherwise from complete durable state.

After a partial mutation, the gateway makes one bounded rollback attempt on the
same RPC bridge that received the request. If exact rollback cannot be verified,
it restarts the session from unchanged durability and verifies the replacement's
complete tuple. A recoverable failure therefore produces authoritative `state`
correction followed by `SET_MODEL_FAILED`; the browser responds with `get_state`
as a final reconciliation. No partial or unrequested tuple is a successful
selection.

If restart or replacement cannot establish a complete verified tuple, recovery
fails closed through normal session termination/archive behavior. A live unsafe
bridge is stopped and detached, its existing record is archived without changing
the durable tuple, and its clients receive the normal `session_archived` event
before their sockets close. If no live row remains, the gateway archives the
dormant record directly. There is no separate quarantine frame or session
status. Because socket closure can precede command-error delivery, clients must
treat `session_archived`/disconnect and session-list invalidation as terminal;
the actionable recovery is to create a fresh session, not to continue sending
commands to the old socket. All recovery errors are sanitized before logging or
WebSocket delivery.

#### Stale selection targets

The gateway captures the request's RPC bridge identity and rechecks it around
mutation, commit, rollback, and the session-ID restart boundary. This is needed
because role assignment or respawn can replace the canonical bridge while an
older `set_model` or `set_thinking_level` RPC is awaiting read-back.

When a newer canonical bridge has taken ownership, the stale request never
rolls back, restarts, terminates, or archives by session ID. It stops only the
superseded captured bridge, reloads the latest durable tuple, verifies the newer
bridge against that tuple, and broadcasts the canonical state when verification
succeeds. The stale command still returns its normal failure code, and the
client's `get_state` refresh converges on the replacement.

If stopping the superseded bridge or verifying the replacement fails, the
gateway reports a sanitized stale-recovery error and retains the newer canonical
session. It deliberately does not invoke session-ID quarantine, because that
would destroy the replacement rather than fence the stale target. The client
should reconnect before retrying. This also prevents an older durable snapshot
from overwriting a tuple committed by the replacement.

For an ordinary live session, a thinking-only UI change remains supported with:

```json
{ "type": "set_thinking_level", "level": "high" }
```

This standalone path leaves provider/model unchanged, clamps `level`—including
`xhigh` or `max` only when supported—against the currently bound exact model,
verifies and persists the resulting complete tuple, and broadcasts both tuple
fields as authoritative state. Failure returns
`SET_THINKING_LEVEL_FAILED` and uses the same correction, bounded rollback,
restart, fail-closed quarantine, stale-target fencing, and client refresh rules.

See [Per-model thinking-level capabilities](thinking-levels.md) for map
semantics and the shared clamp order.

## Server → Client

| Type | Key Fields | Description |
|---|---|---|
| `auth_ok` | `capabilities?` | Authentication succeeded. Accepted optional capabilities are echoed with their negotiated version. |
| `auth_failed` | — | Authentication failed |
| `state` | `data` | Current agent state snapshot. `data.condition` may be `{ code: "MODEL_SELECTION_REQUIRED", provider: string, modelId: string }`; partial snapshots that omit it do not clear it, and the server sends explicit `condition: null` only after verified recovery. |
| `messages` | `data` | Full message history array |
| `event` | `data`, `seq?`, `ts?` | Ordered agent event. Correlated user events carry delivery identity; `assistant_stream_invalidated` removes a provisional recoverable-length tail by `assistantStreamId`. `seq` is monotonic per session and `ts` is wall-clock ms; both remain optional for legacy interoperability. |
| `resume_gap` | `lastSeq` | Server's reply when `resume` cannot safely replay the missed tail. This can mean the requested `fromSeq` is outside the retained EventBuffer window, the replay would exceed the resume byte budget, or the socket is already backed up. Client must fall back to `get_messages` for a fresh snapshot and reset its seq counter to `lastSeq`. |
| `session_status` | `status` | Session status change (`idle`, `streaming`, `aborting`, etc.) |
| `session_title` | `sessionId`, `title` | Title changed |
| `session_created` | `sessionId`, `projectId?` | A visible session was created through REST, UI, or `host.agents`; clients should refresh the session list immediately. |
| `sessions_changed` | `projectId?`, `sessionId?`, `user_tags?` | Broad session-list invalidation. Pin mutations include the authoritative normalized user tags for an immediate row patch; clients still refresh the session list. |
| `session_removed` | `sessionId`, `projectId?`, `reason` | A session was terminated, archived, or purged; clients should remove or refresh the matching row promptly. |
| `staff_changed` | `reason`, `staffId`, `projectId`, `previousProjectId?`, `sessionId?` | A staff record was created, updated, reassigned, or deleted through REST/tool paths. Clients should reload staff and orphaned-staff state before refreshing sessions so permanent staff-agent sessions are classified under Staff instead of regular Sessions. |
| `client_joined` | `clientId` | Another client connected |
| `client_left` | `clientId` | A client disconnected |
| `error` | `message`, `code`, `intentId?`, `retryable?` | Error message. Correlated pre-admission errors may update only that local occurrence; uncorrelated errors settle none. |
| `pong` | — | Keepalive response |
| `cost_update` | `sessionId`, `goalId?`, `taskId?`, `cost` | Cumulative persisted session cost snapshot. Sent after live completed assistant usage and during hydration paths when persisted cost exists. Current servers include `cost.cacheHitRate`; see [Cost update shape](#cost-update-shape). |
| `queue_update` | `sessionId`, `queue` | Full server delivery-outbox projection, including accepted and in-flight occurrences. |
| `delivery_outbox` | `sessionId`, `outbox` | Attach-time server-authoritative delivery projection; current clients merge it by occurrence ID. |
| `intent_update` | `sessionId`, `intent`, `settlement?` | One exact occurrence projection or `surfaced` / `failed` / `cancelled` disposition. |
| `side_panel_workspace` | `sessionId`, `workspace` | The server-authoritative side-panel workspace for the session changed. Clients replace their local mirror only when `workspace.revision` is newer; see [side-panel-workspace.md](side-panel-workspace.md). |
| `context_trace_updated` | `sessionId`, `ts` | Metadata-only invalidation emitted after the session's trace append is durable. It contains no trace row or provider diagnostic. Only an open Context inspector for the active session performs a bounded REST refetch; clients that do not support this event may ignore it. See [Context Trace Inspector](lifecycle-hub.md#context-trace-inspector). |
| `decision_requests_updated` | `sessionId`, `ts` | Exact payload `{ type: "decision_requests_updated", sessionId: string, ts: number }`. Metadata-only invalidation after the session's durable decision requests change; it carries no request, question, answer, option, resolution, or secret. Clients re-fetch the [decision-request REST projection](rest-api.md#extension-decision-requests). |
| `extension_grants_updated` | `projectId`, `ts` | Exact payload `{ type: "extension_grants_updated", projectId: string, ts: number }`. Metadata-only invalidation after a project's extension grants change; it carries no grant, actor, audit row, reason, or secret. Clients re-fetch the [extension-grant REST projection](rest-api.md#extension-capability-grants); see [Extension capability grants](extension-capability-grants.md#administrative-rest-api) for the capability and revocation contract. |
| `extension_settings_updated` | `projectId`, `revision`, `ts` | Exact payload `{ type: "extension_settings_updated", projectId: string, revision: number, ts: number }`. Metadata-only invalidation after project extension settings publish. It carries no target, setting value, secret, grant, or actor. A client displaying that exact project re-fetches the redacted [extension-settings projection](rest-api.md#project-extension-settings); other project surfaces do nothing. |
| `task_changed` | `task` | A task was created, updated, or deleted |
| `tasks_list` | `tasks` | Full task list for a goal |
| `session_archived` | `sessionId`, `archivedAt` | Session was archived |
| `preferences_changed` | `preferences` | Server preferences were updated |
| `bg_process_created` | `process` (`BgProcessInfo`) | Background process started; `process.endTime` is `null` |
| `bg_process_output` | `processId`, `stream`, `text` | Output from a background process |
| `bg_process_exited` | `processId`, `exitCode`, `endTime`, `terminalReason`, `spawnFailure?` | Background process became terminal; `endTime` is the fixed terminal timestamp. `exitCode` is `number \| null` (null when no real code was captured). `terminalReason` is `"normal" \| "killed" \| "unrecoverable" \| "spawn-failed"`; `spawnFailure` is present only for the known startup failure. |
| `bg_process_dismissed` | `processId` | A background process record was dismissed (removed) and its persisted log/status files purged |
| `gate_signal_received` | `goalId`, `gateId`, `signalId` | Gate signal received |
| `gate_verification_started` | `goalId`, `gateId`, `signalId` | Gate verification began |
| `gate_verification_step_started` | `goalId`, `gateId`, `stepIndex`, `stepName` | A verification step began |
| `gate_verification_step_output` | `goalId`, `gateId`, `stepIndex`, `stream`, `text`, `textTruncated?`, `originalTextBytes?`, `previewTextBytes?` | Live output from a verification step. Large chunks are truncated to a bounded WS preview; full output remains available through gate inspection/retained diagnostics. |
| `gate_verification_step_complete` | `goalId`, `gateId`, `stepIndex`, `status`, `outputTruncated?`, `originalOutputBytes?`, `previewOutputBytes?` | A verification step finished (passed/failed). Large completion output is truncated to a bounded WS preview; full output remains available through gate inspection/retained diagnostics. |
| `gate_verification_awaiting_human` | `goalId`, `gateId`, `signalId`, `stepIndex`, `stepName`, `label`, `prompt` | A `human-signoff` step parked waiting on a human decision. Resolution emits `gate_verification_step_complete` (no separate event). See [goals-workflows-tasks.md — Human sign-off steps](goals-workflows-tasks.md#human-sign-off-steps). |
| `gate_verification_complete` | `goalId`, `gateId`, `signalId`, `status` | All verification steps finished |
| `gate_status_changed` | `goalId`, `gateId`, `status` | Gate status changed |
| `gate_reset` | `goalId`, `gateId`, `affectedGateIds`, `changedGateIds`, `unchangedGateIds`, `reopen` | A gate reset invalidated the requested gate and downstream dependents. `reopen` is the lifecycle outcome described below. Clients should refresh gate summaries for all affected ids. |
| `goal_state_changed` | `goalId` | A persisted goal state or setup-lifecycle transition changed. Treat it as an invalidation and refresh goal-list state, including retry transitions that clear stale setup errors and controls; reset-driven reopening emits this globally only when it performs `complete` → `in-progress`. |
| `goal_setup_complete` | `goalId` | Worktree setup was verified ready. It does not guarantee that a Team Lead or team has started. |
| `goal_setup_error` | `goalId`, `error` | Current setup failed; starting remains blocked until a retry or recovery reaches verified ready. |
| `team_agent_spawned` | `goalId`, `sessionId`, `role`, `name` | Team agent was spawned |
| `team_agent_dismissed` | `goalId`, `sessionId`, `role`, `name` | Team agent was dismissed |
| `team_agent_finished` | `goalId`, `sessionId`, `role`, `name` | Team agent finished its turn |
| `pr_status_changed` | `goalId?`, `sessionId?`, `status` | PR status changed for a goal or session |
| `tool_permission_needed` | `toolName`, `group`, `roleName`, `roleLabel`, `lastPromptText?`, `seq?`, `ts?` | A guarded tool call is blocked pending user approval. The frame is ordered with the transcript so the client can render the blocked tool call and permission row coherently. |
| `tool_permission_settled` | `toolName`, `group?`, `status`, `reason?` | The active permission request settled as `granted`, `denied`, `expired`, `superseded`, `cancelled`, or `error`. Clients keep inline history and remove non-actionable rows from pinned controls. |
| `index:progress` | `projectId`, `phase`, `total`, `completed`, `backlog` | Search index progress. `phase` is `"rebuild"` or `"incremental"`. Debounced to 500ms per project. |
| `index:complete` | `projectId`, `phase`, `durationMs`, `rowsWritten` | Search index run finished (full rebuild or incremental drain) |
| `index:error` | `projectId`, `message`, `recoverable` | Search worker/indexing error. `recoverable` indicates whether retry or an authoritative rebuild can recover; the current pure-JS engine has no model-download or native-binary failure mode. |
| `inbox.entry.added` | `staffId`, `entry` | A new inbox entry was enqueued for a staff agent (trigger fire, `POST /api/staff/:id/inbox`, or UI "+ Add to inbox"). See [staff-inbox.md](staff-inbox.md). |
| `inbox.entry.updated` | `staffId`, `entry` | A staff agent transitioned an inbox entry via `inbox_complete` / `inbox_dismiss`. |
| `inbox.entry.removed` | `staffId`, `entryId` | An inbox entry was pruned (`DELETE /api/staff/:id/inbox/:entryId`). Entry body not echoed — clients reconcile by id. |

### Gate reset lifecycle payload

Every `gate_reset` event includes this additive object, matching the REST reset response exactly:

```json
{
  "reopen": {
    "reopened": true,
    "previousState": "complete",
    "state": "in-progress"
  }
}
```

- `reopened: boolean` — `true` only when this request changed an active completed goal to `in-progress`.
- `previousState` — the goal state observed for this reset.
- `state` — the resulting goal state. Both state fields use `todo | in-progress | complete | shelved | blocked`.

A new successful reset emits `gate_reset`, including a no-op retry after a previously finalized reset. For an already reopened goal, that retry carries `{ "reopened": false, "previousState": "in-progress", "state": "in-progress" }`. It does not emit a second `goal_state_changed` or duplicate the team runtime rearm/lead notice when no gates changed.

A retry that resumes a retained write-ahead intent is different: its job is to finish runtime rearm or intent cleanup after the goal and gates already committed. It returns the original affected scope and reopen outcome through REST, but suppresses duplicate `gate_status_changed`, `gate_reset`, `goal_state_changed`, and lead notification. This makes transport effects idempotent as well as persistence.

On an actual reopen, `goal_state_changed { goalId }` is broadcast globally so sidebar, dashboard, status widget, and other browser contexts refresh their goal-list cache immediately. Goal-scoped `gate_status_changed` and `gate_reset` events update gate views. The widget's own viewer subscription refreshes goals, gates, and active verifications on `goal_state_changed`, so an external reopen reconciles even without an active chat socket.

The widget does not treat completion as a permanent local latch. While its popover is open it mirrors the authoritative app goal cache, so an external `team_complete` observed by the normal goal refresh/poll switches it to completed; the same mirror can later switch back on reopen. For an initiating reset it applies the REST `reopen.state` and affected pending gates immediately, then performs authoritative goal/gate/verification reads. The response is therefore a latency optimization, not a second source of lifecycle truth.

Dormant archived, shelved, or paused goals return REST `409`; they produce no `gate_reset` or reopen-driven `goal_state_changed` event. See [REST API — Durable reset transaction](rest-api.md#durable-reset-transaction) and [Goals, Workflows & Tasks — Reset-driven goal reopening](goals-workflows-tasks.md#reset-driven-goal-reopening).

### Background process events

`BgProcessInfo` snapshots carry `{ id, name, command, pid, status, exitCode, terminalReason, spawnFailure?, startTime, endTime }`, where timestamps are epoch milliseconds. `status` is `"running" | "exited" | "unrecoverable"`. `exitCode` is `number | null`. `terminalReason` is `"normal" | "killed" | "unrecoverable" | "spawn-failed" | null` (null while running). Running processes have `endTime: null`; a terminal process sets `endTime` once.

`bg_process_created` sends the full running snapshot. `bg_process_exited` sends `{ processId, exitCode, endTime, terminalReason, spawnFailure? }` so clients can update an existing pill without waiting for REST hydration. `terminalReason` distinguishes a clean exit (`"normal"`), a user-requested kill (`"killed"`), a process whose real exit code could not be recovered after a gateway restart (`"unrecoverable"`), and a known shell/Docker runtime startup failure (`"spawn-failed"`). The latter three use `exitCode: null`; clients must not fabricate one. `unrecoverable` is reserved for restart recovery and must not be used for a known failed spawn. For `spawn-failed`, `status` is `"exited"` and `spawnFailure` may contain only `{ kind: "spawn", code: "ENOENT" | "EACCES" | "EPERM" | "UNKNOWN", message }`, a sanitized diagnostic with no raw command, path, OS message, or stack. Missing legacy `endTime` values mean the final runtime is unknown; clients should keep the display non-growing rather than deriving elapsed time from `Date.now()`.

`bg_process_dismissed` (`{ processId }`) fires when a record is removed — either via explicit dismiss or as part of the legacy kill-then-dismiss path — and signals that the pill should disappear and its persisted log/status files have been purged. Dismiss is rejected (REST 409) while a process is still running; clients kill it first, then dismiss the resulting exited record.

### Session cost hydration

`cost_update.cost` has the same shape as `state.serverCost`: cumulative input/output/cache token totals plus `totalCost`, with `cacheHitRate` included by current servers. The payload is read from persisted `CostTracker` data and is not a delta; clients should replace their cached cost snapshot, not add it locally.

When persisted cost exists, the server hydrates it on active attach/reconnect, `get_state`, `get_messages`, resume/replay fallback, archived attach/state/messages, and `refreshAfterCompaction()`. `refreshAfterCompaction()` sends `cost_update` before the compacted `messages` snapshot so the UI keeps showing cumulative spend instead of recalculating from the reduced visible transcript.

See [session-cost.md](session-cost.md) for the source-of-truth and no-double-counting rules.

### Cost update shape

The `cost` field of a `cost_update` message:

```json
{
  "inputTokens": 12500,
  "outputTokens": 340,
  "cacheReadTokens": 87000,
  "cacheWriteTokens": 3200,
  "totalCost": 0.004712,
  "cacheHitRate": 0.874
}
```

- `cacheHitRate?: number | null` — derived ratio `cacheReadTokens / (cacheReadTokens + inputTokens)`. `null` when the denominator is 0 (cold session, or provider that does not report cache counters). Optional for mixed-version compatibility with older payloads.
- Older clients that do not recognise `cacheHitRate` silently ignore it.

See [docs/cache-hit-rate.md](cache-hit-rate.md) for formula details and null semantics.

### Streaming resume

Every `event` broadcast carries a server-assigned monotonic `seq` (per session, starting at 1) and wall-clock `ts`. The client tracks the highest `seq` it has seen and, on WebSocket reopen, sends `{ type: "resume", fromSeq: <highest> }` so the server replays only the tail it missed.

Resume replay is bounded twice: the EventBuffer retains only the recent ring of session events, and the serialized replay tail must fit within the resume byte budget. Before replaying, the server also waits briefly for an already-backed-up socket to drain, then paces individual event sends. If the window is missed, the replay would be too large, or the socket remains backed up, the server replies `{ type: "resume_gap", lastSeq }`. The client then fetches a full snapshot via `get_messages` and resets its counter to `lastSeq`.

The fallback preserves ordering without rebuilding the same multi-megabyte send queue that caused the reconnect. Full snapshots are also payload-bounded before delivery, so large tool output or verification reports do not re-enter the socket as one unbounded history frame. See [docs/internals.md — Event stream ordering & dedup](internals.md#event-stream-ordering--dedup) and [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md).

### Search index events

The `index:*` events drive the search status dot and the Settings → Maintenance → Search Index panel. They are never surfaced as foreground toasts or banners — users who want detail open the Maintenance panel. See [docs/internals.md — Semantic search](internals.md#semantic-search) for the full re-indexing model.
