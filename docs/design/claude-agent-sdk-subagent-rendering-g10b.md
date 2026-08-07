# G10b — Embedded Claude Agent SDK subagent rendering

## Decision

Render an SDK child **inside the root `Agent` tool card that created it**. It is
not a Bobbit session, task, team member, sidebar item, or a second chat pane.
The same transcript/card pipeline used by `team_delegate` owns its presentation.

The authoritative join is the SDK's `parent_tool_use_id`:

```text
root assistant toolCall { id: "agent-use-1", name: "Agent" }
                         │
                         ├─ child SDK messages { parent_tool_use_id: "agent-use-1" }
                         ├─ child tool lifecycle { parentToolUseId: "agent-use-1" }
                         └─ SubagentStart/Stop registry { toolUseId: "agent-use-1", agentId/type }
```

`SubagentStart` and `SubagentStop` describe identity and terminal lifecycle;
they do **not** supply the parent id at this SDK pin. The existing admission
registry is therefore the only valid Start/Stop-to-parent join. Forwarded SDK
frames remain partitioned by `parent_tool_use_id`, as they already are in
`claude-sdk-event-translator.ts`; no text or tool result from a non-root
partition may enter root assistant prose.

## Existing seams and gaps

| Existing seam | Current behavior | G10b change |
|---|---|---|
| `claude-sdk-event-translator.ts::translateClaudeSdkEvent` | Correctly isolates each `parent_tool_use_id`, emits `parentToolUseId`, drains child terminal locally. | Retain its ordering/terminal behavior. Add typed identity annotation only after the partition is established. |
| `claude-agent-sdk-tool-surface.ts::buildClaudeSdkSubagentPolicy` | Correlates admitted root `Agent` call to `agent_id`/type and audits bounded Start/Stop data. | Publish immutable lifecycle records to the bridge; do not make hooks create Bobbit sessions. |
| `claude-agent-sdk-bridge.ts::consume` | Emits translated child events as ordinary events. | Project child event/lifecycle data into an embedded-work event stream; root events retain the ordinary stream. |
| `claude-agent-sdk-history-adapter.ts` | Preserves `parentToolUseId`/`parentAgentId`, but returns child rows at transcript top level. | Preserve raw rows, then create a pure embedded snapshot projection. |
| `session-manager.ts` | Lifecycle, snapshots, event buffer, search, and cost tracking treat all assistant rows as root rows. | Pass through embedded-work events, exclude child lifecycle from root completion/queue state, index and account each child row once with its parent attribution. |
| `remote-agent.ts` / `message-reducer.ts` | Treats every `message_end` as a normal transcript row, so child prose leaks into the root timeline. | Keep per-parent embedded state; consume child events without adding them to the root message list. |
| `MessageList`, `Messages`, `DelegateRenderer` | Existing tool-card and delegate-card composition. | Normalize only the display identity of native `Agent` to the delegate renderer contract and render child content there. |

## Types and ownership

Add `src/server/agent/claude-sdk-subagent-work.ts`. It is pure except for the
bounded recovery adapter passed to it. Its exported wire/data types are the
single G10b contract:

```ts
export type ClaudeSdkSubagentPhase =
  | "pending" | "running" | "completed" | "error" | "aborted" | "unknown";

export interface ClaudeSdkSubagentIdentity {
  readonly parentToolUseId: string;
  readonly agentId?: string;
  readonly agentType?: string;
}

export interface ClaudeSdkEmbeddedWork {
  readonly parentToolUseId: string;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly phase: ClaudeSdkSubagentPhase;
  readonly startedAt?: number;
  readonly stoppedAt?: number;
  readonly durationMs?: number;
  /** Ordered Pi-shaped child-only rows; never root transcript rows. */
  readonly messages: readonly ClaudeAgentSdkHistoryMessage[];
  /** Tool ids still open inside this child partition. */
  readonly pendingToolCallIds: readonly string[];
  /** Sum only finalized child-message usage, keyed by SDK UUID. */
  readonly usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  readonly diagnostic?: "unknown-parent" | "recovery-unavailable" | "recovery-mismatch";
}

export interface ClaudeSdkEmbeddedWorkEvent {
  readonly type: "claude_sdk_subagent_work";
  readonly parentToolUseId: string;
  readonly kind: "start" | "message" | "tool_start" | "tool_end" | "stop" | "terminal" | "recovered";
  readonly identity?: ClaudeSdkSubagentIdentity;
  readonly message?: ClaudeAgentSdkHistoryMessage;
  readonly toolEvent?: Record<string, unknown>;
  readonly terminal?: { phase: ClaudeSdkSubagentPhase; error?: string };
  readonly seq?: number;
}
```

