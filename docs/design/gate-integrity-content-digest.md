# Gate integrity: content-digest cache guard

## Scope

D-1/D-2 make a cached green gate attest to the current *source worktree bytes*, not merely `HEAD`. Every non-bypass gate signal records either a digest of the source worktree used for its cache decision/run or a durable, sanitized digest failure. Both cache layers require an exact digest match in addition to existing commit-SHA and invalidation-timestamp checks:

1. the route's whole-gate passed-result reuse; and
2. `VerificationHarness`'s individual verification-step reuse.

This document records the D-1/D-2 cache guard only; it deliberately did not pin execution. D-3 now supplies immutable execution, D-4 (`FIX-PINNED-NESTED-STEP-CWD`) extends it to nested component and multi-repository paths, and D-5 verifies the composed lifecycle. Current cache eligibility also requires coherent pinned-checkout evidence; the digest rule here remains an additional, independent guard. See [Pinned gate verification (D-3)](pinned-gate-verification.md), [Pinned multi-repo verification (D-4)](pinned-multi-repo-verification.md), and the [D-5 end-to-end plan](pinned-gate-verification-e2e.md).

## Existing flow and defect

`src/server/server.ts` obtains `git rev-parse HEAD` from `goal.cwd`, then calls `reuseCachedGateSignal()` before creating a new signal. That helper accepts a prior passed signal with the same SHA. On a miss, the route persists a running `GateSignal` and starts `VerificationHarness.verifyGateSignal()`. The harness separately calls `buildStepCache()` using the same SHA before it executes remaining steps. `GateState.verificationCacheInvalidatedAt` already prevents pre-reset cache reuse.

The SHA is not a witness of the live worktree. A dirty change retains the same SHA. More importantly, the current harness performs its optional origin synchronization *after* building/consuming the step cache, so either cache can reuse output created from different source bytes.

## D-1/D-2 acceptance criteria

1. **Content witness:** a signal persists a versioned fingerprint of the complete child goal branch container's non-ignored source inventory after origin synchronization and before any cache decision or verification command. A computation failure persists a safe diagnostic instead.
2. **Fail-closed reuse:** whole-gate and step cache reuse require equal commit SHA **and** equal valid digest. A missing legacy digest, current/prior digest error, or unequal digest runs fresh and states `content-digest-unavailable` or `content-digest-mismatch` to the operator.
3. **Nested-goal safety:** equal SHAs in parent, child, or sibling worktrees do not authorize reuse across differing child `worktreePath` content. Component `repo`/`relativePath` remains applied once only by `resolveStep()`.
4. **No D-3 claim:** a mutation after digesting and before command spawn remains a TOCTOU window. This guard detects unsafe reuse; it does not create an immutable checkout.

## Alternatives considered

Both candidates preserve the D-1/D-2 acceptance criteria, existing invalidation/human-signoff rules, durable schema, route and harness injection points, and test coverage below. They differ only in how a worktree digest is produced.

| Concern | A — file-byte digest (selected) | B — throwaway-index tree OID (rejected) |
|---|---|---|
| Inventory | `git ls-files --cached --others --exclude-standard -z`; Git supplies tracked/untracked/ignore membership. | `GIT_INDEX_FILE=<temp> git add -A`, then `git write-tree`; Git supplies membership and tree shape. |
| Byte semantics | Hashes bytes commands can read, plus file kind, executable mode, and symlink target. | Hashes Git's *clean-filtered* blob contents and index modes, not necessarily worktree bytes. |
| Git filters | Never invokes a clean filter. | Runs configured clean filters and normalization; a CRLF→LF byte change under `text` can retain the same tree OID. Filter programs also add side effects/failure modes to a signal request. |
| Deletes and special entries | Explicit deletion record for a tracked file absent from disk; a race/missing untracked file, special entry, or submodule fails closed. | Tracked deletes, modes, symlinks, and renames are represented by Git. A submodule is represented by its recorded child commit, not dirty child source bytes. |
| Object database | Read-only Git inventory plus file reads; no repository objects created. | `git add -A` writes loose blob/tree objects to the source repository ODB. Removing the temporary index cannot remove these objects. |
| New code/dependency | Small digest module, `hasha` for file streams, and a short versioned aggregate record format. | Small process wrapper and no npm dependency, but temp-index lifecycle, environment isolation, ODB pollution, filter behavior, and object-format metadata. |
| Cross-platform process control | Existing `CommandRunner.execFile()` for two read-only Git inventory calls; `hasha`/Node streams are portable. | Must use `execFile("git", args, { env: { ...process.env, GIT_INDEX_FILE } })`, never shell `GIT_INDEX_FILE=…`; create an index path outside the worktree, remove index and lock in `finally`, and tolerate crash residue. |
| Test seam | Fake `CommandRunner` for inventory errors plus temporary real-repo fixtures for byte, mode, symlink, deletion, ignore, and nested-root cases. | Fake runner must assert both process calls and env; real fixtures must also assert temp cleanup, ODB writes, filters, and object-format behavior. |

