# Persist Compaction History

Status: design (pre-implementation)
Goal: `goal-persist-co-e3a7640a`
Related design: [compaction-e2e-rich-summary.md](./compaction-e2e-rich-summary.md)

---

## 1. Problem

Two related gaps in the compaction UX. Both stem from pi-coding-agent
owning the `.jsonl` transcript while the rich compaction card lives only
in client state.

1. **Compaction cards disappear on navigate-away / reload.** The card is
   built purely from the live `compaction_end` WS event in
   `src/app/remote-agent.ts:2059–2120` and stored only in the message
   reducer. On revisit the snapshot has nothing to anchor a card to —
   the legacy "Context compacted from Xk tokens." plain-text row that
   the old client used to emit is gone since the rich-summary refactor,
   and pi-coding-agent never produced one of its own.
   `upgradeServerCompactionMarker` in `src/app/compaction-types.ts:208`
   (and its mirror in `src/app/message-reducer.ts:142`) plus
   `tests/message-reducer.test.ts` case 12c (line 483) are effectively
   dead code — there is no path that can deliver such a row today.

2. **Pre-compaction history is invisible.** `pi-coding-agent`'s
   `getMessages()` returns only the active branch (summary entry +
   tail from `firstKeptEntryId`). The orphaned entries are still on
   disk but never reach the client. The user can't scroll back to what
   was discussed before compaction.

Both have the same fix shape: take what's in the `.jsonl` plus what we
know from live events, persist it server-side, and serve it.

---

## 2. Approach overview

| Part | What it does | Server / client |
|------|--------------|-----------------|
| A    | Compaction sidecar: append one JSON line per compaction event; splice synthetic `__compaction_summary` rows into snapshots so cards survive reload. | Server |
| B    | Full-`.jsonl` reader + REST endpoint returning the orphaned pre-compaction entries for a given compaction. | Server |
| C    | Lit UI: lazy-fetch count, "Show N messages before compaction" affordance on the card, inline read-only expansion. | Client |

Mirrors the existing skill-sidecar pattern
(`src/server/skills/skill-sidecar.ts`) for storage and lifecycle.

### Sequencing

Part A is a prerequisite for Parts B + C — the sidecar carries
`firstKeptEntryId`, which both B's branch split and C's expand affordance
key off. There are two viable paths:

* **Recommended: single PR.** A is small (one new file, two call sites,
  one snapshot splice point). Landing A alone gives the user
  "card-survives-reload" but no scrollback — a confusing partial state.
  Bundling A+B+C is ~5 files server-side, ~3 files client-side, and
  ships one coherent feature.
* **Acceptable: split.** A first behind a single PR. B+C in a follow-up.
  Worth doing only if review velocity on a big PR is the bottleneck.

This doc assumes the single-PR path; implementer may split with no
design-level consequence.

---

## 3. Part A — server-side compaction sidecar

### 3.1 Storage

`<stateDir>/compaction-sidecar/<sessionId>.jsonl`. Host-side (mirrors
`skill-sidecar`), so valid even for sandboxed sessions whose agent
`.jsonl` lives inside the container. One JSON line per compaction event.

### 3.2 Record schema

```ts
// src/server/agent/compaction-sidecar.ts

/** Sidecar record schema v1. Bump if any consumer relies on a new field. */
export interface CompactionSidecarEntry {
  /** v1; consumers must skip lines whose schemaVersion they don't recognise. */
  schemaVersion: 1;
  /** Stable id derived from startedAt + a 6-char random suffix. Used as the
   *  primary key for the REST endpoint's `?compactionId=` query param. */
  id: string;
  /** "manual" | "auto" | "overflow". Matches CompactionTrigger. */
  trigger: "manual" | "auto" | "overflow";
  tokensBefore: number | null;
  /** Best-effort post-compaction usage. Null on the manual path because the
   *  server emits compaction_end before the post-refresh getState arrives
   *  (same constraint the client already documents at remote-agent.ts:2093).
   *  May be amended by a follow-up assistant message_end's `usage`. */
  tokensAfter: number | null;
  durationMs: number;
  /** ISO-8601 timestamps. */
  startedAt: string;
  endedAt: string;
  success: boolean;
  /** Failure detail; only set on success=false. */
  error?: string;
  /** Pi-coding-agent's first-kept entry id from CompactionResult. Used by
   *  Part B to split the .jsonl into orphaned vs active. May be null for
   *  legacy lines written before pi-coding-agent surfaced this field —
   *  Part B then falls back to scanning the .jsonl. */
  firstKeptEntryId: string | null;
}
```

