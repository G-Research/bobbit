# Safe-gains E2E close-out

This report closes the speed-up investigation at the safe boundary selected on 2026-09-03. It records what was measured, what remains unqualified, and why the retained changes do not reduce integration coverage.

The fixed design baseline is `3a90cf55ab5226249529b00ecb874be4a79d5e54`. The close-out candidate is `6fff16e240010936096556f38fba11089554264c`. The last two candidate commits repair and verify a cache-publication unit-test ordering issue; they do not change E2E scheduling or product behavior.

## Outcome

The user selected **Stop with safe gains only**. The repository keeps the validated harness, lifecycle, dependency, and coverage-preserving reductions described below. It does **not** implement or remotely prototype the proposed release-runtime bundle, module hook, path transform, or provenance subsystem.

The original performance acceptance target is not met:

- No hosted GitHub E2E step completed in less than 300 seconds, and the exact retry-free acceptance environment was not captured across all three platforms.
- The required three alternating baseline/candidate pairs for both cold and warm state on Linux, Windows, and macOS were not collected.
- There is therefore no cross-platform median proof that candidate subtree CPU-minutes are no higher than baseline.
- No `qualification.json` or complete committed `samples/` and `profiles/` tree exists.

These are explicit unmet findings under the amended close-out scope, not evidence that the original target passed.

## Measurement boundary

