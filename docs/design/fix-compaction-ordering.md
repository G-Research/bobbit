# Fix Compaction Ordering (live vs reload divergence)

Status: **implemented**. Targets the goal "Fix Compaction Ordering"
(follow-up to PR #817 "Fix compaction history recovery").

§0–§6 below are the original investigation/design. §8 records the **final
implementation** as shipped — read it for what the code actually does; the
earlier sections explain *why*.

## 0. Symptom

After PR #817, the pre-compaction history is recoverable, but in the **same
live session immediately after compaction** the compaction summary card and its
`Show N messages before compaction` affordance render **after** the preserved
recent messages/tool rows. Navigating away and back, or reloading, fixes the
order. This is the classic signature of a **live reducer/order-reconciliation
bug** rather than a persisted transcript/sidecar bug: reload produces canonical
ordering, live does not.

Maintainer feedback: the 47 compacted messages' card should be at the *start* of
the post-compaction window (before the preserved tail), not after it; message
display around agent events feels fragile.

This doc isolates the exact ordering model, confirms the root cause, and
proposes a fix at the **shared ordering/reconciliation layer** (the reducer's
snapshot dedup + the `compaction-result` transition) plus failing-first
regression coverage.

## 1. The ordering model today

All ordering flows through the single pure reducer in
`src/app/message-reducer.ts` (see `docs/design/unified-message-ordering-reducer.md`).
Every row carries `_order` (primary sort key) and `_insertionTick` (secondary).
`sortMessages` sorts `(_order ASC, _insertionTick ASC)` after every reduce, and
render trusts the array verbatim (`MessageList.buildRenderItems` walks it
in-order, prepending the `<bobbit-pre-compaction-history>` widget immediately
before any `__compaction_summary` card that carries a `compactionId`).

`_order` is assigned per action type:

| Row | Action | `_order` assigned |
|---|---|---|
| Live `message_end` (user/assistant/toolResult) | `live-event` | `seq` (server-stamped, **positive**, monotonic) |
| Snapshot row, no explicit `_order` | `snapshot` | `SNAPSHOT_ORDER_FLOOR + i` = `-1_000_000_000 + i` (**negative**) |
| Snapshot row carrying explicit server `_order` | `snapshot` | that value verbatim |
| Optimistic prompt/steer | `optimistic-*` | `OPTIMISTIC_ORDER_BASE + tick` (huge positive — always tail) |
| Live in-progress compaction card (`compact_active`) | `compaction-placeholder` | `highestSeq + 0.5` (**positive**) |
| Terminal compaction card (`compact_active`) + paired toolResult | `compaction-result` | `highestSeq + 0.5` (card), `+0.001` (toolResult) (**positive**) |
| `system-notification` / `error` / `mutation-pending` | resp. | `highestSeq + 0.5` (**positive**) |

`highestSeq` tracks the highest **live** seq consumed (snapshots are negative
and never raise it). So all the synthetic "+0.5" rows are anchored to *tail
position relative to the live messages seen so far*.

### 1.1 The compaction card has two lifecycles

**Live emission (`remote-agent.ts`):**
- `compaction_start`/`auto_compaction_start` → `_addCompactingPlaceholder()` →
  `compaction-placeholder` action injects a RICH in-progress synthetic with
  stable id `compact_active`. The in-progress payload (`buildInProgressCompactionPayload`)
  carries **no `compactionId`**.
- `compaction_end`/`auto_compaction_end` → after a `COMPACT_CARD_MIN_DURATION`
  (2500 ms) floor, `transitionCard()` fires `compaction-result`. Only here does
  the card gain `compactionId` (from `event.compactionId`). The terminal card
  keeps id `compact_active` for single-DOM-identity continuity. The transition
  is frequently deferred inside a `setTimeout`, so it can land **after** the
  server's post-compaction snapshot.

**Persisted/reload splice (`compaction-sidecar.ts`):**
- `mergeCompactionSidecarIntoMessages(sessionId, messages)` reads sidecar
  entries and, for each, builds `syntheticCompactionRowsFromSidecar` — an
  assistant `__compaction_summary` row whose id is the sidecar **`entry.id`**
  (NOT `compact_active`) plus a paired toolResult. Both carry `compactionId =
  entry.id`. The block is **prepended** to the message list, on the assumption
  the reducer's snapshot stamping (`SNAPSHOT_ORDER_FLOOR + i`) then makes the
  card sort before the kept tail.
- `hasLiveActive` guard: when a live `compact_active` summary toolCall is
  already in the array, the most-recent sidecar row is dropped from the splice
  (same compaction, two surfaces) — this guard runs in the **server-side
  get_messages pipeline**, not in the live client reducer.

### 1.2 Live↔snapshot compaction dedup in the reducer

In the `snapshot` action:
- `hasRichSyntheticCompaction` → drop the server's legacy plain-text marker.
- `liveCompactionIds`: collect `compactionId`s from any state row with id
  `compact_active`. If non-empty, **drop** from the incoming snapshot every row
  whose `compactionSummaryId` is in that set, plus its paired toolResult
  (`compaction-summary:<id>`). Rationale: the live card already hosts the
  affordance; reuse one DOM node, avoid a duplicate. On reload there is no
  `compact_active`, so this set is empty and the persisted sidecar synthetic
  survives with its canonical (negative, prepended) `_order`.

In the `compaction-result` action:
- Drop `compacting_placeholder`, `compact_active`, and (when the terminal card
  has a `compactionId`) any persisted sidecar card with the same
  `compactionId` + its paired toolResult. Then push the new card at `highestSeq
  + 0.5` and the toolResult at `+0.001`.

### 1.3 What the post-compaction snapshot contains

pi-coding-agent's `getMessages()` after compaction returns only the **active
branch**: the summary entry + the preserved tail from `firstKeptEntryId`. Bobbit's
server pipeline runs `mergeCompactionSidecarIntoMessages`, prepending the
persisted sidecar card+toolResult. None of the preserved-tail rows carry an
explicit `_order`, so in the reducer they are stamped `SNAPSHOT_ORDER_FLOOR + i`
(negative). The preserved-tail rows that were *also* live events in this session
get dropped from the live copy by id-match in the survivor pass, leaving the
snapshot's **negative-ordered** copies as the survivors.

## 2. Root cause (confirmed)

The divergence is a missing **positional reconciliation** when the reducer keeps
a live row in place of the snapshot row that represents the same logical entity.

After compaction, the surviving state is:

- live `compact_active` card: `_order = highestSeq + 0.5` → **positive**
- live `compact_active` paired toolResult: `_order = highestSeq + 0.501`
- preserved tail rows (from the snapshot): `_order = SNAPSHOT_ORDER_FLOOR + i`
  → **negative**

Sorting `_order ASC` puts every negative-ordered preserved-tail row **before**
the positive-ordered card. Result: the card + affordance render *after* the
preserved recent messages. This is the reported bug.

On **reload** there is no `compact_active` in state, so the snapshot's persisted
sidecar card survives. Because `mergeCompactionSidecarIntoMessages` **prepends**
it, it is stamped `SNAPSHOT_ORDER_FLOOR + 0/1` — the most-negative orders — so it
sorts **before** the preserved tail. Canonical, correct ordering.

So: **reload works because the persisted card gets canonical (prepended,
most-negative) snapshot ordering; live is wrong because the surviving
`compact_active` card retains a stale pre-compaction positive `_order` while the
preserved tail it should precede gets fresh negative snapshot orders.** When the
reducer drops the snapshot's authoritative persisted card (`liveCompactionIds`
branch) in favour of the live card, it discards the card's canonical position
and never transfers it to the survivor. Confirms the goal's initial hypothesis.

