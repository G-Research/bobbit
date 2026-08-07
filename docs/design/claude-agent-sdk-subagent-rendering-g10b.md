# G10b — Embedded Claude Agent SDK subagent rendering

## Decision

Render an SDK child **inside the root `Agent` tool card that created it**. An
SDK child is not a Bobbit session, task, team member, sidebar item, or second
chat pane. Existing transcript ownership, message ordering, `ToolMessage`, and
`DelegateRenderer` composition remain the UI system; G10b adds only a
parent-keyed nested-work projection to that system.

The authoritative parent join is `parent_tool_use_id`:

```text
root assistant tool call { id: "agent-use-1", name: "Agent" }
                         │
                         ├─ child SDK rows/events { parent_tool_use_id: "agent-use-1" }
                         ├─ child tool lifecycle { parentToolUseId: "agent-use-1" }
                         └─ admitted SubagentStart/Stop { agentId/type, parentToolUseId: "agent-use-1" }
```

`SubagentStart` and `SubagentStop` at the pinned SDK version identify an
`agent_id` and `agent_type`, but do not carry a parent tool-use id. The
admission registry is therefore the sole Start/Stop-to-parent join. A child
row/event must have a non-empty `parent_tool_use_id` to be renderable; neither
`parent_agent_id`, child prose, a tool name, arrival order, nor an Agent call
that happens to be most recent is a fallback join.

Forwarded child frames remain partitioned by `parent_tool_use_id`, as they are
in `claude-sdk-event-translator.ts`. No child text, tool result, update, or
terminal event enters root assistant prose.

## Scope and non-goals

G10b owns rendering projection and lifecycle correlation only. It does not add
search/indexing behavior, accounting behavior, an account/breakdown, or a
second transcript store. G8 remains the owner of cost/accounting semantics.

Usage, token, and cost fields already present on SDK source rows or forwarded
events are opaque, unmodified audit metadata. The projection preserves them on
the source row/event that supplied them. Replay may suppress a duplicate
rendered row by its stable source identity, but it must not sum, normalize,
move, synthesize, or otherwise account for usage/cost.

## Alternatives considered

### Option A (chosen): server semantic embedded-work projection

The bridge sends partitioned translated child rows and verified policy lifecycle
records to `claude-sdk-subagent-work.ts`. Its assembler emits
`claude_sdk_subagent_work` frames; `SessionManager`/`EventBuffer` sequence and
snapshot those frames without admitting them to root lifecycle state. The
client mirror applies frames to `subagentWorkByParent` before root reduction,
and the existing parent `DelegateRenderer` branch renders the exact-keyed work.

### Option B (rejected): minimal client-side projection of raw events

The existing translator already stamps child events with `parentToolUseId`, and
the bridge/EventBuffer already forward and replay ordinary translated events
with server sequence numbers. This lighter composition would leave those raw
partitioned events unchanged and have `remote-agent.ts` partition/project them
before `message-reducer.ts`, reusing the existing root event path.

The baseline is protected by
`tests2/core/claude-sdk-event-translator.test.ts` (partitioning, duplicate
fingerprints, child-local terminal drain),
`tests2/core/claude-agent-sdk-bridge.test.ts` (event routing and root
`agent_end`), `tests2/core/claude-agent-sdk-skills-subagents.test.ts`
(admission registry), and
`tests2/core/claude-agent-sdk-session-access.test.ts` (sanitized SDK access).

| Option | Data/control flow and files | Concrete failure modes | Protecting test seams |
| --- | --- | --- | --- |
| A — selected | `claude-sdk-subagent-work.ts` assembles translated partitions plus policy lifecycle into semantic frames; `claude-agent-sdk-bridge.ts`, `session-manager.ts`, and EventBuffer carry them; session-access supplies recovery; `src/app/claude-sdk-subagent-work.ts`, `remote-agent.ts`, and the existing renderer consume parent-keyed work. | A missing/late parent, replay, reload, and root abort are handled where the authoritative parent, lifecycle, event sequence, and snapshot boundaries exist; only malformed/unknown data remains bounded diagnostic work. | New core assembler, bridge, policy, session-access, integration SessionManager/EventBuffer, DOM card, and browser reload/resume tests in the focused plan; the four baseline tests above protect the reused seams. |
| B — rejected | `claude-sdk-event-translator.ts` and the existing bridge continue raw forwarding; only `remote-agent.ts` adds a client projection before `message-reducer.ts`, with existing raw EventBuffer replay. | `SubagentStart`/`SubagentStop` are only in the server policy registry, so lifecycle phase still requires a server-to-client lifecycle event. Reload/archive still require server `listSubagents`/`getSubagentMessages` recovery and snapshot handling. Client-only isolation leaves `SessionManager.handleAgentLifecycle` and snapshot construction able to treat child terminals/rows as root state. | The four baseline tests prove raw forwarding, not lifecycle publication, conservative recovery, snapshot reconstruction, or server root isolation; those gaps require the same new server/integration seams as A. |

