# In-process pi bridge — spike (Wave-5)

Status: **spike complete, prototype behind a flag, recommend a narrow "go"**.

## Hypothesis

Bobbit hosts each agent by spawning `@earendil-works/pi-coding-agent` as a
child process and talking JSONL RPC over stdio
(`src/server/agent/rpc-bridge.ts`, `bg-process-{manager,store,runner}.ts`).
Hosting pi in-process (in the gateway's own event loop, or a worker thread)
instead of a spawned child could cut spawn latency, RPC serialization
overhead, and process-management complexity.

This spike verifies the hypothesis against the real pi package installed in
this repo (`@earendil-works/pi-coding-agent@0.79.6`), builds the smallest
working prototype behind a flag, and measures the two costs the hypothesis
names. It supersedes and independently re-verifies the prior pass in
`~/Documents/dev/bobbit-fable-refactor/raw/analysis-in-process-vs-out.md`
(TRACKER.md W5.4) — the architecture findings below match that analysis; the
measurements in this doc were re-run independently on this host for this
spike, plus a new steady-state-cost measurement and a working prototype.

## Does pi support in-process hosting? Yes — verified, not hypothetical

`node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` ships an
in-process embedding SDK from `core/sdk.ts` as first-class exports:
`createAgentSession`, `createAgentSessionRuntime`,
`createAgentSessionServices`, `AgentSession`/`AgentSessionEvent`, tool
factories `createReadOnlyTools`/`createCodingTools`/`createBashTool`
(with an injectable `BashOperations`/`BashSpawnHook`), and
`discoverAndLoadExtensions`/`createExtensionRuntime`. `modes/rpc-mode.d.ts`
states its own purpose verbatim: *"Used for embedding the agent in other
applications"* — the CLI's own `--mode rpc` is `createAgentSessionRuntime()`
+ `runRpcMode()` under the hood. Confirmed by reading the shipped `.d.ts`
files directly (not documentation) in this repo's `node_modules`.

**The seam already exists in Bobbit.** `IRpcBridge` + `registerRpcBridgeFactory()`
(`src/server/agent/rpc-bridge.ts:144,221-223`) let an alternative bridge
implementation replace the child-process one. `ClaudeCodeBridge implements
IRpcBridge` (`claude-code-bridge.ts:147`) and the E2E mock
(`tests/e2e/in-process-mock-bridge.mjs`) already prove Bobbit runs multiple
runtimes behind this one interface. All three pi packages
(`pi-agent-core`, `pi-ai`, `pi-coding-agent`) are already exact-pinned
dependencies — no new dependency for a third `IRpcBridge`.

Even better than the interface seam: `src/server/agent/session-runtime.ts`
already has a **per-session factory function**,
`createSessionBridge(options): IRpcBridge` (called once per session from
`spawnAgent()` in `session-setup.ts:1536`), that picks between `RpcBridge`
and a lazily-loaded `LazyClaudeCodeBridge` depending on `options.runtime`.
This is a cleaner, more local insertion point than the global
`registerRpcBridgeFactory()` test hook: one function, one call site, already
in the per-session hot path.

## What blocks in-process today (load-bearing)

1. **Sandbox = the whole process runs in the container today.** Tools like
   `shell/extension.ts` call `spawn("/bin/bash", …)` in whatever process
   loads them. Out-of-process, that's the per-project Docker container.
   In-process on the host, bash/edit/write would run directly on the host
   with no containment. This is the real, hard blocker — and it only bites
   **code-executing** agents. `createReadOnlyTools()` is exactly
   read/grep/find/ls, **no exec, no mutation** (verified against
   `dist/core/tools/index.d.ts` — the read-only bundle has nothing to
   contain).
2. Bobbit's own tools are authored against pi's CLI `ExtensionAPI`
   (`shell/extension.ts` imports `ExtensionAPI` from
   `@earendil-works/pi-coding-agent`). An in-process bridge either reuses
   pi's exported extension loader or passes `customTools: ToolDefinition[]`
   directly (the prototype does the latter, for the read-only bundle only).
3. Session lifecycle, transcript snapshotting, restart re-attach, and
   `bash_bg` persistence are all shaped around a **child PID**
   (`rpc-bridge.ts` stdin/stdout, SIGTERM/SIGKILL). An in-process agent has
   no PID to persist or re-attach across a gateway restart — see Risks below.
4. Event-shape parity: the RPC wire protocol (JSONL messages the child
   process emits) and `AgentSessionEvent` (the in-process event stream) are
   **not the same shape**. Nothing in pi's public surface promises 1:1
   parity; the CLI's rpc-mode module does its own translation
   (`runRpcMode(runtimeHost)`), which Bobbit does not reuse today.

None of these are "pi is CLI-only" or "pi calls `process.exit()`" — pi
genuinely supports in-process embedding. The blockers are all on Bobbit's
side: the sandbox/containment model and the child-PID-shaped persistence
model, both of which only matter for the **code-executing** class of
session, not the **read-only** class.

## Measurements

All measurements below are **newly run for this spike**, N=10, on this host
(Apple Silicon, Node v26.0.0), directly against the real installed pi CLI —
no mock, no API keys needed (neither `get_state` nor `AgentSession`
construction calls a model). Reproducible via
`scripts/bench-in-process-bridge-spike.mjs` (added in this PR).

### 1. Spawn-to-ready

| Path | Method | Median (ms) |
|---|---|---|
| Child process (today) | spawn `pi --mode rpc` → first `get_state` response | **407.8** (clean run) / **2794** (2nd run, host under heavy load — `uptime` showed load average ~51 on this box mid-run) |
| In-process, cold (module graph not yet loaded) | first `createAgentSession()` call in a fresh process | **138–572** (one-time cost, paid once per gateway lifetime, not per session) |
| In-process, warm (module graph already loaded) | subsequent `createAgentSession()` calls in the same process | **2.4–4.9** |

The absolute child-process numbers vary a lot with host load (this dev box
runs 100+ concurrent worktrees/agents; `uptime` load average swung from ~28
to ~51 between runs) — but the **ratio** is stable and large across both
runs: warm in-process construction is **~170×–570× faster** than a child
spawn. The qualitative conclusion does not depend on which run you use.

This matches the prior analysis's estimate (they measured child spawn at
340–420ms depending on flags/extensions) and confirms its central claim:
almost all of the ~400ms is Node + pi's **module graph load**
(provider SDKs, HTTP dispatcher, etc.), which in-process is paid **once at
gateway boot**, not once per agent. Extension loading itself is cheap
(disk-cached jiti transpile, ~5ms for 2 extensions per the prior analysis).

