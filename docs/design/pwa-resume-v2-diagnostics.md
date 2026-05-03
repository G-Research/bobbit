# PWA Resume v2 — Diagnostic Methodology

Status: **active** — instrumentation only. No production behaviour change.

This document defines **how** we measure iOS PWA resume before designing
any fix. The previous attempt (PR #450 + 6 follow-ups, then reverted)
layered defenses without first establishing where the time was going.
That mistake is not repeated here: every design decision in PWA Resume
v2 must be traceable back to a number captured by the methodology
described below.

## 1. Goal of the diagnostic phase

Answer four questions, with real numbers from a real iOS device:

1. **Where does the time go on iOS PWA resume?** Break time-to-interactive
   into HTML fetch, JS chunk fetch, JS parse/execute, gateway auth
   (`waitForGateway`), preferences fetch, WS connect, first session
   fetch, first paint of session content.
2. **What does iOS actually do on resume?** Is the JS context killed
   (full cold boot) or frozen (bfcache-style restore)? Does that change
   with time-since-suspension? How does the SW behave (active vs needs
   activation)? Does the WS socket survive in any state?
3. **Why is the cold-boot bundle reduction (PR #461, -64% gz) not
   enough?** Identify the dominant remaining cost: network, gateway
   auth, WS handshake, or transcript hydration.
4. **What's the irreducible minimum?** Given platform constraints (SW
   activation, HTML parse, JS execute), what is the fastest possible
   time-to-paint? This sets the realistic acceptance bar.

The output of this phase is the diagnostic report appended to this
document (or to the PR description) once measurements are in.

## 2. Instrumentation surface

A tiny helper, [`src/app/perf.ts`](../../src/app/perf.ts), wraps the
User Timing API (`performance.mark` / `performance.measure`). All marks
share the prefix `bobbit:` so they're easy to filter in Safari Web
Inspector's Timelines pane.

### 2.1 Always-on marks

These are stamped on every boot regardless of opt-in. Cost is a single
`performance.mark()` call (a few µs); leaving them in production is
free.

| Mark name                     | Site                                     | Meaning                                               |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `main:module`                 | top of `src/app/main.ts`                 | Module evaluation began (earliest reachable JS time). |
| `init:start`                  | first line of `initApp()`                | Bootstrap function entered.                           |
| `init:first-render`           | before initial `renderApp()`             | About to paint disconnected/starting shell.           |
| `init:first-paint`            | after initial `renderApp()`              | UI shell handed to the renderer (paint imminent).     |
| `init:gateway-wait-start`     | before `waitForGateway`                  | Begin blocking auth probe loop.                       |
| `init:gateway-wait-end`       | after `waitForGateway`                   | Gateway acknowledged auth.                            |
| `init:prefs-loaded`           | after `/api/preferences`                 | Palette / timestamps applied.                         |
| `ws:construct`                | initial `new WebSocket(...)`             | Initial WS handshake initiated.                       |
| `ws:open`                     | initial `ws.onopen`                      | TCP+TLS+upgrade complete; auth frame sent.            |
| `ws:auth-ok`                  | initial `auth_ok` received               | Server accepted the session.                          |
| `ws:reconnect-construct`      | reconnect path                           | Reconnect attempt initiated.                          |
| `ws:reconnect-open`           | reconnect path                           | Reconnect socket open.                                |
| `ws:reconnect-auth-ok`        | reconnect path                           | Reconnect resumed.                                    |
| `pageshow:fresh`              | `pageshow` (persisted=false)             | Cold load / context killed.                           |
| `pageshow:persisted`          | `pageshow` (persisted=true)              | bfcache restore (rare on iOS PWA, telling when seen). |
| `visible`                     | `visibilitychange → visible`             | Tab/PWA returned to foreground.                       |

### 2.2 Opt-in console reporting

Reporting is gated to avoid noise in normal sessions. Enable either:

- URL: `?perf=1`
- Persistent: `localStorage.setItem('bobbit-perf','1')` then reload.

When enabled, `perf.ts` logs a `console.table` digest at `pageshow`,
each `visible` transition, and on demand via
`window.__bobbitPerf.dump()`. The table includes absolute time-since-
navigation-start and per-mark deltas, so you can read the breakdown at
a glance in Safari Web Inspector's console.

### 2.3 Web Inspector workflow (iOS)

This is the canonical capture procedure used for every iOS measurement
in §4. Synthetic Lighthouse runs are **not** acceptable — they don't
reproduce iOS's PWA-suspension lifecycle.

1. Settings → Safari → Advanced → enable **Web Inspector**.
2. Plug device into a Mac. Open Safari → Develop → `<device name>` →
   the running PWA. (PWAs appear here as separate web views once
   installed to home screen.)
3. In Web Inspector:
   - **Network** tab: clear, enable "Preserve Log".
   - **Timelines** tab: select Script, Layout & Rendering, JavaScript
     & Events, Network. Click record before triggering resume.
   - **Console**: ensure the page has `?perf=1` so the auto-dump fires.
4. Trigger the resume scenario (see §3). On resume foreground:
   - Stop the timeline.
   - Screenshot the network waterfall.
   - Save `window.__bobbitPerf.snapshot()` JSON output.

Capture artefacts go in the PR description under a "Diagnostic
captures" section, one block per scenario.

## 3. Test scenarios

Reproducible scenarios are required so v2's design can be validated
against the same conditions the diagnostic identified. **Author's
device** for the canonical capture — record device model and iOS
version in each report.

| ID  | Pre-state                              | Action                            | What it tells us                                       |
| --- | -------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| C0  | Browser cold (PWA not installed)       | First load                        | Baseline cold-boot cost in browser (control).          |
| C1  | PWA installed; never opened in session | Tap home-screen icon              | First-launch cost from icon.                           |
| R1  | PWA open, screen lock 1 min            | Unlock & focus PWA                | Short-suspension resume — JS likely frozen.            |
| R10 | PWA open, screen lock 10 min           | Unlock & focus PWA                | Mid-suspension — context likely killed.                |
| R60 | PWA open, screen lock 60 min           | Unlock & focus PWA                | Long-suspension — definitely cold.                     |
| RA  | PWA open, switch to other app 30s      | Swipe back to PWA                 | App-switcher resume (no lock screen).                  |
| RN  | PWA open, kill via app switcher        | Reopen from home screen           | Forced cold launch — distinguishes "cold boot" from    |
|     |                                        |                                   | "resume". Compare to R60 to confirm R60 ≈ cold.        |

Each scenario reports four numbers, derived from the marks above:

- **TTFP-shell** = `init:first-paint` − navigationStart.
  Time until *something* is on screen.
- **TTGW** = `init:gateway-wait-end` − `init:gateway-wait-start`.
  Cost of `waitForGateway`.
- **TT-WS-ready** = `ws:auth-ok` − navigationStart (or `ws:reconnect-auth-ok`).
  Time until the server can stream us session content.
- **TTI** = paint of session content (capture via screen recording;
  Safari paint mark is unreliable on iOS for SPA route changes).

## 4. Reporting template

Append measurements as a new section once captures are complete. Until
then, the table below is empty by design — committing speculative
numbers would defeat the purpose of the methodology.

```
### Device: <model> · iOS <version> · build <git sha>

| Scenario | TTFP-shell | TTGW   | TT-WS-ready | TTI     | Notes |
| -------- | ---------- | ------ | ----------- | ------- | ----- |
| C0       |            |        |             |         |       |
| C1       |            |        |             |         |       |
| R1       |            |        |             |         |       |
| R10      |            |        |             |         |       |
| R60      |            |        |             |         |       |
| RA       |            |        |             |         |       |
| RN       |            |        |             |         |       |
```

For each scenario the report should also note: was the SW already
active, or did it need activation? Did `pageshow` fire with
`persisted=true` (extremely informative if it ever happens on iOS PWA)?
Did the WebSocket re-use an existing socket or open a new one?

## 5. Decision criteria

Only after §4 is filled may v2 design proceed. The diagnostic must
produce, at minimum:

- A ranked list of dominant costs across scenarios.
- A statement of whether the bottleneck is shared between cold (C1) and
  resume (R10/R60) — if yes, one fix may address both.
- A floor estimate (the irreducible minimum) so the ≤500 ms acceptance
  bar can be validated as physically reachable.

Any v2 mechanism that the previous attempt removed (persisted UI
snapshot, inline skeleton, prepaint, render watchdog, heartbeat-gap
bypass, force-close-on-pageshow) may only be reintroduced if the
diagnostic explicitly identifies it as the only mechanism that closes
the dominant gap. The default answer is "no".

## 6. What this PR ships

- `src/app/perf.ts` — ~150 LOC helper, no deps, behaviour-neutral.
- Marks at the boot points enumerated in §2.1.
- `pageshow` / `visibilitychange` capture + `window.__bobbitPerf`
  console surface.
- This document.

It deliberately ships **no** production behaviour change, no UI
change, and no new tests beyond what `npm run check` /
`npm run test:unit` already cover. The next task in the goal will use
the data captured with this instrumentation to scope the v2 design.
