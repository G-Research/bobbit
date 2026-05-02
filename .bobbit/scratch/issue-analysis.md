# Issue Analysis — Production-grade PWA resume

## 1. Symptom

**Reproduction**
1. Install Bobbit as a PWA on iOS (Add to Home Screen).
2. Open the app, navigate into an active session, scroll up in the transcript, and start typing a draft into the message editor.
3. Lock the device or switch to another app for ≥1 minute (longer → more reliable repro; >5 min essentially always).
4. Reopen Bobbit from the home-screen icon.

**Observed**
- A blank white screen — `<div id="app">` is empty — for anywhere from a few seconds up to 30 s. Sometimes it never recovers without force-quit + relaunch.
- During that window the page is unresponsive: no UI chrome, no skeleton, no "Reconnecting…" indicator.

**Expected (Linear/Slack/Things 3 quality)**
- The last view the user saw paints in the first frame after launch.
- Network reconciliation is silent and the UI stays interactive.
- Reload-on-return is never required.

**Secondary symptoms**
- Even when the app does eventually paint, the editor draft is gone (the in-memory `state` was thrown away when JS bootstrap re-ran from zero).
- Scroll position is reset to bottom (or to wherever the next snapshot lands).
- A turn that completed during the freeze is not reflected — the agent's final message arrives "later", which "feels broken".

---

## 2. Root cause

**The bootstrap is fully cold and renders nothing until the network is up.** `<div id="app">` is empty markup (`index.html:18`) and the very first render only happens after JS executes and Lit mounts the `ChatPanel`. Both are gated on async work.

Concretely:

- `index.html:18` — `<body>` contains only `<div id="app"></div>` plus inline manifest-injection JS. **No skeleton, no static fallback content.** First paint is therefore necessarily white until JS runs.

- `src/app/main.ts:309-314` — `initApp()` immediately enters an `await` to probe `/api/health`:
  ```ts
  if (!savedUrl || !savedToken) {
      try {
          const probe = await fetch(`${window.location.origin}/api/health`);
          ...
  ```
  Until that probe settles, no `renderApp()` has run.

- `src/app/main.ts:331-333` — even when creds are present we set `state.appView = "gateway-starting"` and `renderApp()`, which gives an empty placeholder view rather than the user's last-known content.

- `src/app/main.ts:32-50` — `waitForGateway()` is a blocking 1.5 s polling loop with a 120 s cap:
  ```ts
  const POLL_INTERVAL = 1500;
  const MAX_WAIT = 120_000;
  while (true) {
      try { await authenticateGateway(url, token); return; }
      catch (err) { ... await new Promise(r => setTimeout(r, POLL_INTERVAL)); }
  }
  ```
  Until this resolves, the rest of `initApp()` (preferences, route hydration, session connect) is parked and the user sees `gateway-starting`.

- `src/app/main.ts:340 / 411-414` — `await waitForGateway(...)` is the first hard gate; on failure we drop to `state.appView = "disconnected"`. There is no "show last view" alternative.

- `src/app/remote-agent.ts:358` — `private static readonly CONNECT_TIMEOUT_MS = 15_000;`

- `src/app/remote-agent.ts:386-394` — `connect()` races `_connectWs` against this 15 s timeout:
  ```ts
  const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Connection timed out")),
                 RemoteAgent.CONNECT_TIMEOUT_MS);
  });
  try { await Promise.race([this._connectWs(true), timeout]); }
  ```
  On a half-dead iOS socket, the user therefore stares at the blank `gateway-starting` view for up to 15 s before any fallback path runs. There is no UI rendered while this is in flight.

In short: **every code path that produces visible UI is downstream of two awaits (`waitForGateway` + WS connect) that can each take 15–120 s.** A persisted snapshot cannot help unless the bootstrap is restructured to render before awaiting.

---

## 3. Compounding factors

**(a) Service worker is network-first with no fetch timeout** — `public/sw.js:51-79`:
```js
event.respondWith(
    fetch(req)
        .then((response) => { ... })
        .catch(async () => {
            const cached = await caches.match(req);
            ...
            if (req.mode === "navigate") {
                const root = await caches.match("/");
                if (root) return root;
            }
            throw new Error("offline and no cached response");
        }),
);
```
There is no race against a timeout — the cache fallback runs only after the platform's `fetch` rejects. On iOS, a half-dead socket can keep `fetch` pending for tens of seconds, so the SW *holds the navigation hostage* before `index.html` even reaches the parser. The header comment at `public/sw.js:1-25` explicitly chose network-first to avoid stale-asset bugs after server restart, but the cure is the iOS resume defect.

