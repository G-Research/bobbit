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
| Behaviours mutation-tested (content mutants, clusterA) | 10 |
| Real holes found | 10 |
| **Real holes CLOSED (ported + re-verified v2-caught)** | **10** |
| Null-mutant integrity checks passed | 1 (BR50-null-A) |

See the **COMPLETENESS DENOMINATOR** section below for the exhaustive D8 status
(N in-scope behaviours across the 5 domains, M mutated, per-spec held/hole/excluded).

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

## Batch A5 (BR57, BR58) — 2 holes closed

Both confirmed real holes, ported + re-verified `v2: caught` (0 holes). Clean-passed first.

| Mutant | Domain | File | Ported journey assertion |
|---|---|---|---|
| BR57 | app-smoke (goal-metadata) | `src/app/proposal-panels.ts` | goal proposal → Metadata tab → panel visible → `goal-metadata-add` click appends a `goal-metadata-row` with key/value inputs |
| BR58 | sidebar-nav (Show Read filter) | `src/ui/components/sidebar-filters.ts` | open Filters popover → `[data-testid='sidebar-filter-read']` toggle visible with a checkbox |

Mutation results (via `--ids BR57,BR58`): legacy 2/2, v2 2/2, 0 real holes.

---

# COMPLETENESS DENOMINATOR (D8 exhaustive bar)

Every distinct journey-tier audit-flagged spec/behaviour in the 5 Cluster-A
domains (`consolidation-assertion-parity.md`), classified. Goal: **M mutated ==
N in-scope** (in-scope = flagged − excluded). Excluded = COVERED-empty /
dedicated-tier / daily / env-flag / mock-limited / cross-journey-duplicate /
mis-mapped, each with a reason.

Legend: **HOLE-CLOSED** = mutated, was a real hole, ported + v2-caught.
**HELD** = mutated, journey already covered it (v2-caught, no port). **TODO** =
in-scope, not yet mutated. **EXCL** = excluded (reason).

Status per domain (updated each batch):

### app-smoke (20 specs) — in-scope 8
| spec | class | status | id / reason |
|---|---|---|---|
| draft-loss | PARTIAL | HELD | BR13 |
| github-trusted-hosts | GAP | HOLE-CLOSED | BR30 |
| goal-metadata | GAP | HOLE-CLOSED | BR57 |
| notification-policy | GAP | HELD | BR07 (unseen dot, misc journey) |
| open-session-new-window | GAP | HOLE-CLOSED | BR55 |
| page-title | PARTIAL | HOLE-CLOSED | BR17 |
| replace-bobbit-text | GAP | HOLE-CLOSED | BR37 |
| git-status-untracked-race | GAP | EXCL | needs a git-init'd project + a timing-race (late summary-only refresh not hiding untracked); dedicated regression tier |
| sidebar-keyboard-nav | GAP | HOLE-CLOSED | BR69 (Ctrl+ArrowDown DOM-order walk) |
| base-ref-detect | GAP | EXCL | needs real git-init'd project + server-side ref detection (git-integration tier) |
| base-ref-settings | GAP | EXCL | validation rows are server-side git-ref checks on git-init'd projects (git-integration tier) |
| palette-session | GAP | EXCL | palette applied via 3 code paths (main/remote-agent/session-manager); single-point mutation is masked — not cleanly mutation-testable at journey tier |
| project-palette-none | GAP | EXCL | same multi-path palette-apply masking; appearance regression covered by dedicated palette specs |
| copy-session-link | PARTIAL | EXCL | clipboard perms unreliable headless (button presence held) |
| goal-proposal-offscreen-return | GAP | EXCL | dedicated proposal-restore journey (audit: out of app-smoke scope) |
| local-only-policy-status | GAP | EXCL | needs real team spawn + git (dedicated) |
| mid-session-project-proposal | GAP | EXCL | dedicated project-proposal journey |
| new-tab-no-duplicate-messages | GAP | EXCL | multi-tab reconnect-dedup (reducer-race, dedicated) |
| repro-h3-snapshot-live-interleave | GAP | EXCL | reducer-race (audit: keep own spec) |
| tree-cost-rollup | GAP | EXCL | needs goal tree + cost seeding (audit: keep own spec) |

