# Browser-chaos porting pass — running tally

Comprehensive porting pass driven by the browser-mutation campaign
(`scripts/testing-v2/browser-chaos.mjs`) against the assertion-parity audit
(`consolidation-assertion-parity.md`). For each audit-flagged behaviour: add a
mutant → run → if it's a **real hole** (legacy-caught, journey-missed), port the
assertion into the owning journey → re-run to confirm caught. No assertions
weakened; no mutants dropped (mis-targeted mutants are *retargeted* to the
contract the legacy spec actually asserts).

## Cumulative tally

| | Count |
|---|------:|
| Behaviours mutation-tested (content mutants) | 49 |
| Clean substitutions (journey already held) | 15 |
| v2-stronger (legacy missed, v2 caught) | 1 |
| **Real holes found** | **32** |
| **Real holes CLOSED (ported + re-verified)** | **27** |
| **Real holes OPEN (confirmed, ports pending)** | **5 (BR45–BR49)** |
| Both-missed (tracked justification) | 1 |

> HANDOFF checkpoint — see `browser-porting-handoff.md`. Batch 4 mutants BR45–BR49
> are confirmed real holes with researched port instructions but are NOT yet
> ported (handed off to fresh coder(s)).

## Batch 1 (BR01–BR28) — 13 holes closed

13 clean substitutions; 1 v2-stronger (BR07 unseen dot); **13 real holes closed**
(BR11 sidebar goal-title search, BR13 draft server-restore, BR17 page-title
suffix, BR18 api-error-modal, BR19 cost-cache-hit, BR20 gate-signal-badge, BR21
awaiting-signoffs, BR22 proposal-open-button, BR23 @-mention, BR24 send-disabled,
BR25 model-fallback toggle, BR27 preflight gating, BR28 research-preview banner);
1 both-missed (BR26 staff-trigger `Wake prompt (required)` label — pre-existing
legacy gap, tracked). Full authoritative re-run confirmed 0 real holes across all
28. See `browser-chaos-report.md`.

## Batch 2 (BR29–BR36) — 8 holes closed

All 8 confirmed real holes (2 of them, BR34/BR35, after retargeting from testids
the legacy specs don't assert to the contracts they do). Ported + re-verified
caught:

| Mutant | Domain | Ported journey assertion |
|---|---|---|
| BR29 | misc | inject `auto_retry_pending` → banner + `data-reason/attempt/retry-delay-ms` |
| BR30 | app-smoke | add GitHub trusted host → `github-trusted-host-row` renders |
| BR31 | staff-debug | create staff agent → `sidebar-staff-header` renders |
| BR32 | misc | footer `footer-image-model-id` = `gpt-image-2` |
| BR33 | marketplace-packs | Installed tab → `market-installed-panel` |
| BR34 | stories-registry | settings "Show Headquarters in project lists" toggle (by label) |
| BR35 | sidebar-nav | archive + Show Archived → `grayscale(1)`-dimmed row |
| BR36 | project-settings | `#/roles` exposes a "New Role" button |

## Batch 3 (BR37–BR43) — 6 holes closed

7 behaviours; 6 real holes closed, 1 clean (BR42 subgoals-enabled toggle already
covered). Ported + re-verified caught:

| Mutant | Domain | Ported journey assertion |
|---|---|---|
| BR37 | app-smoke | settings replace-bobbit-with-text toggle |
| BR38 | team-operations | goal-widget gate-bypass control on a failed gate row (route-mocked gates) |
| BR39 | project-settings | settings customise-system-prompt control |
| BR40 | staff-debug | staff edit-page role select |
| BR41 | goal-editing | Sub-goals-tab parent picker (subgoals enabled) |
| BR43 | proposals | MISSING_WORKFLOW → goal-proposal-workflow-error row |

## Batch 4 (BR44–BR49) — 1 clean, 5 holes CONFIRMED (ports pending, handed off)

BR44 (max-nesting-depth) clean — goal-editing already covered it. BR45–BR49 are
confirmed real holes (legacy-caught, journey-missed); port instructions are in
`browser-porting-handoff.md` §2:
- BR45 proposals `goal-form-max-depth` (SUBGOAL_PREFILL)
- BR46 misc `wf-step-type` (workflow editor)
- BR47 project-settings `worktree-cleanup-maintenance`
- BR48 misc `goal-proposal-role-reset` (proposal Roles tab)
- BR49 project-onboarding `directory-picker-suggestions` (typeahead)

## Both-missed (tracked, not consolidation regressions)

- **BR26** (staff-debug) — goal-trigger `Wake prompt (required)` label: asserted by
  neither the legacy `staff-triggers.spec.ts` nor the journey. Add a
  staff-trigger-editor assertion when that editor flow is journey-covered.

## Domains remaining (next batches)

Still under the audit's high-flag counts, behaviours not yet mutation-tested:
app-smoke (palette, replace-bobbit, keyboard-nav, notification team-suppression,
goal-metadata), misc (compaction card, gate-bypass, review Approve/Reject,
prompt-stats, workflow-editor), sidebar-nav (rapid-switch, refresh-agent,
child-loading, full-search navigation), prompt-interaction (queue-ui,
escape-aborts, ask Escape/keyboard, session delete), project-settings
(restart-button, system-prompt-customise, agent-dir, maintenance), stories
(goal-routing, streaming, resilience), goal-editing (subgoal picker/toggle),
team-operations (verify-card — likely manual/integration tier), proposals
(failed-workflow, revision-autoupdate, subgoal-prefill).

bg-wait-multi-repo + crash-restart remain covered by dedicated tier-1/2/3 specs
(not journey extensions) — see the audit reconciliation section.
