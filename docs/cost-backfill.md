# Cost Backfill and Legacy-Zero UI

## Why this exists

`CostTracker.recordUsage` stamps a `goalId` on every cost entry so tree-cost
rollups survive session purge — the `sessions.json` entry can be wiped but the
cost data lives on in `session-costs.json`. That forward-stamp fix shipped in
commit `a4050f59`. Any entry that existed on disk *before* that commit has no
`goalId`, and if its source session has since been purged the cost entry is
effectively orphaned: `computeTreeCost` cannot attribute it to any goal, so
every affected subgoal shows `$0.0000 / 0 tokens` even though it clearly did
real work.

The boot-time cost backfill recovers as many missing `goalId`s as possible.
Two passes run in order:

1. **Sidecar pass** — synchronous, runs before `server.listen()`, authoritative.
2. **Transcript pass** — async, fire-and-forget after `listen()`, confidence-gated.

Any entry that survives both passes is surfaced as `Unattributable (legacy)` in
the tree-cost panel rather than silently dropped.

---

## Pass 1 — Sidecar pass

**Source:** `src/server/agent/cost-backfill.ts` → `backfillLegacyCostGoalIds`

**When:** Synchronous, runs once per project context immediately after
`sessionManager.restoreSessions()`, before `listen()`.

**How it works** — for each unstamped cost entry, tries two resolution paths:

1. **Live persisted session record** (`sessionManager.getPersistedSession`).
   Prefers `teamGoalId`, falls back to `goalId`, then reads the sibling
   `*.bobbit.json` sidecar if `agentSessionFile` is present.

2. **Sidecar index scan** — walks `<agentSessionsRoot>/<slug>/*.bobbit.json`
   two levels deep, builds a `bobbitSessionId → teamGoalId` map in one shot,
   and looks up each remaining unmapped session. The index is built lazily —
   only when path 1 fails for at least one entry — because the filesystem scan
   is comparatively expensive.

**Idempotent:** already-stamped entries are skipped; subsequent boots with no
new unstamped entries are pure no-ops (no persistence write, no generation
bump).

**Log output:**
```
[cost-backfill] stamped goalId on N entries; M still unattributable
```

---

## Pass 2 — Transcript pass

**Source:** `src/server/agent/cost-backfill.ts` → `backfillLegacyCostGoalIdsFromTranscripts`

**When:** Async, runs as part of `runBootBackgroundTasks` (after `listen()`).
Fire-and-forget — it does not block the gateway from accepting connections.
When it finishes, it bumps the `CostTracker` generation, which invalidates
cached tree-cost rollups so the next request picks up the new attributions.

### Why transcripts work

Bobbit injects goal context into the first turn of every spawned session: the
working-directory path (`goal-<slug>-<id8>/`), the `BOBBIT_GOAL_ID` env var,
and the goal spec/title block. Even sessions whose `sessions.json` entry and
sidecar are both gone still have their `.jsonl` transcript on disk until it is
manually swept. The goalId appears verbatim in the first ~50 lines of any
team-lead, coder, reviewer, or verifier transcript.

### Transcript filename shape

The agent CLI names transcripts:
```
<agentSessionsRoot>/<slug>/<isoTimestamp>_<sessionId>.jsonl
```
A handful of older test fixtures use the legacy shape `<sessionId>.jsonl`
(no timestamp prefix). `findTranscriptPath` accepts both.

### Defensive bounds

| Bound | Default | Rationale |
|---|---|---|
| Lines per transcript | 50 | The goalId always appears in the first turn; reading more is wasted I/O. |
| Bytes per transcript | 64 KiB | Guards against pathologically large first lines. |
| Total runtime per project | 30 s | Keeps boot-background overhead bounded even on large installs. |

When the 30-second deadline is hit, the pass logs how many sessions were
skipped and exits normally — those entries remain in the unattributable bucket.

Every file read is wrapped in `try/catch`; a malformed or truncated `.jsonl`
is silently skipped.

### Confidence rules

**Hard rule: a wrong attribution is worse than `unattributable`.** The pass
never stamps an entry unless it can satisfy one of the following:

| Signal | Confidence | Example |
|---|---|---|
| `BOBBIT_GOAL_ID=<id>` in the transcript text | High | Env-injection block |
| `--goal <id>` or `--goal=<id>` | High | CLI spawn flags |
| Worktree path segment `goal-<slug>-<id8>` where `id8` is the first 8 chars | High | Working-directory line |
| Goal-context keyword within ~400 chars of the id occurrence | Medium | `# Goal`, `Goal Spec`, `Current Goal`, `Working Directory`, `Goal nesting context` |

**Skip conditions (never stamp):**

- The id appears only in a prose paragraph with no nearby goal-context marker.
- The transcript yields two or more *distinct* goal ids that are both known
  goals (ambiguous — could be a team-lead referencing a sibling goal).
- The id appears in the transcript but is not present in `goalStore.getAll()`
  (unknown goal — may be from a different project or a deleted goal).

