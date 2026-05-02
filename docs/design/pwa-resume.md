# Production-grade PWA resume — Design Doc

**Goal**: returning to the Bobbit PWA — especially after iOS suspends/evicts the WebKit process — must paint the last-known UI in the first frame and reconcile silently. Force-quit + relaunch must never be required, and the user must never stare at a blank screen.

**Scope**: client-side only. Bootstrap (`src/app/main.ts`), persistence (`src/app/ui-snapshot.ts`), service worker (`public/sw.js`), boot HTML (`index.html`), and `RemoteAgent` lifecycle (`src/app/remote-agent.ts`). Server, reducer, and WS protocol unchanged.

> Companion to [streaming-dedup-reorder.md](streaming-dedup-reorder.md) and [unified-message-ordering-reducer.md](unified-message-ordering-reducer.md). The new snapshot path *dispatches into* the existing reducer rather than maintaining a parallel merge — see §4.

---

## 1. Problem

User-facing symptom on iOS PWA install (Add to Home Screen):

1. Open Bobbit, navigate into an active session, scroll up, start typing a draft.
2. Lock the device or switch apps for ≥1 minute (>5 min essentially always reproduces).
3. Reopen Bobbit from the home screen.

Observed: `<div id="app">` is empty for several seconds up to 30 s — sometimes only force-quit + relaunch recovers. No skeleton, no UI chrome, no "Reconnecting…" pill. Editor draft and scroll position are gone, and a turn that completed during the freeze isn't reflected until much later.

Root cause: every code path that produces visible UI was downstream of two awaits — `waitForGateway()` (`src/app/main.ts`, polling loop with 120 s cap) and `RemoteAgent.connect()` (formerly a 15 s WS race). On a half-dead iOS socket either can hang for tens of seconds. There was no skeleton in `index.html`, no persisted UI snapshot to paint from, and no `pageshow` / Page Lifecycle handlers — so an iOS bfcache restore fired none of the wakeup paths the client knew about.

## 2. Design principle

**Render first, reconcile second.**

The first frame after launch must be a usable view sourced from a persisted snapshot of the last-rendered state. Network calls happen in the background and update the UI as data arrives, routed through the existing `message-reducer.ts` `"snapshot"` action so dedup invariants hold. `location.reload()` is reserved for catastrophic state mismatch (BUILD_ID change, explicit user click on the watchdog banner) — never a routine path.

## 3. Architecture — four streams

The fix decomposes into four loosely-coupled streams. Each can be modified independently.

### Stream A — Persisted UI snapshot + non-blocking bootstrap

Files: `src/app/ui-snapshot.ts` (new), `src/app/main.ts`, `src/app/session-manager.ts`.

- `ui-snapshot.ts` exposes a low-level pair (`serialize` / `hydrate`, storage-agnostic, used by unit tests) and a high-level pair (`saveSnapshot` / `loadSnapshot` / `scheduleSave` / `flushPendingSnapshot` / `clearSnapshot`) that read/write `window.localStorage`.
- `initApp()` in `src/app/main.ts` calls `loadSnapshot()` and `renderApp()` synchronously *before* awaiting the gateway probe, then sets `data-rendered="true"` on `#app` (cancels the inline watchdog). `waitForGateway()` runs in the background; while polling, the cached view stays visible with the "Reconnecting…" pill.
- After the first render, `scheduleSave(state)` is called from canonical mutation points in `session-manager.ts` so the persisted view tracks live state at ~500 ms debounce.

**Invariant**: hydrated `messages` arrays are dispatched as `{ type: "snapshot", messages }` (see `src/app/message-reducer.ts` `case "snapshot"`). They are never pushed directly into `state.messages`. The reducer's existing toolCall + plain-text survivor tiers handle dedup against incoming live events.

**Edge cases**:
- `BOBBIT_E2E=1` (or `import.meta.env.MODE === "test"`) → `saveSnapshot` and `scheduleSave` no-op so test runs aren't polluted by stale localStorage. Low-level `serialize`/`hydrate` are unaffected: tests pass storage explicitly and E2E fixtures pre-seed via `page.evaluate`.
- Every IO path is `try/catch` and degrades silently — localStorage may be disabled, full, or partitioned in some PWA modes.
- Snapshot writers must not capture the `RemoteAgent` instance by reference: the `import.meta.hot` HMR boundary in `main.ts` swaps the agent on every hot reload. Project from `state` each time.

