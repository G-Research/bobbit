# Session-store crash-safety

Status: implemented on `goal/sessions-p-14dc3ec7`. Companion to
[`unify-session-status.md`](./unify-session-status.md) (single-writer
status invariant) — both are about not silently losing session-shaped
state across a crash.

---

## 1. The incident

Date: **2026-05-09**. The gateway crashed mid-day. On restart, almost all
live sessions were gone from the UI.

Forensic snapshot of the affected install's `.bobbit/state/sessions.json`:

- 1459 entries total. **1455 archived, 4 live.**
- The most recent non-archived `createdAt` was **2026-05-06T11:11:49Z**, even
  though the user had actively created and run goals (and a multi-agent team)
  on May 7–9.
- 9 sessions carried `archivedAt ≈ 2026-05-09T17:57:43Z` (the post-crash
  boot time) — the boot orphan-cleanup sweep had bulk-archived them.
- The agent CLI's `*.jsonl` transcripts on disk were **healthy** the whole
  time: 300 KB+ team-lead and coder transcripts existed for the goal that
  was supposedly gone.

Net effect: the gateway's session-metadata index lost ≥1455 entries silently
between May 6 and May 9, and then the next-boot sweep "cleaned up" what was
left because the heuristic was too aggressive.

## 2. Why this happened (and what we now defend against)

Three independent failure modes contributed. Each is now blocked by a
distinct guard.

### 2.1 Non-atomic JSON write

`SessionStore.saveNow()` previously did `fs.writeFileSync(storeFile, json)`.
On Windows, with a 1 MB+ file, an interrupted write (power loss, OOM kill,
antivirus locking the file mid-stream) could leave `sessions.json` truncated
or corrupt. There was no `.tmp + rename`, no `fsync`, no backup rotation.

**Bug class prevented:** torn writes to the canonical metadata index.

### 2.2 Stale-snapshot rollback

A more subtle failure: if `sessions.json` got rolled back to an older
revision **out-of-band** — by OneDrive / Dropbox / iCloud sync, by an
antivirus quarantine-and-restore, or by a user manually replacing it from
a `.pre-migration` backup while the gateway was running — the next
`SessionStore.load()` would happily seed an in-memory map from the stale
file. Newly-created sessions would live only in RAM until the next save,
which would clobber any newer state on disk.

There was no way for the store to notice it had been time-travelled. Each
process treated whatever it loaded as the truth.

**Bug class prevented:** load-then-clobber when something replaces
`sessions.json` underneath a running gateway.

### 2.3 Over-aggressive orphan archive sweep

The boot sweep that archived the 9 May-7–9 sessions used a coarse rule:
"if I can't reattach to this session's agent process / `.jsonl` /
worktree, archive it." That rule fires correctly for sessions whose
worktree was deleted or whose CLI never wrote a frame, but it also fires
for sessions whose `agentSessionFile` path moved, whose container was
restarted, or whose lookup raced startup — even though the worktree dir
and a fresh `.jsonl` are sitting right there on disk.

**Bug class prevented:** confusing "I can't reattach right now" with
"this session is dead."

## 3. The fix

Four parts. Each addresses one failure mode and is independently testable.

### 3.1 On-disk format v2 with epoch field

`sessions.json` previously was a bare JSON array of `PersistedSession`.
The new shape is:

```json
{
  "version": 2,
  "epoch": 12345,
  "sessions": [ /* PersistedSession[] */ ]
}
```

`epoch` is monotonically incremented on every successful save. Legacy v1
arrays still load (their epoch is treated as 0), so an in-place upgrade
is automatic on the first save after upgrade.

The wrapper exists for one reason: to give the stale-snapshot guard
(§3.3) a comparable scalar that survives across processes. It is **not**
the in-memory `generation` counter, which resets every restart.

### 3.2 Atomic write with `.bak.1..5` rotation

`saveNow()` now:

1. Rotates `sessions.json → .bak.1`, `.bak.1 → .bak.2`, …, `.bak.5`. The
   oldest is dropped. The current file is **copied** (not renamed) into
   `.bak.1` so the live file remains present if the next step fails.