Module shape (mirrors `skill-sidecar.ts` 1:1):

```ts
export function initCompactionSidecarDir(stateDir: string): void;
export function appendCompactionSidecarEntry(
  sessionId: string,
  entry: CompactionSidecarEntry,
): boolean;
export function readCompactionSidecarEntries(
  sessionId: string,
): CompactionSidecarEntry[];
export function findCompactionSidecarEntry(
  sessionId: string,
  id: string,
): CompactionSidecarEntry | undefined;
export function purgeCompactionSidecar(sessionId: string): void;
```

Init from `src/server/server.ts:499–510` next to `initSkillSidecarDir`.
Purge from the same code path that calls `purgeSkillSidecar` (archive /
terminate).

### 3.3 Append points

#### 3.3.1 Manual path — `src/server/ws/handler.ts`

Around the existing `compaction_end` broadcast (lines 553–573). Capture
`startedAt` at the broadcast of `compaction_start` (line 554); compute
`durationMs` at `compaction_end` (line 566). The RPC return
`compactResult.data` already exposes `tokensBefore` (line 565). Extract
`firstKeptEntryId` from the same payload — currently dropped on the
floor; coder must add it to the destructure.

```ts
// Pseudocode — graft into the existing async IIFE.
const startedAtMs = Date.now();
session.isCompacting = true;
broadcast(session.clients, { type: "event", data: { type: "compaction_start", reason: "manual" } });
try {
  const compactResult = await session.rpcClient.compact(120_000);
  const endedAtMs = Date.now();
  const tokensBefore = compactResult?.data?.tokensBefore ?? null;
  const firstKeptEntryId = compactResult?.data?.firstKeptEntryId ?? null;
  appendCompactionSidecarEntry(session.id, {
    schemaVersion: 1,
    id: makeCompactionId(startedAtMs),  // `c_<startedAtMs>_<rand6>`
    trigger: "manual",
    tokensBefore,
    tokensAfter: null,
    durationMs: endedAtMs - startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    success: true,
    firstKeptEntryId,
  });
  broadcast(session.clients, { type: "event", data: { type: "compaction_end", reason: "manual", success: true, tokensBefore } });
  await sessionManager.refreshAfterCompaction(session);
} catch (err: any) {
  const endedAtMs = Date.now();
  appendCompactionSidecarEntry(session.id, {
    schemaVersion: 1,
    id: makeCompactionId(startedAtMs),
    trigger: "manual",
    tokensBefore: null,
    tokensAfter: null,
    durationMs: endedAtMs - startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    success: false,
    error: err.message,
    firstKeptEntryId: null,
  });
  broadcast(session.clients, { type: "event", data: { type: "compaction_end", reason: "manual", success: false, error: err.message } });
}
```

#### 3.3.2 Auto / overflow path — `src/server/agent/session-manager.ts`

At lines 1910–1914 (`auto_compaction_start` / `auto_compaction_end`).

* On `auto_compaction_start`: stash `startedAtMs` and the trigger
  (`event.reason === "overflow" ? "overflow" : "auto"`) on the session,
  e.g. as `session.compactionStartedAt` and `session.compactionTrigger`.
  These fields already have implicit precedent: the client tracks
  `_compactionStartedAt` (`remote-agent.ts:2104`); the server needs an
  equivalent.
