# Performance optimisation programme — implementation plan

Status: implementation in progress for [Performance optimisation programme](performance-optimisation-programme.md).

## 1. Delivery strategy

Build one usable vertical product slice from current `main`; do not merge the earlier static MVP as an independent product release.

Relevant revisions:

- `f92efd9d5` — Pack Local Data foundation.
- `ff85b0a6f` — Unified Host Hooks foundation.
- `ea7855305` — reconciled local performance-pack shell and bounded project-snapshot implementation; use as implementation material, not as the release boundary.

The final change should retain the proven panel/build work from `ea7855305`, replace the implicit `host.store` fixture contract with extension-owned SQLite, and add the real Scanner → Registry → Director → Goal loop before merge.

The Director directly creates goals through `bobbit_orchestrate(create_goal)`; proposal validation is not part of this automation path.

## 2. Scope by ownership

### Core Bobbit

Only the already-designed bounded project snapshot is required:

- `src/shared/extension-host/host-api.ts`
- `src/app/host-api.ts`
- `src/server/extension-host/project-snapshot-access.ts`
- `src/server/extension-host/project-snapshot-projection.ts`
- `src/server/server.ts`

Keep it optional, panel-only, server-bound to the authenticated session project, path-free, privacy-bounded, capped, and additive to notification APIs. Do not add goal metadata projection, SQLite concepts, pack events, or core navigation in this work.

### Performance pack

All programme policy and state belong under:

```text
market-packs/performance-optimisation/
```

Expected additions:

```text
pack.yaml
README.md
roles/
  performance-scanner.yaml
  performance-ideator.yaml
  optimisation-director.yaml
skills/
  install-performance-optimisation/SKILL.md
templates/
  explore-hypothesis.ts
tools/
  performance-optimisation/
    extension.ts
    perf_*.yaml
src/
  database.ts
  migrations.ts
  coverage-map.ts
  hypothesis-registry.ts
  benchmark-registry.ts
  programme-snapshot.ts
  routes.ts
  performance-panel.ts
lib/
  ...built browser/server bundles...
```

Exact bundle layout should follow the existing market-pack build pipeline; avoid runtime imports escaping the pack root.

## 3. Phase 0 — reconcile the shell and contracts

### Work

1. Start from current `main` in a fresh goal branch.
2. Reapply the relevant files from `ea7855305` rather than merging the static MVP branch wholesale.
3. Preserve notifications, Pack Local Data, and panel project snapshots together in the Host contract.
4. Keep the pack `defaultDisabled: true`.
5. Preserve the existing build/watch/mirror support and canonical sprite source.
6. Remove stale README claims that autonomous operation or Host notifications are unavailable.

### Tests

- Host contract version and feature-detection tests.
- Panel-only snapshot access and surface-token authorization tests.
- Pure snapshot projection caps/privacy tests.
- Existing performance pack inventory/build tests.

### Exit criteria

- `npm run check` passes.
- The opt-in pack installs and opens an honest empty panel.
- Non-panel surfaces cannot call `host.project.snapshot()`.
- No unresolved foundation-era compatibility code remains.

## 4. Phase 1 — manifest and local-data binding

### Work

Update `pack.yaml` to declare:

```yaml
localData:
  scope: project
  directory: .performance-optimisation
  access: read-write
  preserveOnUninstall: true
```

Register the new role, skill, tool group, and pack routes. Confirm the tool and skill names resolve through the winning pack and remain opt-in with the pack. Keep the **Explore Hypothesis** definition as a pack-owned inline-workflow template; do not list it under `contents.workflows`, because current marketplace workflow declarations are accepted as catalogue metadata but are not runtime-loaded.

Add a single pack-owned directory resolver seam used by:

- Server route modules through `ctx.host.localData.directory()`.
- Pi-extension tools through the pack-keyed agent binding.
- Tests through an injected temporary directory.

No API accepts a database path, project root, pack ID, or project ID from model/browser input.

### Tests

- Manifest validation and contribution inventory.
- Enabled/disabled and shadowed-pack behavior.
- Host, worktree, polyrepo, restored staff, delegate, and sandbox binding round trips.
- Preserve-on-disable/uninstall behavior.

### Exit criteria

Every extension execution realm resolves the same canonical project database directory.

## 5. Phase 2 — SQLite kernel and migrations

### Work

Implement a small pack-owned database module around Bobbit's shared `better-sqlite3` runtime dependency:

