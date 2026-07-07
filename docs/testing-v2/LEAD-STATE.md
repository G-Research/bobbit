# TEAM-LEAD RESUME STATE (read this first after any compaction/restart)

Goal: **Sub-3-min test suite rebuild** (id `6c956ecf-...`). Branch `goal/sub-3-min-test-6c956ecf`.
PR **#935** (base master). This doc is the lead's source of truth; the preview dashboard is only a user summary.
Update this doc whenever state materially changes.

## Where we are (gate DAG: 8/12 passed)
Passed: baseline-inventory, design-doc, di-runtime, v2-foundation, mass-migration, browser-tier, parity-proof, **chaos-proof**.
Open: **concurrency-proof** (pending — see Decisions), then **switchover** → **daily-lane** → **review-findings**.
Only the LEAD signals gates. Signal from goal HEAD after merging member branches (verification runs from goal.cwd HEAD).

## Goal HEAD / PR
- Goal HEAD as of writing: **17d8022b** (may advance). PR mergeable, **0 behind master**.
- STANDING USER DIRECTIVES: (1) keep the preview HTML dashboard updated at milestones; (2) keep the PR mergeable + current with master — re-merge origin/master whenever it advances (it moves often; each sync = a coder resolves conflicts + represents new master tests in v2, then I merge+push).

## Settled decisions (full text in docs/testing-v2/design.md §D7/§D8/§D9; plus:)
- **D7** budget/reliability: single isolated `test:v2` < 5 min (achieved: **251s green**); under 5-way load < 10 min + 0 flakes; budgets = honest measured, never padded.
- **Chaos-fix**: Option A (narrow junction-safety fix) — DONE + verified.
- **D8** browser coverage confidence = switchover prerequisite (mutation + audit + coverage-delta).
- **D9** concurrency: capped at 3 — BUT measured 3-way ALSO fails (see below). SUPERSEDED/OPEN.
- **Coverage closure**: triage-by-mutation, port hybrid, KEPT IN THIS GOAL (comprehensive bounded pass).

## OPEN USER DECISIONS
1. **Concurrency bar** — UNRESOLVED. Measured: single 251s green; 5-way ~800–960s FAIL; 3-way ~570–697s 0/9 FAIL. **CORRECTED ROOT CAUSE (gateway-cost study, docs/testing-v2/gateway-cost-feasibility.md, DONE):** NOT gateway boots — the gateway is already a per-fork singleton (895 integration tests → 6 boots; boot ~470ms lean). The real concurrency killer = the **verification-harness command-steps spawn cmd.exe child processes the LEDGER DOES NOT COUNT** → under N-way the true process count oversubscribes 24 cores → the ~6 heaviest verification tests (gate-reset-api, gates-api-heavy, verification-core, maintenance-api, gate-signal-progress, gate-resign-cancel) hit 60s timeouts. Secondary: ~11s/fork vitest transform of the src/server graph (startup spike). esbuild prebundle (~425ms vs ~11s) helps startup only → SPIN-OFF. **In-goal fix available:** make the ledger account for (or tests reduce) the verification spawns, and/or relocate the ~6 heaviest verification tests to daily. Re-ask posted with corrected options; decide, then implement + re-measure.
2. **Spin-off goal "Restore 5-way test:v2 concurrency"** — PROPOSED, awaiting user review.

## Current roster (verify with team_list; sessions die on restart)
- **test-engineer-1443** `c8bf9a3b-ef5b-4926-9fe4-72552ef12b1e` — task **144a0853** — GATEWAY-COST FEASIBILITY STUDY. Merged harness from branch `goal/6c956ecf/test-engineer-9980` (multi-worktree concurrency-proof.mjs + ledger Σ≤24 fix). Deliverable: docs/testing-v2/gateway-cost-feasibility.md (current boot model + measured cost; shared-gateway-per-fork vs lazy-boot prototype; expected concurrency impact; recommendation). NO gate signal.
- **coder-b93a** `b7246fe1-7364-4800-9428-91febd953950` — task **736906a3** — Browser porting CLUSTER A (journeys: app-smoke, misc, sidebar-nav, prompt-interaction, stories-registry). Corpus `tests2/chaos/browser-mutants-clusterA.json`, `browser-chaos.mjs --corpus clusterA`.
- **coder-51bf** `bfb9ce14-671a-4d2e-a628-e06e1f5b6cbb` — task **b6519897** — Browser porting CLUSTER B (journeys: proposals, goal-editing, project-settings, project-onboarding, team-operations, goal-team-gates, session-lifecycle). Corpus `browser-mutants-clusterB.json`, `--corpus clusterB`.
- Dismissed: coder-9092 (context limit, handoff captured), coder-d894 (master-sync done), coder-ce49/general-a479 (earlier).