`parentToolUseId` is a non-empty bounded string at every boundary. It is never
inferred from `parentAgentId`, child text, a tool name, or arrival order.
`agentId` and `agentType` enrich a known parent but never authorize or redirect
one. Unknown/late child partitions are retained under their partition key until
recovery; they must not be appended to the root timeline or attached to the
most recent `Agent` call.

`projectClaudeSdkEmbeddedWork(...)` in this file accepts ordered normalized
rows/events and returns `{ rootMessages, workByParent, diagnostics }`. It:

1. recognizes a root native `Agent` call by the raw SDK name before display
   normalization;
2. uses the call id as the sole parent-card key;
3. removes rows with a `parentToolUseId` from `rootMessages` and appends them,
   in input/sequence order, to that key's work;
4. associates child tool starts/ends with the same key and child tool id;
5. uses SDK UUID/tool-call id idempotency sets so replay, live delivery, and a
   later snapshot cannot duplicate content, usage, or a terminal; and
6. leaves a root `Agent` result as the parent card result; it never replaces it
   with a child result.

The projection carries the original message `id`, timestamp, `usage`,
`parentToolUseId`, and `parentAgentId`; this is the audit transcript. It does
not serialize SDK hook transcript paths, prompts, environment, credentials, or
unbounded raw hook values.

## Server data flow

### 1. Hook registry to bridge lifecycle

Extend `ClaudeSdkSubagentPolicy` in
`src/server/agent/claude-agent-sdk-tool-surface.ts` with:

```ts
subscribe(listener: (event: {
  kind: "start" | "stop";
  entry: ClaudeSdkSubagentRegistryEntry;
  at: number;
}) => void): () => void;
```

`onStart` emits only after it has atomically inserted the existing matching
registry entry. `onStop` emits the removed entry before discarding it. `clear`
and `dispose` emit terminal `aborted` records for live entries, once. The
existing `toolUseId` on `ClaudeSdkSubagentRegistryEntry` becomes
`parentToolUseId`; do not trust fields supplied by the hook to manufacture the
join. Keep the existing bounded `ClaudeSdkSubagentAuditEvent` logging unchanged
and add `parentToolUseId` to every Start/Stop audit row.

In `ClaudeAgentSdkBridge.startInternal`, subscribe to this policy immediately
after creating the query surface, store the unsubscribe alongside the bridge,
and emit `claude_sdk_subagent_work` start/stop frames. Cleanup unsubscribes
before surface disposal. A root terminal, bridge failure, stop, replacement, or
dispose must emit one aborted terminal for every live child before clearing the
registry. This makes an interrupted card terminal rather than permanently
running.

### 2. SDK event translation and parent partition

In `ClaudeAgentSdkBridge.consume`:

* run the existing translator and canonical MCP-name conversion unchanged;
* for every translated event with `parentToolUseId`, send it to
  `ClaudeSdkSubagentWorkAssembler.ingestLiveEvent`; emit its resulting
  `claude_sdk_subagent_work` frame(s) instead of emitting that child
  `message_update`, `message_end`, `tool_execution_*`, or child terminal as a
  root event;
* emit root-partition events through the existing `this.emit(event)` path;
* retain the present root-only `agent_end` detection. A child terminal must
  never flip bridge state to ready, clear the root turn, settle the root queue,
  or emit `agent_end`.

