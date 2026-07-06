# EXP-003 Warm Pool Spawn Latency Results

Generated: 2026-07-06T00:51:44.161Z (UTC)

Command: `node scripts/exp-warm-pool-report.mjs`

Commit: `a6948372ad9a0c2c0d85c9fe9b3ce2d40fee8a7f`
Pre-registration commit: `a6948372ad9a0c2c0d85c9fe9b3ce2d40fee8a7f`

Recommendation: `recommend-default-on-follow-up`

| Metric | off | on |
|---|---:|---:|
| Measured spawns | 10 | 10 |
| Median latency | 126.2 ms | 28.5 ms |
| Mean latency | 142.9 ms | 28.5 ms |
| p90 latency | 127.7 ms | 29.6 ms |
| Min latency | 124.0 ms | 26.6 ms |
| Max latency | 295.2 ms | 29.8 ms |

| Pool metric | Value |
|---|---:|
| Measured on-arm hits | 10 |
| Measured on-arm misses | 0 |
| Measured on-arm hit rate | 100.0% |
| Warm-up misses | 10 |

| Paired effect | Value |
|---|---:|
| Median paired reduction | 77.8% |
| Median paired reduction | 97.2 ms |
| p90 regression vs off | -76.8% |

| Memory | Value |
|---|---:|
| Measurable | yes |
| Median idle RSS per ready process | 57.8 MiB |
| p90 idle RSS per ready process | 58.0 MiB |
| Max idle RSS per ready process | 58.1 MiB |

Notes:

- Measurement uses an isolated in-process gateway and the repo mock-agent as a real RpcBridge child process, not the InProcessMockBridge shortcut.
- Primary ready signal is SessionManager.createSession returning a session whose normal setup path has set status to idle.
