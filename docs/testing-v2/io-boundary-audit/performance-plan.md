# I/O boundary performance plan

**Date:** 2026-07-15
**Evidence:** existing merge-base audit, `.profiles/eligible-io/clean-groups.json` and its logs, `.profiles/hotspots/clean-before.json` and its logs, and the retained loaded lane logs under `.profiles/unit-lanes/`. No new measurement is claimed here.

> **Latest quantified route:** [`core-fidelity-contention-route.md`](core-fidelity-contention-route.md) supersedes the critical-lane forecast after the coverage-reduced 679.2s run. It measures the clean lane at 177.03s and exact delegated before/after deltas, but no pre-restoration full run is acceptance evidence.

## Decision

The latest lane walls are:

| Lane | Wall |
|---|---:|
| integration-1 | **809.8s** |
| core-fidelity | 679.6s |
| integration-3 | 649.1s |
| core | 636.9s |
| DOM | 175.3s |

`integration-1` is the critical lane. The acceptance gap is **509.8s**. All seven eligible narrow groups are in core or DOM, so their immediate critical-path saving is **0s**. Scheduling and lane allocation remain frozen.

## Eligible narrow groups

The ranking uses the one-worker focused measurements generated at `2026-07-15T09:49:33.381Z`. These measurements ran every test in the named files, while eligibility covers only the exact assertion subsets in [`index.md`](index.md). Accordingly:

- **Focused wall** is the external wall of the dedicated invocation.
- **Cumulative tests** is Vitest's reported test time for every test in those files, not just eligible assertions.
- **Entire-file upper bound** is Vitest's total duration for those files. It deliberately overstates narrow-conversion savings.
- **Maximum latest-suite effect** is zero because none changes the 809.8s `integration-1` wall.

| Rank | Eligible group and timed files | Focused wall | Cumulative tests | Entire-file upper bound | Domain lane | Maximum latest-suite effect |
|---:|---|---:|---:|---:|---|---:|
| 1 | Preview decisions — `preview-mount.test.ts`, `preview-artifacts.test.ts` | **15.756s** | 14.560s | 15.300s | core | **0.000s** |
| 2 | DOM PR launcher decisions — `message-editor-pack-slash.test.ts`, `session-menu.test.ts` | **5.561s** | 3.080s | 5.060s | DOM | **0.000s** |
| 3 | Pool-claim stability — `pool-claim-stable-branch.test.ts` | **1.523s** | 0.791s | 1.010s | core | **0.000s** |
| 4 | Pack activation decisions — `pack-default-disabled.test.ts` | **1.008s** | 0.075s | 0.511s | core | **0.000s** |
| 5 | Terminal proxy routing — `extension-host-terminal.test.ts` | **0.896s** | 0.064s | 0.448s | core | **0.000s** |
| 6 | MCP catalogue/policy — `mcp-meta-name.test.ts`, `mcp-meta-schema.test.ts`, `mcp-meta-policy.test.ts`, `mcp-policy-prefix.test.ts` | **0.863s** | 0.019s | 0.371s | core | **0.000s** |
| 7 | Session-store semantics — `session-store.test.ts`, `session-store-stale-load-guard.test.ts` | **0.823s** | 0.014s | 0.268s | core | **0.000s** |
|  | **Total** | **26.428s** | **18.603s** | **22.968s** | core/DOM | **0.000s** |

Even the impossible counterfactual that removes every timed file and its invocation is only about **26.4s** of focused wall; removing all reported test work is only about **18.6s**. Both are far below the **509.8s** acceptance gap, and neither shortens the unchanged 809.8s critical lane.

### Authorized implementation order

Only the narrow groups already authorized by the audit may change:

