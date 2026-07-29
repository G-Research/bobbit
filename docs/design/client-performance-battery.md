# Client performance & battery — analysis and implementation plan

Status: design accepted, not started. This is the WHAT/WHY + contracts (Appendix A).

> **Execution authority:** implement from
> [client-performance-battery-implementation-plan.md](client-performance-battery-implementation-plan.md)
> (per-goal owned files, symbol anchors, RED→GREEN tests, measurement discipline).
> Sequencing: [fable-program-execution-plan.md](fable-program-execution-plan.md).

**The symptom this answers:** Bobbit visibly drains laptop battery — noticeably worse than
leaving a typical web app open. The goal: an *idle* Bobbit tab should cost ≈0% CPU with zero
continuous repaints, and an *active* one should stay smooth even on machines without dedicated
GPU acceleration (soft constraint, not a hard gate).

**The one-paragraph answer:** The server side was already fixed (see the
[reduce-server-cpu series](reduce-server-cpu-performance-report.md) — idle gateway ≈ 0% CPU),
so the drain is client-side, and it is structural, not one bug: **the UI is never idle.**
Dozens of `infinite` CSS animations (sprites, accessories, pulses, shimmers) keep the
compositor — and on non-GPU machines, the CPU rasterizer — awake 24/7 even when nothing is
happening; two of the pulse animations animate `box-shadow`, which repaints on the main thread
every frame; a 5-second REST poll re-fetches the session list the WebSocket already pushes;
a 1-second timer re-renders the *entire app* while any verification runs; and every WebSocket
streaming delta schedules a full root re-render (rAF-coalesced, so up to ~60 full lit-html
tree evaluations per second during streaming). None of these is individually fatal; together
they mean the browser never reaches its power-saving render-idle state. The plan below is
**instrumentation-first** (same discipline as
[time-and-token-cost-efficiency.md](time-and-token-cost-efficiency.md)): we build a small repeatable measurement
harness, capture a baseline, then land tiered fixes — each behind a
[`perf-flags.ts`](../../src/app/perf-flags.ts)-style kill switch and re-measured against the
baseline.

Related: [docs/perf/defer-offscreen-render.md](../perf/defer-offscreen-render.md) (prior art:
measured, flag-gated, default-on), [docs/perf/bundle-profile.md](../perf/bundle-profile.md),
[docs/design/shrink-initial-bundle.md](shrink-initial-bundle.md).

---

## §1 Why "battery" ≠ "CPU benchmark"

Battery drain on modern laptops is dominated by how often the machine is *prevented from
sleeping its silicon*, not by average CPU%. Three distinct mechanisms matter here:

1. **Render-loop liveness.** Any running CSS animation — even a compositor-only
   `transform`/`opacity` one — forces the browser to produce frames continuously. The GPU (or
   CPU rasterizer without GPU acceleration) never idles, and the display pipeline never drops
   to its low-power state. Cheap per frame × 60 fps × every hour the tab is open = the single
   biggest battery line item for "decorative" animation.
2. **Main-thread paint.** Animating paint-affecting properties (`box-shadow`, `background`,
   layout properties) repaints on the main thread every frame. Strictly worse than (1).
3. **Timer wakeups.** Every `setInterval` tick wakes the process, runs JS, possibly fetches
   over the network (radio/Wi-Fi power-up), and possibly re-renders. Browsers throttle timers
   in *hidden* tabs but not in visible-but-idle ones.

The fix plan maps 1:1 onto these: stop animating when nothing is happening (§6 P1), never
animate paint properties (§6 P1), and make timers event-driven or visibility/idle-gated
(§6 P2).

---

## §2 Findings (verified in source, 2026-06-10)

### F1 — Ambient `infinite` animations never stop (HIGH, the headline)

Inventory (grep `animation:.*infinite` across `src/**/*.css`):