### Validation of the Git-native candidate

The throwaway-index approach was tested in a disposable repository, with the index directory outside the worktree so it could not be staged. It correctly excluded ignored files and represented regular files, symlinks, executable mode, deletion, and rename in its tree. It also left newly created objects in the source repository's object database after index cleanup.

A decisive counterexample is a tracked `a.txt` marked `text` in `.gitattributes`: writing `line\r\n` and then `line\n` yielded the same `git write-tree` OID after separate `git add -A` calls, while SHA-256 of the two worktree byte streams differed. Verification commands read those worktree bytes, so reusing a pass in that case violates D-1 rather than merely producing a conservative miss. The same concern applies to custom clean filters. A dirty submodule has the analogous problem: its superproject tree records only the nested repository's `HEAD`, not the nested worktree's dirty bytes.

Option B is superficially the smaller diff, and Git is the best-maintained tree implementation. It loses because it fingerprints Git's normalized staging representation and mutates the source ODB, whereas D-1 requires a fingerprint of files the check actually runs against. Adapting it to raw bytes and recursive submodule state would reintroduce the bespoke machinery it was meant to remove. Option A is therefore the smallest **robust** solution for the stated contract.

### Defect-surface inventory

| Surface | A — disposition | B — disposition |
|---|---|---|
| `verification-content-digest.ts` | Required: narrow inventory/hash wrapper and versioned aggregate. | Required: narrower wrapper, but gains temp-index and environment cleanup. |
| `hasha` dependency | Required: maintained ESM package (`^7.0.0`, Node >=20; project is Node >=22) owns streamed file hashing. | Eliminated. |
| Aggregate canonicalization | Required but minimal: kind, mode, POSIX relative path, and SHA-256 in an unambiguous NUL record stream. | Eliminated only by accepting filtered Git-tree semantics. |
| Two `GateSignal` fields | Required and append-only. | Required and append-only. |
| `updateSignalContentDigest()` | Required; follows `updateSignalVerification()` coalesced-write pattern. | Required. |
| Cache miss reasons | Required: unavailable/mismatch. | Required. |
| API projections | Required: digest/error summary in gate detail/history and `src/app/api.ts`. | Required. |

The maintained-library instruction is met by using `hasha` for content streams rather than hand-writing streaming, buffering, and read-error behavior. Node `crypto` performs only the bounded aggregate SHA-256; a directory-digest package would duplicate Git's ignore/inventory role or be stale, and was not selected.

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

The root is always the **un-offset branch container** from `goalBranchContainer(goal)` (`goal.worktreePath ?? goal.cwd`), never a component cwd and never a parent goal's cwd. A command step may later descend into a component, but the cache decision covers the complete source worktree it can read. This keeps single-repo relative paths from being applied twice and makes a nested child goal digest its own worktree.

Run these Git inventory queries through the existing injected `CommandRunner` as argument vectors, with bounded timeouts:

```sh
git -C <worktreeRoot> ls-files --cached -z
git -C <worktreeRoot> ls-files --others --exclude-standard -z
```

