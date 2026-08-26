# Issue Analysis — Compaction message-loss / missing pre-compaction affordance

Goal: `goal-4ac993bb` (Fix compaction message loss)
Task: `f2b085f7-a37c-4fde-aff4-03e47ece2a8b`
Author: coder-12e6 (analysis only — no production code or tests changed)
Live session inspected: `f5d1ea3f-4ba2-403e-a935-4867b3598acb`

---

## TL;DR

The pre-compaction messages are **not lost on disk** and the orphan reader
**works correctly**. The bug is purely UX (the design's "gap 1"): after a
compaction in the *same live session*, the rich compaction card the user is
looking at is the client-only `compact_active` synthetic, which carries **no
`compactionId`**. The "Show N messages before compaction" affordance in
`MessageList.ts` is gated on `getCompactionSidecarId(msg)`, which keys on
`block.arguments?.compactionId`. The live card has no such id, so no
affordance attaches to it. The *persisted* sidecar synthetic that does carry
`compactionId` either (a) never reaches the live snapshot in time (manual
path race) or (b) is spliced in as a **second** card at the very top of the
transcript (auto/overflow path), far from where the user is looking. The
affordance only becomes visible after a page reload, when the live
`compact_active` card is gone and only the persisted synthetic remains.

The design's suspected "gap 2" (`firstKeptEntryId` never populated) is **NOT
real** for the common auto/overflow path: every sidecar on disk carries a
valid `firstKeptEntryId`, it matches a real top-level `entry.id` in the agent
`.jsonl`, and `readOrphanedBeforeCompaction` resolves the correct split and a
non-zero `total`. A residual gap exists only for the manual/error paths
(which write `firstKeptEntryId: null`) where the legacy `type:"compaction"`
fallback scan is approximate (over-counts the kept tail).

---

## Evidence from the real session

### Sidecar (`<stateDir>/compaction-sidecar/f5d1ea3f-…​.jsonl`)

```json
{"schemaVersion":1,"id":"c_1781889090173_9802f8","trigger":"auto",
 "tokensBefore":265357,"tokensAfter":null,"durationMs":48148,
 "startedAt":"2026-06-19T17:11:30.173Z","endedAt":"2026-06-19T17:12:18.321Z",
 "success":true,"firstKeptEntryId":"b69ccf22"}
```

All seven sidecars currently on disk (auto + overflow triggers) carry a
non-null `firstKeptEntryId` (8-char hex, e.g. `b69ccf22`, `cbb91ed8`,
`04c1245e`). So the field name **`firstKeptEntryId`** is correct and the
auto/overflow capture path (`session-manager.ts:2853`,
`result?.firstKeptEntryId`) works.

### Agent transcript (pi-coding-agent `.jsonl`)

For session f5d1ea3f the active branch lives at
`~/.bobbit/agent/sessions/…/…019ee06a-…​.jsonl` (631 entries). Key facts:

- `firstKeptEntryId="b69ccf22"` matches a **top-level `entry.id`** at index
  465 (an `assistant` message). The reader reads `entry.id` in `parseJsonl`
  / `parseJsonlAllEntries`, so the field shape matches.
- The agent's own boundary marker is a separate entry
  `{"type":"compaction","id":"bf9b1c9b",…,"firstKeptEntryId":"b69ccf22",
  "tokensBefore":265357,…}` at index **502** — i.e. it sits *after*
  `firstKeptEntryId`, not at it.
- Simulating `readOrphanedBeforeCompaction`:
  - with `firstKeptEntryId="b69ccf22"` → `splitIdx=465` → **`total=462`**
    orphaned messages. Correct.
  - via legacy `type:"compaction"` fallback → `splitIdx=502` →
    `total=499`. **Over-counts by 37** (the kept-tail entries 465..501 that
    the compaction summarised but *kept* on the active branch).

So the reader returns the right messages **as long as `firstKeptEntryId` is
used**. The legacy fallback is a coarser safety net only.

---

## 1. Why the affordance does not appear immediately in the live session

The affordance is rendered by `MessageList.buildRenderItems()`
(`src/ui/components/MessageList.ts`) only when:

```ts
const compactionId = getCompactionSidecarId(msg);  // block.arguments?.compactionId
if (compactionId && this.sessionId) { …mount <bobbit-pre-compaction-history>… }
```

`getCompactionSidecarId` is **id-agnostic** — it matches *any*
`__compaction_summary` assistant row whose toolCall `arguments` carry a
non-empty `compactionId`. So the gate is purely: *does the rendered card's
payload carry `compactionId`?*

The card the user sees immediately after compaction is the **live
`compact_active` synthetic**, built client-side in
`remote-agent.ts` (`compaction_end` / `auto_compaction_end` handler →
`buildCompactionSummaryMessages(payload)`). That `payload`
(`CompactionSummaryPayload`) is assembled from the WS event and **never sets
`compactionId`** — the field is documented as "Absent on live in-flight
payloads" (`compaction-types.ts`). Hence the live card never satisfies the
gate, and no affordance attaches to it.

The *persisted* synthetic (built by `syntheticCompactionRowsFromSidecar` in
`compaction-sidecar.ts`) **does** set `compactionId: entry.id`. Whether it
reaches the user live differs by trigger:

### Manual path (`/compact`) — timing race

- `ws/handler.ts` (`case "compact"`) generates `compactionId` and appends the
  sidecar entry **inside a fire-and-forget IIFE, only after
  `await session.rpcClient.compact()` resolves**.
- pi-coding-agent emits `compaction_end` **during** that RPC. session-manager's
  event listener (`session-manager.ts:2860`) calls `refreshAfterCompaction`
  **on that event**, i.e. *before* the handler's post-await
  `appendCompactionSidecarEntry` runs.
- `refreshAfterCompaction` → `getMessages()` →
  `mergeCompactionSidecarIntoMessages(session.id, …)` reads the sidecar — which
  is **still empty** — so no synthetic is spliced. The broadcast snapshot has
  no card with `compactionId`. Net: no affordance live; it appears only on the
  next reload (when the sidecar finally exists and `get_messages` splices it).

### Auto / overflow path — duplicate card, mis-positioned

- session-manager appends the sidecar **synchronously before**
  `refreshAfterCompaction` (`session-manager.ts:2845`→`2860`), so the snapshot
  *does* carry a synthetic with `compactionId`.
- But the snapshot is processed by the reducer's `snapshot` case
  (`message-reducer.ts`). The live `compact_active` synthetic (no
  `compactionId`, `_origin:"synthetic"`, `_order ≈ highestSeq+0.5`) and the
  snapshot's persisted synthetic (different `id`, `_origin:"server"`,
  `_order = SNAPSHOT_ORDER_FLOOR + 0`) have **different ids and toolCallIds**,
  so neither dedups the other. Both survive → **two compaction cards**.
