# Data-driven proofs & A/B testing framework

Status: **design only — no production code changed.** This document is the
deliverable. AJ's directive: "design skills or tools or themes to do proper
data driven proofs and A/B testing."

All file:line citations verified live in this worktree
(`fable/d6-ab-design`, based on `origin/aj-current`) on 2026-07-05 — grep and
read, not recalled.

---

## Recommendation

Bobbit already has two of the three pieces a real A/B framework needs —
**a goal-spawn experiment engine** (the `experiment-runner` pack) and
**four durably-collected, goal/session-addressable telemetry stores**
(cost, gate signals, classifier decisions, tool-permission audit). It is
missing the third piece, and it is the one that actually caused the
`VER-07` and `VER-01` "hand-run A/B"s to be unreproducible proofs rather
than results: **an honest, pre-registered assignment record for
in-place flag experiments** (`BOBBIT_GATE_CACHE`, `BOBBIT_PARALLEL_REVIEWS`
and friends), which today are toggled fleet-wide for a time window with
nothing but a git commit and a person's memory saying which window was
which.

**Do not build a new experiment engine.** Build the missing piece —
assignment + reporting discipline — as a thin layer that both existing
paths can share:

| Experiment kind | Unit | Assignment today | Gap |
|---|---|---|---|
| **Goal-spawn** (workflow variant, prompt-profile, model-tier) — `experiment-runner` pack | goal run | Already honest: `ExperimentDef` is written before any child goal is spawned, `RunRecord`s are appended as goals settle (`docs/experiment-runner.md` §1, §4) | Only needs more `MetricExtractor`s (gate-cache hit rate, parallel-review token waste) and a shared statistics layer — no new mechanism |
| **In-place flag** (`BOBBIT_GATE_CACHE`, `BOBBIT_PARALLEL_REVIEWS`) — organic dev traffic | gate signal / goal | **None.** A human sets an env var, waits, greps a log line, unsets it. `RECONCILIATION-2026-07-05.md`'s VER-07 measurement (n=3/side, synthetic mocked delays, throwaway worktree, nothing pushed) is what this produces today | This document's actual deliverable |
| **UI variant** (themes) | session / user | None; no exposure-logging substrate exists on the client at all | Scoped **out of v0/v1** below — sketch only, §1.6 |

**Staged plan** (each stage independently useful, none blocks on the next):

- **v0 (today, zero code)**: a written pre-registration convention + a
  minimum-n / one-look statistical discipline, applied by hand to data that
  already exists (`gates.json`, `session-cost-turns.json`,
  `session-context-trace/*.jsonl`). This alone would have made VER-07/VER-01
  falsifiable instead of anecdotal. See §3 for the first real experiment run
  this way.
- **v1 (tooling)**: `scripts/ab-evidence-report.mjs` — a pure, unit-tested
  join+stats script (same shape as `scripts/playwright-json-summary.mjs`)
  reading a small experiment registry file, plus (v1.5, the one genuinely
  new mechanism) an **`ExperimentOverrideResolver`** seam at the exact
  policy-leak call sites `docs/design/verification-policy-seam.md` already
  inventoried (`verification-harness.ts:3419`, `:4041`), so a registered
  flag experiment can assign **concurrently**, per gate-run, instead of by
  time window — removing the confound that made VER-07/VER-01 unreproducible.
- **v2 (UI)**: surface both experiment kinds in the existing
  `experiment-runner` panel; an AJ-visible registry tab; UI-variant
  experiments revisited only once a client exposure-log substrate exists.

The first real experiment this framework should produce end-to-end
(§3): **`BOBBIT_GATE_CACHE=content` vs `sha` on Bobbit's own
`.bobbit/config/project.yaml` gate runs** — the lever is shipped, the
per-project `cacheInputGlobs` are already adopted (W3.1b), the flag itself
is deliberately **not yet flipped on live traffic** (`docs/design/gate-step-cache.md`
line 148: "that remains a separate operational decision"), and every metric
the analysis needs (hit rate, wall-clock, cost) is already collected with a
joinable key. It needs nothing but the v0 discipline to become a real
proof this week.

---

## 0. What exists today (read before designing anything new)

### 0.1 The `experiment-runner` pack — a goal-spawn engine, already honest

`docs/experiment-runner.md` documents a first-party market pack
(`market-packs/experiment-runner/`) that ships **active by default** (on
the `FIRST_PARTY_PACKS` allowlist, no install step) and already does real
A/B and autoresearch experiments, but exactly one
shape of them: **fan out N child goals as `host.agents.spawnGoal` calls**,
each with its own `metadata`/`inlineRoles`/`workflowId` treatment, poll them
to a terminal state, and pull `cost`, `gates`, `tasks` outcomes over the
existing authenticated REST surface (`docs/experiment-runner.md` §2, §2.2).

