# Bound Async Recovery I/O

## Status

Implementation design for the **Bound Async Recovery I/O** goal. The implementation must be ported narrowly onto the current `origin/master`; `bobbit-perf-fixes.patch` and `bobbit-perf-fixes.md` are reference material only and must not be applied.

## Problem

Three remaining paths can monopolize Bobbit's single Node event loop:

1. `cost-backfill.ts` synchronously discovers historical session directories, searches transcripts, and reads transcript headers while resolving legacy costs.
2. `team-store-consistency.ts`, called by `TeamManager.restoreTeams()`, synchronously scans historical slug directories and reads JSONL headers while reconstructing lost team sessions.
3. `model-completion.ts::resolveConfigValue()` uses `execSync` for `!command` model configuration values and can block the event loop for the full 15-second timeout.

These are internal recovery/configuration operations. The change must not alter recovered data, attribution confidence, team/session ordering, boot visibility, model request behavior, logs, REST/WS shapes, or UI state.

## Current contracts to preserve

### Cost backfill

`backfillLegacyCostGoalIds()` currently resolves each unstamped session in this order:

1. persisted session `teamGoalId`;
2. persisted session `goalId`;
3. the sidecar adjacent to `agentSessionFile`;
4. a lazily built, one-shot index of all `*.bobbit.json` sidecars.

The global sidecar index walks root entries and child names in their returned `readdir` order. Duplicate `bobbitSessionId` values are **first-wins**. Malformed/unreadable sidecars and per-entry stat/readdir failures are ignored. A missing root yields an empty map; a root read failure retains the existing warning text. Already stamped entries remain untouched, and `CostTracker.backfillGoalIds()` remains the single mutation point so persistence and generation-bump behavior stay unchanged.

`backfillLegacyCostGoalIdsFromTranscripts()`:

- considers only unstamped sessions;
- accepts both `<sessionId>.jsonl` and `*_<sessionId>.jsonl`;
- chooses the first valid file in root-entry/child-entry order;
- reads at most `maxBytes` (default 64 KiB), then retains at most `maxLines` (default 50), including a truncated final line;
- applies the existing known-goal and confidence rules unchanged;
- checks the project deadline using the existing strict `elapsed > deadlineMs` condition before starting another session;
- lets already-started work finish, counts work not started after the deadline as `skipped`, and then performs one ordered `backfillGoalIds()` call;
- preserves summary and deadline-suffix logging.

The transcript pass intentionally remains part of the post-listen boot background aggregate. The aggregate already awaits the transcript task together with sweeper and pool initialization; the implementation must not detach per-session work or change visible startup/loading behavior.

### Team consistency recovery

`scanSlugDirForJsonlsAt()` currently:

- derives one slug directory with `slugDirNameForCwd()`;
- considers only names ending in `.jsonl`;
- stats each candidate and reads only its first 2,048 bytes;
- parses bytes through the first newline, or all bytes read when no newline exists;
- accepts only `{ type: "session", cwd: worktreeCwd, id: string }`;
- uses parsed `timestamp`, otherwise `stat.mtime.toISOString()`;
- returns candidates in directory-entry order and isolates every per-file failure.

`discoverAgentsForGoal()` currently preserves session-root entry order, applies the existing slug-prefix and `role + eight-lowercase-hex-id` validation, derives the same worktree path, and omits matched agent directories that contain no valid candidates.

`team-manager.ts` scans `trustedAgentSessionsRoots()` sequentially and de-duplicates by resolved path. Thus the first root remains authoritative. `pickCanonicalTeamLeadJsonl()` remains mtime-first and size-second; stable input order is the final tie-break. Recovery passes mutate stores and emit diagnostics in project/goal/agent order. Sidecar metadata continues to override heuristic reconstruction.