1. **Preview decisions:** supply manifest/tree/hash inputs and injected stage-operation outcomes. Keep real selective copy, bytes, stage/swap rename, mtime, temp-file absence, and watcher delivery/re-arm canaries.
2. **DOM launcher decisions:** supply launcher entries, a recording host factory, and a `NO_PR` result. Keep the production autocomplete/route/header/body/feedback browser owner.
3. **Pool-claim stability:** use the store seam only for persisted branch/path preservation. Keep real refs, reflog, worktree topology, push/delete, and Git-output canaries.
4. **Pack activation:** supply manifest records and activation-store results only. Keep real enumeration, reads, module loading, precedence, and installed dispatch.
5. **Terminal routing:** use the proxy `ChannelPtyService`/PTY host for frame and status projection only. Keep platform spawn and PTY output/attach/exit/kill/restart canaries.
6. **MCP catalogue/policy:** use supplied catalogues/descriptors and recording transports for naming, schema, filtering, operation mapping, and error mapping. Keep real stdio/HTTP session and generated-proxy lifecycle canaries.
7. **Session-store semantics:** use injected `FsLike`/memfs and write failures for semantic decisions only. Keep real `sessions.json`, temp/backup/recovery, traversal/mtime, and restart-visibility canaries.

## Four stopped hotspot paths

These are ranked by loaded file time where the retained latest logs report one. The latest loaded run records four failing assertions across the first three paths. `rpc-bridge-lifecycle` was clean-focused but has no loaded file result in the retained latest lane logs; no loaded time or failure is invented for it.

| Rank | Hotspot | Clean focused wall / tests | Loaded file time | Exact retained loaded failure or protected assertion |
|---:|---|---:|---:|---|
| 1 | `tests2/integration/mcp-meta-call.test.ts` | 20.379s / 19.531s | **190.856s** (`integration-1`) | `POST /api/internal/mcp-call lets broad role allow override persisted per-op \`never\`` — 60s timeout at line 613. |
| 2 | `tests2/core/team-manager.test.ts` | 7.374s / 5.892s | **177.917s** (`core-fidelity`) | `should handle completeTeam with real worktrees` — 30s timeout; `should create distinct worktrees for coder, reviewer, and tester` — 30s timeout. |
| 3 | `tests2/integration/maintenance-api.test.ts` | 25.660s / 24.749s | **72.309s** (`integration-3`) | `scan exposes UX dispositions, reason categories, groups, and selection presets` — `fetch failed`, caused by `read ECONNRESET`, while `listProjects()` seeded the case. |
| 4 | `tests2/core/rpc-bridge-lifecycle.test.ts` | 1.520s / 0.621s | Not reported | Sole protected assertion: `rejects a pending prompt exactly once when the Pi child exits unexpectedly`; clean evidence asserts exit `17`, crash stderr, one rejection, one `process_exit`, `running === false`, and idempotent stop. |

### Fixture/adapter plan and retained canaries

#### 1. MCP meta-call

- **Reuse:** keep one fork-scoped gateway and seeded fake MCP-client catalogue for the route/policy matrix; use the already-authorized supplied catalogue/recording transport for pure naming, policy, operation, and error mapping rather than rebuilding equivalent state.
- **Retain:** real loopback route/auth/project scoping; no fallback from project manager to default; real stdio discovery/calls/errors; streamable-HTTP session-header/close ownership; generated-file import and Pi proxy lifecycle. The last two remain unproved and cannot be claimed away.
- **Targeted concurrent proof:** before a full run, run this file without retries under the current production integration concurrency and competing fixed lanes. All 15 assertions must pass, especially the persisted per-op `never` override, with no 60s timeout, connection reset, manager leak, or tool-registration leak.

#### 2. Team manager

- **Reuse:** create one repository template and cheap per-case clones/copies; reuse setup primitives and remove redundant commits/process launches. `TeamWorktreeService.createMember()` may serve orchestration-only tests through `{path, branch, baseSha, registered}` but cannot replace real Git assertions.
- **Retain:** inherited files, exact HEAD and `baseSha`, unpublished local base behavior, distinct member worktrees, `git worktree list`, cleanup/prune, and persisted state around real results.
- **Targeted concurrent proof:** before a full run, exercise the entire real-Git block under the current core-fidelity plus integration contention. Both latest failing assertions and the other real-worktree assertions must pass without retries or 30s timeouts, and post-run worktree/ref cleanup must remain observable.

