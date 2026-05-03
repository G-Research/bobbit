# Bobbit vs Claude Code vs Hermes — Comparison Audit

Read-only research deliverable produced by the `Real-tasks comparison audit` supergoal.
The audit cross-checks every improvement claim in `bobbit-improvements.md` against the
actual source of three harnesses (Bobbit, Claude Code, Hermes Agent) and classifies each
goal as **real / partial / already-done / hallucinated / unverifiable** with `file:line`
citations.

## Contents

- [`real-tasks.md`](./real-tasks.md) — Phase C synthesis: executive summary, top-10 highest-confidence real tasks, per-priority verdict tables, hallucinations appendix, comparison.md discrepancies, and ready-to-spawn next-step goal stubs. **Start here.**
- [`audits/`](./audits/) — Phase A independent capability inventories per harness:
  - [`bobbit.md`](./audits/bobbit.md)
  - [`claude-code.md`](./audits/claude-code.md)
  - [`hermes.md`](./audits/hermes.md)
- [`findings/priority-0.md`](./findings/priority-0.md) … [`priority-14.md`](./findings/priority-14.md) — Phase B per-priority verifications. Each goal in `bobbit-improvements.md` is classified with citation-backed evidence.
- [`bobbit-improvements.md`](./bobbit-improvements.md), [`comparison.md`](./comparison.md), [`criteria.md`](./criteria.md) — input documents the audit was run against, included for traceability.

## How the audit was structured

Three sequential phases of parallel subgoals:

1. **Phase A — Independent harness audits** (3 parallel children, one per harness). Children produced fresh, bottom-up capability inventories without first reading the existing scoring docs, so the team-lead could later detect drift.
2. **Phase B — Priority-section verifications** (15 parallel children, one per Priority section in `bobbit-improvements.md`). Each goal cross-checked against Phase A audits + actual source.
3. **Phase C — Synthesis** (single child, fresh context). Consumed all 18 prior findings to produce `real-tasks.md`.

## Headline result

77 goals classified across 15 priorities — **63 real, 12 partial, 1 already-done, 0 hallucinated, 1 unverifiable**. The `bobbit-improvements.md` doc is well-grounded; the discriminator is "real vs partial vs already-done", not "real vs invented". See `real-tasks.md` §1 for the full table and §2 for the top-10 highest-confidence shippable tasks.