This already satisfies honest assignment for anything expressible as "spawn
a goal with these settings": workflow variant (`general` vs `solo-fast`),
prompt-profile variant (different `inlineRoles`), model-tier variant (a role
override that pins a model). The `ExperimentDef` is persisted *before*
launch (`exp/<experimentId>` in `host.store`) and every `RunRecord` is
appended as its goal settles (`exp/<experimentId>/run/<runId>`) — nobody can
retroactively decide which runs "count," because the variant list and
repeat count were fixed at definition time (`projectCost` even bounds the
spend up front). **This is not the gap.** A new A/B framework must not
duplicate this engine; it should register new `MetricExtractor`s against it
(§2 below) and stop there for this experiment shape.

What it does **not** cover: an experiment where the treatment is an
**env-var-gated behavior change inside a single running gateway**, applied
to organic development traffic rather than a purpose-spawned goal. That is
exactly the `BOBBIT_GATE_CACHE` / `BOBBIT_PARALLEL_REVIEWS` shape, and it is
the shape every dark-flag measurement to date has used.

### 0.2 The dark-flag pattern — real levers, no assignment record

Four flags exist as opt-in, `process.env`-gated behavior changes, each
already proven to have a real, measurable effect, each measured **ad hoc**:

| Flag | What it changes | How it was measured | Where |
|---|---|---|---|
| `BOBBIT_GATE_CACHE` | `sha` (default) vs `content` step-cache reuse | "flip it per-environment, compare cache-hit rate and gate wall time via the telemetry log line... revert by unsetting the var" | `docs/design/gate-step-cache.md` lines 28-30 |
| `BOBBIT_PARALLEL_REVIEWS` | serial vs concurrent leading review phase | 3 reps/side, **synthetic mocked delays** (build 3s, review 10s, etc.), throwaway worktree, instrumentation left uncommitted, nothing pushed | `RECONCILIATION-2026-07-05.md` "Dark flags: VER-05/VER-07 measurement," lines 212-234 |
| `BOBBIT_DOC_GATE_FILTER` | doc-gate inclusion | Named as a lever in `docs/design/self-improvement-loop.md` line 27; no dedicated A/B write-up found | `verification-logic.ts:600` |
| `BOBBIT_INPROC_BRIDGE` | in-process vs spawned pi bridge for eligible sessions | Design-spike measurement (`docs/design/in-process-bridge-spike.md`), not yet a live flag decision | `in-process-bridge-eligibility.ts:28` |

The VER-07 measurement is the clearest cautionary example, and it is worth
being precise about *why* it is a pilot, not a result, even though its
headline number (**−42.8% pass-path wall-clock**) is almost certainly
directionally correct:

1. **n=3 per arm.** No effect-size uncertainty is reportable at that n —
   the reconciliation doc reports point averages, not a range or CI.
2. **Synthetic, not real, workload.** Delays were hand-picked constants
   (build 3s, review 10s...), not sampled from real gate runs. A synthetic
   benchmark can prove the *mechanism* (concurrency saves wall-clock when
   the serial dependency is fake) without proving the *magnitude* on real,
   variable-length reviews.
3. **No assignment record.** There is no artifact saying "these 3 runs were
   OFF, these 3 were ON" that an independent script could re-derive and
   re-check — the claim is only as durable as the reconciliation doc's
   prose.
4. **Ephemeral worktree, uncommitted instrumentation.** The measurement
   apparatus itself doesn't exist anymore to be re-run.

None of this means the flag is wrong — the recommendation
("DEFAULT-ON-WITH-GUARD") in that same doc is reasonable. It means Bobbit
has no way to *cheaply upgrade* a finding like this from "plausible, hand-run
pilot" to "reproducible proof with real traffic and a stated confidence
level" — and that upgrade path is exactly what this framework should be.

### 0.3 Telemetry already durable enough to build on

Four stores are already goal/session-addressable and require **zero new
instrumentation** to join into an experiment result. All are files under
`stateDir` (`.bobbit/state/` in a project checkout):