The assembler attaches the registry identity when it knows the partition. If a
child frame precedes its Start hook, it creates an `unknown` entry keyed by the
partition and triggers recovery (below); a subsequent verified Start upgrades
that exact key. It never uses `parent_agent_id` as a fallback parent.

The existing translator must continue to ensure local ordering:
`message_end(assistant)` before `tool_execution_start`; matching child
`toolResult` before `tool_execution_end`; a child error/result drains only that
partition. G10b does not change `ClaudeSdkTranslatorState`, root `agent_end`,
or its duplicate fingerprint rules.

### 3. Snapshot/reload/resume recovery

Extend `ClaudeAgentSdkSessionApi` and its lazy SDK adapter in
`src/server/agent/claude-agent-sdk-session-access.ts` with the pin's official
recovery APIs (using their exact `.d.ts` option shapes at implementation time):

```ts
listSubagents(sessionId, { dir? }): Promise<unknown[]>;
getSubagentMessages(sessionId, agentId, { dir? }): Promise<SdkSessionMessage[]>;
```

Expose narrow wrappers `readSdkSubagents` and `readSdkSubagentMessages`. They
must validate the root SDK UUID, pass only `{ dir: cwd }`, sanitize errors with
the existing `SDK_SESSION_UNAVAILABLE` path, and be dependency-injected through
`ClaudeAgentSdkSessionAccessDeps`. No direct read of Claude transcript files is
allowed.

Recovery algorithm, owned by `ClaudeSdkSubagentWorkAssembler.recover`:

1. Call `listSubagents(rootSessionId, { dir: cwd })` only for an unknown/late
   partition, a missing Start/Stop after bounded debounce, or a snapshot row
   that references a parent with no live registry identity. Coalesce one
   in-flight request per parent partition.
2. Normalize only documented identity/lifecycle fields from each returned
   record. Match its parent tool-use id exactly. Reject a zero, duplicate, or
   mismatched parent as `recovery-mismatch`; do not guess.
3. For an exact child `agentId`, call `getSubagentMessages`; adapt with the
   existing `adaptSdkSessionMessages`, require every recovered row to carry the
   same `parentToolUseId`, then merge by SDK UUID/tool-call id into the child
   projection.
4. A completed list row supplies phase/timestamps only when Start/Stop data was
   missed. Its messages and usage remain auditable child rows. An unavailable
   recovery leaves the card visibly `unknown`/`recovery-unavailable`, never
   drops received live data and never invents completion.

Use this same projection in three places:

* `ClaudeAgentSdkBridge.getMessages()` after `adaptSdkSessionMessages`;
* `SessionManager.getArchivedMessages()` after the SDK history adapter; and
* the live bridge for frames arriving after the websocket is connected.

`SessionManager.buildVisibleMessageSnapshot` accepts a snapshot envelope
`{ messages, subagentWork }` (or a parallel optional `subagentWork` field),
rather than pretending embedded rows are root transcript messages. Preserve it
through the websocket `messages` response. The EventBuffer stores the semantic
embedded-work frames with ordinary server sequence numbers, so reconnect replay
and compaction/restart see the same incremental state. It must not persist a
second Bobbit transcript or session row.

On bridge resume, initialize a new assembler from the official source snapshot
before forwarding new child traffic. Its UUID/idempotency sets make a snapshot
that overlaps replayed WS events converge. On SDK compaction, retain child
work already represented by the current snapshot and follow normal compaction
visibility rules; never promote it into root prose. On a later resumed root
turn, a new root `Agent` tool id creates a new parent key.

### 4. Session lifecycle, search, and cost

`SessionManager.handleAgentLifecycle` must ignore
`claude_sdk_subagent_work` for root acceptance fences, `latestMessageUpdate`,
root terminal classification, prompt/steer draining, session status, and
`completedTurnCount`. It broadcasts these frames through `emitAgentEvent` with
the ordinary sequence envelope.