#### 3. Maintenance API

- **Reuse:** share cheap clone fixtures across cases. Feed pure ownership classification through `WorktreeInventoryBackend` plus the canonical ownership index; do not fake removal outcomes.
- **Retain:** real worktree/branch existence, preservation and deletion; shared-owner protection; stale and colliding paths; selector matching; selected/all cleanup; sandbox skipping; and safe branch deletion.
- **Targeted concurrent proof:** before a full run, run the complete isolated file under the current integration contention. The exact scan assertion must pass with no `ECONNRESET`, and the retained removal/preservation/branch assertions must all pass against real Git state.

#### 4. RPC bridge lifecycle

- **Reuse:** use the existing `InProcessMockBridge` only for surrounding policy/state tests and share a synthetic-child fixture/launcher where practical. It cannot replace this file's real child.
- **Retain:** the single synthetic Pi child canary and its exact exit `17`, stderr, one rejection, one `process_exit`, cleared running state, and idempotent-stop assertions.
- **Targeted concurrent proof:** before a full run, run the canary under the current core plus integration process load, without retries. It must complete within its existing deadlines with exactly one rejection/event and no surviving child.

## Implemented hotspot wave and targeted concurrent proof

The eligible narrow seam wave was **not** pursued: its impossible upper bound cannot affect the current integration critical path. The first implementation wave instead retained every real boundary and reduced load amplification through fixture/adapter reuse in the four failing hotspots.

| Hotspot | Exact fixture/adapter change | Clean before → after | Three-round concurrent result | Retained real boundary |
|---|---|---:|---:|---|
| `team-manager.test.ts` | Reused immutable published/unpublished repositories; production still creates a fresh registered worktree for each lifecycle; compatible Git reads batched; exact suite cleanup deferred to `afterAll`. | 5.89s → 4.15s tests | 52/52 each round; process walls 6.64s, 6.59s, 6.84s | Real inherited bytes, unpublished HEAD/base, local-only remote absence, registration, provisioning order, dismiss/complete preservation, persisted `baseSha`, three distinct worktrees. |
| `maintenance-api.test.ts` | Cached the stable gateway/default-project identity, reused an immutable bare seed through isolated real shared clones, batched SessionStore fixture persistence, buffered real HTTP responses before teardown. | 24.75s → 27.08s tests (no quiet-speed claim) | 24/24 each round; process walls 33.60s, 34.20s, 34.69s; no `ECONNRESET` | Real HTTP, Git worktree inventory/removal/preservation, stale/live/sandbox classifications, selectors, branch deletion, transcript/archive persistence. |
| `rpc-bridge-lifecycle.test.ts` | Simplified the real Node child and added a child-output readiness handshake; removed polling/timers/temp-directory overhead; closed stdio/listeners exactly. | 621ms → 128–144ms tests | 1/1 each round; process walls 1.89s, 1.76s, 1.88s; separate 8-CPU-burn stress also passed 8/8 | Real child spawn, prompt write, crash stderr, exit `17`, one rejection, one `process_exit`, `running=false`, idempotent stop. |
| `mcp-meta-call.test.ts` | Hoisted immutable descriptors/roles, cached stable project/token, reused three role-isolated session identities, awaited manager disconnects, and exactly reset sessions/roles/policy/managers. | 19.53s → 13.11s tests | 15/15 each round; process walls 17.57s, 17.47s, 17.96s; no 60s timeout | Real gateway HTTP/auth/project scoping, manager disconnect/registration, runtime-key conflict, namespace stripping, persisted deny/broad-allow policy. |

The combined targeted stress ran the four files simultaneously for three sequential rounds: **276/276 assertions passed**. Slowest round wall was **34.70s**, versus loaded file times of 190.86s, 177.92s, and 72.31s in the last valid full run. This is targeted evidence only, not acceptance timing.