* On `auto_compaction_end`: compute `durationMs`, pull `tokensBefore`
  and `firstKeptEntryId` from `event.result` (the upstream
  `CompactionResult`; currently dropped — see `remote-agent.ts:2073`
  which already references `event.result?.tokensBefore`), append the
  sidecar entry, clear the stashed fields, then call the existing
  `refreshAfterCompaction(session)`.

The trigger detected at *_start* must be persisted so end-time can
report `overflow` correctly (matches existing client logic in
`remote-agent.ts::_triggerFromEvent`).

### 3.4 `getMessages()` splice — making the card survive reload

Two server entry points return the message list to the client:

1. `src/server/ws/handler.ts::case "get_messages"` (~line 614).
2. `src/server/agent/session-manager.ts::refreshAfterCompaction`
   (line 3268, broadcasts a `{type:"messages"}` frame).

Both currently call `session.rpcClient.getMessages()` and post-process
through `spliceInFlightMessage` → `truncateLargeToolContentInMessages` →
`mergeSkillSidecarIntoMessages`. Add a new pre/post step
`mergeCompactionSidecarIntoMessages(sessionId, messages)` that:

1. Reads `readCompactionSidecarEntries(sessionId)`.
2. For each entry, builds a synthetic `assistant`+`toolResult` pair
   shaped as `__compaction_summary` (see §3.5) and splices them into
   the message array at the chronological position implied by the
   `firstKeptEntryId` boundary. If the boundary isn't resolvable
   (legacy entry with `firstKeptEntryId: null`), append the pair
   immediately before the active-branch summary row.
3. Idempotent: if a `__compaction_summary` toolCall already exists in
   the input with the same stable id (live emission path during the
   same session) the sidecar entry is skipped for that array slot —
   the live row wins on equality, the reducer's existing dedup handles
   the rest via `hasCompactionToolCall` at `message-reducer.ts:102`.

The splice MUST run BEFORE `spliceInFlightMessage` and `truncate*` so
the synthetic rows participate in the same post-processing as
server-origin rows.

### 3.5 Synthetic row shape (server-side)

The reducer already knows how to recognise the rich shape via
`hasCompactionToolCall` (`message-reducer.ts:102–107`). The server emits
exactly the same shape that `buildCompactionSummaryMessages` in
`src/app/compaction-types.ts:71–110` produces, except the id is the
sidecar's stable `entry.id` (NOT `compact_active` — that's reserved for
the live in-flight card so single-DOM-identity continuity isn't
broken).

```ts
// Server-side, no Lit imports — keep it framework-free.
function syntheticCompactionRowsFromSidecar(entry: CompactionSidecarEntry): [any, any] {
  const payload = {
    schemaVersion: 1 as const,
    trigger: entry.trigger,
    state: entry.success ? "complete" : "error",
    success: entry.success,
    timestamp: entry.endedAt,
    startedAt: entry.startedAt,
    durationMs: entry.durationMs,
    tokensBefore: entry.tokensBefore,
    tokensAfter: entry.tokensAfter,
    reductionPct:
      entry.tokensBefore != null && entry.tokensAfter != null
        ? Math.round(((entry.tokensBefore - entry.tokensAfter) / entry.tokensBefore) * 1000) / 10
        : null,
    error: entry.success ? undefined : entry.error,
    /** NEW — sidecar id, used by Part C to query pre-compaction history. */
    compactionId: entry.id,
  };
  const id = entry.id;                          // e.g. "c_1731602400000_a1b2c3"
  const toolCallId = `compaction-summary:${id}`;
  const tsMs = new Date(entry.endedAt).getTime();
  const message = {
    id,
    role: "assistant",
    timestamp: tsMs,
    content: [{ type: "toolCall", id: toolCallId, name: "__compaction_summary", arguments: payload }],
  };
  const toolResult = {
    role: "toolResult",
    toolCallId,
    toolName: "__compaction_summary",
    isError: !entry.success,
    content: [{ type: "text", text: entry.success ? "ok" : (entry.error || "compaction failed") }],
    details: payload,
    timestamp: tsMs,
  };
  return [message, toolResult];
}
```

