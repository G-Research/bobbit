// src/app/gesture-context.ts
//
// Client-internal USER-GESTURE TOKEN for the durable v1 Host API
// (design docs/design/extension-host-phase2.md §8 C2.1). This is NOT a v1
// signature parameter — the frozen `host.session.postMessage(msg)` contract
// cannot carry a gesture token (that would be a breaking change), so the
// "no post on mount" guarantee is enforced by this transient module-scoped flag
// instead of a reviewer convention.
//
// Genuine user-gesture handlers — entrypoint launchers (C1), git-widget /
// command-palette button clicks, composer-slash invocation — wrap their handler
// body in `runWithUserGesture(...)`. `host.session.postMessage` calls
// `consumeGesture()` SYNCHRONOUSLY at its prologue (before any await): if no
// gesture is active it throws so a render/mount-time post fails loudly; if one is
// active it consumes+clears it (a gesture authorizes exactly ONE post — no
// latching) and proceeds to the authorized, audited server POST.
//
// The server still independently authorizes every post (authorizeScopedRequest:
// header-bound session, body===header, tool ∈ allowedTools, server-derived
// packId, audit). This flag is client-side defense-in-depth, not the only gate.
//
// Fix 5 — SERVER-VALIDATED single-use gesture NONCE. The flag above is bypassable
// by a same-realm pack `fetch('/api/ext/session/message', …)`. To make the gate
// UNFORGEABLE, a genuine gesture additionally fetches a server-minted single-use
// nonce (POST /api/ext/session/gesture) which `host.session.postMessage` attaches
// and the server consumes. The nonce is held in this MODULE CLOSURE
// (`pendingNonce`) — never on `window` or the `host` object — so pack code cannot
// read it. The minter is injected by trusted app code (host-api.ts) via
// `setGestureNonceMinter`; tests inject a stub.

let activeGesture = false;

/** Trusted minter for a server gesture nonce. Injected by host-api.ts; held in a
 *  module closure (never exposed to pack code). Returns null when unavailable. */
let nonceMinter: (() => Promise<string | null>) | null = null;

/** The nonce promise for the CURRENT gesture, kicked off inside runWithUserGesture
 *  and awaited+cleared by takeGestureNonce(). Module-private — pack code cannot read it. */
let pendingNonce: Promise<string | null> | null = null;

/** Register the trusted server gesture-nonce minter (POSTs /api/ext/session/gesture).
 *  Called only by trusted app code; never exposed on `window`/`host`. */
export function setGestureNonceMinter(fn: (() => Promise<string | null>) | null): void {
	nonceMinter = fn;
}

/**
 * Await + CLEAR the current gesture's server nonce (single-use, one post per
 * gesture). Returns null when no gesture nonce is pending or the mint failed.
 * `host.session.postMessage` calls this in its async body and attaches the result.
 */
export async function takeGestureNonce(): Promise<string | null> {
	const p = pendingNonce;
	pendingNonce = null;
	if (!p) return null;
	try { return await p; } catch { return null; }
}

/**
 * Run `fn` with the user-gesture flag set for the SYNCHRONOUS duration of the
 * call. Restores the prior value afterward (nesting-safe). Any synchronous
 * `host.session.postMessage` issued from within `fn` will see an active gesture
 * and consume it; a post issued asynchronously AFTER `fn` returns will NOT (the
 * flag has been restored), which is exactly the "no auto-post on mount / after
 * the gesture settles" guarantee.
 */
export function runWithUserGesture<T>(fn: () => T): T {
	const prev = activeGesture;
	activeGesture = true;
	// Kick off a fresh server-minted single-use nonce for THIS gesture and hold the
	// promise in the module closure (pack code cannot reach it). The async
	// postMessage body awaits it via takeGestureNonce(); it outlives the synchronous
	// gesture window on purpose, and expires server-side (TTL) if never consumed.
	pendingNonce = nonceMinter ? nonceMinter().catch(() => null) : Promise.resolve(null);
	try {
		return fn();
	} finally {
		activeGesture = prev;
	}
}

/**
 * Read-and-clear the gesture flag. Returns true exactly once per active gesture
 * (consuming it), false otherwise. `host.session.postMessage` calls this at its
 * synchronous prologue and throws when it returns false.
 */
export function consumeGesture(): boolean {
	if (!activeGesture) return false;
	activeGesture = false;
	return true;
}

/** Non-consuming probe of the gesture flag (diagnostics/tests). */
export function isGestureActive(): boolean {
	return activeGesture;
}
