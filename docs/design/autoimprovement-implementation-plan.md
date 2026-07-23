# Autoimprovement — Implementation Plan (hand-off)

Status: ready for execution, not started. Workstream **AI** in
[fable-program-execution-plan.md](fable-program-execution-plan.md).

Companion to [autoimprovement.md](autoimprovement.md) (the WHAT/WHY — read §1–§6 and
**Appendix A** before implementing; the §2 change-class table and §5 ladder guard rails are
LAW — enforce in code, not prompts).

> **Anchor baseline:** fable-docs @ 2026-06-11 (master parent `6ec8c8f9`). Locate by symbol
> name; missing symbol ⇒ STOP and re-derive from the cited pattern, never improvise.
>
> **Precision policy:** AI-P1/P2 file/function level; AI-P3…P6 contract level (substrate
> created by P1/P2) — re-verify anchors first.
>
> **Universal rules:** [extension-platform-implementation-plan.md §0](extension-platform-implementation-plan.md)
> + [fable-program-execution-plan.md §1](fable-program-execution-plan.md). Depends on:
> MC-P0 (global scope) for the Improver staff home; GA-R2 (push triggers — shared seam,
> land there); MC-P3 (flight recorder — stub until it lands, like MC-P2a does).

---

## Goal map

```
AI-P1 substrate ─→ AI-P2a judge+pack ─→ AI-P2b Improver ─→ AI-P3a curator ─→ AI-P3b dreaming
                                        AI-P2b ─→ AI-P4 shadow ─→ AI-P5 autonomy ─→ AI-P6 measurement
```

---

## AI-P1 — Proposal substrate

**Outcome:** an `ImprovementProposal` can be created by a tool, rendered in the proposal
panel with diff + evidence, decided by a human, and queried over REST. Nothing automatic.

**Owned files:** NEW `src/server/agent/improvement-store.ts`; NEW
`defaults/tools/proposals/propose_improvement.yaml` (+ wiring in that group's
`extension.ts`); `src/app/proposal-registry.ts` + the proposal panel render path;
`server.ts` (routes); NEW `tests/improvement-store.test.ts`,
`tests/e2e/improvements.spec.ts`, `tests/e2e/ui/improvement-proposal.spec.ts`.

**Steps**

1. `improvement-store.ts`: implement the types from autoimprovement.md Appendix A.1
   **verbatim** (copy the interfaces; do not rename fields). JSONL at
   `.bobbit/state/improvement/proposals.jsonl`: append-only, status change = append full
   record same `id`, last-writer-wins on load; crash-safe write per
   [session-store-crash-safety.md](session-store-crash-safety.md). Export
   `createProposal`, `decideProposal`, `listProposals`, `getProposal`.
2. Enforce the §2 ceilings **in `decideProposal`**: `decision.by === "policy"` is rejected
   outright in this phase (autonomy is AI-P5); class validation rejects unknown
   `ChangeClass`.
3. REST per Appendix A.2: `GET /api/improvements`, `POST /api/improvements`,
   `POST /api/improvements/:id/decision`. (`/revert` and `/calibration` come later — do
   not stub routes.)
4. Tool: `propose_improvement.yaml` mirroring `propose_staff`'s YAML shape in
   `defaults/tools/proposals/` (params per Appendix A.3:
   `change_class, title, diff?, files?, evidence`); provider `bobbit-extension` calling
   `POST /api/improvements`.
5. Client: extend `ProposalType` union (`src/app/proposal-registry.ts:21`), add
   `"improvement"` to `PROPOSAL_TYPES` (`:23`), and register a `ProposalTypePlugin`
   (`:60`, registry at `PROPOSAL_TYPE_REGISTRY:277`) rendering: title, change-class badge,
   evidence bundle (signal, session links, excerpts), unified diff (reuse the existing
   proposal diff component — see `src/app/project-proposal-diff.ts`), Approve / Reject
   (+required reason on reject). Inline editing rides the editable-proposals machinery —
   reuse, don't fork ([editable-proposals.md](editable-proposals.md)).

**Tests (author first; RED unless noted)**

- Unit: store round-trip; status append/last-writer-wins; crash-mid-append load; unknown
  class rejected; `by: "policy"` rejected.
- API E2E: create → list → decide(approve) → status `approved-human`;
  decide(reject, no reason) → 400.
