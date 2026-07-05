# Gate step cache — content-keyed mode (VER-01)

Status: shipped behind `BOBBIT_GATE_CACHE` (default unchanged: `sha`).
Finding: Fable audit `VER-01` — "Commit-SHA-exact step cache forces a full
re-run of the entire gate suite on every Ralph-loop fix".

## The problem

`buildStepCache` (`src/server/agent/verification-logic.ts`) reuses a
previously-passed verify step only when the new signal's `commitSha` is
*byte-identical* to a prior signal's `commitSha`. The Ralph loop's normal
operating mode is: run the gate, a reviewer fails a step, the coder commits a
fix, HEAD advances, the gate is re-signalled. That's a new SHA on every
iteration, so the cache is empty on essentially every re-signal — build,
typecheck, unit, the (900s-timeout) e2e suite, and every LLM review re-run
from scratch to validate a delta that may be a single line in one file.

## The fix: an opt-in content-keyed mode

`BOBBIT_GATE_CACHE=content` widens step reuse: a step can now be reused
across *different* commit SHAs when the step declares `cacheInputGlobs` on
its `VerifyStep` definition and those globs are byte-identical between the
two commits (`git diff --quiet oldSha newSha -- <globs>`, run at the step's
resolved cwd). Steps that don't declare `cacheInputGlobs` always require an
exact SHA match, in *every* mode — nothing about their reuse behavior
changes.

