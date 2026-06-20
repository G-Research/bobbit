# Verification-Loop Economics — the retry tax, and right-sizing the gate suite

Status: **investigation complete, remediation not started** · Measured 2026-06-20 against a live
`.bobbit/state` snapshot on the primary dev machine (28 goals, 633 sessions, $2,184 tracked
spend, 240 gate signals, 379 verifier runs), cross-checked against 1,461 Claude Code sessions and
the `~/.hermes` council harness. Workstream **CE** in
[fable-program-execution-plan.md](fable-program-execution-plan.md) — this doc **deepens
CE-G8.1** (risk-proportional verification) with measured loop data and adds the goals
**CE-G8.7–G8.11**.
Companion docs: [time-and-token-cost-efficiency.md](time-and-token-cost-efficiency.md) (§9 latency
axis + the process-per-agent root cause this builds on; the F5/F13/F14/F15 findings),
[agent-swarm-and-reconciliation.md](agent-swarm-and-reconciliation.md) (the parallel end-state
these levers converge toward), [extension-platform-implementation-plan.md](extension-platform-implementation-plan.md)
(model-selector G9.2/G9.3 — the substrate for model/thinking tiering), [agent-memory.md](agent-memory.md).

**The question this answers:** goals run for hours and re-spawn fix/review agents long after the
work looks done. Where does that time actually go, is it the *agents* or the *machinery*, and
what is the cheapest change that bends the curve?

**The one-paragraph answer.** The dominant tax is the **verification loop**, and it is driven by
**reviewer opinion, not broken code**. Half of all gate-signal events (123 of 240, **51%**) are
*retries* of a gate that was already signaled; 112 of those 123 retries follow a **failed**
verification, and **70% of failed signals were a reviewer returning FAIL while the build/tests
passed** — only ~9% were a real build/test failure. Each implementation re-signal re-runs the
*entire* phase suite (Build+Check+Unit+E2E + gap-analysis + code-review + security ≈ **27 min of
machine compute**, ~9–10 min wall) even when one nit changed, because there is **no
severity→verdict mapping** (any single subjective `[high]` blocks the gate) and **no
affected-only re-verification** (a re-signal cascade-resets and re-runs everything). Across the
dataset that is **≈40 h of repeated implementation-gate verification**. The fix is four
data-driven, mostly-infra-free levers — a **severity floor + round budget**, **affected-only
re-verification**, **goal-author-composed / agent-right-sized workflows**, and **model+thinking
tiering (plan→cheap→frontier-review)** — each validated by the experiment-runner before it ships,
with one hard guardrail learned from Hermes: a cheap tier is only safe behind an **independent
reviewer that checks ground truth and never self-certifies**.

---

## North star — the invariant every lever bows to

**Bobbit's defining value is that autonomous agent work is *trustworthy*: verified to a high bar
with minimal human babysitting. That is non-negotiable and ranks above every optimization in this
doc.** Speed, token cost, swarm width, thinking budget, and model tier are all **subordinate** —
no lever may ship if it raises the **escaped-defect rate**, which is why every behaviour-affecting
goal here is BENCH-gated on defect-escape, not dollars (§0.4, §6).

What we are cutting is **waste, not assurance**: re-reviewing code that did not change, looping on
subjective nits, running heavyweight gates on trivial diffs, and re-reading bloated context. Every
lever either (a) holds quality constant while removing that waste, or (b) *strengthens*
verification — the **strengthen-free / weaken-gated asymmetry** (CE-G8.9), the
**reviewer-confirmed-bug floor** (CE-G8.7), the **non-removable build/security gate floor**, and
the **ground-truth reviewer guardrail** on any cheap tier (CE-G8.10, from Hermes). Gates stay
re-openable; nothing self-certifies.

The end-state we are building toward — Fable-style **fan-out → synthesize → concrete plan →
execute → loop** across many agents (see [agent-swarm-and-reconciliation.md](agent-swarm-and-reconciliation.md))
— is valuable *precisely because* it sits on this trust foundation. Parallelism multiplies output;
verification is what makes that output safe to trust at scale. The levers in this doc make
verification **cheaper and better-targeted**, never weaker, so that scaling up the agent count
later compounds quality instead of diluting it.

---

## §0 Universal rules

Same as the extension-platform / CE plans (restated because goals here are handed off
independently):