- **`src/ui/app.css` (sprite/chat layer)** — ~25 infinite rules: `blob-busy-shadow` (10s),
  `blob-crown-idle-sleep-breathe` / `blob-bandana-idle-sleep-breathe` (3.6s),
  `blob-compact-squash` / `blob-compact-squash-rigid` (3s, several marked `!important`),
  `magnifier-depth-idle` (10s `steps(1)`), `wand-sparkle-a/b`, `flask-bubbles`,
  `ask-heartbeat` (1.8s), two `shimmer` variants.
- **`src/app/app.css` (shell layer)** — `bobbit-bob`, `bobbit-breathe`, `bobbit-eyes` (+ `-s`
  sidebar variants), `status-pulse` (2s), `unseen-dot-pulse` (1.8s), `gentle-float` (4s),
  `bobbit-unread-tap` (1.6s), `bobbit-sidebar-unread-blink` (3.4s `steps(1)`).

Two important nuances (so the fix targets the right thing):

- The sprite keyframes themselves are **well-built**: `bobbit-eyes`, `blob-busy-shadow` etc.
  animate `transform`/`opacity` only (verified at `src/app/app.css:439`,
  `src/ui/app.css:2693`) — compositor-friendly, no per-frame paint. The cost is **liveness**
  (§1.1): they run `infinite`, on *every* visible sprite (sidebar shows one per session), at
  all times — including when every agent is idle and the user is just reading.
- `status-pulse` and `unseen-dot-pulse` **do animate `box-shadow`** (§1.2): main-thread
  repaint every frame, forever, for each status dot / unseen indicator on screen.

`prefers-reduced-motion` is honored in only **9** CSS sites — e.g. `.unseen-dot` and
`.bobbit-unread-pulse` opt out, but the sprite system, shimmers, and pulses largely don't.

### F2 — Polling alongside a push channel (MEDIUM-HIGH)

- **Session list poll** — `src/app/api.ts::startSessionPolling()` (`api.ts:273`) runs
  `refreshSessions()` every **5 s** whenever the app is authenticated and visible. The
  gateway *already pushes* `session_status` frames over the WebSocket (the same file handles
  them ~20 lines above). So in steady state the poll is pure redundancy: a REST round-trip +
  state diff + `renderApp()` every 5 s, all day. It exists as a safety net for missed frames —
  the right shape is "slow fallback, fast on reconnect" (§6 P2.1).
- **Live verification timer** — `src/app/goal-dashboard.ts:1090` `startLiveVerifTimer()`:
  `setInterval(() => renderApp(), 1000)` while any verification step is `running`. A full app
  re-render every second, to advance an elapsed-time label. (It does stop when no step is
  running — `stopLiveVerifTimerIfDone()` — but verifications can run for many minutes.)
- **Relative-clock timer** — `src/app/render-helpers.ts:338`: `renderApp()` every 60 s. Fine
  in isolation; included in the wakeup budget.
- **Good pattern already in-tree** — the git-status poll
  (`src/app/session-manager.ts:2821`) is the model citizen: 30 s tick, visibility-gated,
  coalesced against event-driven refreshes (`gitStatusLastRefreshAt`, 10 s min spacing),
  self-cancelling when the session changes or the repo is known-absent, with a
  `visibilitychange` catch-up refresh. P2 below converges the other pollers on this shape.
- ~92 `setInterval`/`setTimeout`-loop sites exist across `src/app` (top files:
  `goal-dashboard.ts` ×24, `dialogs.ts` ×16, `session-manager.ts` ×11, `api.ts` ×10). Most
  are benign one-shots; the audit in P0 classifies them so we fix the loops, not the noise.

### F3 — Every event is a full-tree render (MEDIUM)

