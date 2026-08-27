# Performance optimisation programme

Status: proposed end-state design. Product decisions are confirmed; names, thresholds, SQL indexes, scan-size heuristics, and installation defaults remain implementation details.

## 1. Purpose

The performance optimisation pack continuously discovers plausible performance improvements, turns selected ideas into measured implementation goals, and preserves both successful and negative findings.

```text
Map Builder        Scanner        Director  ──>  [ Goal ]
        \          /\     \       /\                  ||
         \         ||      \     /                 Team Lead  ──> PR
         \/        \/      \/   \/                 /       \
      [Coverage Map]   [Hypotheses]        [Benchmarks]   [Tests]
```

The programme has three authorities:

| Authority | Owns |
|---|---|
| Project repositories | Production source, benchmark commands, behavioural tests |
| Performance pack SQLite | Coverage, scan attempts, hypotheses, benchmark references/runs, decisions, goal links, settings, activity |
| Bobbit | Staff, sessions, goals, tasks, workflow gates, and PR status |

The pack is opt-in. It does not modify production code itself: persistent staff discover and coordinate; goal-scoped teams implement changes through normal Bobbit workflows and review.

## 2. Goals and non-goals

### Goals

- Maintain a durable, revision-aware map of production code that has and has not been examined.
- Continuously generate performance hypotheses through bounded parallel code analysis.
- Avoid duplicate hypotheses while preserving repeated observations and changing source locations.
- Keep a configurable number of promising hypotheses under active investigation.
- Require baseline measurement and behavioural validation before recommending a change.
- Preserve negative and inconclusive findings so the programme does not repeatedly rediscover them.
- Present coverage, hypotheses, active goals, measurements, decisions, and recent activity in a reload-safe panel.

### Non-goals for the MVP

- Creating or owning project benchmark implementations.
- Automatically merging PRs. The Director does create and start performance goals autonomously.
- Programme-wide pause/resume.
- A generic benchmark runner in Bobbit core.
- Host-level SQLite watching, schema policy, or extension-data events.
- Browser projection of goal metadata.
- Core goal/session deep-link navigation.
- Staff templates or a new staff-proposal flow.
- Proving a hypothesis before it is recorded.

## 3. Platform fit

The programme uses existing Bobbit capabilities:

- Pack Local Data binds the canonical project directory to pack server code, Pi-extension tools, staff, delegates, worktrees, and sandboxes.
- Unified Host Hooks provide canonical notifications and durable notification-triggered staff inbox delivery.
- Persistent staff are created directly with `bobbit_read` and `bobbit_orchestrate(operation: "create_staff")`.
- Direct `bobbit_orchestrate(create_goal)` metadata carries pack-namespaced hypothesis correlation.
- Pack routes expose bounded SQLite projections to the browser panel.
- The pack uses Bobbit's shared `better-sqlite3` runtime dependency, matching the goal and gate stores while retaining its own isolated project-local database.

No new broad core subsystem is required. The panel uses the landed contract-v7 on-demand `host.project` reads from its authenticated pack-owned surface.

Goal metadata projection and core navigation are not MVP dependencies. SQLite stores the created `hypothesisId → goalId` link, and the panel requests the linked goal and its bounded task, gate, session, and cached PR summaries by goal ID.

## 4. Actors

### 4.1 Map Builder

The Map Builder is deterministic pack code invoked by the Scanner, not a third persistent staff member.

It inventories tracked production files, derives structural scan units, materializes Scanner-defined cross-cutting units, records their content fingerprints, and marks affected units stale when production code changes. It does not use an LLM to decide whether code is performant. The Scanner may use architectural judgement to define or update semantic cross-cutting units through a validated registry tool; the Map Builder remains the deterministic materializer and invalidation owner.

### 4.2 Optimisation Scanner

Persistent staff identity:

- Name: **Optimisation Scanner**
- Role: `performance-scanner`
- Accessory: magnifying glass
- Trigger: user-selected schedule established by the installation skill

On each wake the Scanner:

1. Refreshes the coverage map against the current production revision.
2. Reconciles outstanding scan attempts and their delegate sessions.
3. Returns early when no scan units need work.
4. Selects up to the configured parallelism limit.
5. Launches one non-blocking `performance-ideator` delegate for each selected unit.
6. Records each delegate session against its scan attempt.

The Scanner owns retries and delegate lifetime. There is no strict scan lease timeout. On later wakes it uses Bobbit read tools to decide whether an existing delegate is progressing, stale, failed, missing, or complete, and retries or concludes the attempt accordingly.

### 4.3 Performance Ideator

`performance-ideator` is an ephemeral, read-only analysis role. It is never installed as persistent staff.

For one claimed scan unit it:

1. Reads and analyses the assigned production code in depth.
2. Searches the registry for each possible performance improvement.
3. Creates a new hypothesis when no match exists, or merges a new observation into an existing match.
4. Marks the scan attempt complete only after all hypothesis writes have committed.

Ideators may read source and use performance registry tools. They may not modify production files, create goals, or manage staff.

### 4.4 Optimisation Director

Persistent staff identity:

- Name: **Optimisation Director**
- Role: `optimisation-director`
- Accessory: crown
- Trigger: user-selected schedule established by the installation skill

On each wake the Director:

1. Reconciles direct goal-creation claims and created goals with the hypothesis registry.
2. Inspects active performance goals, sessions, tasks, gates, and PR status using Bobbit read tools.
3. Takes sensible action on stuck goals.
4. Counts goal-pending, setting-up, and in-progress performance goals against the configured target.
5. Returns early when the target is already met.
6. Selects enough open hypotheses to fill the available slots.
7. Transactionally claims each selected hypothesis, then directly calls `bobbit_orchestrate(operation: "create_goal")` with the canonical **Explore Hypothesis** workflow, namespaced metadata, and automatic team start.
8. Immediately links the returned goal ID to the hypothesis. After an interrupted turn, it searches goal metadata before retrying so a lost response cannot create a duplicate.

The persistent Director owns goal creation; it never launches a proposal delegate or writes a proposal draft. Goal teams start automatically without a human acceptance step.

The Director has full operational discretion over performance goals: it may prompt, restart, redirect, pause, resume, or abandon them. It must log every intervention and preserve commits, branches, measurements, and PRs. Before abandonment it records the current evidence and outcome in SQLite. It cannot bypass workflow evidence, repository protections, or merge authority.

### 4.5 Goal Team Lead

The normal Bobbit goal Team Lead owns the measured experiment and implementation. It selects relevant benchmarks and tests, establishes a baseline, implements variations, compares results, validates behaviour, records a terminal recommendation, and creates or advances a PR only when merging is recommended.

## 5. Installation

The pack ships an installation skill. It calls gateway tools directly and does not use `propose_staff`.

The skill asks the user for:

- Scanner schedule.
- Director schedule.
- Maximum parallel Ideators.
- Target concurrent optimisation goals.

It offers sensible defaults without making those values architectural invariants. It then:

1. Resolves the current project and confirms the pack is enabled.
2. Initializes or updates programme settings in SQLite.
3. Initializes deterministic production coverage.
4. Discovers existing benchmark-like component commands and manifest scripts, retaining only candidates whose repository-owned configuration or documentation defines a primary metric, unit, direction, and production applicability.
5. Idempotently syncs those validated benchmark references without executing or modifying project commands; ambiguous candidates are reported and skipped.
6. Lists project staff and first checks staff IDs previously recorded in SQLite.
7. On first install, adopts an exact stable name-and-role match when one exists; otherwise it creates the missing staff with its role, accessory, prompt, and schedule trigger.
8. Persists created/adopted staff IDs and reports them.

Install-time discovery is the MVP registration boundary. Scanner and Director passes consume benchmark references but never redefine them. Rerun the installation skill after adding or changing project benchmarks. A post-MVP benchmark-authoring system may respond to `blocked-unmeasurable` demand by creating and validating project-owned benchmarks before registering them.