Post-stress state:

- matching Vitest/unit-orchestrator processes: **0**;
- worker ledger: **0/24**, no active reservations;
- inventory at that measurement: **868/868** then-unit files retained; the later coverage correction restores the twelve formerly E2E-excluded integration files, making all **880 merge-base core/DOM/integration files unit-owned**;
- `npm run check`: **passed**;
- retries/timeouts/scheduling/E2E eligibility changes: **none**.

Evidence: `.profiles/hotspots/concurrent-summary.json` and `.profiles/hotspots/concurrent/r{1,2,3}-*.log`.

## First post-wave complete run

The frozen-schedule natural run completed in **681.2s**, a **128.6s (15.9%)** improvement over 809.8s. The four targeted former failures all passed with their real boundaries intact:

- `team-manager`: 52/52, 9.973s loaded;
- `maintenance-api`: 24/24, 46.328s loaded;
- `rpc-bridge-lifecycle`: 1/1, 0.849s loaded;
- `mcp-meta-call`: 15/15, 13.175s loaded.

The run remained non-accepting with two new load failures:

1. `git-status-native.test.ts` — its real-Git template `beforeAll` exceeded the unchanged 60s hook deadline; clean file time was 10.44s.
2. `stories-sessions-api.test.ts` — the production worktree became ready, but its in-process agent had stopped before metadata persistence and the session did not become idle within the unchanged 15s deadline.

Lane walls were `core-fidelity` 681.1s, `integration-1` 656.5s, `integration-3` 633.8s, `core` 612.3s, `integration-2` 593.8s, and DOM 156.2s. The critical lane therefore moved to core-fidelity; acceptance remains **381.2s** away.

## Second retained-boundary fixture wave

| File | Exact change | Boundary retained |
|---|---|---|
| `git-status-native.test.ts` | Reduced template construction from 43 to 7 Git processes by deriving immutable loose-ref layouts from one committed real repository and using a real local bare/upstream clone for the ahead graph. Read-only tests reuse the immutable real graphs; dirty status gets a private copy. | All eight calls still execute production `runBatchGitStatusNative` against real repositories, including dirty/untracked, detached HEAD, branch fallback, real upstream/ahead counts, and non-repo detection. |
| `stories-sessions-api.test.ts` | Reused one isolated real repository, registered project, fully idle session, and production-created worktree across the two ordered story assertions; exact purge/project/repo/worktree cleanup runs after the file. | Real gateway HTTP and WebSocket, production session setup, real Git registration/branch/path, idle transition, title/color/model/context persistence, and termination cleanup. |

The six retained-boundary hotspot files then ran simultaneously for three sequential rounds: **306/306 assertions passed**. Round walls were **36.26s**, **37.54s**, and **36.58s**. Worst per-file process walls were 7.76s team-manager, 37.53s maintenance, 2.48s RPC lifecycle, 18.82s MCP, 5.38s native Git status, and 21.53s session stories. No timeout, retry, `ECONNRESET`, assertion reduction, scheduling change, or E2E addition was used.

Post-stress: zero matching Vitest/orchestrator processes, ledger **0/24**, and `npm run check` passed. Evidence: `.profiles/hotspots/concurrent-six-summary.json` and `.profiles/hotspots/concurrent-six/r{1,2,3}-*.log`.

## Execution guardrails

1. Make no scheduling, worker-count, lane-allocation, or file-placement changes.
2. Add no E2E tests and do not relocate coverage to unlock mocking. The four coverage-first paths remain stopped.
3. Preserve every retained boundary canary; optimize only fixture construction/reuse or the explicitly authorized decision seam.
4. Require the targeted concurrent proof above before spending a full-suite run.
5. Treat loaded timings as amplification/hotspot evidence only, not acceptance or before/after evidence. Final acceptance still requires a clean full run under the frozen schedule.