This is a shared-layer flaw, not compaction-specific cosmetics: the reducer's
contract is "server snapshot is authoritative for any id/entity it contains."
For toolResult and plain-text equivalence the reducer enforces this by **dropping
the live row** (snapshot wins outright). The compaction card is the one entity
where the reducer deliberately **keeps the live row** (DOM continuity) but
**drops the snapshot row** — and that asymmetry is exactly where positional
authority is lost. The same class of bug can affect any future "keep live,
discard snapshot-equivalent" reconciliation; the fix should establish the
invariant generally: *a live row retained in place of a snapshot-equivalent row
inherits the snapshot row's `_order`.*

### 2.1 Two timing sub-cases (both end at the bug)

1. **Snapshot lands after the terminal transition** (live card has
   `compactionId`): the `snapshot` `liveCompactionIds` branch drops the
   persisted card; live card keeps `highestSeq + 0.5`. Bug.
2. **Snapshot lands before the terminal transition** (in-progress card has no
   `compactionId`): the persisted card survives the snapshot (good, negative
   order). Then the deferred `compaction-result` fires, drops the matching
   persisted card by `compactionId`, and pushes the new `compact_active` at
   `highestSeq + 0.5`. The good negative-ordered card is replaced by a
   positive-ordered one. Bug.

Therefore the fix must cover **both** the `snapshot` displacement path and the
`compaction-result` displacement path. Both are instances of the same invariant.

