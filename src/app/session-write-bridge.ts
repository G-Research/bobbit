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
// RESOLUTION (transport): the SEND rides the app's already-authenticated session
// WebSocket. The `RemoteAgent` owns the WS (a private field) and registers its
// WS-bound poster HERE on connect; `host.session.postMessage` calls
// `postSessionMessageOverWs`, which forwards to the registered poster. There is NO
// session secret on any `fetch`, and pack code cannot reach this transport: pack
// renderers/panels are Blob-URL modules that cannot import app modules (the `host`
// object is their only surface). The server targets the WS connection's OWN
// authenticated session, so cross-session posting is structurally impossible.
//
// SAME-REALM REPLAY (the residual the WS-only move did NOT close): a same-realm pack
// can still monkey-patch `WebSocket.prototype.send` / capture the socket and FORGE
// or REPLAY an `ext_session_post` frame. CLOSED by a SERVER-MINTED, one-time,
// content-bound write permit: the poster first mints a nonce (bound to
// {session, packId, tool, contentHash}) over the trusted WS, then sends the post
// carrying it. A replayed post → permit already consumed → rejected; a forged post
// without a mint → no valid nonce → rejected (server-side, session-write-permit.ts).
// The remaining residual (forging the MINT during a genuine gesture) is the
// documented realm-isolation follow-up.

/** A session-write request as handed to the trusted WS poster. `sessionId` selects
 *  the bound RemoteAgent's poster; the SERVER ignores it as a target and always
 *  posts into the WS connection's own authenticated session.
 *
 *  `contentHash` is sha256 hex of `role + "\n" + text`, computed by `host-api.ts`
 *  (SubtleCrypto). The poster first mints a server-minted, one-time, content-bound
 *  write permit (`ext_session_write_permit`, binding this hash) and then sends the
 *  post carrying the returned nonce — so a captured/replayed post frame is rejected
 *  (permit already consumed) and a tampered role/text fails the hash binding. See
 *  session-write-permit.ts + design extension-host-phase2.md §8 C2.1. */
export interface SessionPostRequest {
	sessionId: string | undefined;
	tool: string;
	role: "user" | "system";
	text: string;
	resumeTurn?: boolean;
	contentHash: string;
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