### 2. Steady-state RPC round trip

| Path | Method | Median (ms) |
|---|---|---|
| Child process (today) | repeated `get_state` over stdio, warm connection | **0.13–0.22** |
| In-process | repeated `session.state` / `session.messages` property read | **0.0004–0.0009** |

Both are already sub-millisecond for an empty/small session — `get_state`
doesn't ship the transcript. **This spike did not reproduce the
transcript-size-scaling serialization tax** the prior analysis cites for
`get_messages()` (which ships the *entire* transcript as JSON every call,
`rpc-bridge.ts:641-645`, then gets re-`JSON.stringify`'d again to broadcast
in `session-manager.ts`). That cost is real (confirmed in git history: the
`perf/snapshot-server-timing` branch explicitly instruments
`get_messages` snapshot cost) but scales with transcript length, which a
synthetic empty-session benchmark doesn't exercise — flagged as a follow-up
measurement, not fabricated here.

**Bottom line: the win is almost entirely in spawn latency, not steady-state
RPC.** For an agent that lives for one prompt (a verifier/classifier/reviewer),
removing ~400ms of spawn cost dominates; for a long-lived session doing many
turns, the per-call RPC tax is small unless the transcript grows large.

## Prototype (behind `BOBBIT_INPROC_BRIDGE=1`, default OFF)

Landed in this PR, restricted hard to the class of session the analysis
above says is safe:

- **`src/server/agent/in-process-bridge-eligibility.ts`** — pure,
  dependency-free eligibility check:
  `BOBBIT_INPROC_BRIDGE === "1" && readOnly && !sandboxed && !containerId`.
  The env check runs first and short-circuits, so this function — and by
  extension `createSessionBridge` — is a **true no-op when the flag is
  unset**. This file deliberately has zero import of the pi SDK so checking
  eligibility never pulls pi's module graph into the gateway's static
  import graph.
- **`src/server/agent/in-process-bridge.ts`** — `InProcessBridge implements
  IRpcBridge`, wrapping `createAgentSession({ customTools:
  createReadOnlyTools(cwd), noTools: "all", … })`. Real, file-backed
  `AuthStorage`/`ModelRegistry` pointed at `globalAgentDir()` (the same
  config the child process already reads via `PI_CODING_AGENT_DIR`), so — if
  ever exercised for real in a running gateway — it can complete real
  prompts against whatever credentials are already configured, not just a
  construction-time demo.
- **`src/server/agent/session-runtime.ts`** — `createSessionBridge()` now
  checks `isInProcessBridgeEligible()` and, only when true, returns a
  `LazyInProcessBridge` that dynamically `import()`s `in-process-bridge.ts`
  on first `start()` (mirroring the existing `LazyClaudeCodeBridge` idiom in
  the same file) — so the pi SDK's runtime module graph is loaded lazily,
  once, only for an eligible session that actually starts.
- **`tests/in-process-bridge-spike.test.ts`** — pins:
  1. flag unset → `createSessionBridge` always returns `RpcBridge`
     (byte-identical to pre-spike), for every combination of options;
  2. flag on but `sandboxed`, or bound to a `containerId`, or not
     `readOnly` → still `RpcBridge` (code-executing/sandboxed agents can
     never route in-process, even with the flag on);
  3. flag on + `readOnly` + not sandboxed → routes away from `RpcBridge`.
- **`scripts/bench-in-process-bridge-spike.mjs`** — the exact benchmark
  behind the numbers above, runnable standalone (no gateway, no API keys,
  no Docker).

**What the prototype explicitly does NOT attempt** (spike scope, not
migration scope — see "HARD SCOPE LIMITS" comment at the top of
`in-process-bridge.ts`):
- Event-shape translation from `AgentSessionEvent` to the RPC wire JSONL
  shape. Events are forwarded as-is; only `getState`/`getMessages`/the
  `prompt` ack are shaped to match `RpcBridge`'s response envelope.
- Transcript persistence / restart re-attach (`SessionManager.inMemory()` —
  in-process state dies with the gateway process).
- Any tool surface beyond the hard-pinned read-only bundle.
- Wiring a full end-to-end real-prompt latency measurement (would need a
  configured API key + a running gateway; out of the time box for this
  spike — the spawn/steady-state measurements above use the same
  no-network methodology the prior analysis used).

## Migration risk list (for anyone tempted to extend this beyond the spike)

- **Loss of crash isolation.** A pi child crash/OOM today rejects only that
  session's pending calls and fires `process_exit`
  (`rpc-bridge.ts:507-532`) without touching the gateway. In-process, an
  uncaught throw/OOM/infinite loop in agent or tool code can take down the
  gateway and every session on it. The prototype catches `session.prompt()`
  rejections defensively, but that is not the same guarantee as OS process
  isolation.
- **Loss of the Docker sandbox / untrusted-code containment.** This is the
  hard line: Bobbit runs agent-generated code via bash/edit/write inside a
  per-project container with a per-session capability secret injected via
  `docker exec -e` (never in `/proc/1/environ`,
  `rpc-bridge.ts:677-682`). In-process on the host, code-exec tools escape
  that boundary entirely. **Do not** relax the eligibility check to include
  `createCodingTools()` or any bash/edit/write allowlist without solving
  this first — and solving it (e.g. routing an in-process agent's tool
  calls back through `docker exec`) reintroduces the per-call latency this
  spike is trying to remove, tangling the sandbox back in.
