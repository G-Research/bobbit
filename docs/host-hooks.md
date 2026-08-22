# Unified Extension Host hooks

Bobbit Extension Host hooks let installed packs participate in lifecycle operations or observe committed facts without inventing pack-specific event contracts.

Use the two hook kinds for different jobs:

- **Interceptor** — participate before Bobbit commits an operation. Bobbit awaits the handler, validates its typed proposal, and remains the only authority that can apply it.
- **Notification** — observe an immutable fact after Bobbit commits the authoritative change. A handler cannot delay, alter, or roll back the source operation.

Legacy Lifecycle Hub providers remain supported for ambient context. New code should use an explicit hook `kind`; a kindless `{ events, mode }` declaration remains inert compatibility metadata. See [Lifecycle Hub](lifecycle-hub.md) for the provider adapter and [the design record](design/unified-host-hooks.md) for alternatives and ownership decisions.

## Canonical contract

The shared catalogue in `src/shared/extension-host/host-hooks.ts` is the runtime and TypeScript source of truth for hook names, schemas, limits, filter fields, publication boundaries, revisions, privacy, and eligible consumers. Server publishers, browser APIs, observational modules, and staff triggers do not maintain parallel event definitions.

A notification has this readonly, host-constructed shape:

```ts
interface HostNotification<Name extends HostNotificationName> {
  readonly id: string;
  readonly scope: "session" | "project";
  readonly name: Name;
  readonly payloadVersion: number;
  readonly occurredAt: number;
  readonly projectId: string;
  readonly sessionId?: string;
  readonly aggregate: {
    readonly kind: string;
    readonly id: string;
    readonly revision: string | number;
  };
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload: Readonly<HostNotificationPayload<Name>>;
}
```

The host copies, validates, and deeply freezes the envelope before fanout. Extensions cannot choose its identity, scope, project/session binding, aggregate revision, timestamp, or correlation fields.

### Notification catalogue

Payloads are bounded metadata projections. The **Filters** column lists the only payload fields a notification-based staff trigger may match.

| Scope and name | Payload | Filters |
|---|---|---|
| session `statusChanged` | `previousStatus`, `status`, `statusVersion` | `status` |
| session `turnStarted` | `turnIndex`, `source` | `source` |
| session `turnCompleted` | `turnIndex`, `outcome`, `durationMs`, `hadToolCalls` | `outcome`, `hadToolCalls` |
| session `messageAppended` | `messageId`, `cursor`, `role`, `blockKinds` | `role` |
| session `toolCallStarted` | `toolCallId`, `toolName`, `turnIndex` | `toolName` |
| session `toolCallCompleted` | `toolCallId`, `toolName`, `status`, `durationMs`, optional `errorStatus` | `toolName`, `status`, `errorStatus` |
| project `sessionCreated` | `sessionId`, `kind`, optional `goalId` | `kind` |
| project `sessionArchived` | `sessionId`, `reason` | `reason` |
| project `sessionForked` | `sourceSessionId`, `sessionId`, optional `cutEntryId`, `forkMode` | `forkMode` |
| project `sessionStatusChanged` | `sessionId`, `previousStatus`, `status`, `statusVersion` | `status` |
| project `staffCreated` | `staffId`, `state`, optional `sessionId` | `state` |
| project `staffConfigChanged` | `staffId`, `changedFields` | — |
| project `staffRetired` | `staffId` | — |
| project `staffSessionChanged` | `staffId`, optional previous/current session IDs | — |
| project `goalCreated` | `goalId`, optional `parentGoalId`, `state` | `state` |
| project `goalUpdated` | `goalId`, `state`, `changedFields` | `state` |
| project `goalCompleted` | `goalId`, optional `parentGoalId` | — |
| project `goalArchived` | `goalId` | — |
| project `taskCreated` | `taskId`, `goalId`, `type`, `state`, optional `parentTaskId` | `type`, `state` |
| project `taskUpdated` | `taskId`, `goalId`, `state`, `changedFields` | `state` |
| project `taskStateChanged` | `taskId`, `goalId`, `previousState`, `state` | `previousState`, `state` |
| project `gateStatusChanged` | `gateId`, `goalId`, `previousStatus`, `status` | `status` |
| project `pullRequestStatusChanged` | `goalId`, optional `number`, `state`, `reviewDecision`, `mergeability` | `state`, `reviewDecision`, `mergeability` |
| project `settingsChanged` | `target`, `changedKeys` | `target` |