For search and audit, index each finalized child message once, with existing
session ownership plus `{ parentToolUseId, parentAgentId, agentType }` metadata;
do not index a copied/root-prose form. Add `recordSubagentUsage` beside
`trackCostFromEvent`, keyed by `(sessionId, parentToolUseId, messageId)`. It
records child usage in the **existing root session cost account** exactly once
and maintains a queryable per-parent breakdown. `trackCostFromEvent` skips
child `message_end` events because the assembler owns their accounting. The
root final message remains independently accounted. This avoids both losing
child spend and double counting root/child usage.

Expose the breakdown only in the parent card's transcript/cost affordance; do
not create a child `CostTracker` account. Existing bounded policy audit events
plus the normalized child transcript/usage rows give operators enough evidence
to reconcile child work to root cost without retaining secret hook data.

## Client projection and rendering

### Client state

Add `src/app/claude-sdk-subagent-work.ts`, a pure reducer helper mirroring the
server wire type. `RemoteAgent` adds `subagentWorkByParent: Map<string,
ClaudeSdkEmbeddedWork>` to its transient state.

* On `claude_sdk_subagent_work`, update that map and notify render.
* On a child `message_update`/`message_end` from older/replayed servers, first
  recognize `event.parentToolUseId` and route it through the same helper; never
  set `streamingMessage`, call root proposal parsing, publish a root host
  message, or dispatch a standalone transcript event.
* Root events preserve current behavior.
* On a `messages` snapshot, run `projectClaudeSdkSnapshot(messages,
  subagentWork)` before dispatching `message-reducer`'s `snapshot` action:
  child rows become parent work, root rows alone reach `messages`.

Keep `message-reducer.ts` as the sole ordering reducer. Extend its snapshot and
live replacement identity sets to include parent+SDK UUID and parent+toolCallId
when comparing embedded work; do not use plain-text dedup for child rows.
The parent assistant row keeps its server `_order`; its nested children use
chronological SDK timestamp followed by server sequence/insertion tick. This
prevents interleaved children from reordering root transcript rows while keeping
each card stable across reload.

### Renderer identity normalization

Add `normalizeClaudeSdkRenderIdentity` in the new client helper. It is display
only:

```ts
raw native "Agent" + approved embedded work -> "team_delegate"
raw MCP names                          -> existing canonical normalization
all other names                        -> unchanged
```

Retain `rawToolName: "Agent"` and the original tool-call id on the parent
block. The normalizer must require an approved/known `parentToolUseId`; an
ordinary/unknown tool named `Agent` uses the default tool renderer. It does not
change server permission identities, persisted grants, SDK `allowedTools`, or
policy checks.

Extend `src/ui/tools/renderers/DelegateRenderer.ts` with a narrow
`ClaudeSdkEmbeddedDelegateDetails` branch, and use existing `ToolMessage` /
`renderTool` wrapping rather than a new standalone subagent component system.
The branch renders:

* the existing compact delegate header with approved type and phase;
* collapsed-by-default child transcript text/thinking and the existing tool
  renderer for each child tool/result, keyed `parentToolUseId:toolCallId`;
* running/open child tools and a terminal completed/error/aborted/unknown
  badge; and
* a cost/transcript disclosure using the embedded normalized rows.

It has no session link, child controls, sidebar presence, task actions, or
independent timer/cost account. Existing `team_delegate` behavior stays
unchanged. `MessageList` passes `subagentWorkByParent.get(toolCall.id)` as the
renderer detail/partial state for the normalized parent only. `Messages` and
`StreamingMessageContainer` receive the same detail for live parent streaming;
all child prose stays inside that card.

## Failure and ordering rules

