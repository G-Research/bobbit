# Portrait session cache ownership

## Context

Bobbit keeps recently visited session views in a bounded, client-side LRU in the session manager. Each entry owns both the rendered `ChatPanel` and its connected `RemoteAgent`, so returning to a session can restore the existing transcript DOM and WebSocket instead of rebuilding the panel and showing the connection loader.

Desktop session switching already used this cache. Portrait navigation reaches the same sessions through **Back to session list**, however, so disconnecting on that route made equivalent navigation slower and discarded useful live UI state. Both routes now use the same ownership transfer. This is a navigation optimization only: the portrait layout, route flow, persisted session state, and transcript hydration contract do not change.

The cache is deliberately bounded by `SESSION_CACHE_MAX`. Keeping a small set of connected background agents makes recent returns immediate without allowing panels or WebSockets to grow without limit.

## Admission and ownership

`transferActiveSessionToCache()` in the session manager is the shared release point for direct session switching and portrait back-to-list navigation. It admits a pair only when all ownership markers agree:

- an expected outgoing session id exists and, for a direct switch, differs from the destination;
- the active panel and agent both exist;
- the agent is connected and its `gatewaySessionId` equals the outgoing id;
- both `ChatPanel.agent` and `ChatPanel.agentInterface.session` reference that same `RemoteAgent`.

These checks prevent unrelated globals, a half-bound panel, or an agent left over from another session from becoming reusable merely because all values are non-null.

On admission, the helper places the pair in `sessionCache` before clearing the active panel and agent references. It does not disconnect the transferred agent. On rejection, it disconnects any active agent and clears the active references. The resulting invariant is:

> A `RemoteAgent` is owned either by active application state or by one cache entry, never by both.

`backToSessions()` performs the transfer before clearing the selected id. It still performs its existing draft flush, proposal and review cleanup, preview and inbox subscription teardown, route and palette reset, local-storage update, mobile tracking teardown, render, and session-list refresh.

## Taking a cached session

The existing-session path in `connectToSession()` is the only cache take-ownership path:

- **Healthy entry:** remove the entry from the cache first, then install the exact cached panel and agent as active state. The agent re-registers its Host API transports, but no replacement panel, agent, or session WebSocket is created.
- **Stale entry:** remove the entry, disconnect its agent, and continue through the normal fresh-connect path. The normal loader may mount, a replacement agent and WebSocket are created, and persisted transcript history hydrates as usual.

Deleting the entry before assigning active references preserves single ownership in both cases. Treating a disconnected cached socket as stale also keeps reconnect safety stronger than the performance optimization.

## Eviction and explicit cleanup

Each admission records recency. When the cache exceeds `SESSION_CACHE_MAX`, the oldest entry is disconnected and removed. `uncacheSession(sessionId)` applies the same disconnect-then-remove behavior to one entry.

Navigation reuse must never outlive the session or an explicit gateway teardown:

- session termination uncaches the target before the terminate/archive request;
- a server-pushed `session_removed` event uncaches a session removed, archived, or purged elsewhere, including changes originating in another tab;
- `disconnectGateway()` disconnects the active agent and every cached agent, then clears the cache;
- repeated cleanup is safe because an entry is removed on its first cleanup.

The cache is a module-local `Map`; it is not serialized to browser storage or the server. Each tab has its own cache, and reload, tab closure, or browser termination discards it. Persisted transcript history is separate, so a reload creates a new connection while still restoring history.

## Background-session isolation

Cached agents remain connected so their own panel state can continue receiving session events. They must not own global UI or trigger foreground-only hydration. The selected session id remains the authority for those effects:

- switching or returning to the list stops git polling and aborts the outgoing session's in-flight git refresh before caching it;
- visibility-driven history resync runs only for the selected session, avoiding a burst of `get_messages` calls from cached agents when a mobile tab wakes;
- connection status, reconnect git-status/background-process/annotation hydration, idle-triggered git refresh, git polling, background-process UI events, and preview state are applied only for the active session;
- review reconstruction and review tool results re-check active ownership around asynchronous boundaries;
- proposal callbacks, streaming flags, and end-of-turn flag cleanup ignore inactive agents.

These guards allow a background agent to maintain its session-local transcript without leaking review, proposal, connection, git, or process state into the panel currently on screen.

## Regression evidence

The stable regression coverage is registered in `tests2/tests-map.json`:

- `tests2/dom/portrait-session-cache-repro.test.ts` uses mocked panels and agents to pin strict admission, active-reference clearing, healthy ownership take, stale fallback, bounded eviction and disconnect, explicit and externally pushed cleanup, inactive reconnect hydration isolation, and preservation of back-to-list cleanup.
- `tests2/dom/review-tool-active-guard.test.ts` pins review and proposal isolation for cached agents, including session changes across asynchronous review hydration.
- `tests2/browser/journeys/portrait-session-cache.journey.spec.ts` exercises portrait list round-trips, stale-socket fallback, landscape parity, reload non-persistence, transcript hydration, and session cleanup against the real UI.

The browser journey does not infer reuse from elapsed time. Before navigation it installs a `MutationObserver` for `[data-testid="bobbit-loader"]`, retains the exact panel identity, and counts session WebSocket creation. A healthy return must preserve panel identity with no loader mount or new socket. Deliberately disconnecting the cached agent must instead mount the normal loader, create one replacement session socket, and restore the transcript. Reload evidence similarly requires a new panel and connection while retaining persisted history.
