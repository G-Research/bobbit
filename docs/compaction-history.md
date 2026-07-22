# Compaction history persistence

Compaction summary cards survive navigation and page reload, and the user
can expand a card to read the pre-compaction transcript that was rolled
into its summary. This page documents the shipped behaviour. For the
problem statement and design rationale see
[docs/design/persist-compaction-history.md](design/persist-compaction-history.md).
For the live compaction lifecycle (triggers, the rich-summary card, test
hooks) see [docs/compaction.md](compaction.md).

## What the user sees

- **Card survives navigation.** After a session compacts, switching to a
  sibling session and back leaves the compaction-summary card in place.
- **Card survives reload.** A hard page reload re-renders the same card —
  not as a plain `"Context compacted"` text row but as the same rich
  card with trigger pill, before/after counts, reduction percentage,
  timestamp, and verdict.
- **Expandable pre-compaction history.** Each compaction card carries an
  inline affordance — `▾ Show N messages before compaction` — when the
  agent's transcript still has the entries that preceded the summary.
  This appears on the **live card in the same session** (immediately
  after a compaction, no reload required) as well as on the persisted
  card after navigate-away or reload. Clicking expands a dimmed,
  read-only list of those messages above the card. Re-collapse from the
  same chevron. Open/closed state is component-local and does not persist
  across reload (collapsed default).
- **Read-only by design.** Expanded rows are visually dimmed
  (`opacity: 0.65`) and have `pointer-events: none` — text is selectable
  for copy, but there are no retry buttons, permission cards, or
  thinking-block toggles. The agent's context is not affected; those
  entries are abandoned from its perspective.
