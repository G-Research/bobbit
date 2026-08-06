# Pinned multi-repo verification (D-4)

## Decision and invariant

D-4 extends D-3's signal-owned frozen checkout from one Git root to the
*logical branch container* of a goal. It fixes `FIX-PINNED-NESTED-STEP-CWD`:
a verification step must resolve its component cwd once against the goal's
branch container and execute at the equivalent location in the frozen copy,
not at the copied-container root and never in the live worktree.

> Every fresh verification step, including a component command beneath a
> nested path or in a different repository, runs only from the matching path
> in one signal-owned pinned layout. A signal passes only after every copied
> repository still matches the persisted source manifest and aggregate digest.

D-4 preserves D-1/D-2 and D-3 contracts:

- The existing v1 raw-byte digest algorithm and the byte-for-byte single-repo
  result are unchanged. Tracked/untracked membership, deletion, executable
  mode, symlink target, ignored-file treatment, and cache invalidation retain
  their existing meanings.
- D-3's source-only public tree, private Git context, durable lease, atomic
  publication/quarantine audit, sidecar ordering, and terminal cleanup owner
  remain mandatory. No D-4 path may fall back to `goal.cwd`, a component's
  live worktree, or a normal project sandbox.
- A D-3 v1 single-repository lease/signal remains resumable. A legacy signal
  without a coherent pinned attestation remains cache-ineligible.

This is a verification-layout change, not a broad change to component setup,
worktree provisioning, workflow validation, command retry policy, or Git
synchronization policy.

## Terms

| Term | Meaning |
|---|---|
| branch container | `goalBranchContainer(goal)`: the un-offset, goal-owned container. For a polyrepo goal it is non-Git and holds component worktrees; for a monorepo it is the one repository root. |
| repository key | A validated component `repo` value. `.` denotes the single-repository root; a polyrepo key is a relative path such as `services/api`. |
| repository entry | One unique Git worktree in a pinned layout. Multiple components may select the same entry with different `relativePath` values. |
| logical path | A slash-separated path inside the branch container: either `.` or `<repo>/<relativePath>`. It is data, not a host or container absolute path. |
| execution root | The public source-only checkout root. D-4 recreates the branch-container logical layout beneath it. |

## Existing defect and selected approach

Today `resolveStep(step, components, cwd)` correctly calculates a live
component cwd as `<branchContainer>/<repo>/<relativePath>`. D-3 rejects every
result other than `cwd`, then materializes one Git root and launches every
step at `pinnedCheckout.path`. That is safe but makes a nested component or
polyrepo command unavailable. Mapping the resolved *live absolute path* into
the checkout after the fact is unsafe: it can double-apply `relativePath`,
lose the repository boundary, or turn an escaping/replaced source path into a
live fallback.

The selected design makes component resolution return a validated logical
location first. The manager materializes a full logical layout and the harness
maps that location to the pinned host or sandbox root exactly once.

```text
frozen project components + own goal's repository map
  -> resolve component to { repoKey, relativePath } once
  -> validate goal-owned live repository roots / synchronize each repository
  -> read one raw-byte inventory and commit for each repository
  -> materialize private Git worktree and source tree per repository
  -> publish one public source-only branch-container layout
  -> map logical location once to public host path or exact sidecar path
  -> phase execution
  -> remove sidecar; quarantine/audit every repository inventory; release
```

The manager, rather than a caller, remains the only owner of public/private
paths, repository worktrees, inventories, and cleanup. The harness owns
workflow-step resolution and passes an already validated layout specification
to the manager.

## Source layout and representation

### Layout discovery

Before acquisition, the harness loads the *executing goal* from its own
`ProjectContextManager` context. It does not inherit the parent goal's
`worktreePath`, `cwd`, `repoWorktrees`, or project configuration. This is the
nested-goal boundary: a child is pinned from its own branch container and its
own component worktrees even if parent and child share a commit or project.

`resolvePinnedLayout(goal, components)` returns one of these closed layouts:

```ts
type PinnedRepositorySource = {
  repoKey: string;                 // "." or normalized component repo path
  sourceRoot: string;              // canonical goal-owned Git worktree root
  commitSha: string;               // full Git commit for this repository
};

type PinnedSourceLayout =
  | { version: 1; kind: "single"; containerRoot: string; repositories: readonly [PinnedRepositorySource] }
  | { version: 2; kind: "multi"; containerRoot: string; repositories: readonly PinnedRepositorySource[] };
```

For `kind: "single"`, the sole entry has `repoKey: "."` and `sourceRoot ===
containerRoot`; it follows the D-3 acquisition code path so existing v1 bytes,
paths, and state remain unchanged. A multi-repository layout is selected only
when the goal has an authoritative non-empty `repoWorktrees` map. Its keys,
not caller-provided absolute paths, identify the repository entries.

Discovery must reject rather than guess when any condition below fails:

1. The container/root or an entry is absent, a symlink, not a directory, or
   changes identity while being inspected.
2. A repository key is not a normalized safe relative path (`.` only for the
   root entry; no absolute, drive, UNC, NUL, backslash-normalization,
   `.`/`..`, or duplicate/case-colliding segments).
3. `realpath(repoWorktrees[repoKey])` is not exactly
   `realpath(containerRoot/repoKey)` for a polyrepo entry, or the root entry
   is not exactly the canonical container root. This binds the map to the
   branch container instead of accepting a map that points into another goal.
4. The entry is not a Git top-level directory, its `HEAD` is not a full SHA,
   repository roots overlap, or two keys resolve to the same root. Components
   may share *one key*, but nested/overlapping Git roots are rejected because
   their inventories and cleanup ownership are ambiguous.
5. Components reference an absent repository key, or a component's normalized
   `relativePath` is not contained in its repository entry. It need not exist
   until command execution, but a nonexistent path is a normal command failure
   inside the pinned tree—not permission to choose another cwd.

The existing configuration validator remains the first line of defense;
D-4 repeats containment at the live filesystem boundary because frozen
configuration can be old and a goal record is persisted state.

### Commit and digest manifest

A polyrepo signal cannot truthfully use one Git SHA as the identity of all
source. D-4 therefore does **not** overload `GateSignal.commitSha` with a
synthetic SHA or pass a synthetic value to Git. It introduces a source identity
used by lease validation, active recovery, and cache decisions:

```ts
type PinnedRepositoryManifest = {
  repoKey: string;
  commitSha: string;                         // full SHA of this entry
  contentDigest: VerificationContentDigest;  // existing v1 digest, per repo
  sourceInventory: PersistedVerificationSourceInventoryEntry[];
  publicRelativePath: string;                // "." or repoKey
  trustedGitWorktreePath?: string;           // lease-private only
};

type PinnedCheckoutAttestation =
  | { version: 1; commitSha: string; contentDigest: VerificationContentDigest }
  | {
      version: 2;
      layout: "multi-repo";
      contentDigest: VerificationContentDigest; // aggregate, v1 algorithm
      repositories: readonly {
        repoKey: string;
        commitSha: string;
        contentDigest: VerificationContentDigest;
      }[];
    };
```

The D-4 aggregate uses the existing `computeVerificationContentDigestFromInventory`
algorithm with its v1 header. The manager prefixes every per-repository
inventory path with its normalized repository key (`services/api/src/x.ts`),
then sorts the combined raw path inventory by UTF-8 bytes. Its `fileCount` is
the sum of repository file counts. Thus the aggregate continues to mean
"all non-ignored bytes verification can read", while the prefix prevents
identical files in distinct repositories from aliasing. Single-repo D-3 still
uses its original unprefixed inventory and produces exactly its original v1
digest.

`GateSignal.commitSha` remains the existing single-Git-repository field. For
a new multi layout it is display/legacy metadata only; every cache, resume,
and attestation comparison must instead use `PinnedSourceIdentity`:

```ts
type PinnedSourceIdentity =
  | { kind: "single"; commitSha: string; digest: VerificationContentDigest }
  | { kind: "multi"; aggregateDigest: VerificationContentDigest;
      repositories: readonly { repoKey: string; commitSha: string; digest: VerificationContentDigest }[] };
```

`buildStepCache()` and `reuseCachedGateSignal()` receive that identity rather
than treating equal `commitSha` as sufficient. They require exact layout kind,
ordered repository keys, each commit, per-repo digest, and aggregate digest.
A v1 prior attestation is only comparable to another single layout. Old signals
and any partial/unknown v2 manifest are cache misses, never inferred matches.
This retains D-1/D-2's digest guard while preventing a pass from repository A
being reused after only repository B changed.

The durable public `GateSignal.pinnedCheckout` stores the sanitized v2
attestation, never filesystem paths, inventories, or Git output. The existing
v1 attestation shape is retained as a union. `ActiveVerification.pinnedCheckout`
and `PinnedCheckoutLease` carry the full private manifest needed to resume:
repository key, canonical source/root identity, commit, inventory, digest,
public relative path, private worktree path, and the public root identity.

## Exact-once step cwd mapping

Refactor structural step resolution into a pure logical resolver and two
one-way mappers:

```ts
type ResolvedStepLocation = {
  runString?: string;
  location: { kind: "container" } | {
    kind: "component";
    repoKey: string;
    relativePath: string; // "." or normalized relative path inside repo
  };
};

resolveStepLocation(step, components, context): ResolvedStepLocation;
mapPinnedLocation(checkout, location): { hostCwd: string; relativePath: string };
mapSandboxPinnedLocation(signalId, relativePath): string;
```

`resolveStep()` may remain as a compatibility wrapper for normal execution,
implemented by resolving the logical location then joining it to a supplied
branch container. It must not be used to derive a pinned cwd from an already
absolute live cwd.

Rules:

- `{ component, command }` and `{ component, run }` resolve the component
  name once. Their location is its `repoKey` plus `relativePath`.
- Free-form `{ run }`, LLM review, human sign-off, and an agent-QA step with
  no component use `{ kind: "container" }`, i.e. the complete pinned layout.
  Agent-QA with `component` uses that component location; its component
  configuration lookup follows the same resolver.
- `mapPinnedLocation()` accepts only an entry in the checkout's persisted
  manifest. It obtains a canonical public execution root, appends the
  manifest's public relative path and the already-normalized component suffix,
  and proves lexical containment. It never calls `realpath` through a
  command-created path and never uses the live location as a fallback.
- The manager preserves container layout in the public copy: for a polyrepo
  component `repo: "services/api", relativePath: "packages/web"`, both live
  and pinned logical resolution are exactly
  `services/api/packages/web`. The command runs at
  `<pinnedRoot>/services/api/packages/web`, once—not at `<pinnedRoot>`, and
  not with `packages/web` appended twice.
- The root `.git` discovery barrier remains at the public container root. No
  copied component has Git metadata, so Git started in a child stops at that
  barrier rather than discovering an enclosing gateway repository.

This explicit logical mapping is the regression boundary for
`FIX-PINNED-NESTED-STEP-CWD` and for a child goal whose `cwd` contains a
monorepo offset. `goalBranchContainer(goal)` stays the only place that chooses
`worktreePath ?? cwd`; it is called once for the own goal, before resolution.

## Acquisition and execution flow

1. Resolve the own goal layout and each step's logical location before source
   acquisition. Resolve/synchronize every repository against its own
   `sourceRoot`; a failure in any repository fails the signal before a cache
   is built or a command is launched. The single-repo synchronization flow and
   post-sync signal repin remain unchanged.
2. Persist a `preparing` lease containing the immutable repository plan. For
   each ordered entry, read D-1's raw source inventory once, validate the
   repository HEAD, create a private detached `--no-checkout` worktree at its
   own SHA, and materialize exactly that entry's raw bytes there.
