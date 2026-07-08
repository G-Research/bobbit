# Concurrency: global-budget implementation + efficiency proof — HANDOFF

Fresh-agent brief. Prior de-flake agent (test-engineer-8605) dismissed after diagnosis;
its branch `goal/6c956ecf/test-engineer-8605` persists for reference (measurement notes in
its `concurrency-proof.md`, `measure-tier2.mjs`, ledger split experiments — REFERENCE ONLY,
do not assume its split changes are kept).

## Where we are
- Command-step DI seam: DONE (tier-1 command-step spawn exhaustion solved).
- Browser porting (D8): DONE (0 real holes, v2≥legacy). 
- Concurrency-proof is the last open gate. Single-run v2 = **299.7s wall / ~13 CPU-min** (vs legacy baseline ~2 CPU-hours/loop — the ~8× CPU win, from vitest shared-worker replacing per-file spawn+tsx transform tax).

## Diagnosis (from the dismissed agent — this is solid, build on it)
- Running **N full `test:v2` suites concurrently** oversubscribes the 24-core box. The flakes are a **broad rotating cast of timing-sensitive integration tests** starved by **transient GATEWAY-BOOT CPU bursts** (each v2-integration test boots an in-process gateway; many booting at once spike CPU and starve timing-sensitive work past its timeouts). Examples seen flaking: `verification-core`, `verification-harness-timeout` tree-kill, `goal-fanout-ws`, `config-cascade`, `transcript-path`, `project-reorder-api`, `multi-repo-goal`.
- **No static worker-split fixes this** (tried 1p/2p/4v+3p) — the bursts are transient and cross-run; static allocation can't prevent them.
- Browser tier is **gateway/IO-bound, not CPU-parallelism-bound**: 2 playwright workers ≈ 4 workers (~276s vs ~297s); 1 worker DOUBLES it (~550–710s). So don't starve playwright to 1.

## DECISION (user, settled): GLOBAL CONCURRENCY BUDGET
Implement a **cross-process global resource budget** shared across ALL concurrent `test:v2` runs. Heavy ops **acquire a lease → WAIT if saturated → release**, so the box is never oversubscribed at ANY N. **Accept higher wall-time (queuing) in exchange for near-zero flakes** — reliability > speed (user's explicit tradeoff). This makes flakiness structurally impossible at any N; the concurrency "bar" becomes *acceptable wall-time at N*, not a flake threshold (may revive 5-way / obviate the spin-off).
- **Gate the real contention sources:** primarily concurrent **gateway boots** (cap global in-flight boots regardless of active-run count); secondarily total **Chromium**. 
- **Reuse/extend the ledger** (`scripts/testing-v2/ledger.mjs`) — it already has cross-process filesystem registration of active runs. Turn it into a live lease/token pool (acquire/wait/release) rather than static per-run worker allocation.

## HARD CONSTRAINTS
- **Do NOT move ANY coverage to the daily lane** (user: daily = latent bugs). Fix flakes via the global budget + determinism (clock seam / observable-state waits); NEVER by relocation. (The prior agent's multi-repo-goal→daily was reverted / never merged.)
- No weakening/skipping/deleting assertions; no `test.slow()`/timeout/`retries` padding. retries:0.
- KEEP the determinism fixes already on goal (cherry-picked `824e8e4d`): event-bus → isolated singleFork project; steer-reconnect → durable-transcript assert.

## DELIVERABLES
1. **Global budget implemented** (gateway boots + Chromium gated, cross-process, acquire/wait/release).
2. **Re-measure 3/4/5-way × 3 reps** under the budget: per-N green rate (target ≈0 flakes at EVERY N), per-run wall (expected to rise — accepted), peak global resource ≤ budget. Update `docs/testing-v2/concurrency-proof.md` with real numbers; the story is "wall-time at N", not "flake threshold".
3. **EFFICIENCY PROOF (new, per user's strategic question "is v2 genuinely more efficient, including daily?"):** a committed head-to-head `docs/testing-v2/efficiency-comparison.md`:
   - v2 per-commit: single-run CPU-min + wall; wall-at-N under the budget (the queuing cost).
   - v2 daily-lane run: actual/estimated CPU-min + wall (build the daily bundle enough to time it).
   - Legacy baseline: CPU-min + wall per loop (from the goal's recorded baseline; re-measure if stale).
   - Verdict: is v2 (per-commit + daily) genuinely lower total CPU-min/loop and/or better concurrency headroom than legacy? Honest numbers; if it does NOT clearly favor v2, say so — that's a real finding the lead escalates before switchover.

Ping the lead before the heavy 5-way run. Do NOT signal any gate — lead reviews + signals.
