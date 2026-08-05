# Gate integrity: content-digest cache guard

## Scope

D-1/D-2 make a cached green gate attest to the current *source worktree inventory*, not only `HEAD`. Every non-bypass gate signal records a digest of the source worktree used for its cache decision/run. Both cache layers require an exact digest match in addition to the existing commit-SHA and invalidation-timestamp checks:

1. the route's whole-gate passed-result reuse; and
2. `VerificationHarness`'s individual verification-step reuse.

This deliberately does **not** pin execution to a checkout. D-3 must supply the immutable checkout before a pass can be claimed to prove a particular commit. D-4 (`FIX-PINNED-NESTED-STEP-CWD`) remains mis-scoped as a small follow-up until D-3 exists; there is no `pinned-checkout.ts` on `main`.

## Existing flow and defect

`src/server/server.ts` obtains `git rev-parse HEAD` from `goal.cwd`, then calls `reuseCachedGateSignal()` before creating a new signal. That helper accepts any prior passed signal with the same SHA. On a miss, the route persists a running `GateSignal`, starts `VerificationHarness.verifyGateSignal()`, and returns. The harness separately calls `buildStepCache()` using the same SHA before it executes remaining steps. `GateState.verificationCacheInvalidatedAt` already prevents pre-reset cache reuse.

The SHA is not a witness of the live worktree. A dirty change can retain the same SHA, and the harness can synchronize the goal worktree after the cache decision. Therefore either cache can reuse output created from different source bytes.

## Digest contract

Add `src/server/agent/verification-content-digest.ts`:

```ts
export interface VerificationContentDigest {
  algorithm: "sha256";
  version: 1;
  digest: string;
  fileCount: number;
}

export class VerificationContentDigestError extends Error {
  readonly code = "VERIFICATION_CONTENT_DIGEST_FAILED";
}

export async function computeVerificationContentDigest(
  worktreeRoot: string,
): Promise<VerificationContentDigest>;
```

The root is always the **un-offset branch container** from `goalBranchContainer(goal)` (`goal.worktreePath ?? goal.cwd`), never a component cwd and never a parent goal's cwd. A command step may later descend into a component, but the verification decision covers the complete source worktree it can read. This keeps single-repo relative paths from being applied twice and makes a nested child goal digest its own worktree.

The source inventory is the deterministic union of tracked and untracked, non-ignored files from:

```sh
git -C <worktreeRoot> ls-files --cached --others --exclude-standard -z
```

For each NUL-delimited relative path, resolve it under the root and reject any path escaping the root. Sort bytewise by POSIX-normalized relative path. Hash regular-file contents with SHA-256; hash a symlink's link text, tagged as a symlink. Reject unreadable, missing, special, or escaping entries. Feed an aggregate SHA-256 a versioned, NUL-delimited record stream:

```
bobbit/gate-content-digest/v1\0
<kind>\0<relative-path>\0<file-sha256>\0
...
```

The aggregate includes the algorithm/version and exact file list, so adds, removes, renames, type changes, and byte changes differ. `git ls-files` intentionally defines the inventory as source-controlled plus non-ignored worktree input; `.git` metadata, ignored dependency/install output, and arbitrary parent directories are not verification source. This is cheap enough for every signal, avoids digesting `node_modules`, and is consistent across worktrees.

Use the maintained `hasha` package (current `^7.0.0`) for file-content hashing rather than implementing stream/error handling. Node's built-in `node:crypto` SHA-256 is used only for the small canonical aggregate. Git is already the authoritative worktree dependency and its `ls-files` command supplies correct index/ignore semantics; this is not a hand-rolled directory walker. The PR must state this choice and why unmaintained directory-hash packages were rejected. Do not use the existing truncated SHA-1 identifiers in unrelated inventory code.

## Durable schema and compatibility

Extend `GateSignal` in `src/server/agent/gate-store.ts`:

```ts
contentDigest?: VerificationContentDigest;
contentDigestError?: { code: "VERIFICATION_CONTENT_DIGEST_FAILED"; message: string };
```

These optional fields are append-only. `GateStore.load()` preserves old JSON unchanged. A legacy signal lacking `contentDigest`, a bypass signal, an `unknown` SHA, or either digest-computation failure is cache-ineligible, not migrated or guessed. This is fail closed.

Add a durable mutation method:

```ts
updateSignalContentDigest(
  signalId: string,
  result: VerificationContentDigest | VerificationContentDigestError,
): void;
```

It must find the signal exactly as `updateSignalVerification()` does, replace digest/error atomically in the coalesced gate-store write, and never alter final verification output/status. The public gate-detail and signal-history payloads already project stored signals; add `contentDigest` and a sanitized error code/message to their summary projections in `src/server/server.ts`, and mirror the optional fields in `src/app/api.ts`. This gives operators a durable answer to why a cache was not trusted without exposing paths or stack traces.

## Signal creation and run ordering

### Route cache (whole gate)

In the signal route in `src/server/server.ts`:

1. Resolve `branchContainer = goalBranchContainer(goal)` immediately after the SHA lookup.
2. Compute the digest from that container before `reuseCachedGateSignal()`.
3. Pass the result to `reuseCachedGateSignal()` in `src/server/gate-signal-response.ts` and persist it in a materialized cached signal. If it cannot be computed, persist no success digest; normal verification continues and the eventual signal records `contentDigestError`.
4. On a cache miss due to missing/different digest, log a structured, operator-readable event with goal, gate, current signal id when available, prior signal id, and reason. Do not return a cached `201` response.