`renderApp()` (`src/app/state.ts:687`) is rAF-coalesced (good — multiple calls per frame
collapse to one) but each invocation re-evaluates the **entire root lit-html template**
(sidebar + chat + panels). There are **646** `renderApp()` call sites; during agent streaming,
every `message_update` WS frame schedules one, so a streaming session runs a full-tree
evaluation at up to the frame rate, continuously, for minutes. lit-html diffing makes each
pass cheap-ish, but "cheap × 60/s × whole tree" is exactly the §1.1 problem in JS form. The
server-side coalescing experiment was rejected
([reduce-server-cpu-experiment-stream-coalescing.md](reduce-server-cpu-experiment-stream-coalescing.md))
— the client is the right layer: batch *visual* updates without delaying state updates.

### F4 — Dev mode amplifies everything (LOW, but affects the owner's perception)

`npm run dev:harness` runs vite dev (esbuild transforms, HMR socket, unminified lit) plus the
restart harness. The baseline (§4) must be captured on a **production build** (`npm run
build` + gateway) *and* dev mode, separately, so we know how much of the perceived drain is
dev-only and don't chase ghosts.

### F5 — What was ruled out

- Gateway CPU: already measured ≈0% idle (`reduce-server-cpu-baseline.md`); not the drain.
- `deferOffscreenRender` already prevents offscreen transcript paint on activation; long
  transcripts are not the idle-drain cause.

---

## §3 Targets (acceptance bar for the whole effort)

Measured on a production build, mid-range laptop, all four states from §4:

| State | Target |
|---|---|
| Idle-foreground (agents idle, user reading) | 0 continuous animations running; <2 paint events/s; <8 timer wakeups/min; CPU ≈0% |
| Hidden tab | 0 animations, 0 renders, ≤1 network poll/min |
| Streaming (one active agent) | visual update cadence ~10 Hz (not 60); no long tasks >50 ms from render |
| Dashboard open, verification running | scoped second-tick (no full-tree render/s) |

"Battery-saver mode" (§6 P3.3) tightens these further on demand.

---

## §4 Phase P0 — Measurement harness (build BEFORE any fix)

Goal: a repeatable, scriptable protocol that outputs one comparison table per run. Pattern:
the server-side benchmark harness (`reduce-server-cpu-benchmark.md`) and `boot-timing.ts`.

Implementation steps:

1. **Add `src/app/perf-monitor.ts`** (debug-only, loaded when
   `localStorage.bobbitPerfFlags` contains `+perfMonitor` — reuse the
   `isPerfFlagEnabled`/`perf-flags.ts` mechanism). It records, over a sampling window:
   - renders/s: increment a counter inside `renderApp()`'s rAF callback (one-line hook,
     guarded by the flag);
   - timer wakeups/s: in monitor mode only, wrap `window.setInterval`/`setTimeout` to count
     scheduled-callback executions by call-site stack bucket;
   - long tasks: `PerformanceObserver({ type: "longtask" })`;
   - running animations: `document.getAnimations().length` sampled 1/s (this is the direct
     "is the page render-idle" probe);
   - WS frames/s by frame type (hook the existing WS message dispatch).
   Expose `window.__bobbitPerf.report()` returning JSON; the
   [`client-debug` skill](../../.claude/skills/client-debug/SKILL.md) is the retrieval path.
2. **Define the four states** as a manual-but-scripted protocol (a new
   `docs/perf/battery-protocol.md` section or appendix in this doc): idle-foreground,
   hidden, streaming (one mock-agent session — reuse the E2E mock agent), dashboard+verification.
   60 s sample each, three runs, production build and dev build.
3. **Record the baseline table** into this doc (§7 placeholder) — same convention as the
   shared baseline table in `reduce-server-cpu-performance-report.md`.
4. OS-level cross-check (manual, documented): macOS `powermetrics`/Activity Monitor "Energy
   Impact" or Windows Task Manager power column for the browser process, idle-foreground vs
   after P1. This is the number the owner actually feels.

Acceptance: `window.__bobbitPerf.report()` returns all five metric families in all four
states; baseline table committed. No behavior change when the flag is off (pinned by a unit
test asserting `perf-monitor` is not imported in the default boot path — follow the
`tests/`-side pattern used for `boot-timing`).

