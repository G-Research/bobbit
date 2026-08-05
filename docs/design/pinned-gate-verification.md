# Pinned gate verification (D-3)

## Scope and invariant

D-1/D-2's content digest prevents unsafe cache reuse but does not prevent a
mutation between hashing and a command reading the live goal worktree. D-3
closes that TOCTOU window for the single-repository foundation:

> Every command, LLM-review, agent-QA, and human-signoff context belonging to
> an executing signal uses one detached, signal-owned source snapshot. A
> signal may become `passed` only after the snapshot's digest remains equal to
> the digest persisted for that signal.

The snapshot represents the complete non-ignored source inventory defined by
`computeVerificationContentDigest()`: tracked and untracked paths, including
raw file bytes, executable mode, symlink target, and tracked deletion state.
Ignored build/dependency output and `.git` metadata are deliberately outside
this source contract, as they already are for D-1/D-2. A source that cannot
be represented safely fails closed; it is never silently verified live.

This is D-3 only. It creates one detached checkout for the current
single-repository branch container. It does **not** resolve a command step's
component cwd in a copied multi-repo container; that mapping is D-4. Existing
`resolveStep()` behavior is retained for ordinary worktrees.

## Current boundary

The route currently computes a preliminary digest of `goalBranchContainer()`
for whole-gate cache reuse. A cache miss records a running signal, then
`VerificationHarness.verifyGateSignal()` synchronizes the live worktree,
recomputes its digest, builds the step cache, and invokes steps from that live
cwd. `goalBranchContainer()` correctly selects `goal.worktreePath` rather
than an offset `goal.cwd`, while `resolveStep()` applies a component path.

Consequently D-1/D-2 can decline a stale cache hit but cannot make the bytes
read by a fresh command stable. A mutating agent, watcher, origin sync race,
or command that edits its cwd can invalidate the witness after it was
recorded.

## Alternatives considered

This is not a quick fix: it introduces a new snapshot lifecycle API, durable
recovery state, persisted signal fields, and new cache decisions. Each option
below has the same D-3 acceptance criterion: every verification result must
attest to immutable bytes representing the signal's dirty, single-repository
source inventory.

### Option A — detached worktree with raw-byte overlay (chosen)

Create a detached `git worktree add --no-checkout`, then materialize the
existing inventory-defined source bytes into it. `VerificationPinnedCheckoutManager`
owns a durable lease record and restart recovery, so an interrupted command
can resume only after revalidating the same ready checkout. This is the design
specified below.

### Option B — temporary-index commit snapshot

Build a temporary `GIT_INDEX_FILE`, use `git add -A`, `write-tree`, and
`commit-tree` to commit the dirty source state without moving a source ref,
then check that commit out into a temporary worktree and digest it. This is a
materially different snapshot mechanism and avoids explicit source copying,
but it loses on the D-1 contract: `git add` and checkout apply attributes and
filters, so a `text` attribute can make checkout bytes differ from the
raw CRLF/LF bytes that `computeVerificationContentDigest()` witnesses. It also
creates loose Git objects and does not represent ignored/untracked edge cases
under exactly the existing inventory rules. A digest of that checkout would
therefore attest to a transformed source, not the exact source bytes D-3
requires.

### Option C — ephemeral in-harness copy (minimal composition)

Keep all lifecycle code inside
`src/server/agent/verification-harness.ts`; copy the strictly decoded Git
inventory into a per-run directory under the server state directory, re-digest
it with the existing `computeVerificationContentDigest()`, and delete it in a
`finally` block. The implementation would extract and reuse the inventory from
`src/server/agent/verification-content-digest.ts`, whose contract is protected
by `tests2/core/verification-content-digest.test.ts`; digest persistence stays
covered by `tests2/core/gate-store-content-digest.test.ts`. On restart,
`resumeInterruptedVerifications()` would classify the execution as a retryable
infrastructure interruption and rerun against a newly created snapshot.

This is the smallest code composition: it has no manager, no lease store, and
no state machine. It loses because it cannot resume an in-flight signal against
the **same** immutable copy, cannot reliably distinguish an orphaned copy from
an active resumed copy after restart, and supplies only a root sweep rather
than a persisted cleanup/retry diagnostic. Recreating the copy after a live
worktree mutation would change the source being attested; rerunning is safe
but fails the goal's explicit restart and persistence/diagnostics expectations.