Keeping tracked and untracked output separate lets the digest represent a tracked file deleted from disk as `deleted`, while a vanished untracked path is a race and fails closed. Git remains authoritative for tracked/untracked/ignore membership. Decode only NUL-delimited paths, reject absolute/escaping paths, and sort POSIX-normalized relative paths bytewise. Hash regular-file **bytes** with `hasha`; hash symlink target text with `readlink`; include the executable-bit mode for regular files. Reject a symlink whose resolved target escapes the branch container, so the fingerprint never silently omits external content a command could follow. Feed Node `crypto` a versioned NUL-delimited aggregate stream:

```
bobbit/gate-content-digest/v1\0
<kind>\0<mode>\0<relative-path>\0<file-sha256>\0
...
```

The aggregate includes its version and exact inventory, so byte, add, remove, rename, kind, symlink-target, and executable-mode changes differ. For a tracked index path absent from disk, emit a `deleted` record rather than treating the index entry as a readable file. A missing untracked path (race), unreadable entry, escaping path, special file, or tracked submodule is `VERIFICATION_CONTENT_DIGEST_FAILED`; cache reuse is disabled rather than guessing. Submodule recursion is intentionally deferred: neither candidate safely proves dirty child worktree content without an explicit policy.

Ignored dependencies/install output and `.git` metadata are absent by Git inventory definition. Untracked `.gitignore` and `.gitattributes` remain included because they can change which source files Git reports or how commands interpret source. The implementation must not use unrelated truncated SHA-1 identifiers.

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

It must find the signal exactly as `updateSignalVerification()` does, replace digest/error atomically in the coalesced gate-store write, and never alter final verification output/status. Gate detail and signal-history responses already expose stored signals; project `contentDigest` and a sanitized error code/message there and mirror optional fields in `src/app/api.ts`. This gives operators a durable cache-bypass explanation without paths or stacks.

## Exact composition and control flow

### Route cache (whole gate)

In the gate-signal route in `src/server/server.ts`:

1. Resolve `branchContainer = goalBranchContainer(goal)` after the SHA lookup and before `reuseCachedGateSignal()`.
2. Compute the digest from that container and pass either its value or unavailable state to the helper.
3. Extend `src/server/gate-signal-response.ts::reuseCachedGateSignal()` so eligibility requires commit, invalidation boundary, no human sign-off, and equal valid digest. A materialized cached signal persists the matching digest.
4. Return a structured decision, not bare `undefined`, so the route logs an operator-readable integrity miss and creates a fresh running signal with a pending/failed digest result.

```ts
type GateCacheMissReason =
  | "no-prior-passed-signal"
  | "unknown-commit"
  | "content-digest-unavailable"
  | "content-digest-mismatch"
  | "pinned-checkout-unavailable"
  | "pinned-checkout-mismatch"
  | "invalidated"
  | "human-signoff";
```

### Step cache (harness)

In `VerificationHarness.verifyGateSignal()`:

1. Move the existing origin synchronization ahead of `buildStepCache()` and its all-steps shortcut; leave command cwd resolution and phase behavior unchanged.
2. Immediately after synchronization, compute the digest for the supplied branch-container `cwd`, then call `updateSignalContentDigest()`.
3. Pass the result to `buildStepCache()`. A value computed by the route is only a preliminary cache decision; this post-sync value is the durable witness for bytes the step cache and commands see.
4. Both the all-steps shortcut and partial-cache path consume the decision and log `[verification] cache bypassed: content digest <unavailable|mismatch>; running fresh` when appropriate.

Change `buildStepCache()` in `src/server/agent/verification-logic.ts` to return a decision rather than only a map:

```ts
export interface StepCacheDecision {
  steps: Map<string, GateSignalStep>;
  missReason?:
    | "content-digest-unavailable"
    | "content-digest-mismatch"
    | "pinned-checkout-unavailable"
    | "pinned-checkout-mismatch";
  priorSignalIds: string[];
}
```

