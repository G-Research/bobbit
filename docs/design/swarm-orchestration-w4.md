# SWARM-W4 — token-efficient topologies (design, nothing shipped)

Status: **design only** · Wave 4 of the SWARM lane
(`~/Documents/dev/bobbit-fable-refactor/design/swarm-orchestration.md`, §3/§4/§9,
§11 Wave 3/4). Rides on SWARM-W0–W3 (shipped: `docs/design/swarm-orchestration-w0.md`
through `-w3.md`) and on the Classifier Framework lane's shipped seam
(`docs/design/classifier-framework-status.md`). Zero code in this PR — this
document specifies what SWARM-W3's honest gap ("no synthesizer, no classifier
`propose` wiring... blocked on CLF's propose seam") actually needs to close,
now that CLF's real state is knowable in detail rather than "harness only."

## 0. Where we actually are — restated so the rest of this doc has a floor

AJ's question: is swarm optimal for performance, token use, parallelism, and
wall clock? **Honest split verdict, unchanged by this doc:**

- **Wall-clock / parallelism: yes.** SWARM-W1's hard governor
  (`SwarmGovernor`: per-node token-budget abort/hard-kill, straggler
  wall-clock hard-kill), SWARM-W2's restart-durable re-arm, and SWARM-W3's
  scheduler-hook fix (straggler clock anchored to actual team-start, not
  request time) together mean a best-of-N fan-out already runs at **1×
  latency** with a governor that can always converge (barrier always fires,
  even across a restart).
- **Token use: no.** The **only** topology that exists in production is
  best-of-N fan-out (`swarm-best-of-n.ts`), and it is defined by running
  **N full, independent, redundant attempts at the same task** — its token
  cost is a straight multiple of a single attempt, with no lever to cut that
  multiple except choosing a smaller N. Every other pattern the original
  design sketched (§4: orchestrator-worker, judge-panel, loop-until-dry) and
  every synthesizer/decomposition idea (§3, §11 Wave 3) was **explicitly
  deferred**, gated on the classifier framework's `propose` seam landing.