- Browser E2E: hand-POST a proposal; panel renders class badge + diff + evidence; reject
  persists reason across reload.

**Acceptance:** all green; proposal-panel suites for existing types green unmodified;
`tests/test-phase-invariant.test.ts` green (new tests land in the right phases).

---

## AI-P2a — Judge + learned-skills pack (inert plumbing)

**Outcome:** proposals get judged confidence scores; an approved `skill-new` lands as a
staged skill in a server-scoped `learned-skills` pack; skill usage is tracked. No staff yet.

**Owned files:** NEW `src/server/agent/improvement-judge.ts`; NEW
`src/server/agent/learned-skills-pack.ts`; skill-usage hook in
`src/server/agent/slash-skills.ts` (one call site); NEW `tests/improvement-judge.test.ts`,
`tests/learned-skills-pack.test.ts`.

**Steps**

1. `improvement-judge.ts`: `judgeProposal(p) → {confidence, rubricVersion, model}` — one
   non-streaming aux-model call. Model resolution: the `auxiliary.improver-judge` slot
   (Appendix A.4); **first lander defines the `auxiliary.*` config shape** per execution
   plan §1.4 — follow [per-role-model-overrides.md](per-role-model-overrides.md)
   conventions for resolution + fallback-to-main-model on `auto`. Rubric text loaded from
   the pack path (Appendix A.3), keyed by `ChangeClass`; missing rubric ⇒ judge returns
   no score (never throws). Judge result appended onto the proposal record.
2. `learned-skills-pack.ts`: create-on-first-use server-scoped pack (resolver scope order
   already supports it — see `pack-types.ts` scope order in EP plan §0.1); approved
   `skill-new.files[]` written under it with a `staged: true` marker the skills catalog
   renders as `[learned — staged]`; `pack_activation` per-entity disable must work on
   these like any pack skill (pin it).
3. Usage hook: where `slash-skills.ts` resolves/loads a skill, append
   `{skillName, sessionId, ts}` to `.bobbit/state/improvement/skill-usage.jsonl`
   (cheap fire-and-forget; this feeds AI-P3 lifecycle and AI-P6).

**Tests:** judge — rubric routing per class, `auto` fallback, missing-rubric no-throw
(mock the model client; no live LLM in unit/e2e). Pack — approve `skill-new` ⇒ skill
resolvable with staged marker; `pack_activation` disable works; usage hook appends once
per load. *(RED)*

**Acceptance:** green; pack-resolver and skills suites green unmodified.

## AI-P2b — The Improver (human-in-the-loop learning live)

**Outcome:** archiving a goal with correction signals produces a judged
`propose_improvement` in the panel, end-to-end, with a human deciding.

**Owned files:** Improver role + skills + rubrics inside
`market-packs/mission-control/` (coordinate with MC-P4a — if it hasn't landed, this PR
creates the pack skeleton per mission-control.md Appendix A.5 and MC-P4a extends it);
trigger wiring only via existing staff machinery; NEW `tests/e2e/improver-loop.spec.ts`.

**Steps**

1. Improver role prompt = autoimprovement.md §1a heuristics **verbatim** (active stance,
   corrections-first, umbrella shape, patch-first order 1→4) + standing-orders charter
   (GA-R3 format) + §3 evidence-bundle requirements. Lives in the pack, never in server
   source.
2. Staff template: `global: true`, role above, triggers `goal_archived` + `gate_failed`
   (from GA-R2) + weekly `schedule`, all **disabled by default** (mission-control.md §5).
3. Tool whitelist via role `toolPolicies`: read/search tools + `propose_improvement`
   ONLY (the Hermes fork-whitelist discipline, §1a). Pin: Improver role cannot call
   write/bash tools.
4. Wire judge: `POST /api/improvements` triggers `judgeProposal` asynchronously; panel
   shows confidence when present.

**Tests:** API E2E with a mock agent (existing mock-agent harness): seed a session
transcript containing a planted correction ("stop doing X"); archive the goal; assert an
inbox entry fires, the Improver session's proposal appears with evidence excerpts
referencing the planted text, judge score attached; approving creates the staged skill
(AI-P2a path). Tool-whitelist pin: Improver session denied a bash call. *(RED)*

