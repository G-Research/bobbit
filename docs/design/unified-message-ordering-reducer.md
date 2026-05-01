# Unified Message Ordering Reducer — Design Doc

Status: design / not yet implemented. Branch `goal/unified-me-c6054622`.
Companion to [`streaming-dedup-reorder.md`](./streaming-dedup-reorder.md), which fixes
**transport-level** dedup; this doc fixes **client-state-level** ordering.

---

## 1. Problem

Messages render out-of-order in the chat history, especially around widget-style
assistant turns (`propose_*`, `ask_user_choices`). Symptoms self-correct on the
next event in some cases and stay wedged until manual reload in others. The
streaming-dedup-reorder fix solved the wire path, but `_state.messages` is
still mutated by **eleven** independent call sites in `src/app/remote-agent.ts`
with no shared ordering key.

## 2. Root cause (one paragraph)

There is no single source of truth for transcript order. Live `event` frames
carry `seq`; everything else (snapshots, `tool_permission_needed`, optimistic
echoes, compaction placeholders, error rows, notifications) does not. The
client compensates with eight overlapping mechanisms — `_deferredAssistantMessage`,
`_liveEventMessages`, `_pendingPermissionCards`, `_compactionSyntheticMessages`,
text-equality optimistic dedup, snapshot-merge stable sort, slice-truncation
on permission inserts, and index-based render keys. Three failure modes:
**(A)** an assistant message that carries a `tool_use` block lands in the
single mutable `_deferredAssistantMessage` slot waiting for a future event to
flush it; a second deferred message silently overwrites the first; **(B)** a
mid-flight `messages` snapshot clears the deferred slot without flushing it,
so the widget vanishes from the transcript with no rendering signal;
**(C)** the snapshot path stable-sorts by `(timestamp, insertionOrder)` while
live ingestion appends — same data, two orderings. `MessageList.buildRenderItems`
then keys by array index (`msg:${i}`) so any reorder cascades DOM recreation
through every row downstream, resetting widget state.

## 3. Wire-format additions (additive)

### 3.1 What gets stamped, where

| Frame | Field added | Source | Where |
|---|---|---|---|
| `{type:"event"}` | `seq`, `ts` (existing) | `EventBuffer.push` | `agent/session-manager.ts::emitSessionEvent` (already lives there) |
| `{type:"tool_permission_needed"}` | `seq`, `ts` | new helper `emitSessionFrame()` that wraps non-event broadcasts through `EventBuffer.pushFrame()` | `agent/session-manager.ts::requestToolPermission` (line ~1909), `ws/handler.ts::262` (replay-on-reconnect) |
| `{type:"messages"}` snapshot | per-message `_order: number` (negative integers, see §3.2) | `getArchivedMessages` / `rpcClient.getMessages` post-processor | `ws/handler.ts:284, 316, 509, 593` |
| `{type:"resume_gap"}` | `lastSeq` (existing) | unchanged | unchanged |

Two new helpers in `src/server/agent/event-buffer.ts`:

```ts
/** Like push() but for non-`event` frames that need a seq for client ordering.
 *  Stamps but does NOT retain in the ring buffer (resume catch-up uses
 *  rebroadcastable events only — permission frames are republished via the
 *  existing handler.ts:262 fallback). */
pushFrame(): { seq: number; ts: number };

/** Floor sentinel reserved for snapshot ordering. All snapshot `_order`
 *  values are strictly less than every live `seq`. */
static readonly SNAPSHOT_ORDER_FLOOR = -1_000_000_000;
```

### 3.2 Snapshot `_order` numbering

**Choice: negative integers, position-derived.** For a snapshot of N messages,
message at index `i` (0-based) gets `_order = -1_000_000_000 + i`. Since live
`seq` starts at `1` and is positive, the invariant **`snapshotOrder < liveSeq`
for every (snapshot, live) pair** holds without coordination.

Rejected alternative `seq * 1000 + index`: requires the server to know the
client's current `_highestSeq`, which it doesn't (and shouldn't — snapshots
are stateless). Negative-floor numbering is purely a function of position.