- Open `<localData>/performance.sqlite`.
- Use the same SQLite driver as Bobbit's goal and gate stores while retaining a separate pack-owned database file, schema, and connection.
- Enable WAL, foreign keys, and bounded busy timeout.
- Apply forward-only migrations transactionally.
- Reject a database newer than the supported schema.
- Surface binding, open, migration, and integrity errors.
- Never delete or recreate a failed database automatically.

Initial migrations create:

1. `schema_migrations`
2. `programme_settings`
3. `scan_units`
4. `scan_unit_files`
5. `scan_attempts`
6. `hypotheses`
7. `hypothesis_locations`
8. `hypothesis_observations`
9. `hypothesis_goal_links`
10. `benchmark_references`
11. `benchmark_bindings`
12. `benchmark_runs`
13. `hypothesis_outcomes`
14. `activity_events`

Add a one-row programme revision or equivalent monotonic counter. Increment it in the same transaction as every panel-visible change. Insert activity in that transaction and prune to the newest 50 rows.

Use separate repository modules over one connection/transaction boundary rather than embedding SQL in tools and routes.

### Required invariants

- Stable generated IDs.
- Repository-relative normalized paths.
- One active scan attempt per scan unit and fingerprint.
- One active goal or Director-owned creation claim per hypothesis.
- Exact hypothesis creation fingerprint uniqueness.
- Observation history is append-only.
- Goal IDs are unique across hypothesis links.
- Outcome recording is idempotent.
- Panel snapshots observe only committed states.

### Tests

- Fresh creation and every migration step.
- Reopen/restart durability.
- WAL/busy behavior with two connections.
- Transaction rollback at injected failure points.
- Foreign-key and uniqueness failures.
- Newer-schema rejection.
- Corrupt database diagnostic without replacement.
- Activity ordering/pruning and revision atomicity.

### Exit criteria

All registry behavior can be tested without Bobbit, agents, or a browser by injecting a temporary local-data directory.

## 6. Phase 3 — coverage map

### Work

Implement deterministic Map Builder logic:

1. Run Scanner staff without a private worktree so its workspace reflects the canonical project checkout.
2. Inventory tracked production files from each registered project component/repository. The Scanner obtains Bobbit-resolved component names and relative paths through `bobbit_read`; the tool accepts only bounded relative component descriptors, validates every resolved real path remains under the Scanner workspace, and never accepts a project ID, absolute root, or database path.
3. Exclude configured tests, docs, generated output, vendor/build directories, and binary files.
4. Derive structural units from workspace/package manifests and source-directory boundaries.
5. Split unusually large units and combine only clearly related tiny groups.
6. Validate and materialize explicit cross-cutting definitions stored by the Scanner. Scanner judgement chooses semantic flows and members through a bounded tool; deterministic Map Builder code owns path/member validation and fingerprints.
7. Calculate deterministic fingerprints from normalized paths and file content identities.
8. Transactionally reconcile added, removed, changed, and unchanged units.

Do not infer the canonical project root from process cwd. Repository inspection occurs in the Scanner's project context; durable state always writes through Pack Local Data.

Implement attempt transitions and Scanner reconciliation views. Claims have no automatic lease expiration. Store Scanner/delegate identity and last observed state so the Scanner can make the recovery decision on its next wake.

### Agent tools

- `perf_coverage_refresh`
- `perf_coverage_get_modules_to_scan`
- `perf_coverage_mark_module_as`
- `perf_coverage_get_attempts`
- `perf_coverage_upsert_cross_cutting_unit`

Bound every list and text input/output. Return current/claimed fingerprints so a delegate cannot accidentally mark a newer revision scanned.

### Tests

- Stable output for unchanged trees.
- Edit/add/delete/rename invalidation.
- Tests/docs/generated changes do not invalidate production units.
- Parent and cross-cutting invalidation.
- Change-during-scan keeps the unit stale.
- Restart reconciliation and duplicate active-attempt prevention.
- Multi-repo and component-relative paths.

### Exit criteria

A fixture repository can move deterministically from unscanned to scanned, stale after a production change, and scanned again without losing historical attempts.

## 7. Phase 4 — hypothesis registry

### Work

Implement structurally validated hypotheses with no evidence requirement.

Creation fields:

- Improvement types.
- Scan units and current source locations.
- Confidence, impact, and risk enums.
- Description.
- Source scan attempt/fingerprint.

Implement matching in two layers:

