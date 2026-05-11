# Session-recovery boot-pass cascade

Status: implemented on `goal/audit-subg-225e4d3d` (commits a4c6e890,
d9a0b7b4, 050228d3, 237b0d00, 9cd3ffd5). Companion to
[`session-store-crash-safety.md`](./session-store-crash-safety.md) — both
are about not silently losing session-shaped state across a crash, but
crash-safety defends the canonical metadata index (`sessions.json`)
write path, and this doc defends the *reconstruction* path when that
index lost or never had entries that the on-disk transcripts say should
exist.

---

## 1. The invariant

After any boot, three sources of session truth must converge:

- `sessions.json` — the canonical session-metadata index.
- `team-state.json` — the team-store, mapping team-mode goals to their
  team-lead session id.
- The agent CLI's `*.jsonl` slug-dirs on disk — the transcripts.

The recovery cascade enforces:

- **No team-store entry may reference a session id that is not in
  `sessions.json`.** Dangling team entries cause the team-lead UI to
  jam ("Team already active" with no agents to show).
- **No team-lead session record may be destroyed while it is still
  live.** The *refusal guard* in `purgeOneSession` blocks destructive
  paths from removing a session whose team-store entry still claims it
  and whose owning goal is not archived.
- **Team-mode goals whose team-lead session was lost — but whose
  `.jsonl` transcripts still exist on disk — must be reconstructed
  best-effort** into a fresh session record so the user can see and
  continue the work. Best-effort because the original session id is not
  preserved on disk (see §4).

These three invariants address three real failure modes that surfaced
together during the May-2026 crash-safety work; the crash-safety doc
covers the *prevention* side, this doc covers the *recovery* side.

## 2. Architecture as built

The recovery work splits cleanly into pure decision logic and thin I/O
glue, mirroring the pattern set by
[`session-store-crash-safety.md`](./session-store-crash-safety.md).

### 2.1 Pure helpers — `src/server/agent/team-store-consistency.ts`

No I/O, fully unit-testable (52 cases in
`tests/team-store-consistency.test.ts`):

- `findOrphanTeamEntries(teams, sessions)` — team-store entries whose
  `teamLeadSessionId` does not resolve to any record in `sessions.json`.
- `canPurgeTeamLeadSession({ session, teamStore, goal })` — the refusal
  predicate consumed by `SessionManager.purgeOneSession` and the DELETE
  `/api/sessions/:id` handler. See §3.
- `pickCanonicalTeamLeadJsonl(candidates)` — given the `*.jsonl` files
  found in a goal's slug-dir, picks the most-recently-appended one
  (mtime first, then size). Used when reconstructing a session record
  from disk and several candidate transcripts coexist.
- `reconstructTeamLeadSessionRecord({ goal, jsonlPath, funName, archived })`
  — synthesises a fresh `PersistedSession` from a surviving transcript:
  new UUID, fun-name title, goal binding, role `"team-lead"`, and (for
  archived goals) `archivedAt` stamped from the transcript's mtime.
- `isStaleRecoveredTeamLeadTitle(title, goalTitle)` — predicate that
  matches the *legacy* recovered-title shape (`Team Lead: <goal-title>
  (recovered)`) so pass-4 can rename idempotently without touching
  titles that are already in the modern shape.

### 2.2 I/O glue — `src/server/agent/team-manager.ts::restoreTeams()`

Four boot passes that run in order. Each is independently safe to re-run
on every restart; together they converge the three sources of truth.

#### Pass 1 — drop entries for archived/gone goals (pre-existing)

Walk the team-store. Drop any entry whose owning goal is archived or no
longer exists. This was already in place before today's recovery work
and is unchanged; it is listed here for completeness because the order
of the later passes depends on it.

#### Pass 2 — drop dangling team entries (commit a4c6e890)

After pass-1, walk the team-store again. For every surviving entry,
check whether `teamLeadSessionId` resolves to a record in
`sessions.json`. If it does not, the entry is dangling — drop it.

