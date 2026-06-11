# Fable program — execution plan (hand-off for the main Bobbit session)

Status: living tracking document. This is the **single sequencing source of truth** for all
work proposed on the fable-docs branch. Hand this file to the orchestrating Bobbit session;
it creates goals from §3, in lane order, and ticks §4 as PRs merge.

The workstreams (each doc owns its *content* — tasks, contracts, acceptance; this doc owns
*ordering, slicing, and the checklist*):

| Workstream | Design (WHAT/WHY) | Execution authority (HOW) |
|---|---|---|
| **EP** extension platform | [extension-platform.md](extension-platform.md) | [extension-platform-implementation-plan.md](extension-platform-implementation-plan.md) (G1.1–G9) |
| **CE** token/cost efficiency | [token-cost-efficiency.md](token-cost-efficiency.md) §1–§5 | same doc, §6 (CE-G0.1–G7.2, BENCH gates) |
| **CS** comms-stack reliability | [comms-stack/01–03](comms-stack/01-understanding.md) | [comms-stack/04-current-state-and-backlog.md](comms-stack/04-current-state-and-backlog.md) §6–§7 (waves + merge map) |
| **SN** sidebar & goal-nesting | [sidebar-goal-nesting-audit.md](sidebar-goal-nesting-audit.md) §1–§3 | same doc, §4 (T1–T9) |
| **PB** client perf/battery | [client-performance-battery.md](client-performance-battery.md) | [client-performance-battery-implementation-plan.md](client-performance-battery-implementation-plan.md) |
| **MC** Mission Control | [mission-control.md](mission-control.md) | [mission-control-implementation-plan.md](mission-control-implementation-plan.md) |
| **AI** autoimprovement | [autoimprovement.md](autoimprovement.md) | [autoimprovement-implementation-plan.md](autoimprovement-implementation-plan.md) |
| **GA** gap-analysis easy wins | [harness-gap-analysis.md](harness-gap-analysis.md) | [gap-easy-wins-implementation-plan.md](gap-easy-wins-implementation-plan.md) |
| **CI** code intelligence | [code-intelligence.md](code-intelligence.md) | [code-intelligence-implementation-plan.md](code-intelligence-implementation-plan.md) |

**An implementer agent receives exactly one goal ID and reads: the execution-authority doc's
goal section → the contracts it cites → §1 below. Nothing else is required.**

---

## §1 Binding rules (no exceptions, no re-litigating)

1. **Universal definition-of-done**:
   [extension-platform-implementation-plan.md §0](extension-platform-implementation-plan.md)
   applies verbatim to every PR in every workstream — read-before-edit (`rg` the symbol in
   docs/tests/src first), tests authored first and shown RED where expressible, `npm run
   check` + `test:unit` + relevant `test:e2e` green, browser E2E for every user-facing
   feature, no flaky tests, minimal change, master stays green, anchors located by **symbol
   name** (line numbers are hints; if a named symbol is missing, STOP and re-derive from the
   cited pattern file — never improvise a parallel mechanism). Its §0.1 patterns library is
   the copy-from list for all workstreams.
2. **The docs are the spec.** Implement exactly what the owning doc's task/phase says, using
   its appendix contracts (types, catalogs, file layouts) as written. If reality forces a
   deviation, amend the owning doc **in the same PR** with a `> Deviation:` note at the
   affected section — doc and code must never disagree after a merge. Architectural
   deviation ⇒ stop and escalate to a human.
3. **One task/phase = one goal; one goal = 1–3 PRs.** Never batch. Every PR leaves the
   product working and mergeable on its own (flag-gated or additive when incomplete).
