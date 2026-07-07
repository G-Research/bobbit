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
| Behaviours mutation-tested (content mutants) | 3 |
| Real holes found | 3 |
| **Real holes CLOSED (ported + re-verified caught)** | **3** |
| Real holes OPEN | 0 |
| Null-mutant harness-integrity in corpus | 1 (BR00-null) |

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

## Remaining (next batches, Cluster B domains)

Per handoff §2b + per-domain "remaining" lists (not yet mutation-tested):
- proposals: dismiss-reload, invalid-workflow, revision-autoupdate, edit-flow, spec-survives-navigate
- goal-editing: archive-always-on, goal-creation, form-tooltips, subgoal-existing-goal-settings
- project-settings: settings-restart-button, settings-agent-dir, goal-accept-failure, goal-reattempt, project-assistant
- project-onboarding: multi-repo-subset, select-all, symlink, post-archive
- team-operations: archive-child-cascade (modal child names). **verification-progress verify-card = manual/integration tier — flagged, NOT forced.**
- session-lifecycle: session-created-push-sync, session-status-recovery (**daily tier**)
