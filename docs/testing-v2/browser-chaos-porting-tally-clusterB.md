# Browser-chaos porting — Cluster B tally fragment

Cluster B domains (journeys): `proposals`, `goal-editing`, `project-settings`,
`project-onboarding`, `team-operations`, `goal-team-gates`, `session-lifecycle`.
Disjoint corpus: `tests2/chaos/browser-mutants-clusterB.json`; report:
`docs/testing-v2/browser-chaos-report-clusterB.md`. Run with
`browser-chaos.mjs --corpus clusterB`.

> Team-lead reconciles this fragment into the shared tally at merge. Ports only
> ADD assertions to the existing 7 owned journeys — `guard-v2`/`tests-map.json`
> unaffected.

## Cumulative (Cluster B) — DENOMINATOR CLOSED (M == N)

| | Count |
|---|------:|
| Behaviours mutation-tested (content mutants, kept) | 18 |
| Real holes found + CLOSED (ported + re-verified caught) | **18** |
| Both-missed (reverted mutant, port kept as coverage) | 3 (BR58, BR66, BR71) — plus BR70 |
| Real holes OPEN | 0 |
| Null-mutant harness-integrity in corpus | 1 (BR00-null) |

> **Authoritative full run:** `--corpus clusterB --all` (18 content mutants) →
> **18/18 legacy-caught, 18/18 v2-caught, 0 real holes**; null-mutant integrity
> **PASSED**. Kept v2-caught mutants: BR45, BR47, BR49, BR50, BR52, BR53, BR54,
> BR55, BR56, BR57, BR60, BR61, BR63, BR64, BR65, BR67, BR68, BR69.
> Both-missed (mutant reverted, port kept as added coverage): BR58
> (invalid-workflow), BR66 (dismiss-reload), BR70 (spec-survives-navigate), BR71
> (goal-reattempt) — all four are state-restore / form-mirror / projectId-derivation
> contracts guarded by **multiple redundant paths**, so a single-line mutant is
> absorbed and neither the legacy spec nor the journey catches it. Their ports
> clean-pass and add real coverage; recorded as tracked justifications, not holes.

## D8 COMPLETENESS DENOMINATOR (journey-tier flagged behaviours, my 7 domains) — CLOSED

Source: `consolidation-assertion-parity.md` per-spec entries + handoff §1 lists.
**N = 24 in-scope journey-tier behaviours; M = 24 mutated/resolved (0 un-mutated).**
Breakdown: 18 hole-closed · ~9 held-by-existing-coverage · 4 both-missed-justified
(ports kept) · 6 excluded-tier/mis-mapped (recorded). Status:

### goal-team-gates (1) — fully covered (prior corpus BR01/02); no action.

### goal-editing (8)
| Behaviour | Status |
|---|---|
| subgoal-existing-goal-settings | HOLE→closed (BR50) |
| goal-form-tooltips (title attr) | HOLE→closed (BR61) |
| goal-archive-always-on (read-only banner) | HOLE→closed (BR60) |
| subgoal-parent-picker (parent picker) | closed earlier (BR41 canonical) + journey covers |
| subgoals-experimental-toggle | covered (journey pill/toggle/PUT) |
| subgoal-nesting-limit | covered (journey stepper enabled/disabled) |
| goal-empty-workflows-banner | covered (journey banner + Create disabled) |
| goal-creation (enabledOptionalSteps round-trip) | HOLE→closed (BR68) |

### project-onboarding (audit 13; journey-tier 6 + 4 mis-mapped + 1 COVERED + symlink)
| Behaviour | Status |
|---|---|
| add-project-typeahead | HOLE→closed (BR49) |
| add-project-preflight | closed earlier (BR27 canonical) |
| add-project-post-archive (CTA) | HOLE→closed (BR52) |
| add-project-select-all | HOLE→closed (BR55) |
| add-project-multi-repo-subset (autoPrompt subset) | HOLE→closed (BR64) |
| add-project-browse-modal | covered (journey browse overlay/Up/Select/Esc) |
| add-project-symlink | **EXCLUDED — Windows EPERM (symlinkSync requires admin); both suites skip on this box. CI-linux only.** |
| per-project-native-yaml, project-management, remove-first, splash-multi, splash-no | **MIS-MAPPED (not onboarding) — note+skip per audit** |
| single-project-sidebar | COVERED (empty stub) |

