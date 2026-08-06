# Pinned gate verification (D-3)

## Scope and invariant

D-1/D-2's content digest prevents unsafe cache reuse but does not prevent a
mutation between hashing and a command reading the live goal worktree. D-3
closes that TOCTOU window for the single-repository foundation:

> Every command, LLM-review, agent-QA, and human-signoff context belonging to
> an executing signal uses one signal-owned source snapshot. A signal may
> become `passed` only after the snapshot's digest remains equal to the digest
> persisted for that signal.

> The delivered snapshot has two server-owned trees: a private detached Git
> worktree for trusted Git context, and a source-only public execution tree.
> Only the public tree is exposed to commands, reviewers, or a sandbox; it has
> an empty root `.git` discovery barrier and no Git metadata.

The snapshot represents the complete non-ignored source inventory defined by
`computeVerificationContentDigest()`: tracked and untracked paths, including
raw file bytes, executable mode, symlink target, and tracked deletion state.
Ignored build/dependency output and `.git` metadata are deliberately outside
this source contract, as they already are for D-1/D-2. A source that cannot
be represented safely fails closed; it is never silently verified live.

D-3 established the single-repository foundation. D-4 now extends the same
signal-owned boundary to nested component cwd mapping and multi-repository
branch containers. The D-3 v1 layout remains supported unchanged; see
[Pinned multi-repo verification (D-4)](pinned-multi-repo-verification.md) for
the v2 layout and exact-once mapping contract.

## Delivered boundary

The route still computes a preliminary digest of `goalBranchContainer()` for
whole-gate cache reuse. On a cache miss, `VerificationHarness.verifyGateSignal()`
performs its non-destructive origin synchronization, then creates the
signal-owned snapshot before it builds a step cache or launches a step.
`goalBranchContainer()` selects `goal.worktreePath` rather than an offset
`goal.cwd`.

The mutable goal worktree is therefore only the source for the initial
inventory and synchronization. Commands and reviewer/QA execution receive the
public source-only tree; trusted baseline/diff Git operations use the separate
private worktree. This makes a mutating agent, watcher, origin race, or command
unable to turn a changed source into an attested pass.

## Alternatives considered

This is not a quick fix: it introduces a new snapshot lifecycle API, durable
recovery state, persisted signal fields, and new cache decisions. Each option
below has the same D-3 acceptance criterion: every verification result must
attest to immutable bytes representing the signal's dirty, single-repository
source inventory.

### Option A — detached worktree with raw-byte overlay (chosen)

Create a project-scoped private `git worktree add --no-checkout`, materialize
the inventory-defined source bytes there, then copy that exact inventory to a
private candidate. The manager adds an empty `.git` discovery barrier, makes
that candidate a source-only public execution tree, and atomically publishes
it under the project-scoped public checkout root. The durable lease records
both trees and restart recovery, so interrupted work resumes only after
revalidating the same ready snapshot.

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
| A: detached overlay | Inventory bytes → private no-checkout worktree → private candidate → atomically published source-only public tree → digest/lease → command or restart validation | Pinned manager; harness, digest, store, cache/route integration | Private-worktree lock, public-root replacement, or orphan lease; handled by identity checks and recorded cleanup retry | Real temporary Git repos plus sandbox/publication and fake lifecycle seams |
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

## Delivered architecture

`src/server/agent/verification-pinned-checkout.ts` owns the persistent lease
store and the filesystem/Git lifecycle. `VerificationHarness` only asks it to
acquire, validate, resume, and release a checkout.

```ts
export interface PinnedCheckout {
  id: string;
  projectId: string;
  sourceRoot: string;
  repoRoot: string;
  path: string;                  // public source-only execution tree
  trustedGitCwd?: string;        // private detached Git worktree
  commitSha: string;
  contentDigest: VerificationContentDigest;
  writableIgnoredDirectories: readonly string[];
}

export interface PinnedCheckoutLease {
  signalId: string;
  projectId: string;
  state: "preparing" | "ready" | "releasing";
  checkoutPath: string;          // project-scoped public execution tree
  worktreePath?: string;         // private detached Git worktree
  publicationState?: "public" | "quarantined";
  publishedRootIdentity?: { dev: number; ino: number };
  sourceInventory?: PersistedVerificationSourceInventoryEntry[];
  writableIgnoredDirectories?: string[];
  // source/repository identity, commit/digest, and cleanup diagnostics
}
```

