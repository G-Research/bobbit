# Context compaction

When a session's transcript grows too large for the active model's context
window, Bobbit can fold older turns into a shorter summary — *compaction*.
The transcript keeps moving forward, the user keeps their conversation
history in the UI, and the agent stops bleeding tokens on every turn.

This page documents the **client-facing** surface: the three triggers, the
rich summary card that appears in the transcript, how it round-trips across
navigation and reload, and the test entrypoints. Server-side mechanics
(how the agent subprocess actually compacts, refresh-after-compaction RPC)
live in [internals.md](internals.md).

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

Both paths end with the same `compaction_end` event carrying `reason`,
an optional `result.tokensBefore`, an `aborted` / `success` flag, and
(on failure) an `errorMessage` string. The client maps `reason` to the
payload's `trigger` field in `src/app/remote-agent.ts::_triggerFromEvent`.

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
in the transcript. Pinned by `tests/message-reducer.test.ts` case 12d
and `tests/e2e/ui/compaction-widget.spec.ts`.

### Overflow `tokensBefore` resolution

`remote-agent.ts`'s `compaction_end` handler resolves `tokensBefore` in
priority order — first non-null wins:

1. `event.result.tokensBefore` — agent-emitted on auto / overflow end.
2. `event.tokensBefore` — server-emitted on the manual `/compact` path.
3. `parseOverflowTokenCount(event.errorMessage)` — extracts the leading
   integer from an Anthropic-shaped error via `/(\d{4,})\s*tokens\s*>/i`.
4. `this._lastKnownContextTokens` — last-seen live count, kept current
   as the in-progress payload is built.

This means `reductionPct` now resolves for overflow as well, where v1
left it uniformly `null`. Pinned by `tests/compaction-types.test.ts`
and reducer case 12e.

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
card (id `c_<startedAtMs>_<rand6>`) dedup against each other:

- **Live path.** While `compact_active` is on screen, the splice drops
  the most-recent sidecar row — it represents the same compaction
  surfaced live.
- **Reload path.** No `compact_active` exists; the splice prepends the
  sidecar's rich rows directly. The renderer reads `payload.compactionId`
  and mounts the pre-compaction history affordance.

Full mechanics, schema, and the REST endpoint that surfaces the
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

Invariants are pinned by `tests/message-reducer.test.ts` cases 12, 12b,
12d (in-place lifecycle transition), 12e (overflow trigger +
tokensBefore propagation), and the sidecar-snapshot reducer test that
replaced case 12c.

## Tests

Two new lanes cover compaction end to end.

### Real-LLM e2e

`tests/compaction.spec.ts` runs under `tests/playwright-e2e.config.ts`,
which spawns an isolated gateway on **port 3097** with
`BOBBIT_DIR=.e2e-real-bobbit` so it cannot collide with the dev
server's state. The test:

1. Creates a project + session against the isolated gateway.
2. Knocks down the model's `contextWindow` via `models.json` so a few
   prompts are enough to fill it (cheap and deterministic — does not
   depend on the model's real window).
3. Drives `/compact` from the prompt box.
4. Asserts the rich card renders (via the `data-testid` hook above) with
   no console errors and no error toast.
5. Navigates to a second session and back — card still there.
6. Reloads the page — card still there, materialised via the reload-path
   upgrade described above.

Run it with:

```bash
npm run test:e2e:real
```

This script (`package.json`) is separate from `npm run test:e2e`, which
uses the root `playwright-e2e.config.ts`. The real-LLM lane needs an API
key, so it is opt-in rather than part of the default e2e run.

### Manual-integration pressure test

`tests/manual-integration/compaction-pressure.spec.ts` exercises the
**real auto-compaction** path with real agents and Docker. It pushes a
session near the actual context limit, waits for the agent subprocess to
fire `auto_compaction_start` on its own, asserts the card renders with
`data-test="trigger"` reading `auto`, then sends one more prompt and
checks the agent keeps working post-compact. Runtime is roughly the same
as the rest of the manual suite (~5 min).

Run it with:

```bash
npm run test:manual
```

## Files

| Concern | File |
| --- | --- |
| Payload type + envelope builder | `src/app/compaction-types.ts` |
| Server-side persistence + snapshot splice | `src/server/agent/compaction-sidecar.ts` — see [compaction-history.md](compaction-history.md) |
| Live emission (manual / auto / overflow) | `src/app/remote-agent.ts` — `compaction_start` / `compaction_end` handlers, `_triggerFromEvent`, `_lastKnownContextTokens` |
| Server-side manual broadcast | `src/server/ws/handler.ts` — emits `reason: "manual"` on the manual `/compact` path |
| Reducer (in-progress, result, snapshot dedup, reload upgrade) | `src/app/message-reducer.ts` — `compaction-placeholder`, `compaction-result`, and `snapshot` cases |
| Renderer (three states + adjacent layout + overflow pill) | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` |
| Renderer registration | `src/ui/tools/index.ts` — `__compaction_summary` |
| Helper unit tests | `tests/compaction-types.test.ts` — `parseOverflowTokenCount`, in-progress builder, stable id |
| Reducer unit tests | `tests/message-reducer.test.ts` — cases 12, 12b, 12c, 12d, 12e |
| Browser E2E (renderer lifecycle, file:// harness) | `tests/e2e/ui/compaction-widget.spec.ts`, `tests/fixtures/compaction-widget.html` |
| Compact-cost regression | `tests/e2e/compact-cost-ws.spec.ts`, `tests/e2e/ui/compact-cost.spec.ts`, `tests/context-cost-stats.spec.ts` |
| Real-LLM e2e | `tests/compaction.spec.ts`, `tests/playwright-e2e.config.ts` |
| Manual-integration pressure test | `tests/manual-integration/compaction-pressure.spec.ts` |
| Full design rationale | `docs/design/compaction-e2e-rich-summary.md` |
