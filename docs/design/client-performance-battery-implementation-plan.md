# Client Performance & Battery — Implementation Plan (hand-off)

Status: ready for execution, not started. Workstream **PB** in
[fable-program-execution-plan.md](fable-program-execution-plan.md).

Companion to [client-performance-battery.md](client-performance-battery.md) (the WHAT/WHY —
read §1–§6 and **Appendix A**; its A.1 animation table and A.4 poll table are the definite
work lists).

> **Anchor baseline:** fable-docs @ 2026-06-11 (master parent `6ec8c8f9`). Locate by symbol
> name; missing symbol ⇒ STOP, re-derive from the cited pattern.
>
> **Precision policy:** all goals file/function level (this workstream touches few files).
>
> **Universal rules:** [extension-platform-implementation-plan.md §0](extension-platform-implementation-plan.md)
> + [fable-program-execution-plan.md §1](fable-program-execution-plan.md). **Seam guard:**
> PB-P2a must land AFTER SN-T2/T3, and PB-P2c after (or rebased onto) SN-T5 — see the
> execution plan §1.4 table; check the §4 checklist before starting those goals.
>
> **Measurement discipline:** no behavior-affecting goal merges without before/after
> numbers from the PB-P0 harness in the PR description, and the doc's §7 table updated in
> the same PR.

---

## Goal map

```
PB-P0 harness ─→ PB-P1a anim gating ─→ PB-P1b paint-prop rewrites
            └─→ PB-P2a poll demotion (after SN-T2/T3) · PB-P2b scoped tick ·
                PB-P2c render throttle (after SN-T5) · PB-P2d timer audit
PB-P1 + PB-P2 ─→ PB-P3 battery saver + flag soak + re-baseline
```

---

## PB-P0 — Measurement harness

**Outcome:** `window.__bobbitPerf.report()` returns the Appendix A.3 shape in all four §4
protocol states; baseline table committed. Zero default-path behavior change.

**Owned files:** NEW `src/app/perf-monitor.ts`; `src/app/state.ts` (ONE guarded line in
`renderApp()`, symbol at `state.ts:687`); `src/app/perf-flags.ts` (flag registration only);
doc §7 table; NEW `tests/perf-monitor.spec.ts` (browser fixture).

**Steps**

1. `perf-monitor.ts` per Appendix A.3: render counter (incremented from the guarded hook
   inside `renderApp`'s rAF callback — read how `_renderScheduled` works first), timer
   wrap (monitor mode only: wrap `window.setInterval`/`setTimeout`, bucket by
   `new Error().stack` top app frame), `PerformanceObserver longtask`,
   `document.getAnimations().length` sampled 1/s, WS frames/s by type (hook the client WS
   dispatch — find the single switch over frame types in `src/app/`).
2. Activation: only when `bobbitPerfFlags` contains `+perfMonitor`
   (`isPerfFlagEnabled` — read `perf-flags.ts` and `docs/perf/defer-offscreen-render.md`
   for the conventions). Module must not be imported on the default boot path — lazy
   `import()` behind the flag check in `main.ts`.
3. Run the §4 protocol (4 states × 60 s × 3 runs × dev+prod) **manually**, fill the doc §7
   baseline columns, include the OS-level energy reading (§4 step 4).

**Tests:** browser fixture — flag off ⇒ `window.__bobbitPerf` undefined *(GREEN pins the
default path)*; flag on ⇒ report returns every A.3 field with sane types *(RED)*.

**Acceptance:** baseline table filled in the same PR; `npm run test:unit` green.

---

## PB-P1a — Ambient animation gating

**Outcome:** idle-or-hidden Bobbit runs **zero** animations
(`document.getAnimations().length === 0`); working agents still animate.

**Owned files:** NEW `src/app/animation-power.ts`; `src/app/main.ts` (one init call);
`src/app/app.css`, `src/app/goal-dashboard.css`, `src/ui/app.css` (gates per the A.1
table); NEW `tests/e2e/ui/animation-power.spec.ts`, `tests/animation-gate.test.ts`.

**Steps**

1. Re-run the A.1 grep; reconcile drift (new rules ⇒ classify + extend the table in this
   PR — execution plan §1.2).
2. `animation-power.ts` per Appendix A.2 **exactly**: inputs are `visibilitychange`, the
   session-status update path (find where `state.gatewaySessions` statuses are written —
   `api.ts` `updateLocalSessionStatus` and the `refreshSessions` apply step — and call a
   re-evaluate from there), `prefers-reduced-motion` media query listener, and (later)
   battery-saver. Output: toggle `anims-paused` on `document.documentElement`. No timers.
3. CSS: for every **ambient** row in A.1, add the pause guard
   (`html.anims-paused <selector> { animation-play-state: paused; }` grouped in one block
   per file); for every **status** row, move/confirm the animation under its
   working-state selector so it doesn't run at idle (the `blob-*-idle-sleep-breathe`
   loops are the flagship: idle/sleep sprites become static frames). Remove `!important`
   from `blob-compact-squash*` while adding gates. NEVER a bare `html.anims-paused *`
   rule (A.2 freeze hazard).
4. Flag: `-pauseAmbientAnims` restores current behavior (gate the class-toggle, not the
   CSS).

**Tests (author first):**