A same-name record with the wrong role is an explicit blocked installation conflict, not an invitation to create a duplicate. Rerunning the skill follows stored IDs and is idempotent: it never creates duplicates, deletes staff, or silently replaces a renamed or user-modified staff record. If a recorded staff ID no longer exists, the skill reports that condition and asks before recreating it. Because the allowed gateway tool surface creates but does not update staff, changing an existing staff schedule remains an explicit user edit; pack-local concurrency settings may be changed independently.

## 6. Coverage map

### 6.1 Scan units

The database calls the coverage primitive a `scan_unit`; the UI and agent prompts may use “module” for readability.

Two kinds exist:

- **Structural units** follow repository components/packages, source directories, and bounded related file groups.
- **Cross-cutting units** explicitly overlap structural units to cover flows such as startup, request handling, rendering, persistence, caching, build pipelines, and memory cleanup. The Scanner defines their stable name and member structural units/files; deterministic Map Builder code validates and materializes them.

Each unit records:

- Stable ID and kind.
- Parent structural unit where applicable.
- Repository-relative production files.
- Current production-content fingerprint.
- Last successfully scanned fingerprint and revision.
- State: `unscanned`, `scanning`, `scanned`, `stale`, or `failed`.
- Last scan time and attempt summary.

Exact size thresholds and splitting heuristics are implementation-tunable. Package/manifest boundaries take priority; large units split by subsystem or directory, while tiny related groups may be combined.

### 6.2 Invalidation

A unit is current only while its production-code fingerprint equals the fingerprint from its last successful scan.

Any production file edit, addition, deletion, or rename marks every containing structural and cross-cutting unit stale. Tests, documentation, generated output, and benchmark-only changes do not invalidate production-code coverage.

If production code changes while an Ideator is working, its hypotheses and scan record remain valid historical observations tied to the original fingerprint, but the unit remains stale and becomes eligible for another scan.

### 6.3 Attempts and reconciliation

Each scan attempt stores:

- Scan-unit ID and claimed production fingerprint.
- Scanner staff/session identity.
- Delegate session ID when launched.
- State and timestamps.
- Completion or failure summary.

State transitions are transactional to avoid duplicate active delegates. Claims do not expire automatically. The Scanner reconciles them against current Bobbit session state:

- Running/progressing delegate: retain `scanning`.
- Successful delegate and committed completion: mark scanned for its claimed fingerprint.
- Missing, terminated, or errored delegate: retry or mark failed using Scanner judgement.
- Fingerprint mismatch: retain findings and return the unit to `stale`.
- Scanner restart: reconcile existing attempts before launching new work.

Structural and cross-cutting coverage are reported separately.

## 7. Hypothesis registry

### 7.1 Meaning

A hypothesis is a record of an idea that identifies a possible performance improvement. It is not required to include evidence or an applicable benchmark.

Creation performs structural validation only. Every successfully stored open hypothesis is eligible for Director selection.

Required content includes:

- One or more improvement types, such as speed, responsiveness, CPU efficiency, or memory efficiency.
- Structural/cross-cutting scan units and source locations.
- Confidence: high, medium, or low.
- Expected impact: high, medium, or low.
- Risk: high, medium, or low.
- Description of the possible improvement.

Locations should prefer repository-relative file plus symbol/function identity, with line ranges as changeable hints rather than identity.

### 7.2 Search and merge

Before submitting an idea, an Ideator searches for an existing match.

- No match: create normally.
- Match: append an observation and merge current locations into the existing hypothesis.

A merge preserves history. It may add or update modules, files, function names, and line ranges; union improvement types; and retain all contributing scan attempts. Renames and shifted line numbers therefore update the current projection without erasing the earlier observation.

Creation rechecks a canonical exact-match fingerprint inside its transaction so concurrent Ideators cannot create the same exact record after both searched. Similarity matching may be richer and advisory; the exact fingerprint is the race-safety backstop.

### 7.3 Lifecycle

Scheduling state and investigation outcome are separate:

- Scheduling: `open`, `goal-pending`, `active`, `blocked-unmeasurable`, or `concluded`.
- Outcome: absent until known, then one of:
  - `No improvement found`
  - `Improvement doesn’t justify complication`
  - `Changes system behaviour`
  - `Recommend merging`
  - `Abandoned`

