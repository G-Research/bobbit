# D-5: pinned gate verification end-to-end plan

## Delivery status

D-5 is delivered by complementary tests at three boundaries:

- `tests/e2e/pinned-verification-sidecar.spec.ts` is the production gateway and Docker-sidecar proof. It pauses real single-repository and multi-repository commands, mutates the corresponding live worktrees, and proves the sidecar reads only the frozen source, maps the multi-repository component cwd once, exposes sanitized history, and cleans up the exact sidecar/checkout.
- `tests2/integration/pinned-gate-verification-e2e.test.ts` is the real-Git `VerificationHarness` lifecycle proof. It owns terminal mutation auditing, cache-attestation decisions, cancellation ordering, restart/resume, and retryable exact cleanup without replacing those timing seams with a fake checkout manager.
- `tests2/browser/journeys/goal-team-gates-verification.journey.spec.ts` owns the rendered history contract: deterministic injected pinned-checkout evidence survives reload and exposes only the fixed public diagnostic. It intentionally does not prove real Git materialization or Docker execution.

This document is the acceptance and coverage boundary for those complementary tests; no one fixture is a substitute for another boundary.

## Purpose and acceptance boundary

D-3 established a source-only, signal-owned checkout for a single repository.
D-4 extended that checkout to a logical branch-container layout containing
multiple repositories and nested component paths. Their focused tests prove the
manager and harness seams independently. D-5 closes the remaining composition
gap: prove the actual gate lifecycle keeps one frozen source witness from
signal creation through process execution, audits, terminal evidence, cache
selection, cancellation/recovery, and cleanup.

Together, the D-5 tests must prove all of the following. The production sidecar
cases establish the source-execution claims; the harness and browser cases
cover lifecycle and rendered-history seams that are intentionally deterministic.

1. A fresh signal acquires a `VerificationPinnedCheckoutManager` checkout after
   synchronization and before cache/step execution. A command reads that
   checkout, never the mutable branch container, even if the latter changes
   while the command is paused.
2. `GateSignal.contentDigest` and `GateSignal.pinnedCheckout` identify the
   materialized source. A later public-tree mutation cannot publish `passed`;
   the durable failure has only the fixed, sanitized `PINNED_CHECKOUT_*`
   code/message.
3. Whole-gate and step cache decisions remain fail-closed: unchanged coherent
   evidence may reuse; a changed digest, missing/incoherent attestation, or
   changed v2 repository identity runs fresh.
4. A D-4 component command executes at exactly one pinned logical suffix:
   `<public root>/<repo>/<relativePath>`, not the public root, a doubled suffix,
   or any live component path. Each repository remains represented in the v2
   attestation and aggregate digest.
5. Re-signalling/cancellation and restart recovery retain the specific
   lease/sidecar until command cleanup is safe, then remove only recorded
   resources. They never reconstruct a checkout from changed live bytes or
   delete a replacement/foreign path.
6. An operator can identify the frozen source evidence and a failure cause in
   the gate signal/history without receiving checkout paths, raw Git output,
   lease JSON, or private-worktree paths.

This plan is a verification delivery. It intentionally does not redesign D-1
through D-4, change the digest algorithm, change ordinary workflow semantics,
or add a general test hook to production. Production changes are allowed only
when a D-5 test below first demonstrates a concrete failure, and must be the
narrowest fix with a regression assertion in that same test.

## Delivered seams and data flow to exercise

The D-5 tests must use these existing production boundaries rather than
reimplement their behavior:

```text
POST gate signal
  -> server.ts computes preliminary branch-container digest
  -> reuseCachedGateSignal() (only a coherent equal witness may fast-pass)
  -> GateStore.recordSignal() / VerificationHarness.beginVerification()
  -> VerificationHarness.verifyGateSignal()
       -> origin synchronization / post-sync commit update
       -> resolvePinnedSourceLayout() for D-4
       -> PinnedCheckoutManager.acquire()
       -> GateStore.updateSignalContentDigest() and
          updateSignalPinnedCheckout()
       -> buildStepCache()
       -> assertUnchanged() before phase
       -> mapPinnedLocation() / resolvePinnedExecutionContext()
       -> real command runner at public pinned cwd
       -> remove sidecar, assertUnchanged() after phase/finally
       -> terminal GateStore evidence
       -> _releaseTerminalVerificationResources()
          -> remove exact sidecar, release exact lease
```