- `tests/animation-gate.test.ts` (node): parse the three CSS files; every
  `animation:.*infinite` rule must match an A.1 bucket: ambient ⇒ a pause guard exists
  for its selector; status ⇒ selector includes a state class; else FAIL ("the missing
  test IS the bug" — this is the never-reintroduce pin). *(RED)*
- Browser E2E: all-idle fixture ⇒ class present + `getAnimations()` = 0; mock agent
  working ⇒ its sprite animates and count > 0; tab hidden ⇒ 0; flag opt-out restores.
  *(RED)*

**Acceptance:** E2E + pin green; harness shows idle-foreground animations 0 and paint
events <2/s; visual check: working sprites unchanged (record before/after GIF in PR).

## PB-P1b — Paint-property rewrites + reduced-motion sweep

**Owned files:** `src/app/app.css` only. **Steps:** rewrite `status-pulse`,
`unseen-dot-pulse`, `pr-conflict-pulse` to opacity/transform on a pseudo-element halo
(FX3 — visually equivalent: pre-rendered shadow layer scaling/fading); add the blanket
reduced-motion rule (FX4) and delete the now-redundant piecemeal opt-outs (grep
`prefers-reduced-motion`, currently 9 sites). **Tests:** extend `animation-gate.test.ts`:
no `@keyframes` in the three files may animate `box-shadow` *(RED until rewritten)*.
**Acceptance:** pin green; screenshots before/after in PR.

---

## PB-P2a — Session-poll demotion *(after SN-T2/T3 — verify §4 checklist first)*

**Owned files:** `src/app/api.ts` (`startSessionPolling`, symbol near `api.ts:273`, plus
the WS-health signal); NEW `tests/session-poll-policy.test.ts`.

**Steps:** extract interval selection into a pure
`sessionPollIntervalMs({wsConnected, visible})` → 60 000 when WS healthy, 5 000 otherwise
(read how the client tracks WS connection state first — reuse, don't add a tracker);
immediate `refreshSessions()` on WS reconnect and on `visibilitychange`→visible (the
git-status catch-up pattern, `session-manager.ts` near `startGitStatusPoll`). Rebase onto
SN-T2's coalescing/generation guard — do not reimplement any part of it.

**Tests:** pure-function unit table *(RED)*; existing
`tests/spurious-idle-unread.spec.ts` green unmodified. **Acceptance:** harness:
idle-foreground network ≤1 sessions fetch/min with WS up; status updates still arrive
(WS push path) — E2E asserts a status change renders without a poll tick (fake timers).

## PB-P2b — Scoped verification tick

**Owned files:** `src/app/goal-dashboard.ts` (`startLiveVerifTimer`, symbol near `:1090`).
**Steps:** the 1 s `setInterval(() => renderApp(), 1000)` becomes a scoped updater writing
`textContent` on the elapsed-time node(s) only (give them a stable
`data-testid="verif-elapsed"`); status *transitions* still arrive via the existing WS/event
path and call `renderApp()` as today; keep `stopLiveVerifTimerIfDone` semantics.
**Tests:** browser E2E — while a mock verification runs, elapsed label advances ≥2 s while
the perf-monitor render counter advances 0 in the same window; timer stops when the run
ends *(RED)*. **Acceptance:** dashboard suites green unmodified.

## PB-P2c — Streaming render throttle *(after/rebased on SN-T5)*

**Owned files:** `src/app/state.ts` (add `renderAppThrottled(ms = 100)` beside `renderApp`,
reusing `_renderScheduled`/suppression machinery — trailing edge, max one render per
window); the streaming dispatch call sites (`message_update`-class frames in the client WS
switch; terminal frames keep plain `renderApp()`). Flag `-throttleStreamRender`.
**Tests:** unit — burst of N calls in 100 ms ⇒ 1 render, trailing call lands; terminal
frame flushes immediately *(RED)*. Browser E2E — long mock stream: perf-counter ≤15
renders/s; `follow-tail` suites green unmodified. **Acceptance:** harness streaming state
~10 Hz; no visible degradation (manual check noted in PR).

## PB-P2d — Timer audit

**Owned files:** convicted loops only (expect `goal-dashboard.ts`, `dialogs.ts`).
**Steps:** run PB-P0's wakeup-by-callsite report in the idle + dashboard states; commit the
table into the doc (§F2 update, same PR); every surviving loop ≥1 tick/min gets the
git-status pattern (visibility gate + event coalescing + self-cancel). One PR may fix
several loops if each has its own test. **Acceptance:** idle-foreground wakeups <8/min on
the harness; doc table updated.

---

## PB-P3 — Battery saver + flag soak + re-baseline

**Owned files:** settings page (pattern `tests/e2e/ui/settings.spec.ts`),
`animation-power.ts` (battery-saver input), `api.ts`/`state.ts` (cadence overrides), doc
§7 after-table; flag removals per `docs/perf/defer-offscreen-render.md` §"when to remove".

**Steps:** (1) `batterySaver` setting (persisted with other UI settings): forces
`anims-paused`, poll 120 s, throttle 250 ms, shimmer off. (2) `navigator.getBattery()`
suggestion banner when discharging — suggest only, never auto-enable; dismissal persists.
(3) Remove soaked temporary flags (keep `anims-paused` as mechanism). (4) Re-run the full
§4 protocol; fill §7 after-columns + OS energy reading; only then evaluate whether any §3
target is still missed (heavier options stay out of scope unless data convicts — doc §8).

**Tests:** browser E2E — toggle persists across reload; saver state pauses animations
while a mock agent works (overrides status animations); banner dismissal persists. *(RED)*

**Acceptance:** §3 targets table met on the harness (idle-foreground: 0 animations,
<2 paint/s, <8 wakeups/min, ≈0% CPU; hidden: 0 renders, ≤1 poll/min; streaming ~10 Hz,
no >50 ms render long-tasks; dashboard: no full-tree render/s) — or a doc deviation note
explaining the miss and the follow-up goal.
