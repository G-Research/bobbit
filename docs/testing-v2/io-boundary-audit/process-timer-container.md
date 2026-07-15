# Process, timer, and container I/O boundary audit

Date: 2026-07-15
Merge-base authority: `4df9a35e2bd1ac5b662382189e12973fc4e1c4c2`

## Audit rule

This is a merge-base audit, not a description of the current tree. Every owner, test title, and assertion below was read with `git show 4df9a35e2bd1ac5b662382189e12973fc4e1c4c2:<path>`.

Eligible E2E evidence is limited to full-gateway/browser interaction coverage already present at that commit and the `e2e:v2` sources selected there by `scripts/testing-v2/run-e2e-v2.mjs`: tests-map daily Groups A/B/C and the 12 files in `scripts/testing-v2/integration-e2e-files.mjs`. A browser fixture that injects state, an in-process fake bridge, or a synthetic event is not evidence of an OS boundary. `tests/manual-integration/**` is not E2E evidence for this audit. Tests added after the merge base cannot qualify.

Labels:

- **MB-COVERED** — merge-base E2E executes the same real boundary and asserts its effect.
- **MB-PARTIAL** — merge-base E2E executes only part of the boundary lifecycle or asserts only an adjacent effect.
- **MB-GAP** — no merge-base E2E asserts the real boundary.
- **Boundary-independent: Yes** — the unit assertion is about policy, projection, ordering, or state and remains valid with an in-memory/manual seam.
- **Boundary-independent: No** — the assertion itself requires real spawn, output, exit, signal, elapsed time, watcher, PTY, executable, or container behavior. Adjacent E2E does not make it boundary-independent.

## Executive result

| Seam | Merge-base E2E result | Merge-base evidence |
|---|---|---|
| Local Git CLI/worktree and local bare-remote mutation | **MB-COVERED** | Daily worktree/pool/sweeper specs plus `multi-repo-flow-api`, `commit-file-diffs-api`, and local-bare-remote branch cleanup |
| Network remote Git / real `gh` | **MB-GAP** | E2E is deliberately external-free; fake/local `gh` parsing is not network transport |
| Agent `RpcBridge` child process | **MB-GAP** | Browser and integration harnesses install `InProcessMockBridge`; `sandbox-recovery` injects `process_exit` listeners synthetically |
| Verification command process | **MB-PARTIAL** | Real command spawn/running and happy output exist; timeout, tree-kill, cancellation result, and restart adoption do not |
| Background process manager | **MB-PARTIAL** | `tail-chat-real-stream` reaches real `bash_bg` create/wait/normal completion, but not direct logs, exit code, kill, or restart recovery assertions |
| Spawn-tree signal/survival | **MB-COVERED** | Daily `spawn-tree-shutdown-survival.test.ts` asserts real PID survival and death |
| MCP subprocess | **MB-COVERED** | Daily MCP specs spawn `process.execPath`, restart/discover servers, and execute tools |
| Extension worker isolation | **MB-PARTIAL** | Terminal E2E traverses the worker-backed channel, but not generic worker timeout/heap-crash isolation |
| Terminal PTY child | **MB-COVERED** | `terminal-pack.spec.ts` asserts output, reattach, exit, kill, restart, and gateway-restart disconnection |
| Gateway OS process death/signals | **MB-GAP** | Browser `gateway.crash()` calls in-process `gw.shutdown()`; no gateway PID is killed |
| Port-binding child process | **MB-COVERED** | Daily `port-auto-increment.spec.ts` asserts bind conflict, increment, files, output, and child result |
| Standalone AIGW/QA/npm/binary probes | **MB-GAP** | No matching merge-base E2E owner |
| Test-runner hung-child timeout | **MB-COVERED** | Daily `run-unit-hung-test-integration.test.ts` asserts non-zero exit, timeout text, filename, and heartbeat |
| Filesystem watcher | **MB-GAP** | Preview browser coverage refreshes/injects events; it does not mutate a watched file and observe real delivery |
| Team-wait timer semantics | **MB-COVERED** | Fixed Group-I `team-wait-semantics.test.ts` asserts first-idle, immediate, queued, and timeout results |
| Scheduler backoff/debounce/reminders/review/subgoal timers | **MB-GAP** | No exact merge-base E2E owner |
| Docker/container lifecycle | **MB-GAP** | The daily `sandbox-recovery.spec.ts` explicitly says “no Docker needed”; Docker recovery lives in manual integration |
| Verification/background Docker exec and kill | **MB-GAP** | No merge-base E2E asserts those container effects |

