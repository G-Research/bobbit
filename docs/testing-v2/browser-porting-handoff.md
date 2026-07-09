# Browser-chaos porting pass — HANDOFF

Comprehensive bounded pass: mutation-test every distinct audit-flagged browser
behaviour (`consolidation-assertion-parity.md`), port every confirmed real hole
into the owning v2 journey, end with a full-verify campaign at **0 real holes**.
This doc hands off mid-pass so fresh coder(s) can continue (and parallelise).

Branch: `goal/6c956ecf/coder-9092`. Corpus: `tests2/chaos/browser-mutants.json`
(50 entries = 49 content + 1 null, ids BR00–BR49). Tally source of truth:
`docs/testing-v2/browser-chaos-porting-tally.md`.

---

## 1. DONE

Batches run: **1–4** (BR01–BR49). Running tally:

| Metric | Count |
|---|--:|
| Behaviours mutation-tested (content mutants) | 49 |
| Clean substitutions (journey already held) | 15 |
| v2-stronger (legacy missed, v2 caught) | 1 (BR07) |
| **Real holes found** | **32** |
| **Real holes CLOSED (ported + re-verified caught)** | **27** |
| **Real holes OPEN (confirmed, ports pending)** | **5 (BR45–BR49)** |
| Both-missed (tracked justification) | 1 (BR26) |

