/**
 * Unit tests for the server-side status subsystem (design doc §3, §6.3):
 *  - `broadcastStatus()` mutates session.status, bumps statusVersion monotonically,
 *    and broadcasts a `session_status` frame to every client.
 *  - Heartbeat-style re-broadcast (replicated inline here) re-emits the current
 *    frame with the SAME statusVersion (no bump).
 *  - `status_resync` handling (replicated inline) returns the current frame.
 *
 * We don't spin a full SessionManager — broadcastStatus is a pure helper over
 * SessionInfo and a Set<WebSocket-shaped client>. The server WS handler's
 * `status_resync` branch is a 6-line lookup we mirror here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Avoid pulling in the full SessionManager (which transitively imports
// project-context-manager + sandbox bits). The helper is a pure module.
const { broadcastStatus } = await import("../src/server/agent/session-status.ts");

/** Minimal SessionInfo-shaped object used purely to exercise `broadcastStatus`. */
function makeFakeSession(status: any = "idle") {
	const sent: any[] = [];
	const fakeClient = {
		readyState: 1,
		bufferedAmount: 0,
		send(data: string) { sent.push(JSON.parse(data)); },
	};
	const session: any = {
		id: "test-session",
		status,
		statusVersion: 0,
		clients: new Set([fakeClient]),
	};
	return { session, sent };
}

describe("broadcastStatus", () => {
	it("mutates status, bumps statusVersion, broadcasts session_status frame", () => {
		const { session, sent } = makeFakeSession("idle");
		broadcastStatus(session, "streaming", { streamingStartedAt: 1234 });
		assert.equal(session.status, "streaming");
		assert.equal(session.statusVersion, 1);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			type: "session_status",
			status: "streaming",
			statusVersion: 1,
			streamingStartedAt: 1234,
		});
	});

	it("statusVersion is monotonic across multiple transitions", () => {
		const { session, sent } = makeFakeSession("idle");
		broadcastStatus(session, "streaming", { streamingStartedAt: 1 });
		broadcastStatus(session, "aborting");
		broadcastStatus(session, "idle");
		broadcastStatus(session, "streaming", { streamingStartedAt: 2 });
		broadcastStatus(session, "terminated");
		assert.equal(session.statusVersion, 5);
		assert.deepEqual(sent.map((m) => [m.status, m.statusVersion]), [
			["streaming", 1],
			["aborting", 2],
			["idle", 3],
			["streaming", 4],
			["terminated", 5],
		]);
	});

	it("omits streamingStartedAt / archivedAt when not provided", () => {
		const { session, sent } = makeFakeSession("idle");
		broadcastStatus(session, "idle");
		assert.equal(sent[0].streamingStartedAt, undefined);
		assert.equal(sent[0].archivedAt, undefined);
	});

	it("attaches archivedAt only on archived branch", () => {
		const { session, sent } = makeFakeSession("idle");
		broadcastStatus(session, "archived", { archivedAt: 9999 });
		assert.equal(sent[0].archivedAt, 9999);
	});

	it("zero-client broadcast is a no-op (still bumps version)", () => {
		const session: any = {
			id: "x",
			status: "idle",
			statusVersion: 0,
			clients: new Set(),
		};
		broadcastStatus(session, "preparing");
		assert.equal(session.status, "preparing");
		assert.equal(session.statusVersion, 1);
	});

	it("skips broadcast to non-OPEN clients", () => {
		const sentOpen: any[] = [];
		const sentClosed: any[] = [];
		const open = { readyState: 1, bufferedAmount: 0, send: (d: string) => sentOpen.push(JSON.parse(d)) };
		const closed = { readyState: 3, bufferedAmount: 0, send: (d: string) => sentClosed.push(JSON.parse(d)) };
		const session: any = { id: "x", status: "idle", statusVersion: 0, clients: new Set([open, closed]) };
		broadcastStatus(session, "streaming");
		assert.equal(sentOpen.length, 1);
		assert.equal(sentClosed.length, 0);
	});
});

describe("status heartbeat (re-emit current frame WITHOUT bumping)", () => {
	// Mirrors `SessionManager._emitStatusHeartbeat` line-for-line.
	function emitHeartbeat(session: any) {
		if (session.clients.size === 0) return;
		if (session.status === "terminated") return;
		const frame: any = {
			type: "session_status",
			status: session.status,
			statusVersion: session.statusVersion ?? 0,
		};
		if (session.streamingStartedAt) frame.streamingStartedAt = session.streamingStartedAt;
		for (const client of session.clients) {
			if (client.readyState !== 1) continue;
			client.send(JSON.stringify(frame));
		}
	}

	it("re-emits with same version (no bump)", () => {
		const { session, sent } = makeFakeSession("streaming");
		session.statusVersion = 3;
		session.streamingStartedAt = 555;
		emitHeartbeat(session);
		emitHeartbeat(session);
		assert.equal(session.statusVersion, 3, "version unchanged");
		assert.equal(sent.length, 2);
		assert.equal(sent[0].statusVersion, 3);
		assert.equal(sent[1].statusVersion, 3);
		assert.equal(sent[0].streamingStartedAt, 555);
	});

	it("skips terminated sessions", () => {
		const { session, sent } = makeFakeSession("terminated");
		emitHeartbeat(session);
		assert.equal(sent.length, 0);
	});

	it("skips sessions with no clients", () => {
		const session: any = { status: "idle", statusVersion: 1, clients: new Set() };
		// No throw, no crash.
		emitHeartbeat(session);
	});
});

describe("status_resync (handler response)", () => {
	// Mirrors the `case "status_resync"` body in src/server/ws/handler.ts.
	function handleStatusResync(session: any, send: (m: any) => void) {
		const frame: any = {
			type: "session_status",
			status: session.status,
			statusVersion: session.statusVersion ?? 0,
		};
		if (session.streamingStartedAt) frame.streamingStartedAt = session.streamingStartedAt;
		send(frame);
	}

	it("returns the current session_status frame without bumping version", () => {
		const session: any = { status: "streaming", statusVersion: 7, streamingStartedAt: 42 };
		const sent: any[] = [];
		handleStatusResync(session, (m) => sent.push(m));
		assert.equal(session.statusVersion, 7);
		assert.deepEqual(sent[0], {
			type: "session_status",
			status: "streaming",
			statusVersion: 7,
			streamingStartedAt: 42,
		});
	});
});