- **Loss of per-agent OS resource limits.** No cgroup/container CPU/mem cap
  on an in-process agent; a runaway agent competes directly with the
  gateway event loop.
- **Parallel-safety.** N child processes are trivially parallel across
  cores; N in-process agents share one event loop. CPU-bound tool/transcript
  work would need explicit offload to worker threads to avoid contending
  with the gateway's own request handling.
- **Restart re-attach / `bash_bg` persistence do not apply.** The
  child-PID model is exactly what lets sessions and `bash_bg` processes
  survive a gateway restart (`bg-process-{manager,store,runner}.ts`). An
  in-process session's live state dies with the gateway; only a written
  JSONL transcript would survive, meaning rehydration (rebuild from
  transcript) rather than re-attach (resume the live process) — a
  materially different recovery model that the prototype does not
  implement (`SessionManager.inMemory()`, no on-disk transcript at all).
- **Sandbox mounts.** Not applicable to the eligible class (in-process is
  gated to `!sandboxed`), but worth stating explicitly: nothing about this
  spike touches or reduces the sandbox mount surface for code-executing
  agents. They are entirely unaffected — which is the point.

## Recommendation: narrow go

**Ship the flagged prototype as spike infrastructure, do not widen scope
without a follow-up design pass.** The read-only tool bundle
(`createReadOnlyTools` = read/grep/find/ls, no exec) has nothing to contain,
so it is the one class of session where "no sandbox, no child PID" is not a
regression — it is just a fact about that class of work. Code-executing and
team-lead agents must stay exactly as they are today: out-of-process, in the
Docker sandbox, with restart re-attach intact.

Staged path if this goes beyond spike:

1. **Instrument first.** Turn on `BOBBIT_E2E_PROFILE=1` around
   `executePlan.spawnAgent`/`postSpawn` in prod-like runs to confirm the
   ~400–700ms spawn split by session class, and count how many real
   sessions are read-only/verifier/classifier — this sizes the actual prize
   before investing further.
2. **Event-shape parity** would need to be solved for real (not just
   forwarded as-is) before any UI/session-manager code could safely consume
   an in-process session's events the same way it consumes RPC events today.
3. **Transcript persistence** for the read-only-eligible class specifically
   — even without restart re-attach, an in-process session should still
   write a real on-disk transcript so a gateway crash doesn't silently lose
   a reviewer's output.
4. Keep the sandboxed/code-exec path untouched, permanently — this is not a
   staging step, it is a hard constraint (see Risks above).

**Alternative / complement worth flagging:** a **warm pool of pre-spawned pi
processes** (pre-`docker exec` a few idle `--mode rpc` processes per
project) would cut spin-up for the *code-executing* majority without giving
up isolation, restart re-attach, or the sandbox at all. It composes with
this spike rather than competing with it: warm pool for coding agents,
in-process for read-only agents.

## Confidence

- pi's in-process embedding SDK exists and is usable as described: **high**
  (read the shipped `.d.ts` files directly; built and ran a working
  prototype against them in this repo).
- Spawn latency ratio (in-process warm ≪ child spawn): **high** (measured
  directly, real pi binary, two independent runs under different host load
  both showing the same large ratio).
- Steady-state RPC tax at realistic transcript sizes: **not measured in
  this spike** — the empty-session numbers above are real but do not
  exercise the transcript-size-dependent cost the prior analysis flags.
  Medium confidence that it matters for long sessions; low confidence on
  the exact magnitude without a follow-up measurement.
- Migration risk list: **high** — these are architectural facts about the
  current sandbox/restart model, not estimates.

## Sizing results (2026-07-05)

