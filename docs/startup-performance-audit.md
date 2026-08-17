# Gateway Startup Performance Audit

## Scope and measurement

The gateway now tees boot phase timings to `<headquarters>/state/boot-timings.log`. The audit uses ten completed starts from the same Windows development installation plus a controlled `npm run restart-server` run. Timings are wall-clock durations from process start to a ready listener; post-ready worktree sweeping, pool fill, and transcript cost backfill are reported separately.

The measured installation has four project contexts and 39 live sessions. Its retained history is unusually large, which makes repeated recovery work easy to see.

## Baseline

Across the ten retained starts:

| Phase | Median | Range | Startup role |
|---|---:|---:|---|
| Process prologue | 0.82 s | 0.76–1.16 s | binaries, token, TLS |
| `createGateway` construction | 33.93 s | 10.25–53.21 s | migrations and synchronous store/context setup |
| AI gateway check | 0.15 s | 0.12–0.23 s | network/provider discovery |
| MCP initialization | 1.96 s | 1.85–2.50 s | MCP catalogue startup |
| Team restoration | 74.48 s | 48.36–102.86 s | team consistency and historical transcript recovery |
| Session restoration | 22.42 s | 21.12–35.34 s | live agent process revival |
| Cost backfill | 0.67 s | 0.61–1.23 s | legacy metadata repair |
| **Process start to ready** | **131.87 s** | **111.17–175.86 s** | user-visible gateway startup |
| Post-ready background work | 32.43 s | 26.22–44.92 s | sweeper, pool fill, transcript backfill |

The controlled restart completed in 111.17 seconds after the new process began. Its critical path was:

- team restoration: 73.90 s (66.5%);
- session restoration: 23.53 s (21.2%);
- gateway construction: 10.25 s (9.2%);
- MCP initialization: 1.85 s (1.7%);
- all other measured work: 1.64 s (1.5%).

The old harness also stopped the live gateway before compiling server TypeScript. In the controlled run there were about 55 seconds between the shutdown marker and the next process boot marker. That build time was avoidable downtime in addition to gateway boot.

## Validated steady-state result

The first fixed boot retained the one-time salvage behavior and completed in 109.35 seconds, including 57.38 seconds of team recovery, then atomically wrote the project checkpoints. The next boot showed no `restore-teams` phase above the 50 ms logging threshold.

That checkpointed boot became ready in **78.57 seconds**: 30.78 seconds (28.1%) faster than the immediately preceding run and 53.30 seconds (40.4%) faster than the ten-run baseline median. The saved team phase was partly masked by unrelated run-to-run variance: session revival rose from 19.25 to 43.24 seconds and tool-doc generation rose from 1.20 to 15.76 seconds during the second run. The important controlled observation is that 57 seconds of repeated team traversal disappeared while all 35 live sessions restored and health remained clean.

After adding the Headquarters migration evidence checkpoint, its upgrade pass took 5.64 seconds and published the versioned marker. The next boot omitted both `restore-teams` and `migrateLegacyHeadquartersDirectory` from the ≥50 ms phase log. Gateway construction fell to **4.51 seconds**, and process start to ready fell to **30.83 seconds**—101.04 seconds (76.6%) faster than the original ten-run median. All 35 sessions restored and gateway health remained clean. The marker and 2.14 MB full diagnostics remained byte-for-byte untouched during the steady-state boot.

## Root causes

### 1. Historical team salvage ran on every boot

`TeamManager.restoreTeams()` combined routine consistency checks with forensic recovery introduced for old persistence defects. It repeatedly scanned every team-mode goal across the active, historical, and legacy agent-session roots to recover fully orphaned team leads and workers, then checked every session for a missing identity sidecar.

The recovery is valuable once, but successful results are durable and current session creation writes sidecars at the source. Repeating the same tree traversal accounted for roughly half to two-thirds of total startup time.

### 2. The restart harness put compilation inside downtime

A sentinel restart killed the current gateway, waited for its port, validated dependencies, compiled all server TypeScript, and only then launched the replacement. Compilation does not require the current process to be stopped, so users unnecessarily experienced the build as application downtime.

### 3. Synchronous gateway construction is the next variable cost