Public paths are beneath `<stateDir>/verification-checkouts/<project-hash>/`,
while private worktrees, candidates, and audit quarantines are beneath the
separate server-only `verification-checkouts-private` root. The project id is
hashed into an opaque scope; it is never used directly as a filesystem path
component. A ready lease records the identity of the exact published root so a
path replacement cannot be traversed, audited, or removed as though it were
still the checkout.

The durable lease store is `<stateDir>/verification-checkouts.json`, published
with the same tmp-file, fsync, rename, and serialized-write discipline as
other recovery-critical stores. The matching active-verification reference is
persisted before execution, so restart recovery knows which snapshot is
authoritative. Lease records are operational data only; paths and Git errors
stay in server logs rather than gate API payloads.

### Acquiring the snapshot

The harness acquires a snapshot *after* its existing non-destructive origin
synchronization and *before* either step-cache construction or step launch:

1. Resolve and canonicalize `sourceRoot = goalBranchContainer(goal)`. Require
   a directory that is also the single Git repository root, and a full known
   `signal.commitSha` that matches `HEAD`. Git uses fixed `execFile` argument
   arrays, sanitized Git environment, disabled hooks, and no caller-selected
   ref or cwd.
2. Derive the public and private project-scoped roots from the authoritative
   project id. Require a UUID signal id, reject a state root inside the source
   root, and persist a `preparing` lease before creating any Git worktree.
3. Create the private detached metadata worktree:

   ```text
   git -c core.hooksPath= -C <repoRoot> worktree add --detach --no-checkout <private>/<project-hash>/<signal>.worktree <commitSha>
   ```

   `--no-checkout` avoids filter-transformed source bytes. The private tree is
   never mounted into a sandbox or supplied as an execution cwd.
4. Read the strictly decoded tracked/non-ignored-untracked inventory from the
   mutable source once, persist it on the lease, and materialize it into the
   private worktree. This raw-byte copy preserves executable mode and symlink
   target, records tracked deletion, and rejects missing/unreadable paths,
   special files, symlink escapes, replacement races, and unsupported layout.
5. Derive literal writable ignored-output directory names from the materialized
   `.gitignore` files and confirm them with the private worktree's Git ignore
   engine. Materialize the same frozen inventory into a separate private
   candidate, optionally expose manager-owned ignored setup dependencies, and
   add an empty root `.git` file. The empty file is a discovery barrier, not a
   Git directory: it prevents Git from walking upward into an enclosing
   gateway repository.
6. Digest the candidate using the raw-byte inventory, make source files
   read-only, persist the approved ignored-output allowlist and candidate root
   identity, then atomically rename it to the project-scoped public signal
   path. The sandbox enforces the allowlist with exact writable overlays over
   an otherwise read-only source bind; the host-side mode pass remains a
   guardrail. Finally change the lease to `ready` and persist it.

The split topology is required for both dirty-source fidelity and safe
execution. A detached checkout at `HEAD` alone loses staged, unstaged, and
untracked bytes; an ordinary public Git worktree would expose metadata and
allow Git discovery from a command/reviewer cwd. The private worktree retains
trusted Git context while the atomically published public tree contains only
the exact source inventory and its empty `.git` barrier.

### Immutability during execution

Before launch, the published public tree marks source files read-only and
uses a sticky public root so a sandbox UID cannot replace the root `.git`
barrier. On the host, directory modes are only a guardrail. Every production
phase that executes source, including one for a direct/unsandboxed goal, runs
in a dedicated sidecar with one read-only bind of that exact public source
tree; only validated, lease-recorded ignored directories receive separate
writable child overlays. Docker must be running and the configured Bobbit
sandbox image must already exist. Verification does not build the image,
provision a mutable project container, clone a project, or inject project
credentials. That kernel mount boundary, not a command's UID or host mode
bits, keeps the attested source bytes immutable while allowing reports and
build output.

The correctness boundary is quarantine-and-digest validation:

- `assertUnchanged()` first atomically moves the exact public root into a
  private audit quarantine. It validates the recorded filesystem identity,
  recomputes the inventory digest, checks for non-ignored source additions,
  and atomically republishes the same root only if all checks pass.