Option B therefore saves neither the lifecycle wire contract nor the server
recovery and root-boundary work, while splitting the authoritative projection
across client and server. Option A is the smallest robust option: one semantic
server projection at the lifecycle/snapshot boundary plus a narrow client
mirror. A standalone subagent UI is excluded by the goal, not an alternative
under consideration.

### Defect-surface inventory

| New surface | Failure prevented / reason it exists |
| --- | --- |
| Server `claude-sdk-subagent-work.ts` projection/assembler | Prevents raw child rows, tools, and terminals from crossing root lifecycle and transcript boundaries while preserving exact-parent ordering and replay identity. |
| Client `claude-sdk-subagent-work.ts` mirror | Prevents semantic-frame/recovery/replay application from being duplicated in `RemoteAgent` or entering the root message reducer. |
| `claude_sdk_subagent_work` event type | Prevents client receipt of indistinguishable raw child events that can leak into root prose or settle root state. |
| Policy `subscribe` API | Prevents uncorrelated Start/Stop hooks from losing their admitted registry parent association or leaving live work permanently running. |
| `readSdkSubagents` wrapper | Prevents direct transcript parsing or treating an agent-id list as a parent/lifecycle mapping during recovery. |
| `readSdkSubagentMessages` wrapper | Prevents unsanitized, unbounded, or wrong-directory SDK history access and makes exact-parent recovery testable. |
| Snapshot envelope `subagentWork` field | Prevents reload/archive/compaction from either losing child work or promoting it into root `messages`. |
| Narrow `DelegateRenderer` branch | Prevents a second standalone subagent UI or rendering approved native `Agent` work through an incompatible generic card. |
| Parent-keyed `subagentWorkByParent` client state | Prevents interleaved/late children from attaching to the latest parent or reordering root transcript state. |

## Existing seams

| Existing seam | G10b responsibility |
| --- | --- |
| `claude-sdk-event-translator.ts::translateClaudeSdkEvent` | Retain structural partitioning, local tool/result ordering, child-local terminal drain, and duplicate fingerprints. Add no root lifecycle behavior for child partitions. |
| `claude-agent-sdk-tool-surface.ts::buildClaudeSdkSubagentPolicy` | Publish only verified admitted Start/Stop registry lifecycle records. Hooks never create a Bobbit child session. |
| `claude-agent-sdk-bridge.ts` | Divert translated child events into the embedded-work stream; emit root events through the existing path. |
| `claude-agent-sdk-history-adapter.ts` | Keep adapting official SDK history into existing Pi-shaped rows, retaining SDK UUID and parent annotations. |
| `session-manager.ts` / EventBuffer | Carry semantic embedded-work events and snapshot data without treating them as root completion or root transcript rows. |
| `remote-agent.ts` / `message-reducer.ts` | Keep root rows in the existing message reducer; maintain parent-keyed nested work outside the root list. |
| `MessageList`, `Messages`, `StreamingMessageContainer`, `DelegateRenderer` | Render the projected work through the existing parent tool-card path; no standalone subagent UI. |

## Data contract and ownership

Add `src/server/agent/claude-sdk-subagent-work.ts` as a pure projection and
assembler module. Its input is normalized SDK rows/events plus verified policy
lifecycle records; it has no SessionStore, CostTracker, search, or UI
responsibility.

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
  /** Ordered, child-only source rows; usage/cost fields remain on these rows. */
  readonly messages: readonly ClaudeAgentSdkHistoryMessage[];
  /** Child tools still open in this exact parent partition. */
  readonly pendingToolCallIds: readonly string[];
  readonly diagnostic?: "unknown-parent" | "recovery-unavailable" | "recovery-mismatch";
}

