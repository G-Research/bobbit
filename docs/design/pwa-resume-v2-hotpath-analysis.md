# PWA Resume v2 — Source-only Hot-path Analysis

Status: **investigation** — no production code change accompanies this
document. Companion to
[pwa-resume-v2-diagnostics.md](pwa-resume-v2-diagnostics.md): the
diagnostics doc defines *how* we measure; this one maps every step
between "iOS reopens the PWA tab" and "first session content
interactive" against the current source tree, and ranks where the time
is most likely going.

All file:line references are anchored to the post-revert tree (HEAD on
this branch, i.e. PR #462 merged + the diagnostic instrumentation from
task 1). Every claim cites the file:line that proves it. No vague
"the bootstrap waits for X" without a quoted `await`.

---

## 1. Cold-boot timeline (first launch / context killed)

Ordered from `pageshow:fresh` to "first session content paints". `Δ`
column is a rough cost class, not a number — see §5 for measurement
hooks.

| # | Step | Site | Awaits | Blocks next? | Δ |
|---|------|------|--------|-------------|---|
| 1 | HTML fetch + parse | `index.html` (24 lines) | network | yes — JS can't start | net-RTT |
| 2 | Inline palette restore | `index.html:14-16` | none (sync localStorage read) | yes (sync) | cheap |
| 3 | Inline manifest `<link>` injection | `index.html:17-37` | none | yes (sync) | cheap |
| 4 | Module fetch: `/src/app/main.ts` (or hashed bundle) | `index.html:38` `<script type="module">` | network — main chunk + transitive imports (`storage.js`, `state.js`, `ui/index.js`, `api.js`, `session-manager.js`, `render.js`) | yes | net-RTT × N + parse |
| 5 | Module side-effect: `import "./storage.js"` opens IndexedDB | `src/app/main.ts:2`, `src/app/storage.ts:21-32` | yes — `IndexedDBStorageBackend` constructor (async open) | not directly — `state.chatPanel = new ChatPanel()` runs before any storage read | parse + IDB-open |
| 6 | `mark("main:module")` | `src/app/main.ts:3` | — | — | cheap |
| 7 | `setRenderApp(doRenderApp)` | `src/app/main.ts:42` | — | — | cheap |
| 8 | `initApp()` invoked | `src/app/main.ts:481` | — | — | — |
| 9 | `mark("init:start")` + `installResumeHooks()` | `src/app/main.ts:357-358` | — | — | cheap |
| 10 | `new ChatPanel()` | `src/app/main.ts:364` | — | yes — host element constructed | parse |
| 11 | URL token check | `src/app/main.ts:367-373` | none | yes (sync) | cheap |
| 12 | localhost auto-connect probe | `src/app/main.ts:381-396` | `await fetch("/api/health")` **only when no saved creds** — installed PWAs always have creds, so this branch is a no-op on resume | n/a on resume | net-RTT (cold-install only) |
| 13 | Set `appView = "gateway-starting"` | `src/app/main.ts:401` | — | — | cheap |
| 14 | `mark("init:first-render"); renderApp(); markPaint("init:first-paint")` | `src/app/main.ts:404-406` | — | — | render |
| 15 | Bind `hashchange` | `src/app/main.ts:410` | — | — | cheap |
| 16 | **`await waitForGateway(savedUrl, savedToken)`** | `src/app/main.ts:414` (calls `waitForGateway` defined at `:50`) | `await authenticateGateway(...)` (loop, 1.5 s poll) | **yes** — every subsequent step is gated on this | net-RTT (≥1) |
| 16a | `authenticateGateway` → `await fetch("/api/health", { Authorization })` | `src/app/session-manager.ts:425-428` | network | yes | net-RTT |
| 16b | `await healthRes.json()` | `src/app/session-manager.ts:438` | none meaningful | yes | cheap |
| 16c | OAuth check (skipped for localhost / aigw) | `src/app/session-manager.ts:443-448` | possibly `await checkOAuthStatus()` | yes | net-RTT (non-localhost only) |
| 16d | `await refreshSessions()` (called *inside* `authenticateGateway`) | `src/app/session-manager.ts:456` | `Promise.all([sessions, goals, projects])` — three GETs | **yes — blocks the outer `waitForGateway`** | 3× net-RTT |
| 16e | `await gatewayFetch("/api/config/cwd")` | `src/app/session-manager.ts:458-461` | network | yes | net-RTT |
| 16f | `startSessionPolling()` + `startTimeRefresh()` | `src/app/session-manager.ts:466-467` | — | — | cheap |
| 17 | `await gatewayFetch("/api/preferences")` | `src/app/main.ts:419` | network | yes — applies palette/timestamps | net-RTT |
| 18 | `mark("init:prefs-loaded")` | `src/app/main.ts:438` | — | — | cheap |
| 19 | Route dispatch — for `route.view === "session"`: | `src/app/main.ts:443-451` | — | — | — |
| 19a | `await gatewayFetch("/api/sessions/:id")` (existence probe) | `src/app/main.ts:447` | network | yes | net-RTT |
| 19b | `await connectToSession(sessionId, true)` | `src/app/main.ts:449` | the entire connect waterfall (§1.1) | yes | many |
| 20 | Keyboard-shortcut registration + `await loadSavedBindings()` | `src/app/main.ts:526-621` | yes — IDB read | runs after route hydration; doesn't gate first session paint | IDB |
| 21 | Bind `visibilitychange` for prefs sync | `src/app/main.ts:625` | — | — | cheap |
| 22 | SW register | `src/app/main.ts:760-762` | none | — | cheap |

