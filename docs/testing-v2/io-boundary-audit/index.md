# Canonical unit I/O boundary audit

**Audit date:** 2026-07-15
**Evidence authority:** merge base `4df9a35e2bd1ac5b662382189e12973fc4e1c4c2` (`MB`) only
**Decision:** report eligibility before any unit fixture change; this is not a coverage-migration plan.

This index synthesizes the six completed audits in this directory, including the full `tests2/dom` scope. Every qualifying path, title, and assertion below existed at MB and was selected there by `test:e2e:v2`: daily Groups A/B/C, the physical `tests2/browser/e2e` project, or the twelve files then listed in `scripts/testing-v2/integration-e2e-files.mjs`. Unit-scope integration tests, tier-2 browser journeys, manual tests, post-MB assertions, and a filename containing `e2e` do not qualify.

**Current ownership correction:** the twelve historical Group-I files are no longer excluded from unit. They are restored to `v2-integration`, the dedicated `v2-integration-e2e` project and Group-I runner are removed, and all 880 merge-base core/DOM/integration files are required in `npm run test:unit`. References to Group I below describe merge-base evidence only, not current tier ownership.

## Strict eligibility rule

A **specific unit assertion** may move behind a mock only when both keys are true:

1. an assertion-equivalent MB E2E crossed the same real boundary and asserted the material result; and
2. that specific unit assertion is boundary-independent—policy, parsing, mapping, serialization, or orchestration over supplied I/O results.

`MB-COVERED` describes E2E ownership of an interaction; it is not blanket permission to mock a mixed seam. Assertions about real bytes, fresh-process reload, temp/rename/backup/recovery, refs/SHAs/worktrees, process output/exit/signals, elapsed time, listener/socket framing, module import, executable discovery, subprocess connection, or container state remain real. `MB-PARTIAL` and `MB-GAP` never authorize wholesale conversion.

## Canonical interaction table

Rows combine source-audit entries only when they have the same status and proof obligation. The final column is the exact MB owner and material assertion, not a nearby feature test.