---

## §5 Fix inventory (what we change and why it's safe)

Numbered for reference from the phases:

- **FX1 Ambient-animation gating.** Introduce one CSS class contract: every *ambient*
  (infinite, decorative/status) animation rule gains the guard
  `html.anims-paused & { animation-play-state: paused; }` (or is collected under a shared
  selector). A new tiny module `src/app/animation-power.ts` toggles `anims-paused` on
  `<html>` when: tab hidden (`visibilitychange`), OR no session is in a working state
  (derive from existing session status state — the sidebar already knows), OR battery-saver
  is on (P3.3). One-shot transition animations (card-slide-in, banner-slide-down) are NOT
  ambient and are excluded — pausing those would freeze mid-transition.
- **FX2 Sprites as status, not decoration** (UX improvement, not just a fix): a bobbit
  animates **only while its agent is actually working**; idle/sleeping agents show a static
  frame (or the existing sleep pose, frozen). Animation regains meaning as an at-a-glance
  status signal, and N-sessions × ambient-loops disappears. Implemented as CSS: the
  bob/breathe/eyes loops apply only under the existing busy/working status classes
  (verify exact class names in `src/ui/bobbit-render.ts` / `app.css` during impl).
- **FX3 Kill paint-property animation.** Rewrite `status-pulse` and `unseen-dot-pulse` to
  animate `opacity`/`transform` on a pseudo-element halo instead of `box-shadow` (visually
  identical: a pre-rendered shadow layer fading/scaling). `pr-conflict-pulse` same treatment.
- **FX4 Global `prefers-reduced-motion` sweep.** One blanket rule disabling all ambient
  animations under reduced-motion (keep opacity cross-fades), replacing the 9 piecemeal
  opt-outs.
- **FX5 Session-poll demotion.** `startSessionPolling()` becomes the fallback it was meant to
  be: interval 5 s → 60 s while the WS is connected and healthy; immediate `refreshSessions()`
  on WS reconnect and on `visibilitychange`→visible (catch-up), mirroring the git-status
  pattern. Keep 5 s only while the WS is down.
- **FX6 Scoped second-tick.** Replace `liveVerifTimer`'s `renderApp()` with a scoped update:
  the elapsed-time labels become self-updating (a small component/`setInterval` that writes
  `textContent` on the specific nodes, or a CSS counter). Full-tree render is reserved for
  actual status transitions (which already arrive via WS events).
- **FX7 Streaming render cadence.** In the WS dispatch path for high-frequency frame types
  (`message_update` deltas): apply state immediately (never delay data), but schedule the
  visual render through a 100 ms trailing-edge throttle instead of per-frame rAF. Terminal
  frames (`message_complete`, status changes) flush immediately. Build on the existing
  `_renderScheduled` machinery in `state.ts` — add a `renderAppThrottled(ms)` next to
  `renderApp()`; only the streaming call sites switch to it.
- **FX8 Timer audit & visibility gates.** From the P0 wakeup-by-callsite report, every
  surviving interval ≥1/min gets the git-status-pattern treatment (visibility gate +
  event-coalescing + self-cancel). `dialogs.ts`/`goal-dashboard.ts` loops are the known
  suspects; fix what the data convicts.
- **FX9 Battery-saver mode.** A settings toggle (and auto-*suggestion* via
  `navigator.getBattery()` when discharging — suggest, never silently switch): forces
  `anims-paused`, stretches FX5/FX7 cadences (poll 120 s, render throttle 250 ms), disables
  shimmer placeholders. State lives with the other UI settings; surfaced in the settings page
  and the `bobbitPerfFlags` escape hatch.

---

## §6 Phased implementation plan

Each phase = one mission goal; land in order; every behavior change ships behind a perf-flag
kill switch (default-on once verified, like `deferOffscreenRender`) and is re-measured with
the P0 harness before the flag's removal cycle.