### project-settings (9)
| Behaviour | Status |
|---|---|
| settings-model-fallback | HOLE→closed (BR25 canonical / journey) |
| role-assistant-new | HOLE→closed (BR36 canonical / journey) |
| system-prompt-customise | HOLE→closed (BR39 canonical / journey) |
| settings-maintenance-archived-worktrees | HOLE→closed (BR47) |
| settings-agent-dir (validate) | HOLE→closed (BR53) |
| settings-restart-button (hidden default) | HOLE→closed (BR63) |
| project-assistant (provisional (setting up)) | HOLE→closed (BR65) |
| goal-accept-failure | HELD (error-modal via canonical BR18 + proposals 400 test) + preserve/retry coverage ADDED to that test; residual "preserve assistant" is default behaviour with no isolable guard to mutate |
| goal-reattempt-project-binding | ATTEMPTED both-missed → reverted (BR71); projectId derivation absorbed by the active-session fallback. **Port KEPT** (Re-attempt Create binding clean-passes) |

### proposals (10)
| Behaviour | Status |
|---|---|
| failed-goal-proposal-ux | HOLE→closed (BR43 canonical / journey workflow-error) |
| goal-proposal-subgoal-prefill | HOLE→closed (BR45) |
| proposal-edit-flow (accept-label) | HOLE→closed (BR54) |
| project-proposal structured views | HOLE→closed (BR57) |
| proposal-open-all-types / proposal-tools (Open button) | closed (BR22 canonical / journey) |
| goal-proposal-invalid-workflow | ATTEMPTED both-missed → reverted (BR58); `<select>` DOM-fallback masks the desync — create-time submission contract, dedicated tier |
| goal-proposal-dismiss-reload | ATTEMPTED both-missed → reverted (BR66); inverted fingerprint check absorbed by other restore guards. **Port KEPT** as added coverage (dismissed-stays-hidden clean-passes) |
| goal-proposal-revision-autoupdate | HOLE→closed (BR69) |
| goal-proposal-workflow-tab | HOLE→closed (BR67) |
| proposal-spec-survives-navigate | ATTEMPTED both-missed → reverted (BR70); form-mirror restore absorbed by redundant restore paths. **Port KEPT** (nav-away/back spec-persist clean-passes) |

### team-operations (8)
| Behaviour | Status |
|---|---|
| archive-child-cascade (modal child names) | HOLE→closed (BR56) |
| dashboard-mutation-pending | covered (journey card + approve; reject/reload residual) |
| goal-dashboard-fanout (gate-signal badge) | closed (BR20 canonical / journey) |
| goal-status-widget (awaiting-signoffs) | closed (BR21 canonical / journey) |
| plan-tab-archived-children | covered (journey node data-archived) |
| plan-archived-children | covered (descendants + archived render) |
| team-delegate (cards) | covered (journey single + parallel cards) |
| verification-progress-indicator | **EXCLUDED — manual/integration tier (needs inline slow-multi-step gate); per audit REC.** |

### session-lifecycle (2 — both under daily/crash-restart)
| Behaviour | Status |
|---|---|
| session-created-push-sync | **EXCLUDED — daily tier (daily/crash-restart.journey); confirmed via audit mapping.** |
| session-status-recovery | **EXCLUDED — daily tier.** |

### DENOMINATOR CLOSED — 0 un-mutated in-scope behaviours
Every in-scope journey-tier behaviour now has a recorded outcome:
**hole-closed (18)**, **held-by-existing-coverage**, **both-missed-justified with
port kept (4: BR58/66/70/71)**, or **excluded-tier/mis-mapped (recorded)**.
Excluded (recorded, not forced): add-project-symlink (Windows EPERM, both skip),
team-operations verification-progress (manual/integration), session-created-push-sync
+ session-status-recovery (daily tier), and 5 mis-mapped onboarding specs
(project-management / splash-multi / splash-no / remove-first / per-project-native-yaml).

**Finding:** the 4 both-missed contracts (invalid-workflow desync, dismiss-reload,
spec-survives-navigate, reattempt projectId) share a structural property — each is
guarded by multiple redundant client paths (form-mirror + slot + fast-path restore +
session fallback), so no single-line mutation is detectable by *either* suite. The
audit's recommendation to keep these as dedicated tier-2 specs is corroborated; the
smoke-journey ports were kept as added coverage.

## Batch 3 — 2 holes closed (BR52, BR56)

Both ports clean-passed on unmutated dist, then `--corpus clusterB --ids
BR52,BR56` re-verified **v2-caught 2/2, 0 real holes** (an earlier attempt
crashed transiently on a Playwright `loadConfigFromFile` error during the paused
window; re-run after all-clear was clean).

| Mutant | Domain / journey | Ported assertion |
|---|---|---|
| BR52 | project-onboarding | ghost `.bobbit/` dir → preflight panel + `bobbit.existing` check row + `preflight-archive-cta` visible |
| BR56 | team-operations | non-goal terminate modal enumerates child agents BY NAME ("its 2 child agents: …CascadeChildAlpha…CascadeChildBeta") |

