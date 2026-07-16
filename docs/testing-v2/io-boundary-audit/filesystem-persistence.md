# Filesystem and persistence I/O boundary audit

**Audit date:** 2026-07-15

**Evidence cutoff:** merge base `4df9a35e2bd1ac5b662382189e12973fc4e1c4c2` only

**Scope:** filesystem/persistence seams proposed for unit-owned `tests2/core/**/*.test.ts` and `tests2/integration/**/*.test.ts`

## Evidence rule

Every citation below was checked with `git show 4df9a35e2bd1ac5b662382189e12973fc4e1c4c2:<path>`. Working-tree additions and edits do not qualify.

A proposed seam is classified as follows:

- **MB-COVERED** — the merge base has both (1) boundary-independent serialization/orchestration assertions that can remain deterministic behind the seam and (2) a qualifying real-fidelity E2E owner asserting the equivalent public behavior.
- **PARTIAL** — only one half exists, or the E2E proves only part of the proposed seam's contract.
- **GAP** — neither half exists for the proposed seam, or the only baseline coverage is itself tied to real filesystem operations and therefore cannot become the boundary-independent half.

“Qualifying E2E” follows the merge-base runner, not the filename alone:

1. Group B files in the `daily` bucket of `tests2/tests-map.json`.
2. All physical `tests2/browser/e2e/*.spec.ts`, because merge-base `scripts/testing-v2/run-e2e-v2.mjs` runs that whole Playwright project.
3. The 12 files in merge-base `scripts/testing-v2/integration-e2e-files.mjs`.

A merge-base file under `tests/e2e/` mapped to `v2-core`, `v2-integration`, or `v2-browser` is useful predecessor evidence, but it is not an active real-fidelity E2E owner and cannot complete an MB-COVERED pair. Manual integration is supporting real-fidelity evidence, not an E2E-gate owner.

## Required boundary split

### Eligible for an injected seam

These assertions do not require operating-system filesystem behavior and may use `FsLike`, memfs, byte inputs, fake readers, fake clocks, fake watchers, or operation adapters:

- JSON/YAML/frontmatter serialization and schema migration decisions.
- Filtering, rollups, reconciliation, stale-generation and stale-epoch decisions.
- Path-policy decisions after canonical paths/topology are supplied as inputs.
- Retry, restore, re-attach, cleanup, and orchestration state transitions after I/O results are supplied.
- Manifest selection, hash-input ordering, transcript parsing, and bounded-window calculations.
- Error mapping for injected `ENOENT`, `EACCES`, `EPERM`, or `EXDEV` results.

### Must retain real filesystem ownership

These assertions cannot be replaced by memfs or mocks as their only owner:

- Bytes really written and visible to a fresh reader or process.
- Successful temp-write/fsync/rename and absence of the temp file.
- Backup rotation and recovery after corrupting the primary on disk.
- Directory rename, recursive copy, cleanup, migration, and staged swap.
- Browser or gateway reload against the same state directory.
- Real `stat`/mtime, symlink/realpath, platform path, and Git/worktree topology.
- Real `fs.watch` delivery/re-arm behavior.
- Multi-writer atomicity, lock acquisition, stale-lock recovery, and crash behavior.

A unit test may inject an `EXDEV`/`EPERM` result to cover branching logic, but that is not proof that an OS rename/copy/replace occurred.

## Seam audit

### P-01 — `SessionStore` serialization/state seam — **MB-COVERED**

**Boundary-independent unit assertions.** Merge-base `tests2/core/session-store.test.ts` uses the store seam for child metadata and durable delegate fields (lines 163–209), draft generation/stale-write policy (308–377), and save/reload/delete semantics (405–445). `session-store-stale-load-guard.test.ts` pins the newer-epoch refusal and matching-epoch allow path (69–129). Those decisions are eligible for memfs/failure injection.

**Qualifying E2E owner.** `tests2/browser/e2e/crash-restart.journey.spec.ts`, “session created before crash is still accessible via API after restart” and “navigating to pre-crash session after restart shows the editor” (68–94): it crashes and restarts the gateway, then asserts `GET /api/sessions/:id` is `200`, the returned id matches, the editor is visible, and the URL still contains the session id.