Step 1 of the staged path above ("Instrument first"), executed as its own
lane. Instrumentation added behind the existing `BOBBIT_E2E_PROFILE` flag
(zero behavior change when unset — see `profiling.ts`): `executePlan`'s and
`executeWorktreeAsync`'s spawn/postSpawn timers are now labeled by session
class (`readOnly` / `exec` / `sandboxed`, computed by the new
`spawnSessionClass()` in `session-setup.ts`, mirroring but not importing
`isInProcessBridgeEligible`'s three-way split), and the pre-idle
`persistSessionMetadata` call — previously unmeasured — is timed separately
from `spawnAgent.rpcStart`. Measured against a real, isolated gateway
(`dist/server/cli.js`, real `pi-coding-agent` child processes, real
Gemini-backed model binding via `GEMINI_API_KEY`, real Docker for the
sandboxed class) in a scratch project, not the synthetic
`bench-in-process-bridge-spike.mjs` harness — this is what the recommendation
called "prod-like": full tool/extension loading, full model-selection
handshake, real REST API surface, as opposed to the spike's deliberately
stripped `--no-builtin-tools --no-context-files --no-approve` benchmark.

### (a) Spawn split by session class

| Phase | readOnly (N=3) | exec (N=3) | sandboxed (N=1, successful run) |
|---|---|---|---|
| `spawnAgent.rpcStart` (child spawn + ready handshake) | 100.9–101.3ms | 101.1–101.8ms | 103–106ms |
| `persistSessionMetadata` (first real `getState()` RPC) | 526–1411ms | 542–1443ms | ~780ms (derived) / 3938ms (failed run, see caveat) |
| **Total spawn-to-persist window** | **627–1512ms** | **643–1545ms** | **886.6ms** (clean run) |

Two findings, both different from what the spike's synthetic bench implied:

1. **The bare child-process spawn (`rpcClient.start()`) is cheap and
   class-independent**: ~100–106ms across all three classes on this host
   right now, well under the spike's isolated 400ms/2794ms figures (this
   host's OS file-cache for `node_modules` is warm after repeated spawns in
   the same session — the spike's own numbers already flagged high host-load
   sensitivity, e.g. its 2nd run at load average ~51). readOnly and exec pay
   statistically the same `rpcStart` cost, confirming today's per-session
   spawn tax does **not** already discriminate by class — it is paid
   identically by the class the bridge would help and the class it can't
   touch.
