# Browser-chaos porting — Cluster B tally fragment

Cluster B domains (journeys): `proposals`, `goal-editing`, `project-settings`,
`project-onboarding`, `team-operations`, `goal-team-gates`, `session-lifecycle`.
Disjoint corpus: `tests2/chaos/browser-mutants-clusterB.json`; report:
`docs/testing-v2/browser-chaos-report-clusterB.md`. Run with
`browser-chaos.mjs --corpus clusterB`.

> Team-lead reconciles this fragment into the shared tally at merge. Ports only
> ADD assertions to the existing 7 owned journeys — `guard-v2`/`tests-map.json`
> unaffected.

## Cumulative (Cluster B)

| | Count |
|---|------:|
| Behaviours mutation-tested (content mutants) | 10 |
| Real holes found | 10 |
| **Real holes CLOSED (ported + re-verified caught)** | **10** |
| Real holes OPEN | 0 |
| Null-mutant harness-integrity in corpus | 1 (BR00-null) |

> **Authoritative full run:** `--corpus clusterB --all` (10 content mutants) →
> **10/10 legacy-caught, 10/10 v2-caught, 0 real holes**; null-mutant integrity
> **PASSED** (no suite caught the no-op patch). Report:
> `docs/testing-v2/browser-chaos-report-clusterB.md`.

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
