# Test suite speed and retired affected-selection baseline

Bobbit now runs the existing complete unit, browser, E2E, and manual lanes directly. The affected-test selector and its cache, graph, impact registry, and proof machinery were removed because maintaining a second model of test ownership created drift and false-confidence risk. The lane commands retain their existing discovery, worker, retry, fixture, and isolation behavior.

Current commands are documented in the [testing strategy](../testing-strategy.md) and [unit gate operating model](unit-gate.md):

```bash
npm run test:unit
npm run test:browser
npm run test:e2e
npm run test:manual  # Gate-exempt and opt-in
```

## Historical pre-removal baseline

> **Historical evidence only.** The commands in this section targeted the removed affected-test implementation. They are recorded for auditability and must not be used as current testing guidance.

The final baseline was measured on Windows at commit `09d52aea394ff7ca0441b01c210fb3424c722768` on 2026-08-27. The checkout's authoritative unit inventory contained 1,195 files. All direct scenarios were dry plans, so they executed zero tests; their wall values measure selector graph construction and planning only.

Exact direct-plan commands:

```bash
npm run test:affected -- --changed docs/extension-host-authoring.md --dry --json --no-cache > "$TEMP/affected-dry-docs.json"
npm run test:affected -- --changed src/ui/tools/renderers/GateInspectRenderer.ts --dry --json --no-cache > "$TEMP/affected-dry-ui.json"
npm run test:affected -- --changed package-lock.json --dry --json --no-cache > "$TEMP/affected-dry-lockfile.json"
```

| Scenario | Historical plan | Selected / total | Selection rate | Planner wall |
|---|---|---:|---:|---:|
| Ordinary documentation | `SKIP-ALL` | 0 / 1,195 | 0.0% | 3.487 s |
| UI renderer | `BOUNDED` | 211 / 1,195 | 17.7% | 3.478 s |
| Lockfile | `RUN-ALL` | 1,195 / 1,195 | 100.0% | 3.746 s |

The small historical replay used:

```bash
npm run test:affected:proof -- 3 --json "$TEMP/affected-proof-baseline.json"
TIMEFORMAT='proofWallSeconds=%R'; time npm run test:affected:proof -- 3
```

It evaluated three recent primary-branch commits plus seven fixed acceptance rows: one skip-all, four bounded, and five run-all plans. Across those ten rows, executable plans selected 7,841 of 11,950 possible file-runs (**65.6%**). The four bounded rows averaged 467 of 1,195 files (**39.1%**) and 13 ms of classification time after graph construction. The full proof took **40.647 s** wall time and reported no suspicious zeroes, under-selection, or violations.

These figures preserve the final selection-rate and planning-cost snapshot; they are not a performance target for the complete lanes. Current performance work must measure the canonical lane commands themselves rather than recreate path-impact selection, dependency inference, inventories, or local PASS caches.
