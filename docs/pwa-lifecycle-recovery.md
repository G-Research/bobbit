# iOS PWA grey-screen recovery

## The problem

When Bobbit is installed as a standalone PWA on iOS and the user relaunches it
after it has been backgrounded, the app frequently comes up as a **blank
dark-grey screen** — the manifest `background_color` (`#2b2d2b`) with no UI. The
only user-facing workaround was to open the app switcher, kill the app, and
relaunch it.

This is the classic iOS standalone-PWA lifecycle bug. When the app is
backgrounded, iOS may **freeze** the WebKit process (the Page Lifecycle
"frozen" state) or outright **kill** it to reclaim memory. On relaunch iOS
brings forward a *dead or frozen page snapshot*: the JS event loop was suspended
mid-flight, the render loop and WebSocket are dead, and the page is stuck
painting only the background color because the app either never (re-)mounted, or
mounted on a previous run but its reactive machinery never resumed.

### Why this is NOT a WebSocket reconnect problem

Bobbit already has visibility-driven reconnect/resync logic that recovers a dead
WebSocket on a **live** page:

- `_onVisibilityChange` in `src/app/remote-agent.ts`
- the `visibilitychange` handler in `src/app/main.ts`

Those handlers assume there is still live JS running that can notice the socket
is dead and reconnect/resync it. The grey screen happens *earlier* than that:
the page itself never came back to life, so there is no live JS to run a
reconnect. The two concerns are **disjoint** and must not be conflated — see
[Division of labor](#division-of-labor) below.

## The solution: client-side lifecycle recovery

The recovery logic lives in `src/app/pwa-lifecycle.ts`, wired from
`src/app/main.ts`, with one inline backstop in `index.html`. The strategy is to
detect that iOS has handed us a dead/frozen snapshot and force a clean
`location.reload()` so the app re-bootstraps from scratch.

It uses **three independent, mutually-reinforcing mechanisms**, all gated to
standalone display mode so normal browser tabs and the dev server are never
reloaded. Layering exists because iOS's Page Lifecycle support is partial and
inconsistent across versions; no single signal is reliable on its own, so each
mechanism covers a failure mode the others miss.

### Standalone gating

Every listener and timer early-returns unless `isStandalone()` returns true.
`isStandalone()` checks `matchMedia("(display-mode: standalone)")` (Chromium and
modern iOS) **or** the legacy `navigator.standalone` flag (older iOS Safari).
This is essential: the recovery reloads would be actively harmful in a normal
browser tab (where the user can refresh manually) and in the dev server (where
Vite HMR drives reloads). Gating keeps the behavior scoped to exactly the
installed-PWA context that exhibits the bug.

### Mechanism 1 — bfcache / frozen-restore detection

A `pageshow` listener checks `event.persisted`. When a page is restored from the
back/forward cache (or an analogous frozen restore), `persisted === true`. In
standalone mode that restore is treated as inherently suspect — the snapshot may
be dead — so we force a reload to re-bootstrap from scratch.

This path is inherently loop-safe: the reloaded page is a *fresh* navigation, so
its next `pageshow` fires with `persisted === false` and does not re-trigger.

### Mechanism 2 — bounded resume-staleness probe

This is the subtle case: the app *did* mount on a previous run (so `#app` has
content and mechanism 3 sees nothing wrong), but iOS froze the JS event loop and
on resume the reactive machinery never restarts. The page looks painted but is
dead.

A standalone PWA does **not** run a permanent lifecycle heartbeat. Instead, each
resume signal starts bounded work: one liveness `requestAnimationFrame` and one
delayed probe (currently 1.5 seconds). If the frame runs, its timestamp proves
that the event loop resumed. When the delayed probe runs, it asks whether that
one frame was observed after this resume. A qualifying long-suspended mounted
page whose frame never arrives is treated as a frozen snapshot and reloaded.

Each probe owns a monotonic generation and its own liveness observation. A newer
resume cancels the previous frame and timer; even if a cancelled callback is
later delivered, its stale generation cannot satisfy, clear, or complete the
newer probe. The timer also cancels a still-pending frame before making the
reload decision. Environments without rAF record one local liveness observation
instead of creating fallback recurring work.

Suspend/resume is tracked redundantly via `pagehide`, `freeze`, `resume`, and
`visibilitychange` to cover iOS's partial Page Lifecycle support — whichever
event actually fires marks when the page went hidden and triggers the resume
probe.

The "should I reload?" decision is factored out as the **pure, unit-testable**
`shouldReloadOnResume()` (no DOM, no globals). Its rules, in order:

1. **Loop guard (overrides everything)** — within the cooldown window of the
   last reload → never reload.
2. **Dead bootstrap** — nothing painted (`!appMounted`) → reload.
3. **Mounted-but-frozen snapshot** — the page is mounted AND the suspend was
   *long* (gap ≥ stale threshold) AND this resume did **not** observe a live
   frame → reload.
4. **Otherwise** → don't reload. In particular, a mounted page that observes a
   frame after resume is treated as **alive** and is never reloaded, regardless
   of how long the suspend was.

The long-suspend requirement (stale threshold, currently 30 minutes) exists so
that ordinary quick tab switches — where the page is still alive and the
existing visibility-resync handles any dead socket — never trigger a reload.
Only a long suspend *combined with* a stalled one-shot probe is treated as a
frozen snapshot.

#### Lifecycle callback budget

The bounded design keeps iOS recovery while removing foreground wakeups that do
not contribute to a recovery decision. In the controlled diagnosis, the old
60 Hz heartbeat produced about 1,200 callbacks per 20 seconds; the replacement
has no steady-state lifecycle callbacks:

| State | Lifecycle rAF work | Probe timer work | Reload outcome |
|---|---:|---:|---|
| Visible standalone steady state | 0 | 0 | None |
| One healthy resume | At most 1 request and 1 callback | 1 callback | None |
| One stalled resume | 1 request and no observed callback | 1 callback | At most 1 guarded reload |
| Competing resumes | Bounded per signal; older callbacks are inert | Only the newest may complete | At most 1 guarded reload |

These are callback budgets for the lifecycle recovery module, not global page
budgets. Rendering, WebSocket recovery, and the inline boot watchdog retain
their separate owners.

### Mechanism 3 — inline boot watchdog

A small inline script in `index.html` (not in the module bundle) records
`__bobbitBootStart` and schedules a watchdog `setTimeout`. It is inline on
purpose: the module chunk itself can be slow to load or frozen on resume, so the
backstop must not depend on any module having executed.

A `setTimeout` scheduled before an iOS freeze is *paused* during the freeze and
*resumes* firing after unfreeze. So if iOS brings forward a page that was frozen
mid-bootstrap, the watchdog fires shortly after resume, sees that `#app` still
has no children (nothing painted), and forces one reload. Like the other
mechanisms it is gated on standalone mode and skips when the page is hidden.

`markAppBooted()` in `pwa-lifecycle.ts` (called from `main.ts`) clears this
watchdog — but **only once `#app` actually has child content**, never on a
timing assumption. `renderApp()` defers the real Lit render to a
`requestAnimationFrame`, so the `markAppBooted()` call site fires while `#app` is
still empty. If we cleared the watchdog there and iOS froze the page between that
call and the deferred render, we would disable the grey-screen backstop. So
`markAppBooted()` finalizes immediately if `#app` already has children, otherwise
attaches a `MutationObserver` and finalizes on the first child insertion. In the
true grey-screen case where `#app` never populates, the observer never fires, the
watchdog stays armed, and it reloads on timeout.

## Loop guard / cooldown

All three mechanisms funnel forced reloads through a single guard so the app
reloads **at most once per genuine freeze/kill recovery**, never in a loop:

- A `sessionStorage` key, `bobbit-pwa-reload-at`, records the timestamp of the
  last forced reload. Any reload within the cooldown window (currently 10s) is
  suppressed. `sessionStorage` is used (not an in-memory flag alone) because a
  real `location.reload()` tears down the JS module and resets in-memory state —
  the timestamp must survive the reload to break a potential loop. The inline
  `index.html` watchdog reads and writes the same key, so all paths share one
  guard.
- A module-level `reloaded` flag short-circuits redundant reloads within a single
  page lifetime (before the navigation actually happens).

## Division of labor

This is the single most important thing to preserve when touching this code:

| Concern | Page state | Owned by |
|---|---|---|
| Dead/frozen page never came back to life | **DEAD / FROZEN** | `src/app/pwa-lifecycle.ts` (this feature) |
| Dead WebSocket on a still-running page | **LIVE** | `_onVisibilityChange` in `remote-agent.ts` + `visibilitychange` handler in `main.ts` |

`pwa-lifecycle.ts` recovers a page that is *not running* — there is no live JS to
reconnect a socket, so the only fix is a full reload. The visibility-resync
handlers recover a *live* page whose socket died while backgrounded — reloading
there would be wasteful and would risk duplicate-message bugs (see the detailed
comments in `_onVisibilityChange`).

A live page whose one-shot resume frame is observed is explicitly treated as
alive by `shouldReloadOnResume()` and is **never** reloaded by this feature —
that case belongs entirely to the visibility-resync handlers. Do not add a
reload path for the live-page case here, and do not add socket-reconnect logic
to `pwa-lifecycle.ts`.

## Testing

Automated tests use the real lifecycle module with injected clocks and browser
signals. They assert decisions and callback counts; they do not use battery
runtime or cross-machine timing thresholds.

- **DOM lifecycle coverage** — `tests/dom/pwa-lifecycle.dom.test.ts` imports the
  real `shouldReloadOnResume()` and pins cooldown precedence and boundaries,
  dead bootstrap, healthy and stalled long resumes, quick suspend, and missing
  hidden timestamp. Its fake rAF/timer harness also pins zero work on visible
  installation; exact one-frame/one-timer healthy, quick, and stalled budgets;
  generation isolation under force-delivered stale callbacks; one guarded
  reload; and no later work after the module reload guard trips.
- **Browser lifecycle coverage** —
  `tests/browser/fixtures/pwa-lifecycle.fixture.spec.ts` injects standalone mode before
  app scripts run and observes reload requests through
  `window.__bobbitReloadHook`. It covers persisted `pageshow`, same-instance and
  real-reload cooldown, non-standalone gating, quick visibility recovery,
  document-level `freeze`/`resume` wiring, and boot-watchdog clearing after
  `#app` receives content.

True installed-iOS freeze, process reclamation, and relaunch behavior cannot be
established by headless Chromium. Retain manual verification on a real iOS
device: check a quick background/relaunch remains responsive without an
unnecessary recovery, then check a greater-than-30-minute suspend or
freeze/kill/relaunch recovers without requiring the user to terminate the PWA.
This device pass remains required when changing recovery timing or event wiring.

## Key files

- `src/app/pwa-lifecycle.ts` — all three mechanisms, the pure
  `shouldReloadOnResume()` decision, `isStandalone()`, the bounded resume probe,
  and `markAppBooted()`.
- `src/app/main.ts` — calls `installPwaLifecycleRecovery()` and `markAppBooted()`
  during bootstrap; also clears the inline watchdog under Vite HMR so it never
  fights dev full-reloads.
- `index.html` — inline boot watchdog (mechanism 3) and the boot skeleton.
- `public/sw.js` — network-first service worker; intentionally *not* part of the
  recovery, but relevant because its caching strategy must not serve a stale page
  that contributes to a dead restore (it is network-first precisely to avoid
  that class of "stuck UI" bug).
- `public/manifest.json` — `display: standalone`, `background_color: #2b2d2b`
  (the grey the user sees).
