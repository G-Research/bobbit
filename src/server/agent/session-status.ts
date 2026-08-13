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
import { isSocketSendable } from "../ws/socket-sendability.js";
import { resolveSessionRuntime, type SessionRuntime } from "./session-runtime.js";

/** Subset of `SessionInfo` the helper actually touches. */
export interface BroadcastableSession {
	status: string;
	statusVersion: number;
	clients: Set<WebSocket>;
	/** Runtime is server-derived and immutable for the live session. */
	runtime?: SessionRuntime;
	/** Model identity lets legacy/in-flight sessions derive their runtime safely. */
	modelProvider?: string;
	initialModel?: string;
	streamingStartedAt?: number;
}

export type SessionStatusFrame = Extract<ServerMessage, { type: "session_status" }>;

/** Build the canonical status payload shared by transitions and point-in-time projections. */
export function buildSessionStatusFrame(
	session: BroadcastableSession,
	status: string = session.status,
	statusVersion: number = session.statusVersion ?? 0,
	extras?: { streamingStartedAt?: number; archivedAt?: number },
): SessionStatusFrame {
	const hasRuntimeIdentity = session.runtime !== undefined
		|| session.modelProvider !== undefined
		|| session.initialModel !== undefined;
	return {
		type: "session_status",
		status: status as SessionStatusFrame["status"],
		statusVersion,
		...(hasRuntimeIdentity ? {
			runtime: resolveSessionRuntime({
				runtime: session.runtime,
				modelProvider: session.modelProvider,
				initialModel: session.initialModel,
			}),
		} : {}),
		...(extras?.streamingStartedAt ? { streamingStartedAt: extras.streamingStartedAt } : {}),
		...(extras?.archivedAt ? { archivedAt: extras.archivedAt } : {}),
	};
}

/** Internal: send a single `session_status` frame to every OPEN client. */
function broadcastFrame(clients: Set<WebSocket>, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const client of clients) {
		if (!isSocketSendable(client)) continue;
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
	broadcastFrame(session.clients, buildSessionStatusFrame(
		session,
		status,
		session.statusVersion,
		extras,
	));
}
