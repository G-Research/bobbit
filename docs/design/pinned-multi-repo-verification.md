# Pinned multi-repo verification (D-4)

## Decision and invariant

D-4 extends D-3's signal-owned frozen checkout from one Git root to the
*logical branch container* of a goal. It fixes `FIX-PINNED-NESTED-STEP-CWD`:
a verification step must resolve its component cwd once against the goal's
branch container and execute at the equivalent location in the frozen copy,
not at the copied-container root and never in the live worktree.

> Every fresh verification signal that runs a component command beneath a
> nested path or in a different repository uses only the matching path in one
> signal-owned pinned layout. A signal passes only after every copied repository
> still matches the persisted source manifest and aggregate digest.

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

## Delivered approach

D-4 completes `FIX-PINNED-NESTED-STEP-CWD`. `resolveStepLocation()` resolves
a component to a validated logical location, independent of any live absolute
cwd. The checkout manager materializes the complete logical layout, and the
harness maps that location to the pinned host or sandbox root exactly once.
Thus a nested component or polyrepo command executes at its matching frozen
path.

The logical representation is a security and correctness boundary. Mapping a
resolved live absolute path after the fact could double-apply `relativePath`,
lose a repository boundary, or turn an escaping/replaced source path into a
live fallback. D-4 refuses those conditions instead.