2. Writes the new payload to `sessions.json.tmp`, then `fsync`s the file
   descriptor, then `rename`s `.tmp → sessions.json`. On POSIX `rename` is
   atomic; on Windows it is atomic enough for our purposes (the file is
   never half-written from a reader's point of view).
3. `fsync` failures are logged but non-fatal — Windows network shares
   reject `fsync`, and the rename still gives us crash-safety against
   process death.

`load()` falls back through `.bak.1..5` in order if the primary is
missing or unparseable, logging which backup it accepted.

Why 5 backups: enough to survive a few "bad save" cycles in a row (e.g.
the stale-guard tripping on every save while the user diagnoses a sync
client) without filling the disk for state that is at most a few MB.

### 3.3 Stale-snapshot guard (with merge-recovery — CON-05, updated 2026-07-05)

On every `saveNow()`, before writing, peek the on-disk epoch. If it is
**higher** than what we loaded AND we have not yet written this process
(`writtenEpoch === 0`), something rewrote `sessions.json` out from under us.

**Original design (superseded):** refuse to save and trip a one-shot,
process-lifetime latch — no further writes, ever, until the user
investigates and restarts. This over-corrected: the guard's job is to
avoid clobbering newer state, but converting that into a *silent,
permanent, whole-store persistence outage* meant a user could keep
creating/archiving sessions and queuing prompts in a perfectly responsive
UI while literally nothing landed on disk for the rest of the gateway's
uptime — a much larger, harder-to-diagnose loss window than the one-time
event that triggered it (see CON-05 in the Fable refactor audit).

**Current behavior:** merge-recover inline, in the same `saveNow()` call
that detected the trip, instead of latching:

1. Fully read+parse the on-disk file (not just its epoch). If it doesn't
   parse as a well-shaped v2 payload (torn read mid-external-write, corrupt
   shape), fall back to the original refuse-and-latch behavior — we don't
   trust content we can't validate.
2. Otherwise **merge, don't clobber**: adopt every on-disk session whose id
   we don't already hold in memory (the other writer's sessions are kept
   intact); for any id present in both, keep our in-memory copy (assumed to
   hold this process's own newer, unsaved mutation for that specific row).
3. Rebase `loadedEpoch` to the on-disk epoch we just folded in, and fall
   through to the normal write path — the merged state is written this
   same call, so the recovery is one atomic step, not a retry loop.
4. Record the event (`staleGuardRecoveries` count + `lastStaleGuardRecoveredAt`
   timestamp) so it stays visible via `getStaleGuardStatus()` — surfaced
   through `GET /api/health` (`sessionStoreStaleRecovery`) and a splash-screen
   UI banner — even though the store itself has already self-healed.

```
[session-store] Stale-snapshot RECOVERED: on-disk epoch <N> was newer than
loaded epoch <M> (second gateway / cloud-sync / antivirus / .pre-migration
restore?). Merged <A> on-disk-only session(s) into memory, kept this
process's <K> in-memory session(s) as-is, and resumed persistence. Verify
recent session activity — see docs/design/session-store-crash-safety.md.
```

Why this doesn't reintroduce the "retrying on every save... clobbers the
newer file" risk the original design worried about: that concern was about
a *blind* retry-write racing a transient bad read. This is not a retry loop
— it's a single deliberate merge that folds the disk content in rather than
discarding it, and it only fires once: after this save either the merge
succeeded (so `writtenEpoch` is now non-zero and the guard's precondition
`writtenEpoch === 0` can never hold again for this process) or the file
was unparseable and the original permanent-latch fallback still applies.

Per-id conflict resolution (in-memory wins) is a deliberate choice: the
in-memory row for an id we already track is assumed to be *this* process's
own subsequent edit to that session, which the guard exists to protect —
not the external writer's. Only sessions this process has never heard of
are adopted verbatim from disk.

The guard checks `writtenEpoch === 0` so it only catches the
load-then-clobber sequence. Once we've written once, our in-memory state
strictly dominates anything that appeared on disk later (it can only have
got there via our own `rename`).

### 3.4 Tightened orphan archive sweep

The new gate predicate `shouldKeepDespiteOrphan(ps)` lives in
[`src/server/agent/orphan-cleanup.ts`](../../src/server/agent/orphan-cleanup.ts).
Returns `true` when **both**:

- `ps.worktreePath` exists on disk, AND
- `ps.agentSessionFile` was modified within the last 24 h.

Five archive sites in `SessionManager` now consult this gate before
calling `SessionStore.archive()`:

- Pre-restore worktree-recovery branch.
- Three `restoreSessions()` archive paths (missing transcript, container
  recreation, recovery failed).
- The boot bulk-archive sweep that triggered the 2026-05-09 incident.

Gated entries are kept as **dormant** sessions (not running, but visible
and resumable from the UI) and a one-line warning is logged:

```
[orphan-cleanup] WARN: would-archive <id> but worktree+recent-transcript
present — leaving live
```

The user can still archive manually from the UI if the session really
is dead. The cost of a false-positive (one dormant entry that should be
gone) is far lower than the cost of a false-negative (silent data loss).

Sandboxed sessions naturally fall through this gate: their
`worktreePath` is a container-internal path that the host's
`fs.existsSync` cannot see. That's correct — sandbox health is checked
by a separate path.

## 4. Orphan-transcript divergence signal

After `restoreSessions()` completes, `SessionManager` walks the agent CLI's
session-files root and compares every `*.jsonl` against the union of
`agentSessionFile` paths held by the store. Anything not tracked **and**
newer than the most recent `lastActivity` in the store (or, for an empty
store, newer than 24 h ago) is logged as:

```
[session-store] WARN: orphaned transcript: <abs path>
```

Caps: 20 log lines, 50 paths recorded. The total count is exposed via
`SessionManager.orphanedTranscriptsCount` and surfaced through
`GET /api/health` as `orphanedTranscripts`. The splash UI renders a
one-line banner when the count is non-zero:

> N agent transcripts on disk are not tracked — see logs

**There is no auto-import.** This is a divergence signal only. Auto-
importing would conflate three different scenarios:

1. The session-metadata index actually lost entries (the bug we are
   fixing) — a transcript should be imported.
2. The transcripts come from a previous Bobbit install in the same state
   directory — they should NOT be imported; they're noise.
3. The user manually copied a transcript in for debugging — they did not
   ask to have it become a session.

We let the human disambiguate. The banner makes the divergence visible;
that's enough.

## 5. What's explicitly out of scope

These came up during design and were rejected. Each is a real idea but
not worth the surface area for the failure rates we're defending against.

- **Switching to SQLite.** Atomic JSON write + epoch guard is sufficient
  and cheap. SQLite would buy us page-level torn-write protection that
  rename-with-fsync already gives us, plus query semantics we don't need.
  The migration cost (and the operational cost of forever-after carrying
  a SQLite dependency on Windows) is not justified.
- **Auto-importing orphaned `*.jsonl` files on boot.** See §4.
- **A permanent `bobbit sessions reconstruct` recovery CLI.** The
  2026-05-09 incident was reconstructed via a one-shot script
  (`scripts/reconstruct-sessions.cjs`). Once the must-haves above land,
  this class of data loss should not recur. Building a permanent recovery
  CLI for an incident we expect to never see again is overinvestment;
  the script is enough.

## 6. Touched files

Production:

- `src/server/agent/session-store.ts` — v2 on-disk shape, atomic write,
  `.bak.1..5` rotation, `peekDiskEpoch()`, stale-guard merge-recovery in
  `saveNow()` via `readDiskSnapshotForMerge()` (CON-05), `getLoadedEpoch()` /
  `getWrittenEpoch()` / `isStaleGuardTripped()` / `getStaleGuardStatus()`
  test hooks.
- `src/server/agent/orphan-cleanup.ts` (new) — `shouldKeepDespiteOrphan()`
  and `scanOrphanedTranscripts()` extracted from `session-manager.ts` so
  unit tests can exercise the helpers without dragging in the rest of
  `SessionManager`.
- `src/server/agent/session-manager.ts` — five archive sites gated on
  `shouldKeepDespiteOrphan`; post-`restoreSessions()` orphan-transcript
  scan; `orphanedTranscriptsCount` field; `getStaleSessionStoreStatus()`
  (CON-05) aggregating every project's `SessionStore.getStaleGuardStatus()`.
- `src/server/agent/project-context-manager.ts` — `getStaleSessionStoreStatus()`
  aggregation across `this.contexts` (CON-05).
- `src/server/server.ts` — `GET /api/health` now returns
  `orphanedTranscripts` and `sessionStoreStaleRecovery` (CON-05).
- `src/app/state.ts` / `src/app/session-manager.ts` /
  `src/app/render.ts` — splash-screen banners gated on
  `state.orphanedTranscriptsCount` and `state.sessionStoreStaleRecovery`
  (CON-05).

Tests:

- `tests/session-manager-orphan-keep.test.ts` — `shouldKeepDespiteOrphan`
  truth table.
- `tests/session-store-*` — atomic-write crash simulation, stale-load
  guard + merge-recovery (CON-05), backup fallback, v1→v2 migration.

## 7. Operator runbook

If you see `[session-store] Stale-snapshot RECOVERED …` in the logs, the
store already merged and resumed persisting on its own — this is a
visibility signal, not an outage:

1. **Don't panic-restart.** The gateway is still durably persisting; a
   restart is not required to restore write capability.
2. **Verify no data loss.** Compare `.bobbit/state/sessions.json` against
   `.bak.1..5` from around the recovery time. The log line states how many
   on-disk-only sessions were adopted and how many in-memory sessions were
   kept as-is — spot-check a couple of each if the counts look surprising.
3. **Find out who rewrote the file** (informational, not urgent): the usual
   culprits are a second gateway/CLI instance against the same state dir,
   OneDrive/Dropbox/iCloud sync restoring a stale copy, antivirus
   quarantine-and-restore, or a manual `.pre-migration` restore. If it's a
   second gateway, stop the duplicate instance.
4. Check `GET /api/health`'s `sessionStoreStaleRecovery` field (or the
   splash-screen banner) — it stays populated for the process's lifetime so
   this is discoverable after the fact, not just in the log scrollback.

If you instead see `[session-store] REFUSING to save …` (the on-disk file
existed but could not be parsed well enough to merge — a genuinely rare
case, e.g. a torn read mid-external-write), the original process-lifetime
latch applies:

1. **Stop the gateway.**
2. **Inspect the on-disk state.** Compare `.bobbit/state/sessions.json`
   against `.bak.1..5`. The `epoch` and `sessions.length` of each tells
   you which is newest.
3. **Find out who rewrote the file** — see step 3 above.
4. **Pick the canonical file** (usually the one with the highest
   `epoch`), copy it to `sessions.json`, restart the gateway.

If you see the orphaned-transcripts banner:

- Check the agent CLI sessions root listed in the `[session-store] WARN:
  orphaned transcript: …` lines.
- If the transcripts are from a previous install, they are safe to
  archive or delete; the banner will go away on next restart.
- If they correspond to sessions you remember running and `sessions.json`
  is missing them, you have hit the rollback bug — see step 3 above and
  file a report.