2. **The dominant, previously-unmeasured cost is `persistSessionMetadata`'s
   `getState()` round trip** (500ms–1.5s, noisy under host load, same
   order of magnitude as the *entire* spike's headline spawn number) — not
   the bare spawn. This call happens after the child process has started but
   is still finishing its own real work: loading the full builtin/extension
   tool graph (185–376 tool definitions in these runs, vs. the bench
   script's explicit `--no-builtin-tools`), resolving MCP servers, and (via
   `tryAutoSelectModel` in `postSpawn`, called right after) a live
   model-provider handshake. The spike's synthetic bench isolated the bare
   spawn specifically by disabling all of this — so its 400–700ms estimate is
   a **lower bound on the real production tax**, not the full number. Real
   spawn-to-idle for a host-side (non-sandboxed) session is closer to
   **0.6–1.5s** end to end on this host.
   - This matters for the prize calculus in both directions: it's a **bigger
     prize** than scoped (more real latency to remove), but only insofar as
     the in-process path also avoids re-doing this same
     tool/extension-loading work per session — which the prototype already
     does, structurally, for the read-only class: `createReadOnlyTools()` is
     passed as `customTools` directly (in-memory function calls), never going
     through the file-system-based extension-discovery pipeline that a
     spawned child process re-walks on every single spawn.

**Sandboxed class caveat**: N=1 successful sample only. A second and third
attempt in this ad hoc scratch-project setup **reproducibly failed**
during `persistSessionMetadata`'s retries with `Extension path does not
exist: /tools-builtin/<name>/extension.ts` inside the container, i.e. the
`-v <builtinToolsDir>:/tools-builtin:ro` bind mount (`docker-args.ts:228`)
did not resolve inside the container for this scratch project/worktree
layout, crashing the freshly-`docker exec`'d pi process (`rpc-bridge.ts`
logged `Agent process exited (code 1)` then `Agent process not running`,
exhausting `persistSessionMetadata`'s 4 retries at 500/1000/2000ms delays —
hence the 3.9s outlier in the table, which is a retry-storm artifact, not a
latency number, and is excluded from the headline range). This was not
chased to root cause (out of this lane's time box) but is itself a relevant,
independent data point: **Docker-sandboxed spawn has its own operational
fragility mode** (mount resolution) on top of whatever latency it adds, which
is a cost/risk the read-only, non-sandboxed in-process class structurally
cannot have (no mount, no container). The one clean sandboxed run
(886.6ms total, 106ms `rpcStart`) sits inside the same range as host-side
sessions — i.e. once a project's container is already warm (this measured
`docker exec` into an existing long-lived per-project container, not
`docker run` cold start), Docker's own per-session overhead is not the
dominant term either; the same `persistSessionMetadata` tool/model-handshake
cost dominates there too.

**Caveat applying to all of the above**: N=1–3 per class, one host, one
session in time — the spike doc's own numbers moved by 7x between two runs
under different load. Treat the *shape* (rpcStart flat and small;
persistSessionMetadata large, noisy, and class-independent) as the finding,
not the exact milliseconds.

### (b) Fraction of real sessions in the in-process-eligible class

Static census (method: `grep`/read over `defaults/roles/*.yaml`,
`market-packs/`, `verification-harness.ts` spawn call sites — no log
mining; no `sessions.json` trace was available on this host to sample
live data, so this is code-only). Full detail from the census pass:

- Of 16 built-in + market-pack roles surveyed, **7 are read-only in tool
  policy** (no `edit`, no `bash`, `bash_bg: never`): `code-reviewer`,
  `bug-hunter`, `security-reviewer`, `architect`, `spec-auditor`,
  `reviewer`, and the market-pack `pr-reviewer`
  (`market-packs/pr-walkthrough/roles/pr-reviewer.yaml`) — i.e. **~44% of
  role types are shaped like the eligible class**.
- But eligibility (`isInProcessBridgeEligible`) doesn't key off role tool
  policy — it keys off the session-level `readOnly` flag set **at spawn
  time**, and **only one call site in the whole repo sets it**:
  `market-packs/pr-walkthrough/lib/routes.mjs:1364-1365`
  (`launchReviewer` → `spawnReviewerWithRetry(ctx, { role: "pr-reviewer",
  readOnly: true, ... })`), one fresh reviewer per PR/changeset walkthrough,
  always-fresh (no reuse).
- The higher-volume reviewer fan-out — `verification-harness.ts`'s
  `llm-review`/`agent-qa` gate reviewers (~3–4 concurrent reviewer/QA
  sessions per gate-verify phase, per the "3-4 concurrent reviewers" comment
  at `verification-harness.ts:3621-3625`, called from
  `verification-harness.ts:4452` and `:4822`) — **never sets `readOnly`**,
  even though these roles are read-only in spirit. `buildVerificationReviewerMeta`
  (`verification-reviewer-meta.ts:50-62`) stamps `role`/`teamGoalId`/
  `accessory`/`nonInteractive` but not `readOnly`.

**This is the load-bearing finding of the census**: today, the
flag-gated eligible population is **effectively zero** in the highest-volume
fan-out (gate-check reviewers) despite roughly half of role types being
tool-policy read-only. The gap is not "not enough read-only work exists" —
it's that **eligibility isn't derived from the thing that actually
determines safety** (the role's resolved tool bundle), it's derived from an
opt-in flag that's wired up in exactly one (lower-volume, per-PR-walkthrough)
code path. Sizing "how many sessions would benefit" therefore has two very
different answers depending on which number you use:
- **As coded today**: ~0% of gate-check volume, 100% of PR-walkthrough-reviewer volume.
- **As tool-policy would allow** (if eligibility were derived from the
  resolved allowlist instead of a caller-supplied flag): the 3–4
  llm-review/agent-qa reviewers per gate-verify phase would also qualify,
  which is most of the *reviewer-class* session volume in the repo's own
  verification pipeline — a materially larger prize than the flag-based
  count suggests, but contingent on a real (not scoped in this lane) change
  to how eligibility is derived.

### (c) RPC tax at realistic transcript sizes (the spike's flagged gap)

Closed with `scripts/bench-rpc-transcript-tax.mjs` (new, committed): builds a
real pi `--session <path>` JSONL transcript (pi's actual on-disk wire format,
reverse-engineered from a real `pi --print` run — `{type:"session",...}`
header then one `{type:"message", id, parentId, timestamp, message:{role,
content,...}}` per turn), spawns a real `pi --mode rpc` child pointed at it,
and measures 8 warm `get_messages` round trips at 3 transcript sizes (no API
key needed — same no-network methodology as the original spike bench):

| Messages | Transcript file | `get_messages` response | Median RPC round trip |
|---|---|---|---|
| 50 | 26 KB | 21 KB | 0.17ms |
| 500 | 259 KB | 210 KB | 0.85ms |
| 2,000 | 1.0 MB | 841 KB | 2.73ms |

40x more messages → 15.6x more time (sub-linear — fixed per-call overhead
amortizes as size grows). **This confirms the spike's flagged
transcript-size-scaling tax is real** (the empty-session `get_state` numbers
in the spike were not exercising it) **but it stays small in absolute terms**
— 2.7ms at 2000 messages / ~840KB, three orders of magnitude below the
0.6–1.5s spawn-to-idle tax measured in (a). Bobbit's own `session-manager.ts`
re-`JSON.stringify`s the response again before broadcasting to WS clients
(not separately measured here — estimate, not measured: roughly one more
pass of the same curve, so plausibly ~5ms total serialization tax at 2000
messages, still small). **Steady-state RPC tax is not the bottleneck this
lane should optimize for, at any transcript size tested.**

### Go/no-go recommendation for step-2 productionization

**Narrow go, but re-scope step 2 before investing**: the numbers change
*why* the in-process bridge would be worth productionizing, not *whether*.

- The prize is **larger than the spike estimated** on latency alone
  (0.6–1.5s real spawn-to-idle, not 400–700ms) but **smaller than it could
  be** on population, because eligibility today is wired to an opt-in flag
  almost nothing sets, not to the tool-policy signal that actually
  determines safety. **Fix the eligibility signal first** (derive
  `readOnly`-equivalence from the resolved tool allowlist — no `edit`/`bash`/
  `bash_bg` reachable — rather than requiring every caller to remember to
  pass `readOnly: true`) before or as part of step 2; otherwise
  productionizing the bridge ships a fast path almost nothing routes through
  in practice, since the current callers of the review-shaped roles
  (`verification-harness.ts`) don't set the flag.
- Steady-state RPC tax ((c)) is confirmed real but **does not change the
  recommendation** — it's too small relative to the spawn tax to be worth
  designing around at this stage, at any transcript size tested here.
- **Warm-pool comparison**: the doc's "alternative/complement" — a warm pool
  of pre-spawned `--mode rpc` processes per project — remains a live
  alternative for the **code-exec majority** specifically because this
  lane's numbers show the tool/extension-loading cost inside
  `persistSessionMetadata`/`postSpawn` (not just the bare process spawn) is
  most of the real tax, and a warm pool amortizes that loading cost across
  many sessions without needing to solve sandbox containment in-process.
  It does **not** compete with the in-process bridge for the read-only class:
  a warm-pooled *sandboxed* process still pays Docker's own overhead
  (measured here as small once warm, but with the separate mount-fragility
  failure mode above) and still can't skip the file-system extension-walk
  the way `createReadOnlyTools()`'s direct `customTools` injection already
  does. Recommendation: pursue **both**, not either/or — warm pool for the
  code-exec/sandboxed majority, in-process (with the eligibility-signal fix
  above) for the read-only minority-by-flag/majority-by-tool-policy class.
- Steps 2–4 of the original staged path (event-shape parity, transcript
  persistence, keep sandboxed path untouched) are unaffected by this lane's
  findings and remain the right next steps once the eligibility-signal gap
  above is addressed.