The current `origin/master` has no CON-06 untracked-team-lead adoption pass. This goal must not import that unrelated aggregate-patch feature. “Adopted” identity here means exact bobbit identity adopted from an existing sidecar during reconstruction. If a separate adoption change lands before implementation, its existing set, ordering, validation, and diagnostics must be treated as another parity fixture rather than copied from the reference patch.

`TeamManager.restoreTeams()` runs before `SessionManager.restoreSessions()`. Recovered persisted records therefore exist before live-session revival, while `resubscribeTeamEvents()` remains after live-session restoration.

### Model command resolution

For a trimmed config string beginning with `!`, `resolveConfigValue()` currently executes the remaining string through Node's platform-default shell with:

- inherited cwd and environment;
- piped/default stdin, stdout, and stderr handling;
- UTF-8 stdout;
- `windowsHide: true`;
- a 15,000 ms timeout;
- the normal default output buffer;
- stderr ignored on a successful exit;
- trimmed stdout returned, or `undefined` for empty stdout;
- every spawn error, rejection, non-zero exit, signal, timeout, or unusable output mapped to `undefined` without a new log or user-facing error.

Literal values, environment-name lookup, and the special literal `none` remain unchanged. Header keys retain object insertion order and are resolved sequentially. No auth-provider precedence, credential refresh, model routing, request timeout, or completion parsing behavior changes.

## Design

### 1. Shared bounded worker primitive

Add `src/server/agent/bounded-async-work.ts` containing:

```ts
export const RECOVERY_IO_CONCURRENCY = 8;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]>;
```

Requirements:

- `RECOVERY_IO_CONCURRENCY` is documented and statically greater than zero.
- Reject a non-positive/non-finite limit as a programmer error rather than silently creating a dead pool.
- Allocate a result array by index, use a monotonic numeric cursor, and start only `min(limit, items.length)` long-lived workers.
- `Promise.all` is permitted only for that fixed, capped worker array; never create one promise per scanned item.
- Do not use `Array.shift()` or another O(n) work queue.
- Return results in input order regardless of completion order.
- Callers, not the primitive, implement per-item error isolation. Unexpected programmer errors may still reject the lifecycle operation.

Both filesystem modules use this primitive. No synchronous production scan is retained merely to compare async parity.

### 2. Injectable asynchronous recovery filesystem

In the same file, define the smallest structural asynchronous I/O seam needed by both modules:

```ts
export interface RecoveryStats {
  size: number;
  mtime: Date;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface RecoveryFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number):
    Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface RecoveryFs {
  access(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<RecoveryStats>;
  open(path: string, flags: "r"): Promise<RecoveryFileHandle>;
  readFile(path: string, encoding: "utf-8"): Promise<string>;
}
```

Export a `realRecoveryFs` adapter backed only by `fs.promises`. Logic under test receives `RecoveryFs`; it must not call global `fs` directly. Test doubles can defer and record every operation, return ordered directory listings, inject errors, and track active operations.

Header helpers use `open/read/close`, not `readFile`, so transcript data is bounded. `close()` is awaited in `finally` and its error is swallowed without replacing a successful read or an earlier failure.

### 3. `src/server/agent/session-sidecar.ts`

Factor the existing schema validation into a pure `parseSessionSidecar(raw: string): SessionSidecar | null`. Keep the existing synchronous reader only for unchanged production call sites that are outside this goal; it delegates to the same parser and is not a second recovery-scan implementation.

Add:

```ts
export async function readSessionSidecarAsync(
  jsonlPath: string,
  fsImpl: Pick<RecoveryFs, "readFile"> = realRecoveryFs,
): Promise<SessionSidecar | null>;
```

It derives the path through the unchanged `sidecarPathFor()`, awaits injected UTF-8 `readFile`, and returns `null` for read or parse failure. All cost/team recovery paths changed by this goal use the async function. Parser validation and sidecar-wins semantics do not change.