### Comparison

| Option | Authoritative data/control flow | Expected files | Principal failure mode | Test seams |
|---|---|---|---|---|
| A: detached overlay | Inventory bytes → no-checkout detached worktree → target digest → durable lease → command/restart validation | New pinned manager; harness, digest, store, cache/route integration | Worktree lock or orphan lease; handled by recorded cleanup retry | Real temporary Git repos for materialization; fake runner/process seams for timing |
| B: temporary commit | Git-index tree/commit → normal checkout → checkout digest | Harness plus Git snapshot helper and cleanup integration | Filter/attribute transformation diverges from D-1 raw-byte digest | Real Git repos with `text`/CRLF attributes expose divergence |
| C: ephemeral copy | Inventory bytes → temporary directory → target digest → command → `finally` delete | Harness and digest extraction only | Restart loses identity; orphan sweep and re-created snapshot cannot resume the same bytes | Temporary filesystem/Git repos; existing harness restart coverage proves retry only |

### Defect-surface inventory

| Addition in Option A | Why it is necessary (or avoided by another option) |
|---|---|
| `verification-pinned-checkout.ts` manager | Single owner for path validation, Git lifecycle, materialization, recovery, and cleanup; C avoids it but cannot resume the same snapshot. |
| `verification-checkouts.json` durable store with atomic persistence | Records ownership and cleanup retry across restart; C has only an unsafe-to-classify root sweep. |
| `preparing`/`ready`/`releasing` lease state machine | Makes interruption and failed cleanup recoverable without deleting an active cwd. |
| `PinnedCheckout` / `PinnedCheckoutLease` API | Limits the harness to acquire/assert/release and prevents callers from selecting paths or refs. |
| `GateSignal.pinnedCheckout` | Durable evidence that a cache-eligible signal was materialized from pinned bytes. |
| `GateSignal.pinnedCheckoutError` | Sanitized, persisted operational diagnosis without exposing paths or Git output. |
| `pinned-checkout-unavailable` and `pinned-checkout-mismatch` cache misses | Keeps legacy or inconsistent signals out of whole-gate and step reuse. |
| Four pinned-checkout error codes | Separates acquisition, mutation, unreadable, and unsupported-layout outcomes for fixed operator reporting. |
| Read-only chmod pass | Defense-in-depth guard against accidental checkout writes; digest assertions remain authoritative. |
| Canonical containment checks | Keep state-owned checkout paths, source copies, Git calls, and deletions inside approved roots. |

### Selection

Option A is the smallest robust solution that meets the goal's explicit
requirement for “cleanup/recovery, cancellation, restart, cross-platform
safety, secure Git invocation, persistence/diagnostics.” Option B cannot
preserve the existing raw-byte digest contract. Option C is smaller but can
only retry after restart against a newly created copy; it cannot durably resume
or diagnose cleanup for the exact snapshot associated with the signal. The
lease store and manager are therefore justified defect surface rather than
incidental abstraction.

## Architecture

Add `src/server/agent/verification-pinned-checkout.ts`. It owns both a small
persistent lease store and the filesystem/Git lifecycle; `VerificationHarness`
only asks it to acquire, validate, and release a checkout.

```ts
export interface PinnedCheckout {
  id: string;                    // signal id; no caller-selected path
  sourceRoot: string;            // canonical branch container, internal only
  repoRoot: string;              // canonical Git root, internal only
  path: string;                  // stateDir/verification-checkouts/<signalId>
  commitSha: string;             // validated full commit SHA
  contentDigest: VerificationContentDigest;
}

type PinnedCheckoutState = "preparing" | "ready" | "releasing";

export interface PinnedCheckoutLease {
  signalId: string;
  goalId: string;
  gateId: string;
  state: PinnedCheckoutState;
  checkoutPath: string;
  sourceRoot: string;
  repoRoot: string;
  commitSha: string;
  createdAt: number;
  digest?: VerificationContentDigest;
  cleanupAttempts: number;
  lastCleanupErrorCode?: "GIT_REMOVE_FAILED" | "PATH_BUSY";
}

export class VerificationPinnedCheckoutManager {
  acquire(input: { signal: GateSignal; sourceRoot: string }): Promise<PinnedCheckout>;
  assertUnchanged(checkout: PinnedCheckout): Promise<void>;
  release(signalId: string): Promise<void>;
  recover(activeSignalIds: ReadonlySet<string>): Promise<void>;
}
```