### 1.1 `connectToSession` slow path (cold)

Inside step 19b, with `cached === undefined`:

| # | Step | Site | Blocks? |
|---|------|------|--------|
| a | `selectSession(sessionId)` (sync hash + state mutation) | `src/app/session-manager.ts:767` | yes |
| b | `applyProjectPalette(...)` | `:879` | yes |
| c | `state.chatPanel = new ChatPanel(); renderApp()` — empty shell with "Connecting…" | `:898-900` | renders **before** WS — this is the visual "Connecting…" pill | yes |
| d | Start `modelRestorePromise` (parallel) | `:909-918` | parallel |
| e | **`await remote.connect(url, token, sessionId)`** | `:920` → `src/app/remote-agent.ts:390` | yes |
| e1 | `new WebSocket(...)` + `auth` frame | `remote-agent.ts:441-447` | net |
| e2 | `auth_ok` round-trip races a 15 s timeout | `remote-agent.ts:388, 416-418` | WS-RTT |
| f | `modelRestorePromise` await | `:945-948` | usually resolved by now |
| g | `remote.deferProposalCheck(); remote.requestMessages()` (fires `get_messages` over WS) | `:1605-1609` | non-blocking; reply arrives async |
| h | Fire-and-forget: `refreshGitStatusForSession`, `refreshBgProcessesForSession`, `startGitStatusPoll` | `:1612-1615` | parallel, non-blocking |
| i | `draftRestorePromise` — possibly `await restoreGoalDraft / restoreRoleDraft / restoreProjectDraft` (REST GET) | `:1617-1700` | yes (parallel with `backgroundWork`) |
| j | `backgroundWork = Promise.all([refreshSessions(), storage.providerKeys.set(...)])` | `:1701-1739` | yes — **a second `refreshSessions()` after the one inside `authenticateGateway`** |
| k | `await draftRestorePromise` → `runDeferredProposalCheck()` | `:1745-1748` | yes |
| l | `await backgroundWork` | `:1753` | yes |
| m | `_setupPromptDraftHandlers(sessionId)` | `:1756` | sync |

The visible "first session content" appears as soon as the `messages`
WS frame from (g) arrives at the handler in `remote-agent.ts:945-1010`,
which fires `state_update` / `message_end` and `applyProjectPalette`
indirectly drives a `renderApp()`. That is **not awaited** by
`connectToSession` — the function can return before content paints,
and content can paint before the function returns.

---

## 2. Resume timeline — warm (JS context survived)

This is the case where iOS keeps the PWA process alive (typically
short suspensions; ≤ a few minutes). The JS heap is intact;
`window`, `document`, `state`, `state.remoteAgent` all still exist.