## 1. Process seams

### 1.1 Local Git, local remotes, and external GitHub

| Baseline unit owner and exact assertion | Boundary-independent? | Merge-base E2E ownership |
|---|---:|---|
| Real-temp-repo owners including `tests2/core/git-status-native.test.ts`, `goal-push-safety-regression.test.ts`, `verification-goal-sync-nondestructive.test.ts`, `tests2/integration/base-ref-api.test.ts`, `multi-repo-goal.test.ts`, and `task-git-fields.test.ts` assert actual refs, status/diffs, commits, worktrees, merges, fetches, or pushes on disk. | **No** — these assertions consume real Git process/filesystem effects. | **MB-COVERED** for local Git. Daily `tests/worktree-pool.test.ts > happy path: claim renames branch and moves directory to session/<id8>` asserts the branch rename and worktree directory; `tests/worktree-sweeper.test.ts > removes archived-owned orphan worktrees without deleting durable archived branches` asserts directory removal and retained ref; `tests/e2e/continue-archived-worktree.spec.ts > cloned .jsonl is placed under the worktree slug...` asserts real worktree/cwd paths and cloned file placement. |
| Recorded-runner assertions in `goal-push-safety-regression`, `local-sub-agent-push-policy`, and PR-walkthrough resolver tests assert command ordering, refusal policy, parsed stdout, and fallback decisions. | **Yes**. | Local-process coverage does not change this classification. |
| `tests2/core/command-runner-fence.test.ts > allows local git and local bare remotes` asserts a real 40-hex rev and successful file-remote push; `applies remote fencing to sync and spawn paths` also waits for an allowed spawned Git child to exit `0`. | **No** for the allowed real Git assertions; the blocked-command `toThrow` assertions are **Yes**. | **MB-COVERED** for local bare-remotes: `tests/e2e/goal-archive-branch-cleanup.spec.ts > archiving a goal whose remote branch is already absent...` asserts the branch exists after push, is absent after pre-delete, and archive succeeds; `> archiving a team goal deletes all per-role remote branches` asserts every remote branch disappears. |
| Any unit assertion intended to prove a real network `git push/fetch/clone/ls-remote` or production `gh` process. | **No**. | **MB-GAP**. The merge-base E2E runner sets `BOBBIT_TEST_NO_EXTERNAL=1` and `BOBBIT_TEST_NO_REMOTE=1`; local fake-`gh` parsing is not remote ownership. |

### 1.2 Agent child and `RpcBridge`

| Baseline unit owner and exact assertion | Boundary-independent? | Merge-base E2E ownership |
|---|---:|---|
| `tests2/core/rpc-bridge-lifecycle.test.ts > rejects a pending prompt exactly once when the Pi child exits unexpectedly` starts a real synthetic Pi child and asserts exit code `17`, stderr `synthetic pi child crash`, one rejection, one `process_exit`, and `running === false`. | **No** — real child spawn/output/exit are the assertion. | **MB-GAP**. At merge base `tests/e2e/gateway-harness.ts` and `tests/e2e/in-process-harness.ts` register `InProcessMockBridge`. `tests/e2e/sandbox-recovery.spec.ts` directly iterates `rpcClient.eventListeners` and injects `{type:"process_exit"}`; its header says no Docker and its event is synthetic. |
| `rpc-bridge-spawn-args.test.ts` assertions for `--no-approve`, `--no-context-files`, model/thinking order; `rpc-bridge-gateway-env.test.ts` token/URL env assertions; `rpc-bridge-redact-args.test.ts` secret redaction. | **Yes** — argument/environment construction and redaction do not require a child. | **MB-GAP** for actual child receipt; these remain valid unit contracts. |
| `tests2/core/session-manager-force-abort-grace.test.ts > force-kills within the grace period when abort() hangs...` asserts `abort()` once, `stop()` once, elapsed at least the grace and under 5s. | **No** for elapsed grace/kill timing, even though the bridge is fake; **Yes** only for the call-count/state policy. | **MB-GAP**. No merge-base E2E kills an agent PID or asserts the grace interval. |

### 1.3 Verification shell commands