**What actually shipped on the CLF side since that gate was written**
(`docs/design/classifier-framework-status.md`, current head = Wave 2.5):
`Decision<TChoice> = {kind:"select", choice}|{kind:"abstain"}` — **select/abstain
only**, no `mutate`/no `veto` (Wave-5-gated per `decision-types.ts`'s own
header), five registered `DecisionPoint`s (`user-prompt-submit`,
`agent-prompt`, `tool-call`, `turn-boundary`, `compaction` —
`decision-types.ts`), and exactly two real classifiers, both **observe-mode
biased**: the F14 thinking-router (observe-only, records-never-applies) and
the Wave-2.5 tool-approve heuristic (a deterministic 0-token rule table,
enforce-gated behind `BOBBIT_CLF_TOOL_APPROVE=enforce`, `deny`-only
auto-apply). **There is no `propose` kind in the shipped code at all** — the
master classifier-framework design doc's §4 union lists `propose
{proposalType, spec}` as a *planned* Wave-4 kind ("dynamic creation →
human-gated seam (kind kept; plumbing deferred)"), but nothing in
`decision-types.ts` or `LifecycleHub` implements it, and there is no
`goal-create` interception point in the shipped `DECISION_POINTS` array
either (confirmed: `grep -rn "goal-create" src/` — the only hits are
unrelated E2E test comments). A parallel CLF-advancement lane is currently
building thinking-router **apply-mode** (behind a 3-state flag) and an
**observe-only model-selection classifier** — neither one is swarm-specific,
but §3.3 below shows exactly where SWARM should plug into the second one.

**The load-bearing consequence for this doc:** SWARM-W4 does **not** need to
wait for CLF's `propose` kind to ship in the form the master design doc
originally imagined (rate-limited/deduped dynamic creation, per
`classifier-framework.md` §10 Wave 4). Every topology below is designed so
that the classifier's job is a plain **select-or-abstain choice of topology**
— structurally identical to what thinking-router and tool-approve-heuristic
already do — layered on top of hand-wired, human-gated execution machinery
that works today with **zero** classifier involvement. §3 spells out the
minimal, additive seam this actually needs.

## 1. Topology menu — overview

| Topology | New core mechanism needed | Token cost vs. solo (C) | Wall-clock | Ships without CLF? |
|---|---|---|---|---|
| **best-of-N** (shipped, W1–W3) | none | `N×C` | 1× (parallel) | yes — shipped |
| **(c) best-of-N + early-kill** | per-candidate incremental verify + kill-on-first-pass | `≈ E[k]×C`, `E[k] ≤ N` (§1.3) | 1× (unchanged — parallel, just shorter tail) | **yes** |
| **(d) speculative-small-first** | sequential cheap→expensive escalation | `C_cheap + (1−q)×C_expensive` | 1×–2× **sequential** (worse than best-of-N's parallel 1×) | **yes**, ties into the model-selection classifier for the *choice of cheap tier* |
| **(a) plan-synthesizer** (N cheap plans → synthesis → one build) | cheap planning-only fan-out + a reduce step + a *pre-build* human gate | `N×Cp + Cs + 1×C` (§1.1) | ≈1.1–1.3× (two sequential stages after a parallel plan phase) | **yes** for the hand-wired form; topology *choice* benefits from CLF later |
| **(b) orchestrator-worker** | decompose call + disjoint-shard auto-merge (existing subgoal path) + synthesis-role | `C_decompose + Σ C_shard,i + C_synth`, **NOT** `M×C` (§1.2) | ≈1× if shards are balanced (parallel), but Anthropic's own anchor number is ~15× tokens for +90% breadth coverage on genuinely parallel research — a *quality* trade, not a token-savings one, vs. **solo** | **yes** for the hand-wired form; needs a `mergeChild` change (highest risk in this doc) |

All four are designed to run **hand-wired** first (caller/config supplies the
topology, exactly like `POST /api/goals/:id/swarm/best-of-n` does today) —
never gated on the classifier. The classifier's job (§3) is choosing *among*
these, once they exist; it is a second, independent, strictly additive
consumer, not a precondition to shipping any of them. This mirrors the CLF
lane's own repeated pattern (ship the harness/mechanism dark or hand-wired,
ship the real classifier as a separate, later PR — CLF-W0b→W1b,
CLF-W2→W2.5).

### 1.1 (a) Plan-synthesizer — N cheap plans → one synthesis → single build

**Important scoping note, stated up front for honesty:** the master design
doc's own "plan-synthesizer" (§3, §11 Wave 3) is a narrower, different thing
— a *deterministic router* that picks a topology plus an LLM that
*decomposes* a goal into disjoint sub-questions for orchestrator-worker
("router picks the topology; an LLM is used only to decompose into disjoint
sub-questions; the synthesizer never emits arbitrary DAGs" — §3). It does not
describe generating N full candidate *solutions* and merging them. The
pattern this section specifies — **fan out N cheap, build-free planning
passes, synthesize them into one plan, then commit to exactly one expensive
build** — is a genuinely different, new pattern being specified for the
first time here, chosen because it is the direct token-efficient answer to
best-of-N's core defect (paying for N full builds to get diversity). To avoid
colliding names in code, this should be registered as its own pattern id
(e.g. `plan-fan-in`), distinct from whatever the master doc's
decompose-only synthesizer eventually becomes.

**Mechanism**, built on existing primitives:
1. Fan out N siblings via the **same** `createBestOfNSwarm`-shaped call
   (same `swarmGroup` tag, same governor registration, same terminal
   barrier), but each sibling's prompt is planning-only ("propose an
   approach; do not modify files") and each sibling's governor budget
   (`tokenBudgetPerNode`) is set to a small fraction of a normal build's —
   these are genuinely cheap, short, mostly-single-turn sessions, not full
   agentic builds. Call this cost per plan `Cp`.
2. Once the barrier fires (unchanged mechanism — `SwarmGroupStore`'s
   `barrierFired`), a **synthesis step**: one new `spawnRole` node (not
   swarm-tagged) that reads the N *distilled* plan outputs (reuse
   `SwarmArtifact.output`, already populated via
   `SessionManager.getSessionOutput` — no new transcript reader, per
   SWARM-W0's own precedent) and produces ONE merged plan. Cost `Cs`.
3. A **new pre-build human gate** (§4.4) confirms the synthesized plan.
4. Exactly one build child goal executes the confirmed plan — cost `C`, the
   same as a single solo attempt.

**Token cost model:** `total ≈ N×Cp + Cs + 1×C`. Grounding `Cp`/`Cs` against
measured numbers: a planning-only turn has no tool-call cascade and no
multi-turn build loop, so it should land close to `promptProfile:
"narrow-worker"`'s already-measured baseline reduction (PR #155: narrow
delegates drop ~133 tokens of fixed overhead plus avoid the "unbounded
cascade" — up to ~21K tokens per F19's measurement — that a
team/goal-tool-bearing spawn can otherwise accumulate); take `Cp ≈
0.1×C` and `Cs ≈ 0.2×C` as an illustrative, conservative estimate (a
single-turn reduce call over N short summaries, no tool loop). For **N=5**
(the largest fan-out already exercised by `tests/swarm-w1-scheduler-deadlock.test.ts`):
`total ≈ 0.5C + 0.2C + 1C = 1.7C`, vs. best-of-N's `5C` for the same N — **a
~66% token reduction** while still sampling N independent approaches before
committing real build tokens. The corresponding real-world anchor for N: the
gate-verify reviewer fan-out already runs 3–4 reviewers per gate (#157's
measured finding) — plan-fan-in at that same N costs `≈1.5C`, i.e. barely
more than one solo attempt, in exchange for picking the best of 3–4 sampled
approaches.

**When to choose:** the task has multiple plausible *approaches* (not just
noisy execution variance) and the cost of committing to the wrong approach
mid-build is high — i.e. exactly the situation best-of-N is wasteful for
today, because it pays full build cost N times to discover that.

### 1.2 (b) Orchestrator-worker — relate to existing team/goal machinery, don't invent one

The critical design choice: **do not reuse `swarmGroup`'s merge-suppression
primitive** (SWARM-W0 §3) for this topology. That primitive exists
specifically because best-of-N siblings are *competing* candidates for the
*same* task — their branches must never auto-merge, only one can win.
Orchestrator-worker's workers are the opposite: **disjoint** shards of one
task, and disjoint children auto-merging into the parent as they complete is
**already exactly what ordinary (non-swarm) nested subgoals do today** —
`GoalManager.mergeChild` already runs a real git merge, unconditionally,
for any child without a `swarmGroup` tag. Orchestrator-worker is therefore
much closer to "ordinary subgoals plus a decompose step and a synthesis step"
than to "best-of-N with more nodes."

**Mechanism:**
1. One decompose call (cheap, single LLM call, no tool use) turns the goal
   into 3–5 disjoint sub-question specs — the master design doc's own §3
   scoping already nails this down: *"an LLM is used only to decompose into
   disjoint sub-questions... never emit arbitrary DAGs."* Cost `C_decompose`,
   small.
2. Each worker is spawned as an **ordinary nested subgoal** (not
   `swarmGroup`-tagged in the pick-best sense) — it inherits the structural
   recursion cap unconditionally regardless (SWARM-W0's
   `subgoalsAllowed:false`/`maxNestingDepth:0` forcing is keyed on
   `swarmGroup` being *set*, so §1.2.1 below proposes still tagging these for
   barrier/governor tracking, just with different merge semantics — see
   below). Each worker merges its own disjoint changes into the parent
   **as it completes**, via the existing, unmodified `mergeChild` git-merge
   path. Total worker cost is `Σ C_shard,i` — importantly this is a
   **partition of the total work**, not `M` redundant copies of the whole
   task, so it is bounded by (and, on a well-decomposed task, close to) a
   single solo attempt's total token count, **not** `M×C`.
3. Once every worker is terminal (barrier — see §1.2.1), a synthesis role
   (master doc §5 item 3: "one `spawnRole` depending on all leaves; a model
   call only for the reduce step, over distilled artifacts") produces the
   final coherent summary/PR description over the now-already-merged
   changes. Cost `C_synth`, one call.

**Token cost model:** `total ≈ C_decompose + Σ C_shard,i + C_synth`. Two
honest comparisons, not one:
- **vs. best-of-N:** cheaper whenever the task is genuinely decomposable
  (shards are disjoint fractions, not full duplicate attempts) —
  `Σ C_shard,i < M×C` by construction.
- **vs. solo:** more expensive, potentially a lot more. The master design
  doc's own anchor number applies here unmodified: Anthropic's
  orchestrator-worker result was **"+~90% on breadth-first research at ~15×
  tokens"** vs. a single agent. This topology is a genuine token-**for**-
  coverage trade on breadth-limited tasks whose total information exceeds
  one context window (master doc §4's own gate: "only wins when the goal is
  genuinely parallel AND total info exceeds one context window") — it is
  **not** a token-reduction lever the way (a) and (c) are, and this doc
  should not pretend otherwise.

**When to choose:** genuinely parallel, decomposable work (breadth-first
research/audit-style goals — several files/areas that don't interact) where
one context window cannot hold the whole problem. Never for a task with a
single coherent solution path — that is what best-of-N or plan-fan-in are
for.

#### 1.2.1 The one load-bearing new mechanism: `reconcileMode`

To keep the barrier/governor/UI machinery shared across best-of-N and
orchestrator-worker rather than forking a parallel implementation, add one
field to `SwarmGroupRecord` (`swarm-group-store.ts`):

```ts
reconcileMode?: "pick-best" | "merge-all"; // default "pick-best" — byte-identical to today when absent
```

The **only** behavior conditioned on it is inside `GoalManager.mergeChild`'s
existing SWARM-W0 suppression check
(`if (child.swarmGroup && !opts?.forceIntegrateSwarmWinner)` →
`goal-manager.ts:860`): change it to also allow through when
`group.reconcileMode === "merge-all"`, i.e. a merge-all group's children
merge exactly like ordinary non-swarm subgoals, live, as each completes —
**no new call site, no new escape-hatch flag**, one added condition at the
existing single choke point. Everything else — structural recursion cap
(unconditional on `swarmGroup` being set, SWARM-W0), governor registration,
terminal barrier + artifact capture (`notifyChildTerminal`'s
`_captureSwarmArtifactIfTagged`, gated only on `swarmGroup` being set, not on
`reconcileMode`), restart-resume (SWARM-W2), straggler-clock-on-actual-start
(SWARM-W3) — is **already reconcileMode-agnostic** and needs zero changes.
This is the smallest possible extension of the shipped primitives that makes
orchestrator-worker a first-class citizen of the same barrier/governor
infrastructure best-of-N already uses, rather than a parallel system — this
directly answers the task's "relate to the existing team/goal machinery"
requirement.

This is also, honestly, the **highest-risk single change in this whole
document**: `mergeChild` is the one function all three existing auto-merge
callers (`nested-goal-routes.ts` integrate-child, both
`runSubgoalStep` paths in `verification-harness.ts`) already funnel through,
and it is exactly the kind of shared choke point SWARM-W0/W1 both flagged as
needing careful, additive-only changes with byte-identical-default pins. See
§6's staged plan — this is scheduled last and flagged for a judgment lane,
not a codex lane.

### 1.3 (c) Best-of-N + early-kill — the cheapest incremental win

This is explicitly the smallest lift, per the task's own framing: the
governor already has a hard-kill primitive
(`SwarmGovernor.hardKillSwarmNode` → `VerificationHarness.hardKillSwarmNode`
→ `SessionManager.terminateSession`'s SIGTERM→3s→SIGKILL backstop, already
used for budget/straggler kills) — this topology adds exactly one new
*trigger* for that same call, and one relaxation of an existing gate.

**What has to change, precisely:**
1. **`verifyBestOfNGroup` currently hard-requires the full barrier**
   (`swarm-verifier.ts`: `if (!group.barrierFired) return { outcome:
   "not-ready", scores: [] }`). Early-kill needs verify to run on a *single*
   newly-`done` candidate as soon as it lands, not only once every sibling is
   terminal — this is a real, if small, change to an existing invariant
   (`SwarmVerifyOutcome`'s `"not-ready"` semantics), not purely additive, so
   it needs its own review pass (see §6).
2. **On the first candidate that verifies `passed: true`**, iterate the
   group's `expectedSiblingIds` still not present in `artifacts` (i.e. still
   running) and call `hardKillSwarmNode` on each — reusing the exact
   existing kill path, just from a third trigger source (today: budget
   breach, wall-clock breach; new: "a sibling already won").
3. Each early-killed sibling still goes through the **existing**
   `notifyChildTerminal(goalId, "killed")` → barrier-capture path, so the
   barrier still converges normally and no new terminal-state plumbing is
   needed.

**Token cost model:** let each sibling cost `≈C` if run to completion, and
let `p` be the per-sibling probability of passing the deterministic verifier
(independent of which sibling, for a rough model). If siblings are verified
in completion order, the position of the first pass, `k`, has `E[k] ≈ 1/p`
(capped at `N`). Siblings that finish before the winner is found have
already paid their full cost regardless (verify can only run on a *terminal*
`done` candidate — early-kill cannot save a completed sibling's own cost, only
the *remaining* budget of siblings still in flight when the winner lands).
Expected total cost `≈ E[k]×C` vs. best-of-N's flat `N×C` — for the same
concrete N=5 gate-verify-scale example with, say, `p=0.4` (a plausible
pass-rate for a moderately hard task), `E[k]≈2.5`, i.e. **≈50% token
reduction** vs. naive best-of-N with the *identical* fan-out and *identical*
final pick quality (the winner is still the best passing candidate — nothing
about correctness changes, only which siblings get to finish). The win
shrinks toward zero as `p→0` (a very hard task where almost every sibling
fails needs to wait through nearly all of them anyway) and is largest when
`p` is moderate-to-high — the exact regime where best-of-N is arguably
over-provisioned today.

**When to choose:** this should essentially always be preferred over plain
best-of-N once built — it strictly dominates it (same fan-out, same pick
quality, weakly less total token spend, same 1× wall-clock since the winner
was going to finish at the same time regardless). There is no real
"when-to-choose" tradeoff here; it should become the *default* execution
mode for the existing best-of-N pattern, not a separate opt-in topology.

### 1.4 (d) Speculative-small-first — ties to the model-selection classifier

**Mechanism:** one attempt with a cheap model/low effort tier; on
deterministic-verify failure, escalate to one full attempt with the next
tier up. No fan-out, no `swarmGroup` tag needed for the common (unescalated)
case — it degenerates to today's ordinary solo child goal. Only on escalation
does a second attempt exist, and it is **sequential**, not concurrent.

**Token cost model:** let `q` = probability the cheap attempt passes
verify outright, `C_cheap` = cost of the cheap attempt, `C_expensive` = cost
of the escalated attempt. Expected cost `= C_cheap + (1−q)×C_expensive`.
Illustrative numbers: cheap tier ≈0.3× the token count *and* a materially
lower per-token price than the expensive tier, so `C_cheap ≈ 0.3×C`; with
`q=0.6` (a plausible "the cheap tier gets it right most of the time"
assumption for a well-scoped task): expected cost `≈ 0.3C + 0.4×C = 0.7C` —
**cheaper than a single always-expensive solo attempt**, let alone
best-of-N. The catch is wall-clock: unlike every fan-out topology above,
this one is **sequential by construction** — the escalated (40%) case pays
`C_cheap`'s wall-clock *plus* `C_expensive`'s, worse than best-of-N's 1×
parallel latency. This is a genuine token-vs-latency trade, the mirror image
of the other three topologies.

**Ties to the CLF model-selection classifier directly:** the *choice of
which cheap tier to try first* is exactly the decision the CLF-advancement
lane's parallel observe-only model-selection classifier is being seeded to
make (per the dispatch note: "model-selection classifier OBSERVE-ONLY...
accumulating would-have-chosen data"). Speculative-small-first should
**consult that same classifier's decision** for its first-attempt tier
rather than inventing a second, competing model-choice mechanism — one
signal, two consumers (an ordinary single-attempt turn, and this topology's
first attempt), which is exactly the kind of reuse §3 below argues for.

**When to choose:** tasks with a clear, cheap-model-tractable common case
and a well-defined, cheap deterministic verify gate to catch the tail case —
the opposite profile from plan-fan-in/orchestrator-worker, which assume the
task itself is hard to plan or too broad for one context window.

## 2. What the classifier actually decides — and what it doesn't

Per the master design doc's own critique-mandated scope narrowing (§3):
*"topology selection over a fixed pattern set is a deterministic router...
does not need an LLM."* Nothing above needs a model call to choose between
topologies — the classifier's entire job is a **0-token, deterministic
mapping** from goal-creation-time signals (does a deterministic verify
command exist; is the task described as multi-file/breadth-first; is a
fan-out count already requested; has this goal's project seen a recent
speculative-escalation for a similar prompt) to a topology label. This keeps
it structurally identical to the *already-shipped* thinking-router and
tool-approve heuristics — no new "model-backed classifier" infrastructure is
needed for topology choice itself.

## 3. The CLF propose contract — exactly what SWARM needs, named precisely

### 3.1 What exists today (recap, precise)

`decision-types.ts`: `DECISION_POINTS = ["user-prompt-submit",
"agent-prompt", "tool-call", "turn-boundary", "compaction"]`;
`Decision<TChoice> = {kind:"select", choice:TChoice, confidence?, rationale?}
| {kind:"abstain"}`; `decisionKey(point, kind) = "${point}::${kind}"`, used
as the allow-list registration key (`LifecycleHub.allowDecisionPoint`) and
consulted via `LifecycleHub.registerDecisionClassifier`/`dispatchDecision`.
There is **no `goal-create` point** and **no `propose` decision kind** in
this shipped model — the master classifier-framework design doc's `propose
{proposalType, spec}` union member (§4) was never implemented; it remains
"kind kept; plumbing deferred" exactly as that doc says.

### 3.2 The minimal named extension SWARM-W4 needs

**One new `DecisionPoint`:** `"goal-create"`, added to `DECISION_POINTS`.
This is literally the exact point the master design doc's own §13 open
questions flags as missing ("when STR-01's route registry lands (needed to
make `goal-create` a first-class interception point, via the EXT-02 derived
point set — never a hand-added hook)"). **Recommendation: do not wait for
STR-01.** STR-01 (route-registry-derived interception points,
`handleApiRoute` → registry) is a much broader, slower-moving CLF/platform
initiative unrelated to swarm's narrow need; hand-adding one named point now
— exactly the same way CLF-W2 hand-added `(tool-call, tool-approve)` without
waiting for a generic tool-registry abstraction — is consistent with the
CLF lane's own established practice of shipping small, explicitly-named
extensions to the point/kind space rather than blocking on the generalized
version. Flag it in a comment for STR-01 to later subsume, exactly as
`decision-types.ts`'s own header already does for other deferred
generalizations.

**One new decision kind at that point:** `"swarm-topology"`.

```ts
export type SwarmTopologyChoice =
	| { topology: "solo" }
	| { topology: "best-of-n"; fanOut: number; earlyKill: boolean }
	| { topology: "plan-fan-in"; fanOut: number }
	| { topology: "orchestrator-worker"; maxShards: number }
	| { topology: "speculative-small-first"; cheapModel: string };