| # | Step | Site | Notes |
|---|------|------|-------|
| 1 | iOS dispatches `pageshow` (persisted=true rare on iOS PWA, persisted=false typical) | platform | — |
| 2 | `recordResume("pageshow", persisted)` | `src/app/perf.ts:118-124, 144-146` | stamps `pageshow:persisted` or `pageshow:fresh`; **the only `pageshow` listener in the tree today** |
| 3 | iOS dispatches `visibilitychange → visible` | platform | — |
| 4 | `recordResume("visible")` | `src/app/perf.ts:147-149` | stamps `visible` |
| 5 | Per-agent `_onVisibilityChange` fires (only the active session's agent) | `src/app/remote-agent.ts:154-208` | gated on `state.selectedSessionId === this._sessionId` |
| 5a | If `ws.readyState !== OPEN`: clear backoff timer, **immediate** `_connectWs(false)` | `:163-174` | the OS-frozen-socket recovery path |
| 5b | If `ws.readyState === OPEN`: 2 s throttle, then `requestMessages()` (only if `_hadDisconnectSinceLastSnapshot`) + `get_state` | `:175-208` | "OPEN but actually dead" mitigation is *not* tested at this layer — see §4 hypothesis 2 |
| 6 | `init:start` is **not** re-stamped — `initApp()` only runs once | by construction | warm resume reuses the rendered tree |
| 7 | Top-level `visibilitychange` listener in `main.ts` runs prefs sync | `src/app/main.ts:625-665` | `gatewayFetch("/api/preferences")` + `refreshSessions()` + `resetPrPollThrottle()` |
| 8 | Session polling timer (5 s) is paused on hidden, resumes on visible | `src/app/api.ts:75-89` | gated on `document.visibilityState === "visible"` |
| 9 | First repaint happens whenever the renderer next runs — typically the first `state_update` from the resync `get_state`, **or** earlier if Lit's internal scheduling repaints the still-mounted tree before any RPC returns | implicit | — |

**SW behaviour on warm resume:** none. The SW is not consulted for
already-loaded modules, and there is no SW-driven prewarm hook on
`visibilitychange`. The SW exists only to provide offline fallback
(see `public/sw.js:54-92`).

**Live socket detection:** today we trust `ws.readyState`. iOS can
freeze a TCP socket without notifying the JS layer (
`public/sw.js:34-39` references this in the *previous* attempt's
context); the only signal we get back is silence. There is no
heartbeat / ping in the post-revert tree (search `setInterval` in
`remote-agent.ts`: only timers are `_stateRetryTimer:136` and
`_reconnectTimer:137`). A frozen socket therefore stalls
`requestMessages()` and `get_state` indefinitely until the OS finally
RST's the connection or the user navigates.

---

## 3. Resume timeline — cold (JS context killed)

iOS routinely evicts the PWA process after long suspensions
(observed: 10 min – 1 hr lock cycles). This is **indistinguishable
from a fresh cold-boot** at the JS layer — same `index.html` parse,
same module fetch, same `initApp()`. The differences are environmental:

| Concern | Cold boot (first install) | Cold resume (after kill) |
|---------|--------------------------|--------------------------|
| HTML in HTTP cache? | no | yes — but SW is **network-first** (`public/sw.js:69-92`) so it still issues a fetch and only falls back on network failure |
| Hashed asset chunks in HTTP cache? | no | typically yes (immutable content-addressed URLs) — but again network-first |
| SW active? | no — install + activate must run | **yes** — SW already activated; install/activate skipped |
| `localStorage` (`gateway.url`, `gateway.token`, palette, snapshot keys) | empty | populated — drives the `savedUrl && savedToken` branch directly |
| IndexedDB (`pi-gateway-ui` v6) | empty | populated — used by `storage.ts:21-32` |
| WS socket | n/a | dead — must reconstruct from scratch |

Net effect: **cold resume is ≥ as expensive as the slow path of cold
boot**, minus SW install and minus credential dialogs. The dominant
JS-parse cost (step 4 in §1) is fully repaid.

The SW does pre-warm likely-next route chunks at install time
(`public/sw.js:30-37`, `PRECACHE_ROUTE_CHUNKS` populated by
`vite.config.ts:161-212`). That helps cold *boot* on a deploy, but
on cold *resume* the install handler doesn't re-run, so the precache
is only useful if a previous boot warmed it. With the current
network-first fetch handler, that pre-warming buys us nothing on a
healthy network and is the offline fallback only.

---

## 4. Identified blocking points

The following `await`s gate first paint or first interactivity. Each
is a candidate for parallelisation, deferral, or cache-replacement.

### 4.1 Pre-first-paint (≤ `init:first-paint`)

**None on the JS side.** `mark("init:first-render"); renderApp();
markPaint("init:first-paint")` runs at `src/app/main.ts:404-406`
without awaiting any gateway state. If something is delaying first
paint, it is either:

- HTML fetch (step 1), or
- main-chunk fetch + parse (step 4), or
- `IndexedDBStorageBackend` constructor in `storage.ts:21-32` blocking
  module evaluation. That backend opens the DB asynchronously but
  module top-level work is sync; the *first* IDB-dependent call
  blocks until the open completes. We do not call any storage method
  before `init:first-paint` — only `setAppStorage(storage)`. So this
  is *not* a first-paint blocker today, but it can become one if
  early code starts reading from IDB.

**Implication:** "white screen for several seconds" cannot be JS-side
once `main:module` has stamped — anything between `pageshow` and
`main:module` is HTML+JS fetch+parse, anything between `main:module`
and `init:first-paint` is module evaluation only and is currently
small. If diagnostics show > 1 s between these two marks on iOS, the
fix is bundle/parse-shape, not awaits.

### 4.2 Pre-session-paint (between `init:first-paint` and first
`messages` snapshot apply)

