# Bound Async Recovery I/O

## Status

Implemented and verified on 2026-07-18. This document records the shipped design and its behavior-preservation boundaries.

The work was ported narrowly from performance-audit reference material rather than applying the aggregate patch. It changes internal scheduling and I/O seams only; it adds no user-facing feature, recovery policy, route, payload, or UI state.

## Context

Bobbit performs several best-effort recovery operations during gateway startup. Historical installations can contain wide agent-session trees, so synchronous directory discovery, stat calls, and transcript-header reads can hold Node's single event loop long enough to delay unrelated work. Model configuration values beginning with `!` also used a synchronous child process and could block the event loop for the full 15-second command timeout.

The implementation moves those waits to asynchronous I/O while preserving the existing decisions made from the data. That distinction matters: making recovery concurrent must not let completion order replace listing order, change which duplicate wins, expose partially restored teams, or turn one unreadable file into a failed boot.

## Implemented architecture

### Shared bounded recovery worker

`src/server/agent/bounded-async-work.ts` owns the shared limit and worker:

```ts
export const RECOVERY_IO_CONCURRENCY = 8;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]>;
```

The cap of eight is intentionally small. It provides enough overlap for filesystem latency without creating one promise or file operation per historical entry. The worker:

- rejects a non-positive or non-integer limit;
- uses a monotonic numeric cursor rather than `Array.shift()`;
- starts at most `min(limit, items.length)` long-lived workers;
- uses `Promise.all` only for that fixed worker array; and
- stores each result by input index, so completion order cannot change output order.

Callers isolate expected per-item I/O failures. Unexpected programming errors can still reject the lifecycle operation.

Nested scans do not multiply the limit. For example, team agent directories and trusted roots are visited sequentially because each inner file scan already has up to eight workers. Cost transcript lookup is similarly sequential inside each of the capped outer session workers.

### Injectable asynchronous filesystem

The same module exports `RecoveryFs`, `RecoveryStats`, and `RecoveryFileHandle`. `RecoveryFs` contains only the asynchronous operations used by recovery: `access`, `readdir`, `stat`, `open`, and UTF-8 `readFile`. `realRecoveryFs` adapts those methods to `fs.promises`.

Recovery logic accepts this interface instead of calling global filesystem functions. This keeps production I/O asynchronous and lets unit tests defer individual operations, return deterministic directory order, inject failures, record calls, and measure active concurrency without touching disk.

Header reads use `open`, one positional `read`, and `close` rather than reading an entire transcript. Handles are closed in `finally`; a close failure is swallowed so it does not replace a successful header read or an earlier failure.

`session-sidecar.ts` now separates pure `parseSessionSidecar()` validation from `readSessionSidecarAsync()`. The async reader accepts the injected filesystem and is used by the changed cost and team recovery paths. The existing synchronous sidecar reader remains only for unchanged call sites outside this recovery scope; there is no duplicate synchronous recovery scan.

## Cost recovery

### Sidecar pass

`backfillLegacyCostGoalIds()` and `buildSidecarGoalIdIndex()` now return promises and accept `fs?: RecoveryFs` through their options or parameters.

The sidecar pass preserves this priority for each unstamped cost session:

1. persisted `teamGoalId`;
2. persisted `goalId`;
3. the sidecar adjacent to the persisted `agentSessionFile`;
4. the global historical sidecar index.

Persisted metadata and adjacent sidecars are resolved with the capped worker. The global index is built once, and only when at least one session remains unresolved. Root directories are scanned concurrently up to the shared cap, but sidecars within each directory are read sequentially. Candidate pairs are flattened only after the workers settle, in root-entry and file-entry order, so duplicate `bobbitSessionId` values remain first-wins even when later I/O completes first.

`CostTracker.backfillGoalIds()` remains the single mutation point. Already stamped entries, generation bumps, persistence behavior, returned counts, and summary logging therefore retain their previous semantics. Missing roots return an empty index; the established warning for an unreadable root and best-effort skipping of malformed or unreadable children are unchanged.

### Transcript pass

`backfillLegacyCostGoalIdsFromTranscripts()` accepts `fs?: RecoveryFs` and an injectable `clock`. At most eight session workers are active. Within one session, root and child entries remain sequential because the first valid `<sessionId>.jsonl` or `*_<sessionId>.jsonl` in listing order is contractual.

A transcript header is bounded twice:

- one positional read of at most `maxBytes` (64 KiB by default); and
- at most `maxLines` (50 by default), including a truncated final line.

The confidence parser, known-goal check, accepted filename shapes, and attribution results are unchanged. No whole transcript is loaded for a header decision.