| Baseline unit owner and exact assertion | Boundary-independent? | Merge-base E2E ownership |
|---|---:|---|
| `tests2/core/verification-command-runner-contract.test.ts > matches for...`, `> matches on TIMEOUT`, and `> matches on CANCELLATION` run the real runner and assert real exit code/stdout/stderr/timedOut and that `killTree` closes the child. | **No** for the real side of every parity assertion. Fake-interpreter fail-closed and dependency-identity assertions are **Yes**. | **MB-PARTIAL**. `tests2/browser/e2e/gate-status-cross-surface.spec.ts > active verification state is shared...` runs `node -e "setTimeout(()=>process.exit(0),30000)"`, asserts `/verifications/active` has `overallStatus === "running"`, and asserts running UI state after reload. |
| `tests2/core/verification-harness-timeout.test.ts > times out...and reaps the child`, `> killTree reaps the entire subprocess tree`, `> killAllTracked reaps every tracked child`, and timeout/cancellation command cases assert live parent/grandchild PIDs, streamed PID output, death, markers, and registry removal. | **No**. | **MB-PARTIAL** — no merge-base E2E asserts timeout, parent/grandchild death, escalation, cancellation marker, or registry cleanup. |
| `tests2/core/verification-command-restart-lifecycle.test.ts` real cases assert process-exit settlement despite delayed stdio close, identity-safe kill/refusal, surviving-command exit-file recovery, pre/post-restart output, real exit `7`, bounded stdout/stderr tails, and actual downstream command file creation. | **No** for process identity/liveness, signal, exit/output, and file-effect assertions. Pure persisted-state classification rows are **Yes** only where they use authored state and no child. | **MB-PARTIAL** — browser restart is in-process and does not assert durable command adoption. |
| `tests2/core/verification-sandbox-exec.test.ts > runs on host shell...`, `> spawns docker exec...`, and `> streams output...` assert a real host marker, a real failing `docker exec` against a nonexistent container, and streamed stdout. | **No**. Routing-only rows (`passes containerId...`, `/workspace` fallback, non-sandboxed host selection) are **Yes**. | Host happy output is covered by the baseline full-gateway `tests2/browser/journeys/goal-team-gates.journey.spec.ts > gate-list endpoint strips inline step output; full output remains available lazily`, which runs a real `node -e` marker and asserts it in inspect output. Docker exec remains **MB-GAP**. |

Overall verification classification: **MB-PARTIAL**. Real spawn/running/happy output is owned; adverse and restart-safe process lifecycle is not.

### 1.4 Background processes

| Baseline unit owner and exact assertion | Boundary-independent? | Merge-base E2E ownership |
|---|---:|---|
| `tests2/core/bg-process-manager.test.ts` fake-child cases assert abort leaves running, synthetic exit gives code `0`/reason `normal`, fake-timer timeout, listener cleanup, and cleanup delegates `killHostTree`. | **Yes** — status projection, listener ownership, and delegation survive a fake child/manual timer. | **MB-PARTIAL**. |
| `tests2/core/bg-process-persistence.test.ts` wrapper-string, synthetic spool/tailer, fake liveness, fake status-file, fake Docker CLI, and manual-clock rows assert restore classifications, retained ordering, kill intent, grace classification, caps, and correct PID target selection. | **Yes** where the assertion is wrapper/persistence/state/delegation. Assertions phrased as a real exit code remain boundary-independent only because the test authors the status file; they do **not** prove a real process produced it. | **MB-PARTIAL**; no merge-base E2E owns restart recovery or container-backed recovery. |
| `tests2/integration/bg-wait-steer-abort.test.ts > logs endpoint defaults to the last 15 lines` creates a real Node log producer and asserts the last 15 stdout/log lines; `> abortAllWaits...` creates a real long process and asserts `aborted:true`, `timedOut:false`, elapsed `<1500`, and still running; session termination asserts wait release `<5000`. | **No** — real spawn/output and elapsed wait-release are explicit. | **MB-PARTIAL**. Baseline `tests2/browser/e2e/tail-chat-real-stream.spec.ts > STREAM_BURST:2 stays pinned...` drives `_handleRealBgWait(1500)` twice; `STREAM_BURST_DONE:2` appears only after real `bash_bg` create/wait completes. It does not assert direct log lines, exit code/reason, abort, kill, or restart recovery. |

The baseline `tests2/browser/journeys/bg-wait-multi-repo.journey.spec.ts` explicitly says its API/UI cases do not spawn a real process; it is not boundary evidence.

### 1.5 Spawn-tree signals and survival

Daily merge-base E2E `tests/spawn-tree-shutdown-survival.test.ts` is the exact owner:

- `killAllTracked skips survival-marked children` spawns a real long-lived Node PID, marks survival, calls `killAllTracked("SIGKILL")`, polls for 2s, and asserts the PID remains alive.
- `killAllTracked still kills NON-survival children` waits for `close` and asserts the PID is dead.
- `killAllTracked with includeSurvival=true kills everything` asserts a survival-marked PID is dead.