When the client receives a snapshot it advances no `_highestSeq`. Live events
keep their own positive `seq`. The reducer's sort key `(_order, _insertionTick)`
naturally interleaves snapshot-derived rows before live-derived rows.

### 3.3 Backward compat

| Pairing | Behaviour |
|---|---|
| **Old client + new server** | New `_order` / `seq` fields are ignored (unknown JSON keys are inert). Old client keeps its 8-mechanism logic. No regression. |
| **New client + old server** | Snapshot messages arrive with no `_order`. Reducer derives a synthetic order from array index using the same `SNAPSHOT_ORDER_FLOOR + i` formula client-side (server stamping is purely an optimisation/canonicalisation). `tool_permission_needed` arrives with no `seq`; reducer assigns `Number.MAX_SAFE_INTEGER - tick` sentinel (treated as "tail until proven otherwise") and keys reconciliation off the `(toolName, lastPromptText, timestamp)` triple as a last-resort. |
| **Old `.jsonl` lacking `seq`** | Out of scope (see goal spec). The reducer never reads `.jsonl`; it only consumes the snapshot the server hands it. |

## 4. Reducer module shape

New file: `src/app/message-reducer.ts`. **No imports from `./remote-agent`,
`./state`, `./render`, or anything DOM-touching.** Pure data only.

### 4.1 Augmented Message shape

```ts
export type MessageOrigin = "server" | "optimistic" | "synthetic" | "permission";

export interface OrderedMessage {
  /** All existing AgentMessage fields are preserved verbatim. */
  [k: string]: unknown;
  id?: string;
  role: string;
  timestamp?: number;
  /** Sort primary. Server-stamped (positive seq for live, negative for snapshot)
   *  or sentinel for optimistic/synthetic (see §5). */
  _order: number;
  /** Provenance — drives reconciliation rules (see §6). */
  _origin: MessageOrigin;
  /** Sort secondary. Monotonic counter incremented on every reduce. */
  _insertionTick: number;
}
```

### 4.2 Reducer state

```ts
export interface ReducerState {
  /** Sorted by (_order ASC, _insertionTick ASC). Render trusts verbatim. */
  messages: OrderedMessage[];
  /** Monotonic counter incremented on every reduce that adds an entry. */
  nextTick: number;
  /** Highest live seq we've consumed. Mirrors RemoteAgent._highestSeq for
   *  optimistic-sentinel reconciliation (§5). */
  highestSeq: number;
  /** Streaming preview message — not part of `messages`. Kept separately
   *  so render-time filter can hide it when its id appears in `messages`
   *  (replaces _deferredAssistantMessage). */
  streamingMessageId?: string;
}
```

### 4.3 Action union (covers all 11 mutation sites)

```ts
export type Action =
  | { type: "live-event";          frame: AgentEvent;           seq: number; ts: number }
  | { type: "snapshot";            messages: AnyMessage[]                         }   // server-authoritative
  | { type: "optimistic-prompt";   message: AnyMessage                            }   // tail sentinel
  | { type: "optimistic-steer";    message: AnyMessage                            }   // tail sentinel
  | { type: "permission-needed";   card: PermissionCard;        seq: number; ts: number }
  | { type: "permission-resolved"; messageId: string                              }   // grant or deny
  | { type: "compaction-placeholder"                                              }
  | { type: "compaction-result";   message: AnyMessage; success: boolean          }
  | { type: "system-notification"; message: AnyMessage                            }
  | { type: "error";               message: AnyMessage                            }
  | { type: "deny-permission-filter"; messageId: string                           };  // filter-only twin
```

### 4.4 Signature

```ts
export function reduce(state: ReducerState, action: Action): ReducerState;
```

Pure: no `Date.now()`, no `Math.random()`, no `this`, no DOM. The reducer
takes wall-clock timestamps from the action payload and tick from
`state.nextTick`. Tested via byte-equal fixture comparison.

### 4.5 Sort

After every reduce that touches `messages`, return a new array sorted by:

```ts
(a, b) => a._order - b._order || a._insertionTick - b._insertionTick
```

Stability-by-tick removes any ambiguity for entries that share an order
(two optimistic prompts pre-server-echo, two snapshot rows after a
zero-`seq` legacy server, etc.).

## 5. Per-action semantics

