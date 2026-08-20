# Split archived SessionStore writes

## Purpose and boundaries

`SessionStore` keeps one eagerly loaded `Map<string, PersistedSession>`. Splitting persistence prevents the archived majority of a project's session history from being synchronously serialized, copied, and fsynced for every live-session update.

This is a write-path change only. `getArchived()`, `listArchivedSessionsPaginated()`, search, orphan cleanup, worktree inventory, and REST/WebSocket responses all read the same complete in-memory map immediately after construction. There is no archive fetch, spinner, first-access delay, startup deferral, or API change.

SQLite, lazy archive loading, hard-link backup rotation, and separate structural/activity API generations remain deliberately out of scope. SQLite may be appropriate later, but replacing this safety-critical JSON writer would discard its established epoch, fingerprint, backup, and write-fence protections for a much larger change.

## Files and envelopes

Each project state directory contains two independently versioned tiers:

```text
sessions.json                              live v3 tier
sessions.json.bak.1 ... sessions.json.bak.5
sessions.archived.json                     archived v3 tier
sessions.archived.json.bak.1 ... sessions.archived.json.bak.5
sessions.json.split-transition             short-lived pair-publication intent
sessions.json.pre-archived-split[.N]       retained v1/v2 migration evidence
```

Normal v3 publication writes compact envelopes:

```ts
{ version: 3, epoch: number, sessions: PersistedSession[] }
```

The live tier normally contains rows whose `archived` is not `true`; the archived tier normally contains rows whose `archived` is `true`. Load accepts a misplaced row so it can recover and normalize it on the next publication. Membership is always determined by `archived === true`, not by a legacy `archivedAt` value.

An epoch belongs to its tier. Live and archived epoch values are never compared or derived from a shared counter. A v1 bare array or v2 envelope is accepted only from the live candidate chain as a pre-split migration source. The archived candidate chain accepts v3 only. New writes always use v3.

## Eager load and ordinary recovery

Construction reads each tier's primary followed by its backups from newest to oldest. The first parseable v3 envelope for that tier wins. Both results are merged before any caller can observe the store, then the established legacy-field, delivery-ledger, and verifier normalization runs over the complete map.

A missing archived file means an empty archived tier for a new store or while migrating a legacy source. A corrupt primary still falls through to that tier's backups. Recovery does not compare epochs between independently recovered tiers: retaining parseable data from both is preferable to dropping a tier.

Outside a valid transition intent:

- A duplicate id in both tiers keeps the live row and reports a diagnostic. A later dirty publication canonicalizes membership from the row's `archived` flag.
- A row stored in the wrong tier is loaded, reported, and repaired on the next write.
- The retained `.pre-archived-split` file is migration evidence, not a normal v3 fallback.

## Independent persistence safety

Every tier keeps the protections that made the original writer safe:

- **Epoch and stale latch.** Before a tier's first process write, or when its fingerprint is not an exact match, the writer reads that tier's on-disk epoch. An on-disk epoch newer than the tier's loaded epoch latches and refuses that tier only. A live stale latch cannot be caused, cleared, or bypassed by archive state, and vice versa.
- **Fingerprint.** The fast path requires equal `size`, `mtimeMs`, and `ctimeMs`. Change time is required because size plus modification time is not a safe identity on coarse-resolution filesystems. A missing value, stat failure, changed file, or absent file forces an epoch read for that tier.
- **Write fences.** The process-wide `SessionStore.fileWriteTails` fence is keyed by resolved file path. Live-only writes fence `sessions.json`; archive-only writes fence `sessions.archived.json`; pair work acquires both paths in sorted order and releases in reverse order to avoid deadlock between store instances.
- **Atomic publication and backups.** Each tier independently rotates its own five backups, writes its own temporary file, fsyncs when the supplied filesystem supports it, and renames atomically. A live-only save neither serializes nor rotates/copies the archive tier.

A stale live-only save leaves archive bytes untouched. A stale archive-only save leaves live bytes untouched. A stale membership move fails before it writes a transition intent or either tier, so it cannot overwrite a winner's ownership or worktree metadata.

## Dirty routing and durability

Each mutation still increments the public global generation once. That generation is not split for polling or API purposes.

| Mutation | Tiers made dirty | Pair intent |
|---|---|---:|
| New or existing live `put` | live | no |
| New or existing archived `put` | archived | no |
| `put` that changes membership | live and archived | yes |
| Update, draft, tag restore, or activity update without membership change | current tier | no |
| `archive`, `archiveAsync`, or `update({ archived: true })` | live and archived | yes |
| `update({ archived: false })` | live and archived | yes |
| `remove` or `purge` | former tier | no |

A live activity burst serializes only live rows; an archived-only update serializes only archived rows. A membership move serializes both snapshots. A generation is published only after every tier dirtied through that generation has completed its rename. Mutations captured in an already serialized snapshot stay coalesced; mutations that arrive afterward schedule a trailing drain. `flushAsync`, `archiveAsync`, and `purgeAsync` remain durability barriers and reject on their required write failure.

`PersistenceMetrics` describes the completed drain rather than historical state: `liveBytes` and `archivedBytes` identify the actual tier payloads, and `bytes` is their sum. This makes the hot-path reduction observable without altering externally visible generation semantics.

## Epoch-bound membership transitions

Two file renames cannot be one filesystem transaction. A membership-changing batch therefore writes and fsyncs `sessions.json.split-transition` before publishing either tier. The v2 intent contains complete final rows (or a no-row hard-delete entry), the final tier for each id, and a binding for both tier epochs:

```ts
{
  version: 2,
  entries: [{ id, tier: "live" | "archived", session?: PersistedSession }],
  epochs: {
    live: { base, target: base + 1 },
    archived: { base, target: base + 1 },
  },
}
```