**(b) `_onVisibilityChange` short-circuits while `isStreaming`** — `src/app/remote-agent.ts:152-209`. The relevant guard at line 187:
```ts
if (this._state.isStreaming) return;
```
Bug: if the WS dropped silently mid-stream and `isStreaming === true` is stale (server-side the turn finished long ago, but our local flag was never cleared because no `message_end` was received), every visibility wake skips the resync. Combined with the `needsResync` heuristic immediately below (lines 195-197), a stuck `isStreaming = true` leaves the cached state frozen indefinitely. The `_hadDisconnectSinceLastSnapshot = true` guard added in c9e7a77d (line 151) correctly handles the no-disconnect case but does not gate the `isStreaming` early return — so the flag wins.

**(c) No Page Lifecycle / `pageshow` / `freeze` / `resume` handlers anywhere in the client.** `grep -n "pageshow\|freeze\|resume\b" src/app/` returns only comment-prose mentions and the protocol-level `{type:"resume", fromSeq}` WS frame at `src/app/remote-agent.ts:441` — never a `window.addEventListener("pageshow", ...)` or `document.addEventListener("freeze"/"resume", ...)`. The only resume hook today is `visibilitychange` bound at `remote-agent.ts:373` and `main.ts:642` (the latter for preference sync). On iOS, a bfcache restore fires `pageshow` *without* `visibilitychange`, so the WS is never poked and the preference sync never runs — the app sits with an in-memory state that may be hours stale.

---

## 4. Affected code paths (parallelisable work-streams)

Grouped so two coders can work concurrently with minimal merge conflicts.

### Stream A — Snapshot module + non-blocking bootstrap
- **NEW** `src/app/ui-snapshot.ts` — serialize/hydrate, debounced writer, byte-budget LRU, BUILD_ID + token invalidation.
- `src/app/main.ts:303-415` (`initApp`) — restructure to render synchronously from snapshot before any await; demote `waitForGateway` to background.
- `src/app/main.ts:32-50` (`waitForGateway`) — keep, but caller no longer blocks UI on it; on failure don't flip to `"disconnected"` if a snapshot is hydrated.
- `src/app/state.ts:155-330` — likely add a small `lastUiSnapshotAt`/`pendingReconcile` flag; do NOT break the existing `state` object shape.
- `src/app/session-manager.ts` — add snapshot-write hooks at canonical mutation points: lines 92 (`activeProjectId`), 658 (`selectedSessionId`), 721 / 939 / 1297 (`connectionStatus`), 985 (`gatewaySessions`), and the message-array path through `message-reducer.ts`.
- `src/app/message-reducer.ts:199-318` (`case "snapshot"`) — **do not modify**; the new hydration must dispatch a `snapshot` action so the existing survivor filter / plain-text-dedup / toolCall-dedup tiers handle the merge.

### Stream B — Service worker
- `public/sw.js:51-79` — race nav fetch against 4 s timeout, fall back to cache.
- `public/sw.js:55` — branch on `req.mode === "navigate"` and shell paths (`/`, `/index.html`, `/manifest.json`, `/assets/*` hashed) to use stale-while-revalidate.
- `public/sw.js:25-34` — add a pre-cache step on `install` for the shell so first-launch-after-deploy isn't blank.
- Keep `/api/*` and `/ws*` strictly bypassed (already correct at `sw.js:58`).

### Stream C — Inline skeleton + watchdog
- `index.html:17-19` — inline ~2 KB CSS-only sidebar+chat skeleton in `<body>` so first paint is non-white before JS runs.
- `index.html` (new inline `<script>`) and `src/app/main.ts` near the top of `initApp` — 3 s and 10 s render watchdogs that swap in a "Reconnecting…" / "Something went wrong + Reload" banner only if `#app` is still empty.

