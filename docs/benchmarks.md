# Bobbit journey benchmarks

Bobbit owns three end-to-end performance benchmarks for session opening, gateway startup, and live event streaming. They exercise built production modules and real protocol/UI boundaries so performance work is measured without transcribing implementation code into one-off harnesses.

These benchmarks are diagnostic. Correctness or lifecycle failure invalidates a sample, but normal CI does not enforce latency thresholds. None of the three commands is part of `npm run test`, `test:unit`, `test:browser`, or `test:e2e`; run them explicitly when their production boundary changes. A result never justifies changing observable behavior.

## Commands

Each package command ensures the built artifacts exist, then runs one allow-listed journey:

```bash
npm run benchmark:session-open
npm run benchmark:gateway-startup
npm run benchmark:event-stream
```

Pass runner options after `--`:

```bash
npm run benchmark:session-open -- --warmups 2 --repetitions 7 --output baseline/session-open.json
npm run benchmark:gateway-startup -- --warmups 2 --repetitions 7 --output baseline/gateway-startup.json
npm run benchmark:event-stream -- --warmups 2 --repetitions 7 --output baseline/event-stream.json
```

| Option | Contract |
|---|---|
| `--warmups N` | Warm-up cycles, `2`–`20`; default `2`. |
| `--repetitions N` | Measured cycles, `1`–`50`; default `7`. |
| `--output FILE` | Relative `.json` path beneath `.bobbit-qa/benchmarks/`. Absolute paths, traversal, links, and junctions are rejected. |
| `--keep-temp` | Retain the owned temporary run root for diagnosis instead of deleting it. |
| `-h`, `--help` | Print runner help. |

Without `--output`, the complete JSON report is written to stdout. With `--output`, stdout still receives the report and the file is written atomically. A failed run writes a sibling such as `session-open.failed.json` and never replaces the requested known-good result.

The package scripts already select `--journey`; do not pass a second journey option. The Performance Optimisation pack stores references to these named package commands, not arbitrary shell commands.

## Shared measurement contract

The default schedule has two warm-up cycles followed by seven measured cycles. Multi-case journeys reverse case order on every cycle, including across the warm-up/measured boundary, to reduce drift from cache warming, thermal state, and background load. Warm-ups remain in `samples` for auditability but are excluded from summaries.

Every successful schema-version-1 report contains:

- commit SHA and dirty state;
- OS, architecture, Node/V8, CPU, memory, browser, viewport, and metric support where applicable;
- fixture dimensions and semantic hashes;
- warm-ups, repetitions, the complete schedule, and raw samples;
- per-case count, median, nearest-rank p95, minimum, maximum, range, median absolute deviation (MAD), and coefficient of variation;
- units, lower/higher-is-better direction, reliability, interpretation, limitations, noise sources, comparison method, cleanup status, and correctness evidence.

Every declared per-sample metric is a finite number or explicit `null`. Unsupported or unreliable-to-acquire values stay `null`; they are never converted to zero. Summaries omit null values and expose their numeric `count`, while metric definitions, per-sample reliability, and `environment.metricSupport` explain support. A measured sample must contain at least one numeric metric.

Reports are intentionally bounded and credential-safe: at most 4 MiB, 4,096 array entries, 256 object keys, depth 12, and 8,000 characters per string. Commands, environment/argument dumps, full logs, DOM dumps, transcript bodies, stdout/stderr fields, and threshold fields are forbidden. Failure diagnostics contain only the scheduled sample identity and bounded, sanitized process-exit tails.

## Isolation, authentication, watchdogs, and cleanup

Fixtures and mutable sample copies live under an owner-marked `bobbit-benchmark-*` run root in the OS temporary directory, or under `BOBBIT_V2_RUN_ROOT` when the test coordinator supplies it. The runner rejects the repository `.bobbit/` state tree. Canonical fixtures are immutable inputs; each scheduled sample receives a fresh copy.

Every sample gateway enables authentication and receives a new cryptographically random token in a sample-owned secrets directory. Health probes, API calls, shutdown requests, WebSockets, and browser navigation authenticate with that token. Tokens, credential-like environment values, absolute working paths, authorization headers, command/argument lines, and environment dumps are redacted from bounded diagnostics.

Session-open samples have a 180-second watchdog; event-stream samples have a 120-second watchdog. Their watchdogs track the active phase, interrupt page execution on expiry, and close the browser if interruption does not settle within the grace period. Gateway readiness is bounded to 120 seconds; startup URL publication and correctness validation have their own shorter bounds.

Teardown closes browsers before gateways, requests authenticated graceful shutdown, then escalates only the owned process tree and verifies closure. Deferred cleanup is retried after journey failure. The run root is recursively removed only after its ownership marker and canonical location are revalidated. `--keep-temp` is the explicit exception and records the retained root in `cleanup`.

## Session-open journey

