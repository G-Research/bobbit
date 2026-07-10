# Permission Card UX

Permission cards are the user-visible part of Bobbit's `ask` tool policy. When an agent attempts a guarded tool, the guard extension blocks the tool call and asks the gateway to wait for a user decision. The UI must make that blocked state obvious: the tool has not run yet, and no result exists until permission is granted and the original invocation resumes.

This document covers the client/server lifecycle that keeps permission requests visible, ordered, and recoverable across streaming, reconnect, and navigation paths. For policy resolution and grant durations, see [Tool access policies](internals.md#tool-access-policies).

## Core behavior

- A permission-blocked tool call renders as pending/blocked, never as completed or successful before a matching `toolResult` exists.
- The triggering tool-call context remains visible when the permission request arrives during a live streaming turn.
- Active permission controls are pinned near the bottom of the chat column, above the composer/status area.
- Inline permission rows remain in the transcript after settlement, so grant/deny/timeout/error decisions are visible as history.
- Inline and pinned copies of the same card share duration mode, feedback, and disabled state.
- Server-side timeout, supersession, cancellation, denial, grant success, and stale-grant errors settle client rows instead of leaving zombie controls.
- Reconnect and alive-socket navigation derive pinned controls from current reducer rows, not from one-shot WebSocket side effects.

## Data model

Permission rows are synthetic transcript rows with `role: "tool_permission_needed"`. The reducer treats them as ordered transcript entries, not as a side channel. Each row carries the request metadata plus lifecycle fields:

| Field | Meaning |
|---|---|
| `toolName` | Model-facing tool name that triggered the guard. |
| `group` | Tool group used for group-level grants. |
| `roleName` / `roleLabel` | Role context shown to the user. |
| `lastPromptText` | Prompt context for display only; it is not replayed on grant. |
| `status` | Lifecycle: `active`, `granting`, `granted`, `denied`, `expired`, `superseded`, `cancelled`, or `error`. |
| `actionable` | Whether controls should be enabled and eligible for the pinned stack. |
| `mode` | Shared grant duration selection: `session-only`, `one-time`, or `persistent`. |
| `error` | Optional settlement message for stale or failed grants. |

Only `active` and `granting` rows with `actionable !== false` are pinned. Settled rows stay inline as compact history and are not actionable.

## Blocked tool rendering

A guarded tool call can be present without a result in two common cases:

1. A live turn is blocked before the tool runs.
2. A reconnect or late join rehydrates a transcript with an unresolved permission row and a no-result tool call.

The renderer must not interpret that shape as success. `MessageList` derives the set of actionable permission-blocked tool names from current messages and passes it into tool rendering. `Messages` then marks matching no-result tool cards as `permissionBlocked`, which keeps the card visible and displays a waiting-for-permission notice.

This avoids changing the global meaning of no-result historical tool calls. The blocked state is explicit and tied to permission rows.

## Streaming permission path

`tool_permission_needed` can arrive while the blocked tool call still lives only in `state.streamingMessage`. Clearing the streaming preview without preserving it would make the triggering tool disappear.

The client handles this by freezing the current streaming assistant message before clearing the live preview:

1. `RemoteAgent` receives `tool_permission_needed`.
2. If the current streaming assistant message contains the blocked tool call, it dispatches `blocked-tool-call-placeholder`.
3. The reducer inserts a one-time assistant placeholder just before the permission row and marks it `_permissionBlocked`.
4. The streaming preview is cleared, but the transcript still shows the blocked tool context.
5. If an equivalent stable assistant row already exists, the placeholder action is a no-op to avoid duplicate cards.

The placeholder remains blocked until a real `toolResult` or settled permission history makes the outcome clear.

## Pinned controls

`AgentInterface` derives the pinned permission stack from current transcript rows on every render. It does not maintain a separate source of truth.

The pinned area is rendered inside the chat column, above the composer/status region, using sticky in-flow positioning rather than a viewport overlay. This keeps it visible while the transcript scrolls without covering the message editor, session status, or mobile safe-area controls.

Multiple active rows are stacked compactly in a bounded, internally scrollable panel. In the normal server path only one pending guard long-poll is authoritative per session; when a newer request replaces an older one, the older row is marked `superseded` and leaves the pinned stack. The UI still handles multiple actionable rows predictably for transient/replayed states and browser fixtures.

## Inline and pinned card synchronization

The same permission row can render twice: once inline in the transcript and once in the pinned stack. `ToolPermissionCard` is therefore controlled by parent state instead of owning grant state locally.

Shared state lives on the permission row:

- duration mode changes patch the row, so both copies show the same selection;
- grant clicks patch the row to `granting`, disabling both copies;
- deny clicks patch the row to `denied`, removing it from pinned controls while keeping inline history;
- stale grant errors patch the row to `error`, clearing any spinner in both copies.

A short click lock in `AgentInterface` suppresses duplicate grant clicks across copies. The grant scope (`tool` vs `group`) is still determined by the clicked button and is sent with the shared duration mode.

## Settlement lifecycle

The gateway owns the guard long-poll and broadcasts settlement frames when a pending request stops being actionable.

| Server event | Client status | User-visible result |
|---|---|---|
| User grants current request | `granted` | Inline success history; pinned card settles while the original tool resumes. |
| User denies current request | `denied` | Inline denied history; pinned controls disappear. |
| Request times out | `expired` | Inline warning history; no zombie controls. |
| New request replaces old request | `superseded` | Old request becomes stale history; only the latest request is actionable. |
| Session terminates while pending | `cancelled` | Inline cancelled/expired-style history. |
| Stale or mismatched grant | `error` | Inline error history; grant spinner clears. |

The server broadcasts `tool_permission_settled` for grant, deny, timeout, supersession, cancellation, and stale-grant error paths. The client maps that frame to a `permission-status` reducer action.

Generic WebSocket `GRANT_ERROR` frames are also handled defensively: active permission rows are reconciled to `error`, marked non-actionable, and any granting feedback is cleared.

## Reconnect and navigation recovery

Late-joining sockets receive the current pending permission via `getPendingToolPermission()`, using the original `seq` and `ts` from the first broadcast. Reusing the original sequence prevents attached clients from seeing an artificial event gap.

Alive-socket navigate-away/navigate-back is different: the socket may stay open, so no replayed `tool_permission_needed` frame is guaranteed. The pinned area therefore derives entirely from current reducer `messages`. If a permission row is present and actionable, controls appear after remount even without a new server frame.

Settlement is driven by `tool_permission_settled` frames from the gateway. The generic `GRANT_ERROR` fallback uses reducer reconciliation to mark any still-active permission rows as `error` rather than leaving them actionable.

## Protocol summary

Relevant WebSocket frames:

| Direction | Type | Purpose |
|---|---|---|
| Server → client | `tool_permission_needed` | Adds or refreshes an active permission row. Carries `toolName`, `group`, role labels, optional `lastPromptText`, and ordering metadata. |
| Server → client | `tool_permission_settled` | Marks an active row `granted`, `denied`, `expired`, `superseded`, `cancelled`, or `error`. |
| Client → server | `grant_tool_permission` | Grants the active request for a `tool` or `group` with a duration mode. |
| Client → server | `deny_tool_permission` | Denies the active request. |
| Server → client | `error` with `code: "GRANT_ERROR"` | Defensive stale-grant failure path; the client settles active permission UI to `error`. |

The guard extension still uses `POST /api/sessions/:id/tool-grant-request` as the blocking long-poll. UI grant/deny frames resolve that existing request; they do not create a new prompt or replay `lastPromptText`.

## Implementation map

- Client reducer lifecycle: `src/app/message-reducer.ts`
- WebSocket handling and streaming placeholder preservation: `src/app/remote-agent.ts`
- Pinned stack and shared row patching: `src/ui/components/AgentInterface.ts`
- Inline permission rendering and blocked-tool detection: `src/ui/components/MessageList.ts`
- Tool card blocked-state rendering: `src/ui/components/Messages.ts`
- Controlled permission card UI: `src/ui/components/ToolPermissionCard.ts`
- Server request ownership and settlement broadcasts: `src/server/agent/session-manager.ts`
- Protocol typing: `src/server/ws/protocol.ts`

## Regression coverage

- `tests2/core/permission-reducer.test.ts` pins lifecycle transitions and supersession.
- `tests2/dom/permission-card-ux.test.ts` pins blocked rendering, streaming preservation, shared inline/pinned state, stale-grant recovery, and navigation-derived pinned controls.
- `tests2/browser/fixtures/permission-card-ux.spec.ts` pins visible non-overlapping pinned controls and grant/deny behavior from the pinned stack.