### P1 — Stop animating at idle *(FX1–FX4; the battery headline)*

Steps, in order:

1. Build `src/app/animation-power.ts`: exports `initAnimationPower()` (called from
   `main.ts`) — registers `visibilitychange` + subscribes to session-status state changes;
   computes `shouldPause = hidden || noSessionWorking || batterySaver || reducedMotion`;
   toggles `anims-paused` class on `document.documentElement`. Perf-flag:
   `-pauseAmbientAnims` restores current behavior.
2. CSS sweep #1: tag every `infinite` animation rule listed in F1 with the
   `html.anims-paused` pause guard. Mechanical change; keep one shared comment block in each
   CSS file pointing back to this doc ("never reintroduce un-gated infinite animations").
3. CSS sweep #2 (FX2): move the sprite work/idle loops under the busy/working status
   selectors so idle sprites are static. Confirm the sleep pose stays as a static frame.
4. Rewrite `status-pulse` / `unseen-dot-pulse` / `pr-conflict-pulse` per FX3.
5. Add the blanket reduced-motion rule (FX4); delete the now-redundant piecemeal opt-outs.
6. Tests: browser E2E (`tests/e2e/ui/animation-power.spec.ts`) asserting (a) idle state ⇒
   `html.anims-paused` present and `document.getAnimations().length === 0`; (b) mock agent
   working ⇒ its sprite animates; (c) `visibilitychange` to hidden pauses; (d) perf-flag
   opt-out restores animations. Unit test pinning that no `infinite` animation in the two CSS
   files lacks the pause guard (regex over the CSS — the "missing test IS the bug" rule).

Acceptance: idle-foreground `getAnimations()` = 0; paint events/s <2; the E2E suite above
green; visual QA confirms sprites still bob while agents work.

### P2 — Timer & render hygiene *(FX5–FX8)*

1. FX5 session-poll demotion in `api.ts` (+ unit test on the interval-selection logic; the
   spurious-unread pinning test `tests/spurious-idle-unread.spec.ts` must stay green).
2. FX6 scoped verification tick in `goal-dashboard.ts` (+ E2E: elapsed label advances while
   `renderApp` counter — exposed via perf monitor — does not tick per second).
3. FX7 `renderAppThrottled()` in `state.ts` + switch streaming dispatch call sites; E2E:
   streaming a long mock response produces ≤15 renders/s (perf-monitor counter) with no
   visible degradation (follow-tail still pins to bottom — `follow-tail` tests stay green).
4. FX8 audit: commit the wakeup-by-callsite table to this doc, fix convicted loops on the
   git-status pattern.

Acceptance: idle-foreground wakeups <8/min; hidden-tab network ≤1 req/min; streaming render
cadence ~10 Hz; all existing unit + e2e phases green.

### P3 — Product polish

1. **P3.1 Remove temporary flags** that have soaked (per the `defer-offscreen-render.md`
   removal convention), keep `anims-paused` as the permanent mechanism.
2. **P3.2 Re-baseline & publish**: re-run the §4 protocol, fill the after-table in §7, include
   the OS-level energy reading. If streaming long-tasks remain, only then evaluate the heavier
   options (scoped/component-level rendering for chat; sprite-sheet/canvas sprite engine) —
   they are deliberately out of scope until data convicts them.
3. **P3.3 Battery-saver mode** (FX9): settings toggle + `getBattery()` suggestion banner +
   docs. Browser E2E: toggle persists across reload (the settings E2E pattern,
   `tests/e2e/ui/settings.spec.ts`).

---

## §7 Baseline / after (filled by P0 / P3.2)

| State | Metric | Baseline (dev) | Baseline (prod) | After P1 | After P2 |
|---|---|---|---|---|---|
| *(populated by the harness — renders/s, wakeups/min, animations running, long tasks/min, paint events/s, OS energy)* | | | | | |