`npm run benchmark:session-open` measures the real first-open path from the browser's WebSocket `get_messages` request through a settled, interactive UI at a fixed 1280×800 viewport.

### Fixture and production boundary

The runner deterministically generates exact 1,000,000-, 10,000,000-, and 25,000,000-byte JSONL transcripts. Each fixture contains realistic user/assistant turns, Markdown and code, tool calls/results, modern and legacy error forms, a serialized legacy error, two compaction sidecars, first/last markers, and bounded prose ballast. A manifest records transcript and independent semantic/render hashes.

For every sample, the runner starts the built gateway and UI with the test mock agent, creates a project and session through production APIs, replaces the persisted transcript and compaction sidecar, restarts the authenticated gateway, and opens the real session route in Chromium. Measurement starts at `get-messages-sent` and ends after the last marker, enabled editor, post-snapshot paint mark, and two additional animation frames establish interactivity.

The primary metric is `timeToInteractiveMs`. Secondary metrics are server response latency, transferred WebSocket bytes, long-task count/total/maximum, heap growth and sampled peak heap, plus server-side RPC, pipeline, ordering-stamp, and stringify timings.

### Correctness oracle

A sample counts only if independent fixture and browser projections agree on:

- complete semantic message content and strict message order;
- rendered role order and canonical rendered text;
- unique IDs and paired tool calls/results;
- canonical normalization of modern, legacy, and serialized tool errors;
- compaction cards and exactly one first/last marker.

Deferred blocks are subsequently resolved in bounded batches for full render parity. That parity work occurs after the measured interactive boundary.

## Gateway-startup journey

`npm run benchmark:gateway-startup` measures monotonic time from child-process spawn until the authenticated production health endpoint reports ready.

### Fixture and production boundary

The deterministic cases contain 0, 100, and 1,000 persisted sessions. The larger cases contain three live/restorable sessions and respectively 97 and 997 archived sessions. Fixtures include all archived relationship forms, a bounded reachable archived graph, unrelated archived controls, a live goal, transcripts for live sessions, and a durable search sentinel.

Fixture generation uses the built production session, project, goal, and search persistence modules. Each sample relocates a fresh fixture copy, starts the built gateway on a published port-zero URL, observes authenticated readiness, and only then records process CPU and peak RSS where the platform exposes them.

The primary metric is `readyMs`. `cpuTimeMs` and `peakRssBytes` are secondary and may be null.

### Correctness oracle

Readiness is accepted only after production APIs prove:

- the expected project and exact persisted session IDs are visible;
- archived counts and relationship traversal order match the fixture, with controls excluded;
- every live session restored to idle with the pinned mock model and no restore error;
- the stable session relationship projection matches its SHA-256 hash;
- the production search index returns the archived sentinel.

## Event-stream journey

`npm run benchmark:event-stream` measures responsiveness while a deterministic production-shape event sequence streams into Chromium at 1280×800.

### Fixture and production boundary

The versioned fixture emits 48 cumulative assistant updates at 12 ms intervals, followed by settlement and realistic proposal, successful tool, failed tool, and final assistant events. This produces 68 tagged events with stable IDs, ordinals, expected semantics, tool pairs, markers, and hashes.

Each sample starts a fresh authenticated built gateway, creates its project/session through production APIs, opens the real UI, and submits the fixture trigger through the production `RemoteAgent`. The gateway owns event sequencing and WebSocket delivery; the normal client reducer and components own state and DOM commits. A browser observer records native WebSocket arrivals, first DOM commits, animation-frame cadence, long tasks, and precise-memory samples without synthesizing or delaying events.

The registry's primary metric is `eventToRenderP95Ms`, the per-sample p95 from browser arrival to the first committed DOM containing each update marker. Secondary metrics include throughput, elapsed time, estimated slow/dropped frames, long tasks, heap growth, and sampled peak heap.

### Correctness oracle

A sample fails on any lost, duplicated, reordered, or sequence-gapped tagged event. Every update ordinal must arrive and commit after arrival. The final client must be idle, have no pending tools or streaming UI, and have an enabled editor. Marker order/counts, full semantic messages, tool pairing, and DOM/semantic hashes must match the fixture. A reload must reproduce the same final DOM, markers, and semantics.

## Platform limits and noise

Use primary latency metrics for comparisons. Treat secondary measurements according to their reported reliability:

- Chromium Long Tasks can be unavailable; unsupported values are null.
- Browser heap metrics require Chromium precise-memory support. Peaks are periodic sampled lower bounds, not process-wide high-water marks.
- WebSocket bytes use CDP payload bytes when available and otherwise estimate from client frame characters.
- Slow/dropped frames are estimates from `requestAnimationFrame` cadence, not compositor telemetry.
- Linux process CPU and high-water RSS are process-specific and reliable when `/proc` data is available.
- Windows CPU and peak working set are immediate post-readiness samples and lower-confidence.
- macOS can expose partial CPU time but not peak RSS through this runner.
- Health polling adds observation latency of up to one poll interval.

