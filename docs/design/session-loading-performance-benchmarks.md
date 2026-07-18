# Session-loading performance benchmarks

Measured 2026-07-18 on the integrated candidate. These are deterministic, source-equivalent microbenchmarks of the three changed hot paths, not end-to-end browser timings.

## Revisions and environment

- Baseline: `origin/master` at `d706e2096443e691bbfd47397d211c23de7ff47b`
- Candidate: `0f25a4fb7085225b438570d11f04c751583777c3`
- OS: Windows 11 x64, build `10.0.26200`
- CPU: AMD Ryzen AI 9 HX 370, 24 logical CPUs
- Memory: 63.1 GiB
- Runtime: Node `v24.13.1`, V8 `13.6.233.17-node.40`, tsx `4.23.1`

The machine was otherwise in normal developer use. CPU affinity, power state, and garbage collection were not forced.

## Method

A temporary standalone TypeScript harness transcribed the changed control-flow blocks from the two revisions, then was deleted rather than adding benchmark code to the product or test map. Surrounding RPC dispatch and snapshot normalization were reduced to behavior-equivalent operations for the deterministic inputs described below. The baseline blocks came from `origin/master:src/server/server.ts::bfsEnrichArchived`, `origin/master:src/server/agent/rpc-bridge.ts::handleData`, and the baseline `get_messages` path in `origin/master:src/server/ws/handler.ts`. Candidate blocks came from `src/server/agent/archived-session-bfs.ts`, `RpcBridge.handleData()`, and `SessionManager.getMessagesSnapshotBase()`.

The command sequence was:

```bash
git rev-parse origin/master
git rev-parse HEAD
node --version
npx --no-install tsx .tmp-session-loading-bench.ts > .tmp-session-loading-bench-results.json
```

For each case the harness performed two untimed warm-ups per implementation, followed by nine measured samples. Baseline and candidate order alternated on each sample. Timing used `performance.now()`. Median is the middle sorted sample; p95 uses nearest rank and therefore equals the maximum with nine samples.

The harness asserted deep result equality before printing results and computed SHA-256 over the common JSON output. Inputs contained no randomness:

1. **Archived-session preparation:** 10,000 archived rows, one live seed, and a stable chain of 100 reachable rows. The remaining 9,900 rows referenced deterministic unreachable parents. The baseline included the default-route clone/enrich of every archived row before its full-scan BFS. The candidate indexed raw rows and used the same clone/enrich callback only for reachable rows.
2. **Repeated snapshot base:** a fixed sequence (`lastSeq = 42`), 100,000 messages including 5,000 legacy `is_error` tool results, and 20 sequential same-sequence requests per sample. The baseline repeated the RPC and normalization path; the candidate used the sequence-keyed promise memo. The generated messages exercise the direct legacy error-flag normalization path; live overlays and sidecars were deliberately excluded because both revisions recompute them per response.
3. **Large RPC line:** one valid 16 MiB JSONL event split into 64 KiB chunks. In addition to wall time, temporary instrumentation counted the receiver length of every newline `split`, `indexOf`, and `lastIndexOf`. Both framers had to emit exactly one event, preserve the full payload, and finish with an empty partial-line buffer.

To reproduce, use the revisions and deterministic dimensions above, transcribe the named control-flow blocks into a temporary harness, retain the equality/hash assertions, and use the same warm-up, alternating-order, sample-count, and nearest-rank calculations. The raw samples below permit comparison with a rerun.

## Results

All times are milliseconds. “Range” is minimum–maximum.

| Case | Baseline median | Baseline p95 | Baseline range | Candidate median | Candidate p95 | Candidate range | Median improvement |
|---|---:|---:|---:|---:|---:|---:|---:|
| Archived preparation and BFS | 25.204 | 27.341 | 24.982–27.341 | 1.500 | 5.311 | 1.041–5.311 | 16.80× |
| 20 same-sequence snapshots | 52.537 | 54.238 | 48.201–54.238 | 2.548 | 2.801 | 2.341–2.801 | 20.62× |
| 16 MiB chunked RPC line | 455.628 | 514.572 | 350.920–514.572 | 17.964 | 27.664 | 11.234–27.664 | 25.36× |

The snapshot batch made 20 baseline RPC calls and one candidate RPC call. The RPC framing instrumentation counted 2,155,872,256 searched characters for the baseline versus 16,908,288 for the candidate: 127.50× fewer, consistent with removing accumulated-buffer rescans.

### Identity checks

| Output | Common SHA-256 |
|---|---|
| Ordered archived descendants | `de9c3f90def5d29a565149e5b83533e1499c798ddefe80ca15d172833e439670` |
| Normalized snapshot response | `087e16e826102e4f11745a6157631513697fed66ca2c01cca5b59da62cc63e93` |
| Parsed 16 MiB RPC event | `bf2a0d5fc9a037522ec941d365edfbc37cf2d24dbaa1b00a62128ebbabff4714` |

### Raw samples

| Case | Baseline samples (ms) | Candidate samples (ms) |
|---|---|---|
| Archived preparation and BFS | 25.204, 25.464, 24.982, 27.341, 24.982, 26.607, 25.077, 25.127, 25.671 | 1.640, 1.358, 1.500, 5.311, 1.132, 1.041, 1.098, 1.633, 1.894 |
| 20 same-sequence snapshots | 52.537, 49.185, 53.894, 48.760, 53.609, 48.201, 53.425, 48.442, 54.238 | 2.581, 2.548, 2.674, 2.601, 2.801, 2.497, 2.341, 2.526, 2.489 |
| 16 MiB chunked RPC line | 350.920, 379.490, 411.364, 485.915, 471.803, 514.572, 443.901, 470.120, 455.628 | 11.234, 14.888, 17.280, 15.130, 20.678, 17.964, 20.505, 18.347, 27.664 |

## Interpretation and limitations

- These measurements isolate algorithmic work. They do not include HTTP/WebSocket transport, JSON response serialization, filesystem access, process startup, browser rendering, or network latency.
- The archived case models the default `/api/sessions` descendant preparation path rather than launching two complete gateways with seeded stores. It includes the baseline's eager clone/enrich work and the candidate's reachable-only clone callback.
- The snapshot case measures memoized base assembly. Overlay, compaction-sidecar, skill-sidecar, ordering-stamp, truncation, and serialization work remains per response by design, so a complete response will improve by less than this isolated result.
- The RPC case uses a single valid line and excludes `StringDecoder` and pipe I/O. JSON parsing is included equally. Search-character instrumentation is deterministic evidence of complexity; wall time remains machine- and V8-dependent.
- Nine samples are sufficient to show the large effects but not to characterize production tail latency. The candidate archived sample includes one 5.311 ms outlier, which is visible in its range and p95.
- Legacy 20–24 MB first-open transcripts remain limited by full history assembly, transfer, parse, and rendering. This work does not stream, paginate, omit, or lazily restore that history; its snapshot benefit applies to unchanged-sequence repeat loads.