### Stream B — Service worker

File: `public/sw.js`.

- **Bypassed entirely**: `/api/*`, `/ws*` (must hit the gateway), and `/assets/*` (content-addressed; bypass avoids both stale-after-rebuild bugs and the SPA-fallback MIME mismatch where an unknown asset URL during teardown returns `index.html` and trips browser MIME enforcement: *"Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html"*).
- **Stale-while-revalidate**: the app shell — `/`, `/index.html`, `/manifest.json` — and any `req.mode === "navigate"`. Cache hit serves instantly; the live fetch runs in the background under `event.waitUntil` and refreshes the cache for next time.
- **Navigation timeout race**: cold-cache navigations race the live fetch against a 4 s timer. Timeout → fall back to whatever cached shell is available (`/` if no entry for the exact URL). Without this race, a half-dead iOS socket could hang the navigation indefinitely before `index.html` ever reaches the parser.
- **Install pre-cache**: `PRECACHE_URLS = ["/", "/index.html", "/manifest.json"]` is added to the cache during the `install` event so the very first launch after a deploy renders even on a slow network. Failures are non-fatal.
- **Cache invalidation**: `BUILD_ID` is replaced at build time; `CACHE_NAME = bobbit-${BUILD_ID}`. The `activate` handler purges every cache that isn't current. Combined with `skipWaiting()` + `clients.claim()`, a new build replaces the old SW on the next navigation.

### Stream C — Inline boot skeleton + render watchdog

File: `index.html`.

The skeleton (sidebar + chat shape, inline CSS, ~2 KB gzipped) and prepaint script live **outside** `<div id="app">` because Lit's first render replaces `#app`'s children. Layout:

```
<body>
  <div class="bobbit-skeleton">…sidebar + transcript host…</div>
  <div id="app"></div>
  <script>__bobbitPrepaint() / watchdog</script>
  <script type="module" src="/src/app/main.ts"></script>
</body>
```

- `__bobbitPrepaint()` reads `localStorage["bobbit.ui-snapshot.v1"]` synchronously and seeds the last 6 messages of the active session into the skeleton's transcript host. Runs eagerly at parse time, then re-runs on `DOMContentLoaded`, `pageshow`, `storage`, and a monkey-patched `Storage.prototype.setItem` (since native `storage` only fires across tabs). Idempotent.
- **Defensive fallback**: if `[data-bobbit-skeleton-transcript]` is missing (e.g. a custom shell stripped the skeleton), `__bobbitPrepaint()` injects a host into `<body>` so seeded text still lands in `document.body.textContent` for the cold-offline reproducing test.
- **`pointer-events: none`** on `.bobbit-skeleton` is the unconditional safety net. The skeleton is `position: fixed; inset: 0` and would otherwise intercept every click on pages that don't reach a WS-connected session (settings, workflow editor, role manager). It's purely visual.
- **Hide trigger** is the `data-rendered` attribute on `#app` — set by `main.ts` after the first `renderApp()`. **Not** `data-connected` (only fires on session pages). A `MutationObserver` on `documentElement` with `attributeFilter: ["data-rendered"]` adds `--hide` to the skeleton, removes the pill, and disconnects.
- **Watchdog escalation**: 3 s with `#app` not yet rendered → swap in a *manual* "Reconnecting…" + Reload banner. 10 s → "Something went wrong" + Reload banner. **Reload is only ever triggered by an explicit click**; nothing auto-reloads.

### Stream D — `RemoteAgent` lifecycle hardening

File: `src/app/remote-agent.ts`.

- **`CONNECT_TIMEOUT_MS = 8_000`** (was 15 s). 15 s is what users perceived as "white screen for 15 s" on iOS resume. One fast retry on first failure.
- **`pageshow` listener** on `window` (`_onPageShow`). iOS bfcache restore fires `pageshow` *without* `visibilitychange`, so the existing `_onVisibilityChange` path is never invoked — without this, the WS is never poked and the in-memory state can be hours stale. On `event.persisted === true` (or any `pageshow` after bind), force-close the existing socket and call `_connectWs(false)` with `_reconnectAttempt = 0`. Sets `_hadDisconnectSinceLastSnapshot = true` defensively so the message-resync path runs after `auth_ok` regardless of whether a real disconnect was observed.
- **`freeze` / `resume`** on `document` (best-effort Page Lifecycle API). Mirrors the `pageshow` flow for browsers that prefer them under memory-pressure freeze cycles. Heartbeat writes are stopped during freeze so a frozen tab doesn't burn CPU.
- **Idempotent binding**: `_heartbeatBound` is a local guard; bind/unbind goes through `connect()` / `disconnect()` so HMR or programmatic reconnect cycles don't double-register listeners or strand them.

