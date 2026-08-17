# Gateway Startup Performance Audit

## Purpose

Gateway startup must restore durable state before it accepts traffic, but it should not repeat historical salvage work after that work has completed. This change separates one-time forensic recovery from every-boot consistency checks, and moves restart compilation outside the availability window without weakening eager session restoration or crash recovery.

Boot phase lines are written to `<headquarters>/state/boot-timings.log`. They measure process and server phases; client reload samples use the separate `boot-timing.jsonl` instrumentation.

## Historical handoff evidence

The following measurements came from the original candidate handoff. They are retained as context, not presented as a reproduction on the final implementation.

A Windows development installation with four project contexts and a large retained history recorded ten starts:

| Phase | Median | Range |
|---|---:|---:|
| Process prologue | 0.82 s | 0.76–1.16 s |
| `createGateway` construction | 33.93 s | 10.25–53.21 s |
| AI gateway check | 0.15 s | 0.12–0.23 s |
| MCP initialization | 1.96 s | 1.85–2.50 s |
| Team restoration | 74.48 s | 48.36–102.86 s |
| Session restoration | 22.42 s | 21.12–35.34 s |
| Cost backfill | 0.67 s | 0.61–1.23 s |
| **Process start to ready** | **131.87 s** | **111.17–175.86 s** |
| Post-ready background work | 32.43 s | 26.22–44.92 s |

The handoff characterized that installation as having 39 live sessions. A later candidate observation reported a 30.83-second process-to-ready boot, 4.51-second gateway construction, a team-forensic phase below the logging threshold, and 35 restored sessions. The 39-to-35 difference was not independently accounted for. These figures therefore describe separate historical observations and must not be read as a verified before/after session-retention result.

The historical data still identifies the relevant costs: broad team transcript salvage ran repeatedly, Headquarters migration revisited unchanged trees and rewrote large diagnostics, and the restart harness compiled after stopping the live gateway.

## Final implementation

### Team forensic recovery checkpoint

Each project state directory owns `.team-forensic-recovery.json`. The current team recovery policy writes version 1 records with `running` or `complete` status.

A missing, malformed, stale-version, `running`, or completion-fenced record runs the expensive historical passes: fully orphaned team-lead discovery, non-team-lead discovery, and legacy identity-sidecar backfill. Routine team-store cleanup and concrete dangling `teamLeadSessionId` recovery still run on every boot. A dangling pointer revokes completion before recovery and reopens the broader project pass so related agents can be recovered in the same boot.

Completion is published only after recovered session rows have crossed the session store's acknowledged persistence boundary. Atomic temporary-file publication, file synchronization, rename, and supported directory synchronization protect both `running` and `complete` records.

A sibling `.team-forensic-recovery.json.completion-pending` file is the final fail-closed fence. It exists before `complete` is published and is removed only when completion has been acknowledged. If fence removal or its directory acknowledgement fails, including an `EIO` after the fence has disappeared, the publisher recreates the fence before returning the original error. Successful compensation makes the next boot retry. If compensation also fails, an aggregate error preserves both failures because checkpoint authority is then indeterminate and requires operator repair; it must not be described as safely complete.

See [Checkpoint Team Forensic Recovery](design/checkpoint-team-forensic-recovery.md) for the full recovery boundary.

### Headquarters migration checkpoint

The default Headquarters layout uses policy version 3 of `.headquarters-dir-migrated`. Version 3 has explicit `running` and `complete` states and the same completion-pending fence protocol as team recovery. Missing, empty, malformed, older-version, `running`, fenced, or evidence-mismatched records perform a full migration pass. A failed pass retains or republishes retry authority unless both the original completion acknowledgement and its compensation fail; that aggregate failure requires storage repair before checkpoint authority can be trusted.

The fast path requires both resolved path topology and bounded recovery evidence to match:

- top-level legacy state and config topology, including real-path targets;
- content hashes for project registries, deletion tombstones, and migration backups;
- recovery qualification for backup keys against same-root live stores and tombstones.

The recovery qualification detects a same-root live store becoming missing, empty, or corrupt even when the backup itself did not change. Backup content changes invalidate by digest rather than mtime or size, and a previously absent legacy source becoming present invalidates through topology evidence. Evidence read errors fail closed into a full pass.

A clean match skips recursive legacy copying, project-store routing, config quarantine traversal, backup retirement, and diagnostics rewriting. It does **not** skip server-secret relocation, `projects.json` repair, or Headquarters execution-store sanitization. Secret handling remains fail-closed. Override and same-root B1 layouts retain their backup-retirement qualification because their source and target topology differs.