| Store | File | Record shape (key fields) | Join key(s) |
|---|---|---|---|
| Per-turn cost | `session-cost-turns.json` (`cost-tracker.ts:246`) | `RawTurnCost` (`cost-tracker.ts:70-83`): `ts`, `sessionId`, `seq`, token/cache counters, `totalCost`, optional `goalId`, optional **`trigger`** (a free-form tag naming what caused the turn) | `sessionId`, `goalId` |
| Gate verification | `gates.json` (`gate-store.ts:109`) | `GateSignal` (`gate-store.ts:58-72`): `id`, `gateId`, `goalId`, `sessionId`, `timestamp`, `commitSha`, `verification.status`, `verification.steps: GateSignalStep[]` — each step has `type`, `passed`, `duration_ms`, `status` | `gateId`+`goalId` (composite), `sessionId`, `commitSha` |
| Classifier decisions | `session-context-trace/<sessionId>.jsonl` (`context-trace-store.ts:35`) | `TraceEntry` (`context-trace-store.ts:13-27`) with `decisions?: DecisionOutcome[]` (`decision-types.ts:91-110`: `point`, `decisionKind`, `decision: {kind, choice, confidence?, rationale?}`, `applied?`) | `sessionId` only — no `goalId` on the row itself |
| Tool-permission audit | `tool-permission-audit/<sessionId>.jsonl` (`tool-permission-audit-log.ts:26`) | `ToolPermissionAuditEntry` (`tool-permission-audit-log.ts:9-18`): `toolName`, `toolGroup?`, `decision: granted\|denied`, `source`, `toolApproveDecision?` | `sessionId`, `projectId?` |

One genuine gap worth flagging up front rather than discovering mid-build:
**`test-results/e2e-summary/<runId>.json`** (written by
`scripts/run-playwright-e2e.mjs:120-140`, shape `{passed, failed, flaky,
skipped, didNotRun, total, exitCode, signal, generatedAt, runId}`) carries
**no `goalId`/`sessionId`/`gateId` field at all** — only a self-generated
`runId`. E2E pass-rate is out of scope as a bound experiment metric until a
gate step that invokes this script threads its `signalId` through
`BOBBIT_E2E_RUN_ID` (a one-line, low-risk follow-up, not part of this
design). Every metric example in §2 below uses only the four join-key-clean
stores.

**`docs/design/self-improvement-loop.md`** already independently arrived at
several of this design's constraints and is worth reading in full — its
"A-B-testability" section (lines 205-209) states the same thesis this
document leads with: *"A review artifact should always name the experiment
and variant that generated it; otherwise it is evidence, not an A/B
result."* One correction to that doc, found while grounding this one: its
line 22 claims `TraceEntry.decisions[]` is not yet persisted in this
checkout — that is stale; `context-trace-store.ts:26` shows the field is
live (CLF-W1a shipped). Not fixed here (out of scope for a docs-only diff
adding one new file), but worth knowing before citing that doc's "today's
state" section for anything decision-trace-related.

---

## 1. Design questions

### 1.1 Unit of experiment

**Recommendation: two units, matched to the two experiment kinds in §0 — do
not force one unit to cover both.**

