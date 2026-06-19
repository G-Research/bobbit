# Compaction-history fix hazard review

Scope: pre-implementation review for the live pre-compaction history recovery fix. This note calls out failure modes to avoid while threading sidecar `compactionId` onto the live compaction card and reconciling live/snapshot rows.

## Must-preserve invariants

- Pre-compaction entries stay read-only and lazy-loaded through `GET /api/sessions/:id/transcript/before-compaction`; do not re-inject them into reducer state or agent context.
- The live card keeps the stable `compact_active` message id and `compaction-summary:compact_active` toolCall id for in-progress -> complete DOM continuity.
- The persisted sidecar card remains the reload/navigate-away anchor when no live `compact_active` row exists.
- `message-reducer.ts` output must remain sorted by `(_order ASC, _insertionTick ASC)` and must not drop unrelated live rows under the H3 survivor rules.

## Hazards and guardrails

### 1. `compactionId` alignment across event, sidecar, and live card

Hazard: generating or reading different ids in `session-manager.ts`, `ws/handler.ts`, and `remote-agent.ts` will create a live card whose affordance queries one `compactionId` while the sidecar endpoint stores another.

Guardrails:

- Generate one sidecar id per compaction and reuse it for both the sidecar entry and the `compaction_end` / `auto_compaction_end` event delivered to the client.
- For auto/overflow, store the generated id in the pending compaction state at start; do not call `makeCompactionId()` again at end.
- For manual `/compact`, coordinate with the existing `compactionId` created in `ws/handler.ts` or move manual sidecar ownership into the session-manager end-event path. Do not let handler and session-manager append different ids for the same compaction.
- Keep `compactionId` as payload data only. Do not replace the live message id/toolCall id with the sidecar id; that breaks the single-DOM-identity invariant.
- Preserve `payload.compactionId` through every later rebuild of the card, especially `_tryAmendPendingCompaction()` in `remote-agent.ts`. If the first complete payload has the id but the usage-amend payload drops it, the affordance will disappear after tokens-after is filled.

### 2. Do not mount the history widget before the sidecar can answer

Hazard: if an in-progress card receives `compactionId` at `compaction_start`, `<bobbit-pre-compaction-history>` can mount and fetch before the sidecar entry exists. A 404 is cached as `total=0` in `PreCompactionHistory`, so production can remain silently empty unless something forces `refreshCount()`.

Guardrails:

- Prefer adding `compactionId` only to the terminal complete/error payload after the sidecar entry has been appended, or guarantee the widget remounts/refetches when the sidecar becomes available.
- Do not rely on browser E2E calling `refreshCount()` to hide this race; production only has the IntersectionObserver and 500 ms safety-net fetch.

### 3. Manual compact race

Hazard: the current manual path appends the sidecar after `await rpcClient.compact()`, while pi-coding-agent emits `compaction_end` during that RPC and session-manager refreshes messages on that event. A fix that only broadcasts `compactionId` but leaves the sidecar append after refresh can still leave the live widget querying a missing sidecar.

Guardrails:

- Ensure the sidecar entry is appended before `refreshAfterCompaction()` broadcasts the post-compaction snapshot, including manual compactions.
- If manual sidecar writing moves to session-manager, remove or gate the handler append to avoid duplicate sidecar rows.
- If manual writing stays in `ws/handler.ts`, add an explicit post-append refresh/refetch strategy; otherwise the live card and endpoint availability remain racy.

### 4. Reducer dedup must be narrow and paired

Hazard: the snapshot sidecar row and live `compact_active` row use different ids/toolCall ids, so generic id/toolCall dedup will not catch them. Over-broad filtering can drop older compactions or unrelated tool rows.

Guardrails:

- Dedup by matching `arguments.compactionId` on the live rich synthetic against the snapshot sidecar payload, not by message id.
- Drop the snapshot assistant row and its paired `toolResult` together for the matching sidecar id. Leaving an orphaned snapshot `toolResult` creates invisible state noise and can affect future toolCall-id sets.
- Only drop snapshot rows whose `compactionId` matches a live `compact_active` card. Older persisted compaction cards with different ids must survive.
- Perform filtering before stamping or consistently restamp after filtering; do not introduce holes or custom `_order` values that break the reducer sort invariants.
- Keep the H3 survivor logic intact: live server rows with positive `_order` newer than the snapshot must still survive unless the snapshot truly represents them.

### 5. Reload and navigate-away persistence

Hazard: moving dedup entirely client-side can accidentally suppress the persisted sidecar card after reload or after switching sessions if stale live state is considered equivalent.

Guardrails:

- On reload/new navigation, when no live `compact_active` row exists, the sidecar-spliced synthetic from `mergeCompactionSidecarIntoMessages()` must render unchanged with its affordance.
- Treat the server-side `hasLiveActive` guard in `compaction-sidecar.ts` as ineffective for the live-client case, but do not remove the sidecar splice itself.
- Verify both full reload and navigate-away/back with the affordance, not only the card body.

### 6. `firstKeptEntryId` and fallback behavior

Hazard: writing sidecar entries too early or with a null boundary makes the orphan reader fall back to the first `type:"compaction"` marker, which can over-count kept-tail rows; if neither boundary resolves, the UI silently renders `data-state="empty"` even when disk has history.

Guardrails:

- Keep `firstKeptEntryId` capture from `event.result?.firstKeptEntryId` for auto/overflow.
- Verify and preserve the manual RPC field (`compactResult?.data?.firstKeptEntryId`) or prefer the session-manager event result if that is the canonical shape.
- Do not append a final successful sidecar with `firstKeptEntryId: null` if a later payload in the same compaction can provide the exact boundary.
- Keep the fallback scan as a safety net, but tests should prove exact `firstKeptEntryId` wins over the approximate `type:"compaction"` split.

## Test coverage risks

Minimum coverage to avoid false confidence:

- Browser E2E for the live auto/overflow compaction path: before reload, exactly one compaction card, one history affordance, correct count, and expanded orphan rows.
- A manual `/compact` live test or focused integration test that exercises the event ordering where `compaction_end` arrives before the handler RPC promise resolves.
- Reducer unit tests for: matching live `compact_active` + snapshot sidecar id dedups to one assistant row and one toolResult; non-matching older sidecar cards survive; sorted `_order` invariant holds.
- A card-amend test proving `compactionId` survives `_tryAmendPendingCompaction()` after tokens-after/reduction is filled.
- API E2E for null `firstKeptEntryId` fallback and exact `firstKeptEntryId` preference.
- Reload and navigate-away/back UI tests should assert the pre-compaction affordance state/count, not just that the compaction card exists.

## Implementation checklist

- [ ] One generated `compactionId` per compaction, shared by event and sidecar.
- [ ] Sidecar is available before the live widget can permanently cache an empty count.
- [ ] Live terminal and amended card payloads carry `compactionId`.
- [ ] Reducer drops only matching persisted snapshot sidecar rows, including paired toolResult.
- [ ] Older/reloaded persisted sidecar cards still render.
- [ ] `firstKeptEntryId` exact split remains preferred; fallback is covered but not treated as exact.