export interface ClaudeSdkEmbeddedWorkEvent {
  readonly type: "claude_sdk_subagent_work";
  readonly parentToolUseId: string;
  readonly kind: "start" | "message" | "tool_start" | "tool_end" | "stop" | "terminal" | "recovered";
  readonly identity?: ClaudeSdkSubagentIdentity;
  /** Original normalized source row, including opaque usage/cost metadata. */
  readonly message?: ClaudeAgentSdkHistoryMessage;
  readonly toolEvent?: Record<string, unknown>;
  readonly terminal?: { phase: ClaudeSdkSubagentPhase; error?: string };
}
```

`parentToolUseId` is bounded and non-empty at every boundary. Unknown or late
partitions are retained only under their exact key until recovery/expiry. They
are never appended to root transcript rows or attached to another Agent card.

`projectClaudeSdkEmbeddedWork(...)` returns
`{ rootMessages, workByParent, diagnostics }`:

1. It recognizes a root native `Agent` call by raw SDK name before display
   normalization and uses that tool call id as the only parent-card key.
2. It places each annotated child row under that exact key and leaves only
   unannotated rows in `rootMessages`.
3. It associates child tool starts/results/ends only within the same key and
   child tool-call id.
4. It uses source UUIDs and child tool-call ids only to make live delivery,
   EventBuffer replay, and a later snapshot converge on one rendered copy.
   This is presentation replay dedupe, not usage/cost dedupe or accounting.
5. It leaves the root `Agent` result as the parent result. A child result never
   replaces it.

The child source rows retain their original `id`, timestamp,
`parentToolUseId`, `parentAgentId`, content, and all opaque SDK metadata. Do
not persist hook transcript paths, prompts, environment, credentials, or other
unbounded hook payloads.

## Server flow

### 1. Verified lifecycle registry

Extend `ClaudeSdkSubagentPolicy` with a subscription interface:

```ts
subscribe(listener: (event: {
  kind: "start" | "stop" | "aborted";
  entry: ClaudeSdkSubagentRegistryEntry;
  at: number;
}) => void): () => void;
```

`onStart` publishes only after atomically inserting an entry that was admitted
by the root `Agent` tool-use id. `onStop` publishes that matching entry before
removing it. `clear`/`dispose` publish one `aborted` event per live entry before
clearing. Existing bounded policy audit logging remains bounded and redacted;
its parent value is the registry's admitted `toolUseId`, never a hook-provided
parent value.

In `ClaudeAgentSdkBridge.startInternal`, subscribe immediately after creating
the query surface and retain the unsubscribe with the bridge generation.
Translate lifecycle records to embedded-work start/stop/aborted frames. Unsubscribe
before disposing the surface. Root failure, stop, replacement, or disposal
marks every still-live child aborted once, so a card cannot remain running
forever.

### 2. Event partition and root isolation

In `ClaudeAgentSdkBridge.consume`:

- run the existing translator and MCP-name canonicalization unchanged;
- route every translated event with `parentToolUseId` to
  `ClaudeSdkSubagentWorkAssembler.ingestLiveEvent`, then emit only its semantic
  `claude_sdk_subagent_work` frame(s);
- send unpartitioned root events through the existing `this.emit(event)` path;
  and
- retain root-only `agent_end` detection.

A child terminal must not ready the bridge, settle the root queue, clear the
root turn, drain prompts/steers, or emit root `agent_end`. The assembler may
annotate an exact partition with registry identity after partitioning; identity
never authorizes a different key.

The translator's existing local ordering stays authoritative:
`message_end(assistant)` precedes its `tool_execution_start`; a matching child
tool result precedes `tool_execution_end`; child error/result drains only that
child partition. G10b does not alter root translator terminal behavior or
fingerprint rules.

### 3. Official SDK recovery

The pinned package is `@anthropic-ai/claude-agent-sdk@0.3.222`. Its
`0.3.222` `sdk.d.ts` declares exactly:

```ts
listSubagents(sessionId, options?: { dir?: string; sessionStore?: SessionStore })
  : Promise<string[]>;

