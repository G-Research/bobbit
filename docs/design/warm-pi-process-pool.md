# Warm pi process pool — design spike

**Status**: design spike, no production code changed. This document is the
deliverable.

`docs/design/in-process-bridge-spike.md`'s recommendation section names a
"warm pool of pre-spawned pi processes" as the complement to its in-process
bridge for the **code-executing majority** of sessions — the classes
(`sandboxed`, `exec`) that must stay out-of-process for containment reasons
the in-process spike lays out in detail (Docker sandbox, crash isolation,
per-agent resource limits). PR #157 (sizing lane) then measured the actual
cost this pool would amortize: spawn-to-idle is **0.6–1.5s**, dominated not
by the bare `spawn()` call (~100ms, class-independent) but by
`persistSessionMetadata`'s first `getState()` RPC after the full tool/
extension graph loads inside the child. This doc designs the pool PR #157's
own recommendation called for, sized against those numbers.

All line numbers below were verified live against `src/server/agent/` in
this worktree (`fable/d6-design-spikes`, based on `origin/aj-current`) on
2026-07-05 — grep and read, not recalled.

---

## 1. What PR #157 actually measured (the numbers this design is sized against)

From PR #157's own body (`gh pr view 157`) and
`docs/design/in-process-bridge-spike.md`'s "Sizing results" section it
appended:

1. **Spawn split by class**: bare `spawn()`/`rpcClient.start()` ≈ 100ms,
   **class-independent** (sandboxed/readOnly/exec all pay roughly the
   same). The dominant, *class-independent* cost is
   `persistSessionMetadata`'s first `getState()` RPC, which only resolves
   after pi's full tool/extension graph has loaded inside the child —
   **0.6–1.5s**, materially bigger than the original in-process spike's
   400–700ms estimate (which used `--no-builtin-tools` and therefore
   skipped the extension-graph load a real session pays for). One clean
   sandboxed sample came in at 886.6ms; two other sandboxed attempts hit
   **reproducible Docker-mount fragility failures**, reported as a
   separate finding and explicitly *not* folded into the latency number —
   i.e., the 0.6–1.5s figure is itself an optimistic floor for the
   sandboxed class on a flaky day.
2. **Census**: of 16 built-in + market-pack roles, 7 (~44%) are read-only
   by tool policy, but the in-process bridge's eligibility check
   (`src/server/agent/in-process-bridge-eligibility.ts:28`) keys off a
   session-level `readOnly` **flag** that today only one call site sets
   (`market-packs/pr-walkthrough`, one reviewer per PR). The higher-volume
   `verification-harness.ts` reviewer fan-out (~3–4 sessions per
   gate-verify phase) never sets that flag despite being read-only in
   spirit.
3. **RPC tax at transcript size**: real but three orders of magnitude below
   the spawn tax at every size tested (0.17ms @ 50 messages → 2.73ms @
   2000 messages) — confirms the win, if there is one, is entirely in
   **spawn latency**, not steady-state RPC.

PR #157's own recommendation: *"pursue the warm-pool alternative for the
code-exec majority in parallel with, not instead of, in-process for the
read-only class — the two don't compete for the same population."* This
doc is that pursuit.

### 1.1 Sizing the prize

