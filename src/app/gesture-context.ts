// src/app/gesture-context.ts
//
// Client-internal USER-ACTIVATION gate + trusted per-session SECRET holder for the
// durable v1 Host API (design docs/design/extension-host-phase2.md §8 C2.1). This
// is NOT a v1 signature parameter — the frozen `host.session.postMessage(msg)`
// contract cannot carry a gesture token (that would be a breaking change).
//
// THREAT (Fix A): a pack renderer/panel runs in the MAIN UI realm. It shares the
// app's ambient credentials (bearer token in localStorage, cookies) so it CAN make
// authenticated `fetch()` calls — including a raw `fetch('/api/ext/session/message')`
// that would drive the agent, bypassing any client-only flag. The previous design
// used a server-minted single-use nonce, but the nonce-minting endpoint was itself
// callable by same-realm pack code, so the gate was forgeable.
//
// RESOLUTION — two independent, unforgeable gates:
//   1. REAL user activation. `consumeGesture()` reads `navigator.userActivation`:
//      it is `isActive === true` ONLY during a genuine user-gesture call stack (a
//      real button click — INCLUDING a pack panel's own button), and false on
//      mount / after the gesture settles. `host.session.postMessage` throws
//      synchronously when it is false, so a render/mount-time post fails loudly.
//      This is a browser-enforced signal a pack cannot fake (a programmatic call
//      with no transient activation is never "active").
//   2. TRUSTED per-session secret. The server REQUIRES the `x-bobbit-session-secret`
//      header on the post endpoint (SessionSecretStore — see session-write.ts /
//      server.ts). The secret is delivered to TRUSTED UI over the authenticated app
//      connection and held HERE in a module closure (`sessionSecrets`) — never on
//      `window` or the `host` object — so same-realm pack code cannot read it. A raw
//      pack fetch therefore carries no secret and is rejected 403 server-side.
//
// `runWithUserGesture` is kept as a thin wrapper (it no longer sets a flag — the
// real gate is `navigator.userActivation`) so existing genuine-gesture call sites
// and tests keep compiling; the synchronous activation check is what matters.

/** Per-session capability secret, delivered to TRUSTED app code over the
 *  authenticated connection (the same SessionSecretStore the children extension
 *  resolves against) and held in this MODULE CLOSURE — never on `window`/`host`,
 *  so same-realm pack code cannot read it. `host.session.postMessage` attaches it
 *  as `x-bobbit-session-secret`; the server resolves it back to the session. */
const sessionSecrets = new Map<string, string>();

/** Record the trusted per-session secret. Called ONLY by trusted app/connection
 *  code (e.g. on the authenticated WS handshake). Never exposed on `window`/`host`. */
export function setSessionSecret(sessionId: string | undefined, secret: string | undefined): void {
	if (!sessionId) return;
	if (typeof secret === "string" && secret.length > 0) sessionSecrets.set(sessionId, secret);
	else sessionSecrets.delete(sessionId);
}

/** Read the trusted per-session secret for the bound session (or undefined).
 *  Module-private to trusted app code — pack code cannot reach this closure. */
export function getSessionSecret(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	return sessionSecrets.get(sessionId);
}

/** Drop a session's secret (call on disconnect / session removal). */
export function clearSessionSecret(sessionId: string | undefined): void {
	if (sessionId) sessionSecrets.delete(sessionId);
}

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