## 4. Data flow — when is the snapshot written, when is it read, how does it merge

```
  ┌─────────────────────────────────────────────────────────────┐
  │  Live state in src/app/state.ts                              │
  │  + RemoteAgent._state.{messages,pendingToolCalls}            │
  └────────────────┬─────────────────────────┬───────────────────┘
                   │ scheduleSave (~500 ms)   │ buildPayload()
                   ▼                          ▼
  ┌────────────────────────────────┐  localStorage["bobbit.ui-snapshot.v1"]
  │  ui-snapshot.ts:                │  { v:1, savedAt, gatewayUrl, projects,
  │   • trimMessages → tail-200     │    activeProjectId, goals,
  │   • fitToBudget → ≤512 KB       │    archivedSessions, selectedSessionId,
  │   • JSON.stringify              │    hashRoute, activeSession, prefs }
  └────────────────────────────────┘
                                            │
                              (next launch) │
                                            ▼
            initApp() ── loadSnapshot() ── renderApp() ── #app[data-rendered=true]
                              │                                     │
                              │                                     ▼
                              │                       skeleton fades, pill stays
                              │
                              └── dispatch({ type: "snapshot", messages })
                                              │
                                              ▼
                                  message-reducer.ts case "snapshot"
                                    (toolCallId / id / plain-text
                                     survivor filter — UNTOUCHED)
                                              │
                                              ▼
                                      reconciled state.messages
```

**Critical rule**: the only writer of `state.messages` after hydrate is the reducer. Snapshot bytes are an input to the reducer, not a parallel merge path.

## 5. Storage layout

Key: `localStorage["bobbit.ui-snapshot.v1"]`.

Canonical payload (written by `buildPayload()` in `ui-snapshot.ts`):

```ts
{
  v: 1,
  savedAt: number,
  gatewayUrl: string | null,
  projects: Project[],
  activeProjectId: string | null,
  goals: Goal[],
  archivedSessions: ArchivedSession[],   // capped at 50
  selectedSessionId: string | null,
  hashRoute: string,                     // window.location.hash at save time
  activeSession: {
    id, title, model, connectionStatus,
    messages,                            // tail-200
    pendingToolCalls,
    scrollTop,
  } | null,
  prefs: { sidebarCollapsed, showArchived, palette, showTimestamps, playAgentFinishSound },
}
```

**Dual schema acceptance**: `hydrate()` and the inline `__bobbitPrepaint()` accept both the canonical `activeSession` shape and a legacy / E2E-fixture `{ sessions: { [id]: {...} }, selectedSessionId }` shape. `getActiveSessionFromSnapshot(snap)` is the shared resolver.

**Budget**: 512 KB hard cap. `fitToBudget()` first re-trims per-session message arrays (LRU caps 200 → 100 → 50 → 0), then drops `archivedSessions` if still over. On overrun, persistence skips this tick rather than throwing.

**Invalidation**:
- Permissive version check — accept missing `v` (legacy raw payload) or matching `v: 1`. Reject explicit version mismatches.
- Cache-name-derived BUILD_ID guard via SW (`bobbit-${BUILD_ID}`): a new build → new cache name → snapshot is ignored if its companion shell cache no longer exists.
- Token / gateway URL change → snapshot key remains the same but gateway-bound fields self-invalidate on first reconcile (live state wins via reducer).
- `clearSnapshot()` is called on logout.

**E2E gate**: `isE2EAutoSaveDisabled()` returns true under `window.__bobbitE2E === true`, `import.meta.env.BOBBIT_E2E === "1"`, or `import.meta.env.MODE === "test"`. High-level writers no-op; low-level `serialize`/`hydrate` remain available for fixture seeding.

## 6. Service worker contract

| Path                          | Strategy                                  |
| ----------------------------- | ----------------------------------------- |
| `/api/*`, `/ws*`              | **Bypass** (always hit gateway)           |
| `/assets/*` (hashed bundles)  | **Bypass** (browser HTTP cache + ETags)   |
| `/`, `/index.html`, `/manifest.json` | Stale-while-revalidate             |
| `req.mode === "navigate"`     | SWR + 4 s timeout race vs cached `/`      |
| Other GETs                    | Network-first with cache fallback         |