See [Headquarters migration and repair](headquarters.md#migration-and-repair-on-first-boot) for routing, tombstone, and backup semantics.

### Staged restart and crash recovery

A sentinel restart now validates dependencies and builds a complete candidate `dist` tree while the live gateway serves. The candidate rebuilds server/shared output and carries forward unrelated artifacts, such as existing UI output. The harness verifies required server entry points before it enters the stop window.

After the gateway stops and releases its port, the harness promotes the whole candidate tree. A durable promotion journal outside `dist` records the candidate and prior-live locations before either rename. All harness, watchdog, and Nord launch paths enter through the stable `scripts/harness-bootstrap.mjs`, also outside `dist`, so a later launch can resolve an interrupted promotion without importing a possibly absent or partial compiled harness:

- restore the previous tree when interruption occurred after moving live `dist`;
- retain a valid promoted candidate after the second rename;
- promote the candidate for an initial build with no prior `dist`;
- clean stale managed staging, backup, and journal artifacts;
- refuse to guess when the journal is corrupt or no recovery authority remains.

Validation or staged-build failure does not stop the current gateway or mutate live `dist`. If the gateway exits unexpectedly during preparation, normal crash accounting and relaunch policy remain in control and the staged candidate is discarded. Ordinary unexpected-crash relaunch still validates and launches the existing live `dist` without rebuilding; staged compilation is specific to an operator sentinel restart.

Operational details are in [Development workflow](dev-workflow.md#dev-with-harness-recommended).

## Independent final-SHA verification

The final implementation was exercised at SHA `c5aaee4f7` on Windows 11 with Node 24.13.1 and npm 11.8.0. An isolated candidate harness used port 4311 and an isolated empty state directory. Raw ignored artifacts are retained under `.bobbit-qa/hard-restart/` in the verification worktree.

The initial one-time boot reached listen in 313 ms, with `createGateway` taking 138 ms. Two consecutive, exact `npm run restart-server` cycles then recorded:

| Cycle | Signal to ready | Replacement process to listen | `createGateway` | Health |
|---|---:|---:|---:|---|
| 1 | 22.223 s | 264 ms | 97 ms | HTTP 200 immediately after the signal and after ready |
| 2 | 19.403 s | 267 ms | 94 ms | HTTP 200 immediately after the signal and after ready |

Signal-to-ready includes the staged build performed while the prior gateway remained available. After the second cycle, health reported `status: ok`, `sessions: 0`, and `orphanedTranscripts: 0`. Clean boots omitted the slow migration and team-forensic phases. The team checkpoint remained the same 33-byte `complete` record with unchanged mtime, and no completion-pending fence appeared.

This isolated run does **not** reproduce the handoff's 35-session observation or provide a production-sized eager-restoration sample: its state was intentionally empty. Eager restore ordering, failure handling, and checkpoint invalidation are supported by the focused 95+ regression tests and the passing full build, type-check, unit, browser, E2E, and review gates. Failed-build availability was verified by executable regression coverage; the operational run did not inject corruption into a live installation.

## Session restoration and archived ownership

Full eager restoration remains a pre-listen requirement. Team recovery settles before bounded archived-team ownership reconciliation, the live restore set is dispatched with exact suppression, and team event subscription follows session restoration:

```text
restoreTeams
→ reconcileArchivedTeamOwnership
→ restoreSessions(suppression)
→ resubscribeTeamEvents
```

The forensic checkpoint only bounds historical recovery; it does not confer live authority. Archived-goal ownership reconciliation independently scans the current live session and team sets before dispatch, so checkpoint completion cannot preserve a leaked archived session.

## Operational conclusions

- The final isolated sample demonstrates short replacement-process startup and two successful staged hard restarts, not the historical production-sized session count.
- Clean checkpointed boots avoid recurring historical transcript traversal, recursive legacy migration, and large diagnostics rewrites.
- Completion fences make acknowledged durability—not a visible rename alone—the authority for skipping recovery.
- Compilation remains part of signal-to-ready elapsed time but is outside gateway downtime.
- Eager live-session restoration remains intentionally on the readiness path; optimize its internals rather than deferring it.

## Archived-team reconciliation audit

This audit records the startup impact and restart evidence for archived-team ownership reconciliation. The guard closes a crash window before agent restoration; it is not a general historical migration or a replacement for the existing eager session restore path.

## Scope and method

The restart E2E creates an archived team-goal crash fixture with:

- a lead and worker carrying the archived goal's exact `teamGoalId`;
- a third metadata child-shaped row whose ancestry points at a `goalId`-only standalone control but whose own exact `teamGoalId` still makes it authoritative team ownership;
- a persisted TeamStore entry for the lead and worker; and
- the standalone control, which carries the same archived `goalId` but no `teamGoalId`.

It then durably writes the archived goal without calling the normal reconciliation callback, crashes the gateway, and performs two hard restarts. The mock bridge records every session process start. The test also captures session restore counts, repair/subscription log order, health, archived rows, and TeamStore file bytes and modification time.

This is a deterministic lifecycle fixture, not a production-data migration. The motivating production snapshot identified 19 current live session rows owned by archived goals, but the test did not modify or claim to have repaired those historical records. A deployed gateway applies the same bounded boot repair to whatever matching current rows and team entries are present, archiving them rather than deleting them.

## Measured restart results

| Check | First repair boot | Second clean boot |
|---|---|---|
| Matching archived-team rows | 3 archived: lead, worker, and exact-`teamGoalId` metadata child shape | Remained archived with unchanged archive metadata |
| Leaked session process starts | 0 across all 3 matching rows | 0 across all 3 matching rows |
| `goalId`-only standalone control | Eagerly restored | Eagerly restored again |
| TeamStore | Archived goal entry removed before event resubscription | Repaired file bytes and modification time unchanged |
| Repair writes/logging | One candidate goal; 3 sessions archived; 1 team removed; 0 blocked, suppressed, or errors | No reconciliation summary and no reconciliation writes |
| Health | `status: "ok"`; `orphanedTranscripts: 0` | `status: "ok"`; `orphanedTranscripts: 0` |

The first restart also established the dispatch barrier order: the boot repair summary preceded session restoration, and restoration preceded event resubscription for zero archived-goal teams. The control was the only regular fixture session restored; no delegate fixture session was restored.

The second restart compared both the repaired TeamStore contents and its filesystem modification time with the first-boot snapshot. Both were unchanged, while the control still spawned. This distinguishes write-idempotence from merely reaching the same logical JSON state through another rewrite.

## Timing result and limitation

The fixture measures run-local wall-clock restart time and pre-listen duration, and reads a reconciliation phase duration when that boot phase crosses the server's logging threshold. It asserts only that wall-clock restart includes the reported pre-listen work. The deterministic run did **not** retain a stable baseline sample or an exact before/after wall-clock delta suitable for this audit, so no latency number is claimed here.

This omission is deliberate: process startup, filesystem cache state, and the test host dominate a single wall-clock sample. Future performance claims should record repeated baseline and candidate samples on the same environment rather than treating lifecycle assertions as a benchmark.

## Startup work bound

Candidate discovery makes one pass over each project's current live sessions and current team entries, with indexed goal lookups. It does not scan archived session history, transcript files, proposal drafts, costs, or forensic recovery history. Its discovery cost is therefore:

```text
O(current live sessions + current team entries)
```

Reconciliation work is limited to candidate archived goals and their current authoritative root/descendant closure. A legacy candidate with authoritative ownership but no durable team marker adds at most one strict goal-marker publication before session archival. Marker failure preserves the current session and TeamStore evidence and suppresses the exact selected ids rather than broadening the scan. On a clean boot there are no candidates, no repair summary, and no reconciliation persistence write. Genuinely live sessions continue through the existing full eager restoration path; the guard does not add a top-N limit, dormant deferral, or lazy attach policy.

## Operational interpretation

A one-time repair boot can add one sticky team-marker write per legacy candidate, session archive writes proportional to the current leaked set, and TeamStore removal. The marker preserves local and remote branch/worktree evidence after current ownership rows disappear; archive writes preserve transcripts, drafts, costs, and metadata. A marker failure quiesces runtime but leaves persisted ownership unchanged. A failed session archive becomes an exact dispatch-suppression id and remains retryable in-process even without TeamStore; after restart, disk-live ownership reconstructs it. A failed TeamStore removal leaves passive retry evidence. None of these failures allows an archived owner to spawn.

Use the [archived-team reconciliation runbook](debugging.md#archived-team-reconciliation) for audit fields and restart checks. The ownership and boot-boundary design is documented under [Archived-team crash reconciliation](internals.md#archived-team-crash-reconciliation).
