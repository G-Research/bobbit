import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-tool-permission-audit-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { ToolPermissionAuditLog } = await import("../src/server/agent/tool-permission-audit-log.ts");
const { LifecycleHub } = await import("../src/server/agent/lifecycle-hub.ts");
const { ContextTraceStore } = await import("../src/server/agent/context-trace-store.ts");
const { TOOL_APPROVE_POINT, TOOL_APPROVE_KIND } = await import("../src/server/agent/tool-approve-classifier.ts");

type TestClient = {
	readyState: number;
	bufferedAmount: number;
	sent: any[];
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

const managers: any[] = [];

function makeClient(): TestClient {
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(data: string) { this.sent.push(JSON.parse(data)); },
		close() { this.readyState = 3; },
	};
}

function makeRoleManager() {
	const role = { name: "writer", label: "Writer", toolPolicies: {} };
	return {
		getRole: mock.fn(() => role),
		updateRole: mock.fn(() => {}),
	} as any;
}

function emptyRegistry() {
	return { listProviders: () => [] } as any;
}

function makeHub(): InstanceType<typeof LifecycleHub> {
	return new LifecycleHub({
		registry: emptyRegistry(),
		moduleHost: {} as any,
		trace: new ContextTraceStore(path.join(tmpRoot, "never-written-trace-dir")),
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
	});
}

function makeManager(opts: Record<string, any> = {}): any {
	const manager: any = new SessionManager({
		roleManager: makeRoleManager(),
		...opts,
	});
	manager._testStore = {
		update: mock.fn(() => {}),
		get: mock.fn(() => undefined),
	};
	managers.push(manager);
	return manager;
}

function cleanupManager(manager: any): void {
	if (manager._statusHeartbeatTimer) {
		clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	for (const session of manager.sessions?.values?.() ?? []) {
		if (session.pendingGrantRequest?.timer) clearTimeout(session.pendingGrantRequest.timer);
	}
	manager.sessionsWithConnectedClients?.clear();
	manager.sessions?.clear();
}

function putSession(manager: any, id: string, overrides: Record<string, any> = {}): any {
	const client = makeClient();
	const session = {
		id,
		title: "Tool permission audit test",
		role: "writer",
		projectId: "proj-1",
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 0,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set([client]),
		eventBuffer: new EventBuffer(),
		lastPromptText: "do the thing",
		...overrides,
	};
	manager.sessions.set(session.id, session);
	return { session, client };
}

async function waitForPendingGrant(session: any, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!session.pendingGrantRequest && Date.now() - start < timeoutMs) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.ok(session.pendingGrantRequest, "expected pending grant request");
}

afterEach(() => {
	while (managers.length > 0) cleanupManager(managers.pop());
	mock.restoreAll();
});

describe("SessionManager tool-permission audit log", () => {
	it("writes exactly one audit row for a user grant and one for a user deny", async () => {
		const stateDir = path.join(tmpRoot, "audit-state-1");
		const auditLog = new ToolPermissionAuditLog(stateDir);
		const hub = makeHub();
		hub.registerDecisionClassifier(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, {
			id: "test-tool-approve",
			evaluate: (_ctx: any, arg: any) => arg?.toolName === "bash"
				? { kind: "select", choice: "deny", confidence: 1, rationale: "unsafe shell" }
				: { kind: "select", choice: "allow", confidence: 1, rationale: "safe read" },
		});
		const manager = makeManager({ toolPermissionAuditLog: auditLog });
		manager.lifecycleHub = hub;

		const { session: grantSession } = putSession(manager, "s-audit-grant");
		const grantPromise = manager.requestToolGrant(grantSession.id, "read", "File System");
		await waitForPendingGrant(grantSession);
		await manager.grantToolPermission(grantSession.id, "read", "tool", undefined, "session-only");
		assert.deepEqual(await grantPromise, { granted: true, tools: ["read"], scope: "tool", group: undefined, mode: "session-only" });

		const { session: denySession } = putSession(manager, "s-audit-deny");
		const denyPromise = manager.requestToolGrant(denySession.id, "bash", "Shell");
		await waitForPendingGrant(denySession);
		manager.denyToolPermission(denySession.id, "bash");
		assert.deepEqual(await denyPromise, { granted: false });

		const grantRows = auditLog.read(grantSession.id);
		assert.equal(grantRows.length, 1);
		assert.equal(typeof grantRows[0].ts, "number");
		assert.deepEqual({ ...grantRows[0], ts: 0 }, {
			ts: 0,
			sessionId: grantSession.id,
			projectId: "proj-1",
			toolName: "read",
			toolGroup: "File System",
			decision: "granted",
			source: "user",
			toolApproveDecision: { kind: "select", choice: "allow", confidence: 1, rationale: "safe read" },
		});

		const denyRows = auditLog.read(denySession.id);
		assert.equal(denyRows.length, 1);
		assert.equal(typeof denyRows[0].ts, "number");
		assert.deepEqual({ ...denyRows[0], ts: 0 }, {
			ts: 0,
			sessionId: denySession.id,
			projectId: "proj-1",
			toolName: "bash",
			toolGroup: "Shell",
			decision: "denied",
			source: "user",
			toolApproveDecision: { kind: "select", choice: "deny", confidence: 1, rationale: "unsafe shell" },
		});
	});

	it("does not break the ask flow when the audit append fails", async () => {
		const manager = makeManager({
			toolPermissionAuditLog: {
				append: mock.fn(() => { throw new Error("disk full"); }),
			} as any,
		});
		const { session } = putSession(manager, "s-audit-fail-open");

		const grantPromise = manager.requestToolGrant(session.id, "bash", "Shell");
		await waitForPendingGrant(session);
		manager.denyToolPermission(session.id, "bash");

		assert.deepEqual(await grantPromise, { granted: false });
	});
});