### Stream D — RemoteAgent lifecycle hardening
- `src/app/remote-agent.ts:152-209` (`_onVisibilityChange`) — drop the `isStreaming` short-circuit when the gap exceeds 60 s; respect `_hadDisconnectSinceLastSnapshot`.
- `src/app/remote-agent.ts:358` — reduce `CONNECT_TIMEOUT_MS` from 15_000 to 8_000 and add one fast retry.
- `src/app/remote-agent.ts:373` — also bind `pageshow` (and `document` `freeze`/`resume`) alongside `visibilitychange`; on `pageshow.persisted === true`, kick an immediate `_connectWs(false)` with `_reconnectAttempt = 0`.
- Soft heartbeat: write `Date.now()` to `sessionStorage` every 10 s while visible (new helper, can live in `main.ts` or `remote-agent.ts`); on resume, gap > 5 min ⇒ force fresh `_connectWs(false)` + bypass the `isStreaming` guard for that single resync.

---

## 5. Design principle

**Render first, reconcile second.** A production-grade PWA must paint a usable UI within the first frame after launch, sourced from a persisted snapshot of the last-rendered view. Network calls happen in the background and update the UI as data arrives, routed through the existing `message-reducer` snapshot-survivor path so dedup invariants hold. Reload-on-return is reserved for catastrophic state mismatch (BUILD_ID change, explicit user click on the watchdog banner) — never a routine path.

---

## 6. Fix outline (mapped to streams)

1. **Persisted UI snapshot** → Stream A (`ui-snapshot.ts`). Persist `state.projects`, `activeProjectId`, `goals`, `archivedSessions`, active session id + hash route, and per-active-session `messages` (last 200), `title`, `connectionStatus`, `model`, `pendingToolCalls`, scroll position. Persist sidebar/palette consolidation (currently scattered: `state.ts:208` sidebarCollapsed, `state.ts:213` showArchived, palette in `index.html` inline script lines 19-21). Debounced ~500 ms; ~512 KB cap with LRU; key by gateway URL + token-fingerprint + BUILD_ID. **Ordering: this module must land before bootstrap can hydrate from it.**
2. **Non-blocking bootstrap** → Stream A (`main.ts`). Hydrate + `renderApp()` *before* any `await`. `waitForGateway` runs in the background; while polling, the cached view stays visible with a "Reconnecting…" pill. Reserve `appView = "disconnected"` for genuinely missing creds.
3. **Page Lifecycle handlers** → Stream A (`main.ts`) for the heartbeat + watchdog + `pageshow` route refresh; Stream D (`remote-agent.ts`) for the WS-side `pageshow`/`freeze`/`resume` hooks.
4. **RemoteAgent resume hardening** → Stream D.
5. **Service-worker improvements** → Stream B.
6. **Render watchdog** → Stream C.
7. **Inline boot skeleton** → Stream C.

**Ordering constraints**
- A1 (`ui-snapshot.ts`) before A2 (`main.ts` hydration) before A-session-manager hooks.
- B, C, D have no cross-dependencies and can land in any order, in parallel with A.
- The reducer (`message-reducer.ts:199-318`) is **not modified** — the new snapshot must dispatch the existing `"snapshot"` action, so reconciliation reuses the proven survivor filter.

---

## 7. Constraints (must-not-regress list)

