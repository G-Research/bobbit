# Context compaction

When a session's transcript grows too large for the active model's context
window, Bobbit can fold older turns into a shorter summary — *compaction*.
The transcript keeps moving forward, the user keeps their conversation
history in the UI, and the agent stops bleeding tokens on every turn.

This page documents both the client surface and the reliable-turn boundary around compaction. Compaction is active turn work: Bobbit continues to accept visible user intent, but it does not call Pi until the appropriate post-compaction release boundary.

## Triggers

Compaction has three entrypoints on the client, distinguished by the
upstream event's `reason` field:

- **Manual** (`reason: "manual"`) — the user types `/compact` in the prompt
  box. The slash command appends a `compact_cmd_*` user message, starts
  the blob squash animation, and RPC-calls the server's `compactRpc`.
  Wired in `src/ui/components/AgentInterface.ts` (`/compact` handler) and
  `src/server/agent/rpc-bridge.ts` (`compactRpc`). The server's WS
  handler stamps `reason: "manual"` on both `compaction_start` and
  `compaction_end` broadcasts so the client distinguishes this path from
  the auto / overflow paths uniformly.
- **Auto** (`reason: "threshold"`) — the agent subprocess decides on its
  own that another turn would blow the context window and emits
  `compaction_start` with `reason: "threshold"`. Maps to `trigger: "auto"`
  on the card.
- **Overflow** (`reason: "overflow"`) — the agent ran a turn anyway and
  the model returned a context-limit error (e.g. Anthropic's
  `prompt is too long: N tokens > M maximum`). The agent auto-compacts to
  recover and emits `reason: "overflow"`. Maps to `trigger: "overflow"` on
  the card, displayed as the `context limit` pill.

All paths end with a `compaction_end` event carrying `reason`, optional result and usage data, abort/failure signals, and `willRetry` when Pi will continue an interrupted overflow turn. The client maps `reason` to the summary card's `trigger` field.

## Reliable-turn fence and release

### Admission stays open; dispatch is fenced

Manual compaction establishes `session.isCompacting` synchronously before calling Pi. Threshold and overflow compaction establish it on Pi's start event. While the fence is active, Bobbit still persists and broadcasts prompt and steer occurrences, but none of these paths may call Pi:

- direct prompt or steer dispatch;
- ordinary queue draining;
- queued-prompt promotion to steer;
- tool-end continuation-steer flushing; or
- retry dispatch.

The fence is checked again at the final dispatch boundary. If Pi nevertheless returns its canonical “compaction is in progress” rejection, Bobbit treats that as proof that no turn started and restores the exact occurrence to the queue. This closes the race without treating an RPC error as ambiguous delivery.

Input affinity depends on the compaction type:

- during **manual** compaction, prompts and steers target the next turn;
- during **threshold** or **overflow** compaction, steers target the continuing turn while prompts target the next turn; and
- when Pi reports `willRetry: true`, only continuation steers may re-enter the interrupted turn. Next-turn work waits for `agent_settled` after the final `agent_end`.

Pi's final `agent_end` is not a fresh-prompt admission boundary. Pi may still perform threshold compaction and queued-continuation processing while its active-run guard remains set; it clears that guard immediately before `agent_settled`. Bobbit therefore completes user-visible terminal bookkeeping at `agent_end` but fences queue draining and idle-time prompt admission until `agent_settled`. A definite no-start RPC rejection also rolls back both the live and persisted optimistic streaming state.

Every occurrence remains in the visible delivery outbox while fenced. See [Reliable prompt and steer delivery](prompt-queue.md) for identity, settlement, and recovery.

### One idempotent finisher

`SessionManager.finishCompactionAndRelease()` is the sole release decision for Pi events and the manual-RPC resolve/reject fallbacks. Each compaction has one `compactionId`; a bounded completed-ID set makes duplicate end signals no-ops.

| Outcome | Release behavior |
| --- | --- |
| Manual success | Clear the fence once. If the session is safely idle, drain next-turn work normally. |
| Threshold/overflow continues, or `willRetry: true` | Clear once and release queued continuation steers in FIFO order. Keep next-turn work parked. |
| Final non-retry `agent_end` | Retarget any remaining continuation rows once with `continuation-ended`; keep next-turn work parked while Pi performs post-run work. |
| `agent_settled` | Clear the active-run admission fence and drain next-turn work. |
| Automatic compaction failure | Clear the compaction epoch but do not inject continuation work into a possibly failed/interrupted turn. The final safe turn boundary owns later release. |
| Stop near compaction end | Record the compaction finish, defer release to Stop/replacement ownership, reconcile the in-flight attempt, and retarget undispatched continuation work. |

