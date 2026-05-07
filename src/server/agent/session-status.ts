/**
 * Single source of truth for status transitions on a session.
 *
 * `broadcastStatus()` mutates `session.status`, bumps `statusVersion`, and
 * broadcasts the new status to every connected client. **Never write
 * `session.status = …` directly** — every transition site routes through here
 * so the version stays monotonic and clients can detect dropped frames.
 *
 * The only legitimate non-helper writers are session-creation init
 * (`status: "…", statusVersion: 0`) and the `shutdown()` final cleanup, where
 * clients are already being closed and broadcast is unnecessary.
 *
 * Lives in its own file (rather than `session-manager.ts`) so unit tests can
 * exercise the helper without dragging in the rest of the SessionManager
 * dependency graph (search, flexstore, sandbox, mcp, …).
 *
 * See docs/design/unify-session-status.md §3.2.
 */
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";

/** Subset of `SessionInfo` the helper actually touches. */
export interface BroadcastableSession {
	status: string;
	statusVersion: number;
	clients: Set<WebSocket>;
	streamingStartedAt?: number;
}

/** Internal: send a single `session_status` frame to every OPEN client. */
function broadcastFrame(clients: Set<WebSocket>, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const client of clients) {
		if (client.readyState !== 1) continue;
		try { client.send(data); } catch { /* per-client send failure is non-fatal */ }
	}
}

/**
 * Mutate `session.status`, bump `statusVersion`, and broadcast the new status
 * to every connected client.
 *
 * `extras` lets transition sites attach `streamingStartedAt` (only on the
 * "streaming" branch) and `archivedAt` (only on the "archived" branch).
 */
export function broadcastStatus<S extends BroadcastableSession>(
	session: S,
	status: S["status"],
	extras?: { streamingStartedAt?: number; archivedAt?: number },
): void {
	session.status = status;
	session.statusVersion = (session.statusVersion ?? 0) + 1;
	broadcastFrame(session.clients, {
		type: "session_status",
		status: status as any,
		statusVersion: session.statusVersion,
		...(extras?.streamingStartedAt ? { streamingStartedAt: extras.streamingStartedAt } : {}),
		...(extras?.archivedAt ? { archivedAt: extras.archivedAt } : {}),
	});
}