1. Exact canonical fingerprint for transactional race prevention.
2. Bounded likely-match search based on affected units/files/symbols and normalized description terms.

`perf_hypothesis_merge` appends an observation and updates the current location projection. It never deletes prior observations.

Implement Director ordering exactly as designed: lower risk, higher impact, higher confidence, then oldest first. The selection/claim transition to `goal-pending` is transactional.

### Agent tools

- `perf_hypothesis_search`
- `perf_hypothesis_create`
- `perf_hypothesis_merge`
- `perf_hypothesis_get_highest_priority`
- `perf_hypothesis_get_goal_payload`
- `perf_hypothesis_mark_goal_creation`
- `perf_hypothesis_link_goal`
- `perf_hypothesis_record_outcome`

### Tests

- Required-field and enum validation.
- All valid stored hypotheses are eligible without evidence/benchmark.
- Exact duplicate race returns the existing record.
- Similar match search is deterministic and bounded.
- Merge preserves history and updates renamed symbols/line ranges.
- Priority ordering and tie-break.
- Concurrent Director claims cannot select one hypothesis twice.
- Every terminal outcome and blocked-unmeasurable reopening.

### Exit criteria

Two independent Ideators can concurrently discover the same idea and produce one hypothesis with two durable observations.

## 8. Phase 5 — benchmark references and outcomes

### Work

Implement benchmark references to existing project-owned commands. Do not add a new generic runner.

Populate references through `perf_benchmark_sync`, using bounded component/named-command descriptors obtained from `bobbit_read`, plus conventional repository benchmark scripts discovered under the validated workspace. Add `perf_benchmark_register` for explicitly registering another existing named project command. Both operations validate the component and command reference; neither accepts an arbitrary replacement shell command.

The registry stores:

- Component and command/script reference.
- Applicability to scan units, globs, metrics, or tags.
- Metric/unit/direction metadata.
- Optional warm-up/repetition guidance.

The Team Lead selects with `perf_benchmark_list`, runs commands through normal goal tools, and records structured results with `perf_benchmark_record_run`. Store baseline/candidate identity, environment summary, raw/summary metrics, variability, and interpretation.

When no existing benchmark applies:

- Record the measurement gap.
- Set scheduling state `blocked-unmeasurable`.
- Do not enter implementation.
- Allow later benchmark registration to reopen the hypothesis.

Implement the four Team Lead recommendations plus Director abandonment. Require the complexity/maintainability and behavioural assessment in the outcome write.

### Agent tools

- `perf_benchmark_sync`
- `perf_benchmark_register`
- `perf_benchmark_list`
- `perf_benchmark_record_run`

### Tests

- Sync/register accepts existing validated named commands and rejects arbitrary, missing, or escaping references.
- Missing/stale command references surface clearly.
- Baseline and candidate runs remain distinguishable and ordered.
- Unit/direction mismatches are rejected.
- Unmeasurable state blocks scheduling and reopens after binding.
- Outcome schemas require measurement, tests, complexity, and rationale where applicable.
- Repeat outcome submission is idempotent.

### Exit criteria

A complete experiment record can explain what ran, what changed, what it measured, whether behaviour changed, and why merging is or is not recommended.

## 9. Phase 6 — roles and installation skill

### Roles

#### `performance-scanner`

Allow only the tools needed to:

- Read/reconcile Bobbit sessions.
- Refresh/read/update coverage.
- Launch and observe `performance-ideator` delegates.
- Read programme settings and activity.

Its prompt must recover existing attempts before selecting new work and must return early when no units are eligible.

#### `performance-ideator`

Read-only source analysis plus:

- `perf_hypothesis_search`
- `perf_hypothesis_create`
- `perf_hypothesis_merge`
- Final coverage-attempt completion

It cannot edit code, create goals, or manage staff.

#### `optimisation-director`

Allow:

- Bobbit goal/session/task/gate/PR reads.
- Bounded goal/session operational mutations needed for full discretion.
- `bobbit_orchestrate(create_goal)` for direct autonomous goal creation and automatic team start.
- Hypothesis selection, goal-creation claim, goal-link, and outcome tools.

It has no proposal or goal-delegation tools. Its prompt must reconcile pending direct-creation claims and goals before filling capacity and log every intervention.

### Installation skill

Create `skills/install-performance-optimisation/SKILL.md` with allowed gateway/performance tools. It should:

