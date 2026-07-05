# EXP-001 Gate Cache Keying Results

Generated: 2026-07-05T23:12:10.878Z
Recommendation: `recommend-content-for-next-lane`

| Metric | sha | content |
|---|---:|---:|
| Paired scenarios | 9 | 9 |
| Cacheable step decisions | 27 | 27 |
| Cache hits | 4 | 11 |
| Cache hit rate | 14.8% | 40.7% |
| SHA-key hits | 4 | 4 |
| Content-key hits | 0 | 7 |
| False-hit risk proxy | 0 | 0 |
| Estimated wall-clock total | 1,845,000 ms | 1,410,000 ms |
| Estimated wall-clock median | 315,000 ms | 180,000 ms |
| Decision engine wall-clock | 0 ms | 347 ms |

Effect summary:

- Cache hit-rate delta: 25.9 percentage points.
- Total estimated wall-clock savings: 435,000 ms.
- Median estimated wall-clock reduction: 42.9%.
- Median paired reduction: 0.0%.
- Content decision overhead share of savings: 0.1%.

Scenario pairs:

| Scenario | sha estimated wall-clock | content estimated wall-clock | savings | reduction |
|---|---:|---:|---:|---:|
| dependency-change | 315,000 ms | 315,000 ms | 0 ms | 0.0% |
| docs-only-change | 315,000 ms | 120,000 ms | 195,000 ms | 61.9% |
| earliest-prior-passed-result | 60,000 ms | 60,000 ms | 0 ms | 0.0% |
| exact-sha-resignal | 0 ms | 0 ms | 0 ms | n/a |
| glob-matches-no-tracked-path | 30,000 ms | 30,000 ms | 0 ms | 0.0% |
| no-cache-input-globs | 180,000 ms | 180,000 ms | 0 ms | 0.0% |
| public-asset-change | 315,000 ms | 180,000 ms | 135,000 ms | 42.9% |
| source-change | 315,000 ms | 315,000 ms | 0 ms | 0.0% |
| test-only-change | 315,000 ms | 210,000 ms | 105,000 ms | 33.3% |