---

## §8 Non-goals / explicitly rejected

- **Server-side stream coalescing** — already tried and rejected for UX latency reasons
  (`reduce-server-cpu-experiment-stream-coalescing.md`); FX7 does it client-side at the
  visual layer only.
- **Removing the bobbit sprite system** — it is the product's personality
  ([bobbit-sprites.md](../bobbit-sprites.md)). FX2 makes it *more* meaningful, not less
  present.
- **A WebGL/canvas renderer rewrite** — not justified by any current evidence; revisit only
  if P3.2 data demands it.

Cross-references: [time-and-token-cost-efficiency.md](time-and-token-cost-efficiency.md) (the sibling
"instrumentation-first" effort, server/cost side), [mission-control.md](mission-control.md)
(the Observer staff can watch for perf regressions once the harness exists),
[harness-gap-analysis.md](harness-gap-analysis.md) §battery for how peer harnesses avoid this
class of cost (mostly by being TUIs — Bobbit's bar is higher because it ships a real UI).
Execution tracking: [fable-program-execution-plan.md](fable-program-execution-plan.md).

---

## Appendix A — Implementation contracts (definite lists; do not re-derive)

The universal definition-of-done in
[extension-platform-implementation-plan.md §0](extension-platform-implementation-plan.md)
applies to every phase here. This appendix removes the remaining judgment calls.

### A.1 Complete `infinite`-animation inventory and classification

Source of truth: `grep -rn "animation:.*infinite" src --include=*.css` (re-run before
starting; if new rules appeared, classify them with the same three buckets and extend this
table in the same PR).

Buckets: **ambient** = pause under `html.anims-paused` (P1 step 2) · **status** = must run
*only* under a working/busy state selector (P1 step 3) · **keep** = semantically must keep
running (rare; justify inline).

| File:line | Keyframes | Bucket | Note |
|---|---|---|---|
| `src/app/app.css:108` | `status-pulse` | status | also FX3: rewrite off `box-shadow` |
| `src/app/app.css:478` | `gentle-float` | ambient | empty-state decoration |
| `src/app/app.css:943` | `unseen-dot-pulse` | ambient | FX3 rewrite; already has reduced-motion opt-out — keep |
| `src/app/app.css:967` | `bobbit-unread-tap` | ambient | |
| `src/app/app.css:985` | `bobbit-sidebar-unread-blink` | ambient | `steps()` — cheap but still wakes compositor |
| `src/app/app.css:1007` | `sidebar-heartbeat` | status | |
| `src/app/app.css:1026` | `sidebar-conic-spin` | status | spinner — runs only while loading; verify it unmounts |
| `src/app/app.css:1064,1075` | `gate-wave`, `gate-blink` | status | gate in-progress only |
| `src/app/app.css:1102` | `title-wave` | ambient | |
| `src/app/app.css:1111` | `pr-conflict-pulse` | ambient | FX3 rewrite |
| `src/app/goal-dashboard.css:781,1039` | `phase-glow`, `phase-glow-rejected` | status | dashboard visible + phase active only |
| `src/app/goal-dashboard.css:793,1070` | `phase-dot-pulse` | status | |
| `src/app/goal-dashboard.css:796` | `status-indicator-pulse` | status | |
| `src/app/goal-dashboard.css:944` | `gate-dot-pulse` | status | |
| `src/ui/app.css:1117,1140` | `shimmer` ×2 | ambient | loading placeholder; disabled entirely in battery-saver |
| `src/ui/app.css:1166` | `ask-heartbeat` | status | pending-ask only |
| `src/ui/app.css:1239,1411,1412,1521,1586+` | `blob-busy-*` family (move/eyes/shadow) | status | already gated on the busy blob — verify the element unmounts when idle |
| `src/ui/app.css:1526,1669` | `blob-*-idle-sleep-breathe` | **ambient** | the idle/sleep "breathing" loops — these are the FX2 headline: idle sprites must be static |
| `src/ui/app.css:1555,1700,1775,…` | `blob-compact-squash(-rigid)` (all ~10 sites) | ambient | several use `!important` — remove the `!important` when adding the gate |
| `src/ui/app.css:1755–2089` | `magnifier-depth-idle` (×7), `wand-depth-idle` | ambient | accessory idle loops |
| `src/ui/app.css:2041,2050` | `flask-bubbles` ×2 | ambient | |
| `src/ui/app.css:2154,2165` | `wand-sparkle-a/b` | ambient | |
| `src/app/app.css:359–474` | `bobbit-bob`, `bobbit-breathe`, `bobbit-eyes(-s)`, squish family | status | sidebar/chat sprites: working state only (FX2) |

### A.2 `animation-power.ts` contract

```ts
// src/app/animation-power.ts
export function initAnimationPower(): void; // called once from main.ts after state init
// Internally:
//   shouldPause = document.hidden
//     || !anySessionWorking()          // derive from state.gatewaySessions statuses
//     || isBatterySaverOn()            // P3.3; returns false until that phase lands
//     || matchMedia("(prefers-reduced-motion: reduce)").matches
//   → document.documentElement.classList.toggle("anims-paused", shouldPause)
// Inputs: "visibilitychange" listener + a state subscription invoked from the same
// place session status updates already call renderApp(). No polling. No timers.
// Perf-flag: if isPerfFlagEnabled("-pauseAmbientAnims") → never add the class.
```

CSS gate (one block per file, appended at end):
`html.anims-paused :is(<every ambient selector from A.1>) { animation-play-state: paused; }`
Never use a bare `html.anims-paused *` rule — it would freeze one-shot transitions mid-flight.

### A.3 `perf-monitor` report shape

```ts
// window.__bobbitPerf.report() →
{ windowMs: number,
  rendersPerSec: number,            // renderApp rAF executions
  timerWakeups: { perSec: number, byCallsite: Record<string, number> },
  longTasks: { count: number, totalMs: number },
  runningAnimations: number,        // document.getAnimations().length, last sample
  wsFramesPerSec: Record<string, number> }   // keyed by frame type
```

### A.4 Poll-site checklist (the loops; one-shots are out of scope)

| Site | Today | Required end state |
|---|---|---|
| `src/app/api.ts:273` `startSessionPolling` | 5 s, visibility-gated | FX5: 60 s while WS healthy; 5 s only while WS down; refresh on reconnect + visible |
| `src/app/goal-dashboard.ts:1090` `startLiveVerifTimer` | 1 s full `renderApp()` | FX6: scoped elapsed-label update only |
| `src/app/render-helpers.ts:338` | 60 s `renderApp()` | keep (within budget) |
| `src/app/session-manager.ts:2821` git-status poll | 30 s, gated, coalesced | keep — this is the reference pattern |
| remaining `setInterval` loops in `goal-dashboard.ts` / `dialogs.ts` | unaudited | P2.4: classify from the P0 wakeup report; loops get the git-status pattern |

### A.5 Owned files per phase (PR boundaries)

- **PB-P0**: new `src/app/perf-monitor.ts`; one guarded hook line in `state.ts::renderApp`;
  baseline table in this doc. No behavior change.
- **PB-P1**: new `src/app/animation-power.ts`; `main.ts` (one init call); the four CSS files
  in A.1; new `tests/e2e/ui/animation-power.spec.ts`; CSS-pinning unit test
  `tests/animation-gate.test.ts` (regex: every `infinite` rule in the four files is either
  bucket-listed here or fails).
- **PB-P2**: `api.ts`, `goal-dashboard.ts`, `state.ts` (`renderAppThrottled`), streaming
  dispatch call sites in `session-manager.ts`/`message-reducer.ts`; tests beside each.
- **PB-P3**: settings page + `animation-power.ts` (battery-saver input); docs.