## 3. Failing-test-first plan

Land these BEFORE touching production code; confirm the listed pre-fix failure.

### 3.1 Primary repro — pure reducer unit test (fast, deterministic)

File: `tests/message-reducer.test.ts` (unit·node). New cases, naming follows the
existing `(12x)` compaction family:

- **`(12e) live compact_active card sorts before preserved tail after
  post-compaction snapshot`**
  Sequence: a few live `message_end`s → `compaction-placeholder` (`compact_active`)
  → `compaction-result` with `compactionId: "c_x"` → `snapshot` whose rows are
  `[persistedCard(c_x), persistedTR(c_x), keptUser, keptAsst]` (no explicit
  `_order`; mirrors the server splice that prepends the persisted card).
  Assert the resulting `id`/`role` order is
  `["compact_active", <paired toolResult>, "kept-user", "kept-asst"]` — card
  FIRST.
  **Pre-fix failure**: order is `["kept-user", "kept-asst", "compact_active",
  …]` — the card sits after the tail; the `deepStrictEqual` on
  `s.messages.map(m => m.id)` fails.

- **`(12f) snapshot-before-terminal-transition still anchors card before tail`**
  Same but apply the `snapshot` (persisted card present, no live `compactionId`
  yet) BEFORE the `compaction-result` transition. Assert card-first ordering
  afterwards. **Pre-fix failure**: the persisted card is dropped and re-pushed
  positive; card lands after tail.

- **`(12g) live ordering equals reload ordering`**
  Build two states from the same logical post-compaction transcript:
  (a) *live* — placeholder → result → snapshot;
  (b) *reload* — a single `snapshot` containing the prepended persisted card +
  tail (no live card).
  Assert the two `messages.map(m => ({ role, isCompactionCard }))` sequences are
  equal (normalising the card id, since live uses `compact_active` and reload
  uses the sidecar id). **Pre-fix failure**: live places the card last, reload
  places it first → sequences differ.

- **`(12h) exactly one compaction card after the post-compaction snapshot`**
  Assert `messages.filter(isCompactionSummaryCard).length === 1` across both
  timing sub-cases. Guards the PR #817 no-duplicate invariant against the fix.

### 3.2 End-to-end DOM-order regression (browser)

File: `tests/e2e/ui/pre-compaction-history.spec.ts`, extend the existing
`@live-compaction-affordance` live test (which already asserts one card +
affordance, but **not** vertical order). Add an assertion that the compaction
card's DOM position precedes the first preserved-tail message — e.g. compare
`boundingBox().y` of `[data-testid='compaction-summary-card']` against the first
post-compaction `user-message`/`assistant-message`, or compare DOM index via
`evaluate`. **Pre-fix failure**: card `y` is greater than the tail row's `y`
(card below the preserved messages).

Optionally add to `tests/e2e/ui/compaction-persistence.spec.ts` an explicit
"live order == reload order" check: capture the ordered list of card + tail
testids live, reload, and assert equality.

## 4. Implementation plan

All changes are in the shared reducer/reconciliation layer; **no render-time
sorting in `MessageList`** (which must keep trusting `_order` verbatim).