**Keep real FS.** `tests2/integration/session-store-real-fs.test.ts` lines 43–95 owns real `sessions.json`, no leftover `.tmp`, backup rotation, and corrupt-primary recovery; lines 130–163 own recursive transcript traversal/mtime. The active browser E2E proves restart visibility, not `.tmp` cleanup, fsync, backup order, or traversal.

### P-02 — `CostTracker` and legacy backfill seam — **PARTIAL**

**Boundary-independent unit assertions.** `tests2/core/cost-tracker.test.ts` pins accumulation, rounding, rollup, removal, derived cache-hit rate, and omission of the derived field from serialized data (85–382). `cost-tracker-backfill.test.ts` pins resolver stamping, idempotence, unmappable entries, write-once preservation, and reload semantics (29–101).

**Qualifying E2E owner.** None at the merge-base E2E gate. The nearest predecessor, `tests/e2e/cost-backfill-on-boot.spec.ts`, is mapped to `v2-integration`, so it cannot complete the pair. Its exact baseline assertions are nevertheless important: after the second boot it checks `s-side.goalId === goalAId` and `s-ghost.goalId === undefined` on disk (376–383), the `1 stamped / 1 unattributable` boot log (384–399), and tree-cost inclusion/exclusion totals (401–435).

**Keep real FS.** `tests2/integration/cost-tracker-real-fs.test.ts` lines 23–47 owns a real `session-costs.json` write and fresh-instance reload. A new E2E owner must boot against the same state directory and assert the persisted stamp/idempotence before this seam can be MB-COVERED.

### P-03 — common `FsLike` gateway stores seam — **PARTIAL**

This covers goals, gates, inbox, plan mutations, preferences, PR status, annotations, context traces, and marketplace sources.

**Boundary-independent unit assertions.** Examples verified at the merge base include goal metadata normalization in `goal-store-metadata-migration.test.ts` (33–59), gate reconciliation/reload in `gate-store-logic.test.ts` (79–178), inbox persistence logic in `inbox-store.test.ts`, and plan-mutation state logic in `plan-mutation-store.test.ts`. These are serialization/reconciliation assertions suitable for `GatewayDeps.fsImpl` plus memfs.

**Qualifying E2E owner.** Coverage is only partial. `tests2/browser/e2e/gate-status-cross-surface.spec.ts` asserts active verification status across dashboard/sidebar/widget and browser reload (377–410), but browser reload does not restart the gateway or prove a disk reload. `tests2/browser/e2e/crash-restart.journey.spec.ts` proves session recovery, not all listed stores. No qualifying owner reloads each listed store from disk.

**Nonqualifying predecessor evidence.** `tests/e2e/goal-metadata-hierarchy.spec.ts` checks the 201 response, GET detail, and `goals.json` bytes (119–137), but it is mapped to `v2-integration`. `tests/e2e/api-goal-workflow-edit.spec.ts` checks replacement/reconciliation/rollback through the API (156–255), also mapped to `v2-integration`, and does not restart the gateway.

**Keep real FS.** One real restart owner per distinct durability/recovery contract is enough; API permutations should not all use real disk. Browser reload alone is not disk durability.

### P-04 — native project-YAML serialization seam — **PARTIAL**

**Boundary-independent unit assertions.** `tests2/core/project-config-store-native-yaml.test.ts` pins native YAML round trips, legacy JSON-string loading and native rewrite, omission of secret values, and absence of JSON-encoded YAML scalars (45–219). Those are byte-serialization assertions suitable for an injected `FsLike`.

**Qualifying E2E owner.** None. The exact predecessor is `tests/e2e/per-project-config-dirs.spec.ts`, mapped to `v2-integration`: after hard page reload it expects the custom path in the UI (155–159), then reads `project.yaml` and asserts a native YAML list, no JSON-string payload/escaped quotes, and the scalar path (160–171). Because it is not in the real-fidelity E2E gate, it cannot make this seam MB-COVERED.

**Keep real FS.** A qualifying owner must save, restart or reload from the same project directory, and inspect or consume the real YAML. `migrate-project-yaml.test.ts` covers migration decisions on real disk but is not a substitute for E2E migration/reload.

### P-05 — explicit state-root/common-fs seam for direct managers — **PARTIAL**

