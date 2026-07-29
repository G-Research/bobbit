# Experiment Runner smoke test

Date: 2026-06-21
Gateway: `http://127.0.0.1:3005`
Parent goal: `cdb260f0-96fe-4350-8093-bfe2a0008477`
Parent session: `22bd1fb5-fd2f-4319-bfa3-cb838bbcebec`
Experiment id: `smoke-ab-20260621003841`

## Result

**Status: pass with caveats.** The runner is ready for a small real Graphify A/B benchmark, provided the real run uses a realistic per-run budget and an intentional workflow choice. The smoke test verified pack activation, UI launchers, A/B child-goal fan-out, treatment metadata propagation, route lifecycle calls, editable metric/dashboard specs, report generation, autoresearch guardrails, and non-optional UI-driven E2E fixture coverage.

Caveats:
- The intentionally low per-run budget (`0.05`) was below actual model startup cost, so both smoke arms were marked `failed` with `over_budget` during `poll`. This still verified bounded-budget enforcement and report generation, but did not produce collected success metrics.
- The experiment definition intentionally omitted `workflowId`. The spawned child goals received the project default workflow `general`; no custom experiment workflow was required and no workflow route error occurred.
- After evidence capture, both child teams were torn down with `POST /api/goals/:id/team/teardown?cascade=false` to stop further spend.

## Pack and route activation

`GET /api/ext/contributions?projectId=762fef1c-5a69-469e-a5da-1b85862668c2` returned active pack contribution metadata for `experiment-runner`:

- Panel: `experiment-runner.panel` (`Experiments`)
- Session menu entrypoint: `experiment-runner.palette`, label `New experiment`
- Composer slash entrypoint: `experiment-runner.open`, label `Experiments`
- Deep-link route entrypoint: `experiment-runner.route`, `routeId: experiment-runner`, params `experimentId`, `view`
- Route names: `defineExperiment`, `projectCost`, `launch`, `poll`, `collect`, `aggregate`, `iterate`, `listExperiments`, `getExperiment`, `saveMetrics`, `saveDashboard`, `report`, `listMetrics`, `listWidgets`, `cancel`

No `NO_EFFECTIVE_GOAL`, `SPAWN_GOAL_UNAVAILABLE`, pack-route, or workflow errors were observed.

## UI surface checks

Verified in the running browser against this parent session:

- Deep link `#/ext/experiment-runner` opened the side panel titled `Experiments` with the `New experiment` screen.
- Session actions menu contained `New experiment`.
- Composer slash search for `/Exp` showed `/experiment-runner.open Experiments`.
- Default panel copy presents A/B as the recommended bounded mode and Autoresearch as `Autonomous · opt-in · hard caps required`, confirming autoresearch is not the default launch path.

Browser console notes: initial `401` requests occurred before connecting with the gateway token, and one transient `no registered panel` warning appeared before the panel was available. The panel opened successfully afterward.

## Minimal A/B definition

Definition route: `defineExperiment`

Key fields:

```json
{
  "experimentId": "smoke-ab-20260621003841",
  "mode": "ab",
  "parentGoalId": "cdb260f0-96fe-4350-8093-bfe2a0008477",
  "workflowId": null,
  "variants": ["baseline", "variant-b"],
  "repeats": 1,
  "maxConcurrency": 2,
  "perRunBudget": 0.05,
  "sameCompletionBar": false
}
```

Projection returned:

```json
{
  "mode": "ab",
  "arms": 2,
  "estPerArmUsd": 0.5,
  "estCostUsd": 1,
  "concurrencyCap": 2
}
```

Variant treatment metadata:

- `baseline`: `metadata.experiment.userMetrics.metric = 1`, `metadata.experiment.userMetrics.smokeBaselineMarker = 101`, `metadata.smokeTreatment.marker = smoke-baseline-101`
- `variant-b`: `metadata.experiment.userMetrics.metric = 2`, `metadata.experiment.userMetrics.smokeVariantMarker = 202`, `metadata.smokeTreatment.marker = smoke-variant-b-202`

## Launch and child goals

`launch` returned exactly two runs and exactly two child goal ids for the experiment:

| Arm | Run id | Child goal id | Status after launch |
|---|---|---|---|
| `baseline` | `baseline--r0` | `83ae8bfc-fa72-401c-8821-aca1707c1dfc` | `spawned` |
| `variant-b` | `variant-b--r0` | `a174329f-fe14-4b04-b0fe-667453a8ddae` | `spawned` |

Goal inspection confirmed both child goals are under parent `cdb260f0-96fe-4350-8093-bfe2a0008477` and carry the expected metadata.

Baseline child goal:

```json
{
  "id": "83ae8bfc-fa72-401c-8821-aca1707c1dfc",
  "parentGoalId": "cdb260f0-96fe-4350-8093-bfe2a0008477",
  "spawnedFromPlanId": "smoke-ab-20260621003841:baseline--r0",
  "workflowId": "general",
  "metadata": {
    "experiment": {
      "experimentId": "smoke-ab-20260621003841",
      "armId": "baseline",
      "repeat": 0,
      "budget": 0.05,
      "userMetrics": { "metric": 1, "smokeBaselineMarker": 101 }
    },
    "smokeTreatment": { "arm": "baseline", "marker": "smoke-baseline-101" }
  }
}
```

Variant-B child goal:

```json
{
  "id": "a174329f-fe14-4b04-b0fe-667453a8ddae",
  "parentGoalId": "cdb260f0-96fe-4350-8093-bfe2a0008477",
  "spawnedFromPlanId": "smoke-ab-20260621003841:variant-b--r0",
  "workflowId": "general",
  "metadata": {
    "experiment": {
      "experimentId": "smoke-ab-20260621003841",
      "armId": "variant-b",
      "repeat": 0,
      "budget": 0.05,
      "userMetrics": { "metric": 2, "smokeVariantMarker": 202 }
    },
    "smokeTreatment": { "arm": "variant-b", "marker": "smoke-variant-b-202" }
  }
}
```