| Condition | Required result |
|---|---|
| Child starts/messages before parent card arrives | Buffer by exact parent id; render when parent arrives; recover after debounce; never attach to last tool card. |
| Parent exists but Start is late/missing | Render partitioned live work as `unknown`; `listSubagents` may upgrade identity/phase. |
| Unknown parent after recovery | Keep a bounded diagnostic/audit entry and suppress child prose from root; discard only after a root terminal plus recovery window. |
| Child error/result | Drain only that child work, show error/aborted state and retained tools/text; root stays streaming. |
| Root error/abort/stop/replacement | Mark every nonterminal child aborted once; do not wait forever for Stop. |
| Duplicate live/replay/snapshot frames | Dedupe by partition plus SDK UUID/tool-call id; snapshot remains authoritative for identical finalized rows. |
| Reload/archived view | Rebuild cards from `getSessionMessages` plus recovery; no dependency on browser-only live state. |
| Resume/compaction | Hydrate projection before forwarding replay; preserve parent keys and do not emit child content as new root assistant rows. |
| Recovery API unavailable/malformed | Preserve known live data, show bounded unknown state, audit sanitized reason; do not fail the root session. |

## Exact implementation sequence

1. Add server types/projection/recovery to `claude-sdk-subagent-work.ts`; extend
   SDK access API/deps and test fakes for `listSubagents`/
   `getSubagentMessages`.
2. Make the existing subagent policy publish verified Start/Stop registry
   entries; subscribe in the bridge and route child translator events through
   the assembler.
3. Thread embedded frames/snapshot envelope through `SessionManager`, visible
   snapshots, EventBuffer, search, and root-cost attribution without changing
   Pi runtime behavior.
4. Add the client pure reducer/projection; route child events before ordinary
   remote-agent message handling; retain root message-reducer ownership.
5. Add the display-only `Agent` → `team_delegate` normalization and the narrow
   `DelegateRenderer` branch. Do not add a sidebar/session/task UI.

## Test plan

Register every new test in `tests2/tests-map.json`.

| Tier/file | Coverage |
|---|---|
| `tests2/core/claude-sdk-subagent-work.test.ts` | Pure interleaving of root + two children, partition-first attachment, child tool ordering, child-local error drain, dedupe/replay, late parent, unknown parent, Start/Stop-to-admission join, root stop abort, usage UUID dedupe, and recovery exact-match/rejection cases. |
| `tests2/core/claude-agent-sdk-session-access.test.ts` | Exact `dir` forwarding and sanitized failures for `listSubagents`/`getSubagentMessages`; malformed rows and parent mismatch cannot attach. |
| `tests2/core/claude-agent-sdk-bridge.test.ts` | Start/Stop semantic events, no child raw `message_end` leakage, root remains running until root `agent_end`, recovery after a late frame, resume snapshot plus replay convergence. |
| `tests2/core/claude-agent-sdk-skills-subagents.test.ts` | Verified lifecycle subscription emits only admitted registry entries; invalid/duplicate hooks do not create a renderable identity; bounded audit fields stay redacted. |
| `tests2/core/claude-sdk-event-translator.test.ts` | Preserve existing partition, terminal, duplicate, and stream ordering invariants; add a no-regression interleaving fixture. |
| `tests2/integration/session-manager-claude-sdk-subagent-rendering.test.ts` | EventBuffer sequence/reconnect, root queue/status isolation, snapshot/archived reload projection, root-account cost exactly once with per-parent audit, compaction/resume behavior. |
| `tests2/dom/claude-sdk-subagent-card.test.ts` | One parent tool card, no child text in root timeline, live child text/tool updates, terminal error/aborted/unknown badges, collapsed transcript, normalized existing renderer, snapshot replacement without duplicates. |
| `tests2/browser/claude-sdk-subagent-card.spec.ts` | End-to-end fixture: parent Agent card streams child text/tools, root prose remains clean, reload reconstructs same card, resume/reconnect accepts late child frame, and error state remains visible. Assert no extra sidebar session/task card exists. |

Focused commands after implementation:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-sdk-subagent-work.test.ts \
  tests2/core/claude-agent-sdk-session-access.test.ts \
  tests2/core/claude-agent-sdk-bridge.test.ts \
  tests2/integration/session-manager-claude-sdk-subagent-rendering.test.ts \
  tests2/dom/claude-sdk-subagent-card.test.ts
npm run check
npx playwright test tests2/browser/claude-sdk-subagent-card.spec.ts
```