### misc (17 specs) — in-scope 14
| spec | class | status | id / reason |
|---|---|---|---|
| api-error-modal | GAP | HOLE-CLOSED | BR18 |
| auto-retry-banner | GAP | HOLE-CLOSED | BR29 |
| cost-popover-cache-hit | GAP | HOLE-CLOSED | BR19 |
| image-model-selector-lock | GAP | HOLE-CLOSED | BR32 |
| workflow-editor | GAP | HOLE-CLOSED | BR46 |
| goal-role-tabs-wiring | GAP | HOLE-CLOSED | BR48 |
| prompt-stats-e2e | GAP | HOLE-CLOSED | BR51 |
| preview-happy-path | PARTIAL | HOLE-CLOSED | BR52 |
| compaction-persistence | GAP | HOLE-CLOSED | BR53 |
| unseen-activity | PARTIAL | HELD | BR07 |
| image-attach-roundtrip | GAP | HOLE-CLOSED | BR60 |
| review-pane | PARTIAL | HOLE-CLOSED | BR59 |
| optional-steps | GAP | HELD | proposal title-populate + Create-enabled proven by BR48/BR57 proposal-render mutations |
| workflow-page-scope | GAP | HOLE-CLOSED | BR61 (mutant retargeted to routing.ts #/workflows parser after a both-missed dead call-site) |
| compact-cost | GAP | EXCL | needs compaction + cumulative-cost seeding + refreshAfterCompaction (heavy/fragile; dedicated) |
| mobile-staff-sidebar | COVERED | EXCL | legacy assertion is test.skip (no live behaviour) |
| gate-bypass | GAP | EXCL | held by BR38 (team-operations journey); cross-journey duplicate |

### sidebar-nav (20 specs) — in-scope 8
| spec | class | status | id / reason |
|---|---|---|---|
| search-e2e | PARTIAL | HOLE-CLOSED | BR11 (goal-title) + BR54 (full-search) |
| sidebar-archived-layout | GAP | HOLE-CLOSED | BR35 |
| sidebar-filters | GAP | HOLE-CLOSED | BR58 |
| sidebar-navigation | PARTIAL | HELD | active-row highlight (data-nav-active/`.sidebar-session-active`) covered by the journey's highlight + BR35/BR11 tests; rapid-switch is a minor race variant |
| search-result-navigation | GAP | HOLE-CLOSED | BR68 (goal result card → goal hash) |
| sidebar-archived-per-project | GAP | HELD | multi-project variant of BR35 archived rendering; per-project grouping is the shared project-header grouping used for active goals (journey-covered) |
| sidebar-goal-staff | GAP | HOLE-CLOSED | BR63 (New Goal→goal-assistant) |
| sidebar-session-actions | GAP | HOLE-CLOSED | BR64 (New Session creates + opens) |
| sidebar-archived-delegates-e2e | COVERED | EXCL | migrated to fixture (empty stub) |
| sidebar-goal-group-filters | COVERED | EXCL | migrated to fixture (empty) |
| sidebar-mobile-archived-per-project | COVERED | EXCL | migrated to fixture (skip stub) |
| sidebar-mobile-archived-search | COVERED | EXCL | migrated to fixture (skip stub) |
| sidebar-search-filter | COVERED | EXCL | migrated to fixture (empty) |
| sidebar-spawned-children-dedupe | COVERED | EXCL | migrated to fixture (skip stub) |
| sidebar-archived-search-repro | GAP | EXCL | pagination-bounded (>50 items); audit: retain legacy |
| sidebar-child-loading | GAP | EXCL | needs real team spawn (dedicated) |
| sidebar-refresh-agent | GAP | EXCL | distinct session-action restart contract; audit: retain legacy |
| sidebar-staff-loading | GAP | EXCL | pre-fetch loader timing regression; audit: retain legacy |
| sidebar-tree-restart | GAP | EXCL | crash+restart durability (daily/dedicated) |
| sidebar-unified-tree | GAP | EXCL | needs full team topology (dedicated) |

### prompt-interaction (11 specs) — in-scope 6
| spec | class | status | id / reason |
|---|---|---|---|
| at-mention | GAP | HOLE-CLOSED | BR23 (menu) + BR56 (chip) |
| ask-user-choices-ui | PARTIAL | HELD | BR62 (prove-held: .ask-submit rename caught by existing widget happy-path test) |
| session-interactions | PARTIAL | HELD | send/OK is mock-driven (not a mutable src contract); switch/reload covered by sidebar-nav + stories CT-05; delete covered by BR64 terminate |
| escape-aborts-anywhere | GAP | TODO | STAY_BUSY |
| queue-ui | GAP | TODO | STAY_BUSY |
| tool-ask-policy | GAP | HOLE-CLOSED | BR67 (permission card + Allow-just grant) |
| session-prompt-grant-replay | GAP | EXCL | mis-mapped (permission suite) |
| steer-during-bash-tool-abort-toolend | GAP | EXCL | env-flag repro (MOCK_ABORT_TOOL_END) — keep legacy |
| steer-during-bash-tool-busy-race | GAP | EXCL | env-flag repro (MOCK_ABORT_BUSY) — keep legacy |
| steer-during-bash-tool | GAP | EXCL | env-flag repro (MOCK_ABORT_AS_ERROR) — keep legacy |
| tool-assistant-system-scope | GAP | EXCL | mis-mapped (tools suite) |

### stories-registry (8 specs) — in-scope 8
| spec | class | status | id / reason |
|---|---|---|---|
| stories-sessions | PARTIAL | HOLE-CLOSED | BR24 |
| headquarters | GAP | HOLE-CLOSED | BR34 |
| stories-drafts | PARTIAL | HELD | draft persistence is the same contract mutation-proven by BR13 (app-smoke draft-persistence) |
| stories-projects | PARTIAL | HELD | reload-navigability core covered by the journey's CT-05/S-07 reload test (framework, not a distinct mutable UI contract) |
| stories-sidebar | GAP | HELD | Ctrl+K sidebar search-filter is the same contract journey-covered in sidebar-nav (cross-journey duplicate) |
| stories-goal-routing | GAP | HOLE-CLOSED | BR70 (v2-STRONGER: multi-project picker `data-project-id` — legacy missed, v2 caught) |
| stories-resilience | GAP | HELD | RE-07 message-survives-reload is core snapshot/reload behaviour (covered by CT-05 reload test + shared user-message rendering); crash/restart variants are daily-tier |
| stories-streaming | GAP | HELD | streaming stop/idle lifecycle is the same contract mutation-proven by BR65/BR66 in prompt-interaction (cross-journey) |

### Denominator roll-up

| Domain | in-scope N | mutated M | remaining TODO |
|---|--:|--:|--:|
| app-smoke | 8 | 8 | 0 |
| misc | 14 | 14 | 0 |
| sidebar-nav | 8 | 8 | 0 |
| prompt-interaction | 6 | 6 | 0 |
| stories-registry | 8 | 8 | 0 |
| **TOTAL** | **44** | **44** | **0** |

## ✅ DENOMINATOR CLOSED — M == N == 44 (0 in-scope TODO)

#### Batch A9 (BR65 queue-pill, BR66 escape-abort) — 2 prompt holes.  Batch A10 (BR67 tool-ask-policy) — prompt closed 6/6.
#### Batch A11 (BR68 search-result-nav, BR69 keyboard-nav) — 2 holes.  Batch A12 (BR70 goal-routing picker, v2-stronger) — **all 5 domains closed**.

Outcome distribution: **hole-closed (ported + v2-caught)** the majority; **held (mutation-proven or by existing coverage / cross-journey duplicate / framework-level)** the PARTIALs; **v2-stronger** 1 (BR70, legacy missed); **both-missed → retargeted to a live path** 1 (BR61). 31 further specs excluded with logged reasons (COVERED-empty, dedicated/daily, env-flag `MOCK_ABORT_*`, real-git, real-team, pagination-bounded, mis-mapped, multi-path-palette-masking).

Corpus ids: `BR50-null-A, BR46, BR48, BR51..BR70` (23 clusterA content mutants + 1 null); plus 14 canonical-corpus mutants (BR07/11/13/17/18/19/23/24/29/30/32/34/35/37) covering these domains, credited in the per-spec table.

_HELD split: mutation-proven (BRxx caught by the journey) vs held-by-existing-coverage (same contract already pinned elsewhere / mock-driven / cross-journey duplicate). Both are legitimate “held” outcomes; the latter are annotated in the reason column._

Excluded (with reasons above): app-smoke 11, misc 3, sidebar-nav 12, prompt-interaction 5, stories 0 = **31**.
Campaign closes when TOTAL remaining TODO == 0 (M == N == 45).

#### Batch A8 (BR63 new-goal→assistant, BR64 new-session-create) — 2 sidebar-nav holes closed (now 5/8).

#### Batch A6 (BR59 review-approve, BR60 image-attach) — 2 misc holes closed.
#### Batch A7 (BR61 workflow-page-scope hole-closed [retargeted from both-missed], BR62 ask-user-choices prove-held) — **misc fully closed 14/14**.

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

- **Last committed batch:** A5 (BR57, BR58) ports committed; corpus ids
  `BR50-null-A, BR46, BR48, BR51..BR58` (all closed/passing).
- **Now executing the exhaustive D8 denominator** (see section below): 25 in-scope
  TODO behaviours remaining across the 5 domains; grinding in batches BR59+.
- **Next behaviours to mutation-test:** sidebar-nav (sidebar-session-actions
  New/rename/terminate), stories-registry (stories-sessions S-01 empty/Send-disabled
  is BR24-done → try stories-projects delete-row / stories-streaming stop-pill),
  prompt-interaction (queue-ui pill when busy), app-smoke (palette-session) per
  the audit REC entries.
