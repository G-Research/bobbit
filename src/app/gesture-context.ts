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
// packId, audit). This token is client-side defense-in-depth, not the only gate.

let activeGesture = false;

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