Result: **MB-COVERED**. Any unit assertion that checks real PID survival/death or signal behavior is still **Boundary-independent: No**.

### 1.6 MCP subprocesses

Merge-base daily E2E provides exact real ownership:

- `tests/e2e/mcp-integration.spec.ts > server discovery, restart, and connected status` asserts restart `200`, `status === "connected"`, `toolCount === 2`, `config.command === process.execPath`, and discovered `echo`/`add` tools.
- `> tool execution via /api/internal/mcp-call` asserts real subprocess results `hello world`, `5`, and error handling.
- `tests/e2e/marketplace-mcp.spec.ts` asserts runtime reload connects `drop_runtime`, exposes `mcp__drop_runtime__echo`, then disconnects/removes it on update.
- `tests/e2e/mcp-tool-permission.spec.ts` restarts the real mock MCP subprocess and asserts discovery plus policy/grant behavior.

Result: **MB-COVERED** for start/RPC/restart/discovery/tool output. Unit MCP catalogue/policy assertions are **Boundary-independent: Yes**; any assertion that waits for child connection/exit/output is **No**.

### 1.7 Extension workers and terminal PTY

| Baseline unit owner and exact assertion | Boundary-independent? | Merge-base E2E ownership |
|---|---:|---|
| `tests2/core/extension-host-module-isolation.test.ts > runs a handler in a worker...`, top-level/handler infinite-loop timeout cases, heap-cap crash, and post-crash host survival execute real `worker_threads`. | **No**. Host-call marshaling, allowlists, structured errors, and cloned payload assertions are **Yes** once supplied a worker seam. | **MB-PARTIAL**. Terminal E2E traverses a worker-backed channel, but does not assert generic infinite-loop termination or heap isolation. |
| `tests2/core/extension-host-terminal.test.ts > bridges client text/resize/kill frames...` and `> opens a narrow PTY handle...` use proxy PTYs and assert frames, cwd/options, writes, resize, exit, env filtering, and fail-closed policy. | **Yes** for protocol/routing/options against the proxy. | **MB-COVERED** by `tests2/browser/e2e/terminal-pack.spec.ts > opens...runs commands...reload-reattaches, kills, restarts, exits...`: it asserts three command markers, reload reattach, normal exited state, explicit killed/idle/disconnected state, and restart. `> renders a clear disconnected state after gateway restart...` asserts live output, disconnected state, enabled restart, and new output after restart. |

### 1.8 Other process executables

| Seam and baseline unit assertion | Boundary-independent? | Merge-base E2E result |
|---|---:|---|
| `aigw-header-resolver.test.ts` executes a temporary Node CLI and asserts exact stdout for set/unset/empty `BOBBIT_SESSION_ID`. | **No**. | **MB-GAP**. |
| `binaries-resolver.test.ts` allows production `spawnSync(candidate,["--version"])` probes and asserts source/path/missing resolution. Package-name mapping is **Yes**; executable discovery is **No**. | Mixed as stated. | **MB-GAP**. |
| `support-packaging.test.ts > npm pack --dry-run --json lists docs/ and src/ entries`. | **No** for `npm pack`; static `package.json files` assertions are **Yes**. | **MB-GAP**. |
| `qa-seed.test.ts` launches the seed script, then asserts generated files and referential integrity. | **No** for successful script execution/file effects; schema checks over an existing fixture are **Yes**. | **MB-GAP**. |
| `clean-build-warnings-regression.test.ts` real Git fallback/warning cases. | **No** for real Git/output capture; static import scans are **Yes**. | Covered only by local-Git E2E generally, not the exact warning contract: **MB-GAP**. |
| Daily `tests/run-unit-hung-test-integration.test.ts > node --test-timeout fails and names a hung test file...` asserts non-zero child exit, `test timed out after 700ms`, `hangs.test.mjs`, heartbeat existence, and two completed files. | **No**. | **MB-COVERED**. |
| Daily `tests/e2e/port-auto-increment.spec.ts` asserts occupied-port auto-increment, actual-port/gateway-url files, conflict output, explicit-port `EADDRINUSE`, and free-port `OK:<port>`. | **No**. | **MB-COVERED**. |
| Daily `tests/subsystem-cpu-attribution.test.ts` asserts real Git child buckets, Docker-attempt bucket, timer counters, and diagnostics file behavior. | **No** for actual child attribution/flush; **Yes** for counter aggregation fed synthetic samples. | **MB-COVERED** for attribution instrumentation, not for a successful Docker container operation. |

