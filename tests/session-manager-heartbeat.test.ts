import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-heartbeat-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");

type TestClient = {
	readyState: number;
	bufferedAmount: number;
	sent: any[];
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

const managers: any[] = [];

function makeManager(): any {
	const manager: any = new SessionManager();
	managers.push(manager);
	return manager;
}

function cleanupManager(manager: any): void {
	if (manager._statusHeartbeatTimer) {
		clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager.sessionsWithConnectedClients?.clear();
	manager.sessions?.clear();
}

function makeClient(): TestClient {
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(data: string) { this.sent.push(JSON.parse(data)); },
		close() { this.readyState = 3; },
	};
}

function putSession(manager: any, id: string, overrides: Record<string, any> = {}): any {
	const session = {
		id,
		title: id,
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 7,
		createdAt: 1,
		lastActivity: 1,
		clients: new Set(),
		streamingStartedAt: undefined,
		...overrides,
	};
	manager.sessions.set(id, session);
	return session;
}

afterEach(() => {
	while (managers.length > 0) cleanupManager(managers.pop());
});

describe("SessionManager status heartbeat connected-session tracking", () => {
	it("tracks attached sessions and sends heartbeat with unchanged statusVersion", () => {
		const manager = makeManager();
		for (let i = 0; i < 100; i++) putSession(manager, `s-${i}`);
		const session = manager.sessions.get("s-42");
		const client = makeClient();

		assert.equal(manager.addClient("s-42", client as any), true);
		assert.equal(manager.sessionsWithConnectedClients.size, 1);
		assert.equal(manager.sessionsWithConnectedClients.has(session), true);

		manager._emitStatusHeartbeat();

		assert.equal(session.statusVersion, 7, "heartbeat must not bump statusVersion");
		assert.deepEqual(client.sent, [{ type: "session_status", status: "idle", statusVersion: 7 }]);
	});

	it("removes disconnected sessions from the heartbeat set", () => {
		const manager = makeManager();
		putSession(manager, "s-1");
		const client = makeClient();
		manager.addClient("s-1", client as any);
		assert.equal(manager.sessionsWithConnectedClients.size, 1);

		manager.removeClient("s-1", client as any);
		assert.equal(manager.sessionsWithConnectedClients.size, 0);

		manager._emitStatusHeartbeat();
		assert.equal(client.sent.length, 0);
	});

	it("prunes terminated sessions and re-adds them on reconnect", () => {
		const manager = makeManager();
		const session = putSession(manager, "s-1");
		const firstClient = makeClient();
		manager.addClient("s-1", firstClient as any);

		session.status = "terminated";
		manager._emitStatusHeartbeat();
		assert.equal(firstClient.sent.length, 0, "terminated sessions are skipped");
		assert.equal(manager.sessionsWithConnectedClients.size, 0, "terminated sessions are pruned");

		session.status = "idle";
		const secondClient = makeClient();
		manager.addClient("s-1", secondClient as any);
		assert.equal(manager.sessionsWithConnectedClients.size, 1, "reconnect re-adds the session");

		manager._emitStatusHeartbeat();
		assert.deepEqual(secondClient.sent, [{ type: "session_status", status: "idle", statusVersion: 7 }]);
	});
});