| Action | Effect on `messages` | `_order` source | Reconciliation |
|---|---|---|---|
| `live-event` (assistant message_end) | Append `{...msg, _order: seq, _origin:"server", _insertionTick}` | `seq` from frame | If `id` matches an existing entry → replace in place; else append. Streaming preview cleared by setting `streamingMessageId = msg.id` (rendered hidden). |
| `live-event` (user message_end) | Append, but first try id-match against `_origin:"optimistic"` rows; if no id-match, fall back to text equality (§6). On match: **replace** (keep new `_order`, keep new id, keep optimistic `attachments`/`skillExpansions` if missing on server msg). | `seq` | id ∨ text |
| `live-event` (toolResult) | Append. | `seq` | id |
| `snapshot` | Build new `messages = [...snapshotRows, ...survivingClientRows]` and re-sort. **Server snapshot is authoritative for any id it contains.** Drop client rows whose `id` is in snapshot. Additionally drop live server-origin `toolResult` rows whose `toolCallId` matches a snapshot toolResult, and live server-origin `assistant` rows whose content contains a `toolCall.id` matching a snapshot assistant toolCall — toolResult `message_end` frames often arrive without a string `id`, so id-only equivalence would let an un-id'd live row pass through alongside the snapshot's id'd copy. Drop `_origin:"synthetic"` compaction marker if any snapshot row is `assistant` with text starting `"Context compacted"`. Permission cards survive iff their `id` is not in snapshot **and** no snapshot row's `_order > card._order`. | `_order = -1e9 + i` for snapshot rows; client rows keep theirs | id ∨ text (compaction marker only) |
| `optimistic-prompt` | Append with sentinel `_order = Number.MAX_SAFE_INTEGER - state.nextTick`. | sentinel | replaced by server echo via id-or-text rule |
| `optimistic-steer` | Same as prompt. | sentinel | id-or-text |
| `permission-needed` | Append `{...card, _order: seq, _origin:"permission"}`. **No slice-truncation.** Aborted-turn cleanup (formerly `messages.slice(0, lastUserIdx+1)`) is now a render-time concern: the streaming-message renderer filters tool calls whose result is "aborted-by-permission". | `seq` from frame | id |
| `permission-resolved` | Filter out the row by `id`. (Grant restarts the session; messages snapshot will be reissued by server.) | n/a | id |
| `compaction-placeholder` | Filter any existing `id === "compacting_placeholder"` then append `{role:"assistant", id:"compacting_placeholder", _order: highestSeq + 0.5, _origin:"synthetic"}`. The `+0.5` keeps it just-after the latest live event without colliding with an integer seq. | derived from `highestSeq` | id |
| `compaction-result` | Filter `id === "compacting_placeholder"`, append a new synthetic with `_order = highestSeq + 0.5`. Replaced/dropped on next snapshot if server has its own marker. | derived | id ∨ text-prefix `"Context compacted"` (snapshot path only) |
| `system-notification` | Append with `_order = highestSeq + 0.5 + tickFraction` (so multiple notifications in one tick stay ordered by `_insertionTick`). `_origin:"synthetic"`. | derived | none — synthetics stay client-side |
| `error` | Append with sentinel `_order = highestSeq + 0.5`. `_origin:"synthetic"`. Dismiss is the only mutation. | derived | id |
| `deny-permission-filter` | Filter row by `id`. (Twin of `permission-resolved` — issued from a UI click that doesn't yet have a server round-trip.) | n/a | id |

> **Rationale for `+0.5`:** `seq` is integer-monotonic on the server, so any
> fractional offset in `(integer, integer+1)` is collision-free with both
> live events and snapshot rows (snapshot rows are negative).

## 6. Optimistic message handling

### 6.1 Sentinel scheme

Optimistic prompts and steers use `_order = Number.MAX_SAFE_INTEGER - state.nextTick`.

- **Tail-positioned by construction** — larger than any `seq` we'll ever see
  (server seqs are 32-bit-ish in practice, MAX_SAFE_INTEGER is 2^53−1).
- **Stable order between siblings** — `nextTick` decreases the value
  monotonically, so successive optimistic messages land in insertion order
  (later optimistic ⇒ smaller `_order` ⇒ comes *before* earlier — wait,
  that's wrong). **Corrected:** use `Number.MAX_SAFE_INTEGER - (1e9 - nextTick)`
  — equivalently `Number.MAX_SAFE_INTEGER - 1e9 + nextTick`. Forward-monotonic,
  still strictly larger than any real seq for any reasonable session.

### 6.2 Reconciliation when server echo arrives

On a `live-event` user message_end with text `T` and id `S`:

1. **id match** — find any optimistic row with `id === S`. Replace in place
   (keep new `_order = seq`, copy missing fields from optimistic).
2. **text fallback** — only if optimistic rows have ids matching
   `^optimistic_` (current convention) **and** no other optimistic row has the
   same `id`, find the most recent `_origin:"optimistic"` row whose
   `extractText() === T` and replace.
3. **No match** — append as new server row.

Text-fallback is bounded: at most one optimistic per turn is in flight, and
the search scope is `_origin:"optimistic"` only.

## 7. Render contract

### 7.1 Id-keyed render

`MessageList.buildRenderItems` (currently `src/ui/components/MessageList.ts:64`)
must key by **stable id**, never `msg:${i}`. Rule:

```ts
function keyFor(m: OrderedMessage, group?: string): string {
  if (group) return `${group}:${m.id ?? `synth:${m._origin}:${m._order}:${m._insertionTick}`}`;
  return m.id ?? `synth:${m._origin}:${m._order}:${m._insertionTick}`;
}
```

For the `tool-group` cross-message group, the key is
`group:${firstCall.id ?? synth:...}` so groups remain stable when adjacent
messages are inserted/removed.

### 7.2 No render-time sort

`MessageList` consumes `agent.messages` verbatim. It does not re-sort, dedupe,
or filter on order — those are reducer concerns. The only render-time filter
is **§7.3**.

### 7.3 Streaming-message filter (replaces `_deferredAssistantMessage`)

`AgentInterface` already passes `streamingMessage` and `messages` separately
to children. Add one render-side guard: when `state.streamingMessage?.id ===
m.id` for some `m ∈ messages`, hide that `m` from the message-list output
(the streaming container is already rendering it). The reducer's
`streamingMessageId` is the source of truth for which id is currently
duplicated in the streaming preview.

Result: `_deferredAssistantMessage` and its three call sites disappear. The
"don't show streaming message twice" guarantee is now a one-line filter, not
a stateful slot.

## 8. Deletion list

After this refactor, `grep -rn` over `src/app/` must return **zero hits** for
each of:

- `_deferredAssistantMessage` — currently `remote-agent.ts:52, 682, 869, 1513–1517, 1609, 1622`
- `_liveEventMessages` — currently `remote-agent.ts:71, 582, 606, 685, 892–909, 1660`
- `_pendingPermissionCards` — currently `remote-agent.ts:84, 741, 752, 942–954, 1254`
- `_compactionSyntheticMessages` — currently `remote-agent.ts:80, 560, 916–930, 1775`
- `flushDeferredMessage` — currently `remote-agent.ts:1513, 1532, 1563, 1622`

And these mechanisms collapse:

| # | Mechanism | Current site | Replacement |
|---|---|---|---|
| 1 | Deferred assistant slot | `remote-agent.ts:52, 1609` | reducer + render-time streaming filter |
| 2 | Live-event bucket text-merge | `remote-agent.ts:71, 892` | id-based optimistic reconciliation in reducer |
| 3 | Pending-permission `maxServerTs` cutoff | `remote-agent.ts:942–954` | snapshot `_order` ≥ card `_order` rule |
| 4 | `tool_permission_needed` slice-truncation | `remote-agent.ts:1237–1241` | render-time filter on aborted tool calls |
| 5 | Compaction text-prefix match | `remote-agent.ts:881–890, 916` | id rule + single text fallback in `snapshot` action |
| 6 | Snapshot stable sort by `(timestamp, insertionOrder)` | `remote-agent.ts:962–973` | reducer's `(_order, _insertionTick)` sort |
| 7 | Optimistic text-equality dedup | `remote-agent.ts:1651–1665` | reducer's id-or-text rule, sentinel ordering |
| 8 | `MessageList` index-key `msg:${i}` | `MessageList.ts:117, 122, 169, 173` | id-or-synthetic key from §7.1 |

## 9. `RemoteAgent` glue

`RemoteAgent` keeps **transport** state and becomes a thin dispatcher.

### 9.1 Stays on `RemoteAgent`

- WS lifecycle (`ws`, `_highestSeq`, `_pendingEvents`, `_seqInitialized`,
  `_inResumeFallback`, resume/reconnect logic — see streaming-dedup-reorder.md).
- Subscriptions / event emitter (`subscribe`, `emit`).
- Status (`isStreaming`, `isAborting`, `turnStartTime`, `archivedAt`).
- Server queue mirror (`_serverQueue`).
- Project/preview/cost/preferences/skill-sidecar plumbing.
- Title and goal-setup callbacks.
- Tool-proposal panel detection (`_processedProposalIds`,
  `_checkToolProposals`, `_checkProposals`) — these inspect message content,
  not order, so they're unchanged.

### 9.2 Moves into `ReducerState`

- `_state.messages` → `reducerState.messages`.
- `_state.streamingMessage`'s "is this duplicated in messages" question →
  `reducerState.streamingMessageId` plus render filter.
- The four buckets (`_deferredAssistantMessage`, `_liveEventMessages`,
  `_pendingPermissionCards`, `_compactionSyntheticMessages`) — **deleted**,
  not relocated.

### 9.3 Sketch

```ts
class RemoteAgent {
  private reducerState: ReducerState = initialState();

  private apply(action: Action) {
    this.reducerState = reduce(this.reducerState, action);
    this._state.messages = this.reducerState.messages;        // for legacy readers
    this.emit({ type: "render" });
  }

  private async handleServerMessage(msg: any) {
    switch (msg.type) {
      case "messages":
        this.apply({ type: "snapshot", messages: msg.data?.messages ?? msg.data });
        // …non-message side effects: review pane, proposal scan, reconnect notif
        return;
      case "tool_permission_needed":
        this.apply({ type: "permission-needed", card: buildCard(msg), seq: msg.seq, ts: msg.ts });
        return;
      case "error":
        this.apply({ type: "error", message: buildErrorRow(msg) });
        return;
      case "event":
        // existing seq/ordering gate from streaming-dedup-reorder.md still applies
        this.handleAgentEvent(msg.data, msg.seq, msg.ts);
        return;
      // …state, session_status, queue_update etc. unchanged
    }
  }

  private handleAgentEvent(ev: any, seq: number, ts: number) {
    switch (ev.type) {
      case "message_end":
        this.apply({ type: "live-event", frame: ev, seq, ts });
        // existing proposal scan stays here
        return;
      case "message_update":  /* streaming preview only — no reduce */ return;
      case "compaction_start":
        this.apply({ type: "compaction-placeholder" });
        return;
      case "compaction_end":
        this.apply({ type: "compaction-result", message: buildCompactionRow(ev), success: !!ev.success });
        return;
      // …tool_execution_start/update/end unchanged (no transcript mutation)
    }
  }

  prompt(text: string, /* … */) {
    if (!this._state.isStreaming) {
      this.apply({ type: "optimistic-prompt", message: buildOptimistic(text, /* … */) });
    }
    this.send({ type: "prompt", text });
  }

  steer(message) { this.apply({ type: "optimistic-steer", message: buildOptimistic(...) }); this.send({ type: "steer", text }); }

  denyToolPermission(id, toolName) {
    if (toolName) this.send({ type: "deny_tool_permission", toolName });
    this.apply({ type: "deny-permission-filter", messageId: id });
  }

  reset() { this.reducerState = initialState(); /* … rest of reset */ }
}
```

`handleServerMessage` and `handleAgentEvent` shrink to ~150 lines each (down
from ~600 combined today), and every transcript mutation is one `apply()`.

## 10. Test plan

### 10.1 Unit — `tests/message-reducer.test.ts` (new)

Pure synchronous Node tests. No Playwright, no WS, no DOM. Each scenario is a
sequence of `Action`s applied to the initial state; assertion is byte-equal
on the resulting `messages.map(m => ({ id: m.id, _order: m._order, role: m.role }))`.

| # | Scenario | Action sequence | Expected (id, _order) order |
|---|---|---|---|
| 1 | In-order live | `live(seq=1,id=u1)`, `live(seq=2,id=a1)` | `[u1@1, a1@2]` |
| 2 | Out-of-order live (after seq gate) | `live(seq=2,id=a1)`, `live(seq=1,id=u1)` — gated upstream, but if reducer sees them out-of-order it still sorts | `[u1@1, a1@2]` |
| 3 | Duplicate live | `live(seq=1,id=u1)` ×2 | `[u1@1]` (id-replace, single row) |
| 4 | Snapshot mid-stream replaces by id | `live(seq=1,id=u1)`, `live(seq=2,id=a1)`, `snapshot([{id:u1},{id:a1,content:"updated"}])` | snapshot rows at `[-1e9, -1e9+1]`, content from server |
| 5 | Snapshot + optimistic survivor | `optimistic-prompt(id=opt1,text="hi")`, `snapshot([{id:srv1,role:user,text:"world"}])` | `[srv1@-1e9, opt1@MAXSAFE-…]` — optimistic kept (no id/text match) |
| 6 | Optimistic → echo (id) | `optimistic-prompt(id=opt1)`, `live(seq=1,id=opt1,role=user)` | `[opt1@1]` (replaced, no dup) |
| 7 | Optimistic → echo (text) | `optimistic-prompt(id=opt1,text="hi")`, `live(seq=1,id=srv1,role=user,text="hi")` | `[srv1@1]` |
| 8 | Proposal burst | `live(seq=1,id=a1,toolUse=propose_goal)`, `live(seq=2,id=a2,toolUse=propose_role)`, `live(seq=3,id=tr1,role=toolResult)` | `[a1@1, a2@2, tr1@3]` — both widgets present, no overwrite (kills Mode A) |
| 9 | ask_user_choices envelope routing | `live(seq=1,id=a1,toolUse=ask_user_choices,toolUseId=auc1)`, `live(seq=2,id=u1,role=user,text="[ask_user_choices_response auc1] …")` | both rows present in order; envelope-scan helper finds row 2 by `auc1` |
| 10 | Reconnect with gap | `live(seq=1,id=u1)`, `live(seq=2,id=a1)`, `snapshot([u1,a1,u2,a2])` (live tail follows) , then `live(seq=5,id=a3)` | snapshot block at `[-1e9..-1e9+3]`, `a3@5` after; no dups |
| 11 | Permission insert + resolve | `live(seq=1,id=u1)`, `permission-needed(seq=2,id=p1)`, `permission-resolved(p1)` | `[u1@1]` — no slice-truncation of u1 |
| 12 | Compaction placeholder + server marker | `compaction-placeholder` → row `compacting_placeholder@hi+0.5`; then `snapshot([{id:cs1,role:assistant,text:"Context compacted from 12k tokens."}])` | single compaction row from server, synthetic dropped |

Pass criterion: byte-equal output array of `(id, _order)` pairs.

### 10.2 E2E — extend `tests/e2e/ui/stories-streaming.spec.ts`

| Story | User-visible assertion |
|---|---|
| **ST-DEDUP-02 — Proposal burst** | Mock agent emits two consecutive `propose_*` assistant turns + a toolResult. Both `<proposal-…>` widgets must render in order. Click the first → it submits; click the second → it submits. Neither is unmounted/remounted (assertion: stable `data-msg-key` between the two screenshots). |
| **ST-DEDUP-03 — Mid-burst reconnect** | While the proposal burst is mid-stream, kill the WS. Server resumes via `seq` replay. After reconnect, the widget appears **exactly once** in the transcript (assertion: `page.locator('proposal-goal').count() === 1`). |
| **ST-DEDUP-04 — `ask_user_choices` envelope routing** | Two `ask_user_choices` cards on screen. Click answer on card B; `[ask_user_choices_response <toolUseId-B>]` user message arrives. Card B shows answer; card A unchanged (assertion: `findAskResponseAnswers` matches card B's `toolUseId`). |

### 10.3 Regression guard

- `tests/remote-agent-snapshot-merge.test.ts` — must still pass. Convert
  internally to call the new reducer (the test currently constructs a
  `RemoteAgent` and feeds frames via reflection; rewrite to construct
  `ReducerState` + `Action`s).
- `tests/e2e/ui/stories-streaming.spec.ts::RE-07` (preferences-snapshot
  ordering) — must still pass, no transport change.
- `tests/e2e/ui/stories-streaming.spec.ts::ST-DEDUP-01` — replay-pacing path
  is unchanged.
- Manual: open a session that previously showed the proposal-out-of-order
  symptom; confirm widgets are in order on first paint without reload.

## 11. Risk register

| Risk | Mitigation |
|---|---|
| **RE-07 regression** — preferences snapshot relied on stable-by-timestamp ordering | The reducer preserves the same effective order (snapshot rows in array order, ties broken by `_insertionTick`). Add an explicit RE-07 fixture to the unit suite to lock the contract. |
| **ST-DEDUP-01 regression** — replay pacing | Untouched by this change. The reducer doesn't care whether events arrive paced or burst — it sorts by seq either way. |
| **`tests/remote-agent-snapshot-merge.test.ts`** — current test reaches into private buckets via reflection | Rewrite as reducer test (pure function, no reflection). Keeps the same behavioural assertions: server-snapshot id wins, compaction marker dedup by text, permission cards survive only when not superseded. |
| **Very-old persisted `.jsonl` lacking `seq`** | Server's `getMessages` always assigns `_order = -1e9 + i` from snapshot index, regardless of whether the underlying JSONL had `seq`. Old data is invisible to the reducer; it sees only the snapshot. |
| **Race: snapshot arrival after pending optimistic** | Optimistic rows sit at `_order ≈ MAX_SAFE_INTEGER`, so a snapshot that doesn't contain the optimistic id cannot displace it. The follow-up live echo at `seq = N` then replaces by id (or by text). Worst case: the optimistic row visibly persists for one extra render frame after the snapshot — same as today, no regression. |
| **`__preview_snapshot_v1__` marker interactions** | Reducer doesn't inspect tool-result text. Marker handling stays in `PreviewRenderer.ts` / `truncate-large-content.ts` and is not affected. |
| **Proposal scan double-fire** | `_processedProposalIds` is keyed by block id, not message position; safe across reducer migration. The streaming flag `state.proposalStreamingByTag` is similarly id-keyed (see `proposal-panel-streaming-ux.md`). |
| **AI Gateway / restart-resume reviewer reminder** | Verification harness uses `waitForIdle`/`waitForStreaming`, not transcript ordering. No coupling. |
| **Tool-group cross-message grouping (`MessageList.ts:138`)** breaks when key changes from index to id | The grouping logic walks the array, not keys. Group key becomes `group:${firstCall.id}` — stable across re-renders. Add a unit test for the group with three tool-only assistant turns. |
| **Old client + new server seqs on `tool_permission_needed`** | Old client ignores unknown `seq` field. New behaviour is purely additive. |
| **Backwards compat on snapshot `_order` from old server** | New client computes `_order = SNAPSHOT_ORDER_FLOOR + i` itself when the server didn't stamp it. End-to-end behaviour identical. |

---

## Acceptance pointer

This design satisfies all eight acceptance bullets in the goal spec:

1. Single `reduce()` in `src/app/message-reducer.ts`, `RemoteAgent` shrinks to dispatcher (§4, §9).
2. All eight mechanisms deleted (§8).
3. Server stamps `_order` on snapshot and `seq` on `tool_permission_needed`; old client / old server compat verified (§3).
4. 12 unit tests + 3 E2E stories specified (§10).
5. `npm run check` / `test:unit` / `test:e2e` clean — no breaking type changes; reducer is additive.
6. `docs/internals.md — Snapshot merge invariant` to be rewritten as "Reducer ordering invariant" (out of scope here, called out in implementation task).
7. `docs/design/streaming-dedup-reorder.md §4.5` carve-out for `_liveEventMessages` to be deleted (called out in implementation task).
8. Manual proposal-widget repro fixed (§10.2 ST-DEDUP-02).