| ID | Canonical interaction | MB status | Exact MB baseline owner and assertion |
|---|---|---|---|
| `C-01` | Session-store serialization/state semantics (`P-01`) | **MB-COVERED** | `tests2/browser/e2e/crash-restart.journey.spec.ts:68-94`: after gateway crash/restart, session GET is `200`, id matches, editor is visible, and URL retains the session id. |
| `C-02` | Cost tracking and legacy backfill (`P-02`) | **MB-PARTIAL** | No qualifying E2E. `tests/e2e/cost-backfill-on-boot.spec.ts:376-435` asserts persisted stamping/log/totals but was mapped to `v2-integration`, so it is predecessor evidence only. |
| `C-03` | Common gateway stores and direct-manager registries (`P-03`, `P-05`) | **MB-PARTIAL** | `tests2/browser/e2e/gate-status-cross-surface.spec.ts:377-410` proves gate status across surfaces/browser reload, not disk reload; `tests/e2e/remove-boot-respawn-restart.spec.ts:91-129` proves one team teardown/restart outcome; `tests2/integration/orchestrate-restart.test.ts:179-240` rebuilds restoration in process. |
| `C-04` | Native project-YAML serialization/migration (`P-04`) | **MB-PARTIAL** | No qualifying E2E. `tests/e2e/per-project-config-dirs.spec.ts:155-171` asserts native YAML bytes after reload but was mapped to `v2-integration`. |
| `C-05` | Agent-directory validation and credential/model migration (`P-06`) | **MB-GAP** | None. `tests/e2e/ui/settings-agent-dir.spec.ts:126-147` is a nonqualifying `v2-browser` predecessor. |
| `C-06` | Draft/proposal/transcript parsing and copy (`P-07`) | **MB-PARTIAL** | `tests2/integration/continue-archived-assistant.test.ts:114-253` asserts destination existence, byte-identical live/history/snapshot copies, role/tool/staff copies, and absent-source no-op; it does not prove draft reload or proposal atomic edit. |
| `C-07` | Background/verification spool persistence (`P-08`) | **MB-PARTIAL** | No equivalent `bash_bg` restart owner. `tests2/browser/e2e/terminal-pack.spec.ts:39-110,339-384` proves terminal attach/restart only, not spool/pid/status-file semantics. |
| `C-08` | Preview manifest/hash/artifact decisions (`P-09`) | **MB-COVERED** | `tests2/browser/e2e/crash-restart.journey.spec.ts:129-152`: mounted entry survives restart; GET is `200`, entry matches, and hash is SHA-256-shaped. |
| `C-09` | Real watcher delivery/re-arm (`P-10`) | **MB-GAP** | None mutates a watched source and observes real delivery. Refresh-button or injected events are not `fs.watch` proof. |
| `C-10` | Copy/rename/swap/archive/install/migration operations (`P-11`) | **MB-PARTIAL** | `continue-archived-assistant.test.ts:114-253` proves recursive copy; `continue-archived-worktree.spec.ts:101-170` proves clone placement; `marketplace-mcp.spec.ts:210-321` proves install/update/removal; `goal-archive-branch-cleanup.spec.ts:96-255` proves branch cleanup. Interrupted swap/rollback and migration recovery are unproved. |
| `C-11` | Discovery/tree-reader policy and real topology (`P-12`) | **MB-PARTIAL** | `tests/e2e/mcp-integration.spec.ts:81-104` asserts connected discovery/tool names; `tests/e2e/marketplace-mcp.spec.ts:210-321` asserts installed discovery reaches runtime. Symlink/realpath and precedence contracts are unproved. |
| `C-12` | Persisted pool-claim branch decision only (`P-13`) | **MB-COVERED** | `tests/e2e/pool-claim-restart-resume.spec.ts:71-133`: asserts `session/<id8>`, real worktree existence, stable branch/path after restore, unchanged reflog, and stable inode where supported. This covers the decision, not generic Git execution. |
| `C-13` | Atomic writer/concurrent-writer locking (`P-14`) | **MB-GAP** | None creates two writers or proves lost-update/stale-lock recovery. |
| `C-14` | Repository containment, refs, command fence, sanitized snapshot, native status (`GIT-001`–`005`) | **MB-GAP** | None is assertion-equivalent for the real repository/ref/status/fence matrices. The PR Walkthrough `NO_PR` UI case does not prove command-fence or Git-status behavior. |
| `C-15` | Host worktree creation/publication/upstream/refspec (`GIT-006`) | **MB-PARTIAL** | `tests2/integration/sidebar-actions-fork-github-link.test.ts:270-316,350-386` proves distinct creation/reuse and stale-source replacement, not upstream clearing, pool claims, publication, or refspec safety. |
| `C-16` | Team-member worktree lifecycle/base SHA (`GIT-007`) | **MB-GAP** | `team-dismiss-structured-regression.test.ts:121-147` proves registration, structured dismissal, removal, and idempotence only; it never inspects a worktree, branch, commit, or `baseSha`. |
| `C-17` | Goal/session/staff worktree provisioning and ordering (`GIT-008`) | **MB-PARTIAL** | `sidebar-actions-fork-github-link.test.ts:270-316,350-386` proves session worktree creation/reuse only; staff, auto-start ordering, child setup, and reconciliation remain unproved. |
| `C-18` | Multi-repository worktree-set lifecycle (`GIT-009`) | **MB-PARTIAL** | `tests2/integration/multi-repo-flow-api.test.ts:91-97` always asserts structured components; exact `api`/`web` paths and cleanup at `:135-152` are conditional, and `:153-157` permits single-worktree fallback. |
| `C-19` | Worktree inventory/ownership/maintenance cleanup (`GIT-010`) | **MB-PARTIAL** | `multi-repo-flow-api.test.ts:135-157` is conditional/fallback-permissive; `sidebar-actions-fork-github-link.test.ts:388-392` is test-helper cleanup. Neither invokes and asserts the production maintenance classifier/API. |
| `C-20` | Verification Git identity and non-destructive sync (`GIT-011`) | **MB-GAP** | None proves equal/ahead/diverged/absent graphs, ancestry, hard fast-forward, or local-commit preservation. |
| `C-21` | Commit/diff extraction and hunk identity (`GIT-012`) | **MB-PARTIAL** | `tests2/integration/commit-file-diffs-api.test.ts:70-110,126-177` asserts M/A/D/R metadata, patch markers, errors, worktree readiness, and commit/diff extraction; `pr-walkthrough-pack.spec.ts:418-432,842-888` proves confinement and durable live evidence. Parser permutations are not all covered. |
| `C-22` | GitHub CLI/link/export/review behavior (`GIT-013`) | **MB-PARTIAL** | `sidebar-actions-fork-github-link.test.ts:170-205` proves cached PR/branch-link/unavailable states; `pr-walkthrough-pack.spec.ts:653-695` proves visible `NO_PR`. Neither proves `gh` auth, enterprise hostname, argv/stdin, review payload, or launch failure. |
| `C-23` | Git census/incidental Git scaffolding/Headquarters suppression (`GIT-014`–`016`) | **MB-GAP** | No exact MB E2E. Active non-Git assertions may be fixture-cleanup candidates, but strict two-key eligibility is not met and they cannot be reported as coverage migration. |
| `C-24` | Agent `RpcBridge` child spawn/output/abrupt exit | **MB-GAP** | Browser/integration harnesses use `InProcessMockBridge`; `sandbox-recovery.spec.ts` injects `process_exit`. No MB E2E owns real agent-child exit. |
| `C-25` | Verification command spawn/output/timeout/tree-kill/restart | **MB-PARTIAL** | `gate-status-cross-surface.spec.ts` runs a real long Node command and asserts running state; `goal-team-gates.journey.spec.ts` runs a marker command and asserts inspect output. Timeout, descendants, escalation, cancellation marker, and durable adoption remain unproved. |
| `C-26` | Background process create/wait/log/kill/restart | **MB-PARTIAL** | `tests2/browser/e2e/tail-chat-real-stream.spec.ts:30-73` reaches real `bash_bg` create/wait and normal completion; it does not assert direct logs, exit reason/code, kill, or restart recovery. |
| `C-27` | Standalone process canaries: spawn-tree, port binding, hung-test runner | **MB-COVERED** | `tests/spawn-tree-shutdown-survival.test.ts` asserts real PID survival/death; `tests/e2e/port-auto-increment.spec.ts` asserts conflict/increment/files/output/result; `tests/run-unit-hung-test-integration.test.ts` asserts nonzero exit, timeout text, filename, and heartbeat. Their real process assertions remain real. |
| `C-28` | Generic extension-worker lifecycle/isolation | **MB-PARTIAL** | `terminal-pack.spec.ts` traverses one worker-backed channel but does not assert infinite-loop timeout, heap crash, top-level-await, or generic worker recovery. |
| `C-29` | Terminal PTY protocol/lifecycle | **MB-COVERED** | `tests2/browser/e2e/terminal-pack.spec.ts:39-108,339-384` asserts command output, resize, reload attach/replay, exit, kill, restart, and gateway-restart disconnect. |
| `C-30` | Gateway OS death/signals, standalone probes, and Docker/container lifecycle | **MB-GAP** | `crash-restart` calls in-process shutdown, `sandbox-recovery.spec.ts` explicitly needs no Docker, and no MB E2E owns AIGW/npm/binary probes or a real container lifecycle. |
| `C-31` | Team-wait result semantics | **MB-COVERED** | Fixed Group-I `tests2/integration/team-wait-semantics.test.ts:152-169` and its first-idle/immediate/queued/timeout cases assert the exact result/status/error contracts. Wall-clock timing itself remains real. |
| `C-32` | Scheduler/reminder/backoff/debounce/reviewer/subgoal timers | **MB-GAP** | No assertion-equivalent MB E2E. Manual-clock policy assertions are already boundary-independent; real elapsed deadlines are not mock-eligible. |
| `C-33` | Gateway HTTP routes and listener lifecycle | **MB-PARTIAL** | Exact route proofs include session response (`session-lifecycle`), project isolation, team auth (`team-lead-child-authz`), commit diff, and preview (`misc`); `crash-restart` asserts `/health` `200`. They do not cover unrelated endpoints, bind/refusal, or open-socket shutdown. |
| `C-34` | Gateway WebSocket and extension-channel transport | **MB-PARTIAL** | `tail-chat-real-stream.spec.ts:30-73` proves live stream; `goal-team-gates.journey.spec.ts:231-305` proves gate frames; `terminal-pack.spec.ts:39-108` proves terminal happy path. Auth rejection, payload limits, backpressure, fan-out, and close cleanup remain real. |
| `C-35` | Chunked HTTP/body streaming | **MB-PARTIAL** | `team-wait-semantics.test.ts:152-169` proves a post-header error response only. Header timing, heartbeat bytes, abort, chunk boundaries, and oversized request cleanup are unproved. |
| `C-36` | SSE, AIGW, OAuth, image, Code Assist, Hindsight, GitHub HTTP, TLS | **MB-GAP** | No qualifying MB E2E crosses and asserts these upstream/listener protocols; intercepted browser routes and “feature absent” UI assertions do not qualify. |
| `C-37` | Generated gateway clients and direct handler adapters | **MB-PARTIAL** | `pr-walkthrough-pack.spec.ts:624-648,698-724` proves one real generated route POST plus session header/body; linked-goal and preview journeys prove selected handlers. Other generated clients, body overflow, cookie auth, heartbeat, and stream state remain unproved. |
| `C-38` | Fetch/command egress fence and HTTPS/TLS | **MB-GAP** | No product E2E is assertion-equivalent. Positive loopback, block-before-DNS, and any future TLS handshake remain real canaries. |
| `C-39` | Browser imports/package exports/production UI bundle | **MB-PARTIAL** | `terminal-pack.spec.ts` loads and operates one shipped production panel; no MB E2E invokes every supported lazy Pi import/export/chunk or bundle-size contract. |
| `C-40` | Generated TypeScript and Pi-extension write/transpile/import/probe | **MB-GAP** | No MB E2E spawns real Pi and proves generated extension import/execution or Pi-extension probe/remap. |
| `C-41` | Extension Host module loading/containment/resource behavior | **MB-PARTIAL** | PR Walkthrough executes built-in routes and rejects caller `repoDir` exfiltration; Terminal executes a real channel. Rewrite invalidation, symlink/import escape, timeout/OOM/crash, and hostile modules remain unproved. |
| `C-42` | Pack manifest/contribution and custom tool/skill discovery | **MB-PARTIAL** | Terminal and PR Walkthrough prove shipped contributions and activation/default-off toggles. No MB E2E proves conflicting/malformed bands or custom `config_directories` loaded by a real agent. |
| `C-43` | Marketplace source/install/update/uninstall | **MB-PARTIAL** | `tests/e2e/marketplace-mcp.spec.ts` proves source creation, virtual/local pack install, runtime activation/update, and uninstall; git sync, metadata/order, generic file fidelity, rollback, and restart persistence are unproved. |
| `C-44` | npm package/healing, project archive, and agent-directory runtime | **MB-GAP** | No MB E2E installs the tarball, repairs dependencies, proves archive fallback, or restarts on a changed agent directory. |
| `C-45` | Executable discovery/staging | **MB-PARTIAL** | Terminal proves a platform shell and Group-I sidebar coverage proves local Git; neither proves bundled `fd`/`rg`, package resolution, PATH probing, permissions, or staging. |
| `C-46` | Credential bootstrap and child/container propagation | **MB-PARTIAL** | Group-I `team-dismiss-structured-regression.test.ts` proves scoped route authorization; `team-delegate.test.ts` proves model metadata through a mock bridge. Neither inspects real child/container env, files, mounts, or token omission. |
| `C-47` | Provider keys, OAuth/Code Assist/AIGW, provider hooks, built-in tool extensions | **MB-GAP** | No MB E2E persists/reloads credentials and drives the corresponding real Pi/provider/extension/upstream chain. |
| `C-48` | MCP catalogue, stdio/HTTP transport, generated proxy/meta-tool chain | **MB-PARTIAL** | `tests/e2e/mcp-integration.spec.ts` proves real stdio discovery, tool list, direct `echo`/`add`, and errors; `marketplace-mcp.spec.ts` proves runtime activation/update; `mcp-tool-permission.spec.ts` proves policy. No MB owner proves streamable-HTTP session close or real Pi loading/invoking the generated meta-tool. |
| `C-49` | happy-dom custom-element registry, lit pinned-document, teardown-gap rAF bridge (`D-01`) | **MB-PARTIAL** | Terminal and PR Walkthrough load selected production browser bundles, but no MB E2E reproduces the v2-dom shared-fork `isolate:false` registry replay or teardown gap. |
| `C-50` | DOM-owned search filesystem, FlexSearch persistence/reopen/corruption/close/performance (`D-03`) | **MB-GAP** | None. MB `tests/e2e/ui/search-e2e.spec.ts` was `v2-browser`, not daily E2E; the qualifying navigation story only deep-links to `#/search` and asserts the route. |
| `C-51` | DOM client fetch/route construction and response projection (`D-04`) | **MB-PARTIAL** | `pr-walkthrough-pack.spec.ts:624-728` proves exact slash/session-menu route requests and feedback; `gate-status-cross-surface.spec.ts:238-258,282-330,377-415` proves selected widget state. Other mocked DOM routes never cross real HTTP in a qualifying owner. |
| `C-52` | DOM WebSocket client state machines: token mint, resume/dedupe, outbox, staff push (`D-05`) | **MB-PARTIAL** | `terminal-pack.spec.ts:39-108` proves selected channel open/attach/output/kill behavior and `tail-chat-real-stream.spec.ts:30-73` proves live transcript streaming. Stale-token remint, resume frames, sequence holes, offline bounds, and staff refresh are unproved. |
| `C-53` | Browser local/session storage and IndexedDB (`D-06`, `D-07`) | **MB-PARTIAL** | `stories-navigation.spec.ts:297-347` proves the real `bobbit-sidebar-collapsed` key across reload; `crash-restart.journey.spec.ts:159-175` proves one tree-state key across restart/reload. Transient drafts, model/outbox keys, quota/security errors, and IndexedDB are unproved. |
| `C-54` | Browser URL/history/navigation/PWA state (`D-08`) | **MB-PARTIAL** | `stories-navigation.spec.ts:74-117,124-290,463-520` proves real deep links, back/forward, reload, and session↔goal back. Stale-assistant suppression, no-dashboard-history, connect/hash and rapid-key races, and PWA lifecycle remain unproved. |
| `C-55` | DOM real timers/clocks/rAF, polling, expiry, flush/close timing (`D-09`, `D-10`) | **MB-GAP** | No qualifying MB E2E asserts the exact interval cancellation, elapsed deadline, rAF ordering, expiry/eviction, or search close/flush timing. Fake clocks and polling waits are not real-time proof. |
| `C-56` | DOM observers, workers, canvas/layout, speech/service-worker APIs (`D-12`) | **MB-GAP** | No DOM unit invokes a real worker/observer/service worker, and no qualifying MB E2E owns the missing lifecycle/failure contracts. The lane uses a no-op ResizeObserver and fake SpeechRecognition only. |