Why this exists *as well as* the refusal guard (§3): the refusal guard
prevents *new* danglers from being created going forward, but historical
installs already have danglers from before the guard landed. Pass-2 is
defence-in-depth that cleans those up on every boot without requiring
manual intervention.

**Why pass-2 cannot run before pass-1.** Pass-1 legitimately removes
entries whose goal is archived or gone; running pass-2 first would also
remove those entries but for the wrong reason, masking the actual signal
("dangler") in logs.

#### Pass 3 — reconstruct from surviving transcripts (050228d3, 237b0d00)

For every team-mode goal in the project, if:

- there is no team-store entry for it (so the team-lead UI cannot
  resurrect itself the normal way), AND
- there is no live team-lead session record bound to the goal, AND
- there *is* at least one `*.jsonl` file in the agent CLI's slug-dir for
  the goal's worktree path,

then `pickCanonicalTeamLeadJsonl` selects the most-recent transcript and
`reconstructTeamLeadSessionRecord` synthesises a fresh session record
from it. The record is written into `sessions.json` and (for live goals)
a new team-store entry is created pointing at the new session id.

For archived goals, the reconstructed record is also marked archived
with `archivedAt = jsonl.mtime`. This keeps it under the sidebar's
archived branch instead of polluting the live forest.

**Why pass-3 must run after pass-2.** Pass-3's "no team-store entry"
check would be wrong if pass-2 hadn't yet cleaned up the danglers — it
would see a dangler, conclude "team-store thinks this goal already has a
team-lead", and skip reconstruction.

#### Pass 4 — rename stale legacy titles (commit 9cd3ffd5)

Scan all session titles. Any title matching the legacy shape
`Team Lead: <goal-title> (recovered)` is renamed in-place to the modern
shape `Team Lead: <fun-name> (recovered)`, using the same fun-name
generator that pass-3 uses for new reconstructions. Idempotent — the
predicate matches *only* the legacy shape, so re-running the pass on
already-modernised titles is a no-op.

Why pass-4 is separate: pass-3 reconstructs missing records, pass-4
normalises titles on records that already exist. The two could run in
either order; pass-4 is placed last for clarity.

### 2.3 Order summary

```
restoreTeams():
  pass 1 → drop entries for archived/gone goals       (pre-existing)
  pass 2 → drop entries whose teamLeadSessionId       (a4c6e890)
           doesn't resolve in sessions.json
  pass 3 → for each team-mode goal lacking both an    (050228d3,
           entry and a live team-lead, reconstruct     237b0d00)
           from surviving .jsonl
  pass 4 → rename stale legacy "(recovered)" titles    (9cd3ffd5)
           to fun-name shape
```

## 3. The refusal guard — `purgeOneSession`

`SessionManager.purgeOneSession` consults `canPurgeTeamLeadSession()`
before destroying any session record. The predicate refuses purge when
**all** of the following hold:

- `session.role === "team-lead"`,
- `session.teamGoalId` is set,
- `teamStore.get(teamGoalId).teamLeadSessionId === session.id`,
- the owning goal is **not** archived.

On refusal, `purgeOneSession` logs a warning instructing the caller to
call `teardownTeam(goalId)` first (which clears the team-store entry,
removing the third condition).

The DELETE `/api/sessions/:id` handler (commit d9a0b7b4) is the
companion fix: a DELETE on an already-archived session is now idempotent
— it returns `200 { alreadyArchived: true }` rather than silently
destroying the record. The `?purge=true` query parameter is the
explicit-opt-in escape hatch for callers (operators, migration scripts)
that genuinely want to destroy the record. This closes the production
footgun where re-archiving an already-archived session — easy to do
from the UI, easy to do from a script — silently wiped the underlying
record and its team-lead binding.

## 4. Why pass-3 cannot recover the original session id

`reconstructTeamLeadSessionRecord` mints a **fresh UUID** for the
reconstructed session. The original session id is not recoverable
because nothing on disk preserves it.

The agent CLI keys its slug-dir by `slugify(cwd)` — the worktree path —
not by session id. The `.jsonl` filename does embed a timestamp, but
the gateway's session UUID is independent and lives only in
`sessions.json`. Once that index has lost the entry, there is no path
back to the original id.