## Browser-porting progress (the dominant remaining work; D8 prereq)
- Audit (docs/testing-v2/consolidation-assertion-parity.md): 151 consolidated specs, ~143 GAP/PARTIAL. Mutation showed ~50% of flagged behaviours are REAL holes (~70 est. total).
- Closed + verified so far: ~40 (handoff coder-9092 = 27; Cluster A ~4: BR46/48/51/52; Cluster B ~9: BR45/47/49/50/52/53/54/55/56). ~30 est. remaining.
- Method (proven): per audit-flagged behaviour → add mutant to cluster corpus → `browser-chaos.mjs --corpus <cluster>` → if legacy-caught & journey-missed (REAL hole) port the assertion into the owning journey → re-verify caught. v2 ≥ legacy; retries:0; junction-safe.
- Handoff/how-to: docs/testing-v2/browser-porting-handoff.md; tally: browser-chaos-porting-tally.md.
- BR26 both-missed (staff 'Wake prompt (required)' label) = pre-existing legacy gap, JUSTIFIED (not a regression).

## LEAD's own remaining tasks (do NOT delegate the merge/reconcile)
1. Collect cluster A + B branches into goal (ff/merge + push). Both edit DISJOINT journey files + SEPARATE corpus files → clean; only risk = BR id collisions (both seeded BR50+) → RENUMBER to unique ids when merging into the canonical `tests2/chaos/browser-mutants.json`.
2. Reconcile canonical browser-mutants.json + audit doc + tally after merging clusters.
3. Run ONE canonical `browser-chaos.mjs --all` full-verify → must show 0 REAL journey holes (the D8 gate).
3b. Produce an EXPLICIT burn-down checklist: all 143 audit-flagged behaviours (107 GAP + 36 PARTIAL from consolidation-assertion-parity.md) each marked mutated→{held | hole-closed | both-missed-justified}, so completeness is auditable at a glance (not inferred from per-cluster tallies). Second completeness axis = per-file V8 coverage-delta (coverage-delta.mjs) must show no per-area regression.
4. Resolve the concurrency bar (post gateway-cost study) + re-validate.
5. Reproducibility cleanup (see gotchas): remove `.npmrc shrinkwrap=false`, declare `tsx` in devDeps, fix the rollup optional-dep lockfile mismatch so `npm ci` yields a complete tree; fix pre-existing `tsc -p tsconfig.tests2.json` browser-fixture type errors.
6. Signal switchover (flip .bobbit/config/project.yaml unit/e2e → v2; rewrite docs/testing-strategy.md, testing-coverage.md, AGENTS.md; remove superseded policy) → daily-lane (staff daily trigger + runbook + one green tier-3 run) → review-findings → ready-to-merge.

## INFRA GOTCHAS (learned painfully — do not relearn)
- **Sweeper hard-resets goal.cwd to origin/<goal-branch>**: local merges/commits are WIPED unless PUSHED. Always `git push` immediately after merging to goal. If a merge "disappears", it was reset to origin — re-merge + push.
- **Verification caches command steps by commitSha**: a stale/poisoned cached result (e.g. an old campaign) is reused on re-signal at the same commit. BUST with a fresh commit (even `--allow-empty` won't help if tree identical → make a real/empty NEW-sha commit; a new merge commit works).
- **node_modules corruption**: chaos.mjs & browser-chaos.mjs junction node_modules into ephemeral worktrees; `unlinkNodeModulesJunction` unlinks the reparse point BEFORE any recursive delete. NEVER regress this — delete-through-junction wipes the shared tree (bricked agent spawning once). RCA: docs/testing-v2/node-modules-corruption-rca.md.
- **tsx** is undeclared; legacy/chaos legacy-tier uses `npx --no-install tsx`. **@earendil-works/pi-ai** (with `./oauth` subpath, dist/oauth.js) is needed for v2 tests that import the server graph; goal worktree nm can be incomplete → copy from primary `C:/Users/jsubr/w/bobbit/node_modules/@earendil-works/pi-ai` if missing.
- **API auth**: `BOBBIT_TOKEN` + `BOBBIT_GATEWAY_URL` env work for REST GET. PUT `/api/goals/:id` (edit goal spec) = **403 sandbox token cannot access** → cannot edit goal-spec prose; record decisions in design.md instead. `PUT` (not PATCH) is the goal-update verb.
- **git commit/push via Bash**: a trailer-injector mangles commands containing `(`/parens/certain text → use `git commit -F- <<'EOF' ... EOF` (heredoc) for messages, and run `git push` as its own bare command. Co-author trailer: `Co-authored-by: bobbit-ai <bobbit@bobbit.ai>`.
- **Machine**: single 24-core thermally-throttled box. Serialize heavy runs (5×3 proofs, chaos --all campaigns). Targeted browser-chaos runs are low-worker (~2 gateways) so 2–3 in parallel is fine (~6 boots << the ~15–20 that starves). Coordinate heavy runs through the lead.

## ETA
Switchover-ready ~2–3 working days (browser porting ~57% done + parallel; then concurrency/repro/switchover/daily/review). Legacy retired ~2 weeks after (14 consecutive green daily runs; legacy stays the gate/safety-net until then).