Every one of these is a serial `await`:

1. **`waitForGateway` polling loop** — `src/app/main.ts:50-71`. Even
   on the happy path it costs `authenticateGateway` (step 16), which
   itself awaits **3 + 1 fetches** (`/api/health`, `Promise.all`
   `/api/sessions` + `/api/goals` + `/api/projects`,
   `/api/config/cwd`) before returning to `initApp`.
   - **Parallelisable?** `authenticateGateway` mixes auth (cheap) with
     `refreshSessions` (heavy 3-way fan-out) and `/api/config/cwd`
     (one more RTT). Splitting auth from data hydration means
     `initApp` could proceed to `connectToSession` after the
     `/api/health` response (~1 RTT) and let session/goal/project
     lists arrive in parallel with the WS handshake.
   - **Deferrable?** The `cwd` fetch is only consumed by the new-
     session dialog; nothing on the resume path needs it.
   - **From cache?** Yes for `/api/health` (we already have a token —
     the only purpose of the fetch is to confirm the server is up
     and the token still works). On a warm install we can render
     optimistically and only flip to "disconnected" if the WS auth
     itself fails. localStorage already says we have valid creds.

2. **`gatewayFetch("/api/preferences")`** — `src/app/main.ts:419-435`.
   Strictly serial after `waitForGateway`; gates the route dispatch.
   - Already consumed in part by the inline boot script
     (`index.html:14-16`) for palette only. `showTimestamps` and
     `playAgentFinishSound` are not visible on first paint of any
     session.
   - **Deferrable?** Yes — fire it but don't `await` before the route
     dispatch. The palette is already applied inline.

3. **`gatewayFetch("/api/sessions/:id")` existence probe** —
   `src/app/main.ts:447`. One RTT before we even create the
   `RemoteAgent`.
   - **Deferrable?** Yes — `remote.connect()` already returns a
     `SESSION_NOT_FOUND` error frame (`src/server/ws/handler.ts:271`
     equivalent). We can let the WS handshake itself confirm
     existence and skip this probe. Saves 1 RTT every session
     navigation.

4. **`remote.connect(url, token, sessionId)`** —
   `src/app/session-manager.ts:920` → `remote-agent.ts:390-432`.
   Inside that: WS construct → open → `auth` frame → `auth_ok`. Two
   server round-trips (TCP+TLS upgrade, then auth ack).
   - **Parallelisable?** The TCP/TLS handshake can start in parallel
     with `waitForGateway` if we kick off the WS at module load and
     swap the in-flight one once `sessionId` is known. iOS won't pre-
     resolve `wss://` for us.

