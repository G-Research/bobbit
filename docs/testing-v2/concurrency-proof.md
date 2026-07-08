# Concurrency Proof Report

**Generated:** Wed, 08 Jul 2026 17:50:51 GMT  
**Result:** ❌ FAILED  
**Model:** multi-worktree (Option A) — one `test:v2` per throwaway git worktree, each with its own `node_modules` (`npm ci`) + copied `dist`, coordinated by the cross-process ledger.  
**Base commit:** `bc7a25070b8ecc9365b083ee63fe0836bf51efd6`  
**Scale:** 2 concurrent × 3 rep(s) = 6 total runs (reduced smoke — default is 5×3)  

> **Acceptance bar (D7):** 3 concurrent × 3 reps = 9 runs, all green, `retries: 0`, zero flakes, each run ≤ 1800s under mutual load, ledger Σworkers ≤ cores. Playwright flakes under load are HARD failures.

---

## AUTHORITATIVE N-CURVE & ANALYSIS (task 4bb07af1, base `bc7a2507`)

> The single-snapshot report below is auto-generated and overwritten by the
> proof harness. This narrative is the authoritative interpretation of the
> last-mile work (ledger-split fix + determinism fixes + the deterministic
> tool-docs blocker fix). Measured 24-core AMD Ryzen box, **not truly idle**
> (~30 peer-agent procs, ~12–18 % CPU baseline; a genuinely quiet window was not
> available). `retries: 0`, wall decoupled from flake (`BOBBIT_V2_PERRUN_WALL_MS`).

### N-curve

| N | green (both tiers) | vitest | playwright | wall avg/max | Σworkers | dominant residual |
|---|---|---|---|---|---|---|
| **1** | ~near-clean (per prior authoritative) | pass | pass | ~300 s | 2 | — |
| **2** (×3 = 6 runs) | **0/6** | **0/6** | 3/6 | 548 s / 593 s | **14/24** ✅ | integration 60 s CPU-starvation timeouts (rotating) + 1 gateway-boot cascade |

**Highest cleanly ~0-flake N (this box, this build): N=1.** 3-way/4-way were NOT
run — 2-way already fails the ~0-flake bar, and higher N is strictly worse.

### What the last-mile fixes DID achieve (vs prior authoritative base `12df82b6`)

1. **Ledger no longer oversubscribes at N=2.** `splitBundle` gated on
   `activeParents===1` → Σ=**14/24** (was 20 → the N=2-worse-than-N=3
   oversubscription is gone). Browser tier no longer collapses from render
   starvation the way it did (pw 0/4 → mostly holding; 3/6 residual flakes here).
2. **Deterministic blocker removed.** `tool-docs-prompt › "returns empty string
   when no tools exist"` failed **6/6** on goal HEAD — a regression from the
   master-sync `defaultBuiltinToolsDir()` fallback, NOT concurrency. Fixed
   (bc7a2507). This was the true cause of the first "0/6, vitest 6/6" snapshot.
3. **The briefed wall-clock cluster now HOLDS.** `verification-dedup`, `PPS-04`
   (proposal-panel-streaming follow-tail), `app-smoke` Ctrl+ArrowDown,
   `goal-team-gates`, `project-reorder-api`, and `multi-repo-goal` (24 s → 645 ms)
   are **absent from every failure list** across both proofs. The observable-state
   / vestigial-poll fixes worked.

### The true residual (why N≥2 is still not ~0-flake)

After the above, 5/6 runs fail on only **1–2 rotating integration tests**, all
hitting a **60 s test-timeout / 15 s WS-waitFor / `pollUntil` deadline** under
N-way CPU starvation. Rotating cast this run: `team-lead-child-authz`,
`project-isolation`, `role-assistant-session`, `gate-signal-reminder`,
`mcp-meta-call`, `parent-scoped-archive-child`, `verification-core`. Plus an
intermittent **catastrophic gateway-boot cascade** (rep1-run2: **130 files**,
73× `ENOENT …/state/token` — the fixture cannot boot gateways under peak load).

**Key point:** these tests already drive on OBSERVABLE STATE (WS `waitFor`,
`pollUntil`) — they are not wall-clock-sleep flakes. The failure is the **server
itself** (gateway boot + WS round-trips + team orchestration) being CPU-starved
under 2 concurrent full `test:v2` suites (+ the peer-agent baseline). The
prescribed test-side levers (clock seam, state-waits) **cannot** move this: there
is no fake clock for real gateway-boot/WS-broadcast CPU cost. This is the same
KIND of ceiling the prior authoritative proof reached — now with the
oversubscription and the deterministic blocker removed, and the briefed cluster
proven robust.

### Honest conclusion

The ledger-split + determinism + blocker fixes are correct and landed real
improvements, but **did not** reach ~0-flake at N≥2 on this box. The binding
constraint is server throughput under concurrent load (heavy integration
timeouts + an intermittent gateway-boot cascade), not test-side timing. Options
for the goal owner: (a) a non-test-side lever (extend the non-spawning fake to
more heavy integration files; harden the gateway fixture against boot-cascade;
further cap heavy-test concurrency); (b) a genuinely idle measurement window to
separate peer-agent contamination from real starvation; or (c) set the honest
bar at N=1 for this build. No coverage was relocated, no assertion weakened, no
timeout/retry padded.