The exact command is:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:e2e
```

`ensure-dist` remains inside that command. Local cold/warm diagnostics also measured the unchanged packed-consumer prewarm separately with the outer PID-and-creation subtree meter. The [profiling procedure](profiling.md) defines the authoritative boundary, cold/warm preparation, environment fingerprint, and qualification rules.

Focused measurements in the coverage tables are empirical evidence for an individual change only. They are not projections to the full suite and do not substitute for the missing cross-platform qualification matrix.

## Final measurements

### Hosted GitHub runners

The newest hosted run is [GitHub Actions run 33794772440](https://github.com/G-Research/bobbit/actions/runs/33794772440) at the exact close-out SHA `6fff16e240010936096556f38fba11089554264c`. Its workflow invoked `npm run test:e2e` with the committed CI retry policy; it did not set `BOBBIT_V2_RETRY_FREE=1`, so these are current E2E-step timings, not acceptance-command qualification samples. Matching raw profile/sample manifests were not committed to this directory.

| Runner | Exact wall / subtree CPU / peak | A / B / C / D wall | Result and retry evidence | Docker |
|---|---|---|---|---|
| Linux | 421.7s / 16.22 CPU-min / 29 | 9.4 / 154.4 / 224.2 / 32.1s | Passed; no retry entry observed in the job log | Available; Docker-backed coverage ran |
| macOS | 451.0s / 12.47 CPU-min / 28 | 10.5 / 170.4 / 227.8 / 40.5s | Passed; no retry entry observed in the job log | Daemon unavailable; guarded Docker path self-skipped |
| Windows | 1282.7s / 33.76 CPU-min / 153 | 38.7 / 338.3 / 808.8 / 91.2s | Passed after five browser retry entries | Daemon unavailable; guarded Docker path self-skipped |

All three exceed 300 seconds. The final Windows hosted run does not meet the zero-observed-retry requirement even though its job passed. An immediately preceding run at `4afa8d3ef` produced the implementation-gate snapshot of Linux 374.2s/13.90 CPU-min/peak 30, macOS 469.6s/12.76/25, and Windows 1325.9s/25.48/53; that macOS job also recorded one flaky retry. The differences between adjacent runs reinforce why isolated hosted samples are not paired qualification evidence.

The Windows wall time was dominated by Group C and the packaged-consumer path; it is not evidence of a hang or permission to skip that path.

### Local Windows cold and warm diagnostics

These samples were collected at `4afa8d3ef3b318d8f6c5b56a88162037850befa2`. Later close-out commits did not change scheduling, discovery, capacities, packaging, or E2E test bodies. They are complete single diagnostics, not paired qualification samples.

| State | Exact wall / CPU / peak | A / B / C / D wall | Prewarm wall / CPU | Active-meter total wall / CPU | Result |
|---|---|---|---|---|---|
| Cold preparation | 584.3s / 18.791 CPU-min / 36 | 30.8 / 228.7 / 255.0 / 56.5s | 65.4s / 1.238 CPU-min | 649.7s / 20.029 CPU-min | 507 passed, 19 capability/platform skips, 0 failures, 0 retries |
| Warm preparation | 576.5s / 18.192 CPU-min / 30 | 30.2 / 224.8 / 254.5 / 53.0s | 43.0s / 0.730 CPU-min | 619.5s / 18.922 CPU-min | 507 passed, 19 capability/platform skips, 0 failures, 0 retries |

Cold preparation removed `dist`, prior results, and the ensure-dist lock before the prewarm meter. The separately metered prewarm then performed the cold build in 21.9s, so the following exact command observed an ensure-dist cache hit. Consequently, 584.3s is the post-prewarm exact-command component of the cold-preparation sample, not a command-only cold-build measurement; 649.7s is the combined active-meter boundary that includes prewarm/build plus the exact command. The current lifecycle cannot produce a command-only cold-build sample without omitting or changing the required prewarm, so none is claimed.

The full start-to-end spans, including orchestration gaps between the two authoritative meters, were 661.0s cold and 634.4s warm. Both B and C profiles contained all required lifecycle and activity categories, complete child/hook termination records, and no retries or failures. Docker client `29.3.1` was installed but the daemon was unavailable, so the guarded Docker path self-skipped while non-Docker coverage ran.

Environment: Windows `10.0.26200` on AMD Ryzen AI 9 HX 370, 24 logical CPUs, 67.8 GB RAM, Node `v24.13.1`, npm `11.8.0`, Playwright `1.60.0`, Chromium revision `1223`.

Point-in-time discovery was A=15 files, B=47, C=58, D=9, with 13 manual files excluded and no missing discovered files. Default and qualification capacities were A=2, B=1 on Windows and 2 elsewhere, C=2, and D=1. The runner supports bounded diagnostic overrides, but the qualification validator rejects samples that do not use these settings.

### What these results establish

The two local retry-free samples establish first-attempt green behavior on their Windows environment and identify B and C as the remaining critical path. The final hosted Windows run did observe retries. Together the records do not establish:

- universal sub-300-second completion;
- a final baseline/candidate median;
- cold and warm parity on every platform; or
- a passing aggregate qualification manifest.

A single fixed-baseline Windows warm diagnostic recorded 594.692s and 18.304 CPU-min for the exact command, with A/B/C/D at 25.9/252.8/244.1/57.3s. Comparing that one sample with a later candidate sample is directional only because it is not one of the required alternating matched pairs.

## Evidence availability

- The reproducible profiler and qualification contract is committed in [profiling.md](profiling.md).
- The final hosted logs are durable in [run 33794772440](https://github.com/G-Research/bobbit/actions/runs/33794772440); the table above transcribes its per-group and total summaries.
- The local cold/warm meters, B/C manifests, raw child/hook telemetry, runner reports, and logs were retained under ignored task-local `.profiles/testing-v2/` directories during review. They are not present in a fresh checkout and are therefore diagnostic evidence, not a committed qualification archive.
- There is no aggregate qualification manifest. Readers must not infer one from this narrative report.

## Validation at close-out

- The final GitHub Build & Unit Gate and CodeQL workflows passed at `6fff16e240010936096556f38fba11089554264c`.
- `npm run check` passed for the accepted implementation changes.
- Focused runner/prebundle/routing/isolation/Docker contracts, runtime dependency boundaries, native-pack identity, and each cheaper coverage owner named below passed during their implementation tasks.
- The standard E2E matrix passed on all three hosted platforms, but it did not enforce the retry-free environment and the final Windows job used retries as reported above. Only the two local Windows cold/warm diagnostics were explicitly retry-free and zero-failure at the final E2E behavior revision.

## Retained safe changes

### Harness and lifecycle

- **Serial B→C transform-cache handoff.** The coordinator publishes completed, run-owned B cache slots and seeds isolated C process slots only after B exits. It preserves strict A→B→C→D order, unique writable process ownership, containment, non-clobbering publication, cold fail-open behavior, and cleanup. Focused and raw modes keep their original isolation.
- **Group B compiled-dist prebundle.** Eligible B workers load a run-owned, content-addressed bundle of compiled server modules. The runner builds it after A, injects it only into B, and removes the setting before C. Native packages, generated child paths, assets, `import.meta.url`, and singleton identity remain pinned. Pre-evaluation construction failure may use raw B; an evaluated bundle import failure is fatal. Real-push and all C sentinels stay raw.
- **Truthful profiling.** B/C lifecycle, gateway, browser, subprocess, filesystem, and build/cache attribution is observational. Child and hook completion joins on PID plus creation identity and fails closed on torn telemetry. Inner group CPU is diagnostic; only the outer subtree meter is authoritative.
- **Restart readiness.** Browser restart helpers wait for health and a newly authenticated socket epoch for the correct session instead of swallowing a status-only wait. Timeouts and retries were not increased.
- **Shortest valid timeout journey.** The verification-timeout E2E configures the public workflow API's production-valid one-second minimum. It still executes the real parent/child process, owned tree kill, output/liveness checks, cancellation/error mapping, and cleanup. The Playwright timeout and product default were not weakened.

### Packaging and dependency work

- **Duplicate native-pack build removed.** Group D consumes the fingerprinted same-SHA artifact produced by `ensure-dist` instead of launching a second synchronous esbuild service. The journey still checks source→compiled dist→release root→tarball→strict-offline install byte identity for every native target, read-only execution, plugin errors, containment, and cleanup. Focused runs fell from pathological 136–344s esbuild stalls to about 5.6–5.9s.
- **Published graph narrowed.** Seven browser/build-only packages moved to development dependencies without version changes. Server, document, Pi, and native runtime dependencies remain production dependencies. The strict-offline installed graph fell from 436 to 378 package entries; three focused pairs moved from a 92.1s/3.116 CPU-min median to 86.3s/2.803 CPU-min.
- **Real clean consumer retained.** The packaged journey still starts from an empty consumer, performs one lifecycle-enabled strict-offline install of the actual tarball, owns its lock and dependency graph, runs installed fd/rg, CLI, gateway, UI, browser, live theme bridge, reload, and source-request guards, then removes its processes and filesystem state.

### Coverage-preserving composition

The following mappings cover the changes after the fixed baseline. Each row names the former E2E ownership, every material integration boundary, the retained real owner, the cheaper deterministic owner where assertions moved tiers, and the empirical evidence used to accept the change.

| Change | Before and production boundaries | Retained E2E owner | Deterministic complement | Focused evidence |
|---|---|---|---|---|
| PR walkthrough panel parity `bb486e47c` | A 26-case Group C file used real Chromium and the exact shipped panel for shell geometry; pending/draft/error/recover; navigation/reviewer state; comments, decisions, audit/export, narrative/hunk/diff rendering; responsive CSS. It did not start a gateway or cross session, Git, or persistence boundaries. | The three `pr-walkthrough-pack` journeys retain real gateway/session/Git/tool/publish/recover behavior; `pr-walkthrough-host-agents` retains real host-agent/API lifecycle. | The unchanged 26 cases moved byte-for-byte to the canonical `pr-walkthrough-panel-parity` browser fixture, which still imports the production panel. Discovery pins one owner and excludes the old Group C path. | Old E2E: 59.4s/1.137 CPU-min. Fixture: 17.4s/0.402 CPU-min. Both passed 26/26. |
| Launcher feedback `58adc7549` | One synthetic case directly dispatched the production launcher event and waited through unrelated 2.5s timers; the same file's real session/preview/layout journey was separate. | `extension-panel-ux` retains real session, preview mount, split/fullscreen/collapsed layout. PR walkthrough launcher and trust-prompt journeys retain real launcher routing and feedback. | `header-launcher-feedback.dom.test.ts` imports the production toast path and covers pending/resolved/error/dismiss, exact timer independence, accessibility, and cleanup with fake timers. | Focused wall 35.649→26.069s; subtree CPU 40.750→30.016s; retry-free. |
| Pre-compaction history `93c86f4ef` | A manually seeded browser journey duplicated filesystem sidecar, server count/verbose route, browser expansion/order/opacity/non-streaming/orphan/reload boundaries. A synthetic transient-404 browser case tested retry timing. | The live `AUTO_COMPACT:3` journey crosses the same filesystem/server/browser/reload boundaries plus the real mock-agent WebSocket compaction path. The manual `/compact` journey remains. | `pre-compaction-history-retry.dom.test.ts` covers two 404s then 200, non-cached empty state, ordered expansion, listener and timer cleanup. Gateway integration pins the count envelope. | Four→two E2E cases; wall 42.747→34.536s; CPU 52.203→38.578s; retry-free. |
| AIGW startup policy `78da836dd` | Four boots covered startup wiring plus unreachable preservation, unmarked-user refusal, and skip-discovery policy branches. | The retained real `createGateway().start()` E2E crosses startup invocation, loopback model discovery, managed file and marker publication, request headers, routed models, filesystem, and shutdown. | AIGW startup/well-known/legacy-adoption unit suites pin unreachable byte preservation, refusal after discovery, skip-discovery zero requests, JSONC identity, warnings, and Bedrock flags. | Four→one E2E case; median wall 45.7→23.8s; CPU 0.8725→0.451 CPU-min. |
| Base-ref API matrix `362466166`, repaired by `339172c2d` | The matrix covered add-time default/non-default/no-remote/non-git/multi-repo/mismatch cases and GET detect response/error branches through real API and Git setup. | One stronger real-Git E2E uses two independent component repositories and bare remotes whose `origin/HEAD` is non-default, then proves POST detection, all-component validation, persistence, unregister, and cleanup. `base-ref-detect` retains real GET detect/save/reload in Chromium. | Gateway integration pins exact known-remote, mismatch-null, non-git, unknown-project 404, no-remote POST, add-time success/refusal responses; parser/validation units retain symref permutations. | Matrix→one real-Git E2E; three-pair median wall 23.6→19.4s and CPU 0.402→0.365 CPU-min. The restored integration suite passed 6/6 and the retained E2E 1/1. |
| Stale-base Continue `05b22c40f`, repaired by `bcfc2e43b` | A separate journey crossed archive/Continue HTTP and auth, transcript adoption, real Git stale configured ref, synchronous worktree failure, error provenance, rollback, and cleanup. | The multi-repo journey retains successful adoption across a non-Git container and two Git components. The failure phase now lives in the retained single-repo stale-source journey with pooling disabled, preserving the distinct production `createWorktree` branch, stale ref/path/branch checks, actionable error, no live destination or worktree leak, rollback, and cleanup. | Gateway integration pins exact 500 mapping and pre-persist failure cleanup; routing discovery pins the deleted file's replacement owner. | Initial two-file median wall 59.861→32.285s and CPU 0.999→0.491 CPU-min. The single-repo repair was neutral/slightly lower at 43.048→43.011s wall and 47.047→46.516 CPU-s. |
| MCP integration `f3a50e4ef` | Three cases each paid setup around mock stdio server restart, config/tool discovery, Headquarters session, calls, errors, and tool metadata. | One serial E2E still starts the real stdio child, restarts/discovers it, creates a scoped real session, executes echo/add/unknown operation/unknown server, reads `/api/tools`, purges, and verifies gateway-owned child shutdown. `mcp-tool-permission` remains separate. | Gateway integration pins deterministic unknown-operation MCP `isError` and unknown-server structured response contracts. | Three→one E2E journey; median wall 45.45→29.05s; CPU 0.9805→0.5375 CPU-min; zero retries. |

No production behavior was reclassified as unit-only in these changes. The cheaper tests own deterministic policy, rendering, timing, and response matrices; the listed E2E journeys continue to cross the real integration boundaries.

## Earlier coverage changes retained in the fixed baseline

The fixed baseline already contained the following measured compositions and relocations. They remain part of the close-out coverage map rather than being mistaken for new baseline-to-candidate savings.

| Commit and change | Before | Retained real integration owner and boundaries | Cheaper or folded owner | Evidence |
|---|---|---|---|---|
| `0283bb439` clean consumer | Separate API and browser journeys each packed and installed Bobbit. | `packaged-inline-html-theme` performs the real pack, empty strict-offline install, consumer lock/graph and Pi security checks, native fd/rg execution, installed CLI/gateway/UI/browser/theme/reload/no-source requests, and cleanup. | Deterministic Pi packed-consumer argv, build-key, shrinkwrap-security, and installed-contract suites. | Old serial total 174.9s/5.57 CPU-min; combined diagnostic 90.0s/2.98 CPU-min, retry-free. |
| `d9038972b` crash/restart | Nine cases performed eight generic restart cycles. | Two serial journeys retain strict crash/down/restart/health, session and preview identity/hash, blocked and operator-paused goal state, sidebar state, reload, connection status, and cleanup. Specialized live reconnect stays in `stories-resilience` and background-process persistence. | Existing state/reducer coverage complements but does not replace the two real restart journeys. | 34.3→24.2s wall; 0.59→0.48 CPU-min; same peak; retry-free. |
| `9006ab457` PR host agents | Seventeen cases repeated owner/reviewer/Git fixtures. | Four serial journeys retain confined host routes, real child spawn/worktree, secrets/job authorization, submit/status/recover, freshness/concurrency/scope, restart role/tool recovery, child reaping, trust rejection, termination, and child-before-owner cleanup. | Durable route, lifecycle, role/tool, trust, scope, and orchestration matrices remained green. | 61.8→43.5s wall; 1.47→0.91 CPU-min; unchanged peak. |
| `ef888df2d` marketplace | Fifteen serial browser cases repeated project/source/page setup. | Four journeys retain shell/forms/accessibility, real source registration and filters, install/update/uninstall/provenance/runtime tool APIs, reload, project isolation, conflicts/order/orphan handling, and cleanup. | No assertion moved tiers; compatible steps share their existing dedicated project lifecycle. | Test-body wall 27.1→21.331s; two full focused candidate runs passed retry-free. |
| `8ed2ba078` spawn-child route | Twenty-two API cases repeated parent/repository/harness setup. | Three journeys retain raw HTTP authorization, persisted metadata/workflow/roles, idempotency, validation failures, dependency scheduling, real Git/worktree topology, cascade archive, and cleanup. | Spawned-by, spec-validation, nested-route, dependency-blocking, and concurrency unit matrices own exhaustive permutations. | Focused median 33.65→28.8s; outer median 37→32s; retry-free. |
| `3d052728a` source-runtime relocation | Nine no-page real-process cases paid Group C browser fixtures. | The same nine cases run in Group A's real-process source-runtime file, preserving child spawn, Windows Job ownership, stop coalescing, failure aggregation, signals/escalation, stdio, descendant reaping, and cleanup. Group C retains the real source gateway/Vite/Chromium/theme journey. | E2E-to-E2E move; no case moved to unit-only coverage. | Median 5.9→2.8s wall and 0.07→0.03 CPU-min. |
| `27980d580` staff cwd | Eleven declarations repeatedly created projects, staff, and repositories. | Four real API journeys retain POST/PUT missing/blank/inside/outside cwd, registered/orphan behavior, canonicalization, automatic worktree/root runtime, cross-project rejection, poly-repo parity, persistence, non-mutation, and cleanup. | No input permutation moved out of E2E; compatible route calls share isolated fixtures. | Changed-matrix median 32.2→27.5s and 0.58→0.54 CPU-min. |
| `0253c8ded` proposal comments | Eight browser cases repeated proposal/page setup. | Two journeys retain real selection/highlight/popover, create/edit/delete, overlap, badge/action, keyboard/accessibility, prompt submission, proposal update, reload ephemerality, and cleanup. | Proposal-annotation units retain deterministic keying, removal, clear, composition, and ordering. | Median 48.5→44.1s and 1.13→0.81 CPU-min. |
| `6d2c976e1` PR walkthrough pack | Seven cases repeated session/Git/page setup. | Three journeys retain built-in resolution, authorization and traversal rejection, activation, NO_PR launcher behavior, active/inactive session binding, child pending/recover/publish cards, persisted reload, compact rail, and cleanup. | Pack-entrypoint browser fixture owns deterministic launcher registration, forwarding, errors, conflicts, and re-entry. Panel rendering now has the fixture owner described above. | Outer median 63.0→53.5s; two candidate runs passed retry-free. |
| `8c02633c8` Headquarters | Ten browser cases repeated Headquarters/session setup. | Two journeys retain same-root registry separation; sidebar/picker identity; Quick Session scope/cwd; visibility across reload and gateway restart; preflight; staff proposal; settings/roles scope; no-worktree dashboard; hidden-route/API work; normal-project registration; and cleanup. | No assertion moved tiers; compatible state shares a page lifecycle. | Median 37.6→33.7s and 0.81→0.74 CPU-min. |

The terminal journey was also composed from five to three cases without moving assertions to a cheaper tier. Its retained real PTY journey still covers open/input/output, all 90 unique burst lines, resize, hide/attach, reload/replay, exit, restart, kill, gateway restart, channel identity, layout, and cleanup; Chromium touch and ConPTY regressions remain separate. Focused medians were 57.4→56.9s wall and 1.19→1.13 CPU-min.

### Other bounded reductions

These changes did not remove or re-tier a journey, but they are retained safe gains and therefore remain part of the audit record.

| Change | Preserved boundary | Deterministic complement | Focused evidence |
|---|---|---|---|
| Background stream repetition `ed786335b` | Reduced a synthetic stream from 50 to 24 timed chunks. The retained browser E2E still crosses REST creation, real OS process/stdout spool, PollTailer, durable API log and WebSocket broadcast before and after two gateway restarts, authenticated reattach, ordered final chunk, real exit code, hydration, dismiss/purge, kill, and cleanup. The removed chunks repeated the same path and crossed no new branch. | Background-process persistence units pin multi-chunk interleaving, repeated content, restore/reattach, live reads, exit broadcast, and purge. | Three-sample medians 48.8→37.6s and 0.82→0.67 CPU-min; zero retries. |
| Terminal output batching `42f57fcf9` | Changed nine acknowledged 10-line writes to three acknowledged 30-line writes while retaining the readiness probe, cmd/POSIX forms, all 90 unique lines, each completion marker, PTY/channel/browser path, final marker, resize, reload/reattach, prompt/cursor/layout, and cleanup. | No assertion moved tiers. | 98.9→95.9s and 2.02→1.95 CPU-min; same peak; retry-free. |
| Resilience fixture isolation `3de3ce7f5` | Gives `stories-resilience` a worker-pool state discriminator so RE-01 through RE-08 start from scenario-owned gateway state instead of restoring unrelated prior-file sessions. Coordinator root, ports, restart paths, cleanup, Docker RE-05 guard, retries, and timeouts are unchanged. | Harness startup units pin fixture grouping; no scenario moved tiers. | Positive restore summaries contained at most five owned sessions instead of 15–20 inherited sessions; median restore-phase time 14.424→2.341s. Whole-file focused timing was explicitly non-representative and is not claimed as a suite saving. |
| Benchmark search startup idle `38e8627b1` | Sets the synthetic search startup delay to zero only for the spawned benchmark child. The real worker/rebuild, authenticated search, production API, archived relationships, WebSocket snapshot, authorization rejection, and graceful shutdown still run. Product delay policy is unchanged. | Existing search tests retain startup-delay and persistence behavior. | Three-run median 17.4→13.4s and 0.25→0.23 CPU-min. |
| File-explorer snapshot reuse | Reuses only a bounded server-generated root-list Git snapshot keyed by session, canonical root, refresh generation, TTL, count, and bytes. Root/path claims and the final path-specific diff or untracked read remain live; failures and client-provided snapshots are not cached. | Route units cover reuse, expiry, bounds, failure, and cross-session/root isolation; the real file-explorer browser journey remains. | Route units passed 42 with one platform skip; two retry-free browser runs passed. No unsupported full-suite saving is claimed. |
| Immutable Git fixture templates | Base-ref fixtures copy an immutable template with `--no-hardlinks` into independent mutable roots and explicitly select template branches. Real remotes, refs, worktrees, Git mutation, and cleanup remain per test. | Git-template copy units pin independent objects, branch selection, containment, and cleanup. | Focused coverage passed; noisy whole-file timing was not used as a claimed reduction. |

## Protected real integration anchors

Future speed work must preserve at least one real E2E owner for each boundary below. Deterministic suites may expand the assertion matrix but cannot replace these anchors.

| Boundary | Current real owner |
|---|---|
| Installed release tarball, ordinary strict-offline consumer, native binaries, installed CLI/gateway/UI/theme/reload | `packaged-inline-html-theme` Group C journey |
| Source gateway and Vite runtime, Chromium page, inline HTML parse-time/live theme bridge, materialized assets | `source-vite-inline-html-theme` Group C journey |
| Group B raw real-push behavior | `in-process-harness-realpush` and goal archive/branch cleanup raw sentinels |
| Group B bundled server parity across boot, assets/defaults, native SQLite, modules, search, background process, tools, credentials and Git identity | Retained eligible API journeys plus the raw-vs-bundle routing/parity tests |
| PR walkthrough Git/tool/launcher/publish/recover and host-agent lifecycle | `pr-walkthrough-pack`, trust-prompt, and `pr-walkthrough-host-agents` |
| Marketplace source/install/update/conflict/project isolation | `marketplace` browser journeys and marketplace API journeys |
| Real PTY/channel/browser/restart behavior | `terminal-pack` |
| Real background process/spool/API/WebSocket/restart/reattach/exit/dismiss/purge behavior | `bg-process-persistence` |
| Real generic gateway crash durability | `crash-restart`; live reconnect remains in `stories-resilience` |
| Real compaction sidecar/server/WebSocket/browser/reload behavior | `pre-compaction-history` live auto-compaction and manual `/compact` journeys |
| Real Git base-ref detection, validation, persistence and Continue rollback | `base-ref-pin`, `base-ref-detect`, and single-repo/multi-repo Continue journeys |
| Real stdio MCP child discovery/call/error/cleanup | `mcp-integration`; permission policy remains separate |
| Headquarters project/session/staff routing and restart visibility | `headquarters` |
| Real proposal annotation interaction and prompt submission | `proposal-inline-comments` |
| Real file-explorer Git snapshot/path/diff and packaged panel behavior | `file-explorer-pack` |

The older “retained browser smokes” list in the speed-buffer history used paths from a previous test layout. It is historical evidence, not the current discovery invariant. This table is the current protected integration inventory.

## Invariants that did not change

- Group order remains A→B→C→D; groups do not overlap.
- Default and qualification capacities remain A=2, B=1 on Windows and 2 elsewhere, C=2, D=1; diagnostic overrides do not qualify.
- `NODE_DISABLE_COMPILE_CACHE=1` remains set for the E2E runner.
- Retry-free qualification still requires zero observed retries and zero first-attempt failures.
- Playwright timeouts, suite retry policy, process ownership, run-root isolation, and failure cleanup were not weakened.
- Discovery still includes every canonical non-manual group; manual tests remain excluded by classification rather than ad hoc skips.
- Docker-backed tests still run when the daemon/image is available and self-skip only through the existing capability guard when unavailable.
- External-service and remote-push guards remain in force.
- Group C, focused E2E runs, and real-push sentinels remain raw; no worker may mix raw and bundled server identity.
- The packaged consumer still boots the exact filesystem tree produced by its real npm install.

## Rejected or reverted work

| Experiment | Decision and evidence |
|---|---|
| Default-project fixture snapshot cache | Reverted. Review found mutable baseline poisoning and lifecycle identity risk. The gateway harness again performs the known-safe unconditional post-test reset; no production restore API or shared snapshot remains. |
| Dist import-cache snapshots | Reverted as ineffective. They did not provide a reliable benefit and introduced cache identity/ordering risk. |
| Offline lock-only then `npm ci` | Rejected. On pinned Windows, baseline passed at 88.4s/3.074 CPU-min; the candidate failed after 104.6s when npm synthesized a `node-gyp rebuild`, attempted network header retrieval, and never reached installed-runtime assertions. |
| Copied-lock/locked install handoff | Rejected for the same lifecycle/native failure and because it would not preserve the ordinary consumer install boundary. |
| Relocating packaged process-lifecycle cases from C to A | Rejected and reverted. Serial A+C medians regressed from 89.05s/2.989 CPU-min to 94.2s/3.125 CPU-min. |
| Fixed Group C lanes and broader fixture flattening | Rejected. They either shifted contention, increased lifecycle complexity, or risked shared mutable identity without enough measured benefit. |
| Goal-metadata hierarchy composition | Rejected and reverted. Five retry-free baseline and candidate runs preserved coverage, but the first median comparison regressed from 28.6s/0.50 CPU-min to 33.8s/0.61, and paired wall remained worse. |
| One-entry Group B prebundle | Rejected and reverted after three alternating full-B pairs. Median wall changed only 234.8→233.4s and CPU 4.939→4.892 CPU-min; the approximately 1.4s benefit did not justify schema/manifest complexity. |
| Release-runtime bundle/module hook/path/provenance system | Prohibited by the close-out amendment. A local feasibility study projected a much smaller installed graph, but complete export, identity, native/data asset, license/provenance, and cross-platform behavior were not qualified. Projections are not recorded as achieved speed. |

## Remaining bottlenecks

- **Group B worker startup and repeated integration setup.** Final local B remained about 225–229s. Runtime-load telemetry showed repeated worker evaluation, but flattening one prebundle entry saved only about 1.4s median. Git, gateway/session setup, and subprocess lifecycles remain material and cannot be bypassed without a new coverage and identity design.
- **Group C packaged consumer and browser processes.** Final local C remained about 255s. On hosted Windows, ordinary strict-offline extraction and installed runtime dominated. The real install→same-tree runtime boundary is intentionally retained.
- **Platform filesystem variance.** Windows native/package extraction exhibited much higher variance than focused Linux-like costs. The duplicate native build was removed, but the full installed dependency graph still has many files.
- **Qualification debt.** A future attempt must start with fresh same-runner baseline/candidate pairs using the committed procedure. Historical diagnostics must not be promoted to qualification evidence.

Further work should reduce actual shipped dependencies or repeated owned setup while preserving the anchors above. It must not add workers, overlap groups, move provisioning outside the measured boundary, share mutable installed trees, or replace real integration paths with unit-only tests.