The manager is `src/server/agent/verification-pinned-checkout.ts`:
`acquire`, `assertUnchanged`, `resume`, `recover`, and `release` own public
source publication, private detached worktrees, durable
`verification-checkouts.json`, quarantine audits, and exact cleanup.
`src/server/agent/verification-harness.ts` owns the active-verification record,
phase ordering, `resolvePinnedSourceLayout`, `resolveStepLocation`,
`mapPinnedLocation`, `resolvePinnedExecutionContext`,
`resumeInterruptedVerifications`, `cancelStaleVerifications`, and
`_releaseTerminalVerificationResources`.

`src/server/gate-signal-response.ts::reuseCachedGateSignal` owns route cache
eligibility; `src/server/agent/verification-logic.ts::buildStepCache` owns
per-step reuse. Both must observe the persisted `GateSignal` evidence defined
in `src/server/agent/gate-store.ts`, rather than a test-only digest copy.

## Test fixtures and mechanics

The focused harness suite is registered in `tests2/tests-map.json` as Vitest,
`tier: "e2e"`, `project: "e2e"`. The production sidecar suite is a Docker-gated
daily E2E in `tests/e2e/`, selected by the E2E runner only when Docker and the
prepared Bobbit image are available. The browser journey is registered in the
browser tier.

The real-Git harness fixtures use a run-isolated directory and the existing
patterns in `tests2/integration/verification-pinned-checkout-real-git.test.ts`
and `tests2/integration/verification-pinned-checkout-multi-repo-real-git.test.ts`:

- Initialize and commit actual repositories with `git init`, local identity,
  and separate source/state/control directories. The state directory must be
  outside every source root.
- Construct production `GoalStore`, `GateStore`, `ProjectContextManager`-shape,
  `VerificationHarness`, and `VerificationPinnedCheckoutManager`. Do not inject
  `FakePinnedCheckoutManager` or
  `createFakeVerificationCommandRunner`; use the normal manager and durable
  command runner.
- Use a command-local ready/release control pair outside the source tree. A
  short Node command writes `ready`, waits for `release`, then reads a named
  file from its supplied cwd and prints the value plus `process.cwd()`. The
  test changes the live source only after `ready` exists. This makes the race
  deterministic without sleep-based timing.
- Use `try/finally` to release any still-recorded lease, stop a held process,
  restore patched test-local dependencies, and remove only the run root.
  Assert the public checkout no longer exists and the manager reports no lease
  for successful cleanup; a failed cleanup test instead asserts one persisted
  `releasing` owner before retry/recovery.
- Reuse the real-Git fixture helpers where practical rather than copying Git
  stubs. `runFixtureCommand` / `spawn-with-retry` are appropriate only for
  fixture setup or controlled helper processes, not as a replacement for the
  harness command runner.

The tests may wrap a manager method only to observe an already-production
operation (for example, record `acquire` / `assertUnchanged` call order or hold
one completed cleanup attempt). They must delegate to the original method and
must not manufacture a checkout, digest, lease, or result.

## Required end-to-end cases

### 1. Single-repository frozen execution and durable evidence

**Production owner:** `tests/e2e/pinned-verification-sidecar.spec.ts` —
`keeps a live-mutated single-repository worktree out of the real sidecar and exposes only sanitized durable history`.

The harness companion is
`it("runs a real gate command from a frozen signal checkout while the live worktree changes")`.

1. Create a one-command workflow and real Git root with `fixture.txt =
   "frozen-v1"`.
2. Start `verifyGateSignal()` using a command that reaches the ready barrier,
   then mutate the live `fixture.txt` to `"live-v2"` and release the command.
3. Assert command output contains `frozen-v1`, never `live-v2`; the printed cwd
   is under that signal's project-scoped checkout root and is not the live
   root. Assert the live root really contains `live-v2` afterward.
4. Assert the signal passes and its persisted gate-store record has a valid
   content digest plus a v1 `pinnedCheckout` with the same commit and digest.
   The active record must have persisted a matching pinned reference before the
   command was released.
5. Assert at least pre-phase, post-phase, and terminal audits occurred through
   the real manager, then assert release removed the exact public checkout and
   lease. The changed live file must not affect the passed evidence.

This is the primary TOCTOU proof. It must fail if command cwd regresses to
`goalBranchContainer(goal)` or if the materializer reads after the test's live
mutation.

### 2. Public checkout mutation prevents a pass and reports safe evidence

**Harness owner:** `tests2/integration/pinned-gate-verification-e2e.test.ts` —
`fails a successful command that mutates its public pinned source and persists sanitized attestation failure`.