The durable store is `<stateDir>/verification-checkouts.json`, published with
the same tmp-file, fsync, rename, and serialized-write discipline as other
recovery-critical stores. The matching lease reference is also included in
`ActiveVerification`, before verification can run, so restart recovery knows
which snapshot is authoritative. Lease records are operational data only;
paths and Git errors stay in server logs rather than gate API payloads.

### Acquiring the snapshot

The harness acquires a snapshot *after* its existing non-destructive origin
synchronization and *before* either step-cache construction or step launch:

1. Resolve `sourceRoot = goalBranchContainer(goal)` and canonicalize it with
   `realpath`. Require it to be a directory and a Git worktree root. Reject a
   source root outside the registered single-repo root, a missing
   `signal.commitSha`, or an `unknown` SHA.
2. Query Git with `CommandRunner.execFile()` only. Use `git -C <sourceRoot>
   rev-parse --show-toplevel` and `rev-parse --verify HEAD^{commit}`; require
   the full, validated commit SHA to equal `signal.commitSha`. No shell,
   interpolated command string, Git alias, or user-provided ref is used.
3. Allocate a deterministic, safe path beneath the server-owned state
   directory: `verification-checkouts/<signal UUID>`. The signal id must be a
   UUID and the resolved target must remain beneath that root. Reject a state
   directory nested inside the source root. Persist `preparing` before Git
   changes anything.
4. Create a detached metadata worktree without checkout:

   ```text
   git -c core.hooksPath= -C <repoRoot> worktree add --detach --no-checkout <target> <commitSha>
   ```

   Arguments are an array, `core.hooksPath=` prevents repository hook
   execution, and `<commitSha>` is a fixed full SHA. `--no-checkout` means Git
   does not populate a mutable/filter-transformed source tree.
