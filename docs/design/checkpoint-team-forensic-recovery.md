# Checkpoint Team Forensic Recovery

## Status

Implemented. This change is limited to `TeamManager.restoreTeams()` boot latency and does not change server listen ordering or session revival.

## Problem

Team restoration mixed two different responsibilities:

1. routine consistency repair for persisted team rows; and
2. historical forensic migration across every team-mode goal and every trusted agent-session root.

The second category recovered valuable transcripts after old persistence bugs, but its fully-orphan lead scan, worker scan, and legacy sidecar backfill ran on every startup. On installations with several historical session roots, the six-pass restore phase took 48–103 seconds even when a prior boot had already repaired all recoverable data.

## Design

Each project state directory owns `.team-forensic-recovery.json`. The record contains a recovery-policy version and one of two states:

- `running`: the historical sweep began but did not durably finish;
- `complete`: the current recovery-policy version finished.

Writes use a temporary file and atomic rename. Missing, malformed, `running`, and older-version records all run the forensic sweep. A clean `complete` record suppresses transcript-tree traversal for that project.

The checkpoint gates only the expensive historical work:

- fully-orphan team-lead discovery;
- non-team-lead agent discovery; and
- legacy session-sidecar backfill.

Routine in-memory/store checks still run every boot. In particular, orphan team rows are removed, dangling `teamLeadSessionId` pointers still trigger targeted transcript recovery, and stale recovered titles are still upgraded. Finding a dangling lead invalidates an existing completion before repair and reopens the broader project sweep, so sibling agents can be recovered in the same boot. A process exit or reported recovery failure leaves `running`, causing the next boot to retry.

The marker is per project rather than global. A newly registered or imported project therefore gets its own initial forensic recovery. Recovery-policy changes can deliberately increment the version to perform a new one-time sweep.

## Recovery boundary

New sessions write exact sidecars in the normal session lifecycle, and team-lead purge cleans the team store at the source. The broad scan is therefore a migration/salvage path for historical damaged state, not a standing index rebuild. The persisted-team dangling-pointer path remains the ongoing safety net for concrete new damage.

Operators can force a project rescan by removing `.bobbit/state/.team-forensic-recovery.json`; the next boot writes `running`, performs all historical passes, and publishes `complete` only after they settle.

## Risks and mitigations

- **Both the team row and session row disappear after completion:** there is no authoritative pointer proving new damage, so the broad scan does not automatically reopen. Current source-side persistence and sidecars prevent the known causes; deleting the checkpoint provides an explicit salvage path. A future newly identified cause should fix its mutation source and bump the recovery-policy version when a fleet-wide rescan is warranted.
- **Checkpoint write fails:** restoration remains available; the project stays uncheckpointed and retries next boot. The failure is logged but does not prevent gateway startup.
- **Crash during recovery:** `running` is written before historical traversal, so the next boot retries instead of trusting partial work.
- **Corrupt or stale checkpoint:** it is treated as incomplete and safely replaced after recovery.

## Tests

- `tests2/core/team-manager-async-recovery.test.ts` verifies first-boot recovery, zero transcript-tree I/O on the next clean boot, and checkpoint invalidation for a dangling lead.
- `tests2/core/team-recovery-checkpoint.test.ts` verifies missing, running, corrupt, stale-version, and completed checkpoint states plus temporary-file cleanup.