- `mergeCompactionSidecarIntoMessages` prepends the persisted synthetic at the
  head of `getMessages()`, so it lands at the *most negative* `_order` and
  renders at the **very top** of the transcript (above the kept tail), while
  the live `compact_active` card sits at the bottom where the transcript
  auto-scrolls. The user, looking at the bottom card, sees no affordance; the
  affordance is on a duplicate card buried at the top.
- The `hasLiveActive` guard inside `mergeCompactionSidecarIntoMessages` was
  written to suppress exactly this double card, but it checks
  `existingToolCallIds.has("compaction-summary:compact_active")` against the
  **server-side `getMessages()` output**, which never contains the
  client-only `compact_active` synthetic. So `hasLiveActive` is **always
  false in the broadcast/reload paths — effectively dead code** — and the
  dedup never fires.

Both manifestations share the same root cause: the affordance is keyed to
`compactionId`, but the card the user actually sees in the live session
(`compact_active`) never carries one, and the persisted card that does is
either missing (manual race) or duplicated/mis-placed (auto).

---

## 2. Is `firstKeptEntryId` reliably captured?

**Yes, for auto/overflow** — verified against real on-disk data (all seven
sidecars have valid 8-char-hex `firstKeptEntryId` values; each matches a real
top-level `entry.id` in the corresponding agent `.jsonl`). The capture site
`event.result?.firstKeptEntryId` (`session-manager.ts:2853`) and the reader's
`entry.id` parse are both correct. **"Gap 2" as stated (the field never
populating) is not the live bug.**