Common noise sources are filesystem cache state, antivirus scanning, browser/Node JIT and garbage collection, process scheduling, concurrent host load, power mode, CPU frequency scaling, and thermal throttling. Close unrelated heavy workloads, keep power and thermal conditions stable, and record any unavoidable environmental differences.

## Reproduction and comparison

1. Use clean baseline and candidate builds on the same host.
2. Keep Node and Chromium versions, viewport, power state, warm-ups, repetitions, schema version, fixture version/hashes, and benchmark security revision identical.
3. Alternate complete baseline and candidate invocations. Within each invocation, retain the runner's alternating case schedule.
4. Reject failed cleanup or correctness reports before inspecting performance.
5. Compare the primary metric's raw measured samples, median, p95, MAD, and coefficient of variation. Use secondary metrics to explain a change, not to override parity.
6. Repeat when variability is large or the candidate effect is similar to normal run-to-run noise. Do not compare isolated best runs.

Do not compare reports solely because they share a benchmark ID. Schema, fixture hashes/dimensions, authentication/lifecycle behavior, source revision, and environment are part of the result identity.

## Initial recorded baselines

These initial records were captured on Windows `10.0.26200` x64 with Node `v24.13.1`, Chromium `148.0.7778.96`, an AMD Ryzen AI 9 HX 370, and 24 logical CPUs.

| Journey | Registry run | Source commit | Case/metric | Median | Across-run p95 |
|---|---|---|---|---:|---:|
| Session open | `run-3e5fc5cd-3f4a-40c6-803b-11485723bcb0` | `d8d2a945` | 1 MB `timeToInteractiveMs` | 2688.6 ms | 3287.5 ms |
| Session open | same run | `d8d2a945` | 10 MB `timeToInteractiveMs` | 3256.0 ms | 4041.4 ms |
| Session open | same run | `d8d2a945` | 25 MB `timeToInteractiveMs` | 3791.1 ms | 4105.5 ms |
| Gateway startup | `run-2a1df14e-28fb-4a7d-b7b9-db5f0e957d3f` | `419bae2b` | 0 sessions `readyMs` | 5620.701 ms | 6566.542 ms |
| Gateway startup | same run | `419bae2b` | 100 sessions `readyMs` | 6483.538 ms | 7316.678 ms |
| Gateway startup | same run | `419bae2b` | 1,000 sessions `readyMs` | 7372.995 ms | 8692.530 ms |
| Event stream | `run-d9989afb-0b7d-4d91-9491-cf14695e4605` | `d8d2a945` | `eventToRenderP95Ms` | 263.6 ms | 271.0 ms |
| Event stream | same run | `d8d2a945` | `eventThroughputPerSecond` | 66.122 events/s | 71.730 events/s |

For event streaming, the latency row summarizes each sample's p95 event-to-render value; the table then reports the median and p95 across measured samples. Throughput is higher-is-better even though the registry primary metric is lower-is-better.

Later authentication, containment, lifecycle, and error-diagnostic hardening did not replace these initial records. Treat them as historical starting points, not current-HEAD reruns. A candidate comparison is valid only when its report matches the baseline's schema, fixture, and security revision; otherwise record a new baseline first.

## Performance Optimisation registry

The validated named commands are registered as follows:

| Registry ID | Named command | Primary metric | Direction | Structural scan/file-glob applicability |
|---|---|---|---|---|
| `bobbit-session-open` | `npm run benchmark:session-open` | `timeToInteractiveMs` | Lower is better | Session snapshot/loading and WebSocket scan units; server session/WS modules plus app boot, transcript normalization, and UI message-rendering globs. |
| `bobbit-gateway-startup` | `npm run benchmark:gateway-startup` | `readyMs` | Lower is better | Gateway bootstrap and restoration/indexing scan units; server entrypoint, persisted store, session/project/goal restoration, archived traversal, and search globs. |
| `bobbit-event-stream` | `npm run benchmark:event-stream` | `eventToRenderP95Ms` | Lower is better | Event-ingestion/delivery and client-render scan units; agent/WS server modules plus app reducer, streaming component, and render-scheduling globs. |

Applicability is structural and limited to the production-area file globs described above. It intentionally does not make every source change run every expensive journey, and benchmark fixture/test-only edits do not select a production benchmark by themselves. Registry entries invoke only the existing package scripts above; they do not persist or execute caller-supplied shell text.

The recorded registry run IDs are the initial baselines listed above. When a schema, fixture, or security revision changes, preserve the old run as historical evidence and register a new like-for-like baseline rather than silently treating unlike reports as candidates.

## Historical context

The earlier [session-loading microbenchmarks](design/session-loading-performance-benchmarks.md) transcribed isolated hot paths and excluded transport, process startup, and browser rendering. They remain useful historical algorithm evidence, but these named journey commands are the durable source for production-boundary comparisons.