The deadline scheduler checks the existing strict condition `clock.now() - start > deadlineMs` immediately before claiming another index. Work at exactly the deadline may start. Once a worker observes expiry, dispatch closes atomically, already-claimed sessions finish, and the unclaimed suffix becomes the exact `skipped` count. Results are then applied in the original unstamped-session order.

### Cost lifecycle

The sidecar pass remains a required pre-listen phase. It runs sequentially per project after session restoration and is awaited under the existing non-fatal boot catch.

The transcript pass remains post-listen work. It runs sequentially per project inside `runBootBackgroundTasks()` alongside the existing sweeper and pool initialization. The server still launches that aggregate after listening, but the transcript task does not detach work beneath the aggregate: all claimed session scans settle before the transcript task completes. This preserves the existing visible startup boundary while removing synchronous event-loop stalls.

## Team consistency recovery

`scanSlugDirForJsonlsAt()` and `discoverAgentsForGoal()` were converted in place to return promises and accept `RecoveryFs`; no synchronous `*Async` twin or parity implementation was added.

A slug-directory scan:

1. awaits the directory listing and returns an empty set if it is unavailable;
2. filters `.jsonl` names;
3. stats and reads candidates with the shared capped worker;
4. reads at most the first 2,048 bytes through the first newline;
5. accepts only a session header whose `cwd` exactly matches and whose `id` is a string; and
6. returns valid candidates in directory-entry order.

Timestamp fallback, candidate size/mtime fields, malformed-header handling, and per-file isolation are unchanged. Canonical selection remains newest mtime first, then largest size, with stable listing order resolving a full tie.

Agent discovery preserves root listing order and the existing slug validation: a role followed by an eight-character lowercase hexadecimal id. Matched agent directories are scanned sequentially, preventing an inner eight-worker scan from becoming an unbounded nested pool. Empty or unreadable agent directories omit only that agent.

`TeamManagerConfig` now exposes two test seams:

```ts
recoveryFs?: RecoveryFs;
recoverySidecars?: TeamRecoverySidecars;
```

`TeamRecoverySidecars` provides async `exists`, `read`, and `write`. Its production implementation retains atomic temporary-file-to-rename writes and the existing best-effort warning behavior. Recovery tests can inject the whole sidecar boundary, so no mocked scan falls through to global filesystem access.

Trusted agent-session roots are still visited sequentially. De-duplication occurs after each root in root order, so the first trusted root remains authoritative. Project, goal, and discovered-agent loops also remain sequential. Consequently, sidecar metadata still overrides heuristic reconstruction, the recovered session set and insertion order remain stable, UUID/name generation order does not change, and store mutations and diagnostics are emitted in their established order.

### Team lifecycle

The `TeamManager` constructor starts one restoration promise and exposes:

```ts
waitForRestore(): Promise<void>;
```

The server now enforces this pre-listen order:

```ts
await bootPhase("restore-teams", () => teamManager.waitForRestore());
await bootPhase("restore-sessions", () => sessionManager.restoreSessions());
```

Recovered persisted records therefore exist before live-session revival. `resubscribeTeamEvents()` remains after session restoration, and the stuck-team sweep starts only after team restoration succeeds. No boot consumer needs to infer completion from constructor timing or observe a partially restored team map.

The existing recovery passes and policies are unchanged. This includes sidecar identity precedence, dangling-team cleanup, fully orphaned team-lead recovery, non-team-lead recovery, title upgrades, and sidecar backfill. In particular, this work did not add untracked-team adoption or change session restoration or lazy-revival policy.

## Model configuration commands

`model-completion.ts` no longer uses `execSync` for a config value beginning with `!`. It defines a narrow injectable seam:

```ts
export interface ModelConfigCommandRunner {
  execFile(
    file: string,
    args: readonly string[],
    options: { encoding: "utf-8"; timeout: number; windowsHide: boolean },
  ): Promise<{ stdout: unknown; stderr: unknown }>;
}
```

The production adapter promisifies `node:child_process.execFile` directly. It does not use a retrying command wrapper, because the previous command path performed no retries.

`resolveConfigValue()` is now async and accepts both the runner and environment. `completeModelText()` carries them, plus an injectable provider-config reader, in `ModelCompletionDependencies`. This makes command execution and provider configuration deterministic in tests without changing existing call compatibility.

The command contract remains:

- POSIX uses `/bin/sh` with `['-c', command]`;
- Windows uses the injected environment's `ComSpec`, falling back to `cmd.exe`, with `['/d', '/s', '/c', command]`;
- the leading `!` is removed from the command text;
- options are exactly `{ encoding: 'utf-8', timeout: 15_000, windowsHide: true }`;
- cwd and environment are inherited because they are not overridden;
- Node's default piped streams and output buffer remain in effect, with no stdin input supplied;
- string output is trimmed and Buffer output is decoded as UTF-8;
- successful stderr is ignored; and
- empty or unusable output, spawn failure, non-zero exit, signal, rejection, or timeout maps to `undefined` without a retry, new log, or new user-facing error.

API-key resolution is awaited before header resolution. AIGW header entries are awaited sequentially, retaining object insertion order. The model request does not begin until command-backed configuration has settled. Literal values, environment-variable lookup, the special `none` value, credential precedence, OAuth refresh, model routing, completion options, response parsing, and error messages are unchanged.

The 15-second limit is still a process timeout, not a completion timeout. The behavioral difference is only that Node can service unrelated work while the process promise is pending.

## Determinism and error isolation

The implementation preserves the following invariants:

- no recovery filesystem item pool exceeds `RECOVERY_IO_CONCURRENCY`;
- nested scans do not multiply the cap;
- results are committed in input order rather than completion order;
- cost sidecar duplicates and transcript candidates retain first-listing semantics;
- trusted team roots retain first-root semantics;
- canonical team transcript ties remain stable;
- team store mutation, identity generation, and diagnostic order remain sequential;
- an unreadable root, directory, stat, file, header, close, malformed record, or command failure does not abort successful siblings; and
- required pre-listen recovery remains awaited at its lifecycle boundary.

These constraints are why the implementation uses index-cursor workers instead of an unbounded `Promise.all`, and why searches with first-match semantics are deliberately sequential inside the outer pool.

## Behavior-preservation boundary

This goal did not change:

- preview artifacts or mounts;
- maintenance endpoints;
- TLS/OpenSSL helpers or shell utility probes;
- Pi-extension or PR Walkthrough hashing;
- background-process polling, watchers, or timer scheduling;
- FlexSearch or persistence stores;
- session restoration policy, lazy revival, or team adoption policy;
- model authentication precedence, routing, request timeout, or completion semantics; or
- UI, REST/WS formats, routes, payloads, or visible loading behavior.

No new reliability setting, retry, or user configuration was introduced.

## Verification evidence

The focused verification used the two cost suites and the new team-scan, team-lifecycle, and model-command suites. The final integrated run passed 59 tests across those five files in 1.70 seconds. The recorded test-body durations were 7 ms and 9 ms for the cost files and 699 ms and 7 ms for the team files, comfortably below the unit file budget.

All new coverage is registered as Vitest `unit`/`core`. It uses fake or in-memory I/O only: no real filesystem, temporary directory, child process, network, Docker, Git, sleeps, polling, or wall-clock performance assertion. Deferred promises prove that an unrelated microtask progresses while filesystem or process I/O remains pending. Active-operation instrumentation proves the cap, while fixed fixtures prove ordering and output parity.

The focused tests cover:

- wide sidecar, transcript, and team scans with a measured maximum of eight active operations;
- missing and unreadable roots, directories, stats, files, headers, and successful siblings around one failure;
- malformed and truncated records plus bounded read sizes;
- live/adjacent/global cost priority, first-wins duplicates, first-match transcripts, exact confidence fixtures, and the strict deadline boundary;
- exact team candidate validation, canonical selection, trusted-root order, recovered set, sidecar precedence, and awaited boot ordering; and
- exact model executable, arguments, options, 15-second timeout, sequential resolution, successful parsing, malformed output, non-zero exit, rejection, signal, and timeout mapping.

The implementation gate then passed `npm run build`, `npm run check`, `npm run test:unit`, `npm run test:browser`, and `npm run test:e2e`, followed by gap, code-quality, journey-coverage, bug-hunt, and security reviews. The browser stage recorded 659 passing tests, eight expected skips, and no per-spec budget violations. `git diff --check` also passed before the implementation signal.

### Why no new E2E scenario was added

No new journey or adapter smoke was added specifically for this change. There is no new user action, UI state, route, payload, loading transition, or restoration decision for a browser test to observe. The risk introduced by the refactor is internal scheduling—concurrency ceilings, completion-versus-listing order, deferred progress, bounded reads, and error mapping—which is more precisely and deterministically tested through the injected fake filesystem and command runner.

The existing broad browser and E2E commands still ran successfully as regression coverage. A new real-I/O smoke would have duplicated unit behavior while making the test slower and dependent on platform filesystem or shell timing.
