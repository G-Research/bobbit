---
name: install-performance-optimisation
description: Configure the performance optimisation programme and idempotently adopt or create its two persistent staff agents.
allowed-tools: ask_user_choices, bobbit_read, bobbit_orchestrate, read, find, grep, perf_coverage_refresh, perf_benchmark_sync, perf_benchmark_list, perf_programme_get_session_context, perf_programme_get_settings, perf_programme_set_settings
---

# Install Performance Optimisation

Install into the current Bobbit project only. Use gateway tools directly; never hand-roll HTTP requests. This procedure may create staff, but it must never update, delete, rename, replace, or silently recreate an existing staff record.

## 1. Preflight the current project

1. Call `perf_programme_get_session_context` to read the gateway-issued current session ID, then call `bobbit_read(operation: "get_session", sessionId: ...)` for that exact session. Use only its returned `projectId`; do not infer project authority from connection information or the filesystem.
2. Call `bobbit_read(operation: "get_project", projectId: ...)`, `bobbit_read(operation: "list_roles", projectId: ...)`, and `bobbit_read(operation: "list_tools", projectId: ...)` with bounded limits. Stop if the exact session or project is missing, the session does not carry a project ID, the pack is disabled, either `performance-scanner` / `optimisation-director` is unavailable, or the programme configuration tools are unavailable.
3. Call `perf_programme_get_settings` before changing anything. Retain any recorded Scanner and Director staff IDs for identity reconciliation.

## 2. Ask for operating settings

Use one `ask_user_choices` call containing all four questions. Each question has an `Other` escape hatch for a custom value.

- **Scanner schedule:** `Manual only (manual)`, `Every 15 minutes (*/15 * * * *)`, `Hourly (0 * * * *)`, `Daily at 02:00 (0 2 * * *)`.
- **Director schedule:** `Manual only (manual)`, `Hourly (15 * * * *)`, `Every 4 hours (15 */4 * * *)`, `Daily at 03:00 (0 3 * * *)`.
- **Ideator parallelism:** `2`, `4`, `6`.
- **Active-goal target:** `1`, `2`, `3`, `4`.