## Actually eligible now

These are the only narrow assertion groups authorized by the two-key rule. Authorization does not extend to the rest of the named file.

| Exact unit assertion group/file | What may be mocked | Real canaries that must remain |
|---|---|---|
| `tests2/core/session-store.test.ts:163-209,308-377,405-445`; `session-store-stale-load-guard.test.ts:69-129` — child/durable fields, draft generation/stale-write policy, semantic save/reload/delete, epoch decisions | Injected `FsLike`/memfs and injected write failures for those semantic decisions | `tests2/integration/session-store-real-fs.test.ts` for real `sessions.json`, `.tmp`, backup rotation, corrupt-primary recovery, recursive traversal/mtime; `crash-restart.journey.spec.ts` for restart visibility. **P-01 is eligible only for session semantics, never real temp/backup/recovery.** |
| `preview-mount.test.ts:79-425` decision-only cases; `preview-artifacts.test.ts:67-151` metadata/dedupe/identity/non-mutation cases | Supplied manifest/tree/hash inputs and injected stage-operation outcomes | Real selective copy, artifact bytes, stage/swap rename, mtime, temp-file absence, and `fs.watch` delivery/re-arm; `crash-restart.journey.spec.ts:129-152`. |
| `pool-claim-stable-branch.test.ts:23-61` — persisted `session/<id8>` branch/path remains unchanged across semantic reload | Store seam for the branch-preservation decision | Real refs, reflog, worktree directories, inode/topology, push/delete, and Git output; `pool-claim-restart-resume.spec.ts:71-133`. No other Git/worktree assertion is authorized. |
| `mcp-meta-name.test.ts`; `mcp-meta-schema.test.ts`; pure `mcpPolicyPrefix`, `resolveGrantPolicy`, and `computeEffectiveAllowedTools` groups in `mcp-meta-policy.test.ts`/`mcp-policy-prefix.test.ts`; supplied-record validation/mapping only | Supplied catalogues/descriptors and recording transports for naming, schema, policy filtering, operation mapping, and error mapping | `mcp-integration.spec.ts`, `marketplace-mcp.spec.ts`, and `mcp-tool-permission.spec.ts`; the real streamable-HTTP session-header canary in `marketplace-mcp-gateway.test.ts`; generated-file import/Pi proxy call remains real and currently unproved. **MCP eligibility is catalogue/policy only, never subprocess connection/output/exit or generated proxy execution.** |
| Handler/proxy-only groups in `extension-host-terminal.test.ts`, including “bridges client text/resize/kill frames…” and “opens a narrow PTY handle…” | Proxy `ChannelPtyService`/PTY host for frame routing, options, replay, status projection, and policy | `terminal-pack.spec.ts` for real PTY output/attach/exit/kill/restart; platform PTY spawn and lifecycle assertions remain real. Manifest/file-loading cases in the same unit file are not included. |
| Pure manifest/default-off and activation-filter decisions in `pack-default-disabled.test.ts` (`parseManifest`, `isPackEffectivelyEnabled`) and supplied-record catalogue shaping | Supplied manifest records and activation-store results | `pr-walkthrough-default-off.spec.ts`, `pr-walkthrough-pack.spec.ts`, and `terminal-pack.spec.ts`; real pack-tree enumeration, manifest reads, module loading, precedence, and installed-pack dispatch remain real. |
| DOM PR Walkthrough launcher decisions: `tests2/dom/message-editor-pack-slash.test.ts:148-157`; `session-menu.test.ts:414-423`; and only the `NO_PR` half at `session-menu.test.ts:426-435` | Supplied launcher entries, recording host factory, and supplied `NO_PR` result for autocomplete completion, inactive-row binding, feedback/menu close, and no panel | `tests2/browser/e2e/pr-walkthrough-pack.spec.ts:624-648,653-728` for production browser autocomplete, real route POST, row-session header/body, feedback, and no child/panel/view switch. Argument parsing, generic throws, success opening, reconciliation, and socket/token behavior are excluded. |