`blocked-unmeasurable` is not a conclusion. Registering a suitable benchmark returns the hypothesis to `open` through reconciliation.

### 7.4 Priority

The MVP follows the Director policy originally specified:

1. Lower risk.
2. Higher expected impact.
3. Higher confidence.
4. Older creation time as a deterministic tie-break.

Only `open` hypotheses participate. A transaction marks selected hypotheses `goal-pending` before the Director creates goals, preventing duplicate scheduling across wakes.

## 8. Direct goal creation and correlation

For each selected hypothesis, the persistent Director reads the canonical goal payload, transactionally claims the hypothesis, and calls `bobbit_orchestrate(operation: "create_goal")` itself. The create body includes the frozen workflow snapshot, automatic team start, and existing namespaced metadata:

```json
{
  "performance-optimisation": {
    "hypothesisId": "hyp-047"
  }
}
```

The pack name is the namespace; the hypothesis ID supplies one-to-one correlation. Titles and spec text are never correlation keys.

Goal creation is reconciliation-based:

1. The hypothesis becomes `goal-pending` and stores the persistent Director session ID before goal creation.
2. The Director passes the pack's canonical **Explore Hypothesis** definition unchanged as `create_goal` body `workflow`; marketplace workflow declarations are not runtime-loaded by the current platform.
3. The created goal persists the metadata and frozen workflow and automatically starts its team.
4. The Director immediately records `hypothesisId → goalId` in SQLite and moves the hypothesis to `active`.
5. After an interrupted or uncertain create call, the Director reads full project goals and matches metadata before retrying. A match is linked; a claim is released to `open` only after no correlated goal exists.
6. Titles and specs remain descriptive only and are never used as correlation keys.

The panel does not need goal metadata. It reads the SQLite goal link, then requests that goal through `host.project.readGoals({ mode: "ids", ids })` and its related detail methods.

## 9. Benchmarks and tests

### 9.1 Ownership

Benchmarks and behavioural tests are pre-existing project-owned commands. The performance pack stores references, applicability, and run results; it does not silently invent or replace project commands.

A benchmark reference may include:

- Stable benchmark ID and display name.
- Project component and named command/script reference.
- Applicable structural/cross-cutting units, file globs, or tags.
- Reported metrics, units, and improvement direction.
- Optional run guidance such as repetitions or warm-up.

The exact command remains in project configuration or repository manifests. References enter the catalogue through `perf_benchmark_sync`: it receives Bobbit-resolved component and named-command descriptors, validates them against the Scanner/Director workspace, discovers conventional benchmark scripts where possible, and updates only reference metadata. `perf_benchmark_register` may explicitly register another existing named project command. Neither tool accepts or creates an arbitrary replacement command. A stale or missing reference is surfaced rather than rewritten by the pack.

### 9.2 Selection

The Explore Hypothesis Team Lead selects all relevant benchmarks. It may use explicit hypothesis bindings, affected scan units, component, files, metrics, and tags, but it owns the final choice.

When no applicable benchmark exists, the workflow stops before implementation with `blocked-unmeasurable`. The Team Lead records:

- The metric or behaviour that needs measurement.
- Affected modules and execution path.
- Why current benchmarks are unsuitable.
- A suggested benchmark shape.

A future Operations Director may schedule benchmark creation. Once a suitable project-owned benchmark is registered, the hypothesis becomes open again.

Behavioural tests are likewise selected from project-owned commands. If existing tests do not protect the affected behaviour, the Team Lead may add characterization coverage as part of the implementation goal.

### 9.3 Measurement judgement

There is no global percentage threshold. The Team Lead applies a complexity-to-benefit trade-off:

- A simplifying or complexity-neutral change needs only a repeatable benefit.
- A change that degrades maintainability, increases complexity, or adds defect surface must demonstrate a commensurately meaningful improvement.

Repeatability, environmental noise, metric direction, and benchmark guidance must be considered. The decision remains accountable Team Lead judgement rather than a hard-coded score.

## 10. Explore Hypothesis inline workflow