- **Empty case is silent.** When the agent's `.jsonl` has no orphaned
  entries for the compaction (legacy session, or a `firstKeptEntryId`
  that can't be resolved), the card renders without the affordance — the
  user never sees a broken expand button.

The card itself is the same `__compaction_summary` synthetic tool render
documented in [compaction.md](compaction.md#the-rich-summary-card); the
only new payload field is `compactionId`, which the renderer uses to
mount the pre-compaction-history child component. Both the persisted
(reload-spliced) card and — after this fix — the live `compact_active`
card carry `compactionId`, so the affordance is available in either case
(see *Sharing one `compactionId` across the live and persisted card*
below).

## Server-side compaction sidecar

The pi-coding-agent CLI owns the canonical `.jsonl` transcript. Its
`getMessages()` only returns the active branch (the summary entry plus
the tail from `firstKeptEntryId`), so the post-compaction snapshot has
nothing to anchor a card to. Bobbit therefore persists one metadata row
per compaction in a host-side sidecar — mirroring the
[skill-sidecar pattern](internals.md#skill-chip-rendering--autonomous-activation).

### Storage

- **Path**: `<stateDir>/compaction-sidecar/<sessionId>.jsonl` — host-side,
  so valid for sandboxed sessions whose agent `.jsonl` lives inside the
  container.
- **Format**: one JSON line per compaction event. Append-only.
- **Lifecycle**: created lazily on first append (no empty file for
  sessions that never compact). Initialised at server bootstrap next to
  `initSkillSidecarDir`. Purged by `purgeCompactionSidecar` from the
  same code path that purges the skill sidecar (archive / terminate).
- **Forward-compat**: every record carries `schemaVersion: 1`. Readers
  skip lines whose `schemaVersion` they don't recognise.

Module: `src/server/agent/compaction-sidecar.ts`.

### Record schema (`CompactionSidecarEntry`)

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | Bump if a new field becomes load-bearing. |
| `id` | string | Stable primary key, shape `c_<startedAtMs>_<rand6>`. Used as the REST endpoint's `compactionId` query param. |
| `trigger` | `"manual" \| "auto" \| "overflow"` | Same vocabulary as the live `CompactionSummaryPayload.trigger`. |
| `tokensBefore` | `number \| null` | Pre-compaction usage, when known. |
| `tokensAfter` | `number \| null` | Best-effort post-compaction usage. Usually `null` at end-of-event time — see `compaction.md` "Why `tokensAfter` is often `null`". |
| `durationMs` | number | End minus start, measured server-side. |
| `startedAt` / `endedAt` | ISO-8601 strings | Source of the rendered timestamp. |
| `success` | boolean | False ⇒ `error` is set. |
| `error` | string? | Failure detail; only set on `success: false`. |
| `firstKeptEntryId` | `string \| null` | Pi-coding-agent's first-kept entry id from `CompactionResult`. Drives the pre-compaction slice (see below). May be `null` for legacy entries or hard failures — the legacy fallback covers that case. |

### Append points

For successful manual, automatic, and overflow compactions, Pi's
`compaction_end` event is the authoritative completion boundary.
`SessionManager` appends the sidecar synchronously before
`refreshAfterCompaction`, stamps the shared `compactionId`, and then lets the
refreshed transcript and completion event reach clients. The same ordering
applies to `compaction_end { willRetry: true }`: the compaction has completed,
but the surrounding agent turn will retry. Pi emits no later terminal
`compaction_end` for that operation.

- **Manual `/compact` success** — the WebSocket handler stashes the id before
  calling `compact()`. `SessionManager` uses the successful `compaction_end`
  result to write the row before transcript refresh. The handler writes a
  failure row if the RPC rejects without a successful completion event, and
  retains a success fallback if the event path could not write the row.
- **Auto / overflow** — `SessionManager` stashes the start metadata at
  `compaction_start`, then writes the completion row from `compaction_end`,
  including the successful overflow form with `willRetry: true`. The legacy
  `auto_compaction_end` event name remains accepted as a compatibility input,
  not as the only automatic-compaction completion signal.

Failed rows carry `success: false` and `error`; only successful rows create an
orphan-history boundary for the live card.

## Snapshot splice — making the card survive reload

The reducer-owned message list is unchanged. Instead, every server-side
path that broadcasts a `messages` frame runs the message array through
`mergeCompactionSidecarIntoMessages(sessionId, messages)` after
in-flight splicing and skill-sidecar merging. The function lives in
`src/server/agent/compaction-sidecar.ts` and is called from:

- `case "get_messages"` in `src/server/ws/handler.ts` (the client's
  on-visibility / on-reload snapshot request).
- `refreshAfterCompaction` in
  `src/server/agent/session-manager.ts` (the post-compaction broadcast).

For each sidecar entry, the splice produces the same two-row shape the
live `compaction_end` path builds — an `assistant` message carrying a
single `toolCall` content block named `__compaction_summary`, plus a
matching `toolResult`. The `arguments` payload is a
`CompactionSummaryPayload` with the new `compactionId` field set to the
sidecar `entry.id`. The synthetic message's id is `entry.id` (NOT
`compact_active` — that constant is reserved for the live in-flight
card so single-DOM-identity continuity isn't broken during the same
session).

The reducer's existing `hasCompactionToolCall` recognition handles these
rows with no new reducer action.

### Sharing one `compactionId` across the live and persisted card

The live in-flight `compact_active` card and the persisted sidecar card
are two synthetics for the *same* compaction, built on different code
paths (client-emitted vs server-spliced) and under different ids. To let
the affordance appear in the live session — and to keep a single card on
screen — both must agree on one `compactionId`:

1. **Server generates the id once, at `compaction_start`.**
   - **Auto / overflow** — `SessionManager` mints `makeCompactionId()` at
     `(auto_)compaction_start` and stashes it on
     `session._pendingCompactionStart`. The same id becomes the sidecar
     `entry.id` and (on success only) is stamped onto the broadcast
     `(auto_)compaction_end` event as `event.compactionId`.
   - **Manual `/compact`** — `src/server/ws/handler.ts` mints the id and
     stashes it on `session._manualCompactionId` *before* awaiting the
     `compact()` RPC. `SessionManager`'s manual `compaction_end` branch
     reads it back and stamps `event.compactionId` (skipped when the
     compaction aborted — a failed compaction has no orphan boundary).
2. **Client carries the id onto the live card.** `remote-agent.ts`'s
   `compaction_end` handler copies `event.compactionId` into the
   `CompactionSummaryPayload`, so the live `compact_active` card mounts
   `<bobbit-pre-compaction-history>` immediately. When the card's
   minimum-visible-duration floor defers the in-place transition into a
   `setTimeout`, the handler also emits a generic `render` event so the
   card repaints from in-progress → complete (no agent event would
   otherwise drive that repaint, leaving the affordance unmounted).
3. **Reducer dedups by `compactionId`.** `refreshAfterCompaction`
   broadcasts the post-compaction snapshot with the persisted sidecar
   synthetic spliced in. Because the live `compact_active` card already
   hosts the affordance, the reducer
   (`src/app/message-reducer.ts`) drops the snapshot's persisted
   assistant card *and* its paired `toolResult` whenever their
   `compactionId` matches the live card's — in both the `snapshot` case
   and the `compaction-result` in-place transition case. The live card
   wins, so one DOM node carries the compaction across its lifecycle
   (avoids a flicker / duplicate). On reload there is no live
   `compact_active` in reducer state, so this dedup set is empty and the
   persisted synthetic survives untouched — reload persistence is
   preserved.

### Idempotency and live/persisted dedup

`mergeCompactionSidecarIntoMessages` is idempotent and dedups against
live rows:

- Sidecar entries already present in the input by `toolCallId`
  (`compaction-summary:<id>`) or by message `id` are skipped.
- If the input contains the live in-flight slot
  (`compaction-summary:compact_active`), the most-recent sidecar entry
  is dropped from the splice — it represents the same compaction that
  is currently surfaced live; rendering both would stack two cards.
  (This server-side guard fires on the `get_messages` path, where the
  client sends up a snapshot that already contains its live card; the
  reducer-side `compactionId` dedup described above covers the
  `refreshAfterCompaction` broadcast, where the server array has no
  `compact_active`.)
- Subsequent compactions for the same session naturally come
  oldest-first (sort by `endedAt`).

The splice is prepended to the message array. Snapshot rows already
carry negative `_order` values
(see [unified-message-ordering-reducer](design/unified-message-ordering-reducer.md)),
so the prepend produces the correct visual position once the reducer
stamps `_order` on the merged frame.

## Pre-compaction history — `GET …/transcript/before-compaction`

The full `.jsonl` is still on disk; only the agent's `getMessages()`
abandons the orphaned entries. A dedicated REST route slices the file
at the compaction boundary and returns the orphaned slice, paginated.

See [docs/rest-api.md](rest-api.md) for the canonical endpoint row.
Query params: `compactionId` (required, sidecar entry id), `cursor`
(from previous response's `nextCursor`), `limit` (1..200, default 50).
Response envelope:

```json
{
  "total": 47,
  "returned": 50,
  "nextCursor": 50,
  "messages": [
    { "index": 0, "role": "user", "ts": "2026-05-12T14:00:00Z", "text": "…" }
  ]
}
```

`nextCursor` is `null` when no more pages are available.

Authorization matches the sibling `GET /api/sessions/:id/transcript`
route and `read_session`: after normal bearer/session authentication,
any authenticated caller on the same gateway that can reach the target
session may read pre-compaction history, even when caller and target
`projectId` values differ. Reads still use the target session's
sandbox-aware transcript file context.

Route-specific structured errors are `session_not_found` (404),
`transcript_unavailable` (404), `compaction_not_found` (404),
`invalid_params` (400), and `internal_error` (500).

Implementation: `readOrphanedBeforeCompaction` in
`src/server/agent/transcript-reader.ts`. Branch-split rules:

- **Primary**: when the sidecar's `firstKeptEntryId` is non-null, the
  reader walks the parsed `.jsonl` and locates the entry whose `id`
  matches. Everything strictly before that index is orphaned.
- **Legacy fallback**: when `firstKeptEntryId` is `null` (legacy sidecar
  rows written before the field was plumbed through, or hard failures),
  the reader scans forward for the first entry with
  `type: "compaction"` — pi-coding-agent appends one of those to mark
  the boundary in-line. The orphaned slice is everything before that
  index.
- **Neither resolves**: the envelope returns `total: 0`. The card just
  hides the expand affordance — no fabricated history.

Only `type: "message"` entries from the orphaned slice are surfaced.
The compaction marker entry itself, and any non-message entries that
might appear in pi-coding-agent's JSONL between user/assistant turns,
are walked past and skipped in the response.

## Sandbox interaction

The sidecar is **always host-side**. It lives under the gateway's
`<stateDir>` and is written / read by the gateway process — no
sandbox-FS plumbing is required. This is the same pattern the
skill-sidecar uses, and works for both single-repo and sandboxed
sessions.

The transcript file itself may be inside the sandbox container. The
endpoint reads it via the existing `sessionFileRead` helper in
`src/server/agent/session-fs.ts`, which dispatches host vs
`docker exec cat` based on `SessionFsContext.sandboxed`. The
dead-container recovery path (`containerPathToHost`) covers sessions
whose container has been GC'd.

## Client UI

`<bobbit-pre-compaction-history>` (`src/ui/components/PreCompactionHistory.ts`)
is mounted by `CompactionSummaryRenderer` at the top of the card body
whenever `payload.compactionId` is present. As of the live-affordance
fix, **both** the persisted sidecar card and the live `compact_active`
card carry `compactionId` (see *Sharing one `compactionId`* above), so
the affordance is available immediately after a compaction in the same
session as well as after a reload.

Lifecycle:

1. On first viewport hit (via `IntersectionObserver`), fetch
   `?limit=1` to learn `total`. A 500ms safety-net timer re-drives the
   fetch if the observer never fires (zero-height parent, animated
   reveal, headless quirks).
2. If `total === 0`, render nothing.
3. Otherwise render the chevron-led button `Show N messages before
   compaction`.
4. Click → fetch the first page (`limit=50`) and render the rows
   dimmed and read-only. When `nextCursor` is non-null, a `Load N more`
   button at the bottom drives further pages.
5. The same chevron collapses the section.

#### Count-probe retry — bounded resilience

The normal successful path does not race the manual `compact()` RPC:
`SessionManager` writes the sidecar while handling `compaction_end`, before it
refreshes the transcript or forwards completion to the live card. This also
holds for automatic and overflow completions, including
`compaction_end { willRetry: true }`.

The widget still treats a transient `404` (`compaction_not_found`) or network /
transport error as retryable. This protects the UI from short propagation
delays, compatibility fallbacks, and temporarily unavailable state without
permanently caching `total = 0`:

- The component keeps `_total === null` (its no-render "loading" state)
  while retries are pending — it never flashes the affordance and never
  caches an empty result mid-race.
- Backoff schedule is `min(2000, 400 × attempt)` ms over up to
  `MAX_COUNT_RETRIES` (8) attempts — roughly a 12s budget, comfortably
  longer than the RPC-response propagation gap.
- An in-flight guard (`_inFlight`) plus the single pending-retry timer
  prevent the IntersectionObserver hit, the 500ms safety-net timer, and
  the retry timer from overlapping.
- A genuinely-missing id (legacy session, purged sidecar) exhausts the
  budget and *then* collapses to `total = 0` / no affordance — the
  widget never spins forever, and never silently renders empty while
  history is still being written.

Non-404 HTTP errors are not retried: they are logged and collapse to
empty immediately. `refreshCount()` (the public test/refresh hook)
clears any pending retry timer and resets the retry counter before
re-running the probe from scratch.

The bounded retry remains a client-side resilience measure; the server-side
sidecar-before-refresh ordering is the primary guarantee. Reducer dedup and
reload persistence are unchanged.

The component renders OUTSIDE the reducer-owned message list, so it
does not perturb the reducer's `_order` invariants documented in
[internals.md](internals.md).

Test hooks (used by the browser E2Es):
`data-testid="pre-compaction-history"` on the root,
`data-state="collapsed|expanded|empty"` on the same element, and
`data-test="row-count"` on the count display.

## Files

| Concern | File |
| --- | --- |
| Sidecar storage + synthetic-row construction + snapshot splice | `src/server/agent/compaction-sidecar.ts` |
| Manual RPC failure/fallback append + `get_messages` splice + manual `compactionId` stash | `src/server/ws/handler.ts` |
| Successful manual / auto / overflow append before `refreshAfterCompaction` + shared `compactionId` mint/stamp | `src/server/agent/session-manager.ts` |
| Live card carries `compactionId`; reducer dedups persisted vs live by `compactionId` | `src/app/remote-agent.ts`, `src/app/message-reducer.ts` |
| Pre-compaction reader + branch-split logic | `src/server/agent/transcript-reader.ts` — `readOrphanedBeforeCompaction` |
| Sandbox-aware transcript read | `src/server/agent/session-fs.ts` — `sessionFileRead` |
| REST endpoint registration | `src/server/server.ts` — `before-compaction` route handler |
| Pre-compaction history component + count-probe retry | `src/ui/components/PreCompactionHistory.ts` |
| Renderer integration (mounts the child when `compactionId` is set) | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` |
| Payload type (adds `compactionId?: string`) | `src/app/compaction-types.ts` |
| API integration (endpoint contract) | `tests2/integration/transcript-before-compaction.test.ts` |
| Browser E2E (persistence + expand + `@live-compaction-affordance` live-session affordance + count-probe transient-404 retry) | `tests2/browser/e2e/pre-compaction-history.spec.ts` |
| Full design rationale | [docs/design/persist-compaction-history.md](design/persist-compaction-history.md) |

## See also

- [docs/compaction.md](compaction.md) — live compaction triggers, the
  rich-summary card surface, single-card lifecycle.
- [docs/design/compaction-e2e-rich-summary.md](design/compaction-e2e-rich-summary.md)
  — original rich-summary design (predecessor of the persistence work).
- [docs/rest-api.md](rest-api.md) — full REST surface.
- [docs/internals.md — Skill chip rendering](internals.md#skill-chip-rendering--autonomous-activation)
  — the sidecar pattern this feature mirrors.