1. **Test-first.** Every CE-G8.x goal below lists pinning tests; write them RED first. No flaky
   tests.
2. **Locate code by symbol name, not line number.** Anchors here were verified on the
   2026-06-20 snapshot and will drift; if a symbol is missing, STOP and re-derive — don't guess.
3. **Gates.** `npm run check` + `npm run test:unit` for everything; `+ test:e2e` for
   server/UI changes.
4. **BENCH-gated.** Every behaviour-affecting lever ships behind an experiment-runner A/B
   (see §6) that measures retries, wall-clock, cost, **and** escaped-defect rate — never just
   dollars. A latency/quality win on vibes is not a win.
5. **Shared-seam serialization.** `verification-logic.ts`, `gate-store.ts`, `team-manager.ts`,
   `session-setup.ts` are hot seams (also touched by CE-G8.1–G8.6, CS, EP). `rg` the symbol and
   serialize per execution-plan §1.4.

---

## §1 The measured loop (the data)

All figures from the 2026-06-20 snapshot; reproduction recipes in **Appendix A**.

### 1.1 Half of all gate signals are do-overs

| Quantity | Value |
|---|---|
| Distinct gates signaled ≥ once | 117 |
| Total signal events | 240 |
| **Re-signals (retries)** | **123 — 51% of all signals** |
| Gates that looped (≥ 1 retry) | 48 |
| Retries following a **FAILED** verification | 112 |
| Retries following an already-**PASSED** gate (cascade-reset re-run of green work) | 11 |
| Retries at a **new** commit (a fix landed) | 108 |
| Retries at the **same** commit (pure re-verification — flaky / metadata / reset) | 15 |

Worst offenders are all the `implementation` gate: **11 retries** on *Hierarchical goal metadata*
and on *Hindsight setup & deploy modes*; 7 on *P3 modes consent* and *Experiment runner*; median
≈ 2.6 retries per implementation gate.

### 1.2 Failures are reviewer verdicts, not broken builds

Cause attribution of the 110 failed signals that carry step detail:

| Cause | Count |
|---|---|
| **Reviewer (llm-review) said FAIL, build/tests green** | **70** |
| Mixed (reviewer + a command both failed) | 30 |
| Real build/test failure only | 10 |

Which step actually failed the gate (count across all failed signals):

| Failing step (role) | Times it failed the gate |
|---|---|
| **Code quality review** (`code-reviewer`) | **83** |
| Gap analysis (`spec-auditor`) | 40 |
| Security review (`security-reviewer`) | 31 |
| Unit tests *(real)* | 20 |
| E2E tests *(real)* | 19 |
| Regression / design / docs reviews | ~20 |

`code-reviewer` alone failed more gates than **all build+test failures combined**.

### 1.3 The findings are mostly subjective, yet any one blocks the gate