This covers project registry plus role/staff/task/team/background-process/color/secret state still discovered through direct paths or module-level environment.

**Boundary-independent unit assertions.** State-machine, filtering, ownership, restoration ordering, and orphan-reap decisions are eligible once constructors receive an explicit root/store. Merge-base examples include `task-state-machine.test.ts`, `team-manager*.test.ts`, `project-registry-order.test.ts`, and `role-store.test.ts`. Their real temp-directory setup is not itself qualifying boundary independence; only the decisions after reads are supplied are eligible.

**Qualifying E2E owner.** Partial only. `tests/e2e/remove-boot-respawn-restart.spec.ts` is an active Group-B owner: after gateway crash/restart it asserts a torn-down goal has no recreated team/agents and can start a new lead (91–129). That proves one team-state outcome, not registry/staff/task/color/secret store durability. `tests2/integration/orchestrate-restart.test.ts` is qualifying Group I, but much of it re-invokes restore methods in-process; for example lines 179–240 assert a delegate is restored live with persisted instructions, not a fresh process loading every direct manager store.

**Keep real FS.** Manager-specific temp-write/rename/recovery behavior needs a focused real owner. Module-load environment discovery should be removed from semantic tests rather than emulated globally.

### P-06 — agent-directory validation/migration filesystem seam — **GAP**

**Boundary-independent unit assertions.** None for the proposed copy boundary. `tests2/core/agent-dir-migration.test.ts` lines 97–227 performs real directory copy/symlink operations. The allowlist, overwrite policy, and error mapping are eligible for extraction, but at the merge base they are not independently asserted behind an operation seam.

**Qualifying E2E owner.** None. The predecessor `tests/e2e/ui/settings-agent-dir.spec.ts` is `v2-browser`, not real-fidelity E2E. It exactly asserts skip preserves destination bytes (126–130), overwrite copies source bytes (132–137), and pending state survives page reload (139–147), but it cannot qualify under the merge-base lane rule.

**Keep real FS.** Source/destination copy, symlink canonicalization, skip/overwrite byte results, and restart-gated pending-state reload all require a real-filesystem owner. Extract policy first, then add an active real-fidelity journey.

### P-07 — draft/proposal/transcript reader-store seam — **PARTIAL**

**Boundary-independent unit assertions.** Draft generation and stale-write policy are already independent in `session-store.test.ts` (242–377). Proposal frontmatter/YAML parsing, edit uniqueness, structural validation, revision selection, and transcript JSONL parsing are eligible to accept strings/bytes rather than discover files. At the merge base, many `proposal-files.test.ts` cases still combine those decisions with real writes (70–375), so only the parsing/policy portion is eligible.

**Qualifying E2E owner.** The configured Group-I `tests2/integration/continue-archived-assistant.test.ts` provides real copy equivalence: the goal-assistant case asserts the continued id/type, destination existence, byte-identical live file, identical history filenames, and byte-identical snapshots (114–160); role/tool/staff copies are checked at 162–235; the absent-source no-op asserts no destination directory (237–253). This covers copy, not draft stale-generation reload or proposal atomic edit.

**Nonqualifying predecessor evidence.** `tests/e2e/ui/draft-loss.spec.ts` is `v2-browser`; it checks a server draft after switch/reload (20–61) and immediate hard-reload flush (63–85), but is not a real-fidelity E2E owner at the merge base.

**Keep real FS.** JSONL append/read, sidecar discovery, snapshot-tree copy, clone/adopt paths, real reload, and proposal temp-write/rename must remain real. Parsing and orchestration permutations may move behind byte/tree seams.

### P-08 — background-process/verification spool interface — **PARTIAL**

**Boundary-independent unit assertions.** `tests2/core/bg-process-persistence.test.ts` contains eligible wrapper/status/orchestration assertions: wrapper command shape and quoting (118–181), restore classifications and idempotence (285–533), kill/exit decisions (536–729), and bounded spool calculations (739–910). A fake process runner, fake liveness probe, fake clock, and spool interface can own these decisions.