### 4.1 `src/app/message-reducer.ts` — `snapshot` action (sub-case 1)

In the `liveCompactionIds` branch, instead of silently filtering the persisted
card+toolResult out of `effectiveRows`, **capture the canonical `_order` they
would receive** and transfer it to the surviving live rows:

1. Compute the persisted card's canonical order. The simplest robust approach:
   stamp `snapshotRows` over the **unfiltered** set so indices are canonical,
   then partition out the rows whose `compactionSummaryId ∈ liveCompactionIds`
   (and their paired `compaction-summary:<id>` toolResults), recording their
   `_order`s, rather than removing them from `effectiveRows` before stamping.
2. After building `survivors`/`merged`, locate the surviving live `compact_active`
   card and its paired toolResult (`toolCallId === "compaction-summary:compact_active"`)
   and override their `_order` to the recorded persisted card / toolResult
   orders (card = persisted card order; toolResult = persisted toolResult order,
   or card order + 0.001 when no persisted toolResult was present).
3. Re-`sortMessages` (already done at the end of the action).

Net effect: the live card inherits the prepended, most-negative snapshot order →
sorts before the preserved tail, identical to reload. The dedup (single card)
behaviour is unchanged.

### 4.2 `src/app/message-reducer.ts` — `compaction-result` action (sub-case 2)

When the terminal card carries a `resultCompactionId` and the state currently
holds a persisted sidecar card with that `compactionId` (the snapshot landed
first), **inherit that card's `_order`** for the new `compact_active` card
instead of `highestSeq + 0.5` (and the toolResult at `inheritedOrder + 0.001`).
Fall back to `highestSeq + 0.5` only when no persisted card is being displaced
(e.g. the genuinely-live, snapshot-not-yet-arrived case — that ordering is
corrected when the snapshot subsequently lands via 4.1).

### 4.3 Factor the shared rule

Extract a small helper, e.g. `compactionCardAnchorOrder(stateMessages,
compactionId)`, returning the `_order` of the persisted/snapshot row that
represents the compaction (or `null`). Both 4.1 and 4.2 call it. This makes the
invariant — *the compaction card's `_order` is anchored to the snapshot position
of the persisted sidecar row for the same compaction* — single-sourced and
testable, rather than duplicated. Document the invariant in a code comment that
references this doc and the pinning tests (per AGENTS.md: pin invariants in
tests, not prose).

### 4.4 Why not fix it in `compaction-sidecar.ts` or `MessageList`?

- `compaction-sidecar.ts` already does the right thing (prepend → canonical
  order); it only runs server-side in get_messages and has no visibility into
  the live `compact_active` card's reducer `_order`. The bug is purely in the
  live client reconciliation.
- Sorting/repositioning in `MessageList.buildRenderItems` would re-introduce a
  second source of ordering truth, violating the unified-reducer contract
  (`docs/design/unified-message-ordering-reducer.md`) and would not fix the
  underlying `_order` that other consumers (keys, defer heuristics) read. The
  reducer is the single ordering authority; the fix belongs there.

## 5. Invariants to pin in tests

Encoded by §3 (extend as needed):

1. **No duplicate compaction cards** — exactly one `__compaction_summary` card
   after the full live sequence and after reload (`(12h)`; existing `(12b)–(12d)`
   single-DOM-identity cases must stay green; E2E `cards.toHaveCount(1)`).
2. **Card before preserved tail (live)** — the card+affordance `_order` is less
   than every preserved-tail row's `_order` in the same live session
   (`(12e)`,`(12f)`; E2E DOM-position assertion).
3. **Live ordering ≡ reload ordering** — the normalised ordered role/kind
   sequence is identical between the live-built and reload-built states
   (`(12g)`; optional E2E live-vs-reload capture).
4. **toolCall/toolResult adjacency + stability** — the compaction card's paired
   `__compaction_summary` toolResult stays immediately adjacent (card order +
   0.001 < first tail order); existing `(3)`/`(4)` toolResult ordering cases and
   the snapshot toolCallId-equivalence dedup stay green.
