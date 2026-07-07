# Browser-chaos porting — Cluster A tally (UI-surface)

Cluster A journeys (STRICT OWNERSHIP): `app-smoke`, `misc`, `sidebar-nav`,
`prompt-interaction`, `stories-registry`.

Disjoint corpus: `tests2/chaos/browser-mutants-clusterA.json` (ids BR50+, plus
the two open holes BR46/BR48 copied from the canonical corpus). Runner:
`node scripts/testing-v2/browser-chaos.mjs --corpus clusterA …`. Authoritative
report: `docs/testing-v2/browser-chaos-report-clusterA.md`.

Loop per behaviour: add mutant → run → if real hole (legacy-caught,
journey-missed) port the assertion into the owning journey (never weaken) →
re-run to confirm v2-caught. `retries: 0`.

> **Harness note:** `browser-chaos.mjs` runs the v2 journeys from an ephemeral
> `git worktree … HEAD`, so journey edits MUST be committed before a mutant
> re-run reflects them (uncommitted edits run the pre-edit HEAD → false "missed").

## Cumulative tally (Cluster A)

| | Count |
|---|------:|
| Behaviours mutation-tested (content mutants) | 2 |
| Real holes found | 2 |
| **Real holes CLOSED (ported + re-verified v2-caught)** | **2** |
| Null-mutant integrity checks passed | 1 (BR50-null-A) |

## Batch A1 (BR46, BR48) — 2 holes closed

Ported the two confirmed-open holes handed off in `browser-porting-handoff.md`
§2. Both re-verified `v2: caught`, 0 real holes.

| Mutant | Domain | File | Ported journey assertion |
|---|---|---|---|
| BR46 | misc (workflow-editor) | `src/app/workflow-page.ts` | seed workflow → `#/settings/<pid>/workflows` → open editor → expand gate + verify-step → `wf-step-type` select visible AND option values == `[command, llm-review, agent-qa, human-signoff]` |
| BR48 | misc (roles tab) | `src/app/proposal-panels.ts` | goal-assistant → GOAL_PROPOSAL → Roles tab → panel + Customize visible → click Customize → `goal-proposal-role-reset` visible |

Harness integrity: **BR50-null-A** (whitespace-insensitive no-op in
`workflow-page.ts`) — both suites still passed (neither falsely caught).