`toolCallCompleted` is session-scoped even when a project staff agent consumes it. A selector with project scope is invalid.

### Authoritative publication boundaries

Each publisher calls the shared dispatcher only after the named authority boundary. The
`aggregate.revision` value comes from the source in the last column.

| Notification | Post-authority boundary | Revision source |
|---|---|---|
| `statusChanged` | Session status owner queued the legacy status frame. | `statusVersion` |
| `turnStarted` | Session manager accepted the canonical `agent_start`. | `turnIndex` |
| `turnCompleted` | Session manager accepted the final non-retrying `agent_end`. | completed turn index |
| `messageAppended` | Session event owner accepted `message_end` into the event buffer. | event-buffer cursor |
| `toolCallStarted` | A current-writer Pi `tool_execution_start` entered the session event buffer, the exact callback claimed its cursor, and permission plus `beforeToolCall` settled as admitted. | accepted start-event cursor |
| `toolCallCompleted` | The admitted call reached `tool_execution_end` only after post-result policy, then its matching post-policy tool-result `message_end` entered the event buffer. | accepted result-message cursor |
| `sessionCreated` | Strict session persistence succeeded. | persisted session `updatedAt` |
| `sessionArchived` | Asynchronous session-store archive committed. | persisted `archivedAt` |
| `sessionForked` | Destination history/session materialisation completed. | destination session `updatedAt` |
| `sessionStatusChanged` | Session status owner queued the legacy status frame. | `statusVersion` |
| `staffCreated` | Staff creation was durably accepted. | staff `updatedAt` |
| `staffConfigChanged` | Strict staff update committed. | staff `updatedAt` |
| `staffRetired` | Strict retirement commit succeeded. | staff `updatedAt` |
| `staffSessionChanged` | Current staff session committed strictly. | staff `updatedAt` |
| `goalCreated` | Strict goal publication succeeded. | goal `updatedAt` |
| `goalUpdated` | Strict goal update publication succeeded. | goal `updatedAt` |
| `goalCompleted` | Goal manager durably published the completion transition. | goal `updatedAt` |
| `goalArchived` | Strict archive publication succeeded. | goal `archivedAt` |
| `taskCreated` | Task manager strictly published creation. | task `updatedAt` |
| `taskUpdated` | Task manager strictly published the update. | task `updatedAt` |
| `taskStateChanged` | Task manager strictly published the state transition. | task `updatedAt` |
| `gateStatusChanged` | Gate status summary was strictly persisted. | gate status revision |
| `pullRequestStatusChanged` | PR status store atomically persisted its safe projection. | provider `updatedAt` or safe-projection SHA-256 |
| `settingsChanged` | Project configuration atomically renamed the committed generation. | committed-config SHA-256 |

“Queued” is the authority point only where the status owner defines publication that way; it does
not mean a consumer acknowledged delivery. Every downstream adapter remains observational.

### Privacy boundary

Notifications contain identifiers, states, revisions, durations, bounded field-name lists, and safe outcome metadata only. They never contain:

- raw prompts or message text;
- tool arguments or tool-result bodies;
- setting values, secrets, or provider credentials;
- provider error text, stack traces, or mutable store objects.

Consumers fetch an authoritative transcript, snapshot, tool-call record, or pack route when they need larger data. Diagnostic rows contain bounded attribution codes, never notification payloads or thrown errors.