export interface SwarmTopologyArg {
	goalId: string;
	/** The prompt/spec text the goal was created with — same visibility class as tool-call's arg, never widened. */
	spec: string;
	/** Whether the caller already supplied a deterministic verify command — a strong topology signal (§1's whole cost model assumes one exists). */
	hasVerifyCommand: boolean;
	/** Caller-requested fan-out, if any — present when a human/orchestrator already picked one explicitly. */
	requestedFanOut?: number;
}
```

This is a plain `select(choice: SwarmTopologyChoice) | abstain` at
`decisionKey("goal-create", "swarm-topology")` — **no new Decision-union
variant needed.** The master design doc's `propose{proposalType, spec}` kind
was conceived for *dynamic creation* generally (rate-limited/deduped,
Wave-4-only, still unbuilt); a swarm topology pick is narrower and simpler
than that: it never creates anything by itself, it only labels an
already-human-or-config-triggered goal with a recommended execution
strategy. Reusing the plain `select`/`abstain` shape that tool-approve and
thinking-router already use — rather than waiting for `propose` to exist in
its full designed form — is the whole reason SWARM-W4 does not need to block
on CLF Wave 4.

### 3.3 Observe-mode-first path (mirrors CLF's own two-step pattern exactly)

1. **Harness-only** (mirrors CLF-W2's first slice): add `"goal-create"` to
   `DECISION_POINTS`, `allowDecisionPoint("goal-create", "swarm-topology")`
   at gateway construction, **register zero classifiers**. Topology stays
   100% caller-supplied (REST body / config), exactly SWARM-W1's existing,
   unchanged behavior ("no classifier `propose` wiring — topology is
   caller-supplied via REST body, never LLM-decided"). Byte-identical,
   pinned the same way CLF-W2's zero-classifier-abstain invariant is pinned.
2. **Real heuristic, observe-mode** (mirrors CLF-W2.5): a deterministic,
   0-token rule table (signals → `SwarmTopologyChoice`) registered for
   real, `mode=observe` — every consult is recorded to the transparency
   panel / decision trace, **never** overrides the caller-supplied topology.
   This accumulates exactly the evidence CLF's own promotion criterion
   requires (see §3.4): would the classifier's pick have matched what was
   actually chosen, and (once the topology ran) how did the outcome compare
   on cost/verify-pass-rate.
3. **Enforce, later, AJ-gated** — only once observed data clears the bar.

### 3.4 Enforce criteria — lighter than tool-approve's, for a specific reason

CLF's own stated promotion criterion (`classifier-framework.md` §12): *"no
ground-truth label today → use observe-mode user-override rate / verify-gate
outcome / operator sign-off — do **not** imply automatic promotion."* Applies
unmodified here. But swarm-topology's **auto-apply blast radius is narrower
than tool-approve's `allow` verdict**, because every non-solo topology this
doc specifies is *already* separately human-gated at the integration step
(§4, unconditionally preserved) regardless of how the topology was chosen —
a wrong topology auto-pick wastes tokens on the wrong execution strategy, it
cannot itself smuggle unreviewed code past the gate the way an unwarranted
tool `allow` could. So: **no CQ-03 operator-confirmation permit is needed to
auto-apply a topology *choice*** the way one is required for tool-approve's
`allow` widening. The bar that *does* apply, directly from the master
design's MUST-FIX #7 ("bound auto-approve-under-budget strictly below solo
cost, or drop it"): **enforce-mode may only auto-select a topology whose
worst-case token cost is bounded at-or-below a solo attempt's** — which
cleanly permits auto-enforcing `solo` and `speculative-small-first` (bounded
by construction per §1.4's cost model) and rules out auto-enforcing
`best-of-n`, `plan-fan-in`, or `orchestrator-worker` (all cost more than
solo in the worst case) without an explicit human/config opt-in regardless
of classifier confidence. This is a stricter, swarm-specific enforce rule
layered on top of CLF's generic promotion criterion, not a replacement for
it.

## 4. Human-gate preservation — the hard constraint, per topology

SWARM-W1's human-gate mechanism (unchanged, reused verbatim everywhere
below): `mintOperatorConfirmation({purpose, binding}, opts)` /
`consumeOperatorConfirmation(token, {purpose, binding})`
(`operator-confirmation.ts`) — a one-shot token, TTL-bounded, minted only for
a caller `authorizeChildrenMutation` classifies as `"human-cookie"` (never a
team-lead/agent-originated caller), bound via `stableConfirmationBinding` to
an opaque hash of the specific decision it authorizes. Today's binding is
`{swarmGroup, winnerGoalId}`. **Every topology below must mint/consume this
same primitive before any real git integration happens; only the `binding`
payload's shape changes.**

| Topology | What gets gated | Binding payload | Mechanism reused |
|---|---|---|---|
| **best-of-N** (shipped) | pick-one-winner integrate | `{swarmGroup, winnerGoalId}` | `mergeChild(..., {forceIntegrateSwarmWinner:true})` — unchanged |
| **best-of-N + early-kill** | identical — early-kill only changes *when* siblings die, not the integrate step | `{swarmGroup, winnerGoalId}` | unchanged, verbatim |
| **plan-fan-in** | **two** gates: (1) NEW — confirm the *synthesized plan* before the expensive build spends any tokens; (2) unchanged — confirm the single build's result before integrating | (1) `{swarmGroup, phase:"plan", planHash}` (2) `{swarmGroup, winnerGoalId}` where `winnerGoalId` is simply the sole build child | (1) new mint/consume call, same primitive, gates the build's *start*, not just its integration — genuinely more protective than today's post-hoc-only gate; (2) `mergeChild(..., {forceIntegrateSwarmWinner:true})`, unchanged |
| **orchestrator-worker** (`reconcileMode:"merge-all"`) | confirm the **whole shard set + synthesis**, not a single winner — there is no `winnerGoalId` | `{swarmGroup, mode:"merge-all", synthesisGoalId}` | workers already auto-merged individually via the *unmodified* `mergeChild` non-swarm path (§1.2.1) — nothing left to gate there; the new gate is on **accepting the synthesis role's summary as final**, using the *same* mint/consume primitive with a new binding shape, not a new mechanism |
| **speculative-small-first** | only the **escalation** (2nd attempt) — the common, unescalated case is a plain solo goal, ungated exactly like today's solo path | `{goalId, escalatedFrom: attempt1GoalId}` | new, lightweight — see §3.4's enforce-bound: auto-escalate is only permitted when the classifier's own bound already guarantees expected cost ≤ solo; outside that bound, gate it like the others |

No topology gets a git-mutating integration step that bypasses
`mergeChild`'s existing choke point or an operator-confirmation token check —
the two invariants (single choke-point merge, one-shot human-cookie-only
token) survive every row in this table unmodified in mechanism, only varied
in binding payload.

## 5. UI/UX gaps against the shipped W3 surface

SWARM-W3 shipped exactly one UI shape: an aggregate governor strip
(`renderSwarmGovernorStrip`) plus one row per sibling
(`renderSwarmSiblingRows`: title, live/terminal state, verify verdict,
winner badge) — built around the invariant "every sibling is a peer,
same-prompt candidate competing for one winner." Every topology in this doc
except best-of-N-early-kill breaks that invariant somewhere. Per the task's
explicit instruction, the increments below are scoped to the **smallest
useful addition**, not a graph-view epic (the master design doc's §8/§11
Wave 5 already explicitly defers graph/topology views to scale-driven later
work — nothing here should reopen that).

- **best-of-N + early-kill:** the existing sibling-row state vocabulary
  (`done`/`failed`/`killed`) already covers an early-killed sibling — it *is*
  `killed`. The one real gap: today `killed` reads as "budget/timeout
  failure," which would be misleading for a deliberate optimization. Smallest
  increment: one optional field on the artifact/row, e.g. `killReason?:
  "governor-budget" | "governor-wallclock" | "superseded"`, rendered as a
  one-word suffix ("killed (superseded)") — no new row shape, no new
  endpoint, reuses the exact rendering path W3 already built.
- **plan-fan-in:** the plan-phase siblings' "artifact" is plan *text*, not a
  verifiable build — they have no meaningful verify verdict. Smallest
  increment: render the existing per-sibling rows unchanged for the N
  plan-phase siblings (state=done, no verdict column — already handled,
  since verdict only renders "once `/verify` has run" per W3's own
  conditional), plus **one new row kind**, `synthesis` (state:
  pending→done, no verify verdict, shows nothing but "synthesizing plan..."
  → "plan ready"), plus the eventual single build child rendering as an
  ordinary (non-swarm) goal row it already would today. Three row *states*
  reusing one existing row component — not a new view.
- **orchestrator-worker:** two gaps. (1) Worker titles should show which
  shard/sub-question each owns — this needs **no UI change at all**, since
  goal titles are freely settable at creation time (`createBestOfNSwarm`'s
  `title` + " (candidate N)" convention just needs an orchestrator-worker
  analogue that uses the shard description instead of a candidate number).
  (2) The strip's language ("pick best passing candidate," a winner badge)
  is wrong for `reconcileMode:"merge-all"` — there is no losing sibling.
  Smallest increment: branch the strip's copy and button label on the
  group's `reconcileMode` (already a stored field, §1.2.1) — "Confirm
  merge" instead of "Confirm winner," and a per-row "included in merge"
  badge (every terminal `done` worker) instead of a single winner badge.
  Pure copy/conditional-class change on the existing component, zero new
  endpoints.
- **speculative-small-first:** the opposite problem — this topology usually
  has **no** governor strip at all (a single, non-`swarmGroup`-tagged solo
  goal in the common case), so W3's entire per-group UI is simply absent,
  correctly. The one real gap is on **escalation**: today nothing visually
  links a retried attempt to the one that failed its verify gate — it would
  render as two unrelated goal cards. Smallest increment: a single
  breadcrumb badge on the second goal's card, "escalated from `<goalId>`" —
  not a strip, not a swarmGroup tag, no barrier/governor involvement at all
  (there is nothing to converge; it's sequential, not concurrent).

## 6. Staged plan — smallest-first, effort-estimated, lane-tagged

| Wave | Item | Effort | Depends on | Lane |
|---|---|---|---|---|
| 4.0 | Apply `promptProfile:"narrow-worker"`/`"reviewer"` (already-shipped, PR #155) consistently to every swarm-sibling spawn call site, across all topologies below — a pure wiring fix, zero new mechanism, immediate ~19%/~133-token-plus-cascade savings per spawn, multiplicatively N times | XS | nothing | **codex-lane** — mechanical, has a byte-count test oracle |
| 4.1 | Best-of-N + early-kill (§1.3) — relax `verifyBestOfNGroup`'s barrier gate to allow per-candidate verify; wire the kill-on-first-pass trigger into the existing `hardKillSwarmNode` path | S–M | 4.0 | **judgment lane** for the verify-gate semantics change (touches `SwarmVerifyOutcome`'s existing `"not-ready"` invariant — needs a real review, not a mechanical patch); the kill-wiring itself is codex-lane-able once the trigger contract is specified |
| 4.2 | CLF seam extension (§3.2): add `"goal-create"` to `DECISION_POINTS`, `allowDecisionPoint("goal-create","swarm-topology")`, zero classifiers registered | XS | nothing (parallel to 4.1) | **codex-lane** — directly copies the CLF-W2 harness-only PR's shape; **must be sequenced with the CLF-advancement lane** to avoid two lanes editing `DECISION_POINTS` concurrently — flag this collision risk explicitly at dispatch time |
| 4.3 | Topology-choice heuristic classifier, observe-mode (§3.3 step 2) — **shipped with narrow v1 table: only `requestedFanOut` + `hasVerifyCommand`; select best-of-N only when both fan-out and verifier are present** | S | 4.2 | codex drafts against the tool-approve-heuristic.ts/thinking-router-classifier.ts precedent; **judgment lane reviews the rule table itself** (exactly the kind of review that caught CLF-W2.5's File-System-group-tightening gap) |
| 4.4 | Speculative-small-first (§1.4), hand-wired, no classifier dependency for execution (only for *which* cheap tier, via 4.3/the parallel model-selection classifier once it exists) | S–M | nothing structurally; benefits from 4.3 | plumbing is codex-lane-able; the auto-approve-under-budget threshold (§3.4) is an **AJ decision**, not code |
| 4.5 | Plan-fan-in (§1.1), hand-wired | M–L | 4.0 (prompt profile applies to the plan-phase siblings too) | the new pre-build gate (§4 row 3) is a genuinely new gate *point*, not just a new binding — **judgment lane** for the gate design; plumbing around it is codex-lane-able once specified |
| 4.6 | Orchestrator-worker (§1.2/1.2.1), hand-wired | L | 4.0 | **judgment lane, mandatory** — the `mergeChild` conditional change touches the single choke point three existing call sites depend on; needs an orchestrator FULL review before merge, mirroring how SWARM-W0/W1 themselves treated that function |

Recommended first cut: **4.0 + 4.1** — together they are the smallest
possible token win (a mechanical prompt-profile fix plus a strictly-dominant
improvement to the *already-shipped* best-of-N pattern), require zero new
CLF dependency, zero new human-gate design, and zero changes to the
`mergeChild` choke point. 4.2/4.3 can run in parallel once the
CLF-advancement lane's `DECISION_POINTS` edits are sequenced to avoid
collision. 4.6 (orchestrator-worker) is deliberately last: it is the only
item in this plan that touches shared, load-bearing merge machinery, and per
this repo's own convention (AGENTS.md: "if you break \[a pinning test], fix
the bug, not the test") it deserves the most scrutiny, not the least.

## 7. Deliberately NOT covered by this doc

- **Judge-panel, loop-until-dry, debate/tournament/blackboard** — the master
  design doc's own §4/§11 already schedules these as Wave 4/Wave 6 pattern-
  library data templates or explicitly deferred-to-v2 (no deterministic
  oracle, hardest to govern); nothing about the token-efficiency argument in
  this doc changes that scoping.
- **The full `propose{proposalType, spec}` kind** as the master
  classifier-framework doc originally specified it (rate-limited/deduped
  dynamic creation) — §3 argues SWARM does not need it and should not wait
  for it; if/when CLF Wave 4 ships that kind for other consumers, revisit
  whether `swarm-topology` should migrate onto it, but do not block on it.
- **Prompt-cache reuse across same-prompt siblings** — still an open
  question carried forward unmodified from the master doc's §13 ("the
  dominant cost lever for best-of-N — unmentioned in v1, should be
  exploited"); orthogonal to topology choice, applies equally to best-of-N
  and plan-fan-in's plan-phase fan-out, not designed here.
- **Warm-pool / in-process spawning** for reducing the ~0.6–1.5s fixed
  per-sibling spawn cost (#157's finding: bare spawn is ~100ms
  class-independent, but the *real* fixed cost is first `getState()` after
  full tool/extension graph load; ~44% of roles are read-only by policy but
  ~0% are actually eligible today due to a missing opt-in flag on the
  gate-verify reviewer fan-out, the highest-volume call site). This is a
  fixed-per-sibling-overhead lever that compounds with every topology's `N`
  or `M`, but it is explicitly a separate, already-queued lane
  ("eligibility-signal fix lane... BEFORE any step-2 productionization") —
  not redesigned here.
- **Cross-goal fleet/graph views at 20–30 agent scale** — still correctly
  deferred per the master doc's own §8/§11 Wave 5 ("the real scaling risk...
  is WS message fan-in, not SVG relayout"); none of the four topologies here
  approach that scale (max fan-out in any cost model above is single-digit).

## Cross-references

- `docs/design/swarm-orchestration-w0.md` / `-w1.md` / `-w2.md` / `-w3.md` —
  the shipped guardrails, best-of-N pattern, restart-resume, and
  scheduler-hook/UI-transparency waves this doc builds on.
- `docs/design/classifier-framework-status.md` — the in-repo CLF status
  ledger this doc's §3 is grounded against.
- `~/Documents/dev/bobbit-fable-refactor/design/swarm-orchestration.md` — the
  original master design (§3–§9, §11, §13–14) this doc's §1–2 extend past
  the point where it stopped (Wave 3+).
- `~/Documents/dev/bobbit-fable-refactor/design/classifier-framework.md` —
  the master CLF design (§3 interception points, §4 Decision union, §10
  phased plan) this doc's §3 reconciles against the actually-shipped subset.
- `src/server/agent/swarm-group-store.ts`, `swarm-best-of-n.ts`,
  `swarm-verifier.ts`, `swarm-governor.ts`, `goal-manager.ts` (`mergeChild`),
  `decision-types.ts`, `src/server/auth/operator-confirmation.ts` — the
  exact source files/signatures this doc's mechanisms are specified against.