4. **Shared-seam serialization.** These seams are touched by multiple workstreams. The first
   goal to land owns the change; later goals rebase onto it — never parallel-edit a seam:

   | Seam | Touched by | Order |
   |---|---|---|
   | `api.ts` `refreshSessions`/`startSessionPolling` | SN-T2/T3 · PB-P2a (FX5) | **SN-T2 → SN-T3 → PB-P2a** |
   | sidebar render paths (`sidebar.ts`, `render-helpers.ts`, nesting) | SN-T5/T6/T7 · PB-P2c (FX7) | SN first; PB-P2c after or rebased |
   | `session-manager.ts` / `session-setup.ts` | CS-R\*/D\*/P3 · CE-G3 · EP G1.3/G1.4 | CS merge-map order governs; CE/EP confine edits to named functions and rebase |
   | `goal-trigger-dispatcher.ts` push triggers (`gate_failed`/`session_errored`) | GA-R2 · MC-P4 · AI-P1 | land once in GA-R2 |
   | `activity-store.ts` / `recordActivity()` | MC-P3 · MC-P2 · AI-P5 | land in MC-P3; earlier callers stub |
   | `auxiliary.*` model-slot config | AI-P2 · GA-R4 · CE-G6.1 | one shape ([per-role-model-overrides.md](per-role-model-overrides.md)); first lander defines it |
   | `verification-harness.ts` | CE-G3.3 · CE-G5.2 (CI-2's gate-consumption is a recorded follow-up, NOT in CI-2) | sequence per CE doc |
   | tool-activation in `session-setup.ts` | CI-1/2/3 · EP G1.4 · CS | confine to named functions; rebase order per wave |
   | EP G8 capability registry | CI-7 consumes | CI ships a local shim until G8 merges; swap PR after |
5. **Tracking discipline.** Tick the §4 row **in the merging PR**; update the owning doc's
   `Status:` line when a workstream's parent goal completes. The orchestrating session
   treats merged-but-unticked as a bug.

## §2 Dependency graph

```mermaid
graph TD
    subgraph "independent lanes — start day one"
        CS[CS waves R1→…→T2<br/>per its §7 merge map]
        SN1[SN-T1/T2/T4/T8/T9] --> SN2[SN-T3, T5] --> SN3[SN-T6, T7]
        CE[CE-G0 → CE lanes per its §6]
        EP[EP G1→G9 per its goal map]
        PB0[PB-P0 harness] --> PB1[PB-P1a/b animations]
        GA2[GA-R2 triggers]; GA3[GA-R3 standing orders]
    end
    SN2 --> PB2[PB-P2a-d timers/renders] --> PB3[PB-P3 battery saver]
    PB1 --> PB2
    MC0[MC-P0 global scope] --> MC1[MC-P1 sessions+sidebar] --> MC2[MC-P2a/b meta-tool]
    MC1 --> MC3[MC-P3 flight recorder]
    MC2 --> MC4[MC-P4a/b pack+crew]; MC3 --> MC4; GA2 --> MC4
    MC4 --> MC5[MC-P5 briefing/onboarding/budgets]
    MC0 --> AI1[AI-P1 substrate]; GA2 --> AI1
    AI1 --> AI2[AI-P2a/b Improver] --> AI3[AI-P3a/b curator+dreaming]
    MC4 --> AI2; MC3 --> AI5
    AI2 --> AI4[AI-P4 shadow] --> AI5[AI-P5 autonomy] --> AI6[AI-P6 measurement]
    GA6[GA-R6 importers] --> EP
    GA5[GA-R5 user profile] -.coordinate.- EP
```

**Day-1 starter set** (parallel, no collisions): AGENTS.md trim (§5) · CS-R1 · SN-T1 ·
PB-P0 · CE-G0.1 · EP G1.1 · GA-R2 · GA-R3.

## §2.1 THE ORDER — waves (the operational answer to "what do we work on now?")

The §2 graph is the truth about *dependencies*; this section is the truth about *sequence*.
A wave starts only when its blocking entries from the previous wave are merged (non-blocking
stragglers from an earlier wave may continue in parallel). Within a wave, everything is
parallel-safe **provided the §1.4 seam table is respected**.

```mermaid
flowchart TD
    W0["WAVE 0 — prereq (hours)
    AGENTS.md trim → suite green"]
    W1["WAVE 1 — foundations, all parallel
    CS-R1 (outage fix) · SN-T1 (pin tree builders)
    PB-P0 (perf baseline) · CE-G0.1 (cost ledger)
    EP G1.1 (manifest v2) · GA-R2 (triggers) · GA-R3 (standing orders)"]
    W2["WAVE 2 — hygiene + scope
    CS: H1‖H2 → R2 → R5‖R6 (its §7 order)
    SN: T2 → T3, T4 · PB: P1a → P1b
    CE: G0.2, G0.3, G1.0 · EP: G1.2 → G1.3
    MC: P0 → P1 · GA: R9, R6 (anytime)"]
    W3["WAVE 3 — spines
    CS: R3 → R7 → R4 → R8‖R9 · SN: T5 (the big one), T8, T9
    PB: P2a (after SN-T2/T3) → P2b → P2d
    CE: post-G1.0 lanes (G2, G7; BENCH-gated G4/G5 wait for G0.3)
    EP: G1.4 → G1.5 → G1.6 · MC: P2a → P2b, P3 · AI: P1
    CI: CI-1 (ast tools) · CI-2 (diagnostics)"]
    W4["WAVE 4 — features on the spines
    SN: T6, T7 · PB: P2c (after SN-T5) → P3
    CS: waves 2–4 (D*, P*, T*) · EP: G2 → G3
    MC: P4a → P4b · AI: P2a → P2b · GA: R4, R5 (R5 prefers EP G1.6)
    CI: CI-3 (LSP supervisor) → CI-5 (repo map)"]
    W5["WAVE 5 — the loop closes
    AI: P3a → P3b → P4 → P5 → P6 · MC: P5
    EP: G4…G9 · CE: remaining BENCH-gated goals
    CI: CI-4 (language packs) · CI-6 (services chip + graphify viz) · CI-7 (capability swap + BENCH)"]
    W0 --> W1 --> W2 --> W3 --> W4 --> W5
```

Milestones the waves deliver (what the user can feel):

| After | The product visibly gains |
|---|---|
| Wave 1 | green suite, cost + perf both measurable, staff can fire one-shot/`gate_failed` triggers |
| Wave 2 | battery: idle tab stops animating; sidebar races hardened; Mission Control entry exists |
| Wave 3 | `bobbit` meta-tool live (chat can run everything); flight recorder visible; one nesting render path |
| Wave 4 | system-staff crew + dashboard; human-in-the-loop self-improvement proposing skills |
| Wave 5 | dreaming, calibrated autonomy with revert/demotion, briefing + onboarding; EP ecosystem complete |

**Rule of thumb for the orchestrator:** at any moment, prefer (1) the lowest-numbered
unfinished wave, (2) within it, the entry that unblocks the most §2 edges, (3) never two
in-flight goals on the same §1.4 seam.

## §3 Lanes and PR slicing

Effort: S ≤ 1 day · M ≤ 3 days · L ≈ a week. EP, CE, and CS are **not re-sliced here** —
their own docs already slice to mergeable units; follow them verbatim (EP goal map order;
CE lanes with BENCH gates; CS §7 merge-map order). The lanes below slice the remaining
workstreams:

### Lane SN — sidebar/nesting ([sidebar-goal-nesting-audit.md](sidebar-goal-nesting-audit.md) §4; one PR per task)

T1 (M, no deps) → T2 (M) → T3 (S) → T4 (M) → T5 (L, after T1+T4) → T6 (M) → T7 (S) →
T8 (S, independent) → T9 (S, independent). T2/T3/T5/T7 gate PB-P2 (§1.4).

### Lane PB — perf/battery (execute from [client-performance-battery-implementation-plan.md](client-performance-battery-implementation-plan.md))

| PR | Scope | Effort | Mergeable because |
|---|---|---|---|
| PB-P0 | `perf-monitor.ts` + baseline table | S | flag-gated, zero behavior change |
| PB-P1a | `animation-power.ts` + CSS gates (A.1 table) + pinning test | M | default-on flag, kill switch |
| PB-P1b | FX3 box-shadow→opacity rewrites + blanket reduced-motion | S | pure CSS, visually identical |
| PB-P2a | FX5 poll demotion *(after SN-T2/T3)* | S | behavior identical while WS down |
| PB-P2b | FX6 scoped verification tick | S | dashboard-local |
| PB-P2c | FX7 `renderAppThrottled` + streaming sites *(after/rebased on SN-T5)* | M | flag-gated |
| PB-P2d | FX8 timer audit + convicted-loop fixes | M | per-loop independent |
| PB-P3 | battery-saver mode + flag-soak removal + after-table | M | additive setting |

### Lane MC→AI — Mission Control then autoimprovement (execute from [mission-control-implementation-plan.md](mission-control-implementation-plan.md), [autoimprovement-implementation-plan.md](autoimprovement-implementation-plan.md), [gap-easy-wins-implementation-plan.md](gap-easy-wins-implementation-plan.md))

| PR | Scope | Effort | Mergeable because |
|---|---|---|---|
| GA-R2 | `at` one-shot + `gate_failed`/`session_errored` triggers (schema in gap doc §5) | M | additive trigger types |
| GA-R3 | standing-orders template + staff-assistant guidance | S | docs+prompt only |
| MC-P0 | global scope + `PersistedStaff.global` (A.1–A.2) | M | invisible until MC-P1 |
| MC-P1 | global sessions + sidebar top entry + E2E | M | complete visible feature |
| MC-P2a | meta-tool registry + catalog pinning test (A.3) | M | server-only |
| MC-P2b | `defaults/tools/bobbit/` + tiers + policy wiring + e2e | M | ships complete with guards |
| MC-P3 | activity store + REST/WS + panel (A.4) | M | immediate audit value |
| MC-P4a | mission-control pack: roles/skills/templates + panel (A.5) | M | installs; crew inert |
| MC-P4b | "create crew" bootstrap + crew E2E + Caretaker dry-run | M | completes crew |
| AI-P1 | improvement store + `propose_improvement` + panel kind (A.1–A.3) | L | manual proposals useful alone |
| AI-P2a | judge + learned-skills pack bootstrap + usage hook | M | inert until Improver |
| AI-P2b | Improver role + post-goal review + e2e | M | human-in-loop learning complete |
| AI-P3a | curator (lifecycle/snapshots/pin/dry-run) | M | maintenance standalone |
| AI-P3b | dreaming job + Archivist wiring | M | config-gated |
| AI-P4 | shadow mode + calibration report | M | zero autonomy granted |
| AI-P5 | levels/thresholds + policy path + revert + demotion + kill switch | L | ships OFF (levels 0) |
| AI-P6 | outcome evaluator + regression demotion | M | completes loop |
| MC-P5 | briefing + onboarding + budgets (3 sub-PRs allowed) | L | each sub-PR standalone |
| GA-R4 | away-summary slice | M | independent; shared `auxiliary.*` |
| GA-R5 | bounded user-profile memory | M | coordinate w/ EP `session-memory` |
| GA-R6 | hermes/openclaw skill import adapters | M | marketplace seam |
| GA-R9 | `bobbit doctor` | M | standalone CLI |

## §4 Master checklist (tick in the merging PR)

- **Prereq**: [ ] AGENTS.md trim (§5)
- **CS** (its §7 order): [ ] R1 · [ ] H1 · [ ] H2 · [ ] R2 · [ ] R5 · [ ] R6 · [ ] R3 · [ ] R7 · [ ] R4 · [ ] R8 · [ ] R9 · [ ] D1 · [ ] D2 · [ ] D3 · [ ] D4 · [ ] D5 · [ ] D6 · [ ] D7 · [ ] D8 · [ ] D9 · [ ] P1 · [ ] P2 · [ ] P3 · [ ] P4 · [ ] T1 · [ ] T2
- **SN**: [ ] T1 · [ ] T2 · [ ] T3 · [ ] T4 · [ ] T5 · [ ] T6 · [ ] T7 · [ ] T8 · [ ] T9
- **PB**: [ ] P0 · [ ] P1a · [ ] P1b · [ ] P2a · [ ] P2b · [ ] P2c · [ ] P2d · [ ] P3
- **CE**: [ ] G0.1 · [ ] G0.2 · [ ] G0.3 · [ ] G1.0 · [ ] G1.1 · [ ] G1.2 · [ ] G2.1 · [ ] G2.2 · [ ] G3.1 · [ ] G3.2 · [ ] G3.3 · [ ] G4.1 · [ ] G4.2 · [ ] G4.3 · [ ] G5.1 · [ ] G5.2 · [ ] G6.1 · [ ] G7.1
- **EP**: [ ] G1.1 · [ ] G1.2 · [ ] G1.3 · [ ] G1.4 · [ ] G1.5 · [ ] G1.6 · [ ] G2.1 · [ ] G2.2 · [ ] G2.3 · [ ] G3.1 · [ ] G3.2 · [ ] G3.3 · [ ] G4 · [ ] G5 · [ ] G6 · [ ] G7 · [ ] G8 · [ ] G9
- **GA**: [ ] R2 · [ ] R3 · [ ] R4 · [ ] R5 · [ ] R6 · [ ] R9
- **MC**: [ ] P0 · [ ] P1 · [ ] P2a · [ ] P2b · [ ] P3 · [ ] P4a · [ ] P4b · [ ] P5
- **AI**: [ ] P1 · [ ] P2a · [ ] P2b · [ ] P3a · [ ] P3b · [ ] P4 · [ ] P5 · [ ] P6
- **CI**: [ ] CI-1 · [ ] CI-2 · [ ] CI-3 · [ ] CI-4 · [ ] CI-5 · [ ] CI-6 · [ ] CI-7 ·
  language-pack cards: [ ] lsp-go · [ ] lsp-rust · [ ] lsp-csharp · [ ] lsp-fsharp · [ ] lsp-jvm · [ ] lsp-clangd · [ ] lsp-kotlin
- **Cards** (post-dependency, owner-accepted): [ ] Caretaker transcript-retention consolidation pass (distill→prune; after EP G2 + MC P3; [agent-memory.md §1](agent-memory.md))

## §5 Prerequisite fix (before any lane)

`tests/agents-md-budget.test.ts` fails on the branch base: AGENTS.md is 6,233 bytes vs the
6,144 budget. One S-size PR: move detail into `docs/`, get the suite green. Every lane
starts from green.

## §6 Doc-format contract (parity rule for any future design doc in this program)

Every workstream doc must carry, and these eight do:

1. A `Status:` line (state + baseline commit where relevant) and a **workstream pointer to
   this file**.
2. A hand-off backlog where each task names: owned files (NEW vs modified), diagnosis or
   contract reference, the fix/steps, tests to author first, acceptance criteria.
3. Exact contracts for anything an implementer would otherwise invent (types, catalogs,
   schemas, directory layouts) — in the doc body or an `Appendix A`.
4. Anchors by **symbol name** with a verified-at baseline, and the §1.1 stop-rule when an
   anchor is missing.
5. Seam-overlap warnings pointing at §1.4 of this file.

A new design doc that lacks any of these is not ready to enter §3/§4.