## Authoring runtime hook contributions

Runtime hooks require a schema-2 pack, a hook basename in `contents.hooks`, and an explicit `kind`. Paths resolve relative to the hook YAML and must remain inside the pack root.

### Interceptor example

```yaml
# pack.yaml
schema: 2
contents:
  roles: []
  tools: []
  skills: []
  hooks: [tool-policy]
```

```yaml
# hooks/tool-policy.yaml
id: policy.tools
module: ../lib/hooks.mjs
kind: interceptor
interceptors: [beforeToolCall, afterToolResult]
failurePolicy: failClosed
capabilities: [store]
budget: { timeoutMs: 1000 }
```

```js
// lib/hooks.mjs
export default {
  async beforeToolCall(ctx, request) {
    if (request.toolName === "unsafe_example") {
      return { action: "block", reasonCode: "not_permitted" };
    }
    return { action: "allow" };
  },

  async afterToolResult(ctx, request) {
    return { action: "allow" };
  },
};
```

The host runs interceptors sequentially in deterministic pack/contribution order. It checks activation and declared capabilities before invocation and again before applying a result. Requests and results are bounded, copied, frozen, and schema-validated. Invalid, timed-out, cancelled, or late results are discarded or converted to the definition's host-owned fail-closed result. The audit records whether a proposal was received, valid, and applied; a handler return value cannot claim application.

`failurePolicy` is accepted only where the interceptor definition allows it. In particular, context contributions fail open, protected tool boundaries may fail closed, and shutdown/import hooks are non-fatal.

### Notification handler example

```yaml
# hooks/goal-audit.yaml
id: audit.goals
module: ../lib/hooks.mjs
kind: notification
notifications:
  - { scope: project, name: goalUpdated }
  - { scope: project, name: goalCompleted }
capabilities: [store]
budget: { timeoutMs: 1000 }
```

```js
// lib/hooks.mjs
export default {
  async goalUpdated(ctx, event) {
    await ctx.host.store.put(
      `audit/${event.id}`,
      JSON.stringify({ revision: event.aggregate.revision, state: event.payload.state }),
    );
  },

  async goalCompleted(ctx, event) {
    await ctx.host.store.put(`audit/${event.id}`, "complete");
  },
};
```

Notification handlers receive the same frozen canonical envelope as browsers and staff triggers. They run asynchronously after publication, in deterministic order, with bounded deadlines and live activation/grant checks. Return values are ignored. Throws, timeouts, revocation, and diagnostics are isolated from both other handlers and the already-committed source operation.

A session-scoped handler's `ctx.host.session` and `ctx.host.agents` capabilities are also fenced to the source session's captured project. Every operation revalidates current host-owned session authority before work and after asynchronous settlement. If that session moves projects while the handler is running, transcript and agent results are withheld; a child minted during the race is best-effort dismissed before the call fails. The observational handler itself may continue until its deadline, but its old-project capabilities cannot cross the move.

### Interceptor catalogue

| Name | Result | Deadline: default / max / whole dispatch | Authority and failure behavior |
|---|---|---:|---|
| `sessionSetup` | `{ context }` | 1,500 / 3,000 / 5,000 ms | Host validates, provenance-fences, and budgets context; fail open. |
| `beforePrompt` | `{ context }` | 500 / 1,000 / 1,500 ms | Adds hidden context without rewriting the user message; fail open. |
| `beforeToolCall` | `allow`, `block`, or `replaceArgs` | 750 / 1,500 / 2,000 ms | Replacement args are validated against the tool; protected declarations may fail closed. |
| `afterToolResult` | `allow`, `replaceResult`, or `syntheticError` | 750 / 1,500 / 2,000 ms | Runs before persistence/publication; protected declarations default to fail closed. |
| `beforeCompact` | optional `context`/`flush` | 1,500 / 3,000 / 5,000 ms | Compaction proceeds on timeout or error. |
| `sessionShutdown` | optional `flush` | 1,000 / 2,000 / 3,000 ms | Teardown proceeds at the deadline; non-fatal. |
| `projectImported` | optional `initialised` | 2,000 / 5,000 / 8,000 ms | Runs after import commit; non-fatal failure cannot undo the imported project. |