5. **Second `refreshSessions()` inside `connectToSession`** —
   `src/app/session-manager.ts:1701-1739`. The first one fired inside
   `authenticateGateway:456` already populated `state.gatewaySessions`.
   This second call is mostly redundant on resume.
   - **Deferrable?** Yes — guard it with a "first call this boot"
     check or rely on `startSessionPolling`'s 5 s tick.

6. **Draft restore** — `src/app/session-manager.ts:1641-1700`. REST
   GET to `/api/sessions/:id/draft`. Fired in parallel with
   `backgroundWork` but the function `await`s `draftRestorePromise`
   before unlocking proposal checks.
   - **Deferrable?** The proposal-check defer machinery already
     exists (`deferProposalCheck`/`runDeferredProposalCheck`). We
     could let messages render and only block proposal panel
     hydration on the draft restore — the chat content does not need
     it.

### 4.3 Inside the WS handshake (server-side)

After `auth_ok` (`src/server/ws/handler.ts:280`), the server fires
`session.rpcClient.getState()` (`:296`) async — does not block
`auth_ok`. Good.

But the **client** waits for the `messages` reply before painting any
session history. `requestMessages()` is sent at
`src/app/session-manager.ts:1609`, the reply is processed at
`remote-agent.ts:945-1010`, and the reducer's `snapshot` action
replaces `state.messages` (`:949`). Before that frame arrives the
chat panel is the empty "Connecting…" shell from §1.1.c.

The server's `session.eventBuffer` and persisted message log are
already on disk; the time here is one WS RTT plus serialisation of
the message array. On a long transcript this is the most likely
"empty chat for a beat" cost on warm resume.

---

## 5. Hypothesis ranking

Ranked by predicted contribution to user-perceived "white screen +
loading screen + UI" duration on iOS PWA cold resume, with the
mark-pair from `perf.ts` that confirms or refutes it.

| Rank | Hypothesis | Predicted magnitude | Confirming mark pair |
|------|-----------|--------------------|---------------------|
| 1 | **JS chunk fetch + parse + execute (HTML→`main:module`).** iOS PWA has no in-process JIT cache after kill; every cold resume re-parses ~1 MB of JS. Even at -64% gz from #461 this is multi-second on a degraded radio. The user describes "white screen" before any UI — only this can produce that. | 1500–4000 ms | `perf.timing.responseEnd` (HTML) → `bobbit:main:module`. Network panel for `index.html` and `/assets/*-*.js` waterfall. |
| 2 | **`waitForGateway` + `authenticateGateway` chain.** `/api/health` + `Promise.all(sessions, goals, projects)` + `/api/config/cwd` is **5 RTTs** before `init:gateway-wait-end`, *all serial vs. WS open*. On a degraded radio each RTT is 200–800 ms. This is the most likely source of the post-paint "loading screen". | 1000–4000 ms | `init:first-paint` → `init:gateway-wait-end` (covers steps 16a–16f). |
| 3 | **WS handshake (TCP+TLS+upgrade+auth) on a frozen-socket connection.** iOS commonly returns OPEN-but-dead sockets; the visibility handler's "if not OPEN, reconnect immediately" branch helps, but `_connectWs` then races a 15 s `CONNECT_TIMEOUT_MS`. On a normal network it's 1–2 RTTs; on a wedge it's the full 15 s. | 200 ms – 15 s | `ws:construct` → `ws:auth-ok`. `ws:reconnect-construct` → `ws:reconnect-auth-ok` if a reconnect happened. |
| 4 | **Transcript hydration (`get_messages` reply + reducer snapshot apply).** Long-running goals can have 100+ messages; serialisation + reducer merge is non-trivial. Until it lands, the chat area is the empty `ChatPanel` shell. | 100–800 ms | `ws:auth-ok` → first `state_update` from snapshot. (Need a new mark — see §7 cheap wins.) |
| 5 | **`/api/preferences` fetch.** One RTT, gated serially before route dispatch. Palette is already applied inline (`index.html:14-16`) so the only user-visible payload is `showTimestamps` / `playAgentFinishSound`. | 100–500 ms | `init:gateway-wait-end` → `init:prefs-loaded`. |
| 6 | **SW activation race on cold resume.** The SW is already activated on a previously-installed PWA, so this is **not** a contributor on cold resume. On a fresh install only. | ~0 ms on resume | n/a |
| 7 | **Session-list fetch.** Already covered inside (2). Not double-count. | n/a | n/a |
| 8 | **IndexedDB open in `storage.ts:21-32`.** Only blocks the first IDB-dependent call (`storage.providerKeys.set(...)` deep in `connectToSession`). Almost certainly noise vs. (1)-(3). | < 100 ms | Add a mark before/after first IDB read if (1)-(3) ranking is wrong. |