1. Check the selected project and enabled pack.
2. Ask for Scanner schedule, Director schedule, Ideator parallelism, and active-goal target.
3. Persist programme settings.
4. List project staff.
5. Match stable names/roles.
6. Call `bobbit_orchestrate(create_staff)` only for missing Scanner/Director staff.
7. Include roles, accessories, project/cwd, and schedule triggers in create bodies.
8. Report existing and created IDs.
9. Never call `propose_staff`, delete staff, or silently replace modified staff.

### Tests

- Role IDs/tool policies resolve from installed pack.
- Ideator mutation tools are denied.
- First install creates exactly two staff and persists their IDs in SQLite.
- Reinstall follows stored IDs and creates none, including after a user rename.
- First install may adopt an exact name-and-role match.
- Existing same-name wrong-role staff blocks installation instead of being overwritten or duplicated.
- A missing previously recorded ID requires user confirmation before recreation.
- User selections persist and drive create bodies/settings.
- Sandbox and normal staff receive the same database binding.

### Exit criteria

A user can enable the pack, run one skill, answer four configuration prompts, and obtain two correctly configured persistent staff without proposals or duplicates.

## 10. Phase 7 — Explore Hypothesis workflow

### Work

Ship one canonical pack-owned inline-workflow template with gates representing:

1. Plan/benchmark/test selection.
2. Baseline recorded.
3. Implementation variation.
4. Candidate measurement.
5. Behavioural validation.
6. Review/recommendation.

Use existing task/gate reset and follow-up task mechanisms for implementation variations. Do not erase an unsuccessful variation or baseline when trying another.

The workflow instructions require:

- Early unmeasurable conclusion before code changes.
- Comparable baseline/candidate conditions.
- Repeatability assessment.
- Complexity-to-benefit judgement.
- One structured terminal recommendation.
- Registry outcome write before goal completion or abandonment.
- A PR description containing the final measurement/trade-off artifact when merging is recommended.

The persistent Director directly creates each selected hypothesis goal. It transactionally records a Director-owned `goal-pending` claim, calls `bobbit_orchestrate(create_goal)` once, then immediately links the returned goal ID. On an interrupted or uncertain response it searches full goal metadata before retrying and releases the claim only when no correlated goal exists.

Each create call supplies the canonical template unchanged through body `workflow` plus:

```json
{
  "performance-optimisation": {
    "hypothesisId": "<id>"
  }
}
```

It uses the selected project, no separate registered workflow ID, no caller-derived cwd override, and explicit automatic team start. Goal creation persists the frozen inline workflow immediately.

### Tests

- Inline-workflow schema and dependency validation.
- Concurrent Director claims cannot create duplicate goals.
- An interrupted create is reconciled by metadata before retry.
- Missing benchmark path stops before implementation.
- Failed measurement can return to implementation without losing evidence.
- Behaviour-change outcome cannot recommend merging.
- Outcome write is required before terminal completion.
- Goal metadata survives direct creation and is found by Director reconciliation.
- Invalid goal parameters fail atomically without leaving a linked registry goal.

### Exit criteria

A fixture hypothesis can traverse every positive gate and each negative terminal path with durable registry evidence.

## 11. Phase 8 — pack routes and live panel

### Pack routes

Add a `performance-snapshot` route that opens the bound database and returns a bounded, versioned projection:

- Programme revision/settings summary.
- Scanner/Director state derived from recent programme activity.
- Structural and cross-cutting coverage.
- Hypotheses and observations needed by the active view.
- Goal links, benchmark summaries, outcomes.
- Latest 50 activity rows newest-first.

Add only narrowly required action routes if the browser needs explicit user operations. Agent writes continue through model-facing tools.

### Panel

Replace `control-pane.snapshot` reads from `host.store` with:

```text
host.project.snapshot()
host.callRoute("performance-snapshot")
```

Join goal/task/gate/PR records by SQLite `goalId`. Do not parse titles/specs or require goal metadata in the browser.

Subscribe to canonical project notifications and `onRefreshRequired`; coalesce bursts into authoritative rereads. Refresh the pack snapshot after relevant Scanner/Director sessions settle. Keep an explicit retry control for diagnostics, not as the normal live-update mechanism.

Retain:

- Flow map, Scan coverage, Hypothesis registry.
- Singleton/reload-safe route behavior.
- Responsive non-overlap guarantees.
- Honest empty/uninstalled/error states.
- Explicitly labelled development fixture.
- Canonical Bobbit sprite data.