`spawnSessionClass()` (`session-setup.ts:1575`) partitions every session
into exactly `sandboxed | readOnly | exec` — mutually exclusive, so
"code-exec majority" = `sandboxed + exec`, everything the in-process spike
does *not* touch. PR #157's census (point 2 above) implies that today
essentially 0% of the `sandboxed`/`exec` population is eligible for the
in-process path even after the eligibility-signal fix that PR proposes
(deriving eligibility from the resolved tool allowlist would move some
`exec`-labeled-by-flag sessions into `readOnly`, but anything sandboxed
stays out-of-process by hard design constraint regardless of tool policy —
see in-process-bridge-spike.md's "hard line" on containment).

Per-spawn saving at target (skip the 0.6–1.5s tool/extension-graph load,
not the ~100ms process fork): **call it ~0.8–1.4s per warm-pool hit**,
using the low end of the range as the conservative planning number and
the high end as the sandboxed-class number (which the mount-fragility
caveat above says may still be optimistic).

Spawn-frequency inputs available today, all from evidence already
gathered by the in-process-bridge/sizing lanes, not fabricated for this
doc:
- **Reviewer fan-out**: ~3–4 sessions per gate-verify phase
  (in-process-bridge-spike.md, PR #157 census point 2) — every gate run on
  every PR pays this, and per VER-04 (RECONCILIATION-2026-07-05.md #50)
  most goals still run the fuller verification path, not `solo-fast`.
- **Team/delegate spawns**: `OrchestrationCore`'s entire purpose
  (`orchestration-core.ts`) is spawning child sessions for delegate/team/
  PR-walkthrough work — an unbounded-but-nonzero per-goal count with no
  single measured average in the fable-refactor bundle; flagged here as
  **not sized**, not assumed zero.
- **One inescapable per-goal cost**: at minimum 1 main coding session per
  goal (`exec` or `sandboxed`), independent of review fan-out.

Putting only the two measured numbers together: a goal that runs the full
gate (1 main session + ~3–4 reviewer spawns, conservatively treating
reviewers as `exec`/`sandboxed` today since PR #157's census point 2 says
the eligibility flag basically never routes them to in-process) pays
**roughly 4–5 × 0.8–1.4s ≈ 3.2–7s of avoidable spawn-side latency per gate
run**, before counting orchestration-spawned children at all. This is the
number a warm pool amortizes; it does not include wall-clock time saved on
the critical path specifically (spawns for independent reviewers may
already run concurrently, in which case the win is per-reviewer latency,
not summed gate latency) — sizing the wall-clock-critical-path fraction of
this is flagged as a measurement gap in §7, not assumed here.

---

## 2. What can be pre-warmed generically vs. what is session-specific

This is the load-bearing question, and it has a sharp, evidence-backed
answer: **almost nothing about a spawned pi process is reusable across an
arbitrary future session.** Everything that matters is fixed at spawn time
via either a `spawn()`/`docker exec` option or a CLI flag, and pi's RPC
protocol has **no command to change any of it after the fact**.

### 2.1 Fixed at spawn, never changeable via RPC (confirmed by reading `rpc-types.d.ts`)

`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`
enumerates the full `RpcCommand` union — 27 command types. None of them is
`set_cwd`, `set_extensions`, `set_system_prompt`, or `set_tools`. Cross-
referenced against how each of those is actually set:

- **`cwd`** — a literal `spawn()` option for direct sessions
  (`rpc-bridge.ts:492`, `cwd: this.options.cwd`) or a `docker exec -w
  <cwd>` flag for sandboxed sessions (`rpc-bridge.ts:786`, with an explicit
  comment: *"The agent CLI (pi) uses `process.cwd()` — not `--cwd` — to
  determine the working directory... docker exec defaults to the
  container's WORKDIR"*). Both are OS/container-process construction-time
  parameters. There is no RPC command to relocate a running process's
  cwd.
- **Tool/extension set** — `--extension <path>` flags, one per loaded
  extension (`rpc-bridge.ts:398,404`, plus role-specific extensions added
  by `buildToolActivationArgs`/`resolveToolActivation`), and
  `--no-builtin-tools`/`--no-extensions` policy flags
  (`rpc-bridge.ts:384-406`). All CLI args, baked in before the process
  starts reading stdin.
- **System prompt path** — `--system-prompt <path>`
  (`rpc-bridge.ts:301`), also a spawn-time CLI arg.
- **Sandbox/container binding** — `containerId` selects `spawnDockerExec`
  vs. the direct `spawn()` path entirely (`rpc-bridge.ts:479-482`); a
  process spawned into one container cannot be moved to another or
  "un-sandboxed" later.

### 2.2 Changeable post-spawn via RPC (also confirmed from `rpc-types.d.ts`)

- **`switch_session`** (`{ type: "switch_session", sessionPath }`) — loads
  a *different* transcript into the *same* running process.
  `session-manager.ts` already uses this today for its own restore/
  role-reassign/force-abort paths (5680, 7613, 8592) — it is the existing,
  load-bearing mechanism for "rebind a live process to different session
  content," not something this design would invent.
- **`set_model`** / **`set_thinking_level`** — change the model/thinking
  level of an already-running process (`rpc-bridge.ts:698,702` already
  wrap these).
- Session naming, steering/follow-up mode, auto-compaction/auto-retry
  toggles — all runtime-mutable, none of them relevant to pool eligibility.

### 2.3 What this means for pool key design

A warm-pool entry is only a valid match for an incoming session request if
**cwd, extension/tool set, system-prompt path, and sandbox/container
binding all already match** — `switch_session` + `set_model` +
`set_thinking_level` cover everything else. Concretely, the pool must be
keyed on the tuple:

```
(projectId, cwd, sandboxed?, containerId-if-sandboxed, extensionSetHash)
```

where `extensionSetHash` is a hash of the resolved `--extension` list
`buildToolActivationArgs`/`resolveToolActivation` would have produced for
this role — i.e., effectively **(project, worktree, role-shape)**. This is
structurally identical to how `WorktreePool` (§3) is already keyed **per
project**, one level coarser than this doc needs (role-shape adds a
dimension `WorktreePool` doesn't have, because a worktree has no notion of
"tool policy").

**Consequence for hit rate**: a pool cannot be one generic bucket of idle
processes handed out to whichever session needs one next, the way the
in-process bridge's read-only tool bundle is generic across every eligible
session. It is closer to N small per-(project, role-shape) pools. This
caps the realistic pool size and hit rate — worth stating plainly before
any implementation estimate, since it's the single biggest way this
design could be over-sold.

### 2.4 System-prompt path is a soft exception, worth flagging

`--system-prompt <path>` is spawn-time-fixed, but prompt *content*
delivered as the first `prompt` RPC command is not the same mechanism —
sessions that don't rely on `--system-prompt` (i.e., that deliver their
role/system context via the first prompt message instead) would not need
this dimension in the pool key at all. Whether any current session-setup
path already does this is not established here — flagged as a check to
make during implementation (§8), not assumed.

---

## 3. Pool lifecycle — the `WorktreePool` pattern as prior art

`src/server/agent/worktree-pool.ts`'s `WorktreePool` class is the closest
existing precedent in this codebase for "maintain a small ready-to-claim
buffer of expensive-to-create resources, refill in the background,
fall back to the cold path when empty." Its shape, read directly
(`worktree-pool.ts:236-337` and the `drain()`/`getStatus()` methods):

- **Ownership**: one `WorktreePool` instance per project, held by
  `SessionManager.worktreePools: Map<projectId, WorktreePool>`
  (per `session-manager-decomposition.md`'s field inventory, §1.1).
- **Fill**: `startFilling(activeWorktreePaths?)` kicks off a background
  fill to `targetSize` (default 2); a private `_fill()` (re-)tops up the
  pool asynchronously and is also invoked after every `claim()`.
- **Claim**: `claim(targetBranch)` is the **only** claim entry point;
  renames the pool entry's branch + moves its directory to the final path
  **synchronously** before returning, then triggers a background
  replenish. On failure, returns `null` and the caller falls back to the
  normal `createWorktree()` path — the pool is a pure optimization, never
  a hard dependency.
- **Status introspection**: `getStatus()` returns `{ enabled, ready,
  target, filling }` — a small, UI/diagnostics-friendly shape.
- **Shutdown**: `drain()` tears down unclaimed pool entries.
- **Config plumbing**: `componentsResolver`/`baseRefResolver`/
  `setupTimeoutResolver` are all **live resolver callbacks**, re-read on
  every fill — so a project-config edit takes effect on the next fill
  without a gateway restart. Directly reusable idiom for "pool size /
  policy is config, not a constructor-time snapshot."

A `PiProcessPool` should mirror this shape almost exactly:

```ts
class PiProcessPool {
  // keyed by the (project, cwd, sandboxed, containerId, extensionSetHash)
  // tuple from §2.3 — one internal Map<poolKey, PoolEntry[]>, not one
  // pool per project the way WorktreePool is (WorktreePool doesn't need
  // the role-shape dimension; this does).
  private pools = new Map<string, PoolEntry[]>();

  startFilling(key: PoolKey): void { /* background-fill this key to target size */ }
  async claim(key: PoolKey): Promise<ClaimedProcess | null> {
    // pop a ready entry, issue switch_session + set_model/set_thinking_level,
    // trigger background refill, return it — or null on miss, caller falls
    // back to the existing cold RpcBridge.start() path unchanged.
  }
  getStatus(key?: PoolKey): { enabled, ready, target, filling }[] { /* ... */ }
  async drain(): Promise<void> { /* SIGTERM every unclaimed pooled process */ }
}
```

**`claim()` returning `null` on a miss and falling back to the existing
cold path is the single most important design property to preserve** —
it's what makes this a pure optimization layer with no new failure mode
for the majority-cold-miss steady state, exactly like `WorktreePool`'s own
stated fallback discipline.

### 3.1 What a pool entry actually is

Not a bare child process — a `RpcBridge` instance that has completed
`start()` and is sitting idle at `get_state`-ready, **with an empty or
placeholder session** (no `switch_session` issued yet). Claim then issues:
1. `switch_session { sessionPath }` (if the claiming session has an
   existing transcript to resume) — or nothing, if this is a brand-new
   session and the process's own freshly-created empty session is fine
   as-is (pi creates the JSONL lazily on first write per
   `session-manager.ts:5213`'s comment on lazy `openSync(file, "wx")`
   creation — a pool entry that's never had `switch_session` called on it
   is indistinguishable from a session that hasn't written yet).
2. `set_model`/`set_thinking_level` if the claiming session's model
   differs from whatever the pool entry was spawned with.
3. Immediate handoff — the caller gets a live `IRpcBridge`-shaped object
   exactly as if `createSessionBridge(...).start()` had just resolved.

---

## 4. Staleness / recycling policy

Three independent staleness sources, each needing its own check:

1. **pi version bump.** A pool entry spawned against
   `node_modules/@earendil-works/pi-coding-agent`'s CLI at fill-time is
   pinned to that install. If `npm install`/a deploy swaps the package
   underneath a long-idle pool, every existing entry is running stale
   code. Fix: pool entries carry a `piVersion` (read once at spawn from
   the resolved package, cheap) and `claim()`/background health checks
   discard (SIGTERM, don't reuse) any entry whose `piVersion` doesn't
   match the currently-resolved package version. Cheapest correct
   check: compare against the same version resolution `findAgentCli()`
   (`rpc-bridge.ts`) already performs for every cold spawn — no new
   version-detection logic needed, reuse it.
2. **Config change** (role tool policy, extension list, project
   `worktree_setup_timeout_ms`-style live settings). Mirror
   `WorktreePool`'s `componentsResolver` idiom (§3): the pool key itself
   (§2.3) already encodes the resolved extension set as a hash, so a
   config change that alters a role's tools produces a **different pool
   key** going forward — old-keyed entries simply age out via TTL (below)
   rather than needing an explicit invalidation signal. This is a real
   advantage of the tuple-keyed design over a single generic pool: config
   changes are naturally isolating, not requiring a flush-everything event.
3. **Idle TTL.** An entry that's sat unclaimed for too long should be
   recycled even with no version/config change — a resident pi process
   holds open file descriptors, loaded provider SDKs, and (per the
   in-process spike's own numbers) a nontrivial in-memory footprint per
   process. Recommend a short TTL (order of minutes, tunable) enforced by
   the same background refill loop that tops up the pool — an entry aged
   past TTL is SIGTERM'd and replaced, not reused, the next time the fill
   loop runs.

**Adaptive pool size.** `WorktreePool`'s `targetSize` is a static
per-project constant (default 2). This pool's natural load signal is
different: track a rolling claim-rate per pool key and grow/shrink
`targetSize` toward it (e.g., target ≈ recent claims-per-minute × entry
startup time, clamped to a small ceiling per key so N pool keys × M
entries doesn't uncontrollably multiply resident processes — see §6 for
the resource-ceiling risk this creates). This is the one piece of this
design with no direct precedent in `WorktreePool` (which never adapts
`targetSize` from load) — flagged explicitly as new, not copied.

---

## 5. Restart re-attach interaction

This section's likely-assumed premise turns out to be false, which
simplifies the design: **pi child processes are never re-attached across
a gateway restart today, warm pool or not.** Read directly:
`restoreSession()` (session-manager.ts, restore path) always spawns a
**brand-new** `RpcBridge` and calls `switch_session` to reload the
persisted transcript into it — it does not attempt to find or reconnect to
the old child's PID. This is architecturally different from `bash_bg`
processes, which `docs/bg-process-persistence.md` documents as genuinely
re-attached via durable on-disk spool/status files precisely because a
long-running shell command's live output needs to survive the gap; a pi
agent's *conversation state* is already fully captured in its on-disk
JSONL transcript, so there's nothing to re-attach to — replay via
`switch_session` against a fresh process is the existing, working design,
not a gap this doc needs to fix.

**Consequence**: a warm pool has **no new restart re-attach obligation.**
The only restart interaction that exists is refill timing: pool entries
are pure in-memory optimization state (idle, un-switch_session'd `RpcBridge`
instances) with no on-disk representation and no reason to have one — on
gateway restart the pool for every key starts empty, exactly like
`WorktreePool` does today (confirmed: `WorktreePool` has no persisted
pool-entry state either, only `startFilling()` called fresh at boot).
`SessionManager.restoreSessions()` already runs before the pool would have
had time to fill (`server.listen()` happens after `restoreSessions()` per
the boot-order evidence in
`docs/design/session-manager-setter-interfaces.md` §4), so **the
mid-restart cold-start window sees zero warm-pool benefit** — the first
wave of sessions restored right after a restart pay full cold-spawn cost
regardless. This is expected and fine (the pool's whole value proposition
is steady-state, not boot-time), but worth stating so nobody designs
around a false assumption that this pool needs to survive restart.

---

## 6. Sandbox interaction — the load-bearing open question

The in-process-bridge-spike doc drew a hard line: code-executing agents
must stay in the Docker sandbox, permanently, not as a staging step. A
warm pool for the `sandboxed` class must respect that line exactly — it
changes *when* the containerized process starts, never *whether* it's
containerized. Two shapes, with real tradeoffs:

**(a) Pre-warm INSIDE an already-running per-project container — confirmed
this is already how sandboxed sessions work today.** `spawnDockerExec`'s
own doc comment (`rpc-bridge.ts:737-738`) states plainly: *"Spawn an agent
process inside an already-running pool container via docker exec. The
container already has all bind mounts and env vars configured."* — and
`remapArgsForContainer`'s comment (`rpc-bridge.ts:807`) confirms *"All
sandbox sessions use pool containers with session-prompts/ mounted."* This
is not a hypothesis to verify at implementation time — it's the existing
design: the container itself is already a long-lived, reused resource
(owned/lifecycle-managed by `sandbox-manager.ts`) independent of any
individual session's pi process; every sandboxed session today is already
just a `docker exec` into a pool container that was already running.
Pre-warming a pi process the same way — an extra idle `docker exec`
sitting inside a container that's already up — adds **no new container
lifecycle at all**, just an extra idle process inside infrastructure that
already exists for exactly this reuse pattern. This is the shape to
prefer, and the fact that containers are already pooled substantially
de-risks sandboxed pooling relative to a naive read of the spike's own
"hard blocker" framing.

**(b) Per-project dedicated pools with their own container lifecycle.**
If pool containers are *not* already durably running (e.g., they spin up
per-session and tear down), pre-warming a pi process would require
pre-warming a **container** first — a much bigger commitment (container
resource ceiling, image pull/startup cost, and exactly the kind of
Docker-mount-timing sensitivity PR #157 already hit in its own
measurement run: *"two reproducible Docker-mount-fragility failures"*).
This shape inherits that fragility directly into the pool's fill loop —
a background fill silently failing on flaky mounts is worse than a
foreground cold-spawn failing loudly on a session a user is actively
waiting on, because nobody is watching the fill loop. **Do not pursue
shape (b) without first root-causing PR #157's mount-fragility finding**
— that finding is a live dependency this design inherits, not a
pre-existing condition it can route around.

**Per-project pools are the right granularity either way** — a
`containerId` is already per-project (or per-worktree, depending on
sandbox-manager's current scoping, to be confirmed against
`sandbox-manager.ts` at implementation time), and §2.3's pool key already
includes it. No new per-project resource-isolation design is needed beyond
what containers already provide.

---

## 7. Failure modes

- **Warm process dies silently while idle in the pool.** A pool entry that
  crashes/OOMs before being claimed must be detected and evicted, not
  handed to the next claimant as if healthy. Cheapest detection: the
  existing `RpcBridge` `process.on("exit", ...)` handler
  (`rpc-bridge.ts`) already fires `process_exit`; the pool's background
  health loop should treat that event as an immediate eviction signal for
  that entry, same discipline `_dispatchSteer`/`forceAbort` already apply
  to live sessions (an exited process is never silently reused).
- **Stale env.** A pool entry spawned with `BOBBIT_GATEWAY_URL`/
  `BOBBIT_TOKEN` (`resolveDirectGatewayEnv`, `rpc-bridge.ts:274`) baked in
  at spawn time is fine as long as the gateway's own URL/token doesn't
  rotate mid-lifetime of a pooled entry — if it does, every already-warm
  entry silently can't call back into the gateway. Mitigate with the same
  TTL discipline as §4's version/config staleness (short TTL bounds the
  blast radius of any env rotation, no new detection logic needed).
- **Pool-key explosion.** §2.3's tuple key means N projects × M
  role-shapes × (sandboxed ? containers : 1) distinct pools. Left
  unbounded, a busy multi-project gateway could end up holding far more
  idle resident pi processes than it ever saves in spawn latency — this
  is the single biggest way this design could become a net resource
  regression instead of a win. Mitigate with a global resident-process
  ceiling (not just a per-key `targetSize`) and prefer evicting
  least-recently-claimed pools first when the ceiling is hit — analogous
  to an LRU cache, not present in `WorktreePool` (which has no global
  cap across projects) and flagged as new design surface, not copied
  precedent.
- **Race between claim and eviction.** A background TTL/version sweep
  could evict an entry the instant before `claim()` pops it. Mitigate by
  making eviction and claim both operate through the same
  mutex-protected pool array mutation (the existing `filling` boolean
  guard in `WorktreePool` is the precedent for "one in-flight mutating
  operation at a time per pool"), not by hoping the race is rare.
- **`switch_session` failure on a warm entry.** `session-manager.ts`
  already treats `switch_session` failure as fatal-to-that-attempt at
  every existing call site (5686, 7617, 8596 all `throw`/log-and-abort on
  `switchResp.error`). A warm-pool claim that fails `switch_session`
  should fall back to the cold path (spawn fresh, no pool), not retry
  against another pool entry blindly — the failure might be
  transcript-specific, not pool-entry-specific, so retrying against a
  second warm entry wouldn't help and would burn it for nothing.

---

## 8. Staged, smallest-first implementation plan

1. **Confirm the one remaining open factual dependency before writing pool
   code**: whether any current role/session path avoids `--system-prompt`
   in favor of first-prompt delivery (§2.4) — this determines whether the
   pool key needs the system-prompt-path dimension for every role or only
   some. (§6a's container-reuse question is already answered by direct
   evidence, not open — see §6.) Pure reading, no code.
2. **Root-cause PR #157's Docker-mount-fragility finding** (§6) if shape
   (b) turns out to be necessary — this is a hard prerequisite for
   sandboxed pooling specifically, not a nice-to-have.
3. **Smallest shippable slice: pool the `exec` class only** (host-level,
   non-sandboxed code-exec agents), skipping the sandbox-container
   question entirely. This is the `WorktreePool`-shaped `PiProcessPool`
   from §3, keyed on `(projectId, cwd, extensionSetHash)` (no
   `containerId` dimension needed yet), with a small fixed `targetSize`
   (start at 1–2 per key, no adaptive sizing yet), a fixed idle TTL (no
   version/config staleness detection beyond the TTL bound), and
   `claim()` returning `null` on any miss (empty pool, version mismatch,
   `switch_session` failure) to fall back to the existing cold path
   byte-identically. No behavior change for any session that doesn't hit
   a live pool entry.
4. **Measure against real traffic**, the same discipline PR #157 itself
   used (`BOBBIT_E2E_PROFILE=1`, real gateway, no synthetic bench) —
   specifically the wall-clock-critical-path question flagged in §1.1 as
   unmeasured: does pooling `exec`-class spawns actually shorten any
   user-visible gate/goal completion time, or does it only shorten
   individually-measured spawn latency that was already off the critical
   path (e.g., because reviewer spawns already run concurrently)? This
   gate decides whether step 5 is worth doing at all.
5. **Extend to `sandboxed`** once step 2's mount-fragility root-cause lands
   favorably — shape (a) is already confirmed viable (§6), so this step is
   gated only on the mount-fragility fix, not on any further design
   question. Add the `containerId` key dimension, reuse the same pool
   implementation.
6. **Adaptive sizing + global resident-process ceiling** (§4, §7) only
   after step 4's measurement shows the fixed-size pool is worth tuning
   further — do not build load-adaptive sizing speculatively ahead of
   real claim-rate data.

Each step is independently shippable and independently revertible; step 3
alone, with `targetSize=1` and a short TTL, is a plausible "smallest
possible PR" that proves the mechanism end-to-end on the least risky class
before any sandbox interaction is attempted.