### 1.9 Gateway process lifecycle and filesystem watcher

- `tests2/core/lifecycle-hub.test.ts` exercises provider hook timeout/error continuation, not OS lifecycle signals. Its timeout result and diagnostics are **Boundary-independent: Yes** when driven by the injected provider/timer.
- Baseline `tests2/browser/e2e/crash-restart.journey.spec.ts` asserts health recovery, persisted session/preview/localStorage, and reconnect after `gateway.crash()`/`restart()`. At merge base `gateway.crash()` is `await gw.shutdown()` in the same process. It does not assert gateway PID death, `SIGINT`, `SIGTERM`, parent death, or uncaught-exception handling. Gateway OS lifecycle is **MB-GAP**.
- `tests2/core/preview-mount.test.ts > watcher fires after a re-mount (handle survives the swap)` performs a real watch and asserts notification after remount. This is **Boundary-independent: No**. Merge-base browser preview tests use explicit refresh, injected events, or persistence checks; none mutates the watched source and observes watcher delivery. Result: **MB-GAP**.

## 2. Timer seams

| Timer seam | Baseline unit owner and exact assertion | Boundary-independent? | Merge-base E2E result |
|---|---|---:|---|
| Background wait timeout/heartbeat | `bg-process-manager.test.ts > timeout fires deterministically under fake timers`; `bg-wait-response.test.ts > writes at least one heartbeat newline on tick`; real integration abort/release cases listed above. | **Yes** for fake-timer state/heartbeat formatting; **No** for integration elapsed thresholds. | **MB-PARTIAL** — normal real wait completion only. |
| Team wait | `tests2/integration/team-wait-semantics.test.ts > returns on the first idle child...`, `> already-idle child returns immediately...`, `> a streaming child...times out`, and mixed idle/timeout assert `firstIdle`, remaining/queued statuses, terminal timeout, and wording. | These E2E assertions use wall-clock scheduling and are **No** as timing assertions; status aggregation itself is **Yes**. | **MB-COVERED** by the same fixed Group-I baseline owner. The agent bridge remains in-process, so this does not cover child-process timing. |
| Team idle nudge/backoff | `team-manager-idle-nudge-backoff.test.ts` advances an injected clock across 5m/10m exponential cycles and the 12h cap; `team-manager-worker-idle-debounce.test.ts` advances 1s/6s and asserts zero/one notification and cancellation on removal. | **Yes** — manual clock and fake sessions are the intended seam. | **MB-GAP** for wall-clock delivery, but no real-boundary unit ownership is being moved. |
| Session abort grace | `session-manager-force-abort-grace.test.ts > force-kills within the grace period...` asserts elapsed lower/upper bounds. | **No** for the elapsed assertion. | **MB-GAP**. |
| Verification command timeout/cancel | Contract and harness cases assert actual timeout, tree death, output, and close. | **No**. | **MB-PARTIAL** as detailed in §1.3. |
| Verification review/reminder timing | `verification-review-timeout-contract.test.ts` uses `makeClock()` and fake session waits to assert 1,200,000ms allowance, repeated 7,000ms windows, 15,000/20,000ms settle windows, and 75,000/330,000ms retry grace; `verification-reminder-race.test.ts` mostly uses fake sessions/events, with a few real bounded waits. | **Yes** for supplied timeout values/manual-clock state; **No** for tests that assert real elapsed race/timeout behavior. | **MB-GAP**. |
| Subgoal cancellation/timeout | `runSubgoalStep-timeout.test.ts` feeds a `timeout` outcome and asserts no merge/archive; `runSubgoalStep-cancellation.test.ts` flips cancellation during a real scheduled wait and asserts return `<1s`. | **Yes** for timeout outcome policy; **No** for the `<1s` cancellation deadline. | **MB-GAP**. |
| Proposal debounce | `proposal-helpers.test.ts > rapid saves coalesce via the debouncer` waits 400ms and asserts one PUT/latest body; delete-cancel asserts zero PUTs. | **No** at merge base because the tests use real `setTimeout`, even though the behavior is seamable. | **MB-GAP**. |
| Store persistence debounce/expiry | Prompt-draft, side-panel, plan/session/bg stores assert coalescing, ordering, expiry, or cleanup with a mixture of manual and real waits. | **Yes** where a manual clock/explicit flush is injected; **No** where passing wall time is asserted or required. | **MB-GAP**. |
| Worker/channel timeout and idle disposal | `extension-host-module-isolation` asserts prompt termination of infinite workers; `extension-host-channel-registry > closes late handler sessions after an open timeout` and detached idle cleanup assert timeout disposal. | **No** for real worker termination; **Yes** for registry state under an injected/manual timer. | **MB-PARTIAL** only for terminal lifecycle; generic timeout cases are gaps. |
| Watch delivery/polling | `preview-mount` waits for real watch delivery. Test-side `expect.poll`/`waitFor` elsewhere merely observes state and is not itself production-boundary ownership. | **No** for watcher delivery; observation polls are not product boundary assertions. | **MB-GAP**. |