Accept the exact sentinel `manual` (including a user's unambiguous “Manual only” answer) or validate a custom schedule as a standard five-field cron expression. Validate custom counts as positive bounded integers accepted by `perf_programme_set_settings`. Use the current project timezone when authoritative project configuration supplies one; otherwise explicitly use and report `UTC`. Do not silently repair invalid input: ask again with the validation error.

Call `perf_programme_set_settings` with exactly `{ scannerSchedule: <scanner cron>, directorSchedule: <director cron>, maxParallelIdeators: <count>, targetActiveGoals: <count> }`. The timezone belongs on the staff schedule triggers and in the report; it is not a programme-setting field. Report a tool failure and stop rather than claiming configuration succeeded.

## 3. Initialise coverage and discover existing benchmarks

Benchmark implementations remain project-owned. Installation only discovers and registers references; it must not create, edit, or execute benchmark commands.

1. Call `perf_coverage_refresh` once so applicability has a current deterministic production map before any staff wake.
2. Inspect bounded project configuration, repository manifests, and benchmark documentation under the authoritative project workspace. Candidate commands must already exist as either a Bobbit component command or a named manifest script. Use conventional names containing `benchmark`, `bench`, or `perf` only as discovery hints—not as proof.
3. Register a candidate only when repository-owned configuration or documentation establishes all of:
   - exact component and named command/script key (never shell text);
   - primary metric, unit, and higher/lower improvement direction;
   - repository-relative production file globs or known current scan-unit IDs that define applicability;
   - optional warm-up and repetition guidance when documented.
4. Never guess measurement semantics from a command name. Do not register load generators, profiling helpers, test-only fixtures, historical one-off measurements, or commands without a structured and repeatable measurement contract. Report each ambiguous candidate as skipped with the missing metadata.
5. Call `perf_benchmark_sync` exactly once with the complete bounded set of validated descriptors. An empty set is valid and must be reported honestly. Use stable IDs when the repository documents them. For package scripts, `commandName` is the script key such as `benchmark:session-open`, not `npm run benchmark:session-open`.
6. Call `perf_benchmark_list` to verify the committed catalogue. On a clean rerun, the same inputs must update in place rather than duplicate references.

This install-time sync is the MVP registration boundary. Scanner passes and Director wakes consume the catalogue but never redefine it. Re-run this installation skill after the project adds or changes benchmark commands. Benchmark creation in response to an unmeasurable hypothesis is a post-MVP capability and must not be improvised during installation.

## 4. Reconcile staff identities before writing

Call `bobbit_read(operation: "list_staff", projectId: ..., limit: 200)` once and preflight **both** desired identities before creating either:

| Stable name | Exact role | Accessory |
|---|---|---|
| `Optimisation Scanner` | `performance-scanner` | `magnifier` |
| `Optimisation Director` | `optimisation-director` | `crown` |

Apply these rules in order:

1. **Recorded ID exists:** adopt that exact project staff record if its role is still exact, even if the user renamed it or changed its prompt/schedule. Do not overwrite those user changes. A recorded ID pointing to another role or project is a blocking conflict.
2. **Recorded ID is missing:** do not fall back to a name match and do not recreate automatically. Use `ask_user_choices` to ask whether to create a replacement or stop. Only an explicit `Create replacement` answer permits the missing identity to continue as create-needed.
3. **No recorded ID:** inspect every exact stable-name match. Adopt one only when its role is exact. Any same-name record with the wrong role, or ambiguous duplicate exact-name records, blocks the installation. Never create a differently named duplicate to work around the conflict.
4. Complete this preflight for both identities. If either is blocked, stop before any staff creation and report the conflicting staff ID, name, and role.

An adopted staff record is left byte-for-byte unchanged. In particular, a rerun does not replace its schedule trigger. If the newly selected schedule differs from the existing trigger, report that an explicit user edit is required while still allowing pack-local parallelism/goal-target settings to change.

## 5. Create only missing staff

For each create-needed identity, call `bobbit_orchestrate(operation: "create_staff")` exactly once with the authoritative `projectId`, stable `name`, and these bodies.

### Optimisation Scanner

- `systemPrompt`: `Run the attached Optimisation Scanner role for this inbox item. Reconcile durable coverage and delegate state before selecting new scan work; finish with a concise activity summary.`
- `body.roleId`: `performance-scanner`
- `body.accessory`: `magnifier`
- `body.projectId`: the authoritative project ID
- Omit `body.cwd`; the gateway resolves the registered project root from the authoritative project ID.
- `body.worktree`: `false`
- `body.triggers`: when the Scanner schedule is `manual`, an empty array; otherwise one enabled schedule trigger with `config: { cron: <scanner cron>, timezone: <timezone> }` and prompt `Refresh performance coverage, reconcile outstanding attempts, and fill available Ideator capacity.`

### Optimisation Director

- `systemPrompt`: `Run the attached Optimisation Director role for this inbox item. Reconcile direct goal-creation claims and active goals before filling target concurrency; log every intervention.`
- `body.roleId`: `optimisation-director`
- `body.accessory`: `crown`
- `body.projectId`: the authoritative project ID
- Omit `body.cwd`; the gateway resolves the registered project root from the authoritative project ID.
- `body.worktree`: `false`
- `body.triggers`: when the Director schedule is `manual`, an empty array; otherwise one enabled schedule trigger with `config: { cron: <director cron>, timezone: <timezone> }` and prompt `Reconcile direct performance goal creation and active goals, then fill available optimisation capacity.`

Use schedule-trigger objects compatible with the gateway contract: `{ type: "schedule", config: { cron, timezone }, prompt, enabled: true }`. Manual-only staff receive `triggers: []` and are run explicitly from their Staff action; never invent a cron schedule for them. Never invoke any staff deletion or update operation.

## 6. Persist IDs and report

After creation, verify the returned IDs by calling the bounded project staff list again. The programme tool exposes stable identity fields, so call `perf_programme_set_settings` again with exactly `{ scannerStaffId: <adopted-or-created ID>, directorStaffId: <adopted-or-created ID> }`; omitted operating fields retain their configured values. If a future tool version does not expose those ID fields, do not invent arguments or alternate storage: report that ID persistence is unavailable and keep the installation result explicit.

Finish with the project ID, effective programme settings, timezone, coverage initialisation result, every registered benchmark reference, every skipped candidate with its reason, and each staff ID marked `adopted` or `created`. A clean rerun with stored IDs must create zero staff. Never claim success when an identity conflict, missing recorded ID decision, configuration write, staff creation, verification, or supported ID-persistence write remains unresolved.