Residual risk on two paths that write `firstKeptEntryId: null`:

- **Manual** (`ws/handler.ts`): reads `compactResult?.data?.firstKeptEntryId`.
  No manual sidecar exists in the current sample, so the RPC-return field name
  is **unverified**. If the manual RPC return does not expose
  `firstKeptEntryId` under that key, manual sidecars fall back to null.
- **Error/aborted**: always null by construction.

When `firstKeptEntryId` is null the reader uses the legacy
`type:"compaction"` fallback, which (per the §evidence) **over-counts** by
including the kept tail. It is non-zero (so the affordance still appears) but
not exactly correct.

---

## 3. How `readOrphanedBeforeCompaction` behaves when `firstKeptEntryId` is null/unresolved, and when `total` becomes 0

`src/server/agent/transcript-reader.ts::readOrphanedBeforeCompaction`:

1. If `firstKeptEntryId` is set →
   `splitIdx = allEntries.findIndex(e => e.entry?.id === firstKeptEntryId)`.
2. If that misses (`splitIdx < 0`) or `firstKeptEntryId` is null →
   `splitIdx = allEntries.findIndex(e => e.entry?.type === "compaction")`
   (legacy fallback).
3. **`if (splitIdx <= 0) return { total: 0, … }`.**

`total` becomes 0 when *either*:

- the sidecar's `firstKeptEntryId` is null **and** the `.jsonl` has no
  `type:"compaction"` entry (older transcripts, or a transcript that was
  truncated/rotated), **or**
- `firstKeptEntryId` is set but does **not** match any `entry.id` (id-shape
  drift / wrong field), and there is also no `type:"compaction"` marker, **or**
- the boundary resolves to index 0 (nothing before it).

This is a deliberate "no fabricated history" guard, and `total:0` makes
`<bobbit-pre-compaction-history>` render `data-state="empty"` (nothing). It is
correct *when no orphans exist*, but it silently hides orphans when the split
fails to resolve despite real pre-compaction entries on disk — which is the
acceptance-criterion failure mode to defend against. For the inspected
session this guard is **not** triggered (total=462).

---

## 4. Smallest TDD test(s) to add before the fix

### T1 (primary, reproduces gap 1) — browser E2E, live compaction, no reload

Extend `tests/e2e/browser/pre-compaction-history.browser-e2e.spec.ts` to drive a **mock-agent compaction in a
live session** and assert the affordance appears **before any reload**:

- Requires extending `tests/e2e/_helpers/mock-agent-core.mjs`: the `compact` RPC (and
  an auto/overflow trigger) must `emit` `compaction_start` then
  `compaction_end`/`auto_compaction_end` with a
  `result: { tokensBefore, firstKeptEntryId }`, and `get_state` must write a
  `.jsonl` whose entries carry top-level `id`s including the
  `firstKeptEntryId` boundary plus ≥1 orphan before it. (Today the mock's
  `compact` just returns `{success:true}`, emits no events, and writes
  id-less `{type:"message",message}` lines.)
- Assert: exactly **one** `[data-testid='compaction-summary-card']`, a
  `[data-testid='pre-compaction-history'][data-state='collapsed']` with
  `Show N messages before compaction` (correct N), expanding shows the orphan
  rows — **all without `page.reload()`**.
- This **fails today**: the live `compact_active` card has no `compactionId`
  (no affordance) and/or a duplicate card appears at the top.

### T2 (pins gap-2 fallback) — API E2E

In `tests/integration/gateway/transcript-before-compaction.gateway.test.ts`, add a case: a sidecar
entry with `firstKeptEntryId: null` whose `.jsonl` carries a real
`type:"compaction"` boundary with orphans before it → assert `total > 0` and
the orphan contents. Add a companion case with `firstKeptEntryId` set to a
real `entry.id` → assert the **exact** `total` (and that it is smaller than
the `type:"compaction"`-based count, pinning "prefer firstKeptEntryId").

### T3 (cheap, file:// browser unit) — affordance gating