- Batch 1 (BR01–28): 13 holes closed; 13 clean; BR07 v2-stronger; BR26 both-missed. A full `--all` re-run confirmed 0 holes across all 28 at that point (`browser-chaos-report.md`).
- Batch 2 (BR29–36): 8 holes closed (incl. BR34/BR35 after retargeting from testids the legacy specs don't assert → the label / grayscale contract they do).
- Batch 3 (BR37–43): 6 holes closed; BR42 clean.
- Batch 4 (BR44–49): BR44 clean; **BR45–49 are CONFIRMED real holes, NOT yet ported** (see §2, ready-to-port).

### Per-journey domain status (15 journeys)

| Journey | Status | Notes |
|---|---|---|
| goal-team-gates | ✅ covered | plan-tab archived + gate-status (BR01/02) |
| proposals | 🟡 partial | streaming/submit/dot/open-button/workflow-error done (BR04/05/06/22/43); **BR45 subgoal-prefill OPEN**; remaining: dismiss-reload, invalid-workflow, revision-autoupdate, edit-flow, spec-survives-navigate |
| goal-editing | 🟡 partial | no-workflows/parent-picker/subgoals-toggle/max-nesting done (BR03/41/42/44); remaining: archive-always-on, goal-creation, form-tooltips, subgoal-existing-goal-settings |
| team-operations | ✅ mostly | mutation-card/status/delegate/gate-signal/awaiting/gate-bypass done (BR08/09/10/20/21/38); remaining: archive-child-cascade (modal child names), verification-progress verify-card (**manual/integration tier** — needs slow multi-step gate) |
| misc | 🟡 partial | api-error/cost-cache/auto-retry/image-model done (BR18/19/29/32); **BR46 workflow-editor + BR48 role-tabs OPEN**; remaining: compaction-summary-card, compact-cost, image-attach, optional-steps, preview-happy-path(new-tab/refresh), prompt-stats, review-pane(approve/reject), workflow-page-scope |
| app-smoke | 🟡 partial | title/draft/github-hosts/replace-bobbit done (BR17/13/30/37); remaining: palette-session, sidebar-keyboard-nav, notification team-suppression, goal-metadata, goal-proposal-offscreen-return, git-status-untracked-race, open-session-new-window, new-tab-no-duplicate, copy-session-link(clipboard), tree-cost-rollup, local-only-policy |
| session-lifecycle | ✅ mostly | fork + sidebar-actions items done (BR12 + Batch-1); remaining: session-created-push-sync, session-status-recovery (**daily tier**) |
| project-onboarding | 🟡 partial | browse dialog/up/select/preflight done (BR14/15/16/27); **BR49 typeahead OPEN**; remaining: multi-repo-subset, select-all, symlink, post-archive, project-management (splash-*/remove-first/per-project-yaml are mis-mapped → project-mgmt/settings journeys) |
| project-settings | 🟡 partial | model-fallback/roles-new/sysprompt done (BR25/36/39); **BR47 maintenance OPEN**; remaining: settings-restart-button, settings-agent-dir, goal-accept-failure, goal-reattempt, project-assistant |
| sidebar-nav | 🟡 partial | goal-search/archived-grayscale done (BR11/35); remaining: search-result-navigation, sidebar-archived-per-project, sidebar-archived-search-repro, sidebar-child-loading, sidebar-filters, sidebar-goal-staff, sidebar-navigation(rapid-switch), sidebar-refresh-agent, sidebar-session-actions, sidebar-staff-loading, sidebar-tree-restart, sidebar-unified-tree |
| prompt-interaction | 🟡 partial | @-mention done (BR23); remaining: ask-user-choices(escape/keyboard), at-mention(chip/reload), escape-aborts, queue-ui, session-interactions(switch/reload/delete), tool-ask-policy, steer-during-bash ×3 (**env-flag repros, likely keep legacy**) |
| marketplace-packs | 🟡 partial | banner/installed-panel done (BR28/33); remaining: artifacts-pack, extension-host, marketplace-mcp, marketplace(install cycle); marketplace-conflicts = **API spec**; skill-multifile/skills-chip = **mis-mapped → a skills journey** |
| staff-debug | 🟡 partial | staff-header/staff-role done (BR31/40); remaining: children-tool-renderers, debug-mode-toggle, instant-loader, staff-accessory, staff-sandbox-indicator; staff-triggers = BR26 both-missed |
| stories-registry | 🟡 partial | send-disabled/headquarters done (BR24/34); remaining: stories-drafts, stories-goal-routing, stories-projects, stories-resilience, stories-sidebar, stories-streaming |
| bg-wait-multi-repo | ⏭️ dedicated tier | bg-process lifecycle, multi-repo, steer flows → dedicated tier-1/2/3 specs (see below), NOT journey extensions |

### Both-missed (tracked, not consolidation regressions)
- **BR26** staff-debug — goal-trigger `Wake prompt (required)` label: asserted by neither the legacy `staff-triggers.spec.ts` nor the journey. Add a staff-trigger-editor assertion when that editor flow is journey-covered.

### Dedicated-tier domains (do NOT port into journeys)
Per the audit's sequencing note, these keep dedicated specs (already exist):
`tests2/core/bg-process-persistence.test.ts`, `tests2/browser/fixtures/bg-process-{pills,popover}.spec.ts`,
`tests/manual-integration/bg-process-restart-survival.spec.ts`, `tests2/browser/daily/crash-restart.journey.spec.ts`,
`tests/manual-integration/multi-repo-docker.spec.ts`. Also likely dedicated/manual: verification-progress verify-card, prompt-interaction steer-during-bash env-flag repros, session-created/status-recovery.

---

## 2. REMAINING — ready-to-port confirmed holes (BR45–BR49)

These 5 are **already mutation-confirmed real holes** (legacy-caught, journey-missed) in the committed corpus; just port + re-verify (`browser-chaos.mjs --ids BR45,...`). Setups already researched from the legacy specs:

- **BR45** proposals `goal-form-max-depth` — port into `proposals.journey.spec.ts`:
  `apiFetch("/api/preferences",{method:"PUT",body:JSON.stringify({subgoalsEnabled:true})})` → `createSessionViaUI(page)` → `sendMessage(page,"Please GOAL_PROPOSAL_SUBGOAL_PREFILL now")` → click `[data-testid='goal-proposal-tab-subgoals']` → assert `[data-testid='goal-form-max-depth']` visible. Reset pref false in `finally`.
- **BR46** misc `wf-step-type` — port into `misc.journey.spec.ts` (workflow editor):
  seed a workflow `POST /api/workflows {projectId:<defaultProjectId>, id, name:"Test Workflow "+id, gates:[{id:"g1",name:"Gate 1",depends_on:[],verify:[{name:"Step",type:"command",run:"echo ok"}]}]}` → nav `#/settings/${projectId}/workflows` → click `[data-testid='workflows-tab']` → click text `Test Workflow ${id}` → wait `.wf-edit-container` → expand first gate + first vstep (`.wf-vstep-collapsed-header` click on `[data-testid='wf-vstep-card']`) → assert `[data-testid='wf-step-type']` visible.
- **BR47** project-settings `worktree-cleanup-maintenance` — port into `project-settings.journey.spec.ts`:
  `page.route(/\/api\/maintenance\/worktrees(?:\?.*)?$/, ...)` returning a small itemset → nav `#/settings/system/maintenance` → assert `getByTestId("worktree-cleanup-maintenance")` visible. (Escape `?` as `\\?` inside a `new RegExp(\`...\`)` template — see gotcha.)
- **BR48** misc `goal-proposal-role-reset` — port into `misc.journey.spec.ts`:
  `createGoalAssistantViaUI(page,{timeout:60000})` → `sendMessage(page,"Please create a GOAL_PROPOSAL for testing")` → click `[data-testid='goal-proposal-tab-roles']` → (Customize if needed) → assert `[data-testid='goal-proposal-role-reset']` visible. (Confirm exact reveal sequence in `goal-role-tabs-wiring.spec.ts`.)
- **BR49** project-onboarding `directory-picker-suggestions` — port into `project-onboarding.journey.spec.ts`:
  build a parent dir with children (`mkdirSync(join(parent,"alpha-child"),...)`) → `openAddProjectDialog(page)` → fill `ADD_PROJECT.pickerInput` with `join(parent,"alpha")` → assert `[data-testid='directory-picker-suggestions']` overlay visible.

After porting: clean-pass each new test on unmutated dist (filtered `-g`), then `browser-chaos.mjs --ids BR45,BR46,BR47,BR48,BR49` → confirm all v2-caught.

## 2b. REMAINING — not-yet-mutation-tested behaviours

For every 🟡 domain above, the audit (`consolidation-assertion-parity.md`, per-spec **REC** entries) lists the exact assertions each legacy spec pins that the journey lacks. Workflow per behaviour: pick the legacy spec → extract its primary asserted `data-testid`/label/`getByRole` → add a mutant → run → port the confirmed hole. Approximate remaining count: ~50–90 behaviours (target total corpus ~100–140).

Fastest mutant-authoring recipe (used for Batches 2–4): grep the legacy spec for its dominant `data-testid`, confirm it's **unique** in the owning `src/` file, add a `dropped-testid` rename mutant; the port is then a presence/attribute assertion mirroring the legacy setup. Behavioural (non-testid) contracts (palette dataset, page-title suffix, off-by-one counts, grayscale style, draft server-restore) use attribute/text/style mutations instead — see BR11/13/17/20/35 for patterns.

---

## 3. HOW TO RESUME

```bash
# From the worktree root. The harness self-resolves a COMPLETE node_modules
# (playwright+tsc+vite+@earendil-works/pi-ai+@anthropic-ai/sdk) from a sibling
# same-goal worktree via a read-only junction — no local install needed.

node scripts/testing-v2/browser-chaos.mjs --dry-run            # list corpus
node scripts/testing-v2/browser-chaos.mjs --ids BR45,BR46      # run a subset
node scripts/testing-v2/browser-chaos.mjs --all                # full campaign (~45 min)
node scripts/testing-v2/browser-chaos.mjs --all --resume       # reuse prior report; run only not-yet-done ids
node scripts/testing-v2/browser-chaos.mjs --regen-report       # rebuild MD from JSON
node scripts/testing-v2/browser-chaos.mjs --corpus clusterB --ids BR50   # disjoint corpus+report (parallel)
```

Per-mutant workflow (the loop):
1. Add mutant to the corpus (unique `search` string verified via grep; map `expectedLegacyCatchers` = the retired spec that asserts it, `expectedV2Catchers` = the owning journey).
2. `browser-chaos.mjs --ids <id>` → read result. `legacy=caught,v2=missed` ⇒ **REAL HOLE**. `both-missed` ⇒ retarget the mutant to a contract the legacy actually asserts, or record a tracked justification. `clean` ⇒ journey already holds (no port).
3. Port the assertion into the owning journey (never weaken; mirror the legacy setup). **Clean-pass it on unmutated dist first** (`playwright test --config playwright-v2.config.ts -g "<title>"`) to catch authoring bugs.
4. Re-run `--ids <id>` → confirm `v2=caught`.
5. Commit per domain/batch; update the tally doc.

To pre-build dist for clean-pass runs (harness builds its own per-mutant; clean-pass needs dist in your worktree): junction a complete `node_modules` in, then
`node <nm>/typescript/bin/tsc -p tsconfig.server.json && node scripts/copy-defaults.mjs && node scripts/copy-builtin-packs.mjs && node <nm>/vite/bin/vite.js build && node scripts/build-market-packs.mjs`.

### Gotchas
- **Junction-safe teardown (mandatory):** the harness junctions the worktree's `node_modules` to a complete sibling; teardown `unlinkNodeModulesJunction` unlinks the reparse point NON-recursively before any recursive delete. Never `rm -rf` a worktree without unlinking the junction first (delete-through-junction corrupts the shared tree). When cleaning up manually, `fs.rmdirSync`/`fs.unlinkSync` the `node_modules` link first.
- **Toolchain resolution:** the primary repo / goal-branch `node_modules` are often partially pruned on Windows (missing pi-ai / provider SDKs). The harness picks the FULLEST complete same-goal worktree by entry count; if it aborts "no COMPLETE node_modules", ensure a sibling `goal-6c956ecf-*` worktree has a full `npm ci`.
- **Dirty-target rebuild:** browser tests run against built `dist`; the harness rebuilds only the mutated target (`build:ui` for src/app|src/ui, `build:server` for src/server) and restores it between mutants. tsc/vite are invoked by JS entry (`node <nm>/typescript/bin/tsc`), NOT `npm`/`.bin` (Windows `.bin` junction PATH is flaky — "'tsc' is not recognized").
- **RegExp in template literals:** escape `?` as `\\?` inside `` new RegExp(`...(?:\\?.*)?$`) `` — a single `\?` collapses to `?` → "Nothing to repeat" (bit BR38).
- **Clean-pass matters:** a journey test broken on clean code shows as false "v2-caught" under mutation. Always clean-pass new tests before trusting the mutant re-run.
- **`--ids` overwrites the report:** a subset run rewrites `browser-comparison-report.{json,md}`. Restore the full committed report (`git checkout -- docs/testing-v2/browser-chaos-report.md`) or run a final `--all`.
- Report doubles are gitignored under `.profiles/`; the committed summary is `docs/testing-v2/browser-chaos-report.md`.

---

## 4. SUGGESTED PARALLEL PARTITION (2 disjoint clusters)

Journey files are the conflict unit; these clusters touch **disjoint** journey
files and use **separate corpus files** (`--corpus clusterA` / `--corpus clusterB`
→ `tests2/chaos/browser-mutants-clusterA.json` / `-clusterB.json`, and suffixed
reports) so two coders run in parallel without conflicts.

**Cluster A — UI-surface domains** (journeys: `app-smoke`, `misc`, `sidebar-nav`,
`prompt-interaction`, `marketplace-packs`, `staff-debug`, `stories-registry`).
Includes open holes **BR46, BR48** (misc). Highest remaining flag counts.

**Cluster B — goal/proposal/settings domains** (journeys: `proposals`,
`goal-editing`, `project-settings`, `project-onboarding`, `team-operations`,
`goal-team-gates`, `session-lifecycle`). Includes open holes **BR45, BR47, BR49**.

Seed each cluster corpus by copying the relevant BRxx entries out of
`browser-mutants.json` (or start new ids BR50+ per cluster). Keep the canonical
`browser-mutants.json` as the merged/authoritative corpus; each coder runs their
cluster file, and a final merge + one `--all` on the canonical corpus is the
0-holes gate. `guard-v2` stays green as long as no journey files are removed and
no `tests-map.json` `v2Path`/`replacement` entries dangle (the ports only ADD
assertions to existing journeys).

---

## 5. Reconciliation state
- `tests2/tests-map.json`: unchanged by porting (ports only add assertions to existing journeys) → `guard-v2` green. The ported specs remain `legacy-pending` (only the mutation-flagged behaviour per spec is closed; their remaining audit assertions are still pending).
- `docs/testing-v2/consolidation-assertion-parity.md`: has a "Mutation-campaign reconciliation" section (Batch 1). Update it as domains reach full coverage.
- `docs/testing-v2/browser-chaos-porting-tally.md`: running tally (update each batch).
