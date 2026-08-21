# Checkpoint Team Forensic Recovery

## Status and context

Implemented. This design reduces `TeamManager.restoreTeams()` boot latency without changing readiness or live-session revival semantics. It distinguishes ongoing team consistency repair from historical transcript salvage that should run once per recovery-policy version.

## Problem

Team restoration previously mixed two responsibilities:

1. routine consistency repair for persisted team rows; and
2. historical forensic migration across every team-mode goal and trusted agent-session root.

The second category repairs old persistence failures, but its fully orphaned lead scan, worker scan, and legacy sidecar backfill do not need to traverse historical trees after their results are durable.

## Recovery boundary

Each project state directory owns `.team-forensic-recovery.json`. The current policy version is 1, with two checkpoint states:

- `running`: historical recovery has begun but has not durably completed;
- `complete`: the current recovery-policy version has finished and been acknowledged.

Missing, malformed, `running`, and older-version records run the forensic sweep. A clean, unfenced `complete` record suppresses only:

- fully orphaned team-lead discovery;
- non-team-lead agent discovery; and
- legacy session-sidecar backfill.

Routine checks remain every-boot behavior. Orphan team rows are removed, dangling `teamLeadSessionId` pointers trigger targeted transcript recovery, unrecoverable dangling entries are dropped, and stale recovered titles are upgraded. A concrete dangling pointer first replaces prior completion with `running`, then reopens the broader project sweep so sibling records can be recovered in the same boot.

The marker is per project so a newly registered or imported project receives its own initial recovery. A future policy change can increment the version to request another fleet-wide pass.

## Completion protocol

Before historical traversal, `begin()` atomically publishes `running`. If this durable revocation fails, the project does not perform forensic mutations during that boot; routine consistency checks still run. This prevents recovery from modifying durable session state while an old `complete` marker remains authoritative.

Recovery preserves existing identity rules: trusted roots remain ordered, the first trusted root wins during de-duplication, and an exact sidecar takes precedence over heuristic reconstruction. Sidecar writes are exclusive temporary-file publications followed by rename; a failed backfill fails the project pass rather than being reported as successful.

After all historical passes settle, the session store is flushed before completion. This matters because reconstructed rows can be queued for asynchronous publication; the checkpoint cannot become authoritative while those rows exist only in memory.

Checkpoint publication uses an exclusive temporary file, file synchronization, atomic rename, and supported directory synchronization. Completion has an additional sibling fence:

```text
.team-forensic-recovery.json.completion-pending
```

The sequence is:

1. durably publish or acknowledge the completion-pending fence;
2. durably publish `complete`;
3. remove the fence and acknowledge that removal.

`isComplete()` returns false whenever the fence exists, even if the visible checkpoint says `complete`. If fence removal or its final directory sync fails, including an `EIO` observed only after the fence is absent, the publisher recreates the fence before returning the original error. Successful compensation keeps the next boot retryable. If compensation also fails, an aggregate error retains both failures because checkpoint authority is indeterminate; stop the gateway, repair the state directory, remove the checkpoint and any fence, then restart to force recovery.

Windows uses rename as the atomic publication boundary because Node does not support opening directories for synchronization there. POSIX filesystems additionally receive directory synchronization where supported; real I/O failures such as `EIO` are not classified as unsupported.

## Ordering and integration

The server's current pre-listen order is:

```text
restoreTeams → restoreSessions → resubscribeTeamEvents
```

Recovered persisted rows therefore exist before eager live-session revival, and event subscriptions attach only after live session objects exist.

PR #1216 (`Fix Archived Team Leaks`) adds archived-goal reconciliation to the same boundary. If it lands before this work is rebased, preserve this semantic order:

```text
restoreTeams
→ reconcileArchivedTeamOwnership
→ restoreSessions(suppression)
```

Reconciliation must determine the suppressed archived-session set before dispatch. A checkpoint may skip historical tree traversal; it must never preserve leaked archived sessions as live or bypass #1216's ownership suppression.

## Operations

To force a project rescan, stop the gateway and remove the project's `.bobbit/state/.team-forensic-recovery.json` and any sibling completion-pending fence. The next boot publishes `running`, performs the historical passes, flushes recovered rows, and publishes acknowledged completion.

Do not remove the checkpoint merely to diagnose ordinary team-store consistency: dangling-pointer and orphan-row checks already run every boot. Inspect gateway logs for checkpoint begin/complete warnings and confirm whether the sibling fence exists before treating a visible `complete` record as authoritative.

## Risks and mitigations

- **Both the team row and session row disappear after completion:** no authoritative pointer proves new damage. Source-side persistence and sidecars prevent the known causes; an operator can remove the checkpoint for explicit salvage. A newly identified systemic cause should fix the mutation source and bump the policy version when a broad rescan is needed.
- **Begin publication fails:** forensic mutations are skipped for that project, so stale completion cannot hide partially published repair. The next boot retries.
- **Recovered-session flush or sidecar write fails:** completion is withheld and the project retries.
- **Crash or completion acknowledgement failure:** `running` or a successfully retained/republished completion-pending fence remains retry authority. An aggregate compensation failure requires operator repair and explicit checkpoint removal before restart.
- **Corrupt or stale checkpoint:** it is incomplete and safely replaced after recovery.

## Verification

Focused coverage exercises missing, running, corrupt, stale-version, and completed states; first-boot recovery and clean-boot zero tree I/O; dangling-pointer invalidation; recovered-session flush failure; atomic publication interruption; completion directory-sync failure; and compensation after fence-clear `EIO`. Broader session tests retain sidecar precedence, trusted-root ordering, and eager restoration behavior.