3. Derive ignored writable-output directories and optional ignored setup
   dependencies from each private materialized repository. Store them as
   container-relative paths (for example `services/api/dist`), with one
   explicit ownership record per repository. A component cannot grant a
   writable overlay to another component by using a prefixed path.
4. Materialize every entry into one private candidate preserving its repository
   key layout. Create the root Git-discovery barrier, compute each existing
   per-repo digest and the aggregate digest, make source files read-only, and
   atomically publish the complete candidate as one public signal root.
5. Persist ready layout/identity state, the v2 signal attestation, and active
   recovery state before calculating step cache reuse. Fresh and cached steps
   share this one aggregate witness.
6. At every fresh phase, map each logical location to the public path, create
   one sidecar if sandboxed, map the same relative path beneath the sidecar
   execution root, then execute. Review Git context is selected by the review
   target: whole-layout review receives a deterministic read-only collection
   of private repositories; component-targeted QA receives only its matching
   private worktree. No private path is supplied to an agent or command.
7. Remove the phase sidecar, quarantine the complete public root, recompute
   all repository and aggregate digests from persisted inventories, check for
   non-ignored additions within each repository subtree, and republish only
   the same recorded root. Audit before phases, after phases, and before a
   terminal pass as D-3 already requires.

A source replacement, unreadable entry, unknown repository key, mismatch in
one repository commit/inventory/digest, or inability to map a component cwd
is a fixed pinned-checkout failure. It cannot degrade to a live worktree
execution or a cache hit.

## Sandbox parity

The host and Docker views must use the identical logical relative path.
`ProjectSandbox` continues to mount one completed signal root read-only at
`/bobbit-state/verification-sources/<signalId>` and builds the root-owned view
at `/bobbit-state/verification-checkouts/<signalId>`. D-4 changes neither
mount to a broad project or branch mount.

For each persisted container-relative ignored output directory, Docker receives
one validated writable child overlay below that signal view. Dependency exposure
is likewise per repository (for example,
`services/api/node_modules`), with the manager recording the exact repository
entry and the sidecar remapping only that exact dependency link to the matching
normal sandbox worktree. The former root-only `node_modules` assumption must
not select a dependency directory from another repository.

`mapSandboxPinnedLocation()` appends only the previously validated logical
relative path to the fixed signal root. `sandboxPinnedCheckoutCwd()` remains an
exact manager-path-to-signal-root check; it must not accept arbitrary suffixes
or host paths. The active sidecar reference persists its version, project,
signal, full Docker ID, root cwd, ordered output overlays, and layout
attestation digest. Recovery validates all of these before it reconnects.

## Recovery and cleanup

D-4 retains D-3's `preparing` → `ready` → `releasing` state machine and adds
no global sweep.

- A v2 ready lease resumes only after validating the exact public-root identity,
  all ordered manifest fields, each private worktree path derived from its
  repository key, and all repository/aggregate digests. Resume never reads a
  current goal worktree to reconstruct the layout.
- Restart uses the active record's persisted layout identity. If the goal was
  deleted or its current `repoWorktrees` changed, recovery still may remove
  only the exact recorded sidecar and checkout resources; it may not resume
  execution against substituted coordinates.
- Release quarantines and removes the one public root after identity checks,
  then removes every private worktree through the corresponding recorded live
  repository root, then removes private candidates/audits. Each path is
  deterministically re-derived from `(projectId, signalId, repoKey, kind)` and
  containment/identity-checked before traversal or deletion.
- A failure in one repository cleanup leaves the signal's one durable releasing
  lease and its bounded retry owner intact. It never deletes remaining paths
  by a recursive container sweep, and a new signal cannot inherit those paths.
- v1 leases use their existing single-repository release path. State loaders
  reject malformed v2 manifests before any filesystem or Git operation;
  unknown future layout versions are unreadable, not backward-compatible
  guesses.

## File-level implementation plan