- **Desktop refresh** must still work — palette inline script (`index.html:19-21`) and `bobbit-hot-reload` sessionStorage marker (`main.ts:686`) must remain functional. Snapshot hydrate must not block on anything async.
- **Vite HMR** — the `import.meta.hot` block at `main.ts:683-690` must continue to flush drafts and trigger reload; HMR boundary changes mean snapshot writers must not capture the `RemoteAgent` instance by reference.
- **`npm run dev:harness`** — gateway restarts trigger WS reconnects; the new resume path must converge cleanly when the gateway disappears for 1–5 s.
- **Restart-resume snapshot survivor filter** — must dispatch `"snapshot"` (`message-reducer.ts:199`) for the new hydration, never bypass it.
- **Multi-tab plain-text dedup** — the c9e7a77d guard `_hadDisconnectSinceLastSnapshot` (`remote-agent.ts:151, 195-197, 495, 922`) must remain authoritative for visibility resyncs. The new `pageshow` path may bypass it for the >5 min heartbeat-gap case, but only with an explicit code path and a test (see §9).
- **Reducer ordering invariant** — never push directly into `state.messages`; all transcript mutations route through `reduce(state, action)`.
- **`BOBBIT_E2E=1` harnesses** — existing E2E tests must pass unmodified. Snapshot writes must be no-ops or deterministic when `BOBBIT_E2E=1` is set, otherwise tests that assert message ordering will be polluted by stale localStorage.
- **`lastActivity` preservation** — `isUserVisibleActivity` filter must not be tripped by snapshot-write side effects.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| localStorage quota exceeded (5–10 MB cap, varies) | Hard byte-budget (~512 KB); LRU-trim per-session messages array (cap last 200); fall back to "skip persist this tick" rather than throw. |
| Hydration mismatch with reducer (duplicate / out-of-order rows) | Route the hydrated `messages` array through `dispatch({ type: "snapshot", messages })` so the existing toolCall + plain-text survivor tiers (`message-reducer.ts:213-313`) handle dedup. Never set `state.messages = persisted` directly. |
| Stale snapshot served after token rotation or server upgrade | Invalidation key: `sha256(gatewayUrl + tokenFingerprint + BUILD_ID)`. Read BUILD_ID from the SW's active cache name (`bobbit-${BUILD_ID}` at `sw.js:27`) via `caches.keys()` on hydrate; mismatch ⇒ drop snapshot and render skeleton. |
| Service-worker shell staleness after deploy | BUILD_ID is already replaced at build (`sw.js:27`); stale-while-revalidate swaps on next nav. Same BUILD_ID guard invalidates the snapshot. |
| Main-thread cost of snapshot writes | Debounce 500 ms; serialize via `JSON.stringify` over a *projection* (no `structuredClone`, no Map/Set traversal — convert only the persisted slice); use `requestIdleCallback` where available. |
| Snapshot capturing an in-flight optimistic message that the server later rejects | Optimistic rows already carry `_origin === "optimistic"` and survive snapshot dedup (`message-reducer.ts:289-294`); persist them, accept the small risk of one ghost row that the next live event reconciles. |
| `pageshow.persisted` resume bypassing `_hadDisconnectSinceLastSnapshot` causes new-tab dup-message regression | Gate the bypass on heartbeat-gap > 60 s AND active-session check (mirroring lines 162-163); add the c9e7a77d reproducing test (multi-tab) to the regression suite for this path. |
| Watchdog reload loop (3 s banner clicked → reload → blank again) | The 10 s watchdog only renders a *manual* Reload button; never `location.reload()` automatically. |

---

## 9. Verification approach (reproducing-test seeds for the test-engineer)

1. **Playwright: cold load + offline → cached view in <100 ms.** Pre-seed localStorage with a serialized snapshot fixture, navigate offline (`page.context().setOffline(true)`), assert `await page.locator("#app .session-transcript").count() > 0` resolves within 100 ms of `domcontentloaded`. Asserts §2 + §6.1.
2. **Playwright: simulated `pageshow {persisted: true}` → no reload, WS reconnect kicked.** Spy on `window.location.reload`, dispatch `new PageTransitionEvent("pageshow", { persisted: true })`, assert reload spy not called and a fresh `WebSocket` open is observed within 1 s. Asserts §6.3 + §6.4.
3. **Unit: SW navigation fetch races a 4 s timeout against a never-resolving fetch.** Stub `self.fetch` to return a `new Promise(() => {})`; pre-populate `caches` with `/`; dispatch a synthetic `fetch` event with `req.mode === "navigate"`; assert `event.respondWith`'s resolved response is the cached `/` within ~4 s. Asserts §6.5.
4. **Unit: snapshot serializer round-trips representative state under 512 KB cap with LRU trim.** Build a `state` projection containing 5000 messages, serialize, assert `length < 512 * 1024`, hydrate, assert last 200 messages preserved + first 4800 dropped + dedup keys (id, toolCallId) intact. Asserts §6.1 + §8 (quota).
5. **E2E: send message → kill WS → fake heartbeat-gap > 70 s → unlock → no duplicate messages and resync ran.** Extends the c9e7a77d reproducing pattern. Asserts §6.4 (heartbeat-gap-bypasses-`isStreaming` guard) without regressing the new-tab dup-message fix.
6. **Playwright: render watchdog escalation.** Force snapshot hydrate to throw, navigate to app, assert 3 s later the static "Reconnecting…" banner is visible inside `#app`, and 10 s later the "Something went wrong + Reload" banner shows. Asserts §6.6.

---

## 10. Out of scope

- **Full offline mode** (creating goals offline, queueing prompts while disconnected, conflict resolution). The app remains read-only when disconnected; we just want it to *render* readably and reconcile invisibly.
- **Server-side changes.** The existing reducer + `{type:"resume", fromSeq}` reconnect protocol (`remote-agent.ts:441`) is sufficient. No changes to `src/server/`, gates, goals, or the WS frame schema.