Why `/assets/*` is bypassed: hashed bundle filenames are content-addressed, so the browser's HTTP cache handles them perfectly. Routing them through SWR risks (a) a stale entry surviving across a build hash bump, and (b) a SPA-fallback returning `index.html` for an unknown asset URL during teardown — which trips `Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html`.

Pre-cache (`install`) is best-effort: failures don't block install (some shell URLs may 404 in dev). Only `basic` / `cors` `ok` responses are written to the cache (`cacheIfOk`); opaque/error responses are never cached.

## 7. Page Lifecycle hooks

`RemoteAgent.connect()` binds three resume signals once per agent:

```
window.addEventListener("pageshow", _onPageShow)
document.addEventListener("freeze", _onFreeze)
document.addEventListener("resume", _onResume)
```

In addition to the existing `document.addEventListener("visibilitychange", _onVisibilityChange)`. `disconnect()` removes all four; `_heartbeatBound` guards against double-bind across HMR.

`_onPageShow`:
1. Bail if no active session yet (boot-time `pageshow` arrives before `connect()` finishes).
2. Force-close the existing socket so the spec test observes a fresh `WebSocket` constructor call within 1.5 s.
3. Set `_hadDisconnectSinceLastSnapshot = true` so the message resync path runs after `auth_ok`.
4. `_connectWs(false)` with `_reconnectAttempt = 0`.

This is the only path that fires on iOS bfcache restore. The active-session check in `_onVisibilityChange` is for cached background agents; `pageshow` is fired once on the window and only the active agent acts on it.

## 8. Heartbeat & stale-streaming bypass

`sessionStorage["bobbit:heartbeat"]` is updated to `Date.now()` every 10 s while the document is visible (`HEARTBEAT_INTERVAL_MS = 10_000`). On any resume signal, `_readHeartbeatGap()` returns `now - lastHeartbeat`.

Two thresholds in `_onVisibilityChange`:

- **`STALE_STREAMING_GAP_MS = 60_000`** — gap > 60 s means the in-memory `isStreaming` flag is stale by definition (mobile OS can freeze the TCP socket without a `message_end` ever arriving). Drop the historical `if (this._state.isStreaming) return;` short-circuit and proceed with resync.
- **`LONG_RESUME_GAP_MS = 5 * 60_000`** — gap > 5 min force-runs the resync regardless of `_hadDisconnectSinceLastSnapshot`. This is the **one place** that bypasses the c9e7a77d new-tab-dup-message guard, gated narrowly on heartbeat-gap > 5 min AND active-session AND for one resync only. The accompanying regression test (`tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts`) asserts the guard still works under normal multi-tab visibility-change flow.

`_freeze` stops heartbeat writes; `_resume` restarts them and mirrors the `pageshow` reconnect.

## 9. Skeleton overlay & watchdog — sibling layout

Why **sibling** and not child of `#app`: Lit replaces `#app`'s children on first render; a skeleton inside `#app` would be blown away. Sibling placement under `<body>` lets the skeleton survive across the boot transition, and the `MutationObserver`-driven hide is the single cleanup point.

Why `pointer-events: none`: the skeleton is `position: fixed; inset: 0`. If the watchdog or `data-rendered` signal misfires (multi-context tests, slow MutationObserver, etc.), every click would otherwise be intercepted by the overlay on every page that doesn't reach a session WS connection — settings, workflow editor, role manager, etc. The hide is the primary path; `pointer-events: none` is the unconditional safety net.

Why `data-rendered` and not `data-connected`: `data-rendered` is set by every Lit page after the first `renderApp()`. `data-connected` only fires on session pages (after WS handshake). Gating the hide on `data-connected` strands the skeleton on every non-session page.

Watchdog timing — manual reload only:

- 3 s without `data-rendered` → swap to "Reconnecting…" + Reload button.
- 10 s without `data-rendered` → swap to "Something went wrong" + Reload button.

Neither timer ever calls `location.reload()` — only the user-clicked button does. This avoids the 30-s-gap → reload loop pattern from the original draft.

## 10. Invariants preserved