## Not eligible hotspots

The broad seams are mixed, so an independently seamable sub-decision does not authorize converting the hotspot file.

| Hotspot | MB result | Why it is not eligible |
|---|---|---|
| `tests2/core/team-manager.test.ts` | `GIT-007` **MB-GAP**; direct-manager persistence only **MB-PARTIAL** | Its existing integration block asserts inherited files, exact HEAD/`baseSha`, local-only bases, distinct worktrees, `git worktree list`, cleanup/prune, and persistence around those real results. Registration/dismiss E2E is not worktree proof. |
| `tests2/integration/maintenance-api.test.ts` | `GIT-010` and route coverage **MB-PARTIAL** | MB E2E neither invokes the production maintenance classifier/API nor proves shared-owner preservation, stale/collision selectors, selected/all removal, sandbox skipping, or safe branch deletion. Real worktree/branch outcomes are boundary-dependent. |
| `tests2/core/rpc-bridge-lifecycle.test.ts` | Agent child **MB-GAP** | “rejects a pending prompt exactly once…” spawns a real synthetic Pi child and asserts exit `17`, stderr, one rejection, one `process_exit`, and `running === false`. MB browser tests use `InProcessMockBridge` or inject the exit event. |
| `tests2/integration/mcp-meta-call.test.ts` | MCP family **MB-PARTIAL**, generated meta-tool chain **MB-GAP** | The unit-scope file seeds fake MCP clients. MB E2E calls MCP through gateway REST, not through a real Pi-loaded generated meta-tool, and does not prove session-header/close/owned-child exit. Catalogue/policy eligibility cannot be broadened to this lifecycle seam. |