The `compactionId` field is **new** in the payload — Part C reads it to
target the REST endpoint. The renderer at
`src/ui/tools/renderers/CompactionSummaryRenderer.ts` is the only
consumer and must be extended (Part C §5.2) to surface the expand
affordance when this field is present.

### 3.6 Deletions

Part A renders these structurally impossible:

* `upgradeServerCompactionMarker` in `src/app/compaction-types.ts`
  (lines 205–238) — **delete**.
* Identical helper in `src/app/message-reducer.ts` (lines 137–168) —
  **delete**.
* Snapshot branch (c) in `message-reducer.ts:306–311` ("upgrade the
  server's text marker in place into a rich synthetic") — **delete**.
  Leave branches (a) and (b) intact (legacy text-form synthetic dedup
  is still meaningful for old client state). The supporting helpers
  `isLegacyTextCompaction`, `parseTokensBeforeFromServerMarker`,
  `isServerCompactionTextMarker` may stay — they still document the
  legacy shape and are referenced by other tests / fixtures. Leave
  them; don't proliferate the delete radius.
* `tests/message-reducer.test.ts` case (12c) at line 483 (`snapshot
  with only server text marker is upgraded to a rich synthetic`) —
  **delete**. Replaced by §6 sidecar-snapshot reducer test.

---

## 4. Part B — full-`.jsonl` reader + REST endpoint

### 4.1 New reader

Add a sibling export to `src/server/agent/transcript-reader.ts`. The
existing `readTranscript` already parses the full `.jsonl` (see
`parseJsonl` at line 121); the new function reuses it and slices by
`firstKeptEntryId` instead of paginating linearly.

```ts
// src/server/agent/transcript-reader.ts (additions)

export interface ReadOrphanedParams {
  /** Required. Sidecar entry id whose firstKeptEntryId defines the split. */
  compactionId: string;
  /** Optional pagination cursor — entry index (NOT id) of the last item
   *  returned by the previous page. Caller passes the value from
   *  envelope.nextCursor. */
  cursor?: number;
  limit?: number;  // 1..200, default 50
}

export interface ReadOrphanedEnvelope {
  /** Total orphaned entries for this compaction (independent of pagination). */
  total: number;
  returned: number;
  /** Pass back as `cursor` for the next page. Null when no more pages. */
  nextCursor: number | null;
  messages: CompactMessage[];  // re-uses existing compact rendering
}

export async function readOrphanedBeforeCompaction(
  params: ReadOrphanedParams,
  opts: {
    readContent: () => Promise<string | null>;
    /** First-kept entry id from the sidecar. Null → fallback scan. */
    firstKeptEntryId: string | null;
  },
): Promise<ReadOrphanedEnvelope>;
```

Branch-split rules:

* If `firstKeptEntryId` is non-null, walk `parseJsonl` output forward;
  the entry whose `uuid`/`id` matches `firstKeptEntryId` is the first
  *kept* entry. Everything strictly before it is orphaned. (The reader
  currently doesn't capture entry ids — extend `RawMessage` with an
  `entryId: string | null` field and populate from the JSONL line's
  `id` / `uuid` / `entryUuid` field, whichever pi-coding-agent uses.
  Coder: grep an actual `.jsonl` to confirm the field name; if it's
  not directly present, fall back to a positional index.)
* If `firstKeptEntryId` is null (legacy sidecar entry), fall back: scan
  forward for an entry whose `message.content` matches pi-coding-agent's
  own compaction-marker structure (a tool_result-like envelope tagged
  with a compaction-summary block; coder: confirm exact shape by
  inspecting a real post-compaction `.jsonl`). Treat that entry's
  position as the split.

### 4.2 REST endpoint

`GET /api/sessions/:id/transcript/before-compaction`

Add next to the existing `GET /api/sessions/:id/transcript` route in
`src/server/server.ts` (currently lines 6432–6490). Reuse:

* `sessionManager.getPersistedSession(targetId)` for resolution.
* `sessionFileRead(ctx, targetPs.agentSessionFile, sandboxManager)`
  for sandbox-aware reads (see `src/server/agent/session-fs.ts:104`).
  The `SessionFsContext` is `{ sandboxed: targetPs.sandboxed, projectId:
  targetPs.projectId }` — same call pattern the existing route uses
  at line 6476.
* Caller-project authorisation header check from the existing route
  (lines 6444–6452). UI-initiated calls go through Bearer auth so the
  header guard is best-effort.

Query params:

| Param            | Type     | Required | Notes |
|------------------|----------|----------|-------|
| `compactionId`   | string   | yes      | sidecar entry id |
| `cursor`         | int      | no       | from previous response's `nextCursor` |
| `limit`          | int      | no       | 1..200, default 50 |

Response (200):

```json
{
  "total": 47,
  "returned": 50,
  "nextCursor": 50,
  "messages": [
    { "index": 0, "role": "user", "ts": "2026-05-12T14:00:00Z", "text": "…" },
    /* … */
  ]
}
```

`nextCursor: null` when `returned < limit` or `cursor + returned >=
total`.

Error cases:

| Status | `error`                  | Trigger |
|--------|--------------------------|---------|
| 400    | `invalid_params`         | bad limit/cursor; missing compactionId |
| 403    | `permission_denied`      | cross-project caller |
| 404    | `session_not_found`      | unknown session |
| 404    | `transcript_unavailable` | `.jsonl` missing/unreadable |
| 404    | `compaction_not_found`   | sidecar has no entry with that id |
| 500    | `internal_error`         | catch-all |

Implementation skeleton (drop in below the existing transcript route at
`server.ts:6432`):

```ts
const orphanMatch = url.pathname.match(
  /^\/api\/sessions\/([^/]+)\/transcript\/before-compaction$/,
);
if (orphanMatch && req.method === "GET") {
  const [, targetId] = orphanMatch;
  const targetPs = sessionManager.getPersistedSession(targetId);
  if (!targetPs) { json({ error: "session_not_found" }, 404); return; }
  if (!targetPs.agentSessionFile) { json({ error: "transcript_unavailable" }, 404); return; }
  /* …same caller-project guard as the sibling route… */
  const compactionId = url.searchParams.get("compactionId");
  if (!compactionId) { json({ error: "invalid_params", detail: "compactionId required" }, 400); return; }
  const entry = findCompactionSidecarEntry(targetId, compactionId);
  if (!entry) { json({ error: "compaction_not_found" }, 404); return; }
  const ctx: SessionFsContext = { sandboxed: targetPs.sandboxed, projectId: targetPs.projectId };
  try {
    const envelope = await readOrphanedBeforeCompaction(
      {
        compactionId,
        cursor: url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
      },
      {
        readContent: () => sessionFileRead(ctx, targetPs.agentSessionFile!, sandboxManager),
        firstKeptEntryId: entry.firstKeptEntryId,
      },
    );
    json(envelope);
  } catch (err) {
    if (err instanceof TranscriptReaderError) {
      json({ error: err.code, detail: err.message }, err.code === "transcript_unavailable" ? 404 : 400);
    } else {
      jsonError(500, err, { error: "internal_error", detail: String(err) });
    }
  }
  return;
}
```

### 4.3 Sandboxed sessions

No special case at the route level — `sessionFileRead` already
dispatches host vs `docker exec cat` based on
`ctx.sandboxed` (see `session-fs.ts:104–148`). The fallback
`containerPathToHost` translation path covers dead-container recovery.

### 4.4 Legacy fallback

For sessions whose sidecar was written before `firstKeptEntryId` was
plumbed through (i.e. `entry.firstKeptEntryId == null`):

* Scan forward through `parseJsonl` looking for the first entry whose
  shape matches pi-coding-agent's compaction marker — coder must
  inspect a real `.jsonl` to pin the exact predicate before
  implementing. Candidates: an entry with
  `message.content[].type === "tool_use"` carrying a compaction tool
  name, or a synthetic system message with a known summary prefix.
* If no match is found, return `{ total: 0, returned: 0, nextCursor:
  null, messages: [] }`. The card just shows "no prior history
  available" (Part C §5.3).

---

## 5. Part C — client UI

### 5.1 Surface

Inline expansion above the existing compaction card. Owner: a new Lit
component `<bobbit-pre-compaction-history>` under
`src/ui/components/PreCompactionHistory.ts`.

Why a sibling component and not part of `CompactionSummaryRenderer`:

* The tool renderer is invoked per-message during the regular
  message-list render — it must stay synchronous and stateless.
* Pre-compaction history has its own async fetch state (loading, error,
  paginated load-more) and lifecycle that doesn't belong in the tool
  renderer registry.
* The reducer-owned message list keeps its `_order` invariants. The new
  component renders OUTSIDE that list, mounted by
  `CompactionSummaryRenderer` as a child element of the card body.

### 5.2 CompactionSummaryRenderer changes

* Read `payload.compactionId` (new field, see §3.5). If absent, render
  unchanged — this preserves behaviour for the live in-flight card
  (which uses the `compact_active` synthetic without a sidecar id).
* When present, render `<bobbit-pre-compaction-history compaction-id=…
  session-id=…>` at the top of the card body. The component is
  responsible for its own affordance / fetch / dimmed list.

Pass `session-id` either via attribute or via the surrounding render
context (the renderer's `params` doesn't currently carry it; coder will
need to thread it through, e.g. via a global `currentSessionId` accessor
on `AgentInterface` or by promoting the renderer registry signature.
Cheapest: pull from a module-level getter set by `AgentInterface` on
session-change).

### 5.3 PreCompactionHistory component

Behaviour:

1. On `firstUpdated`, fetch
   `GET /api/sessions/:id/transcript/before-compaction?compactionId=…&limit=1`
   purely to learn `total`. Cache the count.
2. If `total === 0` → render nothing (no affordance, no
   placeholder). The user never knows it tried.
3. If `total > 0` → render a single button row:
   `▾ Show N messages before compaction` (use the existing icon
   pattern from `mini-lit`, e.g. `ChevronDown`).
4. Click → flip to expanded; fetch the first page (`limit=50`).
   Render the messages as dimmed read-only rows (CSS: `opacity: 0.65;
   pointer-events: none;`). Use existing `CommentableMarkdown` /
   plain text rendering for the body, but skip every interactive
   affordance — no tool permission cards, no retry buttons, no
   thinking-block toggles.
5. If `nextCursor != null` after a page → render
   `▼ Load N more` at the bottom, fetching with `cursor=nextCursor`
   on click.
6. Collapse via the same chevron at the top. Open/closed state is
   component-local; not persisted across reload (intentional — the
   collapsed default keeps reload noise low).

Fetch-on-first-viewport-hit (acceptance criteria mentions this): wrap
the count fetch in an `IntersectionObserver` so cards that never
scroll into view don't issue requests. Use `rootMargin: "200px"` for
prefetch slack. Use a lazy `await import()` of the observer wrapper if
it adds bundle weight.

Styling:

* Container: `border-l: 2px solid var(--border)`, `padding-left:
  0.75rem`, `margin-bottom: 0.5rem`.
* Dimmed rows: `opacity: 0.65; user-select: text; pointer-events:
  none;` — the user can still copy text, but no click handlers fire.
* Match the renderer's existing theme token usage. No hardcoded
  colours.

Test hook: `data-testid="pre-compaction-history"`,
`data-state="collapsed|expanded|empty"`, `data-test="row-count"`.

### 5.4 No reducer changes

The renderer-side mount of `<bobbit-pre-compaction-history>` lives
outside the reducer-owned message list. No new actions. The synthetic
rows from §3.5 flow through the existing `__compaction_summary` path
that `hasCompactionToolCall` already recognises.

---

## 6. Tests

### 6.1 Unit (reducer)

Add to `tests/message-reducer.test.ts`, replacing case 12c at line 483:

```ts
it("(12c-replacement) sidecar synthetic in snapshot is rendered as rich card", () => {
  // Server-emitted synthetic carrying compactionId — must survive snapshot
  // round-trip and emerge as a rich __compaction_summary row.
  const syntheticMsg = {
    id: "c_1731602400000_a1b2c3",
    role: "assistant",
    timestamp: 1_731_602_500_000,
    content: [{
      type: "toolCall",
      id: "compaction-summary:c_1731602400000_a1b2c3",
      name: "__compaction_summary",
      arguments: { /* CompactionSummaryPayload v1 w/ compactionId */ },
    }],
  };
  const syntheticResult = { /* matching toolResult */ };
  const s = applyAll([{
    type: "snapshot",
    messages: [userMsg("u1", "x"), syntheticMsg, syntheticResult],
  }]);
  // Rich row survives unchanged; no upgrade-marker path runs.
  /* … */
});
```

Also delete the existing case 12c body (line 483, name `(12c) snapshot
with only server text marker is upgraded to a rich synthetic`).

### 6.2 API E2E (tests/e2e/)

* `transcript-before-compaction.spec.ts` (new). Spins the in-process
  gateway, seeds a session with two compactions in the sidecar and a
  hand-crafted `.jsonl`, asserts:
  - happy path: `total` count, page contents, `nextCursor` semantics.
  - bad compactionId → 404 `compaction_not_found`.
  - cross-project caller header → 403.
  - missing `agentSessionFile` → 404 `transcript_unavailable`.

### 6.3 Browser E2E (tests/e2e/ui/)

* `compaction-persistence.spec.ts` (new). Wires the gateway-harness
  pattern (see `tests/e2e/ui/settings.spec.ts`). Two scenarios:
  - **Navigate-away.** Drive a mock-agent compaction. Switch to a
    sibling session. Switch back. Assert
    `[data-testid='compaction-summary-card']` count is 1 and the
    state badge matches what was emitted live.
  - **Reload.** Same setup, then `page.reload()`. Same assertion.
* `pre-compaction-history.spec.ts` (new). Drives a session past
  compaction with a known set of pre-compaction user/assistant turns.
  Asserts:
  - The `▾ Show N messages before compaction` affordance appears once
    `total > 0` is resolved.
  - Click expands; assertion on
    `[data-testid='pre-compaction-history'][data-state='expanded']`,
    correct row count, dimmed styling (`opacity`), and absence of any
    interactive affordances inside the expanded block.
  - After `page.reload()`, the affordance is still present (collapsed
    by default) and clicking it re-fetches and re-expands.

All three browser specs must be wired into `npm run test:e2e` via the
existing playwright config (no manual integration tier).

---

## 7. Files

### Create

* `src/server/agent/compaction-sidecar.ts` — module mirroring
  `src/server/skills/skill-sidecar.ts`.
* `src/ui/components/PreCompactionHistory.ts` — Lit component.
* `tests/e2e/transcript-before-compaction.spec.ts`.
* `tests/e2e/ui/compaction-persistence.spec.ts`.
* `tests/e2e/ui/pre-compaction-history.spec.ts`.

### Modify

* `src/server/server.ts`
  - line 34 area: import `initCompactionSidecarDir`.
  - line 505 area: call `initCompactionSidecarDir(stateDir)` next to
    `initSkillSidecarDir`.
  - line ~6490 (immediately after the existing `transcript` route):
    add the new `before-compaction` route per §4.2.
* `src/server/ws/handler.ts`
  - lines 552–573: capture `startedAt`, append sidecar entry on success
    and failure paths per §3.3.1.
  - lines 614–626 area (`case "get_messages"`): wire
    `mergeCompactionSidecarIntoMessages` into the same pipeline as
    `mergeSkillSidecarIntoMessages`.
* `src/server/agent/session-manager.ts`
  - lines 1910–1914: stash `compactionStartedAt` + trigger on _start_;
    append sidecar entry on _end_ per §3.3.2.
  - lines 3268–3290 (`refreshAfterCompaction`): wire
    `mergeCompactionSidecarIntoMessages` into the broadcast pipeline.
* `src/app/compaction-types.ts` — add `compactionId?: string` to
  `CompactionSummaryPayload`; delete `upgradeServerCompactionMarker`
  + `isServerCompactionTextMarker` if no longer referenced after Part
  A lands (grep before deletion).
* `src/app/message-reducer.ts` — delete the duplicate
  `upgradeServerCompactionMarker` and the snapshot branch (c) at lines
  306–311. Leave branches (a) and (b).
* `src/ui/tools/renderers/CompactionSummaryRenderer.ts` — mount the new
  `<bobbit-pre-compaction-history>` child when `payload.compactionId`
  is set.

### Delete

* `src/app/compaction-types.ts::upgradeServerCompactionMarker` (lines
  205–238) and `isServerCompactionTextMarker` (lines 177–189) if
  unreferenced post-Part-A.
* `src/app/message-reducer.ts::upgradeServerCompactionMarker` (lines
  137–168).
* `tests/message-reducer.test.ts` case (12c) (lines 483–512). Replaced
  by §6.1's sidecar-snapshot test.

---

## 8. Constraints (carried verbatim from goal spec)

* Read-only by construction. Pre-compaction entries are NOT
  re-injected into the agent's context — the agent has decided they
  are abandoned.
* Pre-compaction entries render OUTSIDE the reducer-owned message
  list. The reducer's `_order` invariants stay intact.
* Sidecar is created lazily — no empty file for sessions that never
  compact.
* Sandboxed sessions: host-side sidecar (storage), `sessionFileRead`
  for transcript access — no new sandbox plumbing required.

---

## 9. Out of scope

* Persisting the full LLM-generated summary text from
  `CompactionResult.summary`. Sidecar carries metadata only; a "View
  summary" affordance can be a follow-up.
* Allowing branch-off from a pre-compaction state. Continue-archived
  already exists for that workflow.
* Searching pre-compaction history. The existing search index already
  covers the full `.jsonl`.

---

## 10. Open question for the coder

**Pi-coding-agent's `firstKeptEntryId` field name and `.jsonl` entry id
shape are not currently referenced anywhere in this repo.** Before
implementing the auto/manual append points (§3.3) and the JSONL-side
branch split (§4.1), the coder must:

1. Add temporary logging around the existing `compactResult` and
   `auto_compaction_end` event payloads to confirm the actual field
   name (`firstKeptEntryId` vs `first_kept_entry_id` vs `firstKeptId`).
2. Inspect a real session `.jsonl` (under `~/.pi-coding-agent/` or the
   sandbox equivalent) to confirm how each entry's id is serialised
   (`uuid`, `id`, `entryUuid`, or positional only). Update the reader's
   `RawMessage` extension in §4.1 accordingly.

If pi-coding-agent does not in fact expose `firstKeptEntryId`, the
fallback scan (§4.4) becomes the primary path and the sidecar's
`firstKeptEntryId` field can be reduced to a future-proofing slot
(always null in v1). The rest of the design holds without change.