`MessageList` spec: a messages array with one `__compaction_summary`
assistant row whose `arguments.compactionId` is set + `sessionId` present →
asserts a `<bobbit-pre-compaction-history>` is mounted; a sibling case with a
`compact_active`-style payload lacking `compactionId` → asserts none. Pins
the contract "card with `compactionId` ⇒ affordance" that the fix relies on.

---

## 5. Exact files/functions the implementation should change

Recommended fix shape: **thread the sidecar `compactionId` onto the live
card** so the affordance attaches to the single card the user is already
looking at, and **dedup the persisted snapshot synthetic against it**
client-side. `getCompactionSidecarId` already keys on
`arguments.compactionId` (id-agnostic), so once the live payload carries it,
the affordance "just works".

1. `src/server/agent/session-manager.ts` — `handleAgentEvent`
   `auto_compaction_start`/`compaction_start` (~2811) and
   `auto_compaction_end`/`compaction_end` (~2825):
   - Generate the `compactionId` once at *start* (store on
     `_pendingCompactionStart`) for the auto/overflow path, use it for the
     sidecar `id`, **and attach it to the broadcast end event**
     (`event.compactionId`) before/when forwarding to clients, so the client
     can stamp the live card.
2. `src/server/ws/handler.ts` — `case "compact"` (~744):
   - Fix the manual race so the affordance can appear live. Either append the
     sidecar **before** the agent's `compaction_end`-driven
     `refreshAfterCompaction` runs, or (cleaner) surface the
     pre-generated `compactionId` to the client via the broadcast
     `compaction_end` event (coordinate with session-manager rather than
     relying on the snapshot-splice timing). Also verify the manual RPC return
     actually exposes `firstKeptEntryId` (capture it; else rely on the
     `type:"compaction"` fallback).
3. `src/app/remote-agent.ts` — `compaction_end`/`auto_compaction_end` handler
   (~2811–2906): read `event.compactionId` and set it on the
   `CompactionSummaryPayload` passed to `buildCompactionSummaryMessages`, so
   the live `compact_active` card's toolCall arguments carry `compactionId`.
4. `src/app/message-reducer.ts` — `snapshot` case: when a snapshot
   `__compaction_summary` row's `compactionId` matches the live
   `compact_active` synthetic already in state, **drop the snapshot row**
   (live card wins; single DOM identity preserved). Mirrors the existing
   "rich wins" branch (case 12b). On reload (no live card) the snapshot
   synthetic survives unchanged — no regression to reload persistence.
5. `src/server/agent/compaction-sidecar.ts` —
   `mergeCompactionSidecarIntoMessages`: remove/replace the dead
   `hasLiveActive` guard (it can never fire in the broadcast/reload paths
   because server-side `getMessages()` never contains the client-only
   `compact_active`). Dedup now lives client-side (step 4). Keep the splice
   for the reload path.
6. `src/app/compaction-types.ts` — optionally let
   `buildInProgressCompactionPayload` accept/carry `compactionId` so even the
   in-progress card can host the affordance once the id is known at
   `compaction_start`. `CompactionSummaryPayload.compactionId` already exists.
7. `src/ui/components/MessageList.ts` — `getCompactionSidecarId`: **no change
   needed** (already id-agnostic, keys on `arguments.compactionId`). Confirm
   the `content.length === 1` constraint still holds for the live card (it
   does — `buildCompactionSummaryMessages` emits a single toolCall block).

Optional gap-2 hardening (acceptance: "must never silently render empty when
orphaned messages exist on disk"): in
`transcript-reader.ts::readOrphanedBeforeCompaction`, keep `firstKeptEntryId`
as the preferred split (exact), keep the `type:"compaction"` scan as fallback,
and ensure the manual/error paths capture `firstKeptEntryId` where the RPC
exposes it so manual compactions also get exact (not over-counted) splits.

---

## Constraints honoured by this plan

- Read-only by construction: orphan entries are still fetched lazily via the
  REST endpoint and rendered outside the reducer-owned list; not re-injected
  into agent context.
- No regression to the rich card or its reload persistence: the snapshot
  splice and reload path are unchanged; only the live-session duplicate is
  reconciled, and only via a `compactionId`-match drop.
- Theme-token styling only; no rendering changes proposed beyond mounting the
  existing `<bobbit-pre-compaction-history>` against the live card.
</content>
</invoke>
