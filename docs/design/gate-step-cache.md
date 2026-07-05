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

## Per-step key table (generic — `seed-default-workflows.ts` template)

| Step (implementation gate) | Type | Key kind (content mode) | Why |
|---|---|---|---|
| Build | command | sha-exact (no `cacheInputGlobs` shipped by default) | Generic across arbitrary managed projects — the harness has no sound default file-layout assumption (no `src/`, `tests/` guarantee). Opt-in per-project by adding `cacheInputGlobs` to the workflow's `Build` step. |
| Type check passes | command | sha-exact by default | Same reasoning as Build. |
| Unit tests | command | sha-exact by default | Same reasoning as Build. |
| E2E tests | command | sha-exact by default | Same reasoning as Build — also the step type most exposed to live server/DB state, which is exactly the "can't be soundly determined from a file diff" case flagged in the design constraints even where globs are declared. |
| Gap analysis / Code quality / Bug hunt / Risk (llm-review) | llm-review | sha-exact always | LLM reviews read the full diff, not a fixed file set; there is no static glob that soundly captures "what this reviewer's verdict depends on". Kept conservative per the design constraint's explicit carve-out. |
| human-signoff | human-signoff | never reusable, any mode | Pre-existing invariant (Bug-1 defense-in-depth) — a prior approval is not consent for a re-signal. Unconditionally excluded before any glob/SHA check runs. |
| subgoal | subgoal | sha-exact always | Orchestration step, not file-scoped; out of scope for this change. |

**`seed-default-workflows.ts` itself still ships zero `cacheInputGlobs`.**
That file is the legacy-migration fallback template used to seed workflows
for *arbitrary* managed projects (`migrate-project-yaml.ts`) — it has no
sound default file-layout assumption (no guaranteed `src/`, `tests/`
convention), so hardcoding one there would be wrong for a project whose
codebase doesn't share Bobbit's own layout. Real adoption is a per-project,
per-workflow-step declaration in that project's own `project.yaml` — see the
next section for Bobbit's own adoption.

## W3.1b — adoption in Bobbit's own `project.yaml`

Bobbit manages itself (the Ralph loop that lands the `fable/*` branches on
this repo runs against `.bobbit/config/project.yaml`, not a generic
template), so it is exactly the "at least one workflow's command steps
declare real `cacheInputGlobs` for that project's actual layout" precondition
the A/B plan below was waiting on. `general`, `feature`, `bug-fix`, and
`quick-fix` all declare `cacheInputGlobs` on their `component: bobbit`
Build / Type check / Unit tests steps (their `command: build|check|unit` maps
to `npm run build|check|test:unit` per `commands:` in that same file).
Pinned end-to-end (static glob values + real git-backed hit/miss behavior) by
`tests/gate-cache-globs-adoption.test.ts`.

