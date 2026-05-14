# Harden session recovery + reconcile branch with latest master

## Background — what happened today

A series of restarts of bobbit on the `goal/audit-subg-225e4d3d` branch surfaced a
data-loss class where team-lead session records (and their agents) silently
disappeared from `sessions.json`, leaving:
- Orphan `team-state.json` entries pointing at deleted session ids
- "No agents — Start Team" buttons that threw `"Team already active"` on click
- Goal sidebar rows missing their team-leads and subagents
- Apparent loss of chat history for the affected goals

The **chat history was not actually lost** — the agent `.jsonl` files survive
under `~/.bobbit/agent/sessions/<slug-dir>/`, keyed by worktree path rather
than by bobbit session id. For the two top-level goals visible in the sidebar
("Audit subgoals branch" + "Extract generic fixes") there were 12 and 7
surviving `.jsonl` files respectively, and ~50 more across the 18 subgoals.

Today's commits on this branch addressed it in two layers:

**Prevention** (so destruction can't happen the same way again):
- `a4c6e890` — `purgeOneSession` now also cleans the team-store entry when
  destroying a team-lead, so 7-day archive sweeps can't leave orphan
  team-state entries.
- `d9a0b7b4` — `purgeOneSession` REFUSES to destroy a team-lead while the
  team-store still references it for a non-archived goal. `DELETE
  /api/sessions/:id` is now idempotent for archived sessions (no auto-purge;
  must pass `?purge=true` explicitly).

**Recovery** (so existing damage is restored on next boot):
- `050228d3` — Boot-time auto-recovery for orphan team-store entries (rebuilds
  the session record from the surviving `.jsonl`).
- `237b0d00` — Fully-orphan recovery (no team-store entry at all) +
  fun-named recovered titles instead of goal-title placeholders.
- `9cd3ffd5` — Tree-level recovery: renames stale recovered titles + scans
  for agent slug-dirs and reconstructs subagent sessions with role parsed
  from the worktree pattern.

All five boot passes have unit-test coverage in
`tests/team-store-consistency.test.ts` (52 cases).

## What's still incomplete in recovery

The boot-time recovery is best-effort — it reconstructs as much as can be
inferred from disk artifacts (goals.json + `.jsonl` files + slug-dir names).
What it CANNOT recover:

1. **Original bobbit session id** — recovery generates a fresh UUID. Any
   reference to the old id (`spawnedBySessionId`, `delegateOf`, gate-store
   step `sessionId`, verification harness `active.steps[i].sessionId`,
   search-index entries) is permanently dangling.
2. **Original fun-name title** — replaced with a freshly-rolled name.
3. **`teamLeadSessionId` on recovered agents** — only inferrable via
   worktree-naming heuristic. Works for the standard `goal-<lead-name>-
   <role>-<id>` shape; breaks for any non-standard naming.
4. **Inline-roles snapshots, mid-flight gate-step pointers, draft state,
   `lastReadAt`, color, accessory overrides** — all gone with the session
   record.
5. **Cross-tree references** — any other session that pointed at the
   destroyed session by id breaks silently.

The root cause is structural: bobbit-side session metadata (id, role,
teamGoalId, teamLeadSessionId, title, accessory, model preferences) lives
ONLY in `sessions.json`. The agent's `.jsonl` is owned by the pi-coding-agent
process and doesn't carry any bobbit-side identifiers. When sessions.json
loses an entry, the bobbit-side context for that entry is permanently lost.

## Goal

Add a per-session SIDECAR alongside each agent `.jsonl` that records the
bobbit-side metadata needed for exact recovery. Then update the boot recovery
to prefer sidecar reads over heuristic reconstruction, while keeping the
heuristic path as a defensive fallback for sessions that predate the
sidecar.

Also: merge the latest `origin/master` into this branch, resolve any
conflicts, and verify everything still passes bobbit's gates.

## Acceptance criteria

1. **Per-session sidecar written at session creation time.**
   - File location: `~/.bobbit/agent/sessions/<slug>/<jsonl-basename>.bobbit.json`
     (alongside the `.jsonl`, same lifecycle as it on disk).
   - Schema (minimum):
     ```json
     {
       "version": 1,
       "bobbitSessionId": "20dba486-26e8-417d-b6dc-013094da0153",
       "agentSessionId": "019dfee7-578f-7773-8e32-9e1ba838a4ad",
       "role": "team-lead" | "coder" | "code-reviewer" | "qa-tester" | "...",
       "teamGoalId": "225e4d3d-...",
       "teamLeadSessionId": "20dba486-...",
       "delegateOf": "..." | null,
       "spawnedBySessionId": "..." | null,
       "title": "Team Lead: Jira Springer",
       "accessory": "crown",
       "createdAt": 1747242000000,
       "modelProvider": "anthropic",
       "modelId": "claude-opus-4-7"
     }
     ```
   - Atomic write (tmp → rename) so a crash mid-write leaves either the old
     state or the new, never a partial file.
   - Written at `SessionManager.persistSessionMetadata` time, alongside the
     existing `agentSessionFile` write — same fire-and-forget pattern.

2. **Boot recovery prefers sidecar metadata.**
   - In `team-manager.ts::restoreTeams`, when a `.jsonl` is found for recovery,
     check for a matching `.bobbit.json` sidecar in the same dir first.
   - If sidecar present and `version` matches: use its fields verbatim —
     original session id, title, teamLeadSessionId, accessory, model
     prefs, all of it. Recovery becomes exact.
   - If sidecar absent: fall through to the existing heuristic recovery
     (fresh UUID, fun-name title, role parsed from worktree slug).

3. **Sidecar survives `purgeOneSession`** — but is only deleted alongside the
   `.jsonl`. If we keep the `purgeOneSession` refusal guard from `d9a0b7b4`,
   the sidecar shouldn't get destroyed while the goal is live; when the goal
   IS archived and purge is allowed, both sidecar and `.jsonl` go together.

4. **Pure helpers + unit tests** following the pattern already established
   in `team-store-consistency.ts`:
   - `writeSessionSidecar(jsonlPath, meta)` — atomic write, idempotent on
     identical content.
   - `readSessionSidecar(jsonlPath)` — returns `meta | null`.
   - `reconcileRecoveredSessionWithSidecar(record, sidecar)` — applies
     sidecar fields over the heuristic-reconstructed record.
   - Tests in `tests/team-store-consistency.test.ts`: at least 8 cases
     covering atomic write, version-mismatch fallback, sidecar-present
     vs absent, idempotent re-writes.

5. **Migration / backfill** for the user's already-recovered sessions: on
   the first boot after this lands, walk every session whose title matches
   `/\(recovered\)/` and write a sidecar from its current persisted state
   so that future restarts have the sidecar to read from. Idempotent.

6. **No regression in feature gates**: all gates must pass on the branch
   AFTER the merge from master:
   - `npm run check` (type-check)
   - `npm run test:unit` (full unit + tests)
   - Existing gate suite if any custom ones for this branch

7. **Master is merged in**:
   - Pull latest `origin/master`.
   - Resolve any conflicts (AGENTS.md, docs/, code).
   - Take care to preserve all 5 today's commits' behaviour. The boot
     recovery code in `src/server/agent/team-manager.ts::restoreTeams`
     and `src/server/agent/team-store-consistency.ts` is the most
     likely conflict zone — if master added concurrent changes there,
     reconcile manually rather than auto-resolve.
   - Re-run all unit tests post-merge to confirm no regression.

## Plan

Suggested decomposition into subgoals (or `team_spawn` tasks if you prefer):

1. **Merge master** (~30 min) — `git fetch origin && git merge origin/master`,
   resolve conflicts, re-run `npm run check && npm run test:unit`, confirm
   the 52 team-store-consistency tests still pass.

2. **Add sidecar write at session creation** (~1 hr) — implement
   `writeSessionSidecar` pure helper + wire it into `persistSessionMetadata`
   in `session-manager.ts`. Unit-tests for the pure helper.

3. **Add sidecar read at boot recovery** (~1 hr) — implement
   `readSessionSidecar` pure helper. Update `restoreTeams` recovery passes
   to consult the sidecar before falling through to heuristics.

4. **Backfill migration** (~30 min) — boot pass that walks recovered
   sessions and writes sidecars from current persisted state. Idempotent.

5. **End-to-end tests** (~45 min) — extend
   `tests/team-store-consistency.test.ts` with the sidecar happy path
   + version-mismatch fallback + write-then-recover round-trip on a real
   tmpdir.

6. **Verify all gates pass** (~15 min) — `npm run check && npm run test:unit`
   green. Any per-feature gates this branch tracks (charter,
   plan-review, etc.) must still pass.

## Non-goals (out of scope)

- Don't refactor pi-coding-agent's `.jsonl` format. Sidecar lives next to it
  but is owned by bobbit.
- Don't redesign `sessions.json` itself — the sidecar is an ADDITIONAL store,
  not a replacement.
- Don't touch the existing recovery heuristics. They become a fallback for
  pre-sidecar sessions; they stay correct on their own.

## Notes for the team-lead

- The destruction surface has been closed structurally (commits
  `a4c6e890`, `d9a0b7b4`). The recovery surface (commits `050228d3`,
  `237b0d00`, `9cd3ffd5`) handles existing damage AND defends against
  unknown future bugs. The sidecar work proposed here is the next layer:
  making recovery EXACT instead of best-effort.
- The user has already verified recovery works for the 2 top-level
  team-leads + at least some subagents. Whatever's reconstructed today
  uses fresh UUIDs and fun-name titles — the sidecar work will make
  FUTURE recoveries preserve original identities.
- Coordinate with `tests/team-store-consistency.test.ts` — it's already
  at 52 cases and is the established pattern for testing recovery code.
  New tests should extend it, not create a parallel test file.