Default is `sha` (today's behavior, unchanged). This is a pure A/B knob: flip
it per-environment, compare cache-hit rate and gate wall time via the
telemetry log line below, revert by unsetting the var.

## Design constraints and how they're met

**Safety first — conservative over-invalidation.** A stale hit that skips a
needed re-run is worse than the perf bug it fixes. Three independent
guards, each fail-closed:

1. **Opt-in per step.** No declared `cacheInputGlobs` ⇒ sha-exact only,
   unconditionally — see the per-step table below for which steps declare
   globs and why.
2. **Existence guard.** A glob pathspec that matches *zero* tracked files is
   indistinguishable, to `git diff --quiet -- <pathspec>`, from a pathspec
   whose files are genuinely unchanged — both report "no differences". A
   stale/typo'd glob (e.g. a renamed `src/` directory) would otherwise look
   permanently content-stable. `buildContentStepCache` checks
   `git ls-tree -r --name-only <sha>` (glob-free, always authoritative)
   first and refuses to treat the step as verifiable at all if none of its
   declared globs match any tracked path — see `anyPathMatchesGlobs` in
   `verification-logic.ts`.
3. **Fail-closed on any git error.** An unreachable SHA (e.g. after a
   force-push GC'd the old commit), a timeout, or any other git failure is
   caught and treated as a miss, never a hit.

`resolveGateCacheMode` also fails closed on the env var itself: only the
exact literal string `"content"` selects content mode; anything else
(unset, empty, a typo) resolves to `"sha"`.

**Exact-SHA behavior is preserved under the default flag.** `buildStepCache`
is completely unmodified by this change — content mode calls it verbatim for
the exact-SHA pass and only layers additional per-step content matches on
top for steps still uncached afterward. The full pre-existing
`buildStepCache` test suite (`tests/verification-logic.test.ts`) passes
byte-for-byte unmodified, which is the regression guard for "default
behavior didn't change."

**Telemetry.** Every `verifyGateSignal` call logs one structured line:

```
[verification][gate-cache] mode=<sha|content> gate=<gateId> commit=<sha8> decisions=[{stepName,keyKind,result,reason?}, ...]
```

`keyKind` is `"sha"` or `"content"` per step, `result` is `"hit"` or
`"miss"`, and `reason` explains a miss (no globs declared, glob matched no
tracked paths, git lookup failed, etc.). This is per-step, per-verification,
so hit rate by key kind is directly greppable from gate logs for the A/B.
Wall-clock and cost deltas are already observable via existing gate logs and
`cost-tracker.ts` — no new instrumentation needed for those.

## Per-step key table

| Step (implementation gate) | Type | Key kind (content mode) | Why |
|---|---|---|---|
| Build | command | sha-exact (no `cacheInputGlobs` shipped by default) | Generic across arbitrary managed projects — the harness has no sound default file-layout assumption (no `src/`, `tests/` guarantee). Opt-in per-project by adding `cacheInputGlobs` to the workflow's `Build` step. |
| Type check passes | command | sha-exact by default | Same reasoning as Build. |
| Unit tests | command | sha-exact by default | Same reasoning as Build. |
| E2E tests | command | sha-exact by default | Same reasoning as Build — also the step type most exposed to live server/DB state, which is exactly the "can't be soundly determined from a file diff" case flagged in the design constraints even where globs are declared. |
| Gap analysis / Code quality / Bug hunt / Risk (llm-review) | llm-review | sha-exact always | LLM reviews read the full diff, not a fixed file set; there is no static glob that soundly captures "what this reviewer's verdict depends on". Kept conservative per the design constraint's explicit carve-out. |
| human-signoff | human-signoff | never reusable, any mode | Pre-existing invariant (Bug-1 defense-in-depth) — a prior approval is not consent for a re-signal. Unconditionally excluded before any glob/SHA check runs. |
| subgoal | subgoal | sha-exact always | Orchestration step, not file-scoped; out of scope for this change. |

**The mechanism ships with zero workflow YAML changes** — every seeded
workflow's default command steps keep their current sha-exact behavior even
with the flag on, because none declare `cacheInputGlobs`. This is
deliberate: hardcoding a folder convention (`src/**`, `tests/**`, ...) into
`seed-default-workflows.ts` would be wrong for a project whose codebase
doesn't share Bobbit's own layout — the harness manages arbitrary projects,
not just itself. Turning on real content-keyed reuse for a specific project
is an opt-in, per-workflow-step declaration
(`{ name: "Build", ..., cacheInputGlobs: ["src/**", "package.json", ...] }`),
left as a follow-up once the mechanism has bake time with telemetry.

## A/B plan

1. Ship with default `sha` (no behavior change) for at least one merge
   window.
2. Flip `BOBBIT_GATE_CACHE=content` on a subset of goals/environments once at
   least one workflow's command steps declare real `cacheInputGlobs` for
   that project's actual layout.
3. Compare, via the `[verification][gate-cache]` log line: hit rate by
   `keyKind`, and gate wall-clock (existing gate logs) / cost
   (`cost-tracker.ts`) before vs after.
4. If content mode's hit rate and safety hold up over real Ralph-loop
   traffic, consider flipping the default and/or shipping real
   `cacheInputGlobs` in `seed-default-workflows.ts` for the command steps
   whose inputs a majority of managed projects can soundly declare (e.g. via
   a project-level convention already captured in `project.yaml`).

## Where the code lives

- `src/server/agent/verification-logic.ts` — `GateCacheMode`,
  `resolveGateCacheMode`, `globToRegExp` / `pathMatchesAnyGlob` /
  `anyPathMatchesGlobs`, `ContentCacheGitDeps`, `buildContentStepCache`
  (pure decision logic, git I/O injected).
- `src/server/agent/verification-harness.ts` — `gitListTrackedPaths` /
  `gitDiffIsClean` (the real git-backed `ContentCacheGitDeps`
  implementation) and the `verifyGateSignal` call site that selects cache
  mode, resolves each step's cwd, and emits the telemetry line.
- `src/server/agent/workflow-store.ts` — `VerifyStep.cacheInputGlobs`
  (load/save round-trip in `normalizeStep` / `serializeStep`).
- Tests: `tests/verification-logic.test.ts` (decision logic, fake deps),
  `tests/gate-content-cache-git-deps.test.ts` (real git behavior for the two
  git-backed functions).