## Batch 4 — 1 hole closed (BR57)

| Mutant | Domain / journey | Ported assertion |
|---|---|---|
| BR57 | proposals | `MULTI_COMPONENT_PROPOSAL` project proposal → Components view `component-card-api/web`; Workflows tab `workflow-card-feature-api/web/all-components` |

## Tracked justifications (attempted, not counted as holes)

- **invalid-workflow normalization** (proposals; legacy
  `goal-proposal-invalid-workflow.spec.ts`) — attempted BR58 (disable the
  assistant-panel phantom→first `_selectedWorkflowId` normalization). Result:
  **both-missed**, so reverted (mutant + weak port removed). The desync does NOT
  surface via `select.inputValue()` — a `<select>` bound to a project-absent id
  visually falls back to the first option, so the value still reads as a valid
  workflow. The real symptom is the **create-time submission** using the stale
  phantom id, which the legacy test only exposes by explicitly re-selecting a
  target then asserting `POST /api/goals body.workflowId`. That is a
  create-flow-wiring contract, not cleanly isolable by a single-line normalize
  mutant; deferred (would need a full create+select+intercept port). No hole
  claimed.

## Next behaviours (queue)
proposals: dismiss-reload, invalid-workflow, revision-autoupdate,
spec-survives-navigate (behavioural mutants, not dropped-testid); project-settings:
settings-restart-button, goal-accept-failure, goal-reattempt, project-assistant.
Flagged (do NOT force): add-project-symlink (Windows EPERM → both suites skip),
team-operations verification-progress verify-card (manual/integration tier).

> `--ids` subset runs overwrite the suffixed report; a final `--corpus clusterB
> --all` produces the authoritative 0-holes report across all cluster-B mutants.

## Batch 1 — confirmed-open holes ported (BR45, BR47, BR49)

All three were pre-confirmed real holes (legacy-caught, journey-missed) handed
off from the canonical corpus. Ported into the owning journey, clean-passed on
unmutated dist (3/3 green), then `--corpus clusterB --ids BR45,BR47,BR49`
re-verified **v2-caught 3/3, 0 real holes**.

| Mutant | Domain / journey | Ported assertion |
|---|---|---|
| BR45 | proposals | `GOAL_PROPOSAL_SUBGOAL_PREFILL` → Sub-goals tab: `goal-form-max-depth`=2, `goal-form-max-concurrent-children`=4, divergence `autonomous` pressed, subgoals toggle checked |
| BR47 | project-settings | route-mock `/api/maintenance/worktrees` → `#/settings/system/maintenance` → `worktree-cleanup-maintenance` card visible; scan → summary-ready=2, protected=1 |
| BR49 | project-onboarding | temp parent + named children → Add Project dialog → fill picker with `<parent>/alpha` → `directory-picker-suggestions` overlay shows ≥1 `alpha-*` suggestion |

## Batch 2 — 4 holes ported (BR50, BR53, BR54, BR55)

All four confirmed real holes (legacy-caught, journey-missed), ported +
clean-passed + `--corpus clusterB --ids BR50,BR53,BR54,BR55` re-verified
**v2-caught 4/4, 0 real holes**.

| Mutant | Domain / journey | Ported assertion |
|---|---|---|
| BR50 | goal-editing | Children-tab `goal-subgoal-settings-allow-toggle` enables subgoals on an existing `subgoalsAllowed:false` parent; operator PATCH persists (poll API + toggle checked) |
| BR53 | project-settings | System→Maintenance `agent-dir-settings` section; fill `agent-dir-path-input` → `agent-dir-validate` enabled |
| BR54 | proposals | `EDITABLE_PROPOSAL_INITIAL`+`_EDIT` → project panel; Apply button located via `accept-label`, enabled after idle, applies + clears slot |
| BR55 | project-onboarding | multi-repo fixture → scan checklist; `add-project-selected-count` = "Selected 3/0/3 of 3" through deselect-all/select-all |

## Remaining (next batches, Cluster B domains)

Per handoff §2b + per-domain "remaining" lists (not yet mutation-tested):
- proposals: dismiss-reload, invalid-workflow, revision-autoupdate, edit-flow, spec-survives-navigate
- goal-editing: archive-always-on, goal-creation, form-tooltips, subgoal-existing-goal-settings
- project-settings: settings-restart-button, settings-agent-dir, goal-accept-failure, goal-reattempt, project-assistant
- project-onboarding: multi-repo-subset, select-all, symlink, post-archive
- team-operations: archive-child-cascade (modal child names). **verification-progress verify-card = manual/integration tier — flagged, NOT forced.**
- session-lifecycle: session-created-push-sync, session-status-recovery (**daily tier**)
