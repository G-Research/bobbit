# observe — full-stack human-like observer harness

Prototype framework that drives the real Bobbit app (real gateway, real agent
CLI, real browser) and watches for two failure modes:

1. **Hang** — agent status sits in `streaming` (or `pending`) with no growth
   in `state.messages` and no token activity for `--hang-ms` (default 30 s).
2. **Out-of-order rendering** — DOM order of `<user-message>` / `<assistant-message>`
   elements disagrees with `state.messages` sorted by `_order`/timestamp.

It captures, throughout the run:

- A screenshot **before** and **after** every user action.
- A screenshot **and** `window.bobbitState` snapshot **every 1 s**.
- The DOM transcript order at every snapshot (rendered message IDs).

Output: `tests/observe/runs/<timestamp>/` with `timeline.json`, screenshots,
state JSONs, and `report.html`.

## Run

```bash
# default scenario: 3 prompts, ~2 min
npx tsx tests/observe/run.ts

# pick a scenario, control thresholds
npx tsx tests/observe/run.ts --scenario rapid-fire --hang-ms 20000 --headed

# point at an existing dev gateway instead of spawning one
GATEWAY_URL=http://localhost:3001 BOBBIT_TOKEN=$(cat .bobbit/state/token) \
  npx tsx tests/observe/run.ts --no-spawn
```

Real agent CLI is required on PATH (same prereq as `npm run test:manual`).

## Layout

- `observer.ts` — Playwright-side recorder: 1 Hz tick + action wrappers.
- `detectors.ts` — pure functions over the timeline that flag hang / OOO.
- `scenarios.ts` — sequences of human-like actions to run.
- `run.ts` — entry point: spawn (or attach to) gateway, open browser, drive scenario, write report.
- `report.ts` — emit `report.html` from `timeline.json`.