**Acceptance:** the full observe→propose→judge→human-approve→staged-skill path green with
zero live-LLM dependence in CI (mock agent + mocked judge).

---

## AI-P3a — Curator · AI-P3b — Dreaming *(contract level — re-verify anchors)*

Contracts: autoimprovement.md §1b (Hermes semantics: deterministic transitions, bounded
LLM pass, never-delete, pin, snapshot+rollback, dry-run, first-run grace), §4 lifecycle
states, Appendix A.1 (lock/snapshot paths), A.4 (config defaults), A.5 (owned files).

- **P3a:** `improvement-curator.ts` — `runCurator({dryRun})`: phase 1 deterministic
  (usage-file derived `active→stale→archived`, timings from config; `pinned` exempt;
  archive = move under `skill-archive/`, never delete); phase 2 bounded aux-model pass
  emitting `skill-lifecycle`/`skill-patch` **proposals** (Bobbit divergence from Hermes:
  no direct writes — §1 adopt/adapt table). tar.gz snapshot before any apply; REST:
  pin/unpin/restore/dry-run + snapshot list/rollback; staff-page controls. First-run
  seeds `lastRunAt = now`. Tests: fake-clock transitions; snapshot/rollback round-trip
  (incl. rollback-of-rollback); dry-run mutates nothing (tree hash compare); pinned
  untouchable.
- **P3b:** dreaming = Archivist staff scheduled wake whose gate check
  (`time → new-transcripts-count → dream.lock`, autoDream ordering from §1) runs
  server-side **before** the staff is woken (cheap gates outside the LLM); the wake mines
  recent transcripts (read_session/search whitelist) and emits `memory`/`skill-new`
  proposals. Tests: gates closed ⇒ no wake; lock prevents concurrent dream; dream run
  writes a flight-recorder entry.

**Acceptance:** staged skill ages stale→archived→restored across fake-clock runs; dreams
appear in the activity panel; zero direct skill mutations anywhere in P3 paths.

## AI-P4 — Shadow calibration *(contract level)*

Contract: §5 L0.5 + Appendix A.2 calibration endpoint. Judge runs on every proposal
(AI-P2b already does); `decideProposal` stores
`(confidence, wouldAutoApproveAt: thresholds[], humanDecision)`; `GET
/api/improvements/calibration?class` computes the per-threshold agreement matrix; Improver
staff page renders it ("at θ=0.85: 94% agreement, 1 false-approve / 31"). Tests: matrix
math unit tests with seeded decisions; endpoint e2e. **Zero auto-applies — pin it** (a
test that a high-confidence proposal still requires a human decision at level 0.5).

## AI-P5 — Graduated autonomy *(contract level)*

Contracts: §5 ladder + guard rails, Appendix A.4 keys, A.2 `/revert`. Server-side ceiling
clamp (config requesting L1 for `prompt-context` ⇒ rejected with 400 — pin); policy path
in `decideProposal` (`by: "policy"` now legal when class level + threshold + ceiling all
pass); apply with snapshot; flight-recorder entry `improvement.auto-approved` with
`revert` ref; inbox digest of auto-approvals; `POST /api/improvements/:id/revert`
restores snapshot + appends `reverted` + **demotes the class one level** (persisted in
config store); global kill switch (`autoimprovement.enabled: false` ⇒ everything behaves
as L0). Tests: e2e auto-apply happy path; revert demotes; ceiling clamp; kill switch;
every policy decision visible in activity feed.

## AI-P6 — Measurement loop *(contract level)*

Contract: §6. Scheduled evaluator pass (inside the curator run) computes
`helped/neutral/regressed` per applied change from: skill-usage + post-use goal/gate
outcomes, recurrence of the originating correction signal, cost deltas when CE-G0.1's
ledger exists (omit cleanly when absent). `regressed` ⇒ flight-recorder entry + automatic
demotion + an auto-generated revert proposal (NOT auto-revert). Test: planted regression
fixture (staged skill whose sessions then fail a gate) detected and demoted within one
evaluation window (fake clock).

**Program acceptance (AI complete):** with levels at defaults (0) the system only ever
proposes; raising `skill-new` to 1 after shadow calibration auto-applies high-confidence
drafts, every one visible and revertible in the activity panel; killing the switch stops
all autonomy instantly. All suites green; no flaky tests.