```text
frozen project components + own goal's repository map
  -> resolve component to { repoKey, relativePath } once
  -> synchronize the verification cwd; validate every goal-owned repository root
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

`resolvePinnedSourceLayout(goal)` returns one of these closed layouts:

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

`buildStepCache()` compares the current and prior persisted v1/v2
attestations rather than treating equal `commitSha` as sufficient. It requires
exact layout kind, ordered repository keys, each commit, per-repo digest, and
aggregate digest. A v1 prior attestation is only comparable to another single
layout. Old signals and any partial/unknown v2 manifest are cache misses,
never inferred matches.

The route-level whole-gate path also needs current component identity, not
only the branch-container digest. D-5 makes it observe an independent,
path-free witness of the ordered component keys and commits before v2 reuse.
The witness must exactly match the prior v2 attestation; an unavailable or
mismatched witness, incomplete evidence, or a v1/v2 transition proceeds to
fresh pinned verification. This retains the digest guard while preventing a
pass from repository A being reused after only repository B changed. See the
[D-5 end-to-end verification plan](pinned-gate-verification-e2e.md) for the
production lifecycle coverage.

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
   acquisition. The harness applies the existing origin synchronization to its
   verification cwd, then validates and pins every authoritative repository
   root from its current worktree state. A failure in any repository fails the
   signal before a post-acquisition step cache is built or a command is
   launched. The single-repo synchronization flow and
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
   recovery state before calculating post-acquisition step cache reuse. Fresh
   and cached steps share this one aggregate witness.
6. At every fresh phase, map each logical location to the public path, create
   one sidecar if sandboxed, map the same relative path beneath the sidecar
   execution root, then execute. Commands and agent QA use only public mapped
   paths. Server-side LLM review uses the single manager-selected trusted
   checkout Git context, not a repository collection; it must not expose a
   private path to an agent.
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

Every production phase that executes frozen source requires Docker and a
prebuilt configured Bobbit sandbox image, including direct/unsandboxed goals.
Gate signalling does not build that image or provision a mutable project
sandbox; failure is the sanitized `PINNED_CHECKOUT_UNREADABLE` outcome. The
host and Docker views must use the identical logical relative path.
`ProjectSandbox` mounts one completed signal root read-only at
`/bobbit-state/verification-sources/<signalId>` and builds the root-owned view
at `/bobbit-state/verification-checkouts/<signalId>`. A verification sidecar
receives **no** broad live `/workspace`, `/workspace-wt`, or clone-source mount;
it also receives no private checkout material. D-4 therefore cannot obtain a
mutable branch container merely by choosing a different cwd.

For each persisted container-relative ignored output directory, Docker receives
one validated writable child overlay below that signal view. Dependency exposure
is likewise per repository (for example, `services/api/node_modules`), but it
is the sole narrow exception to the no-live-worktree rule: Docker mounts only
that exact, validated subpath read-only from the correct project's worktree
volume. The persisted dependency map binds the repository-local public path to
its matching volume subpath. It cannot mount the containing workspace/worktree
volume, select a sibling repository, use another project's volume, or replace
the recorded target. The former root-only `node_modules` assumption must not
select a dependency directory from another repository.

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

## Delivered implementation

- `src/server/agent/verification-harness.ts` resolves structural step
  locations, chooses the executing goal's layout, maps only through the
  pinned manifest for command and QA execution, and preserves the same
  contract during resume.
- `src/server/agent/verification-pinned-checkout.ts` owns v2 repository
  manifests, per-repository private worktrees and inventories, aggregate
  digest construction, public container-layout publication, audits, resume
  validation, and exact cleanup. Its v1 single-root path and durable records
  remain compatible.
- `src/server/agent/verification-content-digest.ts` builds the prefixed
  aggregate inventory without changing v1 hashing semantics.
- `src/server/agent/verification-checkout-scope.ts` centralizes repository-key
  validation and deterministic private repository path derivation, so raw keys
  never become filesystem components without validation.
- `gate-store.ts`, `verification-logic.ts`, and `gate-signal-response.ts`
  persist the v1/v2 attestation union. The harness compares it for
  post-acquisition per-step reuse; v2 route reuse additionally requires its
  independently observed ordered, path-free component witness.
- The verification sidecar contract persists and validates a multi-layout
  output/dependency map while retaining the exact signal-root mount.

## Delivered coverage

The focused tests are registered in `tests2/tests-map.json`:

1. `tests2/core/verify-step-resolution.test.ts` covers
   `FIX-PINNED-NESTED-STEP-CWD`: an own child-goal branch container, component
   `repo` plus `relativePath`, exact-once logical suffix mapping, malformed
   locations, and no live-cwd fallback.
2. `tests2/core/verification-pinned-checkout.test.ts` covers independent
   repositories, aggregate identity, restart without reading live bytes, and
   per-repository cleanup/retry ownership.
3. `tests2/integration/verification-pinned-checkout-multi-repo-real-git.test.ts`
   uses distinct real Git repositories to verify frozen nested paths, separate
   private worktrees, recovery, containment/overlap refusal, and targeted
   cleanup.
4. `tests2/integration/gate-content-digest-nested.test.ts` proves a nested
   child goal's own v2 repository identity controls cache reuse rather than a
   parent or sibling worktree.
5. `tests2/core/verification-sandbox-exec.test.ts` covers exact nested sidecar
   cwd mapping, no mutable-worktree fallback, per-repository dependency links,
   and restart validation of the persisted v2 link map.
6. `tests2/core/docker-args.test.ts`,
   `tests2/core/project-sandbox-agent-dir-mounts.test.ts`, and
   `tests2/integration/sandbox-pentest.test.ts` cover mount isolation: no broad
   live `/workspace`, `/workspace-wt`, or clone-source mounts; only exact
   read-only dependency-volume subpaths for the owning project; dependency
   remapping; rejection of foreign, broad, or mismatched sidecar adoption; and
   exact sidecar cleanup before a checkout can be released.

Run focused tests, `npm run check`, then the inherited unit/browser/E2E gates.

## Non-goals

- Changing D-1/D-2's v1 source digest semantics or rehashing historical
  single-repository signals.
- Treating a multi-repository branch container as a Git repository, inventing
  a fake Git commit, or allowing normal project sandbox cwd remapping.
- Supporting nested/overlapping component repository roots, arbitrary
  component filesystem paths, or opaque recovery from a malformed manifest.
- Retaining user source after the verification lifecycle completes.
