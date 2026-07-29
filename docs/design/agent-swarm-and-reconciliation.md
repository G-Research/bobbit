# Agent Swarms & Reconciliation — parallelism as the wall-clock lever

Status: **exploratory / vision** (no implementation) · Drafted 2026-06-19. Workstream **SW** in
[fable-program-execution-plan.md](fable-program-execution-plan.md).
Companion / dependency docs: [time-and-token-cost-efficiency.md](time-and-token-cost-efficiency.md)
§9 (the latency axis + the process-per-agent root cause this builds on),
[extension-platform.md](extension-platform.md) (the capability/hook/lifecycle-hub substrate this
ships on), [extension-host.md](extension-host.md) (the worker tier),
[agent-memory.md](agent-memory.md) (shared context for swarm members).

**The question this answers:** Claude Code now fans work out to *many* small specialised agents
(especially for research, but general work too) and runs them in parallel. If spawning an agent
becomes cheap — particularly once agents run **in-process** — can a fleet/swarm plus a
**reconciliation** step (à la [karpathy/llm-council](https://github.com/karpathy/llm-council),
or hermes' Mixture-of-Agents) cut Bobbit's wall-clock and/or raise quality? Where does it fit,
and what must land first?

**One-paragraph answer.** Yes, and it is the single biggest *wall-clock* lever available,
because every other lever in §9 makes *serial* work cheaper while a swarm converts serial work
into **parallel** work: N independent sub-tasks at ~3 min each stop costing 3N min and start
costing ~3 min. Bobbit already has the parallel substrate (teams run up to `maxConcurrent` 12
workers concurrently) — what's missing is (a) **cheap spawning** so fan-out of *many small*
agents is economical, (b) a **reconciliation/council** primitive to merge or arbitrate parallel
outputs, and (c) **risk-proportional, model-tiered** swarm members so you don't fan a frontier
model out 12×. All three compose out of machinery already on the roadmap — the capability
registry, the Lifecycle Hub, the model-selector pack, and workflow templates — so this is a
**pack + capability** play, not core surgery. The hard dependency is cost: a swarm of 12 *cold
OS processes* (today's model, §9.3) **amplifies** the process-per-agent tax 12× and would be a
net loss. The enabler is the move to running **full Bobbit in one container**, which makes
per-agent sandboxing unnecessary and lets swarm members run as cheap **in-process / worker_thread
forks that inherit the parent's warm cache** (§9.5 CE-G8.4). Swarm is therefore *gated on* the
sandbox change + in-process spawning; proposed here so the substrate work is shaped to allow it.

---

## §1 Why parallelism is the lever the cost doc doesn't have

[time-and-token-cost-efficiency.md](time-and-token-cost-efficiency.md) §9 established that
Bobbit's slowness is **structural serialization**, not slow requests: CC runs *larger* contexts
per request (377k median) and still turns in ~4.4s; Bobbit's wall-clock goes into verifiers on
the critical path (1.34 per work session × ~3 min), multi-agent handoffs, and nudge dead-time.

Every CE lever (L1 shrink context, L2 cut requests, L3 cheaper model, L4 stop double-paying)
makes a *serial* step cheaper. **None of them removes the serialization.** A swarm does exactly
that:

| | Serial (today) | Swarm (proposed) |
|---|---|---|
| N independent research probes / file investigations | Σ tᵢ (one agent, N turns) | ~max(tᵢ) (N agents, 1 wave) |
| N independent sub-edits across modules | Σ tᵢ (or N team workers, but each a cold OS spawn) | ~max(tᵢ) on cheap in-process forks |
| Verification | a *downstream* gate (serial tax, §9 F13) | folded into the parallel wave as **peer cross-review** (council) |

The third row matters most: reconciliation lets a fraction of the verification tax (§9 F5/F13)
move *into* the parallel phase as cross-checking among swarm members, instead of a separate
serial verifier gate after the fact.

## §2 The two shapes (both already proven elsewhere)

1. **Fan-out swarm (work/research).** A coordinator decomposes a goal into independent
   sub-tasks, spawns one *small, specialised* agent per sub-task (explorer, grep-er,
   doc-reader, single-file editor), runs them concurrently, and collects structured summaries —
   not raw transcripts — back. This is Claude Code's `utils/swarm/spawnInProcess.js` /
   `inProcessRunner.js` model: **in-process** teammates, parent context **inherited** via
   `forkContextMessages`, read-only explorers shipped with a **slim context** (`omitClaudeMd`).
   Bobbit's team machinery is the serial-process ancestor of this; the upgrade is cheap in-process
   members + summary-only returns.

2. **Council / reconciliation (decisions/quality).** K diverse agents (different
   models/personas/prompts) answer the *same* question in parallel; a **reconciler** then
   cross-reviews, ranks, and synthesises a single answer. This is
   [karpathy/llm-council](https://github.com/karpathy/llm-council) (models answer → peer-rank →
   chairman synthesises) and hermes' `tools/mixture_of_agents_tool.py` (reference models in
   parallel → aggregator synthesis). It is a **quality** play (ensemble reduces variance on hard
   reasoning) *and* a latency play (replaces a serial author→verify loop with parallel
   propose+cross-check). Use it for design decisions, ambiguous specs, risky diffs, research
   synthesis — not for every edit.

The two compose: a fan-out swarm for breadth, a council for the decisions where being right the
first time avoids an expensive serial retry.

## §3 How it composes on the existing platform (no core surgery)

This is deliberately a **capability + workflow-template** feature on the
[extension-platform.md](extension-platform.md) substrate, honouring its "core grows only
*platform* code" principle.

- **`swarm` capability** (`provides: [swarm]`). `ctx.capabilities.call("swarm", { tasks,
  memberRole, model, reconcile, budget })` → host fans out members on the worker tier, enforces
  per-member + aggregate budgets (the §5.2 budget/provenance machinery already specified),
  returns structured summaries. Host-mediated, traced, non-fatal on member failure (principle 4).
- **`reconcile` capability** (`provides: [reconcile]`). The council/aggregator step as its own
  pack method, so the merge policy (rank+synthesise, majority, chairman-model) is swappable.
  hermes' MoA aggregator and llm-council's chairman are the reference designs.
- **`model-selector` capability (EP G9.2)** picks the member model tier and the reconciler tier —
  this is exactly the **multi-model-delivery** pattern (EP G9.3: planner frontier+xhigh,
  implementer cheap). Swarm members default to a *small/cheap* model; the reconciler gets the
  frontier one. Fanning a frontier model out 12× is the anti-pattern the selector prevents.
- **Lifecycle Hub** (extension-platform §5) is the dispatch/budget/provenance host for members,
  and `beforeSessionSpawn`/`beforeGoalCreate` proposal hooks (P8) are where a swarm member's
  slim context + model tier are assigned without core changes.
- **Workflow templates as packs** (`workflows/*.yaml`): ship `research-swarm.yaml` and
  `council-decision.yaml` so a goal can *opt into* the shape, same `WorkflowStore` gate schema
  used today.
- **Shared context** via [agent-memory.md](agent-memory.md): members read the same recall bank
  so the swarm doesn't re-derive shared facts N times.

## §4 The hard dependency: cheap spawning (and why the sandbox change is the unlock)

A swarm is only a win if a member is cheap to start and cheap in tokens. Today (§9.3) every agent
is a **separate OS process** (`rpc-bridge.ts` `spawn`), with its own MCP stdio children, and —
for sandboxed goals — its own `docker exec` into a pool container. A 12-member swarm in that model
pays the per-spawn startup floor **12×** and cold-writes its resident stack **12×** (§9 F14) — a
net wall-clock and cost *loss*.

Two roadmap items remove the blocker, in order:

1. **Full Bobbit in a single container (imminent).** Once the *whole* gateway runs inside one
   Docker container, per-agent sandboxing is redundant — the trust boundary is the container, not
   the agent. That removes the per-member `docker exec`/container tax and, more importantly,
   makes it **safe** to run members as **in-process / `worker_threads`** units (the Extension
   Host worker tier already runs pack modules this way: terminate-able workers with resource
   caps — see [extension-host.md](extension-host.md)). *Per-agent sandboxing is the only reason
   members must be separate processes today; collapse that and the cheap path opens.*
2. **Warm-cache reuse for short-lived spawns (§9.5 CE-G8.4).** In-process members can inherit the
   coordinator's already-cached prefix (Claude Code's `forkContextMessages`) instead of cold-
   writing — directly killing the §9 F14 cold-write tax that would otherwise scale with swarm
   width.

**Sequencing:** SW is gated on (1); it gets dramatically cheaper with (2). Both are independently
motivated in other workstreams — this doc's ask is only that they be **shaped to admit cheap
fan-out** (a pooled/forked member runner, summary-only returns, slim member context).

## §5 Federation — swarms across multiple Bobbits

Once multiple Bobbit instances connect through the **Bobbit gateway** (their projects, agents,
runtimes shared), the gateway becomes a natural **swarm scheduler across instances**: a fan-out
wave can place members on whichever Bobbit has spare capacity / the right project worktree /
the right local model, and the reconciler collects across the federation. This is out of scope
for v1 (single-instance, in-process swarm first) but the `swarm` capability's task/return
contract should be **transport-agnostic** (structured task in, structured summary out) so the
same call site works whether a member runs in-process or on a peer Bobbit. Record this seam now;
don't build it yet.

## §6 Risks & open questions

1. **Fan-out cost blow-up.** Width × model price can dwarf the wall-clock saving. Mitigation:
   cheap-model members by default (model-selector), hard per-wave token/cost budget, and a
   max-width cap (start ~4–6, not 12). BENCH-gated like all behaviour-affecting CE work.
2. **Reconciliation is not free.** The council/aggregator turn is itself a frontier call over K
   answers; for trivial tasks it costs more than it saves. Reserve council for genuinely
   ambiguous/risky decisions; default work to plain fan-out + the existing (risk-proportional,
   §9 CE-G8.1) verification.
3. **Decomposition quality is the ceiling.** A swarm only helps when sub-tasks are genuinely
   independent; bad decomposition serialises anyway (members blocking on each other) or
   duplicates work. The coordinator's decomposition is the hard part and should be evaluated in
   the bench suite (CE-G0.3) with a real multi-file task.
4. **Context coherence / merge conflicts.** Parallel editors on a shared worktree race; need
   per-member worktrees or file-range leasing, then a reconcile/merge step. Read-only research
   swarms avoid this and are the safe v1.
5. **Provenance & debuggability** (platform principle 3): every member's contribution and the
   reconciler's rationale must be inspectable, or a swarm becomes an untrustable black box.
6. **Quality evidence.** MoA/llm-council quality gains are task-dependent; validate on the bench
   suite before claiming them — don't ship council on faith.

## §7 Phased plan (SW)

All phases BENCH-gated (CE-G0.3) on **both** cost and wall-clock; gated on the single-container
sandbox change for the in-process tiers.

- **SW-G0 — Bench shapes (S).** Add to the CE bench suite: (a) a decomposable multi-file research
  task, (b) an ambiguous design-decision task. These are the measuring sticks for everything
  below; without them SW is "vibes". Reuse CE-G0.3's runner + the wall-clock report fields
  (CE-G8.5).
- **SW-G1 — `swarm` capability + read-only research fan-out (M).** Coordinator decomposes →
  N read-only members (slim context, cheap model) → summary-only returns → coordinator
  synthesises. Process-based members acceptable here (read-only, no worktree races) to ship value
  before the container change; cap width ~4. Tests: capability contract, budget enforcement,
  member-failure non-fatal, summary-shape pin.
- **SW-G2 — `reconcile` capability + `council-decision` workflow (M) [BENCH-GATED].** K-agent
  parallel answer → reconciler synthesis (pluggable policy: rank+synthesise default). Wire
  model-selector for member/reconciler tiers. BENCH: decision-quality on SW-G0(b) vs single-agent
  baseline, at acceptable cost.
- **SW-G3 — In-process member runner (L, gated on single-container sandbox).** Run members as
  worker_thread/in-process forks inheriting the coordinator's warm cache (CE-G8.4). This is what
  makes fan-out *cheap* and unlocks wider swarms + parallel *editing* (with per-member worktrees
  or file leasing + a merge reconcile). BENCH: wall-clock + cost vs SW-G1 process model.
- **SW-G4 — Federation-aware scheduling (later, recorded).** Transport-agnostic member placement
  across connected Bobbits via the gateway. Design only until single-instance swarm is proven.

### Expected impact (estimates — bench replaces these)

| Phase | Axis | Est. effect on affected goal class |
|---|---|---|
| SW-G1 | wall-clock | research/discovery phase Σtᵢ → ~max(tᵢ); biggest on broad investigations |
| SW-G2 | quality (+ avoided serial retries) | fewer wrong-first-time decisions → fewer expensive serial redo loops |
| SW-G3 | wall-clock + cost | makes wide fan-out economical; enables parallel editing; kills cold-write width tax |
| SW-G4 | throughput | horizontal scale across instances |

---

## §8 Relationship to the rest of the program

- **Depends on:** EP G1.x (pack platform), EP G9.2 model-selector, EP §5 Lifecycle Hub +
  Extension Host worker tier; the single-container sandbox change (removes per-agent sandbox →
  in-process members); CE-G8.4 warm-cache reuse; CE-G0.3 bench + CE-G8.5 wall-clock metrics.
- **Reframes:** §9's verification tax — council folds cross-review into the parallel wave,
  complementing CE-G8.1's risk-proportional gates rather than replacing them.
- **Does not change:** core orchestration; everything ships as packs + capabilities +
  workflow templates per the extension-platform principles.