| Step | `cacheInputGlobs` | Soundness rationale |
|---|---|---|
| **Build** (`npm run build` = `build:packs && build:server && build:ui`) | `src/**`, `defaults/**`, `market-packs/**`, `scripts/**`, `public/**`, `index.html`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, `tsconfig.web.json`, `vite.config.ts` | Union of every input each build sub-step actually reads: `tsc` compiles `src/server+shared` (`tsconfig.server.json`) and `src/ui+app+shared` (`tsconfig.web.json`); `scripts/copy-defaults.mjs` copies `defaults/**` verbatim into the build output; `scripts/copy-builtin-packs.mjs` + `scripts/build-market-packs.mjs` read `market-packs/**` (pack sources, esbuild config); Vite reads `index.html`, `vite.config.ts`, and `public/**` (copied into `dist/ui` verbatim). `package.json`/`package-lock.json` cover dependency-version changes (transitive type defs, bundled deps) that a source-only diff can't see. |
| **Type check passes** (`tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.web.json --noEmit`) | `src/**`, `tsconfig.json`, `tsconfig.server.json`, `tsconfig.web.json`, `package.json`, `package-lock.json` | `src/` contains exactly the four dirs (`app`, `server`, `shared`, `ui`) both tsconfigs' `include` cover — confirmed against `ls src/` — so `src/**` is the exact (not over-broad) source surface. The three tsconfigs are the compiler's own inputs; `tsconfig.json` is the (empty, project-references-only) root. `package.json`/`package-lock.json` cover ambient `@types/*` version changes. |
| **Unit tests** (`node scripts/run-unit.mjs` — node:test over `tests/*.test.ts` + `tests/contract/*.test.ts`, Playwright `file://` fixtures over `tests/*.spec.ts` + subdirs) | `src/**`, `tests/**`, `defaults/**`, `market-packs/**`, `scripts/**`, `index.html`, `vite.config.ts`, `package.json`, `package-lock.json` | Node-logic tests `import` server/shared source directly (`tsx`, no `dist/` step) and browser fixtures exercise `ui`/`app` source, so the same `src/**` surface as Build/Typecheck applies. `tests/**` is broad on purpose rather than the exact `tests/*.test.ts` + `tests/contract/*.test.ts` + `tests/*.spec.ts` (+ `tests/search`, `tests/ui-fixtures` subdirs) the runner actually touches — over-matching (invalidating on an e2e/manual-integration-only test edit) is the safe direction per the design's own "over-matching is safe, under-matching is the risk" principle, and enumerating every current spec subdir here would silently under-match the day a new one is added. `defaults/**` / `market-packs/**` are read directly by tests that assert on shipped tool/pack contents (`tool-contributions.test.ts`, `builtin-packs.test.ts`, etc.). `scripts/**` covers the unit runner's own orchestration (`run-unit.mjs`, `test-unit-args.mjs`, `test-phase-config.mjs`). `index.html` / `vite.config.ts` are read directly by `index-html-meta.test.ts` / `vite-watch-ignored.test.ts`. |
| **E2E tests** (`npx playwright test --config playwright-e2e.config.ts`) | *(none — sha-exact)* | Spawns a real gateway process against a live port/worktree and drives a real browser — exactly the "most exposed to live server/DB state" case the generic table above already calls out. A file-diff can't soundly bound process-lifecycle/port/timing nondeterminism. |
| **Repro test passes (bug fixed)** (bug-fix workflow, `run: "{{reproducing-test.meta.test_command}}"`) | *(none — sha-exact)* | The actual command is a per-goal dynamic value substituted from upstream gate metadata, not a fixed script — there is no static glob (or even a fixed *command*) to key on. |
| `ready-to-merge` steps (all workflows) | *(none — sha-exact)* | Check live remote state (`git ls-remote`, `git merge-base` against `origin/{{baseBranch}}`, `gh pr list`) — this can change with zero local file diff (e.g. someone else pushes to the PR, or the base branch moves), so it is never soundly reducible to a content key. |
| `pr-review` workflow (all steps) | *(none — sha-exact)* | Every step reads live GitHub PR state (`gh pr checkout/view/review`) — the reviewed artifact isn't this repo's tracked content at a SHA at all. |
| `human-signoff-test` workflow (all steps) | *(none — sha-exact)* | Test-only exerciser fixture with literal `sleep NN && echo ok` commands — no real project inputs to glob. |

## A/B plan

1. Ship with default `sha` (no behavior change) for at least one merge
   window. — done.
2. Flip `BOBBIT_GATE_CACHE=content` on a subset of goals/environments once at
   least one workflow's command steps declare real `cacheInputGlobs` for
   that project's actual layout. — done (W3.1b, this repo's own
   `project.yaml`, see above). `BOBBIT_GATE_CACHE=content` itself is not
   flipped on by this change — that remains a separate operational decision;
   this change only makes turning it on *effective* once it is.
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
  (load/save round-trip in `normalizeStep` / `serializeStep`; note the YAML
  key is camelCase `cacheInputGlobs`, unlike sibling snake_case fields such as
  `depends_on` — `normalizeStep` only reads the camelCase form).
- `.bobbit/config/project.yaml` — Bobbit's own live workflow config; the
  `cacheInputGlobs` adoption described above.
- Tests: `tests/verification-logic.test.ts` (decision logic, fake deps),
  `tests/gate-content-cache-git-deps.test.ts` (real git behavior for the two
  git-backed functions), `tests/gate-cache-globs-adoption.test.ts` (W3.1b —
  pins the exact adopted globs per step in `.bobbit/config/project.yaml` and
  exercises them against real git-backed hit/miss behavior).