Run a real command whose cwd is the public checkout, deliberately relaxes the
fixture mode, and alters a tracked source byte before exiting zero. Assert:

- no `passed` terminal update/broadcast occurs;
- gate and signal end `failed`, with `pinnedCheckoutError.code ===
  "PINNED_CHECKOUT_MUTATED"` and the fixed message `Frozen verification source
  changed during execution.` in the error step;
- the original live source did not change;
- the signal response/store evidence includes no public checkout path, private
  worktree path, source root, Git stderr, or control-path marker;
- final cleanup removes only the signal checkout. A sibling sentinel beside the
  checkout scope survives.

This complements manager-only mutation coverage by proving the harness's
post-phase/final audit controls terminal publication.

### 3. Cache decisions are evidence-safe across the route and harness

**Harness owner:** `tests2/integration/pinned-gate-verification-e2e.test.ts` —
`reuses only coherent frozen evidence and refuses changed digest or v2 repository identity`.

Use a passed result from case 1 and exercise both cache layers:

- `reuseCachedGateSignal()` with the unchanged live digest must create a cached
  passed signal that copies the coherent pinned attestation. It must not call
  checkout acquisition or command execution.
- Change a tracked byte without changing `HEAD`, calculate the new production
  digest, then signal through the normal route/in-process gateway boundary.
  Assert route reuse returns the explicit digest-mismatch decision, produces a
  new running signal, and the real command executes against a fresh checkout.
- At the harness layer, seed a current signal only through normal acquisition;
  assert `buildStepCache()` reuses a previous step only when content digest and
  pinned attestation agree. A legacy/missing attestation yields
  `pinned-checkout-mismatch`; a stored checkout error yields
  `pinned-checkout-unavailable`.
- For a v2 fixture, retain equal aggregate bytes where useful but advance one
  component repository commit. Assert the ordered repository identity differs
  and step reuse is refused. Do not accept `GateSignal.commitSha` as a
  substitute for all component identity.

The route part should use `tests2/integration/_e2e/in-process-harness.ts` and
its gate-signal helpers if they can retain the real command runner; otherwise
add it to the focused module with the same server route and production
`reuseCachedGateSignal` invocation. Do not turn a cache test into a second
mock implementation.

### 4. D-4 nested component runs in the matching frozen subtree

**Production owner:** `tests/e2e/pinned-verification-sidecar.spec.ts` —
`runs a paused multi-repository component command from its exact frozen nested cwd after both live repositories change`.

The harness companion is
`it("runs a multi-repository component command from its exact pinned nested subtree")`.

Create a non-Git branch container with distinct real repositories at
`services/api` and `apps/web`. Persist the executing goal's authoritative
`repoWorktrees` map and a component with:

```ts
{ name: "api", repo: "services/api", relativePath: "packages/api",
  commands: { verify: "<controlled command>" } }
```

The workflow's command step references that component. Pause after acquisition,
change both live component files, then release it. Assert:

- output reads the original API byte and reports exactly
  `<pinned root>/services/api/packages/api`;
- it never reads the new live bytes, web bytes, public root, or a doubled
  `packages/api/packages/api` suffix;
- the v2 signal attestation contains both repository keys, their distinct
  commits/digests, and the aggregate digest; and
- cleanup removes the one public container layout and each recorded private
  worktree while leaving live repositories and an unrelated container sentinel
  intact.

This specifically composes `resolvePinnedSourceLayout`,
`resolveStepLocation`, `mapPinnedLocation`, and actual command execution. The
existing manager and sandbox unit tests remain responsible for hostile path and
Docker mount permutations; D-5 does not duplicate them.

### 5. Cancellation, restart, and exact cleanup ownership

**Harness owner:** `tests2/integration/pinned-gate-verification-e2e.test.ts`.
It provides two deterministic lifecycle cases:

`it("cancels a held real command before releasing its signal checkout")`

- Hold a command after it has opened the pinned cwd. Call
  `cancelStaleVerifications(goalId, gateId)` and observe the tracked command's
  termination before `PinnedCheckoutManager.release` resolves.
- Assert the late successful exit cannot publish `passed`; the active
  verification remains a cleanup owner until command tree cleanup and lease
  release converge; then the lease/public root are gone. A replacement or
  sibling path must remain untouched.

`it("restarts from the persisted ready lease without rereading mutated live repositories and reaps terminal cleanup")`