For `TeamManager`'s boot sidecar backfill, add a narrow injected recovery-sidecar adapter to `TeamManagerConfig` (async existence/read/write operations, defaulting to production helpers). This prevents mocked unit recovery from falling through to global filesystem writes. The default writer preserves the existing atomic tmp-to-rename sidecar behavior and per-session warning behavior. It is awaited in the existing pass, in existing session order; it is not made fire-and-forget.

### 4. `src/server/agent/cost-backfill.ts`

#### Interfaces and signatures

Extend both option types with injectable dependencies:

```ts
fs?: RecoveryFs;
clock?: { now(): number }; // transcript pass only
```

Default to `realRecoveryFs` and `{ now: Date.now }` in production.

Change:

```ts
backfillLegacyCostGoalIds(...): Promise<CostBackfillResult>
buildSidecarGoalIdIndex(...): Promise<Map<string, string>>
```

`backfillLegacyCostGoalIdsFromTranscripts()` is already async.

#### Sidecar pass

Replace the synchronous resolver with two phases:

1. Build an ordered `Map<sessionId, goalId>` asynchronously for the current `getUnstampedSessionIds()` snapshot.
   - Resolve persisted `teamGoalId`/`goalId` synchronously first.
   - For unresolved persisted records with `agentSessionFile`, read the adjacent sidecar asynchronously using the injected filesystem.
   - Only if at least one item remains unresolved, lazily create one shared `Promise<Map<...>>` for the global sidecar index. Multiple workers await the same promise; no duplicate tree scans occur.
   - Process unstamped sessions with `mapWithConcurrency(..., RECOVERY_IO_CONCURRENCY, ...)`, with each worker isolating its own sidecar failure.
2. Call `costTracker.backfillGoalIds(sid => resolved.get(sid))` once, then calculate and log the existing result exactly.

`buildSidecarGoalIdIndex()` awaits root discovery and uses the bounded ordered worker over root entries. Each root-entry worker stats its slug, reads that directory, and reads matching sidecars sequentially. It returns ordered candidate pairs. After workers finish, flatten results in original root-entry/file-entry order and apply the unchanged first-wins `Map.has()` rule. This allows concurrent slug work without completion order changing duplicate resolution. Missing root and unreadable child handling stay best-effort; the existing root warning remains byte-for-byte.

#### Transcript lookup and headers

Replace `findTranscriptPath()` and `readTranscriptHead()` with injected async versions.

`findTranscriptPath()` keeps each individual session search sequential across root entries and child entries. Concurrency exists at the outer session-worker level, so making inner traversal concurrent would only multiply the cap and risk first-completion replacing first-match. Every `stat`, `readdir`, and candidate-file failure remains local to that item.

`readTranscriptHead()` allocates exactly `maxBytes`, performs one positional read from offset zero, decodes only `bytesRead`, then applies the existing line cap. It never reads the whole transcript.

The transcript scheduler uses one monotonic index cursor shared by at most eight workers. Immediately before claiming an index, it evaluates `clock.now() - start > deadlineMs`. The first expired check atomically closes dispatch and sets `skipped` to the number of indices not yet claimed. Sessions already claimed finish. This makes the deadline boundary and skipped count deterministic under concurrency while retaining the prior “check before session, not during its I/O” semantics. Result application remains one ordered map lookup after all in-flight scans settle.

### 5. `src/server/server.ts` cost lifecycle

Await `backfillLegacyCostGoalIds()` in the existing pre-listen per-project loop. Projects remain sequential and the surrounding non-fatal catch, timing threshold, log messages, and pre-listen boundary remain unchanged.

Keep the transcript pass in `runBootBackgroundTasks()`. It continues to await each project sequentially, and `runBootBackgroundTasks()` continues to await it in the fixed three-task aggregate. Do not add detached scan work beneath it and do not move the pass pre-listen.

### 6. `src/server/agent/team-store-consistency.ts`

Convert the existing exported scan functions in place; do not add `*Async` twins:

```ts
export async function scanSlugDirForJsonlsAt(
  sessionsDir: string,
  worktreeCwd: string,
  fs: RecoveryFs,
  join: (...parts: string[]) => string,
): Promise<CandidateJsonl[]>;

export async function discoverAgentsForGoal(
  sessionsDir: string,
  teamLeadWorktreePath: string,
  fs: RecoveryFs,
  join: (...parts: string[]) => string,
  dirname: (p: string) => string,
  basename: (p: string) => string,
): Promise<DiscoveredAgent[]>;
```

Remove `MinimalFs` and the synchronous `readdirSync/statSync/openSync/readSync/closeSync` implementation.

`scanSlugDirForJsonlsAt()`:

1. awaits injected `readdir`, returning `[]` on root failure;
2. filters `.jsonl` names without I/O;
3. runs file work through the shared capped worker;
4. for each name, awaits stat and one bounded 2,048-byte header read, parses/validates exactly as today, and returns `undefined` for any item failure;
5. filters the ordered result array, preserving directory order.

`discoverAgentsForGoal()` parses matching root names in the original order, then scans matched agent directories **sequentially**. Each inner file scan is itself capped at eight. This avoids a nested `8 × 8` concurrency explosion while still moving all filesystem work off the event loop. It also preserves agent ordering and best-effort isolation. An unreadable agent directory omits only that agent.

All pure helpers (`pickCanonicalTeamLeadJsonl`, reconstruction, slug parsing, purge guards, title logic) remain unchanged.

### 7. `src/server/agent/team-manager.ts` and boot lifecycle

Make both trusted-root wrappers async and pass the configured `RecoveryFs`:

- `scanSlugDirForJsonls(worktreePath): Promise<CandidateJsonl[]>`
- `discoverAgentsForGoalAcrossSessionRoots(teamLeadWorktreePath): Promise<DiscoveredAgent[]>`

Trusted roots remain sequential. De-duplication remains after each awaited root in root order, so first-root wins and output order is stable.

Convert `restoreTeams()` to `async`. Await scans and async sidecar reads at their current positions in passes 2, 3, and 5. Continue processing contexts, goals, and discovered agents sequentially so:

- recovered session records are the exact current set;
- sidecar-adopted identities remain exact;
- generated UUID/name call order remains stable;
- store `put/remove/update` order remains stable;
- count summaries and per-item diagnostics retain their existing order and text;
- one scan/read/reconstruction failure does not abort sibling goals or agents.

The constructor starts exactly one restore promise and exposes:

```ts
waitForRestore(): Promise<void>;
```

The stuck-team sweep is armed only after that promise settles successfully. No operational boot task is allowed to observe a partially restored team map.

In `src/server/server.ts`, add a named boot phase immediately before `restore-sessions`:

```ts
await bootPhase("restore-teams", () => teamManager.waitForRestore());
await bootPhase("restore-sessions", () => sessionManager.restoreSessions());
```

`resubscribeTeamEvents()` remains after `restoreSessions()`. Thus required recovery is awaited before session revival and before listen; it is not backgrounded. Non-project/test construction must also await `waitForRestore()` before asserting restored state or invoking resubscription.

### 8. `src/server/agent/model-completion.ts`

Remove `execSync` from this module. Add a narrow injectable `ModelConfigCommandRunner` async process seam local to this module, with `execFile(file, args, options): Promise<{ stdout; stderr }>` and a production adapter built directly from promisified `node:child_process.execFile`. Do **not** use `realCommandRunner`/`execFileSafe` for the default: that wrapper retries selected spawn failures, while the current model-config command has no retries. The seam exists solely to preserve and test this command contract without spawning in unit tests.

Add a pure platform-shell descriptor local to this module that matches Node `execSync(command)` defaults rather than importing or modifying `shell-util.ts`:

- POSIX: executable `/bin/sh`, args `['-c', command]`;
- Windows: executable `process.env.ComSpec || 'cmd.exe'`, args `['/d', '/s', '/c', command]`.

Do not use `getShellConfig()`: it prefers Git Bash on Windows, which would change the current `execSync` shell contract.

Make `resolveConfigValue()` async and injectable/exported for direct unit coverage:

```ts
export async function resolveConfigValue(
  value: unknown,
  commandRunner: ModelConfigCommandRunner = realModelConfigCommandRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined>;
```

For commands, call `execFile(shell, args, { encoding: 'utf-8', timeout: 15_000, windowsHide: true })`. Do not specify cwd, env, stdio, shell, input, or maxBuffer: omission preserves inherited cwd/environment and Node's default piped streams/buffer with no supplied stdin. Accept only string/Buffer stdout, convert Buffer as UTF-8, trim it, and return `undefined` for empty/malformed output. Ignore successful stderr. Catch every rejection, including non-zero exit, timeout, signal, and spawn failure, and return `undefined` with no retry and no new log/error text.

Make `resolveProviderHeaders()` async and resolve entries sequentially with `await`, preserving header insertion order. Thread the same runner and environment from `completeModelText()` via a final optional dependency parameter so existing `completeFn` injection remains source-compatible. `resolveProviderApiKey()` awaits command-backed `apiKey` resolution through the same runner. No completion request is started until all required config commands settle.

Do not copy the aggregate patch's unrelated OAuth/auth precedence changes.

## Determinism and concurrency invariants

1. At most `RECOVERY_IO_CONCURRENCY` filesystem item workers run in either recovery module.
2. Nested scans never multiply the limit.
3. Results are committed in input order, never completion order.
4. Cost duplicate sidecars and transcript candidates retain first-in-listing semantics.
5. Team trusted-root de-duplication retains first-root semantics.
6. Equal-mtime/equal-size team candidates retain stable listing order.
7. Store mutation, UUID/name generation, and diagnostic order remain sequential.
8. One unreadable root, directory, stat, file, header, close, or malformed record cannot abort successful siblings.
9. No required recovery task is detached from its existing lifecycle boundary.
10. No whole transcript is read for a header decision.

## Mocked-only unit plan

All new or rewritten unit tests use structural fakes and in-memory state only. They must not call real `fs`, `os.tmpdir()`, `mkdtemp`, Docker, Git, network, or child processes; must not use arbitrary sleeps, polling sleeps, performance thresholds, fake long-running commands, broad module resets, retries, skips, or global-state mutation.

### Shared fakes

Add a test-only deferred `RecoveryFs` under `tests2/harness/` with:

- explicit directory/file/stat/header fixtures;
- ordered `readdir` results;
- per-operation call records;
- deterministic injected errors;
- deferred promises controlled by the test;
- active/max-active counters around every operation;
- bounded header data and close-call recording.

Use a tiny deferred helper and explicit microtask turns. Event-loop friendliness is proven structurally: invoke the production function, leave an I/O promise unresolved, run an independent queued microtask, assert it progresses while the operation remains pending, then release I/O. There are no elapsed-time assertions.

Use an in-memory fake `CostTracker` implementing only `getUnstampedSessionIds()`, `backfillGoalIds()`, and result inspection. Existing pure confidence tests remain direct.

### Cost backfill coverage

Rewrite affected cost-backfill tests to await both passes and use only fake I/O. Add/extend fixtures proving:

- empty unstamped set performs no filesystem calls and does not bump generation;
- live `teamGoalId` beats `goalId`, both beat adjacent sidecar, and adjacent sidecar beats global index;
- the global index is built lazily and exactly once even when multiple workers need it;
- missing root, unreadable root with unchanged warning, unreadable slug, bad stat, unreadable/malformed/version-invalid sidecar, and one failed sibling do not abort successful siblings;
- duplicate sidecars are first-wins in root/file order even when the later file resolves first;
- a wide mixed old/new fixture returns the exact stamped/unattributable map and stable summary log;
- exact and timestamp-prefixed transcript names are accepted; unrelated suffixes and non-files are rejected;
- duplicate transcript candidates choose the first listing match even when later I/O resolves first;
- headers stop at `maxBytes`/`maxLines`, preserve a truncated final line, and never request more than the configured byte cap;
- no-known-goal, unknown UUID, prose-only, ambiguous UUID, and high-confidence fixtures preserve exact attribution results;
- missing roots, unreadable directories/stats/files, malformed headers, and one failed transcript among successful siblings complete best-effort;
- a wide scan completes with `maxActive <= RECOVERY_IO_CONCURRENCY` and all expected results;
- deferred I/O permits unrelated scheduler progress;
- injected clock at exactly the deadline still starts work (`>` contract); after crossing it, already-claimed sessions finish and the exact unclaimed suffix is reported as `skipped`.

### Team consistency coverage

Add `tests2/core/team-store-consistency-async-io.test.ts` using the same fake:

- exact candidate descriptor parity for fixed headers, including timestamp fallback, size, mtime, and input order;
- non-JSONL, wrong type, wrong cwd, missing/non-string id, malformed JSON, empty/truncated 2,048-byte header, unreadable stat/open/read/close, and one-item failure;
- missing/unreadable slug directory returns `[]`;
- wide directory scans complete and never exceed the cap;
- deferred reads prove scheduler progress;
- agent slug parsing accepts coder/reviewer/qa roles with eight lowercase hex ids, rejects malformed/unrelated names, omits empty/unreadable agent directories, and preserves listing order;
- sequential nested agent scans keep global max activity at or below the cap;
- canonical selection remains mtime-first, size-second, stable on ties.

Add `tests2/core/team-manager-async-recovery.test.ts` with in-memory project/team/session stores, injected roots, sidecar adapter, deterministic UUID/name seams if required, and deferred recovery I/O. Assert:

- `waitForRestore()` remains pending while scan I/O is deferred and completes only after all required recovery work;
- server-order contract is represented by awaiting team restore before fake session restoration/resubscription;
- a fixed pass-2/pass-3/pass-5 fixture yields the exact recovered session set and insertion order;
- sidecar metadata wins without changing which transcript is canonical;
- duplicate trusted roots retain first-root results;
- unreadable work for one goal/agent preserves successful siblings and exact diagnostics;
- team map/reverse lookup is not exposed as fully restored before the promise resolves;
- no current-master-untracked-team adoption is introduced.

Update existing TeamManager tests that assert restored state immediately after construction to `await waitForRestore()`; do not add sleeps.

### Model completion coverage

Add `tests2/core/model-completion-command.test.ts` with a fake `CommandRunner` only:

- literal, whitespace, `none`, environment-name, and non-string paths do not invoke the runner and preserve current return values using the injected environment object rather than mutating `process.env`;
- exact platform-specific executable and args, command text without `!`, and exact options `{ encoding: 'utf-8', timeout: 15_000, windowsHide: true }`;
- cwd/env/stdio/shell/maxBuffer remain absent from options;
- successful stdout is trimmed; Buffer stdout decodes as UTF-8; empty or malformed stdout maps to `undefined`; successful stderr is ignored;
- non-zero-exit rejection, generic rejection/spawn failure, signal rejection, and timeout-shaped rejection all map to `undefined` with no log/new error message;
- a deferred runner proves an independent microtask progresses while resolution is pending;
- multiple AIGW headers resolve sequentially and preserve insertion order;
- `completeModelText()` waits for the command, passes the resolved header/API key unchanged to the fake completer, and preserves all completion options and response/error parsing.

### `tests2/tests-map.json` ownership

Register each new file in `v2Native` with:

```json
"execution": { "runner": "vitest", "tier": "unit", "project": "core" }
```