**Qualifying E2E owner.** None with equivalent `bash_bg` persistence at the merge-base E2E gate. `tests2/browser/e2e/terminal-pack.spec.ts` proves terminal reload/re-attach and gateway-restart disconnect/restart behavior (39–110, 339–384), but terminal channels are not the `bash_bg` spool/status-file contract.

**Supporting real-fidelity evidence.** Manual `tests/manual-integration/bg-process-restart-survival.spec.ts` checks a real `bg-processes.json`, a ticker continuing after gateway restart, and a process finishing during downtime with its real exit code (171–314). It must remain, but manual coverage alone does not make the seam MB-COVERED.

**Keep real FS.** Spool append/copytruncate, pid/nonce/status files, process survival across a killed gateway, log growth, real exit status, and file purge require real process/filesystem coverage.

### P-09 — preview manifest/hash/artifact decision seam — **MB-COVERED**

**Boundary-independent unit assertions.** Entry/path validation, manifest selection, ordered hash inputs, artifact identity, and “preserve old mount on failed staging” orchestration are eligible for pure/fake-tree tests. Merge-base `preview-mount.test.ts` pins selection/path/hash behavior (79–336) and staged replacement decisions (336–425); `preview-artifacts.test.ts` pins exact metadata, dedupe, restore identity, and non-mutation on invalid artifact (67–151).

**Qualifying E2E owner.** `tests2/browser/e2e/crash-restart.journey.spec.ts`, “preview mount entry is still accessible via API after restart” (129–152): it mounts `crash-test.html`, crashes/restarts the gateway, then asserts mount GET `200`, the same entry, and a SHA-256-shaped content hash.

**Keep real FS.** Actual selective copy, immutable artifact bytes, stage/swap rename, mtime, and absence of `.<sid>.tmp-*` remain real-FS assertions. The E2E proves durable mount metadata/accessibility, not watcher delivery or every copied byte.

### P-10 — preview/dev-harness watch adapter — **GAP**

**Boundary-independent unit assertions.** None at the merge base for fake event coalescing, debounce, error, close, or re-arm. `preview-mount.test.ts` has a real-fs “watcher fires after a re-mount” case (453–480), so it cannot serve as the boundary-independent half.

**Qualifying E2E owner.** None asserts “external file write → watch event → one debounced refresh,” watcher failure recovery, or re-arm. The preview crash/restart journey does not mutate the source externally and observe a watch notification.

**Keep real FS.** Add a fake watcher for state-machine permutations and one OS canary for actual `fs.watch` delivery. Do not infer watch correctness from a Refresh-button mtime change.

### P-11 — copy/rename/swap/archive/migration operation adapter — **PARTIAL**

**Boundary-independent unit assertions.** Policy and injected-result branches are eligible: archive preserve lists and `EXDEV`/failure mapping (`bobbit-archive.test.ts` 39–255), clone path/realm decisions (`continue-archived-clone.test.ts` 38–178), marketplace identity/order/update policy (`marketplace-install.test.ts` 101–831), and migration transformation/idempotence (`migrate-project-yaml.test.ts` 31–468).

**Qualifying E2E owners.** Coverage exists for only part of this broad adapter:

- Group-I `continue-archived-assistant.test.ts` checks byte-identical recursive proposal copy and absent-source no-op (114–253).
- Group-B `tests/e2e/continue-archived-worktree.spec.ts` asserts the cloned JSONL exists under the new worktree-cwd slug and not the project-root slug (101–170).
- Group-B `tests/e2e/marketplace-mcp.spec.ts` asserts install `201`, activation reload/tool visibility, disable/enable, uninstall `204`, and runtime removal (210–321).
- Group-B `tests/e2e/goal-archive-branch-cleanup.spec.ts` asserts published/local-only branch cleanup through the public archive route (96–166, 168–255).

There is no qualifying E2E for interrupted marketplace swap rollback, project-YAML migration rename/rollback, headquarters migration recovery, or generic archive `EXDEV`/locked-file behavior; therefore the shared proposal is only PARTIAL.

**Keep real FS.** Recursive copy bytes, staged directory replacement, backup restore, rename cleanup, migration markers, and post-failure source/destination topology need real owners. Synthetic error permutations may use an operation adapter.

### P-12 — discovery/tree-reader seam — **PARTIAL**

This covers skills, packs, MCP, file mentions, repo scan, and topology/path guards.

