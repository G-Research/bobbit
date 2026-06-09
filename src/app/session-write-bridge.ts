// src/app/session-write-bridge.ts
//
// Trusted CLIENT transport for the C2 session WRITE (`host.session.postMessage`;
// design docs/design/extension-host-phase2.md §8 C2.1).
//
// THREAT (resolved): a pack renderer/panel runs in the MAIN UI realm. It shares
// the app's ambient credentials and can monkey-patch `window.fetch`. An earlier
// design attached an unforgeable per-session `x-bobbit-session-secret` to a `fetch`
// to drive the agent; but a same-realm pack could monkey-patch `fetch`, CAPTURE
// that header during one legitimate user-gesture post, then REPLAY it without a
// gesture — exfiltrating the secret.
//
// RESOLUTION: the SEND rides the app's already-authenticated session WebSocket. The
// `RemoteAgent` owns the WS (a private field) and registers its WS-bound poster
// HERE on connect; `host.session.postMessage` calls `postSessionMessageOverWs`,
// which forwards to the registered poster. There is NO session secret on any
// `fetch`, and pack code cannot reach this transport: pack renderers/panels are
// Blob-URL modules that cannot import app modules (the `host` object is their only
// surface), and they have no handle to the WS, so they cannot register a poster or
// send on the socket. The server targets the WS connection's OWN authenticated
// session, so cross-session posting is structurally impossible.

/** A session-write request as handed to the trusted WS poster. `sessionId` selects
 *  the bound RemoteAgent's poster; the SERVER ignores it as a target and always
 *  posts into the WS connection's own authenticated session. */
export interface SessionPostRequest {
	sessionId: string | undefined;
	tool: string;
	role: "user" | "system";
	text: string;
	resumeTurn?: boolean;
}

/** A WS-bound poster: resolves when the server acks the post, rejects on error. */
export type WsSessionPoster = (req: SessionPostRequest) => Promise<void>;

// Module-private registry, keyed by session id. NEVER exposed on window/host, so
// pack code (which also cannot import this module) cannot read or replace it.
const posters = new Map<string, WsSessionPoster>();

/** Register the trusted WS poster for a session. Called ONLY by the per-session
 *  `RemoteAgent` on connect; the poster closes over the agent's private WS. */
export function registerSessionPoster(sessionId: string, poster: WsSessionPoster): void {
	if (sessionId) posters.set(sessionId, poster);
}

/** Drop a session's poster (call on disconnect / teardown). */
export function unregisterSessionPoster(sessionId: string): void {
	if (sessionId) posters.delete(sessionId);
}

/**
 * Drive `host.session.postMessage` over the trusted WS. Throws when no bound
 * session is set, or when no trusted WS transport is registered (not connected).
 * The promise settles on the server's correlated ack.
 */
export async function postSessionMessageOverWs(req: SessionPostRequest): Promise<void> {
	if (!req.sessionId) throw new Error("host.session.postMessage requires a bound session");
	const poster = posters.get(req.sessionId);
	if (!poster) throw new Error("host.session.postMessage transport unavailable (no trusted WebSocket)");
	await poster(req);
}