Change the helper options and return contract so the route can distinguish a normal miss from an integrity miss:

```ts
type GateCacheMissReason =
  | "no-prior-passed-signal"
  | "unknown-commit"
  | "content-digest-unavailable"
  | "content-digest-mismatch"
  | "invalidated"
  | "human-signoff";

reuseCachedGateSignal(options: ReuseCachedGateSignalOptions): {
  response?: GateSignalPostResponse;
  missReason?: GateCacheMissReason;
  priorSignalId?: string;
};
```

The prior passed signal is eligible only when SHA, timestamp boundary, no-human-signoff rule, and `contentDigest.digest` all match. A signal with no digest must never be upgraded into a cache hit.

### Step cache (harness)

In `VerificationHarness.verifyGateSignal()`:

1. Keep the existing non-destructive origin synchronization first.
2. Immediately after synchronization and before `buildStepCache()` or any cache-only completion, compute the digest from the supplied `cwd` (which is the route's `goalBranchContainer`).
3. Call `updateSignalContentDigest()` with that result. This replaces the route's pre-sync snapshot when synchronization changed the worktree, so the durable signal describes the bytes the steps actually saw.
4. Only then build the step cache and execute/cache-complete phases.

Change `buildStepCache()` in `src/server/agent/verification-logic.ts` to take the current digest and return both reusable steps and an integrity diagnostic:

```ts
export interface StepCacheDecision {
  steps: Map<string, GateSignalStep>;
  missReason?: "content-digest-unavailable" | "content-digest-mismatch";
  priorSignalIds: string[];
}

buildStepCache(
  signals: GateSignal[],
  currentSignalId: string,
  commitSha: string | undefined,
  contentDigest: VerificationContentDigest | undefined,
  verificationCacheInvalidatedAt?: number,
): StepCacheDecision;
```

It keeps the current timestamp, current-signal, completed-result, and human-signoff filters. It may reuse only a passed step from a signal with an equal digest. On digest error/missing input it returns an empty map. The all-steps shortcut and per-phase cached branch consume `decision.steps`; both emit a concise `[verification] cache bypassed: content digest ...; running fresh` diagnostic when applicable.

The cache decision must happen *after* sync. Move the existing cache block currently before the sync block accordingly; do not move actual command execution or change phase behavior. D-1 detects the race but cannot prevent a later live-worktree mutation between digest and process spawn. That residual TOCTOU is explicitly D-3, not a reason to claim pinning here.

## Nested goals and cwd safety

All three digest callers use the child signal's own `goalBranchContainer(goal)`: the initial signal route, normal harness run, and `_gatherRerunContext()`/resume path. Do not derive the root from `signal.goalId`'s parent, `goal.cwd` when `worktreePath` is present, or a component's resolved cwd. The existing `resolveStep()` contract applies `repo` and `relativePath` exactly once under the un-offset root and remains unchanged.

A nested child can share a commit SHA with its parent or sibling while its worktree differs; the digest distinguishes it. The digest guard is orthogonal to `runSubgoalStep()` scheduling and does not introduce a pinned child checkout.

## Targeted tests

Extend existing deterministic tests and add a focused integration fixture; register new tests in `tests2/tests-map.json` if a new file is created.

1. `tests2/core/verification-content-digest.test.ts`: same source inventory is stable despite discovery order; changing bytes, adding/removing an untracked non-ignored file, rename/type changes alter digest; unreadable/missing/escaping entry rejects with `VERIFICATION_CONTENT_DIGEST_FAILED`; ignored files do not enter the declared source inventory.
2. `tests2/core/verification-logic.test.ts`: same SHA plus equal digest reuses a passed command; same SHA plus different digest returns no steps and `content-digest-mismatch`; missing current/prior legacy digest returns no steps and `content-digest-unavailable`; retain reset and human-signoff behavior.
3. `tests2/integration/gate-signal-reminder.test.ts` (or a dedicated `gate-content-digest-cache.test.ts`): a whole-gate prior pass is materialized only for an equal digest. With a changed digest, response is not cached, a fresh running signal is recorded, and the persisted diagnostic names the mismatch. A digest failure likewise runs fresh.
4. `tests2/integration/gate-content-digest.test.ts`: create a root goal and nested child goal with distinct worktree roots but the same SHA. Pass the child's gate, alter its source without committing, re-signal, and assert both whole-gate and step cache rerun rather than reuse. Assert the executed command cwd/digest root is the child `worktreePath`, including a component `relativePath` case, not the parent's or doubled child cwd.
5. Persistence/backward compatibility: seed `gates.json` with a pre-D-1 signal and reload; verify it remains inspectable but cannot satisfy either cache. Reload a new digest/error signal and assert its diagnostic survives.

Run `npm run check` and `npm run test:unit`. The focused test command should include the new digest/cache test file(s) while iterating.

## Non-goals

- No `pinned-checkout.ts`, detached worktree, ref checkout, or attempt to make a process observe immutable bytes (D-3).
- No nested pinned-checkout cwd repair (D-4).
- No cache policy change beyond digest eligibility: existing invalidation timestamps, human-signoff exclusion, optional steps, phase ordering, and status broadcasts retain their contracts.
