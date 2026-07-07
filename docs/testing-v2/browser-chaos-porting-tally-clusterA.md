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
| Behaviours mutation-tested (content mutants) | 8 |
| Real holes found | 8 |
| **Real holes CLOSED (ported + re-verified v2-caught)** | **8** |
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

## Batch A3 (BR53, BR54) — 2 holes closed

Both confirmed real holes, ported + re-verified `v2: caught` (0 holes).
Clean-passed on unmutated dist first.

| Mutant | Domain | File | Ported journey assertion |
|---|---|---|---|
| BR53 | misc (compaction) | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` | seed a success compaction sidecar under `gateway.bobbitDir/state/compaction-sidecar/<sid>.jsonl` → `[data-testid='compaction-summary-card']` count 1 + `data-state="complete"`, survives full reload |
| BR54 | sidebar-nav (full search) | `src/app/sidebar.ts` | fill `input[data-search]` = "testquery" → click "Full Search" → hash contains `#/search` and `testquery` |

Mutation results (via `--ids BR53,BR54`): legacy 2/2, v2 2/2, 0 real holes.
A1+A2 authoritative report committed separately (4/4 v2-caught).

## Batch A4 (BR55, BR56) — 2 holes closed

Both confirmed real holes, ported + re-verified `v2: caught` (0 holes).
Clean-passed on unmutated dist first (BR56's first port drafted a live-composer
chip assertion that was wrong — the chip only renders in a SENT message via the
snapshot path; fixed to send + reload before asserting).

| Mutant | Domain | File | Ported journey assertion |
|---|---|---|---|
| BR55 | app-smoke (open new window) | `src/app/session-actions.ts` | session row hover → actions trigger → popover menu item `open-new-window` → click → `window.open` captured `{url: <deepLink>, target: "_blank", features: "noopener"}` |
| BR56 | prompt-interaction (@-mention chip) | `src/ui/components/FileMentionChip.ts` | send `@notes.md` → user bubble contains `@notes.md` → reload → `.file-mention-chip-pill` chip visible |

Mutation results (via `--ids BR55,BR56`): legacy 2/2, v2 2/2, 0 real holes.

## Resume point

- **Last committed batch:** A4 (BR55, BR56) ports committed; corpus has
  `BR50-null-A, BR46, BR48, BR51, BR52, BR53, BR54, BR55, BR56` (all closed/passing).
- **Next behaviours to mutation-test:** sidebar-nav (sidebar-session-actions
  New/rename/terminate), stories-registry (stories-sessions S-01 empty/Send-disabled
  is BR24-done → try stories-projects delete-row / stories-streaming stop-pill),
  prompt-interaction (queue-ui pill when busy), app-smoke (palette-session) per
  the audit REC entries.