5. Materialize the D-1 source inventory from `sourceRoot` into the new
   worktree. Reuse the digest module's strictly decoded `git ls-files --cached
   -z` and `--others --exclude-standard -z` inventory as a shared,
   test-injectable `readVerificationSourceInventory()` primitive. Copy a
   regular file through a freshly opened handle; preserve its executable bit;
   recreate symlinks from their verified target text; remove a target tracked
   path when the source has the durable `deleted` record. Missing untracked
   paths, special files, source/target symlink escapes, replacement races, or
   an unsupported submodule abort the acquisition. The implementation must
   not use `cp -R`, `tar`, `git clean`, a shell, or a filter-running Git
   command.
6. Compute the digest of the **pinned target** using the existing raw-byte
   digest contract. It becomes `signal.contentDigest` through
   `GateStore.updateSignalContentDigest()` and is the only witness used by the
   subsequent step cache. The preliminary route digest remains a fast
   whole-gate-cache check only. A changed source during copying produces the
   target's actual digest, not a claim about a guessed source instant.
7. Change the lease to `ready`, synchronously persist the active verification
   reference, then expose the checkout to execution.

This Git worktree plus explicit overlay matters for dirty source: a detached
checkout at `HEAD` alone loses unstaged, staged, and untracked bytes that
commands normally read. The overlay is inventory-defined and raw-byte based,
so it has the same CRLF/filter semantics as the D-1 witness. The pinned
checkout's `.git` file refers to the source repository only for read-only Git
queries; verification must never run Git commands that alter refs, index, or
worktree state there.

### Immutability during execution

Before launch, recursively make materialized source entries read-only and
make source directories non-writable where the platform permits. The manager
uses Node filesystem APIs for this best-effort guard; it never treats Windows
read-only attributes or POSIX modes as a security boundary against a command
running as the gateway user.

The correctness boundary is digest validation:

- `assertUnchanged()` runs immediately before every phase, immediately after
  every command/reviewer/QA result, and before the final signal transition.
- It recomputes the digest from the pinned root. Any mismatch or digest error
  produces an infrastructure failure (`PINNED_CHECKOUT_MUTATED` or
  `PINNED_CHECKOUT_UNREADABLE`), prevents cache materialization, and cannot
  record `passed`.
- A command that needs output must use the existing state diagnostics/artifact
  directory, not its cwd. Existing workflow commands that write build output
  are allowed only if that output is ignored; nevertheless any source
  inventory mutation fails the verification rather than making the attestation
  ambiguous.

The checkout path replaces the live `cwd` passed to command execution,
`buildReviewPrompt()`, reviewer agents, QA agents, artifact collection, and
all command-specific lifecycle metadata. `builtinVars.commit` comes from the
validated detached commit. Each spawned reviewer prompt explicitly says its
cwd is a frozen verification checkout and still forbids checkout/pull/fetch.

D-3 has one intentional single-repo constraint: verify `sourceRoot ===
repoRoot` after canonicalization. If a goal has a component layout or a
non-repository branch container, acquisition returns the durable
`PINNED_CHECKOUT_UNSUPPORTED_LAYOUT` failure instead of falling back to the
live cwd. D-4 will generalize materialization and then apply `resolveStep()`
inside the pinned branch container once.

## Integration flow

### Fresh execution and step cache

`verifyGateSignal()` becomes:

1. Retain existing signal validation and origin synchronization on the live
   branch worktree.
2. Acquire the pinned checkout; persist its digest and active lease reference.
   Failure finalizes the signal as failed infrastructure verification without
   launching any step.
3. Call `buildStepCache()` with that pinned digest. Existing SHA,
   invalidation-time, optional-step, human-signoff, and phase filters remain
   unchanged.
4. If all steps are cached, assert the just-created checkout is unchanged,
   update the gate, then release it. This ensures a newly recorded cache pass
   has a durable immutable-source witness even though no fresh command ran.
5. Otherwise execute all remaining phases exclusively in the pinned root,
   with before/after assertions described above. Cached individual steps are
   retained exactly as today, but any non-cached step has the same pinned cwd.
6. Verify the final digest one last time, update the signal/gate status, then
   release the lease in `finally`.

`GateStore` receives two append-only fields on `GateSignal` for diagnostics:

```ts
pinnedCheckout?: {
  version: 1;
  commitSha: string;
  contentDigest: VerificationContentDigest;
};
pinnedCheckoutError?: {
  code: "PINNED_CHECKOUT_ACQUIRE_FAILED" | "PINNED_CHECKOUT_MUTATED" |
        "PINNED_CHECKOUT_UNREADABLE" | "PINNED_CHECKOUT_UNSUPPORTED_LAYOUT";
  message: string; // fixed, sanitized operator text
};
```

The persisted content digest remains the existing field for compatibility and
cache eligibility. `pinnedCheckout` says that it was actually materialized
and protected; old signals lacking it are cache-ineligible for D-3 step or
whole-gate reuse. `reuseCachedGateSignal()` therefore requires equal valid
content digests **and** a valid `pinnedCheckout` whose commit and digest match
the signal. This intentionally reruns all pre-D-3 green gates once.

A whole-gate reuse does not execute a process. It is safe to materialize only
when the current live preliminary digest equals this durable pinned digest;
its new cached signal copies the prior `pinnedCheckout` attestation and the
matching current digest. Any mismatch/unavailable/legacy attestation creates
a fresh signal which takes the pinned execution path above.

`buildStepCache()` likewise requires the prior step's signal to have matching
valid content and pinned attestation. Its existing decision object gains
`pinned-checkout-unavailable` and `pinned-checkout-mismatch` miss reasons;
the latter is used when valid source digests match but an attestation is
missing or inconsistent. Neither rule relaxes D-1/D-2's digest guards.

### Cancellation, restart, and cleanup

The manager is owned by the harness and preserves existing cancellation
behavior:

- `cancelStaleVerifications`, normal cancellation, timeout, and `shutdown()`
  do not release a checkout until command process-tree cleanup has reached its
  existing durable terminal barrier. This avoids deleting a cwd under a live
  process.
- An active lease is not deleted just because gateway shutdown begins. On
  restart, `resumeInterruptedVerifications()` restores the active record and
  resumes against the persisted `ready` checkout, never the mutable live
  goal worktree. It asserts the pinned digest before reattaching/rerunning a
  step. A missing or altered ready checkout is a retryable infrastructure
  interruption, never an invented command verdict.
- At startup, before new work is accepted, `recover(activeSignalIds)` removes
  `preparing` or `releasing` leases and `ready` leases with no active signal,
  using a targeted `git worktree remove --force <path>` from the recorded
  canonical repo root. It does not run a global `git worktree prune` and never
  recursively deletes a path outside the server-owned checkout root.
- If removal fails due to locks, retain a `releasing` lease with bounded
  retry/backoff. It is excluded from all signal reuse and surfaced through
  aggregate maintenance diagnostics as a sanitized `cleanup-pending` count.
  A later boot/maintenance pass retries only that recorded path.
- The finalizer always attempts release in `finally`; cleanup failure cannot
  turn a correctly observed command result into a pass if the final digest
  assertion did not complete.

The manager uses canonical path containment checks before every copy, chmod,
Git call, and deletion. Lease IDs, paths, source roots, and refs are never
accepted from route bodies. Git is invoked only through `CommandRunner` with
argument vectors and bounded timeouts. No environment inherited from the
agent is allowed to redirect `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_INDEX_FILE`.

### Planned file changes

- Add `src/server/agent/verification-pinned-checkout.ts`; extract the shared
  inventory reader in `src/server/agent/verification-content-digest.ts`.
- Integrate acquisition, assertions, cancellation, and restart recovery in
  `src/server/agent/verification-harness.ts`; add persisted fields and update
  APIs in `src/server/agent/gate-store.ts`.
- Require the new attestation in `src/server/agent/verification-logic.ts` and
  `src/server/gate-signal-response.ts`; retain the preliminary route digest in
  `src/server/server.ts` (currently near line 12502).
- Add focused core coverage and register it in `tests2/tests-map.json`; extend
  existing harness, digest, logic, and store coverage named below.

## Test plan

Register all new tests in `tests2/tests-map.json`; use temporary real Git
repositories for filesystem/Git behavior and fake command/process seams only
where lifecycle timing requires them.

1. `tests2/core/verification-pinned-checkout.test.ts`: acquire copies dirty
   tracked/staged/untracked bytes, executable mode, symlink target, and
   tracked deletion; raw CRLF/LF differs under a `text` attribute; ignores are
   excluded; escaped paths, submodules, races, special files, wrong SHA, and
   unsupported source layout fail closed. Assert every Git call is `execFile`
   with fixed argument vectors.
2. `tests2/core/verification-pinned-checkout-lifecycle.test.ts`: atomic lease
   persistence/reload; interrupted `preparing` recovery; orphan `ready`
   cleanup; lock retry; containment refusal; active ready lease survives
   restart; and no global prune/unrelated worktree removal.
3. Extend `tests2/core/verification-logic.test.ts` and
   `tests2/core/gate-store-content-digest.test.ts`: legacy/non-attested
   signals cannot populate whole-gate or step caches; equal digest plus equal
   pinned attestation can; incompatible attestation is a structured miss;
   fields survive reload.
4. Extend verification-harness coverage: mutate the live goal worktree after
   acquire but before command launch and prove the command sees the original
   pinned bytes; mutate the pinned source during a command and prove no pass
   is recorded; assert every command/reviewer/QA cwd is the pinned root;
   optional, human-signoff, phase skip, cancellation, and existing command
   recovery semantics remain unchanged.
5. E2E-tier integration: signal a dirty single-repo gate, pause a command,
   mutate its live worktree, and prove output/cached digest remain tied to the
   pinned source. Restart while the command is live and prove recovery uses
   the same lease path. Re-signal after cleanup and prove no stale checkout
   remains.
6. Run the existing D-1/D-2 nested-worktree integration test unchanged to
   pin the D-4 boundary, then add an explicit single-repo rejection assertion
   for a component/non-repository branch container.

Required validation after implementation: focused core/integration tests,
`npm run check`, `npm run test:unit`, and `npm run test:e2e`. Run the inherited
browser tier when diagnostics gain a renderer; browser coverage is otherwise
not applicable because D-3 adds no user-facing flow.

## Non-goals

- Multi-repo or component-root execution and relative-cwd mapping (D-4).
- Making arbitrary hostile verification commands sandbox-secure; digest
  assertions provide correctness, while filesystem permissions are only a
  guardrail.
- Changing cache invalidation, optional-step, human-signoff, phase, sandbox,
  command timeout, cancellation, or restart-verdict policy.
- Retaining pinned checkout contents after finalization; the durable signal
  stores an attestation, never a long-lived copy of user source.