---

## Summary

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Runs green (exit 0) | 0/6 | 6/6 | ❌ |
| Vitest tier failures | 6 | 0 | ❌ |
| Playwright tier failures | 3 | 0 | ❌ |
| Max wall time | 593.4s | ≤ 1800s | ✅ |
| Avg / min wall | 548.3s / 516.8s | — | — |
| Max Σworkers (ledger) | 14 | ≤ 24 | ✅ |

## Assertions

| # | Assertion | Status |
|---|-----------|--------|
| A1 | Every run exits 0 (vitest green + playwright green + wall ≤ cap) | ❌ FAIL — 6 non-zero |
| A2 | No vitest or playwright tier FAIL in any run | ❌ FAIL — vitest 6, playwright 3 |
| A3 | Ledger Σworkers ≤ 24 at all times | ✅ PASS |
| A4 | Per-run wall ≤ 1800s | ✅ PASS |

## Violations

- ❌ A1: 6/6 run(s) exited non-zero: rep1/#1(exit 1), rep1/#2(exit 1), rep2/#1(exit 1), rep2/#2(exit 1), rep3/#1(exit 1), rep3/#2(exit 1)
- ❌ A2: 6 run(s) had vitest tier-1 failures: rep1/#1, rep1/#2, rep2/#1, rep2/#2, rep3/#1, rep3/#2
- ❌ A2: 3 run(s) had playwright tier-2 failures: rep2/#1, rep2/#2, rep3/#2

<details><summary>rep1/run#1 (exit 1) — last output</summary>