## Counts

| Measure | Covered | Partial | Gap | Total |
|---|---:|---:|---:|---:|
| Source-audit decisions, non-deduplicated across six audits | 10 | 39 | 49 | 98 |
| Canonical interaction families above, overlaps collapsed | 6 | 32 | 18 | 56 |
| Broad families eligible for wholesale mocking | 0 | 0 | 0 | 0 |
| Exact narrow assertion groups actually eligible now | 7 | — | — | 7 |

The full MB unit denominator is **868 files**: `548` core + `144` DOM + `188` integration − the `12` fixed Group-I integration E2E files. Thus the domain unit counts are `548` core, `144` DOM, and `176` unit-scope integration. Counts of source decisions are intentionally non-additive because one file/interaction can appear in filesystem, process, transport, loader, and DOM audits.

## Frozen execution state

- Newly added E2E edits in `tests2/integration/team-dismiss-structured-regression.test.ts` and `tests2/integration/multi-repo-flow-api.test.ts` were **reverted**. They are post-MB in origin and cannot qualify even if reintroduced.
- The four coverage-first paths for `team-manager`, `maintenance-api`, `rpc-bridge-lifecycle`, and `mcp-meta-call` are **stopped**. Do not add or relocate coverage merely to unlock a unit-fixture conversion; there is no coverage migration in this audit.
- The attempted three-lane run is **invalid and discarded**. It is not a before/after baseline and yields no acceptance or quiet-timing claim.
- Scheduling and lane allocation are **frozen**. The loaded Windows profile may identify amplification/hotspots only; no schedule change or lane move proceeds from it. Current restored-scope measurements and accepted/rejected edit gates are recorded in [`restored-integration-topology.md`](restored-integration-topology.md).

## Source audits

- [`filesystem-persistence.md`](filesystem-persistence.md)
- [`git-worktree-gh.md`](git-worktree-gh.md)
- [`process-timer-container.md`](process-timer-container.md)
- [`transport-network.md`](transport-network.md)
- [`loaders-extensions-packages.md`](loaders-extensions-packages.md)
- [`dom.md`](dom.md)
- [`restored-integration-topology.md`](restored-integration-topology.md)
