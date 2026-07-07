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
| Behaviours mutation-tested (content mutants) | 4 |
| Real holes found | 4 |
| **Real holes CLOSED (ported + re-verified v2-caught)** | **4** |
| Null-mutant integrity checks passed | 1 (BR50-null-A) |

> **Report freshness:** the committed `browser-chaos-report-clusterA.md` reflects
> the batch-A1 `--all` run (null + BR46 + BR48). Batch A2 (BR51, BR52) was verified
> via `--ids` (both `v2: caught`, 0 holes) but that overwrites the report, so the
> file was restored to the A1 `--all` output. A full `--corpus clusterA --all`
> regeneration over all 5 corpus entries is **pending at resume** (deferred: the
> machine was handed back for a concurrency study). The `.profiles/chaos` JSON
> doubles hold the per-batch evidence.

## Batch A1 (BR46, BR48) — 2 holes closed

Ported the two confirmed-open holes handed off in `browser-porting-handoff.md`
§2. Both re-verified `v2: caught`, 0 real holes.

| Mutant | Domain | File | Ported journey assertion |
|---|---|---|---|
| BR46 | misc (workflow-editor) | `src/app/workflow-page.ts` | seed workflow → `#/settings/<pid>/workflows` → open editor → expand gate + verify-step → `wf-step-type` select visible AND option values == `[command, llm-review, agent-qa, human-signoff]` |
| BR48 | misc (roles tab) | `src/app/proposal-panels.ts` | goal-assistant → GOAL_PROPOSAL → Roles tab → panel + Customize visible → click Customize → `goal-proposal-role-reset` visible |

Harness integrity: **BR50-null-A** (whitespace-insensitive no-op in
`workflow-page.ts`) — both suites still passed (neither falsely caught).

## Batch A2 (BR51, BR52) — 2 holes closed

Both confirmed real holes (legacy-caught, journey-missed), ported into the misc
journey, re-verified `v2: caught` (0 holes). Clean-passed on unmutated dist
first.

| Mutant | Domain | File | Ported journey assertion |
|---|---|---|---|
| BR51 | misc (prompt-stats) | `src/ui/components/AgentInterface.ts` | send msg → agent "OK" → stats bar contains `mock-model`; context `span[title*='Context:']` visible with `\d+%` and `title=/Context:.*tokens/`; stats bar contains `$` |
| BR52 | misc (preview new-tab) | `src/app/render.ts` | after preview mount: `a[title="Open preview in new tab"]` href matches `/preview/<sid>/journey.html` with NO `?#mtime=`; Refresh button click bumps iframe `src` cache-buster |

Mutation results (via `--ids BR51,BR52`): legacy caught 2/2, v2 caught 2/2, 0
real holes.

## Resume point

- **Last committed batch:** A2 (BR51, BR52) ports committed; corpus has
  `BR50-null-A, BR46, BR48, BR51, BR52` (all closed/passing).
- **On resume, first action:** `node scripts/testing-v2/browser-chaos.mjs
  --corpus clusterA --all` to regenerate the authoritative 5-entry report, then
  commit it.
- **Next behaviour to mutation-test:** misc `compaction-summary-card`
  (`compaction-persistence.spec.ts` → seed sidecar via `gateway.bobbitDir`,
  assert card count 1 + `data-state="complete"` + survives reload). Then continue
  through app-smoke (palette-session, sidebar-keyboard-nav, open-session-new-window),
  sidebar-nav (search goal-title match / Full Search nav), prompt-interaction
  (queue-ui, at-mention chip), stories-registry (stories-sidebar Ctrl+K filter,
  stories-projects PR-10) per the audit REC entries.