For exact request/result schemas and deadline caps, use the shared `HOST_INTERCEPTOR_CATALOGUE`; do not duplicate these contracts in pack code.

## Browser Host API

Canonical browser notifications are additive Host contract v5 capabilities. Feature-detect `sessionNotifications` and `projectNotifications` rather than checking member presence.

```js
if (!host.capabilities.projectNotifications) return;

let refreshPending = false;
let refreshRunning = false;

function scheduleRefresh() {
  refreshPending = true;
  if (refreshRunning) return;
  queueMicrotask(async () => {
    if (refreshRunning) return;
    refreshRunning = true;
    try {
      // Repeat when another invalidation arrives during the read.
      while (refreshPending) {
        refreshPending = false;
        // This is the pack's own declared route, not a built-in Host API route.
        renderSnapshot(await host.callRoute("your-snapshot-route"));
      }
    } finally {
      refreshRunning = false;
      if (refreshPending) scheduleRefresh();
    }
  });
}

const offGoal = host.project.notifications.subscribe("goalUpdated", scheduleRefresh);
const offRefresh = host.project.notifications.onRefreshRequired(scheduleRefresh);

// On panel teardown; both functions are idempotent.
offGoal();
offRefresh();
```

`host.session.notifications` is bound to the panel's current session. `host.project.notifications` is bound to that session's server-resolved project and accepts no client-supplied project ID. The server routes session facts only to the exact authenticated session socket and project facts only to authenticated app sockets in the same project. Sandbox principals and unbound/viewer sockets do not receive this Host API stream.

The server revalidates the socket's authentication-time binding against current live and persisted session authority before every delta and refresh. When a session moves projects, the frame that discovers the move is suppressed, the socket is rebound, and old- and new-project deltas remain fenced behind one project `onRefreshRequired` callback. The panel must then read the destination project's authoritative snapshot. Missing or conflicting live/persisted authority unbinds the socket and fails closed rather than selecting a project.

Delivery is ordered and live per connection, not durable replay. `onRefreshRequired` schedules one initial snapshot read when registered and coalesces project moves, reconnect, epoch change, sequence gap, queue overflow, and burst invalidations. A discontinuous event is not applied as a delta. Always re-read the authoritative snapshot on mount or refresh-required; do not reconstruct state from notification history.

The legacy `host.session.subscribe("status" | "message" | "tool_result", handler)` remains available and unchanged. It is a separate adapter over rich session events, not a source for canonical notifications.

## Notification-based staff triggers

A staff trigger can select a canonical notification and optionally apply exact-AND scalar filters from the catalogue:

```json
{
  "id": "successful-example-tool",
  "type": "notification",
  "notification": {
    "scope": "session",
    "name": "toolCallCompleted"
  },
  "filter": {
    "toolName": "example_tool",
    "status": "succeeded"
  },
  "enabled": true
}
```

The server may generate `id` when omitted. Unknown names, scope/name mismatches, unknown filter fields, invalid scalar values, oversized filters, and cross-project matches fail closed. Filters compare the named payload fields for exact equality; there is no expression language.

For each matching active subscriber, Bobbit persists a per-project delivery intent containing the complete original validated canonical envelope. Its stable identity is derived from staff, trigger, and notification IDs. Delivery attempts are **at least once**; successful inbox acceptance is idempotent/effectively once for that identity. The gateway marks success only after the inbox write is durably accepted. A crash can retry the attempt, and restart reconciliation resumes pending or expired leased rows without reprojecting current aggregate state. This is not an exactly-once execution or staff-completion guarantee.