## Lifecycle routes

Executed route sequence:

1. `poll`
2. `collect`
3. `aggregate`
4. `report`
5. `saveMetrics`
6. `saveDashboard`
7. `report` again
8. `getExperiment`

`poll` outcome:

- Both runs crossed the configured `perRunBudget` and were marked `failed` with `error: over_budget`.
- `allSettled: true` was returned.
- Costs captured:
  - baseline: `$0.189494`, `29744` input tokens, `429` output tokens
  - variant-b: `$0.142015`, `28049` input tokens, `59` output tokens

`collect` outcome:

- Returned both terminal failed runs. Because they were already failed, no raw success outcome was collected and metric maps remained empty.
- Experiment state was later confirmed as `{ "status": "done" }`.

`aggregate` outcome:

- Returned an A/B model with both arms and the selected metrics.
- Values were `null` because failed over-budget runs do not contribute collected metrics.

Initial `report` outcome:

- Returned a dashboard/report payload with `model` and `html`.
- Report HTML was generated successfully.

Metric/dashboard edit check:

- `saveMetrics` returned `{ "ok": true }` for edited metrics: `cost.totalUsd`, `time.wallClockMs`.
- `saveDashboard` returned `{ "ok": true }` for edited widgets: `edited-summary`, `edited-raw`.
- A subsequent `report` returned:

```json
{
  "htmlLength": 3827,
  "metricIds": ["cost.totalUsd", "time.wallClockMs"],
  "widgetIds": ["edited-summary", "edited-raw"],
  "runStatuses": ["failed", "failed"]
}
```

## Autoresearch guardrail check

No autoresearch loop was launched.

A direct `defineExperiment` call for `mode: autoresearch` with objective, stop, and per-run budget but no finite hard cap returned:

```json
{ "error": "AR_UNCAPPED" }
```

This confirms autoresearch remains opt-in and requires hard caps before launch.

## Registry checks

- `listMetrics` returned 9 metric descriptors.
- `listWidgets` returned 6 widget descriptors.

## Cleanup

To contain cost after evidence capture, child teams were torn down:

- `POST /api/goals/83ae8bfc-fa72-401c-8821-aca1707c1dfc/team/teardown?cascade=false` → `{ "ok": true, "toreDown": 1 }`
- `POST /api/goals/a174329f-fe14-4b04-b0fe-667453a8ddae/team/teardown?cascade=false` → `{ "ok": true, "toreDown": 1 }`

Final session inspection showed no live sessions for either child goal.

## Automated coverage

Added non-optional browser E2E coverage in `tests/e2e/ui/experiment-runner-smoke.spec.ts`. The test installs the deterministic local fixture pack from `tests/fixtures/market-sources/experiment-runner-smoke-src/`, so it no longer depends on `experiment-runner` already being installed on `origin/master` and does not skip when the pack is absent.

The fixture pack contributes the same smoke-test surfaces required by this goal:

- Session-menu launcher: `New experiment`
- Composer slash launcher: `Experiments`
- Deep link: `#/ext/experiment-runner`
- Panel: `experiment-runner.panel`
- Routes: `defineexperiment`, `launch`, `poll`, `collect`, `aggregate`, `savemetrics`, `savedashboard`, `report`, `getexperiment`, `listmetrics`, `listwidgets`, `cancel`

The E2E is UI-driven for the launch path. It creates a temporary parent goal, starts its team lead to provide an effective parent goal/session, opens the Experiment Runner through the session menu, slash launcher, and deep link, fills the panel fields, clicks `Define experiment`, clicks `Confirm and launch`, and asserts exactly two child goals are created under that parent.

Fixture child-goal expectations are exact:

- Arms: `baseline`, `variant-b`
- Repeats: one per arm
- Per-run budget: `0.05`
- Baseline treatment: `metadata.smokeTreatment = { arm: "baseline", marker: "smoke-baseline-101" }`
- Variant-B treatment: `metadata.smokeTreatment = { arm: "variant-b", marker: "smoke-variant-b-202" }`
- Experiment metadata includes `metadata.experiment.id`, `armId`, `repeat`, `budget`, and `planId`

The test then drives the dashboard lifecycle from the panel (`poll` → `collect` → `aggregate`), edits and saves metric/dashboard JSON (`cost.totalUsd`, `time.wallClockMs`, `edited-summary`, `edited-raw`), generates a report, reloads the app, reopens `#/ext/experiment-runner?experimentId=...&view=report`, verifies the saved specs/report persisted through `getexperiment` and `report`, and cancels/cleans up the temporary experiment goals.

Autoresearch coverage remains a guardrail only: the test calls `defineexperiment` with `mode: "autoresearch"` and no finite hard caps, expects `AR_UNCAPPED`, and never launches an autonomous loop. It also fails on `NO_EFFECTIVE_GOAL`, `SPAWN_GOAL_UNAVAILABLE`, parent mismatch, pack-route, or workflow errors in route responses, browser alerts/status messages, or console output.

## Readiness notes

The runner is ready for a real Graphify A/B benchmark smoke-sized launch. Recommended setup for the real benchmark:

1. Use a per-run budget above the observed startup floor; `0.05` was too low for even the minimal smoke arms.
2. Decide whether to use the project default `general` workflow or an explicit benchmark workflow. Omitting `workflowId` works but still resolves to the project default workflow.
3. Keep `maxConcurrency` at `1` or `2` for the first Graphify run and verify collection before scaling repeats.
4. Leave autoresearch disabled unless explicit finite caps, stop conditions, and per-run budget are configured.