No lock spans an RPC acknowledgement. Queue and ledger persistence happens before handoff, and stale lifecycle generations cannot drain after a replacement.

### Recoverable `length` overflow

Pi `0.84.1` treats a recoverable assistant `stopReason: "length"` as context overflow: it removes the truncated assistant tail, compacts, and retries the interrupted input at most once. Bobbit mirrors Pi's canonical history rewrite without disabling live streaming:

1. Bobbit assigns one `assistantStreamId` to the assistant start, reconstructed updates, and terminal event.
2. The first `length` terminal remains provisional while Pi decides whether to recover.
3. On overflow `compaction_end` with `willRetry: true`, the server emits `assistant_stream_invalidated(assistantStreamId)` before releasing continuation work or forwarding retry output.
4. The browser clears the matching streaming row and removes any matching provisional terminal by ID, never by text.
5. Retry output uses a new stream ID. Its final non-retrying `message_end.message` is authoritative.

Post-compaction snapshots come from Pi's rewritten branch, so reload cannot restore the invalidated tail. A second recoverable-length outcome is not retried again; its final terminal/error remains visible. Invalidation changes only the assistant stream, not the accepted user's `intentId` or settlement.

## The rich summary card

Until this feature shipped, the transcript marker for a finished compaction
was a plain assistant text message — `"Context compacted from 12k tokens."`.
That worked but lost the trigger, the verdict, the timestamp, and any
sense of *how much* was actually reclaimed.

The new card replaces that text with a synthetic tool render. Surface:

- Tokens before / tokens after (em-dash when unknown).
- Reduction percentage (omitted when either count is unknown).
- Trigger pill — `manual` or `auto`.
- Success tick or failure cross plus the error string when it failed.
- Local timestamp from the client's `compaction_end`.

### Why a synthetic tool, not a new message role

The card piggybacks on Bobbit's existing tool-renderer machinery. The
synthetic assistant message carries a single `toolCall` block whose `name`
is `__compaction_summary`, plus a paired `toolResult`. Two leading
underscores keeps it off the real-tool registry — the LLM never sees this
"tool", it never appears in any role's tool list, and it does not consume
any token budget (the description-budget test walks `defaults/tools/`
extensions, not UI renderers).

Using `role: "assistant"` with a `toolCall` content block — rather than
inventing a new message role — means every existing reducer rule (ordering,
dedup, snapshot reconciliation) keeps applying uniformly.

### Test hooks

The renderer (`src/ui/tools/renderers/CompactionSummaryRenderer.ts`)
emits these stable selectors so e2e tests do not have to match on text:

| Selector | Purpose |
| --- | --- |
| `[data-testid="compaction-summary-card"]` | Card root. |
| `[data-test="tokens-before"]` | Before-token value. |
| `[data-test="tokens-after"]` | After-token value (or em-dash). |
| `[data-test="reduction-pct"]` | Reduction badge (when known). |
| `[data-test="trigger"]` | Trigger pill — text content is `manual`, `auto`, or `context limit` (overflow). |
| `[data-state]` (on card root) | Lifecycle state — `in-progress`, `complete`, or `error`. Same DOM node carries the card across the entire lifecycle (see *Single-card lifecycle* below). |
| `[data-test="verdict"]` | Tick or cross icon. |

### Payload shape

The payload type and envelope builder live in
`src/app/compaction-types.ts`:

```ts
interface CompactionSummaryPayload {
  schemaVersion: 1;
  trigger: "manual" | "auto" | "overflow";
  state?: "in-progress" | "complete" | "error";  // drives renderer branch;
                                                 // older payloads omit it —
                                                 // renderer falls back to
                                                 // deriving from `success`
  success: boolean;
  timestamp: string;            // ISO-8601
  tokensBefore: number | null;
  tokensAfter: number | null;   // null when the post-compaction snapshot
                                // has not landed yet (see "tokensAfter" below)
  reductionPct: number | null;  // null when either count is null
  error?: string;               // failure detail
}
```