- The harness removes any phase sidecar before that audit. It audits before a
  phase, after a phase, and once more before terminal publication. This keeps
  same-phase commands on a stable public cwd while ensuring a sandbox cannot
  modify the tree concurrently with a privileged audit.
- A mismatch or read failure produces `PINNED_CHECKOUT_MUTATED` or
  `PINNED_CHECKOUT_UNREADABLE`, prevents cache materialization, and cannot
  record `passed`. Ignored output overlays can hold reports, coverage, and
  approved setup dependencies without becoming source bytes.

The public checkout path replaces the live `cwd` passed to command execution,
reviewer/QA sessions, artifact collection, and command lifecycle metadata.
`builtinVars.commit` comes from the validated detached commit. Review prompt
construction receives the public cwd for display/execution plus the private
`trustedGitCwd` for server-side baseline/diff queries. Each reviewer is told
that its execution cwd is frozen and still forbidden to checkout, pull, or
fetch.

D-3's original single-repository constraint remains the v1 compatibility
path: it verifies `sourceRoot === repoRoot` after canonicalization. D-4 adds a
v2 logical branch-container layout for nested component cwd and
multi-repository execution. It resolves the component location structurally,
then maps it only through the pinned manifest; it does not derive a pinned cwd
from a live absolute path. Invalid, missing, nested, or overlapping repository
roots still fail closed rather than falling back to a live cwd. See [D-4's
layout discovery and mapping rules](pinned-multi-repo-verification.md#source-layout-and-representation).

## Integration flow

### Fresh execution and step cache

`verifyGateSignal()` now:

1. Retains signal validation and origin synchronization on the live branch
   worktree, then acquires the split pinned checkout and persists its digest,
   attestation, and active lease reference. Acquisition failure is a fixed
   infrastructure failure and launches no step.
2. Calls `buildStepCache()` with the persisted pinned digest. Existing SHA,
   invalidation-time, optional-step, human-signoff, and phase filters remain
   unchanged.
3. If all steps are cached, audits the just-created public tree, publishes the
   cached gate result, then releases the resources. This gives a new cached
   signal an immutable source witness even though no command ran.
4. Otherwise audits before each phase, creates a signal-specific sandbox
   sidecar only if that fresh phase needs one, and executes all same-phase
   command/reviewer/QA work against the stable public source-only cwd (or the
   sidecar's equivalent read-only-source plus exact-output-overlay view).
   Cached individual steps retain their existing result while every fresh step
   shares that public snapshot.
5. Removes the sidecar and audits after every phase and once before final
   publication. The private worktree supplies only trusted host-side Git
   context; it is never an execution cwd.
6. Publishes the signal/gate terminal status after the final audit. The active
   record remains a terminal cleanup owner until command cleanup, sidecar
   removal, and checkout release converge; it is not dropped merely because
   the terminal status has become visible.

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

A whole-gate reuse does not execute a process or acquire a new checkout. It is
safe to materialize only when the current live preliminary digest equals this
durable pinned digest; its new cached signal copies the prior
`pinnedCheckout` attestation and the matching current digest. Any
mismatch/unavailable/legacy attestation creates a fresh signal which takes the
pinned execution path above.

`buildStepCache()` likewise requires the prior step's signal to have matching
valid content and pinned attestation. Its existing decision object gains
`pinned-checkout-unavailable` and `pinned-checkout-mismatch` miss reasons;
the latter is used when valid source digests match but an attestation is
missing or inconsistent. Neither rule relaxes D-1/D-2's digest guards.

### Cancellation, restart, and cleanup

The manager is owned by the harness and preserves existing cancellation
behavior:

- `cancelStaleVerifications`, normal cancellation, timeout, and `shutdown()`
  do not release a checkout until command process-tree cleanup reaches its
  durable terminal barrier. This avoids removing either execution cwd or
  private Git context under live work.
- An active lease is not deleted merely because the gateway shuts down. On
  restart, `resumeInterruptedVerifications()` restores the active record and
  resumes only the persisted `ready` lease after it validates project owner,
  public-root identity, commit, and digest. It never rebuilds from the mutable
  goal worktree.
- Startup recovery preserves leases owned by active records and targets only
  orphaned leases. Release first quarantines/removes the exact public root,
  then removes the private detached worktree through its recorded repository
  root, then removes any private candidate/audit remnants. It does not run a
  global `git worktree prune` and never recursively deletes an unvalidated
  path.
- If a public-root, private-worktree, or sidecar removal fails, the active
  verification/lease stays in durable releasing or terminal-cleanup-pending
  state. Bounded retries run only for that recorded owner across restart; a
  new signal cannot inherit or overwrite that cleanup responsibility.
- Terminal publication and resource release are separate. A failure to clean
  up cannot manufacture a pass, and a valid final verdict does not authorize
  forgetting the record before exact cleanup converges.

The manager uses canonical containment and identity checks before every copy,
chmod, rename, quarantine audit, Git call, and deletion. Lease IDs, paths,
source roots, and refs are never accepted from route bodies. Git uses bounded
argument vectors with a sanitized environment; agent-provided `GIT_DIR`,
`GIT_WORK_TREE`, and `GIT_INDEX_FILE` cannot redirect it.

### Delivered file changes

- `src/server/agent/verification-pinned-checkout.ts` and
  `verification-checkout-scope.ts` own the split private/public topology,
  project-scoped path derivation, atomic publication/quarantine, inventory
  materialization, and lease recovery.
- `verification-content-digest.ts` supplies the raw-byte inventory and digest
  contract. `verification-harness.ts` owns acquisition, phase audits,
  trusted-Git context, sidecar lifecycle, terminal resource ownership, and
  restart recovery.
- `gate-store.ts`, `verification-logic.ts`, and `gate-signal-response.ts`
  persist and require the pinned attestation for cache eligibility.
- The focused coverage is registered in `tests2/tests-map.json`.

## Delivered coverage

The focused suite uses real temporary Git repositories for filesystem/Git
behavior and lifecycle-faithful fakes only where timing or process ownership
needs control:

1. `tests2/core/verification-pinned-checkout.test.ts` covers dirty tracked,
   staged, untracked, deleted, executable, symlink, and ignored-output
   materialization; project scope/foreign owner refusal; source-addition and
   mutation detection; durable ready-lease restart; targeted orphan cleanup;
   and busy/access-denied cleanup retry.
2. `tests2/integration/verification-pinned-checkout-real-git.test.ts` covers
   a real empty-index private detached worktree, Git-free public publication,
   private-Git-confirmed ignored-output allowlists, restart validation, and
   post-sync commit repinning. `verification-pinned-checkout-npm.test.ts`
   proves the allowed ignored dependency exposure does not enter the digest.
3. `tests2/core/verification-sandbox-exec.test.ts` covers exact public
   sandbox cwd selection, no mutable-worktree fallback, stable same-phase cwd,
   sidecar/audit ordering, source-mutation failure, cancellation ownership,
   restart resume, and root single-repo component support. D-4's nested and
   multi-repository sandbox coverage is documented in
   [Pinned multi-repo verification](pinned-multi-repo-verification.md#delivered-coverage).
4. `tests2/integration/sandbox-pentest.test.ts`,
   `tests2/core/project-sandbox-agent-dir-mounts.test.ts`, and
   `tests2/core/docker-args.test.ts` pin the sidecar mount boundary: one exact
   signal source execution view, no private worktree or broad state mount, and
   only approved output overlays.
5. `tests2/core/verification-logic.test.ts` and
   `tests2/integration/gate-signal-reminder.test.ts` pin cache decisions and
   signal lifecycle behavior for coherent and unavailable pinned attestations.

Run the focused core/integration tests plus `npm run check`, `npm run test:unit`,
`npm run test:browser`, and `npm run test:e2e` through the normal workflow.

## Non-goals

- Changing D-4's multi-repository/component-root execution and relative-cwd mapping; that delivered extension is documented in [Pinned multi-repo verification](pinned-multi-repo-verification.md).
- Making arbitrary hostile verification commands sandbox-secure; digest
  assertions provide correctness, while filesystem permissions are only a
  guardrail.
- Changing cache invalidation, optional-step, human-signoff, phase, sandbox,
  command timeout, cancellation, or restart-verdict policy.
- Retaining pinned checkout contents after finalization; the durable signal
  stores an attestation, never a long-lived copy of user source.