The user's report is "white screen for several seconds, then full-page
loading screen for several more seconds, then UI". That maps to:

- **white screen** = before `init:first-paint`. Hypothesis 1.
- **full-page loading screen** = `appView === "gateway-starting"`
  rendered between `init:first-paint` and `init:gateway-wait-end`.
  Hypothesis 2.
- **UI appears** = somewhere between `init:gateway-wait-end` and the
  first `messages` snapshot. Hypothesis 4 governs whether the chat
  has content or just chrome at that point.

---

## 6. Pre-existing mitigations and their failure modes

The reverted PR #450 stack (PR #462 reverted it) tried each of these
mechanisms. The goal spec **forbids reintroducing them without
diagnostic justification**. Summary, evidence threshold, lessons.

### 6.1 Persisted UI snapshot (`src/app/ui-snapshot.ts`)

- **What it tried:** Serialise the UI state (sessions list, active
  session messages, sidebar) to localStorage on every state mutation;
  on cold resume, hydrate `state.messages` synchronously from
  localStorage *before* the WS reply.
- **Why reverted:** `2b2f8f7f` ("Fix skeleton bleed-through +
  duplicate Reconnecting pill post-render") and `bf8badfb` ("Rescue
  users still on the buggy cached index.html") show the snapshot
  approach combined with monkey-patching `Storage.prototype.setItem`
  to retrigger an inline prepaint, which fired on **every state
  mutation** post-boot (selecting a session, opening proposals, every
  WS message). Result: skeleton un-hid mid-session, "Reconnecting…"
  pills stacked. Goal spec also calls out that the "snapshot rendered
  a visually unreadable cache" (§Approach).
- **When worth resurrecting:** Only if hypothesis 4 (transcript
  hydration latency) is confirmed dominant **and** hypothesis 1 (JS
  parse) is already minimised — a snapshot only helps once the JS is
  running. Also requires (a) write-only outside boot, no Storage
  monkey-patching, (b) layout-correct serialisation, not a free-form
  HTML blob, (c) a single replace-with-server-truth on `messages`
  arrival, not an ongoing merge.

### 6.2 Inline CSS skeleton in `index.html`

- **What it tried:** A static skeleton (sidebar + chat panel
  placeholders) baked into `index.html` so the user sees layout
  during the JS parse window.
- **Why reverted:** Same chain as 6.1 — the prepaint script that
  controlled show/hide on the skeleton was retriggered by every
  Storage write, leading to flicker (`2b2f8f7f`). Independently,
  `4aa8f205` ("Fix MIME-script and skeleton-overlay regressions")
  shows the skeleton was intercepting pointer events on every page
  that didn't reach a WS-connected session.
- **When worth resurrecting:** If hypothesis 1 dominates *and* the
  parse window is genuinely 1.5+ s on the target device. Even then,
  must be inert after first Lit render — deletion via single
  `MutationObserver`-on-`data-rendered`, no Storage hooks, no inline
  prepaint that runs more than once.

### 6.3 `__bobbitPrepaint` inline bootstrap

- **What it tried:** Sync inline script applying theme/palette/skeleton
  before `<script type="module">` evaluation.
- **Why reverted:** `2b2f8f7f` — re-firing on every localStorage
  write. The patched `Storage.prototype.setItem` made each post-boot
  mutation re-run the prepaint, undoing skeleton hide.
- **When worth resurrecting:** Theme/palette only (already shipped at
  `index.html:14-16` — that subset survived the revert). Anything
  more elaborate buys < 1 frame and adds re-entry hazards.

### 6.4 Render watchdog + Loading / "Something went wrong" banners

- **What it tried:** 3 s "Reconnecting…", later 8 s "Loading…", 20 s
  "Something went wrong". Inline `<script>` watchdog that fired if
  Lit hadn't flipped `data-rendered` by the threshold.
- **Why reverted:** `0462b86d` describes the JS bundle taking 3–6 s
  to parse on iOS PWA resume — the 3 s watchdog fired on **every**
  resume on slower devices. Bumping to 8 s only delayed the bad UX.
- **When worth resurrecting:** The watchdog is a UX bandage for slow
  parse, not a fix. Skip unless hypothesis 1 cannot be reduced and
  the user prefers "Loading…" over white screen at the parse-cost
  budget. A static `index.html` skeleton (6.2) is a strictly better
  primitive.

### 6.5 `pageshow` force-close WS + heartbeat-gap bypass

- **What it tried:** On `pageshow.persisted=true`, force-close the
  current WS so the existing reconnect logic builds a fresh socket;
  separately, a heartbeat that detected long gaps in server activity
  and bypassed the OS-frozen-socket trust on `ws.readyState === OPEN`.
  See `b4490972`, `914da508`.
- **Why reverted:** Goal spec §Approach: "didn't actually recover
  fast on iOS". The diagnose-the-actual-failure step (frozen socket
  vs. SW intercept vs. readyState transition) was skipped. The
  current `_onVisibilityChange` (`remote-agent.ts:154-208`) already
  handles `ws.readyState !== OPEN` via immediate reconnect. What's
  missing is detection of the **OPEN-but-dead** case.