- `src/server/agent/verification-harness.ts`: introduce logical step-location
  resolution, resolve the own goal layout, synchronize/repin each repository,
  pass layout to checkout acquisition, use pinned location mapping for command,
  QA, review, and resume paths, and make cache input source identity-aware.
- `src/server/agent/verification-pinned-checkout.ts`: add v2 repository
  manifests, per-repository private worktrees/inventories/materialization,
  aggregate digest construction, public container layout publication,
  per-repository audit, resume validation, and exact multi-worktree cleanup.
  Preserve the existing v1 single-root code path and on-disk records.
- `src/server/agent/verification-content-digest.ts`: expose a narrowly scoped
  helper to create a prefixed aggregate inventory without changing v1 hashing
  semantics; retain existing single-root API behavior.
- `src/server/agent/verification-checkout-scope.ts`: centralize repository-key
  validation and deterministic private repository path derivation; do not use
  raw keys as unvalidated filesystem components.
- `src/server/agent/gate-store.ts`, `verification-logic.ts`, and
  `gate-signal-response.ts`: persist the v1/v2 attestation union and compare
  `PinnedSourceIdentity` for whole-gate and per-step reuse.
- `src/server/agent/project-sandbox.ts`, `docker-args.ts`, `session-manager.ts`,
  and verification-sidecar types: validate and persist the multi-layout
  sidecar/output/dependency map while retaining the exact signal-root mount.

## Focused regression coverage

Register all additions in `tests2/tests-map.json`.

1. Extend `tests2/core/verify-step-resolution.test.ts` with
   `FIX-PINNED-NESTED-STEP-CWD`: a child goal's un-offset branch container,
   a component `repo` and `relativePath`, and the pinned mapper must produce
   the same logical suffix exactly once. Cover free-form/container and
   component/QA locations, malformed keys, unknown components, and no live
   cwd fallback.
2. Extend `tests2/core/verification-pinned-checkout.test.ts` with a
   two-repository fixture. Assert separate commits and v1 per-repository
   digests, deterministic aggregate digest, shared-repository components,
   dirty/untracked/deleted/executable/symlink fidelity, cross-repository
   mutations, containment/overlap refusal, malformed durable manifest refusal,
   restart without reading live bytes, and targeted per-repository cleanup
   retries.
3. Add `tests2/integration/verification-pinned-checkout-multi-repo-real-git.test.ts`.
   Use real distinct Git repositories and a non-Git branch container. Verify a
   nested component command observes only its frozen path, changes after
   acquisition do not affect output, each private Git worktree is at its own
   SHA, public children expose no Git metadata, and all public/private trees
   are cleaned after success and acquisition failure.
4. Extend `tests2/integration/gate-content-digest-nested.test.ts` to prove a
   nested child goal's own component map drives digest/cache identity. Change
   only one child repository and assert both whole-gate and step reuse miss;
   changing a parent or sibling live worktree must not substitute the child.
5. Extend `tests2/core/verification-sandbox-exec.test.ts`,
   `tests2/integration/sandbox-pentest.test.ts`, and Docker-argument coverage
   for exact multi-repo root mounts, nested sidecar cwd parity, per-repo output
   overlays/dependency remapping, absence of private/live mounts, sidecar
   removal before audit, and invalid container-relative map rejection.
6. Extend restart/cancellation coverage in
   `tests2/core/verification-command-restart-lifecycle.test.ts` and the
   pinned-checkout integration suite: persist a v2 active lease, restart with
   changed/deleted live component roots, resume only the same published layout,
   then verify failure and cleanup-pending paths leave no cross-repository
   deletion authority.

Run focused tests, `npm run check`, then the inherited unit/browser/E2E gates.

## Non-goals

- Changing D-1/D-2's v1 source digest semantics or rehashing historical
  single-repository signals.
- Treating a multi-repository branch container as a Git repository, inventing
  a fake Git commit, or allowing normal project sandbox cwd remapping.
- Supporting nested/overlapping component repository roots, arbitrary
  component filesystem paths, or opaque recovery from a malformed manifest.
- Retaining user source after the verification lifecycle completes.
