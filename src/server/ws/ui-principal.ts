import type { WebSocket } from "ws";

export type WebSocketAuthPrincipal = Readonly<{
	kind: "admin" | "sandbox" | "localhost";
}>;

export type PrincipalTaggedWebSocket = WebSocket & {
	authPrincipal?: WebSocketAuthPrincipal;
};

/**
 * Canonical authority predicate for browser/UI-only WebSocket egress.
 * Caller-controlled product metadata such as clientKind is never consulted.
 */
export function hasUiWebSocketPrincipal(ws: WebSocket): boolean {
	const kind = (ws as PrincipalTaggedWebSocket).authPrincipal?.kind;
	return kind === "admin" || kind === "localhost";
}