The core rule is preserved: real elapsed-time, timeout, output, exit, signal, and watcher assertions remain real even when a nearby E2E exercises the same feature.

## 3. Container seams

The tests-map rationale at the merge base labels `tests/e2e/sandbox-recovery.spec.ts` “Real Docker sandbox container recovery”, but the baseline file content is authoritative: its header says the three cases need no Docker, Docker-dependent recovery moved to `sandbox-recovery-docker.spec.ts`, and each case injects `process_exit` through the in-process bridge listener list. It is not Docker evidence.

| Container seam | Baseline unit owner and exact assertion | Boundary-independent? | Merge-base E2E result |
|---|---|---:|---|
| Docker command/argument construction | `docker-args.test.ts`, `docker-args-sanitize.test.ts`, container-path translation, and sandbox mount tests assert argv, quoting, mounts, paths, limits, and secret exclusion. | **Yes**. | **MB-GAP** for execution; no real boundary is required by these unit assertions. |
| Docker availability/resource probe | `sandbox-cpu-allocation.test.ts > returns an object with cpus and memBytes when Docker is available` conditionally executes real `docker info`; `subsystem-cpu-attribution` records a Docker child bucket even on failure. | **No** for successful probe values; allocation arithmetic is **Yes**. | **MB-GAP** — an attempted/failing `docker info` is not container lifecycle coverage. |
| Project sandbox create/init/recreate/recover | `project-sandbox-agent-dir-mounts.test.ts > recreates an existing project container...` asserts fake call order `remove → create → init`; sandbox recovery helpers assert state/respawn continuity. | **Yes** for policy/call ordering against injected methods. Any assertion that a real container is removed/created/healthy is **No**. | **MB-GAP**. Real recovery exists only under merge-base manual integration, which is excluded. |
| Verification `docker exec` and process-group kill | `verification-sandbox-exec.test.ts > spawns docker exec...` runs real Docker CLI and asserts failure output; `verification-docker-blast-radius.test.ts` statically asserts pgid-scoped kill and forbids `kill ... -1`. | **No** for actual Docker CLI/error output; **Yes** for the static blast-radius source contract. | **MB-GAP**. |
| Container-backed background process restore/kill/logs | `bg-process-persistence.test.ts` uses fake `dockerCli`, fake container liveness/pidfile, fake tailers, and manual clock to assert reattach, negative process-group target, unrecoverable classification, retained projection, and kill intent. | **Yes** for state/routing assertions; a claim of real exec/log/inspect/kill effect would be **No** and is not present. | **MB-GAP**. |
| Sandboxed-agent synthetic exit handling | `sandbox-recovery.spec.ts` asserts REST/WS transition to `terminated` and clears `wasStreaming` after direct listener injection. | **Yes** — event-handling policy is independent of Docker. | It does not qualify as container coverage: **MB-GAP** for the container boundary. |

## 4. Ownership conclusions

1. Do not replace or reclassify the real unit owners for `RpcBridge` exit/output, verification timeout/tree-kill/restart recovery, real `bash_bg` output/wait timing, executable probes, watcher delivery, or real debounce/grace timing. Their assertions are boundary-dependent at the merge base.
2. Merge-base E2E already owns local Git, local bare-remote branch cleanup, spawn-tree survival/kill, MCP subprocess RPC, terminal PTY lifecycle, port conflict handling, and the hung-test runner process.
3. Merge-base E2E only partially owns verification commands, background processes, generic extension workers, and selected timers.
4. Merge-base E2E has no real ownership for agent child processes, gateway OS signals, standalone AIGW/npm/QA/binary probes, filesystem watch delivery, long scheduler/reviewer/subgoal timers, or any Docker/container lifecycle.
5. E2E added after `4df9a35e2bd1ac5b662382189e12973fc4e1c4c2` cannot be used to move real-boundary ownership for this timing decision.