Suggested ownership entries:

- `tests2/core/team-store-consistency-async-io.test.ts` — bounded injectable asynchronous team recovery scans and deterministic parity;
- `tests2/core/team-manager-async-recovery.test.ts` — awaited boot lifecycle and exact recovered/sidecar-adopted set;
- `tests2/core/model-completion-command.test.ts` — injectable non-blocking 15-second shell-command contract;
- add a new cost file only if coverage cannot be kept coherently in the two existing registered cost-backfill files; otherwise retain their current migrated ownership and rewrite them in place.

Run the inventory guard after editing the map.

## E2E plan

No new browser journey is justified. The change has no new user action, UI state, route, payload, or visible loading transition; a browser journey would only restate internal boot I/O mechanics that are deterministic under injected unit seams.

No real-filesystem/process smoke test is planned. Node's `fs.promises` and `CommandRunner.execFile` adapters are existing platform primitives, while the risky behavior is scheduling, ordering, caps, and error mapping, all of which is more precisely covered with deferred fakes. If implementation reveals an adapter-specific issue that cannot be represented structurally, add one minimal deterministic `tests2/integration` or E2E smoke owned by the proper E2E command; do not duplicate unit scenarios and do not place real I/O in the unit tier.

## Focused verification commands

```bash
npx vitest run --config vitest.config.ts \
  tests2/core/cost-backfill.test.ts \
  tests2/core/cost-backfill-transcript-pass.test.ts \
  tests2/core/team-store-consistency-async-io.test.ts \
  tests2/core/team-manager-async-recovery.test.ts \
  tests2/core/model-completion-command.test.ts
npm run test:unit:inventory
npm run check
npm run test:unit
git diff --check
```

If an E2E smoke is added for an adapter-only issue, also run:

```bash
npm run test:e2e
```

Record focused per-file durations from Vitest output in the goal result; each new unit file must remain comfortably below the 15-second solo budget, targeted below two seconds.

## Acceptance criteria

- Production recovery/config command paths contain no synchronous directory discovery, stat, transcript-header read, or model `execSync` in the required scope.
- Both filesystem scans use injected async I/O and the shared positive cap of eight.
- No unbounded per-item `Promise.all`, wide-scan `shift()`, nested cap multiplication, whole-transcript header read, detached required work, or duplicate sync recovery scan remains.
- Cost candidate priority, confidence rules, thresholds, byte/line caps, strict deadline boundary, first-match/first-wins behavior, stamps, counts, generation behavior, logs, and returned data match fixed fixtures.
- Team candidate validation, canonical choice, trusted-root precedence, recovered/sidecar-adopted session set, store mutation order, diagnostics, and best-effort isolation match fixed fixtures.
- Team recovery completes before session restoration; event resubscription remains after session restoration.
- Model commands preserve platform shell, command/args/options, inherited cwd/environment, stream treatment, output trimming, 15-second timeout, and all error-to-`undefined` mappings without blocking the event loop.
- Unit tests use only deferred/mock/in-memory I/O, structurally prove scheduler progress and the concurrency ceiling, pass the inventory guard, and stay under budget.
- `npm run check`, focused tests, `npm run test:unit`, and `git diff --check` pass.
- No browser journey or E2E smoke is added unless an adapter-only gap is demonstrated and documented.

## Explicit exclusions

Do not modify preview artifacts or mounts, maintenance endpoints, TLS/OpenSSL helpers, shell utility probes, Pi-extension or PR Walkthrough hashing, background-process polling/watchers, timer scheduling, FlexSearch or persistence stores, session restoration policy, lazy revival, UI, REST/WS formats, or visible loading behavior.

Do not introduce retries, new configuration, auth precedence changes, untracked-team adoption, recovery-policy changes, unrelated reliability work, aggregate-patch persistence changes, or changes to model/provider completion semantics beyond replacing the blocking command execution seam.
