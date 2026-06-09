// src/app/gesture-context.ts
//
// Client-internal USER-ACTIVATION gate for the durable v1 Host API session WRITE
// (`host.session.postMessage`; design docs/design/extension-host-phase2.md §8
// C2.1). This is NOT a v1 signature parameter — the frozen
// `host.session.postMessage(msg)` contract cannot carry a gesture token (that would
// be a breaking change).
//
// The session WRITE drives the agent, so it is the highest-risk Host-API addition.
// Its UNFORGEABLE transport gate is that the SEND rides the app's authenticated
// session WebSocket (see `session-write-bridge.ts`), which pack code has no handle
// to and cannot send on — so there is NO session secret on any `fetch` for a
// same-realm pack to monkey-patch/capture/replay. (An earlier design carried such a
// secret on a fetch header; that surface is now gone, along with any exported
// secret getter.)
//
// This module supplies the DEFENSE-IN-DEPTH "no post on mount" check layered on top
// of that transport:
//   - `consumeGesture()` reads `navigator.userActivation`: it is `isActive === true`
//     ONLY during a genuine user-gesture call stack (a real button click — INCLUDING
//     a pack panel's own button), and false on mount / after the gesture settles.
//     `host.session.postMessage` throws synchronously when it is false, so a
//     render/mount-time post fails loudly. This is a browser-enforced signal a pack
//     cannot fake (a programmatic call with no transient activation is never
//     "active").
//
// `runWithUserGesture` is kept as a thin wrapper (it no longer sets a flag — the
// real gate is `navigator.userActivation`) so existing genuine-gesture call sites
// and tests keep compiling; the synchronous activation check is what matters.

/**
 * Thin wrapper kept for genuine user-gesture call sites and tests. The real
 * "no post on mount" gate is `navigator.userActivation` (read in
 * {@link consumeGesture}), NOT a flag set here — a pack cannot fabricate transient
 * activation, so wrapping is unnecessary for security. Retained so existing
 * handlers (entrypoint launchers, git-widget / command-palette clicks, composer
 * slash invocation) and tests keep compiling without churn.
 */
export function runWithUserGesture<T>(fn: () => T): T {
	return fn();
}

/**
 * Return true when a GENUINE user activation is currently active
 * (`navigator.userActivation.isActive`). True only inside a real user-gesture call
 * stack (a button click — including a pack panel's own button); false on mount /
 * programmatic calls. `host.session.postMessage` calls this at its synchronous
 * prologue and throws when it returns false.
 *
 * `navigator.userActivation` is unavailable in non-DOM/unit contexts; there we
 * return false so a post never fires without an explicit (mocked) activation.
 */
export function consumeGesture(): boolean {
	const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { userActivation?: { isActive?: boolean } }) : undefined;
	return nav?.userActivation?.isActive === true;
}

/** Non-consuming probe of the current activation state (diagnostics/tests). */
export function isGestureActive(): boolean {
	return consumeGesture();
}