Severity tags across **failed** review steps: `[critical] 18 · [high] 112 · [medium] 88 ·
[low] 33`. There are only **18 critical findings in the entire dataset**. But the verdict is a
**binary pass/fail an LLM picks** (`verification_result(verdict)` in
`defaults/tools/tasks/verification_result.yaml`) with **no severity→verdict contract**: a single
`[high]` — and most "high" are subjective quality (AGENTS.md growth, UI inconsistency, "missing
test coverage"), not broken functionality — fails the gate.

### 1.4 The cascade: one nit re-runs everything

`gate-store.ts` cascade-resets all transitive downstream gates on a re-signal, and
`verification-logic.ts` re-runs the **whole** phase suite from scratch — there is no
"only re-run steps whose inputs changed". Measured per-step averages on the `implementation`
gate: Build 8 s · Check 14–22 s · Unit 45–76 s · **E2E 227–260 s** · Post-impl gap 145–208 s ·
**Code quality 266 s** · Security 94–198 s. **One full re-run ≈ 27 min of machine compute**
(~9–10 min wall, since same-phase steps overlap). With **89 implementation re-signals** in the
dataset that is **≈ 40 h of repeated implementation-gate verification alone**, the bulk of it
re-checking code that did not change.

### 1.5 Cost shape (corroborates CE §9)

Spend by bucket (this snapshot): MAKER (coder/test/docs) **$968** · **TEAM-LEAD $570 across just
28 sessions** · VERIFIER steps **$549** (368) · other ~$98. The team-lead bucket is the
under-weighted sink — 28 long-lived leads cost more than all 368 verifier runs and ~60% of all
230 maker sessions, because a lead lives 30–66 h and re-reads its bloated coordination context on
every nudge (615M cache-read tokens across 28 leads). Cost falls out of wall-clock: every retry
is *both* minutes you wait *and* tokens you pay.

---

## §2 Root causes (fishbone)

```
                VERIFICATION DESIGN              ORCHESTRATION                 MODEL STRATEGY
                • no severity→verdict map        • team-lead = context sink    • one frontier tier for all
                • binary pass/fail on opinion    • 1 lead per (sub)goal        • no plan→cheap→review split
                • full suite re-runs on re-sig   • verify serial, after work   • reviewer not risk-tiered
                          \                              |                            /
                           \                             |                           /
   ────────────────────────────────────────────────────────────────────────────────►  GOALS TAKE HOURS & COST $$
                           /                                           \
                          /                                             \
                PROCESS MODEL                                        CONTEXT
                • process-per-agent (cold spawn)                     • full AGENTS.md on every agent
                • no warm-cache reuse                                • no slim read-only profile
                • MCP stdio per agent                                • re-read whole context each turn
```

The CE §9 doc owns the **process-model** and **context** bones (CE-G8.2/G8.3 + the inherent
F14). This doc owns the **verification-design**, **orchestration** (team-lead diet), and
**model-strategy** bones.

---

## §3 What the other harnesses teach

| Dimension | Claude Code | hermes-agent (council) | Bobbit today |
|---|---|---|---|
| Reviewer | human, inline / real-time | 1 independent `reviewer-opus`, re-verifies vs **ground truth** | 5–7 automated verifiers per gate, **re-run every re-signal** |
| Per-turn latency | ~4 s (warm in-process) | — | ~291 s (cold process-per-agent) |
| Sub-agents | opt-in; **97.6% of work uses none** | kanban tasks + MoA fan-out | always team + full gate suite |
| Gate loops | none (no gates) | FAIL → scoped fix (cards can't reopen) | 123 re-signals, full-suite re-run |
| Quality risk | human must catch it | **cheap models hallucinated PASS / "done" on RED CI; 48 FAIL vs 34 APPROVE** | nit-driven loops; non-deterministic reviewers |

Two opposite lessons, both binding on the levers below:

1. **Claude Code (the speed lesson).** Fast because the maker stays *warm and in-process* across
   turns and fan-out is *opt-in* (97.6% of work uses no sub-agent). Portable: keep makers warm
   (CE-G8.4), make sub-agents opt-in, and **don't re-run the full review suite on every
   re-signal** (CE-G8.8). It has *no* automated assurance — that is the part Bobbit should keep.
2. **Hermes (the quality lesson).** Cheap workers **self-certified garbage**: claimed a clean
   PASS while master CI was RED 8/8, fabricated commit SHAs, and "done" cards could not reopen so
   wrong results persisted. It only stayed sane because **one independent `reviewer-opus`
   re-verified against ground truth (CI, real SHAs)**. This is the **hard guardrail** on the
   cheap-executor lever (CE-G8.10): a cheap tier is only safe behind a strong reviewer that
   checks reality and never trusts the worker's self-report; and gates must remain
   **re-openable** (Bobbit's already are — preserve that).

---

## §4 The levers (hand-off backlog)

Ordering rationale: Wave-1 (G8.7/G8.8) needs no new infra and removes roughly half of all gate
work (the retries). Wave-2 (G8.9/G8.10/G8.11) right-sizes *what* runs and on *which model/think
budget*. The parallel end-state lives in [agent-swarm-and-reconciliation.md](agent-swarm-and-reconciliation.md).

### CE-G8.7 — Severity floor + review-round budget (S–M) **[BENCH-GATED]** — *biggest bang/effort*

- **Diagnosis:** §1.2/§1.3. 70 of 110 failures are reviewer-only; the verdict has no severity
  contract, so subjective `[high]`/`[medium]`/`[low]` block the gate and force a full re-run.
- **Contract:** make `verification_result` carry **structured findings** `{ severity, kind:
  "bug"|"quality", file, line, note }`, and add a gate-level **block policy**: a gate FAILs only
  on a finding that is `severity ∈ {critical, high}` **and** `kind == "bug"` (reviewer-confirmed,
  reproducible). `quality`/`medium`/`low` findings are **recorded as advisory** on the gate and
  surfaced to the team-lead, not auto-looped. Add a **round budget**: after N (default 2) auto
  re-review rounds the gate escalates to a human decision instead of spawning another fix→re-sig
  cycle. The exact rule is **a tunable**, decided by CE-G8.7-EXP (§6), defaulting to
  strict-but-bug-only.
- **Owned files:** `verification_result.yaml` (+ its `extension.ts`); the reviewer role prompts
  (`defaults/roles/code-reviewer.yaml`, `spec-auditor.yaml`, `security-reviewer.yaml`,
  `reviewer.yaml`) to emit structured severities and the bug-vs-quality distinction;
  `verification-logic.ts` (verdict aggregation → block decision); `gate-store.ts` (advisory
  findings persisted, round counter).
- **Tests:** unit — block-decision table (severity × kind × strictness); a `[high] quality`
  finding does NOT fail the gate, a `[high] bug` does; round-budget escalation after N. E2E — a
  gate signaled with only advisory findings passes and records them; the (N+1)th retry escalates
  rather than re-spawns.

### CE-G8.8 — Affected-only re-verification (M) **[BENCH-GATED]**

- **Diagnosis:** §1.4. A re-signal re-runs the entire phase suite even when one file changed; 89
  impl re-signals ≈ 40 h of recompute.
- **Contract:** on re-signal, compute the diff between the new commit and the previously-verified
  commit; **re-run only the steps whose inputs intersect the changed files** (a step declares its
  input scope: command steps by component/path globs, llm-review by the diff it reviews). Steps
  whose inputs are unchanged **reuse the prior passed result** (extends the existing same-SHA
  verification cache in `gate-store.ts` to a *changed-paths* cache). Cascade-reset still
  invalidates downstream *content* gates, but their *unchanged* steps reuse cache.
- **Owned files:** `verification-logic.ts` (input-scope resolution + skip decision), `gate-store.ts`
  (changed-paths cache key), workflow step schema (`component`/`run`/`prompt` gain an optional
  `inputs:` glob list; absent ⇒ "always run", preserving today's behaviour).
- **Tests:** unit — changed-paths → step-skip table; a docs-only re-signal skips Build/Unit/E2E
  and re-runs only Documentation. E2E — second signal at a new commit touching one file re-runs
  only the affected steps; cache markers (`[reused — inputs unchanged]`) appear.
- **Caveat:** never skip a step a workflow marks `required: strict`; never reuse `human-signoff`
  (already non-cacheable).

### CE-G8.9 — Goal-author-composed / agent-right-sized workflows (M) **[BENCH-GATED]**

- **Diagnosis:** today the workflow is a **frozen template picked at creation** and snapshotted
  into the goal; a 2-line tooltip goal pays the same 5–7-verifier suite as a 500-line refactor.
  The machinery to do better already exists (project assistant generates workflows; `propose_goal`
  validates a workflow id; the workflow-editor schema; `WorkflowStore`).
- **Contract — two parts:**
  1. **Compose at creation.** A standardized step lets the goal-creating session **assemble the
     gate set for *this* goal from a catalog** and record an **explicit rationale** per
     included/excluded gate ("docs-only → no security/e2e", "concurrency fix → add soak gate",
     "research → design+review only, no build"). Persist the rationale on the goal for audit.
  2. **Right-size in flight.** The team-lead may **propose** enabling/disabling gates after
     seeing the real diff — reusing the **divergence-policy gradient + `mutation_pending`
     approval card** (same machinery as plan/sub-goal mutation). **Asymmetry is the safety
     model:** *strengthening* (ADD/upgrade a gate) is autonomous under `balanced`/`autonomous`;
     *weakening* (disable/downgrade) is **gated**, with a **non-removable floor** — build,
     typecheck, and security-on-code-changes are never agent-disableable (mirrors the bypass
     human-only rule). Every toggle is justified, audit-logged, and reversible.
- **Owned files:** a `compose_workflow` proposal tool (or extend `propose_goal`); the
  proposal-panel workflow surface (`src/app/proposal-panels.ts`); `WorkflowStore` snapshot path;
  the gate-mutation route + `mutation_pending` plumbing (`team-manager.ts`, the policy/divergence
  code); a `gateFloor` allow-list (non-disableable gate ids/kinds).
- **Tests:** unit — floor enforcement (cannot disable build/typecheck/security on a code goal);
  asymmetry table (ADD autonomous, DISABLE gated by policy). E2E — a docs-only goal composed
  without build/e2e completes without spawning those verifiers; an agent disable-security
  proposal is held for human approval; browser E2E for the creation-time composer + persisted
  rationale.
- **Why it beats a pure line-count threshold (CE-G8.1):** the author/lead reasons about the
  *actual* change and records *why* — auditable and smarter than a heuristic. CE-G8.1's threshold
  becomes the *default* the composer starts from.

### CE-G8.10 — Model + thinking tiering: plan → cheap executor → frontier review (M) **[BENCH-GATED]**

- **Diagnosis:** §1.5 — every role runs the same frontier model at the same thinking budget;
  makers are 44% of spend. Front-loading reasoning into a precise plan lets a cheap/fast model
  execute and a frontier model review — cutting cost *and* wall-clock.
- **Contract:** a **plan gate** whose deliverable is a *precise change-list* (exactly what to
  change, where, with acceptance per item); a **cheap, low/no-thinking executor** role that
  implements the change-list mechanically; a **frontier reviewer** (high thinking) that checks
  plan + diff **against ground truth**. Tiers resolved by the **model-selector** (EP G9.2/G9.3);
  thinking budget set **per role × task risk** (Bobbit already supports per-role `thinkingLevel`
  in `session-setup.ts`) — executors default to no/low extended thinking, planners/reviewers to
  high.
- **Hard guardrail (Hermes, §3.2):** the cheap tier is only enabled behind CE-G8.7's
  reviewer-confirmed-bug floor and a reviewer that verifies reality (CI/tests/SHAs), never the
  worker's self-report. If plan quality is the ceiling, a wrong plan faithfully produces wrong
  code — so the plan gate is itself reviewed (frontier) before execution.
- **Owned files:** model-selector capability (EP); role definitions for `planner` / cheap
  `executor`; `session-setup.ts` (per-role model + thinking resolution); workflow templates that
  wire the plan→exec→review sequence.
- **Tests:** unit — tier resolution per role/risk; executor spawns with low thinking + cheap
  model. E2E — a plan→exec→review goal completes; BENCH — cost & wall-clock down vs
  frontier-everything **with no increase in escaped defects** (the gate that matters).

### CE-G8.11 — Team-lead diet (M)

- **Diagnosis:** §1.5 — 28 leads cost $570; a lead accumulates the whole goal's coordination
  history and re-reads it every nudge.
- **Contract:** **summary handoffs** (workers return structured summaries, not raw transcripts,
  into the lead's context); **lead-context compaction** at phase boundaries; optionally
  **phase-scoped / ephemeral leads** (a fresh lead per phase seeded with the prior phase's
  summary) so the resident context never grows unbounded.
- **Owned files:** `team-manager.ts` (worker-result summarization, nudge payload), the lead
  prompt assembly, compaction hooks.
- **Tests:** unit — worker result is summarized before injection; lead resident size stays under
  a pinned budget across N phases. E2E — a multi-phase goal's lead context does not grow
  monotonically with worker count.

### Expected effect (estimates — the experiment-runner replaces these)

| Goal | Δ cost | Δ wall-clock | Attacks |
|---|---|---|---|
| CE-G8.7 severity floor + budget | −− | −− | the 70 reviewer-only failures / 123 retries |
| CE-G8.8 affected-only re-verify | −− | −− | the 27-min × 89 re-run cascade |
| CE-G8.9 composed / right-sized gates | −− | −− | tiny goals paying the full suite |
| CE-G8.10 model+thinking tiering | −− | − | maker spend (44%) + first-time correctness |
| CE-G8.11 team-lead diet | −− | − | the $570 orchestrator sink |

---

## §5 Sequencing & dependencies

```
WAVE 0 instrument        WAVE 1 kill the loop (no new infra)      WAVE 2 right-size           WAVE 3 (CE-G8.4 + SW)
─────────────────        ──────────────────────────────────      ─────────────────           ─────────────────────
loop+latency metrics  →  CE-G8.7 severity floor + budget       →  CE-G8.9 composed gates    →  in-process agents
(CE-G8.5)             →  CE-G8.8 affected-only re-verify        →  CE-G8.10 model/think tier →  swarm + cheap subgoals
                         CE-G8.3 slim read-only ctx                CE-G8.11 team-lead diet      + council (SW-G1..3)

        Experiment-runner spans every wave → A/B each lever on a real task; measure
        retries · wall-clock · cost · escaped-defect rate (never dollars alone).
```

- **CE-G8.7** depends only on the structured-findings contract; do first.
- **CE-G8.8** is independent of G8.7 (different seam) — parallelizable.
- **CE-G8.9** depends on the divergence-policy/`mutation_pending` machinery (exists) and the
  `WorkflowStore` snapshot path; CE-G8.1's threshold is its default.
- **CE-G8.10** depends on the model-selector (EP G9.2/G9.3) and is **gated** on CE-G8.7's bug
  floor (the Hermes guardrail).
- **Wave 3** is gated on the single-container sandbox change + CE-G8.4 (warm-cache reuse), per
  the swarm doc; "cheap sub-goals as the unit of work" is the same dependency.

---

## §6 Experiment plan (the point of the experiment-runner)

These levers are **hypotheses with a number attached**; the experiment-runner extension (in
flight) decides them on real goals instead of by guess. Each experiment fixes one task and varies
one knob, measuring `{ retries, wallClockMs, costUsd, escapedDefects }` (escaped-defects via a
post-merge re-review or a planted-bug control).

- **CE-G8.7-EXP — severity rule.** Same task; arm A `[high]`-blocks (today), arm B
  `[critical] + reviewer-confirmed bug` blocks, arm C `[high]` blocks but retries capped at 2 →
  human. Pick the arm that minimizes retries+wall-clock without raising escaped-defects.
- **CE-G8.8-EXP — re-verify scope.** re-run-all vs affected-only on re-signal; expect large
  wall-clock/cost drop at equal quality.
- **CE-G8.10-EXP — tiering.** frontier-everything vs plan(frontier)→exec(cheap,no-think)→review(frontier);
  the **escaped-defect** column is decisive (Hermes failure mode).
- **CE-G8.9-EXP — composed gates.** template-frozen vs author-composed gate set on a mixed batch
  (docs-only, small fix, large feature); measure suite-size vs defect-escape.

Until the runner lands these are **defaults, not decisions**: ship CE-G8.7/G8.8 behind a flag,
default strict-but-bug-only + affected-only, and flip per experiment evidence.

---

## Appendix A — Reproduction recipes

All against `.bobbit/state` on the primary dev machine (2026-06-20 snapshot).

```python
# Retry rate + cause + new-vs-same-commit (the §1.1/§1.2 numbers)
import json, collections
g = json.load(open(".bobbit/state/gates.json"))
total=resig=after_fail=after_pass=samesha=newsha=0; gates=0
for e in g:
    s=e.get("signals",[])
    if not s: continue
    gates+=1; total+=len(s)
    for i in range(1,len(s)):
        resig+=1; pv=(s[i-1].get("verification") or {}).get("status")
        after_fail += pv=="failed"; after_pass += pv=="passed"
        if s[i-1].get("commitSha")==s[i].get("commitSha"): samesha+=1
        else: newsha+=1
print(f"gates={gates} signals={total} retries={resig} ({100*resig/total:.0f}%)")
print(f"  after-fail={after_fail} after-pass(reset)={after_pass} same-sha={samesha} new-sha={newsha}")

# Loop driver: which step failed the gate, and finding severities (§1.2/§1.3)
import re
failstep=collections.Counter(); sev=collections.Counter()
for e in g:
    for s in e.get("signals",[]):
        v=s.get("verification") or {}
        if v.get("status")!="failed": continue
        for st in v.get("steps",[]):
            if st.get("passed") is False: failstep[f"{st.get('type')}:{st.get('name')}"]+=1
            if st.get("type")=="llm-review" and st.get("passed") is False:
                out=st.get("output") or ""
                for k in ("critical","high","medium","low"): sev[k]+=len(re.findall(r"\[%s\]"%k,out,re.I))
print(failstep.most_common(8)); print(dict(sev))

# Cost by role + the team-lead sink (§1.5): join session-costs.json to sessions.json by id/role
```

The per-step duration averages (§1.4) come from iterating `signals[].verification.steps[]`
(`duration_ms`, `name`, `passed`, `type`) on `implementation`-gate records. Spend-by-role joins
`session-costs.json` (`totalCost`, `cacheReadTokens`) to `sessions.json` `sessions[]` by id,
bucketing on `role`; verifier-step records are keyed `llm-review-*` / `agent-qa-*`.
