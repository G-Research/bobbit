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
| Behaviours mutation-tested (content mutants) | 7 |
| Real holes found | 7 |
| **Real holes CLOSED (ported + re-verified caught)** | **7** |
| Ported + clean-passed, mutation re-verify PENDING | 2 (BR52, BR56) |
| Real holes OPEN | 0 |
| Null-mutant harness-integrity in corpus | 1 (BR00-null) |

## Batch 3 — 2 holes ported, re-verify PENDING (BR52, BR56)

Both ports authored + **clean-passed on unmutated dist (2/2 green)** and
committed. The `--corpus clusterB --ids BR52,BR56` mutation re-run crashed
transiently on a Playwright `loadConfigFromFile` error in the ephemeral
worktree (machine paused for a concurrency study mid-run) — BR52 legacy=caught,
v2=**error/not-run**, BR56 not reached. NOT a confirmed hole; re-verify pending
the machine all-clear. Neither port weakens or is dropped.

| Mutant | Domain / journey | Ported assertion |
|---|---|---|
| BR52 | project-onboarding | ghost `.bobbit/` dir → preflight panel + `bobbit.existing` check row + `preflight-archive-cta` visible |
| BR56 | team-operations | non-goal terminate modal enumerates child agents BY NAME ("its 2 child agents: …CascadeChildAlpha…CascadeChildBeta") |

### RESUME POINT
Last committed batch: **batch 3 ports** (commit 955682e4). Next action on
all-clear: `node scripts/testing-v2/browser-chaos.mjs --corpus clusterB --ids
BR52,BR56` to confirm v2-caught; then a final `--corpus clusterB --all` for the
authoritative 0-holes report. After that, next behaviours to mutation-test:
proposals (dismiss-reload, invalid-workflow, revision-autoupdate,
spec-survives-navigate — behavioural, not dropped-testid), project-settings
(settings-restart-button, goal-accept-failure, goal-reattempt, project-assistant).
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