getSubagentMessages(
  sessionId,
  agentId,
  options?: { dir?: string; limit?: number; offset?: number; sessionStore?: SessionStore },
): Promise<SessionMessage[]>;
```

`listSubagents` returns **agent-id strings only**, not lifecycle records and
not parent mappings. `SessionMessage` has `uuid`, `session_id`, `message`,
`parent_tool_use_id`, and `parent_agent_id`; it is the same source shape used
by the existing history adapter. Recovery must not describe or rely on records
that these declarations do not provide.

Extend `ClaudeAgentSdkSessionApi` and its lazy adapter with those exact
function signatures and expose narrow `readSdkSubagents` and
`readSdkSubagentMessages` wrappers. They validate the persisted root SDK UUID,
pass only `{ dir: cwd }`, use the existing `SDK_SESSION_UNAVAILABLE`
sanitization, and are dependency-injected through
`ClaudeAgentSdkSessionAccessDeps`. Never parse SDK transcript files directly.

`ClaudeSdkSubagentWorkAssembler.recover` is deliberately conservative:

1. It starts only for an exact unknown/late `parentToolUseId`, a bounded missing
   lifecycle interval, or an incomplete reload snapshot. It coalesces one
   in-flight attempt per parent key.
2. A live verified registry mapping may supply a known `agentId`; otherwise call
   `listSubagents(rootSessionId, { dir: cwd })`. For each returned bounded id,
   read `getSubagentMessages(rootSessionId, agentId, { dir: cwd })`.
3. Adapt returned messages with `adaptSdkSessionMessages`. Attach recovered rows
   only if their non-empty `parentToolUseId` is exactly the requested parent
   key. A returned id with no matching row, multiple conflicting parent keys,
   malformed data, or a mismatch is diagnostic-only. The id is not a parent
   mapping by itself.
4. A verified registry mapping may enrich the card identity. The recovery APIs
   provide neither lifecycle phase nor completion proof, so recovery never
   infers `completed`, timestamps, or a Stop event from their absence. Known
   live data is preserved and otherwise remains `unknown` or
   `recovery-unavailable`.

Use the same projection for bridge history, archived SDK history, and live
post-websocket frames. `buildVisibleMessageSnapshot` carries an envelope such
as `{ messages, subagentWork }`; it must not pretend embedded rows are root
messages. The EventBuffer stores semantic embedded-work frames with ordinary
server sequence numbers, not a duplicate child transcript or session row.

On bridge resume, hydrate the assembler from the official root snapshot before
forwarding new child traffic. Replay and snapshot converge by source identity.
On compaction, retain represented child work according to normal snapshot
visibility rules and never promote it to root prose. A later root `Agent` call
uses its new tool-use id and therefore a new card key.

### 4. Session lifecycle boundary

`SessionManager.handleAgentLifecycle` ignores
`claude_sdk_subagent_work` for root acceptance fences, latest root message,
root terminal classification, queue/steer draining, session status, and
completed-turn count. It broadcasts the frame through the ordinary event
sequence path. G10b otherwise leaves session ownership, search, and all cost
tracking untouched.

## Client projection and rendering

Add `src/app/claude-sdk-subagent-work.ts`, a pure helper mirroring the server
wire contract. `RemoteAgent` keeps
`subagentWorkByParent: Map<string, ClaudeSdkEmbeddedWork>` as nested state.

- A `claude_sdk_subagent_work` event updates that map and re-renders.
- An older/replayed raw child `message_update`/`message_end` is recognized first
  by `event.parentToolUseId` and routed through the same helper. It never sets
  `streamingMessage`, invokes root proposal parsing, publishes a root host
  message, or dispatches a standalone transcript row.
- A `messages` snapshot is projected before the existing message reducer sees
  it: root rows go to the reducer and child rows become parent work.

`message-reducer.ts` remains the only reducer for ordering root messages. The
nested helper uses `parentToolUseId + source UUID` and
`parentToolUseId + toolCallId` for replay replacement identity. Parent rows
keep their server `_order`; nested rows use source chronology, then server
sequence/insertion tick as a stable tie-breaker. This prevents interleaved
children from reordering root rows.

### Display-only identity normalization

`normalizeClaudeSdkRenderIdentity` maps only an approved native parent:

```text
raw native "Agent" + known embedded work -> "team_delegate" (renderer identity)
raw MCP names                             -> existing canonical normalization
all other names                           -> unchanged
```

It retains `rawToolName: "Agent"` and the original root tool-call id. It does
not alter server permission identities, persisted grants, SDK `allowedTools`,
or policy checks. An ordinary/unknown tool named `Agent` remains on the default
tool renderer.

Extend `DelegateRenderer` with a narrow `ClaudeSdkEmbeddedDelegateDetails`
branch and use existing `ToolMessage`/`renderTool` wrapping. The branch renders
the existing compact delegate header with approved type and phase,
collapsed-by-default child text/thinking, existing nested tool/result
renderers, open tools, and completed/error/aborted/unknown state. It renders
source-row metadata as already available to transcript affordances; it creates
no timer or cost account. It has no session link, child controls, sidebar
presence, task actions, or independent UI state. Existing `team_delegate`
behavior remains unchanged.

`MessageList`, `Messages`, and `StreamingMessageContainer` pass
`subagentWorkByParent.get(toolCall.id)` only to that normalized parent card.
All child prose stays inside that card.

## Failure and ordering rules

| Condition | Required result |
| --- | --- |
| Child starts/messages before the parent card | Buffer by exact parent id; render when the parent arrives; recover after debounce; never attach to the latest tool card. |
| Parent exists but Start is late/missing | Show partitioned live work as `unknown`; recovery may supply rows and an already verified mapping may supply identity. |
| Unknown parent remains unresolved | Keep a bounded diagnostic/audit entry and suppress its prose from root; expire only after root terminal plus the recovery window. |
| Child error/result | Drain only that child work; retain its text/tools and show error/aborted state while root continues. |
| Root error/abort/stop/replacement | Mark each nonterminal verified child aborted once. |
| Duplicate live/replay/snapshot source | Render one source copy per partition/identity; preserve the untouched metadata on that copy. |
| Reload/archived view | Rebuild cards from official root history plus conservative recovery; never depend on browser-only state. |
| Resume/compaction | Hydrate before replay, preserve parent keys, and never emit child rows as new root assistant rows. |
| Recovery API unavailable/malformed | Preserve received live data, show bounded unknown state, audit a sanitized reason, and do not fail the root session. |

## Implementation sequence

1. Add the server projection/assembler and exact SDK access wrappers with test
   fakes for the pinned declarations.
2. Publish admitted policy lifecycle records, subscribe in the bridge, and route
   child translator events through the assembler.
3. Thread embedded frames and snapshot envelope through SessionManager and
   EventBuffer while preserving root lifecycle ownership.
4. Add the client nested reducer/projection before ordinary RemoteAgent message
   handling, while retaining message-reducer root ownership.
5. Add display-only Agent-to-delegate normalization and the narrow existing
   renderer branch. Do not add a session/task/sidebar UI.

## Focused test plan

Register each new test in `tests2/tests-map.json`.

| Tier/file | Coverage |
| --- | --- |
| `tests2/core/claude-sdk-subagent-work.test.ts` | Root plus two interleaved children, partition-first attachment, child tool ordering, child-local error drain, replay/snapshot dedupe, late/unknown parent, verified Start/Stop join, root stop abort, opaque usage/cost pass-through, and exact recovery acceptance/rejection. |
| `tests2/core/claude-agent-sdk-session-access.test.ts` | Pinned `listSubagents: Promise<string[]>` and `getSubagentMessages: Promise<SessionMessage[]>` shapes, exact `{ dir }` forwarding, sanitization, malformed IDs, and no parent inference from list ids. |
| `tests2/core/claude-agent-sdk-bridge.test.ts` | Lifecycle semantic events, no child raw `message_end` leakage, root still running until root `agent_end`, late-frame recovery, and resume snapshot/replay convergence. |
| `tests2/core/claude-agent-sdk-skills-subagents.test.ts` | Subscription emits only admitted registry records; invalid/duplicate hooks cannot create renderable identity; audit remains bounded/redacted. |
| `tests2/core/claude-sdk-event-translator.test.ts` | Existing partition, duplicate, terminal, and stream-ordering invariants with an interleaving regression fixture. |
| `tests2/integration/session-manager-claude-sdk-subagent-rendering.test.ts` | EventBuffer sequence/reconnect, root queue/status isolation, archived/reload projection, compaction, and resume; no G10b accounting or search assertion. |
| `tests2/dom/claude-sdk-subagent-card.test.ts` | One parent tool card, no child text in root timeline, live child text/tool updates, terminal badges, collapsed transcript, existing-renderer normalization, and snapshot replacement without duplicates. |
| `tests2/browser/claude-sdk-subagent-card.spec.ts` | Parent Agent card streams child text/tools while root prose stays clean; reload/reconnect/resume reconstructs the card and preserves error state; assert no sidebar/session/task card is added. |

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
