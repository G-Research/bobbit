/**
 * Compile-time-only regression pin for CQ-01 (`AuthenticatedWS` in ./protocol.ts).
 *
 * Before this finding, every read/write of WS connection state (`authenticated`,
 * `sessionId`, `isViewer`, `isArchived`, `viewerGoalIds`) went through
 * `(ws as any).<prop>`, which erases the property name — a typo at any of the
 * 20+ call sites across server.ts / ws/handler.ts would silently read/write
 * `undefined` and `npm run check` would report zero errors either way (see the
 * finding's reproduction).
 *
 * This file is never imported by runtime code — its only purpose is to sit in
 * the `src/server/**` glob that `npm run check` (`tsc -p tsconfig.server.json
 * --noEmit`) type-checks, so a typo'd property name on `AuthenticatedWS` fails
 * the type-check gate instead of compiling clean. Do not import or call
 * `assertAuthenticatedWsTypoIsRejected` from real code.
 */
import type { AuthenticatedWS } from "./protocol.js";

export function assertAuthenticatedWsTypoIsRejected(ws: AuthenticatedWS): void {
	ws.authenticated = true;
	ws.sessionId = "example-session-id";
	ws.isViewer = true;
	ws.isArchived = true;
	ws.viewerGoalIds = new Set<string>();

	// @ts-expect-error CQ-01 pin: "authenticatd" is not a key of AuthenticatedWS.
	// If this stops erroring, the typed backstop the finding asks for is gone —
	// fix AuthenticatedWS (or this pin), don't delete the assertion.
	ws.authenticatd = true;

	// @ts-expect-error CQ-01 pin: "sessionid" (wrong case) is not a key of AuthenticatedWS.
	ws.sessionid = "typo";
}