Prior checkpoints grouped most constructor time into a broad pre-migration bucket. On slow starts this bucket reached roughly 42–44 seconds; project-context opening then took 3–7 seconds, and tool detail-document generation usually took 0.9–1.6 seconds. The constructor now records Headquarters migration, legacy model seeding, residual state/project-registry setup, per-project migration, context opening, and tool-doc generation separately.

The two fixed boots attributed **22.56 seconds** and **10.27 seconds** directly to `migrateLegacyHeadquartersDirectory`. Its current always-run path revisits the legacy tree and retained migration backups even after the completion marker exists; one observed diagnostics payload contained more than 23,000 preserve/skip rows and 1,859 already-routed records. This is now the clearest follow-up target, but its fast path must preserve secret relocation, tombstones, and the ability to recover genuinely unaccounted backup keys.

### 4. Live session revival is material but UX-sensitive

Restoring live agent processes costs 21–35 seconds. The current contract eagerly revives the complete regular/delegate set before gateway readiness so restored teams, interrupted work, and session state are coherent on first use. Deferring or dropping this work could improve the headline number but would trade it for slow first-open sessions or broken restart recovery. It is not the first target.

## Implemented improvements

### Versioned forensic-recovery checkpoint

Each project state directory now receives `.team-forensic-recovery.json`. Missing, corrupt, stale-version, or `running` checkpoints execute the historical sweep. A successful pass atomically publishes `complete`; subsequent clean boots keep routine team consistency checks but skip full orphan/worker discovery and legacy sidecar backfill.

A concrete dangling team-lead pointer invalidates completion and reopens the project sweep, so current detectable damage is still recovered. A crash or failed recovery leaves the checkpoint incomplete and retries next boot. Operators can force salvage by removing the file, and future recovery-policy changes can bump its version.

This targets the 48–103 second dominant phase without changing team/session readiness ordering or application behavior. The first boot of a project on this policy may still perform the one-time migration.

### Build-before-stop harness restart

Sentinel restarts now validate and compile while the current gateway keeps serving. Only a successful build enters the stop, port-release, and launch window. Validation or compilation failure leaves the current application available and avoids launching partial output.

This does not reduce compilation CPU time, but removes it from user-visible downtime and improves failure behavior.

### Headquarters migration steady-state checkpoint

The default-layout `.headquarters-dir-migrated` marker is now a versioned evidence checkpoint rather than a timestamp. When path topology plus project-registry, tombstone, and migration-backup signatures are unchanged, startup skips recursive legacy tree comparison, project-store rerouting, config quarantine traversal, backup retirement, marker rewriting, and the multi-megabyte diagnostics rewrite. Project registries use a content digest because `ProjectRegistry` intentionally rewrites identical bytes on every boot; using mtime would defeat the fast path. A legacy timestamp or older checkpoint receives one final full pass. New or changed migration evidence reopens recovery, while unchanged ambiguous backups remain preserved without forcing work forever. Secret relocation, project repair, and Headquarters execution-store sanitization always run.

### Persistent phase instrumentation

Boot and shutdown phase logs remain bounded and best-effort. Constructor checkpoints are now granular enough to distinguish Headquarters migration from store/context setup. The instrumentation is intentionally cheap and has no startup dependency of its own.

## Recommended next targets

1. **Instrument per-session restore before changing its lifecycle.** Record process spawn, model catalogue resolution, transcript switch, and background-process recovery separately. Optimize shared repeated work and bounded concurrency first; keep eager recovery semantics.
2. **Cache tool detail-doc materialization if its new variability persists.** A source/effective-pack fingerprint could avoid rescanning unchanged definitions. The median was only 0.9–1.6 seconds, but one validation boot took 15.76 seconds, so more samples are warranted.
3. **Keep post-ready work post-ready.** Worktree sweeping, pool fill, and transcript backfill already run after readiness. Their 26–45 seconds affect host load but not initial reachability; optimize them only after the critical path.

## Non-targets

- Do not remove eager live-session restoration merely to improve the headline number.
- Do not make security migration, store repair, or recovery fire-and-forget without a durable boundary.
- Do not move worktree pool preparation back before readiness.
- Do not disable MCP or network/provider discovery globally for a small gain.
