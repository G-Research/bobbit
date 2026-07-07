# Gateway-cost feasibility study (task 144a0853)

**Question:** can per-test gateway cost be reduced enough to lift the v2 concurrency
ceiling (currently capped at 3-way per D9) toward 4–5 way?

**TL;DR verdict:** The premise that *"each v2-integration test boots a full real
gateway"* is **incorrect**. The gateway is already a **per-fork singleton** (D3's
"one gateway per worker" — option (a) is already implemented), and the runtime boot
is already lean (~470 ms, with sweeper/aigw/mcp/pool/title all backgrounded or
skipped). The dominant per-fork cost is the **vitest transform+collect of the
src/server graph (~11 s/fork, once)**, and the dominant *run* cost is the **test
work itself (~478 CPU-s/run)** plus **verification-harness command-step process
spawns that the ledger does not count**. Reducing gateway boot (via an esbuild
prebundle) is a real but **modest** win that helps every run; it will **not by
itself** deliver reliable 4–5 way. The bigger lever is the verification command-step
spawns. **Recommendation: keep this in the spin-off goal, and have the spin-off
target verification-spawn reduction first, esbuild prebundle second.**

All numbers below measured on the 24-core dev box (AMD Ryzen AI 9 HX 370), Node 24,
`retries:0`, from this worktree at HEAD, sharing the machine with light load.

---

## 1. Current model — how a gateway is acquired

- Tier-1 integration tests import `test`/`expect` from
  `tests2/integration/_e2e/in-process-harness.ts`, a vitest compat shim. Its
  `gateway` fixture calls `ensureGateway()` → `getGateway()` in
  `tests2/harness/gateway.ts`.
- `getGateway()` is a **module-level singleton** (`bootPromise`). Under vitest
  `pool:"forks"`, `isolate:false` (see `vitest.config.ts`), the module persists
  across files in a fork, so the gateway **boots exactly once per fork** and is
  shared by every integration file that fork runs.
- **Not per-test, not per-file.** Measured: a full `v2-integration` run of **167
  files / 895 tests** produced **6 `[boot] sweeper start` lines = 6 boots** with
  `VITEST_MAX_FORKS=6`. Boots == fork count.
- 166 of 167 integration files use the shared fixture.