- **`src/app/message-reducer.ts` is untouched.** Hydrated messages dispatch the existing `"snapshot"` action. Survivor filter, toolCallId/id dedup, and plain-text equivalence tiers are unchanged.
- **Multi-tab plain-text dedup (c9e7a77d)** — `_hadDisconnectSinceLastSnapshot` is still authoritative for the visibility-change resync path. The only narrow bypass is the >5 min heartbeat-gap branch (§8), guarded by `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts`.
- **Reducer ordering invariant** — no code path pushes directly into `state.messages` (see [unified-message-ordering-reducer.md](unified-message-ordering-reducer.md)).
- **`BOBBIT_E2E=1` test isolation** — high-level snapshot writers no-op; existing E2E harnesses unchanged.
- **Vite HMR boundary** — `import.meta.hot.dispose` in `main.ts` flushes drafts; snapshot writers project from live `state` each tick rather than capturing the agent.
- **Server-side: zero changes.** No new WS frames, no new REST endpoints, no schema migrations.

## 11. Failure modes & how they manifest

| Symptom | Likely cause |
| ------- | ------------ |
| Console: `Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html`. | SW intercepting an asset URL it shouldn't (`/assets/*` bypass regressed), or production code constructing a dynamic-import specifier the SW maps to the SPA fallback. Check `public/sw.js` `isShellPath` / `/assets/` bypass. |
| Skeleton overlay blocks all clicks on the settings page (or any non-session page). | Hide-trigger gated on `data-connected` instead of `data-rendered`, or `pointer-events: none` removed from `.bobbit-skeleton`. Both are required (primary + safety net). |
| `pwa-resume-pageshow.spec.ts` fails with no `WebSocket` constructor call observed within 1.5 s of `pageshow{persisted:true}`. | `connect()` never ran for the active `RemoteAgent` (`_heartbeatBound === false`), the listener was removed by an unbalanced `disconnect()`, or `_onPageShow` didn't force-close the existing socket so no fresh constructor fires. |
| Cold offline launch shows a blank skeleton (no last messages). | `loadSnapshot()` returned null — version mismatch, no entry, or BUILD_ID/cache-name divergence invalidated it. Check `localStorage["bobbit.ui-snapshot.v1"]` and the SW `CACHE_NAME`. |
| Duplicate plain-text messages after opening a second tab. | `_hadDisconnectSinceLastSnapshot` short-circuit was bypassed outside the >5 min heartbeat-gap branch. Re-run `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts`. |
| Watchdog "Something went wrong" banner fires on a healthy network. | `data-rendered` is never being set on `#app` — `renderApp()` threw, or the `appEl.setAttribute` call in `main.ts` was removed. |
| First paint after deploy is blank for 4+ s. | SW pre-cache failed at install (check `install` event), or BUILD_ID didn't replace and cache name collides. |

## 12. Verification

**Reproducing tests** (added with the fix):

- `tests/pwa-ui-snapshot.test.ts` — `serialize`/`hydrate` round-trip; tail-200 LRU; 512 KB budget overrun → trim → drop archived → skip; dual schema acceptance.
- `tests/pwa-sw-fetch-timeout.test.ts` — synthetic `fetch` event with `req.mode === "navigate"`, `self.fetch` stubbed to `new Promise(() => {})`, cached `/` pre-seeded → asserts `event.respondWith` resolves to the cached shell within ~4 s.
- `tests/e2e/ui/pwa-resume-cold-offline.spec.ts` — pre-seed snapshot, `setOffline(true)`, navigate → assert seeded message text appears in `document.body.textContent` within 100 ms of `domcontentloaded`.
- `tests/e2e/ui/pwa-resume-pageshow.spec.ts` — spy `location.reload`, dispatch `new PageTransitionEvent("pageshow", { persisted: true })` → assert no reload and a fresh `WebSocket` open within 1.5 s.

**Regression tests preserved**:

- `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts` — multi-tab plain-text dedup under the visibility-change path. The narrow >5 min heartbeat-gap bypass must not regress this.

Run with `npm run test:unit` (PWA snapshot + SW timeout) and `npm run test:e2e` (browser specs).

## 13. Out of scope

- **Full offline mode** — creating goals offline, queueing prompts, conflict resolution. The app is read-only when disconnected; we just want it to *render* readably and reconcile invisibly.
- **Server-side changes** — none. The existing reducer + `{ type: "resume", fromSeq }` reconnect protocol is sufficient.