The reconstructed record therefore has:

- A new UUID (different from the original).
- A fun-name title with the `(recovered)` suffix, so the user can tell
  it is reconstructed.
- The same transcript content (it points at the same `.jsonl` file).
- The same goal binding (`teamGoalId`, `projectId`).
- For archived goals, `archivedAt` stamped from the transcript's mtime.

A future **session-sidecar** file — written alongside each `.jsonl`,
recording the gateway's session UUID, role, goal-id, and fun-name — would
make pass-3 an *exact* recovery: same id, same title, same metadata.
Sibling subgoal `a71963d9` is investigating this. Until it lands, pass-3
remains best-effort.

## 5. Deviations / decisions worth flagging

- **Pure helpers vs I/O glue.** All decision logic in
  `team-store-consistency.ts`; `team-manager.ts::restoreTeams` is the
  thin I/O wrapper. This is the pattern that
  [`session-store-crash-safety.md`](./session-store-crash-safety.md) set
  up (`orphan-cleanup.ts` vs `session-manager.ts`); the recovery work
  follows it deliberately so the same testing discipline applies.
- **No new REST surface** beyond the DELETE-idempotency tweak. The
  recovery is boot-time only and surfaces through the existing sidebar
  UI — no new endpoints, no new WS events.
- **No new tools.** The recovery does not introduce any MCP tools or
  agent-visible operations.
- **No direct `session.status =` writes, no direct WS emits.** Pass-3's
  reconstructed records flow through `SessionStore.upsert`; status
  writes for any session continue to go through `broadcastStatus`, and
  events through `emitSessionEvent` — the existing single-writer
  invariants are preserved.

## 6. Touched files

Production:

- `src/server/agent/team-store-consistency.ts` (new) — the five pure
  helpers described in §2.1.
- `src/server/agent/team-manager.ts::restoreTeams` — wires the four
  boot passes to disk, `SessionStore`, `TeamStore`, and `GoalManager`.
- `src/server/agent/session-manager.ts::purgeOneSession` — consults
  `canPurgeTeamLeadSession()` before destroying any session record.
- `src/server/server.ts` (DELETE `/api/sessions/:id` handler) — returns
  `{ alreadyArchived: true }` for archived sessions unless `?purge=true`
  is passed.

Tests:

- `tests/team-store-consistency.test.ts` — 52 cases across the four
  helpers and the refusal predicate.

## 7. Operator runbook

If a team-mode goal's team-lead session has vanished and the sidebar
shows the goal with no agents:

1. **Restart the gateway.** Pass-2 will drop any dangling team-store
   entry; pass-3 will reconstruct the team-lead from the surviving
   `*.jsonl` if one exists.
2. **Check the gateway boot logs.** Look for `[team-manager]` lines
   reporting how many entries pass-2 dropped and how many records
   pass-3 reconstructed.
3. **If nothing was reconstructed**, the agent CLI's slug-dir for the
   goal's worktree path has no `*.jsonl` — the transcript itself is
   gone and there is nothing to recover. The goal can be archived
   manually.

If a DELETE `/api/sessions/:id` returned `{ alreadyArchived: true }`
when you expected the record to be destroyed:

- The session was already archived. The DELETE is intentionally
  idempotent to prevent silently destroying records.
- Add `?purge=true` to the request URL to force destruction. Pre-flight
  the caller will be subject to the `canPurgeTeamLeadSession` refusal
  guard if the session is a live team-lead.

If a recovered team-lead has a fresh UUID and a fun-name title rather
than its original id and title:

- This is expected: pass-3 reconstruction is best-effort because the
  original id is not preserved on disk (§4). The transcript content
  and goal binding are intact; only the id and title differ. See §4
  for the design rationale and the sidecar follow-up.

## 8. References

- Companion design doc:
  [`session-store-crash-safety.md`](./session-store-crash-safety.md).
- Debugging-index entries: see `docs/debugging.md` under
  *Team-lead session disappears*,
  *purgeOneSession refuses to destroy session*, and
  *Recovered team-lead session has fresh UUID*.