### Single-card lifecycle

The card transitions in place across `in-progress → complete | error`
rather than being torn down and rebuilt. The synthetic assistant message
uses a fixed id, `COMPACTION_ACTIVE_ID = "compact_active"` (exported from
`compaction-types.ts`), and the reducer's `compaction-placeholder` and
`compaction-result` cases both filter out any prior row with that id
before appending. Lit then diffs to the same DOM node, repainting only
the card body — there is never a plaintext `"Compacting context…"` row
in the transcript. Pinned by `tests2/core/message-reducer.test.ts` and `tests2/dom/ui-fixtures/compaction-widget.test.ts`.

### Overflow `tokensBefore` resolution

`remote-agent.ts`'s `compaction_end` handler resolves `tokensBefore` in
priority order — first non-null wins:

1. `event.result.tokensBefore` — agent-emitted on auto / overflow end.
2. `event.tokensBefore` — server-emitted on the manual `/compact` path.
3. `parseOverflowTokenCount(event.errorMessage)` — extracts the leading
   integer from an Anthropic-shaped error via `/(\d{4,})\s*tokens\s*>/i`.
4. `this._lastKnownContextTokens` — last-seen live count, kept current
   as the in-progress payload is built.

This means `reductionPct` resolves for overflow as well. Pinned by `tests2/core/compaction-types.test.ts` and the reducer coverage.

`schemaVersion: 1` is reserved for forward compatibility — bump it if a
future renderer adds fields that older snapshots cannot supply.

### Why `tokensAfter` is often `null`

The server emits `compaction_end` *before* it broadcasts the
post-compaction state refresh, and there is no post-compaction usage count
on the `compaction_end` frame itself. The client samples its best-known
context-token count at the moment it applies `compaction-result`. If the
refresh has not landed yet, `tokensAfter` stays `null` and the card shows
`after —` with no reduction badge. The user can still see the new context
fill on the usage bar a moment later. A follow-up amend-action could
back-fill the field, but v1 accepts the null and keeps the reducer simple.

## Cost display after compaction

Compaction changes the visible transcript, not the cumulative session spend.
After a compacted snapshot lands, the remaining assistant messages may carry
only the post-compaction visible usage. Bobbit therefore treats persisted
`CostTracker` data as the authoritative cost display source when present.

`SessionManager.refreshAfterCompaction()` broadcasts the cumulative
`cost_update` before the compacted `messages` snapshot, then sends a `state`
frame with `serverCost` merged in. This ordering primes the client before the
reduced transcript replaces the old one, so the footer and context popover do
not fall back to a lower visible-message sum.

Full source-of-truth, hydration, and regression-test details live in
[session-cost.md](session-cost.md).

## Round-tripping across navigation and reload

Compaction events are persisted server-side in a per-session sidecar
(`<stateDir>/compaction-sidecar/<sessionId>.jsonl`), and every snapshot
the server broadcasts is spliced with synthetic `__compaction_summary`
rows reconstructed from that sidecar. The card therefore survives both
navigate-away and full page reload — the reducer just sees the same
rich row it would have seen live.

The live in-flight card (id `compact_active`) and the persisted sidecar
card (id `c_<startedAtMs>_<rand6>`) are two synthetics for the same
compaction. The server mints one `compactionId` at `compaction_start`
and shares it across the sidecar entry, the broadcast `compaction_end`
event, and — via `remote-agent.ts` — the live card's payload. Because
both cards now carry the same `compactionId`, they dedup cleanly and the
pre-compaction-history affordance appears in either case:

- **Live path.** The live `compact_active` card carries `compactionId`,
  so the renderer mounts the pre-compaction history affordance
  immediately — no reload needed. The reducer drops the server's spliced
  sidecar synthetic (and its paired `toolResult`) for the same
  `compactionId`, so the live card wins and a single card stays on
  screen. (On the `get_messages` snapshot path the server-side splice
  also drops the most-recent sidecar row when the snapshot already
  contains the live card.)
- **Reload path.** No `compact_active` exists; the splice prepends the
  sidecar's rich rows directly, the reducer dedup set is empty, and the
  renderer reads `payload.compactionId` to mount the affordance.

Full mechanics — the shared-`compactionId` flow, the reducer dedup, and
the count-probe retry that covers the manual `/compact` sidecar-write
race — plus schema and the REST endpoint that surfaces the
pre-compaction transcript live in
[docs/compaction-history.md](compaction-history.md).

