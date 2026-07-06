import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const LIVE_CONTROL = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-live-control.ts"), "utf-8");
const SESSION_MANAGER = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-manager.ts"), "utf-8");

function methodBody(source: string, marker: string): string {
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, `precondition: method marker exists: ${marker}`);
	const tail = source.slice(start + 1);
	const boundary = tail.search(/\n\t(?:async |private |public |static |get |set |\/\*\*)|\n\}/);
	assert.notEqual(boundary, -1, `precondition: method is bounded: ${marker}`);
	return source.slice(start, start + 1 + boundary);
}

describe("SessionLiveControl source shape (SM decomposition c15)", () => {
	it("SessionManager retains same-named delegating wrappers", () => {
		for (const name of ["addClient", "removeClient", "abortSessionTurn", "forceAbort"]) {
			assert.match(
				SESSION_MANAGER,
				new RegExp(`Delegates to SessionLiveControl[\\s\\S]*?${name}\\(`),
				`${name} wrapper must remain on SessionManager`,
			);
		}
		assert.match(SESSION_MANAGER, /private retainSessionLiveControlHostSurface\(\): void/);
	});

	it("addClient retains dormant-revive comments and canonical attach behavior", () => {
		const body = methodBody(LIVE_CONTROL, "\taddClient(sessionId: string, ws: WebSocket): boolean {");
		assert.match(body, /If session is dormant \(failed restore\), try to revive it/);
		assert.match(body, /Client connected to dormant session/);
		assert.match(body, /restoreSession replaces the map entry — add client to the canonical one/);
		assert.match(body, /return true; \/\/ optimistically accept the client/);
		assert.match(body, /tool_execution_update events from the heartbeat will flow/);
		assert.match(body, /this\._restoreSessionCoalesced\(ps\)/);
		assert.match(body, /revived\.clients\.add\(ws\)/);
		assert.match(body, /this\._trackConnectedSession\(revived\)/);
	});

	it("removeClient retains client-set removal and tracking behavior", () => {
		const body = methodBody(LIVE_CONTROL, "\tremoveClient(sessionId: string, ws: WebSocket): void {");
		assert.match(body, /const session = this\.sessions\.get\(sessionId\);/);
		assert.match(body, /session\.clients\.delete\(ws\);/);
		assert.match(body, /this\._trackConnectedSession\(session\);/);
	});

	it("abortSessionTurn retains soft-abort comments and no-restart behavior", () => {
		const body = methodBody(LIVE_CONTROL, "\tasync abortSessionTurn(id: string): Promise<void> {");
		assert.match(LIVE_CONTROL, /Soft-abort: interrupt the current streaming turn without killing the/);
		assert.match(LIVE_CONTROL, /`goal_resume` can resume it later\. No kill\/restart fallback/);
		assert.match(body, /session\.status !== "streaming"/);
		assert.match(body, /broadcastStatus\(session, "aborting"\)/);
		assert.match(body, /session\.rpcClient\.abort\(\)/);
	});

	it("forceAbort retains grace-race, respawn, and transcript comments", () => {
		const body = methodBody(LIVE_CONTROL, "\tasync forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {");
		assert.match(body, /S40: cancel any pending auto-retry timer regardless of streaming state/);
		assert.match(body, /CRITICAL: register the agent_end listener BEFORE calling abort\(\)/);
		assert.match(body, /Try graceful abort, but do NOT serialize it ahead of the grace race/);
		assert.match(body, /WP4\/RC3: route through emitSessionEvent/);
		assert.match(body, /Derive the effective allowlist from the session\/persisted allowlist/);
		assert.match(body, /Pin model\/thinking-level at spawn for the force-abort respawn/);
		assert.match(body, /Un-poison blank-text user messages before rehydrating/);
		assert.match(body, /this\.cancelPendingAutoRetry\(session, "terminated"\)/);
		assert.match(body, /void \(async \(\) => \{ await session\.rpcClient\.abort\(\); \}\)\(\)\.catch/);
		assert.match(body, /const forceRespawnPersisted = this\.resolveStoreForSession\(id\)\.get\(id\);/);
		assert.match(body, /emitSessionEvent\(session, \{ type: "agent_end", messages: \[\] \}\)/);
		assert.match(body, /this\.drainQueue\(session\)/);
	});
});