**Log output:**
```
[cost-backfill] transcript-pass stamped goalId on N additional entries; M still unattributable
[cost-backfill] transcript-pass stamped goalId on N additional entries; M still unattributable (deadline reached; K session(s) skipped)
```

---

## Unattributable legacy bucket

Entries that survive both passes remain **unstamped** (`goalId` stays unset).
They are not rewritten to a sentinel on disk. `CostTracker.getUnattributableLegacyCostWithMetadata()` aggregates these unstamped entries and the API presents the aggregate under the response-only sentinel `UNATTRIBUTABLE_LEGACY_GOAL_ID = "__unattributable__"`.

It returns:

- Total cost, `tokensIn`, `tokensOut` (same shape as any other goal cost).
- `firstSeenAt` — the **minimum** `firstSeenAt` timestamp across all unstamped
  entries that have one. This is the oldest known timestamp in the bucket and is
  used by the UI as a threshold for distinguishing "legacy zero" goals from
  genuine zero-cost goals.

The tree-cost REST endpoint exposes this as `unattributableLegacy` in the
response payload:

```json
{
  "unattributableLegacy": {
    "goalId": "__unattributable__",
    "title": "Unattributable (legacy)",
    "costUsd": 1073.80,
    "tokensIn": 2200000,
    "tokensOut": 2200000,
    "firstSeenAt": 1746918000000
  }
}
```

The bucket is only included when it has non-zero cost or tokens.

---

## UI — Legacy $0 row treatment

**Sources:**
- `src/app/tree-cost-legacy.ts` — classification logic and tooltip copy.
- `src/app/goal-dashboard.ts` — render path.

### Classification

`isLegacyUnattributableTreeCostRow(goal, entry, treeCost)` returns `true` when
all four conditions hold:

1. `treeCost.unattributableLegacy` exists and has non-zero spend.
2. The breakdown entry is exactly zero on every axis (`costUsd`, `tokensIn`,
   `tokensOut` all `=== 0`).
3. The goal is known (looked up from live goals and dashboard descendants).
4. The goal's `createdAt` is strictly older than the **legacy threshold**.

### Legacy threshold

The threshold is resolved dynamically — never hardcoded:

1. **Preferred:** `treeCost.unattributableLegacy.firstSeenAt` — the oldest
   timestamp the server found in the unattributable bucket.
2. **Fallback:** `EARLIEST_SIDECAR_TIMESTAMP_MS` (2026-05-11 00:00:00 UTC),
   representing approximately when the session-sidecar feature landed. This
   constant is defined in `tree-cost-legacy.ts` and pinned by unit tests;
   do not move or inline it.

### Rendering

Legacy-zero rows are styled with:
- `color: var(--muted-foreground)` and `font-style: italic` on the row.
- A `(legacy)` suffix in muted colour after the goal name.
- A `title` attribute tooltip:
  > `$0.0000 (legacy) — this goal predates per-goal cost tracking. Its spend is included in the Unattributable (legacy) bucket at the bottom of this list.`

The `Unattributable (legacy)` bucket row itself is rendered as a sticky
`border-top` row at the bottom of the breakdown table, distinct from the
per-goal rows. It is not a child of any goal in the tree and is never included
in subtree totals.

---

## Data flow summary

```
boot
 │
 ├─ sessionManager.restoreSessions()
 │
 ├─ backfillLegacyCostGoalIds()          [sidecar pass — sync, before listen()]
 │    ├─ Path 1: live persisted session record (teamGoalId / goalId)
 │    └─ Path 2: *.bobbit.json sidecar index scan
 │
 ├─ server.listen()   ← gateway accepts connections
 │
 └─ runBootBackgroundTasks() [async, fire-and-forget]
      └─ backfillLegacyCostGoalIdsFromTranscripts()  [transcript pass]
           ├─ reads up to 50 lines / 64 KiB per *.jsonl
           ├─ confidence-gates every hit
           ├─ bumps CostTracker generation on success
           └─ 30s total deadline; skipped sessions stay unattributable

GET /api/goals/:id/tree-cost
 └─ computeTreeCost()
      ├─ per-goal breakdown (goalId-stamped entries)
      └─ unattributableLegacy bucket (unstamped entries, + firstSeenAt)

UI tree-cost panel
 ├─ per-goal rows
 │    └─ legacy-zero rows → muted italic + "(legacy)" + tooltip
 └─ Unattributable (legacy) row (sticky bottom, italic, only if non-zero)
```

---

## Tests

| File | Coverage |
|---|---|
| `tests/cost-backfill-transcript-pass.test.ts` | Transcript pass: working-directory hit, two-id ambiguity, unknown goal id, truncated file, missing file |
| `tests/tree-cost-legacy.test.ts` | `isLegacyUnattributableTreeCostRow`, `resolveLegacyThresholdMs`, threshold fallback constant |
| `tests/e2e/ui/tree-cost-rollup.spec.ts` | Browser E2E: legacy-zero row styling, `(legacy)` suffix, unattributable bucket render |