5. **PR #817 behaviour preserved** — affordance present in live session with
   correct count, transient-404 count-probe retry intact, reload/navigate
   persistence intact, pre-compaction rows read-only/dimmed and outside agent
   context (existing pre-compaction-history + compaction-persistence specs stay
   green).

## 6. Risks and validation

### Risks
- **Order collision**: assigning the live card a negative order equal to a
  snapshot row's must not tie-break wrongly. `_insertionTick` is the secondary
  key; verify the card lands before its toolResult and before the tail. Use the
  persisted card's exact order (and `+0.001` for the toolResult) to stay within
  the `SNAPSHOT_ORDER_FLOOR + i` integer spacing.
- **Multiple compactions in one session**: each card must anchor to *its own*
  sidecar row's order; the helper keys on `compactionId`, so older cards keep
  their earlier (more-negative) positions. Add/extend a case if needed.
- **Snapshot churn**: repeated snapshots (visibilitychange resync) must keep the
  card anchored, not drift it back to positive. Because the reducer re-derives
  the anchor from the snapshot each time, this is idempotent — pin with a
  double-snapshot case.
- **In-progress (no compactionId) snapshots before terminal**: ensure the card
  isn't duplicated while it lacks a `compactionId`; covered by `(12f)`/`(12h)`.

### Validation commands
```bash
npm run check
npm run test:unit                                   # message-reducer.test.ts (incl. new 12e–12h)
npm run test:e2e -- pre-compaction-history          # @live-compaction-affordance DOM-order
npm run test:e2e -- compaction-persistence          # reload/navigate persistence
```

## 7. PR

PR #817 (`Fix compaction history recovery`) is already merged to `master`. This
work opens a **new** PR off `origin/master`; the #817 branch must not be reused
or pushed to.

## 8. Final implementation (as shipped)

The fix landed entirely in the shared reducer/reconciliation layer plus the
server-side sidecar write timing. No render-time sorting was added;
`MessageList` still trusts `_order` verbatim. All invariants are pinned by
tests, not prose (per AGENTS.md).

### 8.1 The shared anchor rule

`src/app/message-reducer.ts` gained one helper that single-sources the
invariant from §2/§4:

```
persistedCompactionAnchor(messages, compactionId)
  → { cardOrder, toolResultOrder }
```

It returns the `_order` of the persisted/snapshot sidecar card for
`compactionId` and its paired `compaction-summary:<id>` toolResult, **excluding
the live `compact_active` surface itself** (`id !== "compact_active"`). `null`
when no persisted row is present. Both displacement paths call it so the rule —
*a live `compact_active` card retained in place of the snapshot-equivalent
persisted card inherits that card's canonical `_order`* — exists in exactly one
place. Pinned by `(12f)`–`(12k)`.

### 8.2 Both terminal/snapshot timing paths

The reducer corrects ordering regardless of which event lands first:

- **Terminal-before-snapshot** (`snapshot` action, `liveCompactionIds` branch):
  the snapshot stamps the **full** row set first so canonical
  `SNAPSHOT_ORDER_FLOOR + i` orders reflect the server's prepended splice
  position, then partitions out the persisted card+toolResult that the live
  `compact_active` already represents — **recording** their orders instead of
  dropping them blind. After the survivor merge, the surviving live card and its
  paired toolResult inherit the recorded (negative, prepended) orders, so they
  sort before the negative-ordered preserved tail. Pinned by `(12f)`.