A narrow legacy-fallback path remains in `src/app/message-reducer.ts`
(`isLegacyTextCompaction`) for snapshots that pre-date the sidecar and
carry only the agent's plain-text `"Context compacted"` row — the
reducer drops that row in favour of any rich synthetic at the same
position. The richer in-place upgrade helpers
(`upgradeServerCompactionMarker`, `isServerCompactionTextMarker`) were
removed when the sidecar landed; the sidecar splice supplies a real
structured row instead of trying to reconstruct one from text.

Reducer invariants are pinned in `tests2/core/message-reducer.test.ts` and `message-reducer-dedup.test.ts`, including in-place lifecycle transition, overflow payload propagation, and live-versus-sidecar deduplication.

## Tests

Deterministic CI coverage uses named runtime barriers rather than timing sleeps:

- `tests2/core/reliable-compaction-release.test.ts` pins admission fencing and the single release owner across manual, threshold, overflow, failure, and Stop outcomes.
- `tests2/core/pi-installed-contract.test.ts` pins Pi event order, `willRetry`, direct-prompt rejection during compaction, recoverable-length tail removal, and the one-retry cap.
- `tests2/core/assistant-stream-session-broadcast.test.ts` pins invalidation-before-release ordering and one invalidation for the first recoverable tail.
- `tests2/integration/reliable-intent-recovery.test.ts` exercises held compaction boundaries and visible outbox continuity through failure and recovery.
- `tests2/browser/journeys/reliable-agent-turns.journey.spec.ts` drives manual, threshold, overflow, Stop, reload, reconnect, and second-tab stories through the visible composer.
- `tests2/dom/ui-fixtures/compaction-widget.test.ts`, `tests2/core/compaction-types.test.ts`, and `tests2/browser/e2e/pre-compaction-history.spec.ts` retain summary-card, payload, sidecar, affordance, and reload coverage.
- `tests/manual-integration/reliable-agent-context-pressure.spec.ts` is the opt-in real Pi/real-model pressure smoke documented in [Pi runtime compatibility](pi-runtime-compatibility.md#real-model-context-pressure-smoke).

## Files

| Concern | File |
| --- | --- |
| Payload type + envelope builder | `src/app/compaction-types.ts` |
| Server-side persistence + snapshot splice | `src/server/agent/compaction-sidecar.ts` — see [compaction-history.md](compaction-history.md) |
| Live emission (manual / auto / overflow) | `src/app/remote-agent.ts` — `compaction_start` / `compaction_end` handlers, `_triggerFromEvent`, `_lastKnownContextTokens` |
| Server-side manual broadcast | `src/server/ws/handler.ts` — emits `reason: "manual"` on the manual `/compact` path |
| Reducer (in-progress, result, snapshot dedup, reload upgrade, live-vs-persisted `compactionId` dedup) | `src/app/message-reducer.ts` — `compaction-placeholder`, `compaction-result`, and `snapshot` cases |
| Live card carries server `compactionId`; pre-compaction affordance + count-probe retry | `src/app/remote-agent.ts`, `src/ui/components/PreCompactionHistory.ts` |
| Renderer (three states + adjacent layout + overflow pill) | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` |
| Renderer registration | `src/ui/tools/index.ts` — `__compaction_summary` |
| Helper unit tests | `tests2/core/compaction-types.test.ts` |
| Reducer unit tests | `tests2/core/message-reducer.test.ts`, `message-reducer-dedup.test.ts` |
| Renderer lifecycle | `tests2/dom/ui-fixtures/compaction-widget.test.ts` |
| Live sidecar/affordance browser E2E | `tests2/browser/e2e/pre-compaction-history.spec.ts` |
| Compact-cost regressions | `tests2/integration/compact-cost-ws.test.ts`, `tests2/dom/context-cost-stats.test.ts` |
| Reliable-turn compaction lifecycle | `tests2/core/reliable-compaction-release.test.ts`, `tests2/integration/reliable-intent-recovery.test.ts`, `tests2/browser/journeys/reliable-agent-turns.journey.spec.ts` |
| Mock agent compaction event emission | `tests/e2e/mock-agent-core.mjs` |
| Full design rationale | `docs/design/compaction-e2e-rich-summary.md` |