It keeps its existing timestamp, current-signal, completed-result, phase, optional-step, and human-signoff filters. Equal digest is an additional eligibility criterion; missing/error current or prior digest yields no steps and `content-digest-unavailable`, while a differing valid digest yields no steps and `content-digest-mismatch`. D-3/D-4 subsequently add `pinned-checkout-unavailable` and `pinned-checkout-mismatch` when otherwise matching signals lack coherent immutable-execution evidence.

`_gatherRerunContext()` already derives `cwd` as `goal.worktreePath || goal.cwd`; make that use `goalBranchContainer(goal)` so normal, resumed, and rerun flows share one explicit root rule. Actual command cwd resolution remains `resolveStep()`'s responsibility.

### Protecting tests at each seam

| Seam | Existing protection | Required extension |
|---|---|---|
| Whole-gate reuse — `gate-signal-response.ts::reuseCachedGateSignal()` | Route-level response semantics and invalidation behavior. | Equal digest materializes; legacy/error/mismatch returns the explicit miss decision and cannot materialize. |
| Step reuse — `verification-logic.ts::buildStepCache()` | `tests2/core/verification-logic.test.ts` `describe("buildStepCache")`: same-SHA reuse, differing-SHA refusal, terminal-status, reset, and human-signoff behavior. | Equal digest reuse; mismatch/unavailable empty cache with reason; existing filters remain true. |
| Durable signal — `GateStore` | `tests2/core/gate-store-logic.test.ts` covers persistence/invalidation behavior. | Append-only reload plus digest/error mutation survives persistence and legacy signals remain readable. |
| Route/harness root — `goalBranchContainer()` / `resolveStep()` | Existing structural resolution and verification lifecycle coverage. | Root/child same SHA, distinct worktrees, component-relative cwd not doubled, and cache decision occurs after sync. |

## Targeted tests and operator surface

1. `tests2/core/verification-content-digest.test.ts`: stable inventory; byte/add/remove/rename/kind/symlink-target/executable-mode changes; ignored exclusion; tracked deletion record; unreadable, race-missing, escaping, special, and submodule failure code. Fixtures must prove raw CRLF/LF byte changes differ even under a Git `text` attribute.
2. `tests2/core/verification-logic.test.ts`: same SHA plus equal digest reuses; differing digest refuses with mismatch; missing legacy/error digest refuses unavailable; retain reset and human-signoff behavior.
3. A route integration test: equal digest materializes cache; changed digest creates a fresh running signal and durable legible mismatch; digest failure runs fresh with unavailable reason.
4. `tests2/integration/gate-content-digest.test.ts`: root and nested child have equal SHAs but distinct worktree roots. Pass a child gate, change child content, re-signal, and prove whole-gate and step caches rerun. Assert digest root and command cwd are child `worktreePath`, including a component `relativePath` case.
5. Persistence compatibility: old `gates.json` signals reload/inspect but cannot satisfy either cache; digest/error fields survive reload.

Register new test files in `tests2/tests-map.json`. Run focused tests while iterating, then `npm run check` and `npm run test:unit`.

The reason is returned through the existing gate-history/detail API and `src/app/api.ts`, but no current browser gate-history renderer is identified as a stable assertion target. The route integration test is the accepted end-to-end seam for this operator diagnostic; add a browser journey only if implementation exposes a new rendered field or changes an existing renderer.

## Delivery and non-goals

The candidate-document §2 split is delivered as the already separate documentation commit that introduced this focused design document; the source candidate document must retain a pointer to this document when it is next maintained in its source repository. Keep that documentation delivery separate from the D-1/D-2 code commit.

- This D-1/D-2 design did not add a pinned checkout, detached worktree, or immutable-execution claim; D-3 later delivered that boundary.
- No change to D-1/D-2 digest semantics; D-4 consumes their existing raw-byte inventory contract for multi-repository pinned layouts.
- No cache policy change beyond digest eligibility: invalidation timestamps, human-signoff exclusion, optional steps, phase ordering, and status broadcasts retain their contracts.