- **When worth resurrecting:** If hypothesis 3 (WS handshake on
  wedged socket) is confirmed via `ws:reconnect-construct` →
  `ws:reconnect-auth-ok` deltas in the 5–15 s range. The right shape
  is a small ping/pong with a hard timeout, **not** a force-close on
  every `pageshow.persisted=true` (which iOS rarely sets anyway).

### 6.6 SW SWR / cache-first assets

- **What it tried:** Stale-while-revalidate for `index.html` and
  cache-first for `/assets/*` (`3834d21f`). Idea: even on a frozen
  network the cached bundle still loads.
- **Why reverted:** Combined with the persisted-snapshot approach,
  this gave users the "stuck UI after server restart" bug — old
  `index.html` referencing immutable hashed bundles, no Ctrl+Shift+R
  could dislodge it (see commit message of `3834d21f` which itself
  references the prior bypass). The current SW (`public/sw.js`) is
  network-first for everything specifically to avoid this.
- **When worth resurrecting:** Cache-first for `/assets/*` (hashed
  immutable URLs) is **safe in isolation** because hash-changes
  always invalidate. Worth bringing back if hypothesis 1 confirms
  parse time is dominated by network fetch on degraded radio, **and**
  we keep `index.html` itself network-first so a deploy still lands
  on the next reload. The previous failure mode was the *combination*
  of asset-cache-first + HTML-cache-first, not asset-cache-first
  alone.

---

## 7. Cheap wins independent of measurements

These are obviously suboptimal in the current code; fixing them is
defensible regardless of what iOS measurements show. **Do not
implement in this task** — list only.

1. **Remove the `await gatewayFetch("/api/sessions/:id")` existence
   probe before `connectToSession`.** `src/app/main.ts:447` and the
   identical probe in `handleHashChange` at `:115`. The WS handshake
   already returns `SESSION_NOT_FOUND` (`src/server/ws/handler.ts:272`)
   if the session is gone — let the existing error path handle the
   404 case. Saves 1 RTT every session navigation.

2. **Lift `refreshSessions()` out of `authenticateGateway`.**
   `src/app/session-manager.ts:456` blocks `waitForGateway` on three
   parallel REST calls (`Promise.all` of sessions, goals, projects)
   that the route dispatch doesn't strictly need. `connectToSession`
   for a `/session/:id` route can render shell + connect WS without
   the global session list. Move `refreshSessions()` to a fire-and-
   forget after `state.appView = "authenticated"`. Same for
   `/api/config/cwd` at `:458-461`.

