// CLF-W2.5: `SessionManager.requestToolGrant` wiring for the REAL, conservative
// tool-approve heuristic classifier (`tool-approve-heuristic.ts`) — as opposed
// to `tests/session-manager-tool-approve.test.ts`, which only exercises the
// CLF-W2 seam mechanics with a fake test classifier.
//
// Pins:
//   1. OBSERVE MODE (default): the heuristic's real `select(deny)` for a
//      dangerous-group tool is RECORDED but never changes what
//      `requestToolGrant` does next — the human-ask flow runs exactly as
//      before ("record-only" telemetry, see this lane's design note).
//   2. ENFORCE MODE (`BOBBIT_CLF_TOOL_APPROVE=enforce`): the heuristic's
//      `select(deny)` for a dangerous-group tool auto-denies immediately.
//   3. ENFORCE MODE never auto-applies the heuristic's `select(allow)` for a
//      read-only-safe tool — CQ-03 operator-confirmation permit wiring for
//      widening is still deferred (see tool-approve-classifier.ts) — it
//      degrades to the same human-ask flow as observe mode / an abstain.
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-tool-approve-heuristic-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { LifecycleHub } = await import("../src/server/agent/lifecycle-hub.ts");
const { ContextTraceStore } = await import("../src/server/agent/context-trace-store.ts");
const { registerToolApproveHeuristicClassifier, TOOL_APPROVE_HEURISTIC_CLASSIFIER_ID } = await import("../src/server/agent/tool-approve-heuristic.ts");

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

function emptyRegistry() {
	return { listProviders: () => [] } as any;
}

/** A bare hub with the REAL heuristic classifier registered (not a test
 *  fixture) — mirrors `tests/session-manager-tool-approve.test.ts`'s
 *  `makeHub` idiom, but wires the production classifier under test. */
function makeHubWithHeuristic(): InstanceType<typeof LifecycleHub> {
	const hub = new LifecycleHub({
		registry: emptyRegistry(),
		moduleHost: {} as any,
		trace: new ContextTraceStore(path.join(tmpRoot, "never-written-trace-dir")),
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
	});
	registerToolApproveHeuristicClassifier(hub);
	return hub;
}

function makeManager(opts?: { hub?: InstanceType<typeof LifecycleHub> }): any {
	const manager: any = new SessionManager();
	manager._testStore = {
		update: mock.fn(() => {}),
		get: mock.fn(() => undefined),
	};
	if (opts?.hub) manager.lifecycleHub = opts.hub;
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

function putSession(manager: any, overrides: Record<string, any> = {}): any {
	const client = makeClient();
	const session = {
		id: "s-tool-approve-heuristic",
		title: "Tool-approve heuristic test",
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

afterEach(() => {
	while (managers.length > 0) cleanupManager(managers.pop());
	delete process.env.BOBBIT_CLF_TOOL_APPROVE;
});

function grantBroadcasts(client: TestClient): any[] {
	return client.sent.filter((m) => m.type === "tool_permission_needed");
}

async function waitForPendingGrant(session: any, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!session.pendingGrantRequest && Date.now() - start < timeoutMs) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("SessionManager.requestToolGrant — real tool-approve heuristic (CLF-W2.5)", () => {
	describe("observe mode (default, no BOBBIT_CLF_TOOL_APPROVE) — records but never changes", () => {
		it("a dangerous-group tool (Team) is denied by the heuristic but the human-ask flow still runs unchanged", async () => {
			const hub = makeHubWithHeuristic();
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "team_dismiss", "Team");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1, "observe mode must still broadcast tool_permission_needed even though the heuristic selected deny");
			assert.ok(session.pendingGrantRequest, "observe mode must still create a pending grant request");

			manager.denyToolPermission(session.id, "team_dismiss");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false }, "observe mode never auto-applies the heuristic's verdict — the human's own decision (simulated here as Deny) wins either way");

			const ring = hub.getDecisionTrace();
			assert.equal(ring.length, 1, "the heuristic's real verdict must still be recorded via dispatchDecision's own trace");
			assert.deepEqual(ring[0].consulted, [TOOL_APPROVE_HEURISTIC_CLASSIFIER_ID]);
			assert.equal((ring[0].decision as any).choice, "deny");
			assert.match((ring[0].decision as any).rationale, /'dangerous-group'/);
		});

		it("a read-only-safe tool (ls) is allowed by the heuristic but the human-ask flow still runs unchanged", async () => {
			const hub = makeHubWithHeuristic();
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "ls", "File System");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1);
			assert.ok(session.pendingGrantRequest);

			manager.denyToolPermission(session.id, "ls");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false });

			const ring = hub.getDecisionTrace();
			assert.equal(ring.length, 1);
			assert.equal((ring[0].decision as any).choice, "allow");
			assert.match((ring[0].decision as any).rationale, /'read-only-safe'/);
		});
	});

	describe("enforce mode (BOBBIT_CLF_TOOL_APPROVE=enforce)", () => {
		it("auto-denies a dangerous-group tool immediately — no broadcast, no pending grant, no timer", async () => {
			process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
			const hub = makeHubWithHeuristic();
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const result = await manager.requestToolGrant(session.id, "goal_archive_child", "Children");
			assert.equal(result.granted, false);
			assert.match(result.reason, /'dangerous-group'/);
			assert.match(result.reason, /"goal_archive_child"/);
			assert.equal(grantBroadcasts(client).length, 0, "auto-deny must never broadcast tool_permission_needed");
			assert.equal(session.pendingGrantRequest, undefined, "auto-deny must never create a pending grant request");
		});

		it("does NOT auto-grant a read-only-safe tool — still runs the human-ask flow (CQ-03 widening deferred)", async () => {
			process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
			const hub = makeHubWithHeuristic();
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "grep", "File System");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1, "select(allow) must still go through the human-ask flow this wave");
			assert.ok(session.pendingGrantRequest);

			manager.denyToolPermission(session.id, "grep");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false });
		});

		it("runs the normal human-ask flow for a tool the heuristic abstains on (bash), same as observe mode", async () => {
			process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
			const hub = makeHubWithHeuristic();
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "bash", "Shell");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1);
			manager.denyToolPermission(session.id, "bash");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false });

			const ring = hub.getDecisionTrace();
			assert.equal(ring.length, 1);
			assert.deepEqual(ring[0].decision, { kind: "abstain" });
		});
	});
});