**Boundary-independent unit assertions.** Skill token expansion and unknown/range handling are pure in `skill-resolve.test.ts` (53–151). Mention classification, caps, ranges, escaping, and outside-cwd decisions are eligible once bytes/canonical paths are supplied (`file-mentions-resolve.test.ts` 50–256). Pack/MCP merge and diagnostic policy can likewise operate on supplied descriptors.

**Qualifying E2E owners.** Group-B `tests/e2e/mcp-integration.spec.ts` asserts server discovery/restart, connected status, tool count, metadata, and tool names (81–104). Group-B `tests/e2e/marketplace-mcp.spec.ts` asserts installed discovery reaches the runtime (210–321). These cover discovery activation, not real symlink escape rejection or every directory precedence rule.

**Nonqualifying predecessor evidence.** `tests/e2e/ui/add-project-symlink.spec.ts` is `v2-browser`; it checks canonical storage and reload persistence (80–149) but cannot qualify as active E2E. Its platform `EPERM` skip also leaves no unconditional Linux symlink canary.

**Keep real FS.** `readdir/stat/lstat/realpath`, symlink/junction escape, package loading, and platform canonicalization need real-tree canaries. Pure expansion/merge/cap logic should not create temp trees.

### P-13 — Git/worktree command-runner seam — **MB-COVERED**

**Boundary-independent unit assertions.** Branch naming/restore policy and command selection are eligible for a fake `CommandRunner`; `pool-claim-stable-branch.test.ts` asserts a `session/<id8>` row reloads unchanged (23–61). Command fencing is independently asserted in `command-runner-fence.test.ts` (21–69).

**Qualifying E2E owner.** Group-B `tests/e2e/pool-claim-restart-resume.spec.ts`, “session/<id8> branch is byte-stable across simulated restart; no git branch -m runs post-restart” (71–133): it asserts the branch shape, real worktree existence, stable persisted branch/worktree path after restore, unchanged reflog, and stable inode where supported. Group-B continuation/worktree and archive specs add real clone/copy/branch cleanup coverage.

**Keep real FS.** Real refs, reflogs, worktree directories, inode/topology, local-bare push/delete, and Git behavior remain in real-fidelity lanes. Only decision permutations belong behind the runner seam.

### P-14 — atomic writer/concurrent-writer lock seam — **GAP**

**Boundary-independent unit assertions.** Atomic replace failure branching can be injected, but the merge base has no production lock protocol state machine to assert: no lock acquisition, lease ownership, stale-lock cleanup, or two-writer conflict resolution.

**Qualifying E2E owner.** None creates two independent writers/gateways against one store or proves lost-update prevention. The session crash E2E proves a session remains visible after restart; it does not prove multi-writer serialization. `session-store-real-fs.test.ts` proves single-writer temp/rename/backup behavior only.

**Keep real FS.** If the contract is single gateway/single writer, document it explicitly: atomic replace prevents torn files but does not coordinate gateways. If multi-writer operation is supported, add a deterministic lock state machine plus a two-process real-FS E2E.

## Status summary

| Status | Proposed seams |
|---|---|
| **MB-COVERED** | P-01 session semantics, P-09 preview manifest/artifact decisions, P-13 Git/worktree command decisions |
| **PARTIAL** | P-02 cost/backfill, P-03 common gateway stores, P-04 native project YAML, P-05 direct managers, P-07 drafts/proposals/transcripts, P-08 bg/verification spools, P-11 copy/swap/migration adapter, P-12 discovery/tree reader |
| **GAP** | P-06 agent-dir migration boundary, P-10 watch adapter, P-14 locking/concurrent writers |

## Recommended order

1. Preserve the P-01, P-09, and P-13 E2E owners while moving only boundary-independent permutations behind their existing/narrow seams.
2. Add qualifying real-fidelity owners for P-02 and P-04 before claiming their old `tests/e2e` predecessors have been replaced.
3. Extract policy from real-copy tests for P-06, P-07, P-08, P-11, and P-12; retain one real owner for each distinct write/copy/reload/topology contract.
4. Add the P-10 fake watcher plus OS watch canary.
5. Decide and document the P-14 writer model before introducing locks or concurrent-writer tests.