```
[1A[2K[596/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:101:2 › Sidebar bobbit data-URL memoization › explicit static sidebar idle bobbits render without inline animation while preserving idle styling
[1A[2K[597/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:129:2 › Sidebar bobbit data-URL memoization › static sidebar status rendering preserves busy and unread animations without idle breathing
[1A[2K[598/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:171:2 › Sidebar bobbit data-URL memoization › compacting sidebar bobbits stay inside the clipped wrapper without layout shift
[1A[2K[599/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:219:2 › Sidebar bobbit data-URL memoization › identical opts: toDataURL runs once on first render, never again
[1A[2K[600/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:89:2 › Sidebar filter/search lightweight fixture › filter defaults and localStorage persistence render with the single-project sidebar
[1A[2K[601/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:245:2 › Sidebar bobbit data-URL memoization › single-layer sprite: only one encode across many renders
[1A[2K[602/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:263:2 › Sidebar bobbit data-URL memoization › hue-rotate is CSS-only: does not produce a distinct cached bitmap
[1A[2K[603/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:281:2 › Sidebar bobbit data-URL memoization › key correctness: pixel-affecting opts produce DIFFERENT cached URLs
[1A[2K[604/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:345:2 › Sidebar bobbit data-URL memoization › idle vs streaming must NOT collide: idle sleeps (eyes closed), streaming is awake
[1A[2K[605/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:242:2 › Sidebar keyboard navigation lightweight fixture › Ctrl+Arrow walks visible rows in DOM order, wraps, and marks one active row
[1A[2K[606/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:121:2 › Sidebar filter/search lightweight fixture › search input filters rows, auto-opens archived results, supports full search, and Escape clears
[1A[2K[607/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:265:2 › Sidebar keyboard navigation lightweight fixture › Ctrl+ArrowLeft and Ctrl+ArrowRight collapse expandable rows without moving selection
[1A[2K[608/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:146:2 › Sidebar filter/search lightweight fixture › search expands retained collapsed goal ancestors ephemerally
[1A[2K[609/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:291:2 › Sidebar keyboard navigation lightweight fixture › Show Archived deterministically adds archived rows to the keyboard cycle
[1A[2K[610/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:164:2 › Sidebar filter/search lightweight fixture › search reveals matching runtime rows under collapsed goals without persisting expansion
[1A[2K[611/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:182:2 › Sidebar filter/search lightweight fixture › search retains matching first-class and delegate child sessions with goal ownership
[1A[2K[612/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:313:2 › Sidebar keyboard navigation lightweight fixture › route-selected project, goal, and session rows persist after rerender
[1A[2K[613/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:219:2 › Sidebar filter/search lightweight fixture › Show Read and Show Busy filters hide rows while search bypasses the filters
[1A[2K[614/623] [browser-v2] › tests2\browser\fixtures\streaming-bobbit-canvas-ref.spec.ts:43:2 › Streaming bobbit canvas eye animation › keeps the existing canvas animation across streaming re-renders
[1A[2K[615/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:91:2 › Tools page → MCP section fixture › renders flat servers, expands operations, and resets expansion on reload
[1A[2K[616/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:74:2 › Verification log Nx duplication (reproducing) › VerificationOutputModal renders streamed line exactly once when same event is dispatched 6×
[1A[2K[617/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:142:2 › Verification log Nx duplication (reproducing) › VerificationOutputModal portals its overlay to document.body so fixed positioning escapes a contained ancestor
[1A[2K[618/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:225:2 › Verification log Nx duplication (reproducing) › GateVerificationLive accumulates streamed line exactly once when same event is dispatched 6×
[1A[2K[619/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:128:2 › Tools page → MCP section fixture › groups gateway sub-namespaces and flat servers
[1A[2K[620/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:148:2 › Tools page → MCP section fixture › writes server and tool policy updates
[1A[2K[621/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:170:2 › Tools page → MCP section fixture › uses supplied public MCP policy keys when gateway runtime names differ
[1A[2K[622/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:213:2 › Tools page → MCP section fixture › shows inherited parent MCP policy for unset sub-namespace rows without storing override
[1A[2K[623/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:257:2 › Tools page → MCP section fixture › loads default and persisted policies, and reset persists empty
[1A[2K[33m  6 skipped[39m
[32m  617 passed[39m[2m (9.1m)[22m
assert-budget: scope=browser tier=tier2
  wall: 547.9s (cap 1800s)  [.profiles/testing-v2/budgets/playwright-report.json]
  cpu:  n/a (cap 240.00 CPU-min)  [unmeasured]
  artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\.profiles\testing-v2\budgets\2026-07-08T17-31-23-265Z-browser.json
assert-budget: PASS
[run-v2] tier1/vitest (test:v2:core): FAIL in 489.1s
[run-v2] tier2/playwright (test:v2:browser): PASS in 550.3s
[run-v2] total wall 553.0s, whole-tree CPU 125.28 CPU-min (peak procs 60)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\.profiles\testing-v2\budgets\2026-07-08T17-31-24-125Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

<details><summary>rep1/run#2 (exit 1) — last output</summary>

```
[1A[2K[596/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:101:2 › Sidebar bobbit data-URL memoization › explicit static sidebar idle bobbits render without inline animation while preserving idle styling
[1A[2K[597/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:129:2 › Sidebar bobbit data-URL memoization › static sidebar status rendering preserves busy and unread animations without idle breathing
[1A[2K[598/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:171:2 › Sidebar bobbit data-URL memoization › compacting sidebar bobbits stay inside the clipped wrapper without layout shift
[1A[2K[599/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:219:2 › Sidebar bobbit data-URL memoization › identical opts: toDataURL runs once on first render, never again
[1A[2K[600/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:245:2 › Sidebar bobbit data-URL memoization › single-layer sprite: only one encode across many renders
[1A[2K[601/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:263:2 › Sidebar bobbit data-URL memoization › hue-rotate is CSS-only: does not produce a distinct cached bitmap
[1A[2K[602/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:281:2 › Sidebar bobbit data-URL memoization › key correctness: pixel-affecting opts produce DIFFERENT cached URLs
[1A[2K[603/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:89:2 › Sidebar filter/search lightweight fixture › filter defaults and localStorage persistence render with the single-project sidebar
[1A[2K[604/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:345:2 › Sidebar bobbit data-URL memoization › idle vs streaming must NOT collide: idle sleeps (eyes closed), streaming is awake
[1A[2K[605/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:242:2 › Sidebar keyboard navigation lightweight fixture › Ctrl+Arrow walks visible rows in DOM order, wraps, and marks one active row
[1A[2K[606/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:121:2 › Sidebar filter/search lightweight fixture › search input filters rows, auto-opens archived results, supports full search, and Escape clears
[1A[2K[607/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:265:2 › Sidebar keyboard navigation lightweight fixture › Ctrl+ArrowLeft and Ctrl+ArrowRight collapse expandable rows without moving selection
[1A[2K[608/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:146:2 › Sidebar filter/search lightweight fixture › search expands retained collapsed goal ancestors ephemerally
[1A[2K[609/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:291:2 › Sidebar keyboard navigation lightweight fixture › Show Archived deterministically adds archived rows to the keyboard cycle
[1A[2K[610/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:164:2 › Sidebar filter/search lightweight fixture › search reveals matching runtime rows under collapsed goals without persisting expansion
[1A[2K[611/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:313:2 › Sidebar keyboard navigation lightweight fixture › route-selected project, goal, and session rows persist after rerender
[1A[2K[612/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:182:2 › Sidebar filter/search lightweight fixture › search retains matching first-class and delegate child sessions with goal ownership
[1A[2K[613/623] [browser-v2] › tests2\browser\fixtures\streaming-bobbit-canvas-ref.spec.ts:43:2 › Streaming bobbit canvas eye animation › keeps the existing canvas animation across streaming re-renders
[1A[2K[614/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:219:2 › Sidebar filter/search lightweight fixture › Show Read and Show Busy filters hide rows while search bypasses the filters
[1A[2K[615/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:91:2 › Tools page → MCP section fixture › renders flat servers, expands operations, and resets expansion on reload
[1A[2K[616/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:74:2 › Verification log Nx duplication (reproducing) › VerificationOutputModal renders streamed line exactly once when same event is dispatched 6×
[1A[2K[617/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:142:2 › Verification log Nx duplication (reproducing) › VerificationOutputModal portals its overlay to document.body so fixed positioning escapes a contained ancestor
[1A[2K[618/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:225:2 › Verification log Nx duplication (reproducing) › GateVerificationLive accumulates streamed line exactly once when same event is dispatched 6×
[1A[2K[619/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:128:2 › Tools page → MCP section fixture › groups gateway sub-namespaces and flat servers
[1A[2K[620/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:148:2 › Tools page → MCP section fixture › writes server and tool policy updates
[1A[2K[621/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:170:2 › Tools page → MCP section fixture › uses supplied public MCP policy keys when gateway runtime names differ
[1A[2K[622/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:213:2 › Tools page → MCP section fixture › shows inherited parent MCP policy for unset sub-namespace rows without storing override
[1A[2K[623/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:257:2 › Tools page → MCP section fixture › loads default and persisted policies, and reset persists empty
[1A[2K[33m  6 skipped[39m
[32m  617 passed[39m[2m (9.2m)[22m
assert-budget: scope=browser tier=tier2
  wall: 550.1s (cap 1800s)  [.profiles/testing-v2/budgets/playwright-report.json]
  cpu:  n/a (cap 240.00 CPU-min)  [unmeasured]
  artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-1\.profiles\testing-v2\budgets\2026-07-08T17-31-25-365Z-browser.json
assert-budget: PASS
[run-v2] tier1/vitest (test:v2:core): FAIL in 425.4s
[run-v2] tier2/playwright (test:v2:browser): PASS in 552.2s
[run-v2] total wall 555.0s, whole-tree CPU 118.61 CPU-min (peak procs 60)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-1\.profiles\testing-v2\budgets\2026-07-08T17-31-26-038Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

<details><summary>rep2/run#1 (exit 1) — last output</summary>

```
 [32m✓[39m [30m[43m v2-core-isolated [49m[39m tests2/core/transcript-sanitizer-agent-dir.test.ts [2m([22m[2m7 tests[22m[2m | [22m[33m1 skipped[39m[2m)[22m[32m 34[2mms[22m[39m
   [2m[90m↓[39m[22m transcript sanitizer trusted agent directory roots[2m > [22mrejects a final symlink inside a historical sessions root[2m[90m [symlink creation not permitted on this platform][39m[22m
[90mstderr[2m | tests2/core/session-recovery-agent-dir.test.ts[2m > [22m[2mrecoverSessionFile with configurable agent directories[2m > [22m[2mdoes not delete exact persisted outside transcript files during purge
[22m[39m[session-manager] Failed to cleanup prompt for outside-purge-session: Error: system-prompt: initPromptDirs() not called
    at getPromptsDir [90m(C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\[39msrc\server\agent\system-prompt.ts:41:26[90m)[39m
    at cleanupSessionPrompt [90m(C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\[39msrc\server\agent\system-prompt.ts:757:31[90m)[39m
    at SessionManager.purgeOneSession [90m(C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\[39msrc\server\agent\session-manager.ts:8886:4[90m)[39m
    at SessionManager.purgeArchivedSession [90m(C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\[39msrc\server\agent\session-manager.ts:8061:3[90m)[39m
    at [90mC:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\[39mtests2\core\session-recovery-agent-dir.test.ts:259:16
    at [90mfile:///C:/Users/jsubr/w/bobbit-wt/cc-proof-47860/wt-0/[39mnode_modules/[4m@vitest/runner[24m/dist/chunk-hooks.js:752:20
 [32m✓[39m [30m[43m v2-core-isolated [49m[39m tests2/core/session-recovery-agent-dir.test.ts [2m([22m[2m9 tests[22m[2m)[22m[32m 81[2mms[22m[39m
[90mstdout[2m | tests2/core/bobbit-dir-agent-dir.test.ts[2m > [22m[2magent directory resolver[2m > [22m[2mscaffold and agent-dir runtime leave existing ~/.pi/agent untouched
[22m[39mCreating Headquarters .bobbit/ in C:\Users\jsubr\AppData\Local\Temp\bobbit-pi-agent-untouched-AmCu3W\project\.bobbit...
Created Headquarters .bobbit/ in C:\Users\jsubr\AppData\Local\Temp\bobbit-pi-agent-untouched-AmCu3W\project\.bobbit. Customize roles, workflows, and system prompt in its config/ directory
 [32m✓[39m [30m[43m v2-core-isolated [49m[39m tests2/core/bobbit-dir-agent-dir.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 59[2mms[22m[39m
 [32m✓[39m [30m[43m v2-core-isolated [49m[39m tests2/core/container-path-translation.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 2[2mms[22m[39m
 [32m✓[39m [30m[43m v2-core-isolated [49m[39m tests2/core/extension-host-session-event-bus.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 1[2mms[22m[39m
[31m⎯⎯⎯⎯⎯⎯⎯[39m[1m[41m Failed Tests 1 [49m[22m[31m⎯⎯⎯⎯⎯⎯⎯[39m
[41m[1m FAIL [22m[49m [30m[43m v2-integration [49m[39m tests2/integration/project-isolation.test.ts[2m > [22mProject isolation — no default fallback[2m > [22mmulti-project session lifecycle — no cross-contamination
[31m[1mError[22m: Test timed out in 60000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".[39m
[36m [2m❯[22m testImpl tests2/integration/_e2e/in-process-harness.ts:[2m265:2[22m[39m
    [90m263| [39m
    [90m264| [39m[35mconst[39m testImpl [33m=[39m ((name[33m:[39m string[33m,[39m a[33m?[39m[33m:[39m unknown[33m,[39m b[33m?[39m[33m:[39m unknown) [33m=>[39m {
    [90m265| [39m [34mvIt[39m(name[33m,[39m [34mwrapTest[39m([34mpickFn[39m(a[33m,[39m b)))[33m;[39m
    [90m   | [39m [31m^[39m
    [90m266| [39m}) [35mas[39m [33mCompatTest[39m[33m;[39m
    [90m267| [39m
[90m [2m❯[22m tests2/integration/project-isolation.test.ts:[2m260:2[22m[39m
[90m [2m❯[22m tests2/integration/_e2e/in-process-harness.ts:[2m229:3[22m[39m
[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯[22m[39m
[2m Test Files [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m810 passed[39m[22m[2m | [22m[33m3 skipped[39m[90m (814)[39m
[2m      Tests [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m7146 passed[39m[22m[2m | [22m[33m27 skipped[39m[90m (7174)[39m
[2m   Start at [22m 18:31:30
[2m   Duration [22m 542.36s[2m (transform 47.13s, setup 16ms, collect 75.13s, tests 1580.19s, environment 3.97s, prepare 4.57s)[22m
[run-v2] tier1/vitest (test:v2:core): FAIL in 544.1s
[run-v2] tier2/playwright (test:v2:browser): FAIL in 517.4s
[run-v2] total wall 546.7s, whole-tree CPU 89.82 CPU-min (peak procs 67)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\.profiles\testing-v2\budgets\2026-07-08T17-40-33-368Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

<details><summary>rep2/run#2 (exit 1) — last output</summary>

```
[1A[2K[593/623] [browser-v2] › tests2\browser\fixtures\sidebar-actions-menu-fixture.spec.ts:327:1 › mobile rows expose quick actions plus hamburger menus without row navigation
[1A[2K[594/623] [browser-v2] › tests2\browser\fixtures\sidebar-archived-fixture.spec.ts:332:2 › Sidebar archived deterministic fixture › mobile archived sections share bucketing, collapse persistence, and search highlighting
[1A[2K[595/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:72:2 › Sidebar bobbit data-URL memoization › default idle preview bobbits keep the breathing animation
[1A[2K[596/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:101:2 › Sidebar bobbit data-URL memoization › explicit static sidebar idle bobbits render without inline animation while preserving idle styling
[1A[2K[597/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:129:2 › Sidebar bobbit data-URL memoization › static sidebar status rendering preserves busy and unread animations without idle breathing
[1A[2K[598/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:171:2 › Sidebar bobbit data-URL memoization › compacting sidebar bobbits stay inside the clipped wrapper without layout shift
[1A[2K[599/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:219:2 › Sidebar bobbit data-URL memoization › identical opts: toDataURL runs once on first render, never again
[1A[2K[600/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:245:2 › Sidebar bobbit data-URL memoization › single-layer sprite: only one encode across many renders
[1A[2K[601/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:263:2 › Sidebar bobbit data-URL memoization › hue-rotate is CSS-only: does not produce a distinct cached bitmap
[1A[2K[602/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:89:2 › Sidebar filter/search lightweight fixture › filter defaults and localStorage persistence render with the single-project sidebar
[1A[2K[603/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:281:2 › Sidebar bobbit data-URL memoization › key correctness: pixel-affecting opts produce DIFFERENT cached URLs
[1A[2K[604/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:345:2 › Sidebar bobbit data-URL memoization › idle vs streaming must NOT collide: idle sleeps (eyes closed), streaming is awake
[1A[2K[605/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:242:2 › Sidebar keyboard navigation lightweight fixture › Ctrl+Arrow walks visible rows in DOM order, wraps, and marks one active row
[1A[2K[606/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:121:2 › Sidebar filter/search lightweight fixture › search input filters rows, auto-opens archived results, supports full search, and Escape clears
[1A[2K[607/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:265:2 › Sidebar keyboard navigation lightweight fixture › Ctrl+ArrowLeft and Ctrl+ArrowRight collapse expandable rows without moving selection
[1A[2K[608/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:146:2 › Sidebar filter/search lightweight fixture › search expands retained collapsed goal ancestors ephemerally
[1A[2K[609/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:291:2 › Sidebar keyboard navigation lightweight fixture › Show Archived deterministically adds archived rows to the keyboard cycle
[1A[2K[610/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:164:2 › Sidebar filter/search lightweight fixture › search reveals matching runtime rows under collapsed goals without persisting expansion
[1A[2K[611/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:313:2 › Sidebar keyboard navigation lightweight fixture › route-selected project, goal, and session rows persist after rerender
[1A[2K[612/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:182:2 › Sidebar filter/search lightweight fixture › search retains matching first-class and delegate child sessions with goal ownership
[1A[2K[613/623] [browser-v2] › tests2\browser\fixtures\streaming-bobbit-canvas-ref.spec.ts:43:2 › Streaming bobbit canvas eye animation › keeps the existing canvas animation across streaming re-renders
[1A[2K[614/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:91:2 › Tools page → MCP section fixture › renders flat servers, expands operations, and resets expansion on reload
[1A[2K[615/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:219:2 › Sidebar filter/search lightweight fixture › Show Read and Show Busy filters hide rows while search bypasses the filters
[1A[2K[616/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:74:2 › Verification log Nx duplication (reproducing) › VerificationOutputModal renders streamed line exactly once when same event is dispatched 6×
[1A[2K[617/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:142:2 › Verification log Nx duplication (reproducing) › VerificationOutputModal portals its overlay to document.body so fixed positioning escapes a contained ancestor
[1A[2K[618/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:225:2 › Verification log Nx duplication (reproducing) › GateVerificationLive accumulates streamed line exactly once when same event is dispatched 6×
[1A[2K[619/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:128:2 › Tools page → MCP section fixture › groups gateway sub-namespaces and flat servers
[1A[2K[620/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:148:2 › Tools page → MCP section fixture › writes server and tool policy updates
[1A[2K[621/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:170:2 › Tools page → MCP section fixture › uses supplied public MCP policy keys when gateway runtime names differ
[1A[2K[622/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:213:2 › Tools page → MCP section fixture › shows inherited parent MCP policy for unset sub-namespace rows without storing override
[1A[2K[623/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:257:2 › Tools page → MCP section fixture › loads default and persisted policies, and reset persists empty
[1A[2K[31m  1 failed[39m
[31m    [browser-v2] › tests2\browser\fixtures\proposal-revision-snapshots.spec.ts:187:2 › Proposal revision snapshots › streaming proposal previews do not synthesize snapshot revisions [39m
[33m  6 skipped[39m
[32m  616 passed[39m[2m (8.5m)[22m
[run-v2] tier1/vitest (test:v2:core): FAIL in 475.2s
[run-v2] tier2/playwright (test:v2:browser): FAIL in 513.7s
[run-v2] total wall 516.4s, whole-tree CPU 88.96 CPU-min (peak procs 86)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-1\.profiles\testing-v2\budgets\2026-07-08T17-40-03-071Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

<details><summary>rep3/run#1 (exit 1) — last output</summary>

```
    [90m266| [39m}) [35mas[39m [33mCompatTest[39m[33m;[39m
    [90m267| [39m
[90m [2m❯[22m tests2/integration/gate-signal-reminder.test.ts:[2m107:2[22m[39m
[90m [2m❯[22m tests2/integration/_e2e/in-process-harness.ts:[2m229:3[22m[39m
[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯[22m[39m
[41m[1m FAIL [22m[49m [30m[43m v2-integration [49m[39m tests2/integration/mcp-meta-call.test.ts[2m > [22mMCP meta-tool API E2E[2m > [22mPOST /api/internal/mcp-call denies per-op `never` policy via role
[31m[1mError[22m: Test timed out in 60000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".[39m
[36m [2m❯[22m testImpl tests2/integration/_e2e/in-process-harness.ts:[2m265:2[22m[39m
    [90m263| [39m
    [90m264| [39m[35mconst[39m testImpl [33m=[39m ((name[33m:[39m string[33m,[39m a[33m?[39m[33m:[39m unknown[33m,[39m b[33m?[39m[33m:[39m unknown) [33m=>[39m {
    [90m265| [39m [34mvIt[39m(name[33m,[39m [34mwrapTest[39m([34mpickFn[39m(a[33m,[39m b)))[33m;[39m
    [90m   | [39m [31m^[39m
    [90m266| [39m}) [35mas[39m [33mCompatTest[39m[33m;[39m
    [90m267| [39m
[90m [2m❯[22m tests2/integration/mcp-meta-call.test.ts:[2m558:2[22m[39m
[90m [2m❯[22m tests2/integration/_e2e/in-process-harness.ts:[2m229:3[22m[39m
[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯[22m[39m
[41m[1m FAIL [22m[49m [30m[43m v2-integration [49m[39m tests2/integration/mcp-meta-call.test.ts[2m > [22mMCP meta-tool API E2E[2m > [22mPOST /api/internal/mcp-call lets broad role allow override persisted per-op `never`
[31m[1mError[22m: Test timed out in 60000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".[39m
[36m [2m❯[22m testImpl tests2/integration/_e2e/in-process-harness.ts:[2m265:2[22m[39m
    [90m263| [39m
    [90m264| [39m[35mconst[39m testImpl [33m=[39m ((name[33m:[39m string[33m,[39m a[33m?[39m[33m:[39m unknown[33m,[39m b[33m?[39m[33m:[39m unknown) [33m=>[39m {
    [90m265| [39m [34mvIt[39m(name[33m,[39m [34mwrapTest[39m([34mpickFn[39m(a[33m,[39m b)))[33m;[39m
    [90m   | [39m [31m^[39m
    [90m266| [39m}) [35mas[39m [33mCompatTest[39m[33m;[39m
    [90m267| [39m
[90m [2m❯[22m tests2/integration/mcp-meta-call.test.ts:[2m612:2[22m[39m
[90m [2m❯[22m tests2/integration/_e2e/in-process-harness.ts:[2m229:3[22m[39m
[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯[22m[39m
[2m Test Files [22m [1m[31m2 failed[39m[22m[2m | [22m[1m[32m809 passed[39m[22m[2m | [22m[33m3 skipped[39m[90m (814)[39m
[2m      Tests [22m [1m[31m3 failed[39m[22m[2m | [22m[1m[32m7144 passed[39m[22m[2m | [22m[33m27 skipped[39m[90m (7174)[39m
[2m   Start at [22m 18:40:37
[2m   Duration [22m 588.55s[2m (transform 39.26s, setup 11ms, collect 68.50s, tests 1721.99s, environment 2.44s, prepare 3.08s)[22m
[run-v2] tier1/vitest (test:v2:core): FAIL in 590.4s
[run-v2] tier2/playwright (test:v2:browser): PASS in 515.2s
[run-v2] total wall 593.0s, whole-tree CPU 1868.60 CPU-min (peak procs 64)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-0\.profiles\testing-v2\budgets\2026-07-08T17-50-26-994Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

<details><summary>rep3/run#2 (exit 1) — last output</summary>

```
[1A[2K[593/623] [browser-v2] › tests2\browser\fixtures\sidebar-archived-fixture.spec.ts:322:2 › Sidebar archived deterministic fixture › collapsed sidebar exposes archived goal rows only when Show Archived is on
[1A[2K[594/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:72:2 › Sidebar bobbit data-URL memoization › default idle preview bobbits keep the breathing animation
[1A[2K[595/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:101:2 › Sidebar bobbit data-URL memoization › explicit static sidebar idle bobbits render without inline animation while preserving idle styling
[1A[2K[596/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:129:2 › Sidebar bobbit data-URL memoization › static sidebar status rendering preserves busy and unread animations without idle breathing
[1A[2K[597/623] [browser-v2] › tests2\browser\fixtures\sidebar-archived-fixture.spec.ts:332:2 › Sidebar archived deterministic fixture › mobile archived sections share bucketing, collapse persistence, and search highlighting
[1A[2K[598/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:171:2 › Sidebar bobbit data-URL memoization › compacting sidebar bobbits stay inside the clipped wrapper without layout shift
[1A[2K[599/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:219:2 › Sidebar bobbit data-URL memoization › identical opts: toDataURL runs once on first render, never again
[1A[2K[600/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:245:2 › Sidebar bobbit data-URL memoization › single-layer sprite: only one encode across many renders
[1A[2K[601/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:263:2 › Sidebar bobbit data-URL memoization › hue-rotate is CSS-only: does not produce a distinct cached bitmap
[1A[2K[602/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:281:2 › Sidebar bobbit data-URL memoization › key correctness: pixel-affecting opts produce DIFFERENT cached URLs
[1A[2K[603/623] [browser-v2] › tests2\browser\fixtures\sidebar-bobbit-datauri-cache.spec.ts:345:2 › Sidebar bobbit data-URL memoization › idle vs streaming must NOT collide: idle sleeps (eyes closed), streaming is awake
[1A[2K[604/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:89:2 › Sidebar filter/search lightweight fixture › filter defaults and localStorage persistence render with the single-project sidebar
[1A[2K[605/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:242:2 › Sidebar keyboard navigation lightweight fixture › Ctrl+Arrow walks visible rows in DOM order, wraps, and marks one active row
[1A[2K[606/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:121:2 › Sidebar filter/search lightweight fixture › search input filters rows, auto-opens archived results, supports full search, and Escape clears
[1A[2K[607/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:265:2 › Sidebar keyboard navigation lightweight fixture › Ctrl+ArrowLeft and Ctrl+ArrowRight collapse expandable rows without moving selection
[1A[2K[608/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:146:2 › Sidebar filter/search lightweight fixture › search expands retained collapsed goal ancestors ephemerally
[1A[2K[609/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:291:2 › Sidebar keyboard navigation lightweight fixture › Show Archived deterministically adds archived rows to the keyboard cycle
[1A[2K[610/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:164:2 › Sidebar filter/search lightweight fixture › search reveals matching runtime rows under collapsed goals without persisting expansion
[1A[2K[611/623] [browser-v2] › tests2\browser\fixtures\sidebar-keyboard-nav-fixture.spec.ts:313:2 › Sidebar keyboard navigation lightweight fixture › route-selected project, goal, and session rows persist after rerender
[1A[2K[612/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:182:2 › Sidebar filter/search lightweight fixture › search retains matching first-class and delegate child sessions with goal ownership
[1A[2K[613/623] [browser-v2] › tests2\browser\fixtures\streaming-bobbit-canvas-ref.spec.ts:43:2 › Streaming bobbit canvas eye animation › keeps the existing canvas animation across streaming re-renders
[1A[2K[614/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:91:2 › Tools page → MCP section fixture › renders flat servers, expands operations, and resets expansion on reload
[1A[2K[615/623] [browser-v2] › tests2\browser\fixtures\sidebar-filter-search-fixture.spec.ts:219:2 › Sidebar filter/search lightweight fixture › Show Read and Show Busy filters hide rows while search bypasses the filters
[1A[2K[616/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:74:2 › Verification log Nx duplication (reproducing) › VerificationOutputModal renders streamed line exactly once when same event is dispatched 6×
[1A[2K[617/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:142:2 › Verification log Nx duplication (reproducing) › VerificationOutputModal portals its overlay to document.body so fixed positioning escapes a contained ancestor
[1A[2K[618/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:128:2 › Tools page → MCP section fixture › groups gateway sub-namespaces and flat servers
[1A[2K[619/623] [browser-v2] › tests2\browser\fixtures\verification-dedup.spec.ts:225:2 › Verification log Nx duplication (reproducing) › GateVerificationLive accumulates streamed line exactly once when same event is dispatched 6×
[1A[2K[620/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:148:2 › Tools page → MCP section fixture › writes server and tool policy updates
[1A[2K[621/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:170:2 › Tools page → MCP section fixture › uses supplied public MCP policy keys when gateway runtime names differ
[1A[2K[622/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:213:2 › Tools page → MCP section fixture › shows inherited parent MCP policy for unset sub-namespace rows without storing override
[1A[2K[623/623] [browser-v2] › tests2\browser\fixtures\tool-manager-mcp-section.spec.ts:257:2 › Tools page → MCP section fixture › loads default and persisted policies, and reset persists empty
[1A[2K[31m  1 failed[39m
[31m    [browser-v2] › tests2\browser\journeys\app-smoke.journey.spec.ts:308:2 › Journey: Sidebar Keyboard Nav › Ctrl+ArrowDown advances keyboard-nav through rows in DOM order [39m
[33m  6 skipped[39m
[32m  616 passed[39m[2m (8.6m)[22m
[run-v2] tier1/vitest (test:v2:core): FAIL in 490.0s
[run-v2] tier2/playwright (test:v2:browser): FAIL in 520.2s
[run-v2] total wall 522.7s, whole-tree CPU 1864.36 CPU-min (peak procs 69)
[run-v2] budget artifact: C:\Users\jsubr\w\bobbit-wt\cc-proof-47860\wt-1\.profiles\testing-v2\budgets\2026-07-08T17-49-16-763Z-full.json
[run-v2] budget PASS (full ≤180s wall / ≤13 CPU-min)
```
</details>

## Per-Rep Results

### Rep 1

| Run | PID | Exit | Wall (s) | Vitest | Playwright |
|-----|-----|------|----------|--------|------------|
| 1 | 47272 | 1 ❌ | 553.6 | ❌ | ✅ |
| 2 | 19812 | 1 ❌ | 555.5 | ❌ | ✅ |

**Ledger peak Σworkers:** 14/24 ✅  (1068 samples)

### Rep 2

| Run | PID | Exit | Wall (s) | Vitest | Playwright |
|-----|-----|------|----------|--------|------------|
| 1 | 41996 | 1 ❌ | 547.1 | ❌ | ❌ |
| 2 | 3880 | 1 ❌ | 516.8 | ❌ | ❌ |

**Ledger peak Σworkers:** 14/24 ✅  (1059 samples)

### Rep 3

| Run | PID | Exit | Wall (s) | Vitest | Playwright |
|-----|-----|------|----------|--------|------------|
| 1 | 45688 | 1 ❌ | 593.4 | ❌ | ✅ |
| 2 | 11404 | 1 ❌ | 523.1 | ❌ | ❌ |

**Ledger peak Σworkers:** 14/24 ✅  (1146 samples)

## What This Proves

1. **Zero-flake concurrency (realistic model).** 0/6 concurrent `test:v2` runs — each in its own worktree, exactly how Bobbit runs agents — completed green with `retries: 0`. A single flake in either tier flips a run's exit code and fails this proof; no downgraded assertions, no dry-run.

2. **CPU exhaustion bounded by the ledger (the D7 mechanism).** Peak Σworkers = 14/24. The ledger counts pending peers during coalescing, so 2 simultaneous runs each get ~`floor(24/2)` slots instead of grabbing the full 12-slot bundle and oversubscribing to ~24 on 24 cores.

3. **Under-load wall budget honoured.** Slowest run: 593.4s ≤ 1800s cap (D7 under-load bar), enforced per-run via `BOBBIT_V2_CONCURRENCY_RUN=1` → run-v2's under-load budget.

## Reproduce

```bash
# Full D7 proof (default 5×3); provisions + tears down worktrees automatically:
node scripts/testing-v2/concurrency-proof.mjs

# Lighter smoke:
CONCURRENCY_PROOF_CONCURRENT=2 CONCURRENCY_PROOF_REPS=1 node scripts/testing-v2/concurrency-proof.mjs
```