Pausing/retiring staff or disabling/deleting a trigger cancels pending work. Bounded attempts, deadlines, subscriber-version checks, and correlation-depth/root checks prevent stale delivery and causal loops. There is no global notification journal or replay API; only rows for matching staff subscribers are durable.

Notification input is not interpolated into prompt text. The inbox stores it as host-owned metadata and emits a generic wake prompt. Browser/operator inbox lists and WebSocket events return a redacted entry with `notificationInput`, root correlation, and causation depth removed. Only the exact live owning staff session may read or transition a notification entry with full metadata, authenticated by its gateway-issued `BOBBIT_SESSION_SECRET` sent as `X-Bobbit-Session-Secret`. The server resolves that secret to the live staff session and verifies staff and project ownership; bearer/cookie auth, public session IDs, request bodies, and client project claims are insufficient. The secret is per-session, in-memory, injected only into the owning process, and regenerated when a gateway restart respawns that process. Same-project sandbox sessions retain the existing shared-container, same-UID `/proc` residual risk; stronger isolation requires per-session containers.

For Pi tool-hook callbacks, that exact-session secret authenticates only the callback transport. Lifecycle authority comes separately from a current-writer Pi execution event accepted at a host-owned cursor. Each matching `{ session generation, toolCallId, toolName, phase }` claim is single-use. A missing or forged secret is rejected before body processing; forged, duplicate, mismatched, terminal, or stale-generation callbacks cannot invoke an interceptor, publish a tool fact, or admit downstream staff delivery.

See [Staff triggers](staff-triggers.md) for legacy trigger compatibility and [Staff inbox](staff-inbox.md) for the redacted/full read surfaces.

## Publication and delivery guarantees

- Publication occurs after each catalogue definition's authoritative persistence/publication boundary. Consumer failure is observational and cannot roll back the mutation.
- `turnCompleted` is emitted only at the final non-retrying terminal boundary. Retry attempts, duplicate/late terminal frames, and restore replay cannot emit another completion. Errored and aborted turns remain explicit outcomes.
- Tool start order is: current-writer Pi `tool_execution_start` observed → start accepted at an event-buffer cursor → Pi permission guard → exact one-use callback claim → `beforeToolCall` → admitted settlement → `toolCallStarted` → handler. A blocked or provenance-invalid call publishes no start fact.
- Tool completion order is: handler result/error → bridge callback attempts the exact admitted-call claim → protected `afterToolResult` policy or its host-owned transport fallback → approved, replaced, preserved original error, or synthetic result returned to Pi → matching current-writer `tool_execution_end` classification → post-policy tool-result `message_end` accepted/published → `messageAppended` → `toolCallCompleted`. Only safe post-policy metadata enters the completion event.
- `goalCompleted` is a durable completion transition with a stable revision and is distinct from `goalArchived`.
- `settingsChanged` follows atomic settings commit and carries only the committed revision plus bounded target/key identifiers, never values or secrets.
- Browser and module delivery are bounded, live, ordered per project, and best-effort. Browser pressure produces refresh-required; module pressure produces bounded diagnostics.
- Matching staff intent admission is durable and independent of live browser/module queues. Attempts are reconciled after restart as described above.

## Compatibility

This API is additive:

- provider contributions and Lifecycle Hub context semantics continue to work;
- kindless legacy `hooks/*.yaml` declarations stay listable but inert;
- `schedule`, `git`, `manual`, `goal_created`, and `goal_archived` staff triggers are unchanged;
- legacy `host.session.subscribe` consumers are unchanged;
- ordinary packs receive only session and project scope; administrative/system scope remains reserved.

See [Extension Host authoring](extension-host-authoring.md), [Lifecycle Hub](lifecycle-hub.md), [Staff triggers](staff-triggers.md), and [WebSocket protocol](websocket-protocol.md) for the surrounding APIs.