3. **Don't `await` `/api/preferences` before route dispatch.**
   `src/app/main.ts:419-435`. The palette is already applied inline at
   `index.html:14-16`. Defer the rest, or make it fire in parallel
   with `connectToSession`.

4. **Skip the second `refreshSessions()` inside `connectToSession`
   on initial boot.** `src/app/session-manager.ts:1701-1707`. The
   first `refreshSessions()` from `authenticateGateway:456` has
   already populated state. Guard with a "first call this boot" flag
   or rely on the 5 s `startSessionPolling` tick.

5. **Add `messages:applied` perf mark.** Stamp at
   `src/app/remote-agent.ts:949` immediately after the snapshot
   reducer apply. Without this we can't measure hypothesis 4 — there
   is no mark between `ws:auth-ok` and "first paint of session
   content".

6. **Add a paint mark after `connectToSession`'s first content
   render.** Currently `markPaint` is only called once at boot
   (`src/app/main.ts:406`). The diagnostic table assumes
   `sinceLastPaintMs` reflects "since last meaningful paint", but
   after a session navigation no second `markPaint` fires, so
   `pageshow` records measure since first-paint of the **previous**
   session.

7. **Kick the WS construction earlier.** `RemoteAgent` is constructed
   at `src/app/session-manager.ts:907` (after `selectSession`,
   `applyProjectPalette`, ChatPanel construction, palette query, and
   localStorage reads). On a `/session/:id` route the `sessionId` is
   known from `getRouteFromHash()` before any of that. Hoist the `new
   WebSocket(...)` to module-load time when the route is `session`,
   so TCP+TLS handshake overlaps with `waitForGateway`.

8. **`_onVisibilityChange` has an OPEN-but-dead blind spot.**
   `src/app/remote-agent.ts:175-208` — when `ws.readyState === OPEN`
   it sends `requestMessages()` and `get_state` and trusts the
   socket. There is no timeout; if the socket is frozen these
   requests never reply and the user sits on stale state. Add a
   `Promise.race` against a 3 s timeout that, on timeout,
   force-closes the socket and reuses the existing `_connectWs(false)`
   path. (This is the *one* surviving lesson from §6.5 worth
   pre-emptive action.)

9. **`startSessionPolling` runs every 5 s on `visible`** —
   `src/app/api.ts:75-89`. After a long suspension the first tick
   fires immediately on `visible`, on top of the
   `visibilitychange` handler in `main.ts:625-665` which **also**
   calls `refreshSessions()` and `gatewayFetch("/api/preferences")`.
   Two redundant fan-outs in the same wake. Reset the polling timer
   on visibility wake so the next tick is 5 s out, not "right now
   plus right now in 5 s".

10. **`storage.providerKeys.set(...)` is on the critical path of
    `connectToSession`** — `src/app/session-manager.ts:1738`. It's
    inside `Promise.all` with `refreshSessions()`, but the function
    `await`s `backgroundWork` later (`:1753`). Writing
    `"gateway-managed"` once per connect is harmless to defer.

---

## 8. Suggested next move (after diagnostics phase)

The cheap wins in §7.1–§7.4 alone collapse the serial chain in §1
from "5 RTTs + WS handshake + transcript fetch" to "WS handshake +
transcript fetch (parallel with prefs/sessions/goals)". That's the
likely majority of hypothesis 2's predicted 1–4 s, paid for by zero
new machinery.

Hypothesis 1 (JS parse) is platform-bound. After §7 wins land, if
iOS measurements still show > 1 s between `pageshow:fresh` and
`init:first-paint`, the only further levers are bundle size (already
-64%) and a static `index.html` skeleton (§6.2 done correctly).

Hypothesis 3 (frozen socket) is independently fixable via §7.8 and
deserves a small WS heartbeat regardless of the rest.

The diagnostic phase's job is to confirm or refute this ordering with
real device measurements before any of §7 ships.