The pack owns one canonical inline-workflow template. The persistent Director passes that template unchanged through `bobbit_orchestrate(create_goal)` body `workflow`; it is not registered through `contents.workflows`, which the current marketplace schema accepts as catalogue metadata but does not load into project workflow stores.

### 10.1 Plan and select

- Explain the expected performance mechanism.
- Select all relevant benchmarks.
- Select relevant behavioural tests.
- Describe expected benefit, risk, and likely complexity.
- If no benchmark applies, record the measurement gap and conclude as unmeasurable before implementation.

### 10.2 Baseline

- Run relevant benchmarks against the unchanged baseline.
- Record commit, environment, commands, repetitions, metrics, variability, and raw/structured results.

### 10.3 Implement

- Implement one bounded performance variation.
- Preserve behavioural intent.
- Record material complexity or maintainability changes.

### 10.4 Measure

- Run the same relevant benchmarks under comparable conditions.
- Compare candidate results to baseline.
- If no repeatable benefit appears, return to implementation for another sensible variation or conclude `No improvement found`.

### 10.5 Validate behaviour

- Run all selected behavioural tests.
- If behaviour changes, return to implementation where correction is sensible or conclude `Changes system behaviour`.

### 10.6 Recommend

The Team Lead records exactly one terminal recommendation:

- `No improvement found`
- `Improvement doesn’t justify complication`
- `Changes system behaviour`
- `Recommend merging`

The final workflow artifact includes:

- Baseline and candidate measurements with variability.
- Repeatability assessment.
- Behavioural test results.
- Complexity and maintainability assessment.
- New defect surface and operational risk.
- Recommendation and rationale.

The same structured result is written to SQLite. Only `Recommend merging` advances the change as a merge candidate. Its PR description must surface the complete comparison and recommendation. Other outcomes preserve the branch, commits, and findings but carry no merge recommendation.

## 11. SQLite design

Database path:

```text
<canonical-project-root>/.performance-optimisation/performance.sqlite
```

The implementation uses Bobbit's shared `better-sqlite3` runtime dependency. The database remains pack-owned and isolated from Bobbit's goal and gate databases; only the driver is shared.

Initial logical tables:

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

Database invariants:

- WAL mode, foreign keys, and bounded busy timeout.
- Forward-only versioned migrations.
- Prepared statements and explicit transactions.
- Stable IDs generated by pack code.
- Visible multi-table changes commit atomically.
- A monotonic pack revision increments with every panel-visible transaction.
- Activity reads are newest-first and retained to the latest 50 rows.
- Migration/corruption errors are surfaced; the database is never silently replaced.
- The pack owns content, retention, and compatibility policy. Bobbit owns only directory binding and sandbox access.

## 12. Agent tools

The final names may be grouped into one `performance-optimisation` tool contribution. The required behaviours are:

### Coverage

- `perf_coverage_refresh` — reconcile structural/cross-cutting units and fingerprints.
- `perf_coverage_get_modules_to_scan` — bounded ordered read for the Scanner.
- `perf_coverage_mark_module_as` — transactional state/attempt transition with delegate identity and claimed fingerprint.
- `perf_coverage_get_attempts` — reconciliation view for outstanding Scanner work.
- `perf_coverage_upsert_cross_cutting_unit` — Scanner-defined semantic unit whose members must resolve to known structural units/files.

### Hypotheses

- `perf_hypothesis_search` — exact and likely-match candidates.
- `perf_hypothesis_create` — validated, transactionally deduplicated creation.
- `perf_hypothesis_merge` — append an observation and update current locations.
- `perf_hypothesis_get_highest_priority` — ordered open hypotheses.
- `perf_hypothesis_mark_goal_creation` — atomic direct-creation claim or owned release.
- `perf_hypothesis_link_goal` — created-goal correlation.
- `perf_hypothesis_record_outcome` — workflow/Director conclusion.

### Benchmarks and programme

- `perf_benchmark_sync` — reconcile Bobbit-resolved named project commands and conventional repository benchmark scripts.
- `perf_benchmark_register` — register a reference to an existing validated named project command.
- `perf_benchmark_list` — project-owned benchmark references and applicability.
- `perf_benchmark_record_run` — baseline/candidate structured result.
- `perf_programme_get_settings` and `perf_programme_set_settings` — install-time/runtime settings.
- `perf_programme_get_activity` — newest-first bounded activity.