### Tests

- Route surface-token, project, pack, and local-data binding.
- DTO bounds and no unrestricted paths/content.
- Empty, active, blocked, positive, negative, and failure panel states.
- Notification refresh, gap/overflow `onRefreshRequired`, reconnect, and reload.
- SQLite diagnostic does not replace prior UI data silently.
- Goal/PR join by goal ID.
- Activity newest-first and capped at 50.
- Narrow/mobile layout and tab restoration.

### Exit criteria

The panel reflects committed SQLite and Bobbit state without fixture/store mediation, survives reload/reconnect, and never constructs internal navigation hashes.

## 12. Phase 9 — end-to-end automation

Build a suite-owned fixture project with:

- Small production modules and one cross-cutting path.
- Project-owned deterministic benchmark command.
- Behavioural test command.
- A controlled performance opportunity.

Automate the full journey:

1. Install/enable the pack.
2. Run installation skill or API-equivalent fixture setup.
3. Wake Scanner.
4. Observe map creation and Ideator delegation.
5. Observe hypothesis create/merge and coverage completion.
6. Wake Director and observe it directly create, link, and start the correlated goal.
7. Run the Explore Hypothesis workflow with baseline/candidate results.
8. Record behavioural validation and `Recommend merging`.
9. Verify PR description content or the exact pre-PR artifact used to generate it.
10. Reload browser and restart gateway.
11. Verify staff, attempts, hypothesis, goal link, outcome, panel, and activity reconcile without duplication.
12. Disable/uninstall and verify local data preservation; clean the suite-owned project root.

Also cover negative journeys:

- No scan work.
- Delegate disappears.
- Production changes during scan.
- Duplicate hypothesis race.
- Failed or interrupted direct goal creation.
- No benchmark.
- No repeatable improvement.
- Complexity outweighs benefit.
- Behaviour changes.
- Director abandons a stuck goal.
- SQLite migration/open failure.

## 13. Test and gate plan

All new automated tests land in `tests2/` and are registered in `tests2/tests-map.json`.

### Unit/core

- Manifest, contribution, build, role/tool/workflow contracts.
- Database, migrations, repositories, matching, ordering, fingerprints, and outcomes.
- Project snapshot privacy/caps and Host contract.

### DOM

- Host snapshot/notification integration.
- Panel state joins, coalesced refresh, errors, and tab persistence.

### Browser

- Installed pack launch, tabs, responsive layout, reload, reconnect, and cleanup.

### E2E

- Canonical local-data access across staff/delegates/worktrees/sandbox.
- Persistent staff + cron/inbox behavior.
- Full Scanner → Director → Goal → measured recommendation journey.
- Gateway restart reconciliation.

### Required commands

Run in order:

```bash
npm run check
npm run test:unit
npm run test:browser
npm run test:e2e
```

Use focused suites during development, then the full sequential gates before merge. Run a manual real-agent journey only after deterministic automation passes.

## 14. Suggested work decomposition

Independent early work can run in parallel after Phase 0:

### Workstream A — data and tools

- Local-data manifest.
- SQLite/migrations.
- Coverage, hypothesis, benchmark repositories.
- Model-facing tools.

### Workstream B — automation policy

- Three roles.
- Installation skill.
- Explore Hypothesis inline-workflow template.
- Scanner/Director prompts and reconciliation.

### Workstream C — browser integration

- Pack snapshot route.
- Panel SQLite/project join.
- Notification-driven refresh.
- Responsive states.

Integrate in this order:

1. A database kernel.
2. A + Scanner/Ideator loop.
3. A + Director direct-goal reconciliation.
4. A + workflow outcomes.
5. C panel.
6. Full E2E/restart qualification.

Keep one owner for schema and tool contracts while parallel work is active; migrations and shared DTOs are serialization points.

## 15. Merge criteria

Do not merge merely because the shell renders. The product slice is usable only when:

- Pack Local Data is the sole performance-state location.
- Installation creates the two persistent staff idempotently.
- A real Scanner wake produces or merges a hypothesis.
- Director directly creates, links, and starts a goal without duplicate scheduling.
- The workflow records baseline, candidate, behavioural validation, complexity assessment, and recommendation.
- The panel shows durable state after browser and gateway reload.
- Positive and negative findings are preserved.
- Interrupted goal creation reconciles by metadata before any retry.
- Full required tests pass and the opt-in pack cleans up without deleting its database.