| Unit | Used by | Grain | Why this grain |
|---|---|---|---|
| **Goal run** | goal-spawn experiments (workflow variant, prompt-profile, model-tier) | one `spawnGoal` child, terminal-state to terminal-state | Matches what `experiment-runner` already produces as a `RunRecord`; a goal is the natural boundary for "which workflow/role/model was used," and cost/gate/task outcomes already roll up per goal (`cost-tracker.ts`'s `TreeCostBreakdown`, `computeTreeCost()`) |
| **Gate signal** | in-place flag experiments (`BOBBIT_GATE_CACHE`, `BOBBIT_PARALLEL_REVIEWS`) | one `verifyGateSignal` call, i.e. one `GateSignal` row | These flags are read at exactly this call site (`verification-harness.ts:3419`, `:4041`); a single goal can re-signal a gate many times (the Ralph loop's whole reason for existing), and per-signal is the grain at which `resolveGateCacheMode`/`isParallelReviewsEnabled` actually branch. Rolling up to goal level too early would average away the effect on the exact steps the flag touches |

**Pros of gate-signal grain for flag experiments:** much higher n per unit
time than goal-level (a single Ralph loop produces many re-signals), so the
"insufficient data" bar (§1.4) is reachable in days, not weeks. Directly
matches the existing `[verification][gate-cache]` telemetry line's own
grain (per-signal, per-step).

**Cons / what it doesn't give you:** a gate-signal-level effect (e.g. "this
one step reused from cache") doesn't automatically prove the goal-level
outcome AJ actually cares about (does the *whole gate* finish faster, does
the *goal* land faster). §2 requires every gate-signal-level experiment to
also declare a goal-level rollup metric for exactly this reason — cheap
because `goalId` is already on every `GateSignal`.

**UI-variant themes — assessed, scoped out of v0/v1, sketch for v2:**

A UI theme (or any client-rendered variant) is neither a goal run nor a
gate signal — its natural unit is a **session or a user**, and its natural
metrics (does the user reload less, dismiss fewer dialogs, spend less time
per task) live entirely on the client, in log shapes that don't exist yet.
Concretely: nothing in `src/server/ws/protocol.ts` today carries an
"experiment exposure" event, and no store persists "this browser tab saw
variant X." Building that substrate is a real, separate design (new WS
message, new store, consent/opt-out story, a much smaller and noisier
population than "every gate run this repo produces"). Recommend: **out of
scope for v0/v1 of this framework.** If AJ wants it, it is a v2-or-later
follow-up design that reuses this document's assignment/registry/reporting
conventions (§1.2-§1.5) but needs its own exposure-logging mechanism — not
a variant of the gate-signal or goal-run unit.

### 1.2 Assignment

**This is the actual gap (§0.2). Recommendation: pre-registered
declaration + deterministic per-unit hashing, staged in two steps.**

**v0 — time-windowed, but *registered* (no new code).** Keep today's
mechanism (set the env var for a period, unset it for another) but fix the
two things that make VER-07 unreproducible:

1. **Register before running.** Write the experiment id, hypothesis, lever,
   variants, unit, minimum-n, and a fixed end condition into a short file
   *before* flipping anything (§1.5's registry). This is the entire fix for
   "no post-hoc cherry-picking" at v0 — a human can still lie, but they now
   have to lie about a dated, checked-in commitment instead of a memory.
2. **Record the window, not just the flag state.** `{experimentId, variant,
   startTs, endTs}` — two lines in the registry file. Every `GateSignal` (or
   `RawTurnCost`, for goal-level flags) with a `timestamp` inside
   `[startTs, endTs)` is unambiguously in that arm. This is a join anyone
   can redo independently from `gates.json` alone.

**Con of time-windowing, inherent, not fixable at v0:** variant assignment
is confounded with *when* the window ran — a different commit range, a
different mix of goal types, different ambient load. This is the real
reason VER-07 used a synthetic benchmark instead of real traffic: real
traffic couldn't be split into two comparable time windows on demand. This
is deliberately left as v0's known limitation, not silently ignored — v1.5
exists to remove it.

**v1.5 — deterministic per-unit hashing (the `ExperimentOverrideResolver`,
new mechanism).** A pure function, unit-testable in isolation exactly like
`resolveGateCacheMode`/`isParallelReviewsEnabled` today:

```ts
// src/server/agent/experiment-override.ts (proposed — not created by this doc)

export interface ActiveFlagExperiment {
  id: string;
  lever: "gateCacheMode" | "parallelReviewsEnabled"; // allowlisted, see §1.6
  variants: [string, string]; // exactly two, e.g. ["sha", "content"]
  unit: "gateSignal" | "goal";
  startTs: number;
  endTs: number; // hard stop — no open-ended experiments, see §1.4
}

/** Deterministic, stable across replays: same unit id always gets the same variant
 *  for the lifetime of one experiment. No process state, no randomness. */
export function assignVariant(experiment: ActiveFlagExperiment, unitId: string): string {
  const hash = fnv1a32(`${experiment.id}\0${unitId}`);
  return experiment.variants[hash % 2];
}
```

Consulted **only** at the exact call sites `docs/design/verification-policy-seam.md`
already inventoried as policy leaks (`verification-harness.ts:3419` for
`gateCacheMode`, `:4041` for `parallelReviewsEnabled`) — this design doc
does not propose new call sites, it reuses the seam audit's own inventory.
Precedence, made explicit so it composes with that other in-flight design
rather than fighting it: **active experiment assignment (if any) wins over
the `BOBBIT_*` env var, which wins over the (future) `VerificationPolicy`
default** — an experiment is the most specific, most temporary override in
the stack, and should never silently lose to a stale env var someone forgot
was set. When no experiment is active for that lever, behavior is
byte-identical to today (env var, then policy default) — this slice adds a
lookup, never removes one.

**Pro:** both variants run *concurrently*, on the *same* commit range, same
ambient load — the confound v0 accepts is gone. n accumulates as fast as
real gate-signal (or goal) traffic occurs, no separate synthetic benchmark
needed.

**Con:** requires the harness to consult one more function at two call
sites — small, but real production code change, unlike v0's pure
discipline-and-paperwork fix. Gate this behind the same "byte-identical
when inactive" proof style `docs/design/verification-policy-seam.md`
demands of its own V1-V4 slices (§5 of that doc) — a pinning test that an
experiment-less run never even calls `assignVariant`.

**Recording, either stage:** the assignment (unit id, variant, experiment
id, timestamp) must be written **synchronously, before the outcome is
known** — for v0 that's the registry's window boundaries (written before
the window opens); for v1.5 that's a new append-only log,
`.bobbit/state/experiment-assignments/<experimentId>.jsonl`, one line per
unit at the moment `assignVariant` is called (same JSONL-per-something
pattern as `context-trace-store.ts`/`tool-permission-audit-log.ts` — no new
storage idiom introduced). A report script (§2, §1.5) that reads this log
and the outcome stores independently, and refuses to run if the log for a
claimed experiment id doesn't exist, is what makes "no post-hoc
cherry-picking" enforced rather than merely policy.

### 1.3 Metrics binding

**Recommendation: extend `experiment-runner`'s existing `MetricExtractor`
registry (`docs/experiment-runner.md` §5.1) rather than invent a second
metric vocabulary.** Its shape already fits both experiment kinds:

```ts
interface MetricExtractor {
  id: string;
  label: string;
  direction: "max" | "min";
  extract(raw: RawOutcome, ctx: { def: ExperimentDef; run: RunRecord }): number | null;
}
```

Goal-spawn experiments already populate `RawOutcome` from the child goal's
REST outcome (cost/gates/tasks). For in-place flag experiments, `RawOutcome`
is instead assembled by the join described in §0.3, keyed by the
assignment log's `unitId`:

| Metric id | Direction | Source | Join |
|---|---|---|---|
| `gateCache.hitRate` | max | `[verification][gate-cache]` telemetry line / `GateSignalStep` count of content-mode hits vs total cacheable steps | `gateId`+`goalId`+`commitSha` from `GateSignal` |
| `gate.wallClockMs` | min | sum of `GateSignalStep.duration_ms` for a signal | `GateSignal.id` |
| `gate.passRate` | max | `GateSignal.verification.status === "passed"` | `GateSignal.id` |
| `cost.totalUsd` | min | sum of `RawTurnCost.totalCost` for the signal's `sessionId` within the signal's time bounds | `sessionId` (already an existing built-in extractor, reused verbatim) |
| `review.wastedSpawns` | min | count of `GateSignalStep{type: "llm-review", status: "failed" or discarded}` following a command-phase failure — the exact VER-07 "wasted spawn" case | `GateSignal.id`, cross-checked against `RawTurnCost.trigger` for the discarded review's session |

None of these require new persistence — they are read-time joins over
existing files, the same "compute on read, never cache a derived
aggregate" discipline `docs/experiment-runner.md` §4 already documents for
`RunRecord` aggregation ("Zero-Re-Run Recalculations").

### 1.4 Statistical discipline

**Recommendation: treat every flag/agent-orchestration experiment as
small-n by default, and design the reporting layer so it cannot produce a
p-value-shaped false confidence.**

1. **Paired over unpaired wherever the unit allows it.** For gate-signal
   experiments under v1.5's concurrent hashing, pair by matching
   `gateId`+workflow shape (not by `commitSha`, which differs by
   construction between variants) — compare "this gate's build-step
   duration under content mode" against "the nearest same-gate signal under
   sha mode," not pooled means across all signals. Paired comparisons need
   far smaller n to detect the same effect size than unpaired ones, which
   matters enormously given real gate-run volume is nowhere near
   "thousands of samples."
2. **Effect size + interval, never a bare point estimate, never a p-value
   for n < ~20/arm.** Report median and a bootstrap or exact permutation
   interval (both distribution-free, appropriate for skewed wall-clock
   data and small n), not a mean ± t-test CI whose asymptotics don't hold
   at n=3. VER-07's "−42.8%" is a point estimate with n=3 and should be
   re-labeled **"pilot estimate, not a result"** in any evidence artifact
   until re-measured with a stated interval.
3. **One pre-declared analysis time; peeking is monitoring, not
   analysis.** The registry (§1.5) fixes `endTs` or a minimum-n threshold
   *before* the experiment starts. Checking the log mid-flight to see
   "is it working yet" is fine and expected (Ralph-loop iteration makes
   this cheap) but must not be reported as the result — only the
   pre-declared stopping point's numbers are the result. This is the same
   discipline `docs/experiment-runner.md`'s autoresearch mode already
   enforces mechanically via `maxIterations`/`plateauK`/`target` (§3.2) —
   this design applies the same discipline to A/B mode, where nothing
   currently enforces it.
4. **"Insufficient data" bar: n < 10 paired observations per arm is a
   pilot, not a finding.** Below that, the report script (§2) should print
   the interval and the label **"PILOT — do not cite as a percentage
   win"** rather than suppress the number; hiding a small-n result invites
   someone to re-derive it by hand and lose the labeling. VER-01's real
   per-project glob adoption (W3.1b, already shipped) crosses this bar
   naturally within days of real Ralph-loop traffic — see §3.

### 1.5 Surface

**Recommendation: skill (runbook) for v1, not a tool group, plus a thin
extension to the existing `experiment-runner` UI for v2. Do not add a new
`defaults/tools/experiments/` MCP tool group.**

Rationale for skill-over-tool-group: a tool group implies the harness calls
it programmatically, inline, on every relevant event (the way
`tool-group-policies.yaml`-gated tools fire during a live session).
Experiments are not run on every gate signal — they are deliberately rare,
human-initiated, bounded-duration activities. A `.claude/skills/`-style
runbook matches that cadence: an agent or AJ invokes it to *define*,
*check status of*, or *report* an experiment; nothing about it needs to be
in the hot path of `verifyGateSignal`. (The one piece that *is* in the hot
path — `assignVariant` at v1.5 — is a tiny, always-cheap function call, not
a tool invocation, and belongs in `verification-harness.ts`/
`verification-logic.ts` directly, same as `resolveGateCacheMode` today.)

**v0 (today):** no surface at all — a markdown registry
(`docs/experiments/registry.md` or, better, machine-readable from day one,
`.bobbit/state/experiments/registry.json`, one entry per experiment: id,
hypothesis, lever, variants, unit, start/end, status, verdict) plus manual
`rg`/`jq` over `gates.json` / `session-cost-turns.json` /
`session-context-trace/*.jsonl`. This is genuinely enough to run the first
real experiment in §3.

**v1:** `scripts/ab-evidence-report.mjs` — a pure function
(`summarizeExperiment(registryEntry, assignmentLog, outcomeStores) ->
{effectSize, interval, n, verdict}`), unit-tested the same way
`scripts/playwright-json-summary.mjs` is (`tests/playwright-json-summary.test.ts`
is the template: pure logic extracted from the CLI wrapper specifically so
it doesn't need a slow end-to-end run to test). Shares the offline,
deterministic, no-LLM-in-the-numbers philosophy that
`scripts/clf-evidence-report.mjs` is understood to be pursuing for
classifier evidence (that script does not exist yet in this checkout —
confirmed via `find`/`grep`, nothing named `clf-evidence-report` anywhere
in this worktree — so this design tracks it as a sibling convention to
converge with if/when it lands, not a dependency). A companion
`.claude/skills/ab-experiment/SKILL.md` runbook: *define an experiment
(fill the registry entry) → let real traffic accumulate → run the report
script → read the verdict, labeled PILOT or RESULT per §1.4's n bar.*

**v2:** extend the existing `experiment-runner` panel (`docs/experiment-runner.md`
§5.2's widget registry already has `comparison-table`/`score-bars`/
`summary-cards` — reuse them, don't build new chart types) with a third
experiment *kind* alongside A/B-mode and autoresearch-mode:
**"in-place flag"** — same dashboard, same widgets, backed by the
assignment log + join in §1.3 instead of `spawnGoal` `RunRecord`s. An
AJ-visible registry tab lists every experiment (goal-spawn and in-place),
its status, and its verdict. UI-variant/theme experiments are noted as a
possible fourth kind but explicitly deferred (§1.1) pending a client
exposure-logging design.

### 1.6 Guardrails

**1. Experiments must never weaken verification integrity — variants are
an allowlist, not an open surface.**

`assignVariant`'s `lever` field (§1.2) is a closed union
(`"gateCacheMode" | "parallelReviewsEnabled"`), not an arbitrary env-var
name. A variant may only select between values a human has already
judged safe to ship as opt-in flags — `content`/`sha`, parallel/serial
review start. **An experiment definition must never be able to make
`verify[]` skip a step, alter `completionBar` filtering asymmetrically
between arms, or disable a review** — those are exactly the "skip a gate as
a variant" failure mode this guardrail exists to block, and they are
structurally impossible today because the lever union doesn't include
anything that touches step membership. When `VerificationPolicy`
(`docs/design/verification-policy-seam.md`) eventually ships, its
`gateRoles`/`reviewVerdictRubric` fields must **not** be added to the
lever union without a fresh safety review — those govern semantic
gate behavior (child-merge rewrite, pass/fail rubric), not a
performance/latency knob, and are a different risk class than
`gateCacheMode`/`parallelReviewsEnabled`.

`experiment-runner`'s goal-spawn mode already has an equivalent guardrail
worth calling out and reusing rather than reinventing:
**same-completion-bar filtering** (`docs/experiment-runner.md` §3.1) —
"runs are filtered by their workflow gate completion status
(`completionBar === 'passed'` by default). Incomplete or failed runs are
excluded from aggregate averages and presented separately." A flag
experiment's report script (§2) must apply the identical filter on both
arms symmetrically — comparing "content-mode hit rate on passed gates" to
"sha-mode hit rate including failed gates" would silently bias the
result.

**2. Cost ceilings.**

Goal-spawn experiments already have one: `projectCost` bounds spend before
launch (`docs/experiment-runner.md` §3.1), autoresearch mode requires a
hard cap (`maxIterations`/`maxWallClockMs`/`maxCostUsd`, §3.2). In-place
flag experiments ride on organic development traffic — they don't spawn
new goals, so there's no new spend to bound, but they should still have a
**soft unit cap** in the registry entry (e.g. "stop after 200 gate
signals or 14 days, whichever first" — both are already required fields
per §1.4 point 3's "fixed end condition") so an experiment can't silently
run forever, accumulating assignment-log entries for a lever nobody is
watching anymore.

**3. AJ-visible experiment registry.**

Every experiment, either kind, must have a registry entry (§1.5) that
exists **before** assignment begins. The v1 report script should refuse
to process an assignment-log file whose `experimentId` has no matching
registry entry — same fail-closed discipline
`resolveGateCacheMode`/`resolveVerificationPolicy` already apply to
malformed input (`docs/design/gate-step-cache.md` line 54-56,
`docs/design/verification-policy-seam.md` line 134-136). This is what
makes "no post-hoc cherry-picking" (the framing question's own phrase)
enforced by tooling rather than merely asked for in a design doc.

---

## 2. What this framework adds vs. what it reuses

| Piece | New or reused | Where |
|---|---|---|
| Goal-spawn fan-out, poll, collect | **Reused, unchanged** | `market-packs/experiment-runner/lib/engine.mjs` |
| `MetricExtractor` / `WidgetRenderer` registries | **Reused**, extended with new extractors | `market-packs/experiment-runner/lib/metrics.mjs`, `.../widgets.mjs` |
| Cost, gate, classifier, tool-permission telemetry | **Reused, unchanged** — zero new instrumentation | `cost-tracker.ts`, `gate-store.ts`, `context-trace-store.ts`, `tool-permission-audit-log.ts` |
| Experiment registry (id, hypothesis, lever, variants, minimum-n, end condition) | **New**, v0 = markdown/JSON file, v2 = UI tab | `.bobbit/state/experiments/registry.json` (proposed) |
| Assignment log for in-place flag experiments | **New** — the actual gap | `.bobbit/state/experiment-assignments/<id>.jsonl` (proposed) |
| `ExperimentOverrideResolver` / `assignVariant` | **New**, v1.5 only, at existing policy-leak call sites | `verification-harness.ts:3419`, `:4041` (call sites), new `experiment-override.ts` |
| Evidence/report script | **New**, pure + unit-tested, same shape as `playwright-json-summary.mjs` | `scripts/ab-evidence-report.mjs` (proposed) |
| Runbook | **New**, skill not tool group | `.claude/skills/ab-experiment/SKILL.md` (proposed) |

---

## 3. The first real experiment: `BOBBIT_GATE_CACHE` on Bobbit's own gates

This is the concrete "one real proof end-to-end" the staged plan should
produce first, and it needs only v0 — no new code.

**Why this one, not parallel-reviews or warm-pool:**

- `BOBBIT_GATE_CACHE=content` is shipped, real, opt-in (`verification-logic.ts`'s
  `resolveGateCacheMode`) — unlike the warm-pi-process-pool design
  (`docs/design/warm-pi-process-pool.md`), which is a spike with no
  implementation to measure yet.
- Bobbit's own `.bobbit/config/project.yaml` already declares real
  `cacheInputGlobs` for its Build/Type-check/Unit-tests steps (W3.1b,
  `docs/design/gate-step-cache.md` lines 117-139) — the precondition the
  gate-step-cache design's own A/B plan says it was "waiting on" (line 145)
  is already met.
- The flag is **deliberately not yet flipped on live traffic**
  (`docs/design/gate-step-cache.md` line 148: "that remains a separate
  operational decision") — this is a genuinely open question, not a
  rehash of an already-answered one.
- Every metric is already collected with a joinable key (§0.3) — hit rate
  from the `[verification][gate-cache]` log line's `keyKind`/`result`
  fields, wall-clock from `GateSignalStep.duration_ms`, cost from
  `session-cost-turns.json`.
- Unlike VER-07's synthetic benchmark, this experiment can run on **real
  Ralph-loop traffic** on this repo's own gates, immediately.

**How to run it at v0, this week, with no new code:**

1. Register: write `{id: "EXP-001-gate-cache", lever: "gateCacheMode",
   variants: ["sha", "content"], unit: "gateSignal", startTs: <now>,
   minimumN: 10, endCondition: "10 paired same-shape gate signals per arm
   or 14 days"}` into `.bobbit/state/experiments/registry.json` (or, at v0,
   literally a paragraph in a scratch doc — the content matters, not the
   format, yet).
2. Run window A: `BOBBIT_GATE_CACHE` unset (today's default, `sha`) for N
   real gate signals on this repo's own workflows. Every `GateSignal`
   already lands in `gates.json` with its `timestamp`, `commitSha`, and
   per-step `duration_ms` — no extra capture needed.
3. Run window B: `BOBBIT_GATE_CACHE=content`, same workflows, comparable
   commit-shape signals (e.g. both windows drawn from ordinary Ralph-loop
   iteration on `fable/*` branches, not one window during a mass-refactor
   spree).
4. Join by hand (or a scratch `jq` one-liner) on `gates.json`'s
   `commitSha`/`timestamp` against the registered window boundaries; pull
   the `[verification][gate-cache]` log lines for `keyKind`/`result` hit
   rate; pull `session-cost-turns.json` for the matching `sessionId`s'
   cost delta.
5. Report per §1.4: median wall-clock delta + a bootstrap interval, hit
   rate by `keyKind`, labeled PILOT if fewer than 10 paired signals per
   arm landed, RESULT otherwise. If content-mode's hit rate and safety
   hold up, this is the evidence
   `docs/design/gate-step-cache.md`'s own closing line ("If content mode's
   hit rate and safety hold up over real Ralph-loop traffic, consider
   flipping the default away from `sha`") is asking for.

A natural second experiment, once the v0 mechanics are proven here: **graduate
VER-07's pilot** — re-run `BOBBIT_PARALLEL_REVIEWS` on real (not synthetic)
gate traffic with the same registration discipline, turning "−42.8%,
n=3, mocked delays" into a number with a real interval on real reviews.

---

## 4. Staged, smallest-first implementation plan

1. **v0 — paperwork only, no code.** Write the registry entry format (a
   paragraph is enough) and run §3's `BOBBIT_GATE_CACHE` experiment on real
   traffic by hand. This alone tests whether the discipline (pre-registration,
   minimum-n, one stated analysis time) is usable before any tooling is
   built around it.
2. **v1a — `scripts/ab-evidence-report.mjs`.** Pure join+stats function,
   unit-tested against fixture `gates.json`/`session-cost-turns.json` rows
   and a fixture assignment/registry file — no real gateway needed to test
   it, same as `playwright-json-summary.mjs`. Wire it to read the v0
   registry format verbatim; no schema changes needed if v0's format was
   chosen to already be the machine-readable JSON, not prose.
3. **v1b — extend `experiment-runner`'s `MetricExtractor` registry** with
   the gate-cache/parallel-review extractors from §1.3, so goal-spawn
   experiments (already engine-complete) can also measure these levers when
   a goal-spawn experiment's treatment happens to set one of these env vars
   via `metadata`.
4. **v1.5 — `ExperimentOverrideResolver` + `assignVariant`.** Only after
   v1a has proven the report/registry plumbing on real time-windowed data.
   Adds concurrent per-unit assignment at the two call sites
   `verification-policy-seam.md` already identified, gated on a
   byte-identical-when-inactive pinning test (mirroring that doc's own V1-V4
   slice discipline). This is the step that removes the time-window
   confound — worth doing, but only once §3's simpler mechanics are proven
   to produce a usable result.
5. **v2 — UI.** Extend the `experiment-runner` panel with the "in-place
   flag" experiment kind and an AJ-visible registry tab. Revisit UI-variant
   (theme) experiments only as a follow-up design once a client
   exposure-logging substrate is scoped — not bundled into this v2.

Each step is independently shippable; step 1 alone, run this week, already
answers the concrete question `docs/design/gate-step-cache.md` left open.

---

## 5. Explicit sequencing against in-flight work

- **`docs/design/verification-policy-seam.md` (S8, in-flight design, not
  yet code).** v1.5's `assignVariant` call sites are the *same two lines*
  that design's V2 slice touches (`verification-harness.ts:3419` for
  `resolveGateCacheMode`, `:4041` for `isParallelReviewsEnabled`). Land
  v1.5 **after** that doc's V0-V2 slices, so `assignVariant` composes with
  the already-established `env var > policy default` precedence instead of
  needing its own migration. If v1.5 needs to land first, it must only add
  the experiment lookup *ahead of* today's `env var ? resolveGateCacheMode(env)
  : "sha"` expression, never restructure it — same "additive, byte-identical
  when inactive" discipline that seam doc requires of its own slices.
- **`docs/design/self-improvement-loop.md`.** That design's "A-B mechanics"
  section (lines 109-128) proposes recording experiment id/variant/flags/
  workflow/goal-session-ids per goal run for its own review pipeline. This
  document's registry (§1.5) and assignment log (§1.2) are the same
  artifact shape; if both designs proceed, converge on one registry format
  rather than shipping two.
- **`docs/design/classifier-framework-status.md` Wave 5 (`gate-risk-classifier`)**
  is a live precedent for "observe-only evidence gathering before any apply
  decision" — the same posture this document's v0/v1 recommend for flag
  experiments (measure honestly before flipping a default). No file overlap
  with this document's proposed changes.