- Pause a durable active verification after acquisition, record its
  `active-verifications.json` and ready lease, mutate the live source(s), then
  construct a fresh harness/manager over the same state as the restart model.
  Do not call `acquire` for the resumed signal.
- Call `resumeInterruptedVerifications()`. Assert `resume(signalId, projectId)`
  validates the recorded checkout; resumed output reads only original bytes and
  its result uses the original digest/attestation. A missing/replaced checkout
  must become `PINNED_CHECKOUT_UNREADABLE`, never trigger live rematerialization.
- Include a terminal-cleanup-pending variant: make the first exact release fail
  through a delegating test-local failure at the removal boundary, assert the
  persisted active row/lease stays owned and reports
  `CHECKOUT_RELEASE_FAILED`, then recreate the harness/manager and allow the
  exact retry to converge. Verify no unrelated checkout is swept.

Use existing `_releaseTerminalVerificationResources`,
`resumeInterruptedVerifications`, manager `recover`, and deterministic manual
clock patterns from `tests2/core/verification-sandbox-exec.test.ts` and
`tests2/core/verification-pinned-checkout.test.ts`. The test must not delete
`verification-checkouts/` wholesale to simulate cleanup.

## Operator diagnostics and browser proof

Every fresh source-executing phase, including a direct/unsandboxed goal, uses
an immutable Docker sidecar. The production sidecar suite requires Docker and
a prepared Bobbit sandbox image; gate signalling does not build that image. An
unavailable sidecar/image reports only the fixed
`PINNED_CHECKOUT_UNREADABLE` diagnostic, never Docker arguments or daemon
output.

The public signal contract is `contentDigest`, a v1 or v2 `pinnedCheckout`,
and a sanitized `pinnedCheckoutError`. The fixed messages are defined in
[Retained gate diagnostics](../gate-diagnostics.md#pinned-verification-operational-evidence).
For a mutation, the terminal Error step is exactly `Frozen verification source
changed during execution.` The expanded dashboard history presents it exactly
as `Frozen source unavailable: Frozen verification source changed during execution. (PINNED_CHECKOUT_MUTATED)`.
Checkout paths, private worktree paths, raw Git output, Docker identifiers,
and lease data remain absent from the API and rendered history.

The production sidecar test asserts the API/history sanitization using real
source and checkout paths. The browser journey's `renders durable
frozen-source witnesses and keeps pinned failures sanitized after reload` test
uses its injected deterministic manager to assert the API projection, expanded
history rendering, and reload persistence. It is deliberately not a second
Docker or real-Git lifecycle test, and it adds no UI-only diagnostic field.

## Coverage ownership and completion checks

The focused suites retain their seam-level responsibilities:

- `tests2/core/verification-pinned-checkout.test.ts`: materialization,
  containment, retries, and the lease state machine;
- `tests2/integration/verification-pinned-checkout-real-git.test.ts` and
  `verification-pinned-checkout-multi-repo-real-git.test.ts`: raw Git/public
  layout mechanics;
- `tests2/core/verification-sandbox-exec.test.ts`: harness mapping, phase
  audit order, injected cancellation, sidecar seams, and restart seams;
- `tests2/core/verification-logic.test.ts` and
  `tests2/integration/gate-signal-reminder.test.ts`: cache-decision matrix.

D-5 composes those seams without duplicating them:

- `tests/e2e/pinned-verification-sidecar.spec.ts` owns the real gateway,
  `SessionManager` → `SandboxManager` Docker sidecar lifecycle, including the
  paused single- and multi-repository live-worktree mutations, exact pinned
  nested cwd, API/history sanitization, and exact cleanup.
- `tests2/integration/pinned-gate-verification-e2e.test.ts` owns the real-Git
  harness lifecycle not made deterministic by the sidecar fixture: terminal
  public-source mutation audit, cache witness refusal, cancellation-before-
  release, restart without rematerializing live bytes, and retryable cleanup.
- `tests2/browser/journeys/goal-team-gates-verification.journey.spec.ts` owns
  the rendered and reloaded history projection using deterministic injected
  evidence; it does not attest to real source execution.

Run:

```sh
npm run check
npm run test:unit
npm run test:browser
npm run test:e2e
```

A production defect found by this plan is in scope only when the new real
lifecycle test fails before the fix and passes afterward. Add the smallest
regression test and retain every acceptance assertion above; do not use D-5 to
refactor the manager, alter Docker policy, redesign cache rules, or broaden
checkout persistence.