Every tool derives its database directory from the pack binding. No caller supplies a filesystem path or project identity. Inputs are bounded and validated, and writes return the committed pack revision.

## 13. Panel

The existing singleton panel retains three primary tabs:

- **Flow map** — Scanner, Director, active goals, Team Leads, PRs, benchmarks, tests, and recent activity.
- **Scan coverage** — structural and cross-cutting coverage, stale units, active attempts, and scan history.
- **Hypothesis registry** — priority, scheduling state, observations, linked goal, measurements, and outcome.

Data flow:

```text
Panel
  ├─ host.callRoute("performance-snapshot")
  │    └─ bounded SQLite projection, staff IDs, goal links, and pack revision
  └─ host.project.readStaff/readSessions/readGoals/readGoalTasks/readGoalGates/readGoalPullRequest
       └─ related Bobbit staff/session/goal/task/gate/PR summaries
```

The panel subscribes to canonical project notifications and `onRefreshRequired`. Relevant events trigger a coalesced route-first reread followed by correlated on-demand Host reads. Scanner/Director activity also causes SQLite rereads after their sessions settle. Browser code never opens SQLite or constructs Bobbit internal hashes.

The normal state is honest and empty until the programme is installed and runs. Development fixture data remains explicitly labelled and cannot be mistaken for project state. Activity is newest-first and capped at 50 rows.

## 14. Failure and recovery

- **Gateway restart:** SQLite and staff/inbox state are durable; the next scheduled wakes reconcile attempts, goal-creation claims, and goals.
- **Delegate disappears:** Scanner observes missing/terminal session state and decides whether to retry or fail the attempt.
- **Production changes during scan:** findings remain tied to the old fingerprint; coverage remains stale.
- **Duplicate tool delivery:** transactional exact fingerprint and state transitions make writes idempotent.
- **Director restarts during creation:** namespaced goal metadata finds and links a created goal before any retry.
- **Goal creation fails:** Director verifies that no correlated goal exists before releasing its claim to `open`.
- **No benchmark:** hypothesis becomes blocked-unmeasurable and may be reopened later.
- **Benchmark or test failure:** recorded as experiment evidence; it does not corrupt coverage state.
- **SQLite busy:** bounded retry/busy timeout; failure is explicit and does not produce a false success.
- **Migration/corruption failure:** panel and tools show a diagnostic; no automatic replacement.

## 15. Security and authority

- Pack server modules are trusted extension code.
- Agent tools receive only the server-derived pack-local binding.
- Paths in database records are repository-relative and never used as unrestricted host paths.
- Ideators are read-only except for performance registry tools.
- Staff schedules enqueue inbox work; they do not bypass staff/session authority.
- The Director autonomously creates and starts performance goals.
- Team Lead recommendations do not merge PRs automatically.
- Director discretion is bounded by existing Bobbit operations, workflow gates, repository protections, and durable audit records.

## 16. MVP acceptance

The MVP is complete when an enabled pack can demonstrate this real journey:

1. Installation skill asks for operating settings, adopts/creates Scanner and Director staff, and persists their stable IDs without duplication.
2. Map Builder creates structural and cross-cutting coverage from a fixture project.
3. Scanner delegates at least one stale unit to an Ideator.
4. Ideator creates or merges a hypothesis and completes the scan attempt.
5. Director claims the hypothesis, directly creates and links a correlated Explore Hypothesis goal, and starts its team.
6. Team Lead selects an existing benchmark, records baseline/candidate runs, runs behavioural tests, and records one terminal recommendation.
7. A recommended change produces a PR description containing measurement and complexity trade-off.
8. Coverage, hypotheses, goal state, decision, and latest activity appear in the panel.
9. Reload and gateway restart preserve state and reconcile without duplicate scans, hypotheses, staff, goal claims, or goals.
10. Disable/uninstall does not delete `.performance-optimisation/performance.sqlite`.