Entries are detached from mutable nested session state. The intent is recovery evidence, not a third data tier and not a substitute for either tier's authority. It is cleared only when its exact bytes remain bound and the pair is conclusively spent.

### Recovery truth table

On boot (and while retrying an interrupted recovery), the store classifies each observed tier epoch as `base`, `target`, or `outside` against the intent. A never-created tier is virtual epoch zero. An existing but unparsable tier is `outside`, never evidence that it is empty.

| Observed epochs | Meaning and action |
|---|---|
| `base` / `base` | Neither rename happened. Do **not** replay intent rows into the map. Clean up the exact spent intent under both fences. The original writer can retry its still-pending move with a fresh epoch-bound intent. |
| `target` / `target` | Both renames happened. Apply the intended final rows to resolve any duplicate/misplaced row in memory, then clean up the exact spent intent. No tier is rewritten merely to remove the intent. |
| One `base`, one `target` | Exactly one rename happened. The intent is authoritative for its ids: apply its final rows, repair only the missing tier to its target epoch, then remove the exact intent. |
| Either tier `outside` | The intent is stale, superseded, malformed, or cannot be bound to these snapshots. Do not replay it, overwrite either tier, or remove it. Preserve it for investigation. |

A legacy v1 intent, malformed intent, or an intent lacking exact epoch bindings is never recovery authority and is retained rather than silently deleted.

### Frozen recovery and coalesced writes

A partial pair freezes the complete post-intent live and archive row snapshots plus one recovery generation before asynchronous repair begins. Repair publishes only that frozen generation; a later in-memory update cannot leak into, or receive credit for, the old pair. Once the frozen repair completes, later dirty work drains separately, creating a fresh intent if it changes membership.

If a peer has removed the exact intent while a partial repair is pending, the repair restores the same v2 intent bytes before publishing the missing tier. It never replaces an existing different intent. This makes a second crash unambiguous. If both tiers are still at base, the active recovery is discarded without replay and pending entries are eligible for a new intent. If either epoch leaves the binding, the retry refuses rather than guessing. These rules let independently constructed stores converge while preserving the ordinary coalescing and trailing-drain guarantees.

## Legacy v1/v2 migration

A live v1/v2 candidate is the authoritative complete source for migration. The store normalizes every row, partitions by `archived === true`, and retains all records.

1. It retains the **exact original bytes** as `sessions.json.pre-archived-split`. Creation is exclusive; an identical retained source is reused, while a different collision gets the next `.N` suffix. Existing forensic evidence is never overwritten.
2. It publishes the archived v3 partition first, using that tier's independent epoch and backup chain.
3. It publishes the live v3 partition second. Its normal backup rotation retains the former legacy primary.
4. Only after both publications succeeds is the migration considered complete. The retained source stays in place.

If archive publication fails, the v1/v2 live source remains authoritative. If archive succeeds but live publication fails, a restart still takes the legacy live source as authoritative and repopulates archive from it; a partially published archive does not contribute rows. A completed v3 split is idempotent: the next construction reads both v3 tiers, creates no new retained source, and does not rewrite unchanged tiers.

## Tombstones, state migration, and operations

Hard deletion has one canonical tombstone namespace: `sessions.json`. `remove()` and `purge()` record that namespace whether the deleted row was live or archived; `purgeAsync()` records it only after the matching tier deletion crosses its durability barrier. Even an unknown-id `remove()` records a tombstone to prevent stale migration evidence from reviving it.

State migration treats `sessions.json` and `sessions.archived.json` as independent versioned envelopes and preserves each tier's shape, version, and epoch while routing project records. It also treats the two files as one logical session identity set when assessing backup-only recovery, so a row that moved tiers is not duplicated or resurrected from an old tier. The canonical `sessions.json` tombstone suppresses recovery from either tier; a recovery backup is retired only after every record is live in either current tier or tombstoned.

The Add Project **start fresh** path normally archives the project state as a whole. When the selected directory is the running gateway's own directory, its gateway-owned allowlist preserves both tiers, the transition intent, and every `sessions.json.pre-archived-split*` retention artifact; moving only `sessions.json` would make the pair inconsistent. The same state migration and archive rules apply to Headquarters migration paths.

Operational code that inspects session state must account for both tiers. In particular, the worktree fallback reads `sessions.archived.json` if the live-tier resolver is unavailable, so a worktree referenced only there is not mistakenly removed. Archive lists, search, orphan checks, and worktree inventory remain correct because `SessionStore` eagerly merges both tiers before they run.

For manual recovery, stop the gateway before editing state. Preserve the two primaries, their backup chains, any `split-transition`, and retained migration evidence together. A stale-guard refusal is intentional: inspect the named tier and its `.bak.*` files rather than copying a snapshot across tiers or changing an epoch. Prefer restart-driven recovery when a valid bound transition exists; an unbound or outside-bound intent is evidence to retain and investigate, not a file to delete casually.

## Verification coverage

The session-store suites cover live-size isolation, live-write archive isolation, eager round-trip parity and pagination, membership moves, v1/v2 migration retention and idempotence, independent tier guards/recovery, and the epoch-bound transition truth table. Real-filesystem coverage owns backup rotation, atomic rename and retained-source behavior. State-migration, start-fresh allowlist, and archived-tier worktree-fallback tests protect adjacent operational paths.

## Explicit non-goals

- Lazy archive loading or any archive-list UX/loading-state change.
- SQLite conversion or a new database dependency.
- Hard-link replacement for backup `copyFile`.
- Structural/activity generation splitting for `/api/sessions?since=`.
- Rewrites of search, archive pagination, orphan cleanup, or session APIs.