- **Snapshot-before-terminal** (`compaction-result` action): when a persisted
  sidecar card for the terminal card's `compactionId` already sits in state, the
  new `compact_active` card inherits that card's anchor order instead of the
  positive `highestSeq + 0.5` tail anchor (which would re-sink it below the
  tail). Fallback chain: persisted anchor → existing live `compact_active`
  card's `_order` (interim case below already moved it negative) → `highestSeq +
  0.5` only for the genuinely-live, snapshot-not-yet-arrived case (corrected
  when that snapshot lands via the `snapshot` path). Pinned by `(12g)`.

`(12h)` asserts the two paths produce **identical** ordering to a reload-built
state (single snapshot, no live card) after normalising card identity
(`compact_active` vs sidecar id).

### 8.3 Interim duplicate-card window

Between a post-compaction snapshot landing and the deferred
`compaction-result` firing, the live `compact_active` card is still
in-progress and carries **no `compactionId`**, so the cid-keyed dedup cannot
match it. Without handling this, both the persisted sidecar card and the live
card would survive (two stacked cards). The `snapshot` action detects an
in-progress live card (`hasInProgressLiveCard`) and treats the **most recent**
persisted sidecar card in the snapshot (greatest `_order` among sidecar cards —
the latest row `mergeCompactionSidecarIntoMessages` prepended) as the pending
anchor: it drops that card + its paired toolResult and transfers their
canonical orders onto the in-progress `compact_active`. Result: exactly one
card during the window, positioned before the tail. Pinned by `(12k)`.

### 8.4 Manual `/compact` sidecar write timing

The live affordance can only mount in the same session if the post-compaction
snapshot already carries the orphan boundary, which requires the sidecar row to
be persisted **before** `refreshAfterCompaction` broadcasts that snapshot. The
manual path was reworked so the success row is written synchronously in
`src/server/agent/session-manager.ts`'s manual `compaction_end` branch —
*before* it calls `refreshAfterCompaction` — reusing the shared `compactionId`
that `src/server/ws/handler.ts` stashes on the session (`_manualCompactionId`)
before awaiting the compact RPC. The agent emits that manual `compaction_end`
before the RPC promise resolves, so the row is durable by the time the snapshot
goes out.

Duplicate prevention: when session-manager's append succeeds it sets
`session._manualSidecarWritten = compactionId`. The ws-handler success branch is
now a **fallback** — it appends only when that marker is absent (e.g. the agent
emitted no successful manual `compaction_end` with a result payload). The
ws-handler still **owns the failure append** (RPC rejected) and clears the
marker defensively. This keeps exactly one sidecar line per manual compaction.

### 8.5 Stale paired-toolResult cleanup

`compaction-placeholder` previously filtered the prior `compact_active`
assistant card by id but left its paired synthetic toolResult
(`toolCallId === "compaction-summary:compact_active"`) behind, so a *second*
compaction in the same session orphaned a detached row. The placeholder filter
now also drops that toolResult, mirroring the `compaction-result` filter.
Pinned by `(12j)`.

### 8.6 Regression coverage

- `tests/message-reducer.test.ts` — `(12f)` terminal-before-snapshot,
  `(12g)` snapshot-before-terminal, `(12h)` live≡reload ordering,
  `(12i)` exactly-one-card + adjacent toolResult across both paths,
  `(12j)` placeholder removes stale paired toolResult,
  `(12k)` interim single-card-before-tail.
- `tests/e2e/ui/pre-compaction-history.spec.ts` —
  `@live-compaction-affordance` now asserts **DOM document order**: both the
  `[data-testid='compaction-summary-card']` and the
  `[data-testid='pre-compaction-history']` affordance appear before the first
  preserved-tail `assistant-message` in the same live session (no reload), plus
  the existing one-card / count-probe-404-recovery checks.

### 8.7 PR #817 behaviour preserved

Single card (`(12i)`, E2E `toHaveCount(1)`), transient-404 count-probe retry,
reload/navigate persistence, and read-only/dimmed orphaned pre-compaction rows
are all unchanged — see `docs/design/persist-compaction-history.md` for those
durable sidecar/affordance invariants.

## References
- `docs/design/unified-message-ordering-reducer.md` — single-ordinal reducer contract.
- `docs/design/persist-compaction-history.md` — sidecar storage + splice (§A, §3, §6.3).
- `docs/design/compaction-e2e-rich-summary.md` — rich summary card lifecycle (§7.3, §7.4).
- `src/app/message-reducer.ts`, `src/server/agent/compaction-sidecar.ts`,
  `src/app/remote-agent.ts`, `src/ui/components/MessageList.ts`.
- Tests: `tests/message-reducer.test.ts`, `tests/e2e/ui/pre-compaction-history.spec.ts`,
  `tests/e2e/ui/compaction-persistence.spec.ts`.
</content>
</invoke>