Per-test isolation on the shared gateway is handled by `createScope()` +
`snapshotIds()`/`sweepTo()` + `assertNoLeaks()` in the shim (owned-entity cleanup),
exactly as D3 designed. **So "share one gateway per fork" (the user's option (a)) is
already the implementation.** The only *further* sharing would be one gateway across
forks or across runs — impossible, because forks/runs are separate OS processes, and
D3 explicitly rejected the multi-gateway-per-process / cross-process-shared model.

### What the fixture already disables (no env flags — explicit config)

`skipMcp: true`, `skipWorktreePool: true`, `skipTitleGeneration: true`,
`skipRemotePush: true`, `skipNonLocalRemoteGit: true`, plus
`configureAigwRuntimeFlags({ skipAigwDiscovery:true, testNoExternal:true, e2e:true })`
and an **in-process mock agent bridge** (no Node subprocess per agent). The boot
background chain (`runBootBackgroundTasks`) is **fire-and-forget after
`server.listen()`** and pool init is gated by `skipWorktreePool`.

---

## 2. Measured boot cost

### 2a. Runtime boot ≈ 470 ms (once per fork), phase breakdown

Replicated the fixture boot sequence with per-phase timing (throwaway bench,
single fork):

| Phase | Cost | Notes |
|---|---|---|
| scaffold + token | 5 ms | |
| packPrep (`cpSync` 3 first-party packs) | 64 ms | Windows FS/Defender copy, per fork |
| **createGateway** (migration + ALL managers + verification harness + project-context load) | **89 ms** | this is the "migration/team-manager" the brief worried about — it is cheap |
| start (`server.listen`) | 98 ms | |
| registerProject (HTTP + context create + git probe) | 109 ms | |
| seedWorkflows (HTTP PUT config) | 38 ms | |
| **total runtime boot** | **~403–471 ms** | |
| sweeper | 123 ms | **background** (`void runBootBackgroundTasks()`), does not block boot |
| aigw discovery | 0 ms | already skipped |

**Finding:** the runtime boot is already minimal. Migration + team-manager +
session-manager + verification-harness construction together cost only ~89 ms.
Sweeper (123 ms) runs in the background. aigw discovery is skipped. There is very
little runtime boot left to cut (maybe the 64 ms packPrep by caching the curated
packs dir, a ~0.4 CPU-s/run rounding error).

### 2b. The real per-fork cost = vitest transform + collect ≈ 11 s (once per fork)

The `src/server` graph is **278 `.ts` files / 124 k lines** (`server.ts` alone is
16.6 k lines). Importing it under vitest's SSR transformer costs, per **cold fork**:

| | single-file run (1 fork) | full tier (167 files, 6 forks) |
|---|---|---|
| transform | 2.2 s | 8.76 s (summed) |
| collect | 3.5 s | 58.2 s (summed ≈ 9.7 s/fork) |
| runtime boot | 0.47 s | ~3 s (summed) |
| tests | 0.44 s | **477.9 s (summed)** |
| **wall** | **4.1 s** | **144.3 s** |

Warm vs cold made no material difference (transform 2.17 s vs 2.22 s) — the
transform is **not** meaningfully reused between processes.

**Two headline facts:**
1. Per cold fork, ~11–12 s is spent transforming+importing the src graph **before
   any test runs** — this is the true "boot cost", and it is a module-transform cost,
   not a gateway-runtime cost.
2. Across a full run the **test work (478 CPU-s) dwarfs transform+collect (67 CPU-s)**
   — ~88% of CPU-time is real test execution.

### 2c. What makes the heavy tests heavy (the starvation set)

Slowest individual tests measured: `verification-core` 5.53 s + 5.29 s,
`gate-inspect-slicing` 4.88 s + 3.34 s. These are **verification-harness tests**:
they create goals with command-step workflows (`test-fast`: steps like
`{ type:"command", run:"echo ok" }`) and `await ws.waitFor(...)` on
`gate_verification_*` WS events with wall-clock timeouts.

`verification-harness.ts` executes each command step via `spawn` / `spawnTracked`
(`node:child_process`). On Windows each `echo ok` step spawns a `cmd.exe`. A single
heavy test drives several goals × several gates × several steps → **many child-process
spawns that the concurrency ledger does not count** in its `Σworkers ≤ 24` budget.

**This is the actual concurrency-ceiling mechanism:** under N-way load, N runs ×
forks × verification command-step spawns oversubscribe the 24 cores *beyond* the
ledger's worker cap, the CPU saturates, and the heavy tests' wall-clock `waitFor`
/ 60 s test timeouts blow. It is CPU/process contention on *test work*, **not**
per-test gateway boot.

---

## 3. Options evaluated

### Option (a) — Share one gateway per fork
**Status: ALREADY DONE (D3).** `getGateway()` is a per-fork singleton; 895 tests →
6 boots. There is no per-test boot to remove. Cross-fork/cross-run sharing is
impossible (separate processes) and explicitly rejected by D3. **Effort: 0.
Additional concurrency headroom from further "sharing": none.**

### Option (b) — Cheaper boot
- **Runtime subsystems**: already minimized (~470 ms; sweeper backgrounded; aigw/
  mcp/pool/title skipped). Remaining nibbles (cache packPrep, defer project
  register) save <0.5 CPU-s/run — not worth it.
- **esbuild prebundle of the src/server graph** (D3's R5 fallback) — the only boot
  lever with real magnitude. **Prototyped:**
  - `esbuild src/server/server.ts --bundle --platform=node --format=esm
    --packages=external` → **3.3 MB single file in ~1.7 s** (esbuild core 110 ms).
  - Importing that bundle (parse+eval) = **~425 ms** (2 reps: 425/423 ms).
  - vs vitest transform+collect ≈ **11 s/fork**. So a prebundle could cut per-fork
    cold-start from ~11 s → ~0.4 s (plus one ~0.1 s esbuild per run).
  - **Caveat found:** the naive bundle throws at module-top on `import.meta.url`
    path resolution (`aigw-manager`'s `models.generated.js` / package.json User-Agent
    resolver; also the fixture's `builtinsDir`/`market-packs` resolution). A real
    prebundle must shim/inject those paths (esbuild `define`/banner or a small
    loader). **Moderate effort, moderate risk** (must keep the bundle behaviourally
    identical to the transformed graph; a per-fork bundle-vs-source drift would be a
    subtle test-only bug).

---

## 4. Concurrency-impact estimate

Rough model (24 cores, ledger `Σworkers ≤ 24`; under 4-way each run gets ~3 vitest
forks + ~1 playwright worker):

| Cost bucket per run | Now | After esbuild prebundle |
|---|---|---|
| Cold-start (F forks × ~11 s), F≈3 | ~34 CPU-s/run; **4-way = ~134 CPU-s** simultaneous spike at run start | ~1 CPU-s/run; 4-way ≈ ~5 CPU-s |
| Integration test work | ~478 CPU-s/run (unchanged) | ~478 CPU-s/run (unchanged) |
| Verification command-step spawns | uncounted, oversubscribing (unchanged) | unchanged |

- The prebundle removes a **~130 CPU-s startup spike** that lands exactly when all
  runs boot together — the worst contention moment — and also trims **~10–20 s off
  every isolated run**. That is a genuine, universally-useful win.
- But it leaves the **478 CPU-s/run of test work** and the **uncounted verification
  spawns** untouched. Under 4-way that is 4 × 478 ≈ 1.9 k CPU-s of integration alone
  (~80 s floor on 24 cores) plus the browser tier plus spawn oversubscription.

**Estimate:** the prebundle alone is likely to make 3-way faster and *possibly* nudge
4-way within reach on a fully-quiet box, but it will **not reliably** deliver 4–5 way
with zero flakes. To hit 4–5 way reliably the higher-impact levers are, in order:
1. **Eliminate/replace verification command-step spawns** in tier-1 (e.g. an
   in-process command runner for `echo ok`-class steps, or fake-clock-driven
   verification) — kills the uncounted-process oversubscription. *Biggest lever.*
2. **esbuild prebundle** — removes the startup CPU spike (this section).
3. Count spawned child processes against the ledger budget, or relocate the ~6
   heaviest verification tests to the daily lane.

---

## 5. Recommendation

- **Correct the record:** gateway boot is **not** the concurrency bottleneck. It is
  already shared per fork (D3) and lean (~470 ms). The bottleneck is test-work CPU +
  uncounted verification command-step process spawns.
- **Best boot-cost action = esbuild prebundle** of the src/server graph: ~11 s/fork →
  ~0.4 s/fork, helping both isolated and concurrent runs. Moderate effort (~1–2 days
  incl. the `import.meta.url` shims + a bundle/source parity check), moderate risk.
- **Do it in the SPIN-OFF, not this goal.** This goal's acceptance is already capped
  at 3-way (D9) and the prebundle does not change that bar. The spin-off should
  sequence: (1) verification-spawn reduction (the real 4–5-way enabler), then (2) the
  prebundle. Track the "ledger doesn't count command-step child processes" gap there
  too.

### If a heavy isolated confirmation run is wanted

A 4-way `test:v2` measurement with an esbuild-prebundle prototype wired into
`vitest.config.ts` (alias `src/server` → the bundle) would confirm the estimate, but
requires the machine-quiet window and the shim work above. Not run in this study
(analysis + micro-benchmarks only, per the brief).

---

## Reproduce the measurements

```bash
npm ci
# Runtime boot + phase breakdown: add a throwaway tests2/integration/*.test.ts that
# times getGateway() (total) and the replicated boot phases, then:
VITEST_MAX_FORKS=1 npx vitest run --project v2-integration <bench>.test.ts   # ~470 ms boot; transform 2.2s + collect 3.5s
# Full tier split (boots == forks; work vs transform):
VITEST_MAX_FORKS=6 npx vitest run --project v2-integration --reporter=verbose  # 144s; 6 boots; tests 478 CPU-s
# esbuild prebundle prototype:
npx esbuild src/server/server.ts --bundle --platform=node --format=esm --packages=external --outfile=bundle.mjs  # ~1.7s, 3.3MB
node -e 'const t=performance.now();import("./bundle.mjs").catch(()=>{});Promise.resolve().then(()=>console.log(performance.now()-t))'  # ~425 ms import
```
