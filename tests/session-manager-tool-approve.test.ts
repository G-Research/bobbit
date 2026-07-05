// CLF-W2: `SessionManager.requestToolGrant` wiring for the tool auto-approve/
// deny decision seam.
//
// Pins the wave's core safety properties (see
// src/server/agent/tool-approve-classifier.ts's header for the full design):
//
//   1. OBSERVE MODE (default): a registered classifier's decision — allow OR
//      deny — is recorded via `dispatchDecision`'s own trace, but NEVER
//      changes what `requestToolGrant` does next. The human-ask flow
//      (broadcast + pending-grant promise) runs exactly as before.
//   2. ENFORCE MODE (`BOBBIT_CLF_TOOL_APPROVE=enforce`): only a `select` with
//      `choice: "deny"` short-circuits to `{ granted: false }` immediately —
//      no broadcast, no pending-grant timer. A `select` with
//      `choice: "allow"` is NOT auto-applied even in enforce mode this wave
//      (CQ-03 permit wiring is deferred) — it degrades to the same no-op as
//      observe mode / an abstain.
//   3. Byte-identical when no hub is attached, or a hub is attached but the
//      pair was never allow-listed/registered — both must behave exactly
//      like today, never throwing out of `requestToolGrant`.
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-tool-approve-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
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

function emptyRegistry() {
	return { listProviders: () => [] } as any;
}

/** A bare hub pointed at a directory that is never written by these tests —
 *  mirrors the stub idiom in tests/lifecycle-hub-dispatch-decision.test.ts
 *  and tests/session-manager-thinking-router.test.ts. No `dispatch()` call
 *  ever runs, so any recorded decision falls to the in-memory ring
 *  (`getDecisionTrace()`). */
function makeHub(): InstanceType<typeof LifecycleHub> {
	return new LifecycleHub({
		registry: emptyRegistry(),
		moduleHost: {} as any,
		trace: new ContextTraceStore(path.join(tmpRoot, "never-written-trace-dir")),
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
	});
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
		id: "s-tool-approve",
		title: "Tool-approve seam test",
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

/**
 * `requestToolGrant` now `await`s the tool-approve seam consult before
 * reaching the human-ask flow (frame allocation + broadcast + pending-grant
 * creation) whenever a hub is attached — so, unlike the pre-CLF-W2 code, that
 * work no longer necessarily lands in the same microtask as the call. Poll
 * for `pendingGrantRequest` rather than asserting immediately after calling.
 * Not needed for the no-hub / enforce-auto-deny cases, which are still
 * synchronous end-to-end (see requestToolGrant's own comment on why the hub
 * check must stay OUTSIDE the `await`).
 */
async function waitForPendingGrant(session: any, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!session.pendingGrantRequest && Date.now() - start < timeoutMs) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("SessionManager.requestToolGrant — tool-approve decision seam (CLF-W2)", () => {
	describe("observe mode (default, no BOBBIT_CLF_TOOL_APPROVE)", () => {
		it("records a select(deny) but still runs the full human-ask flow (no auto-deny)", async () => {
			const hub = makeHub();
			hub.registerDecisionClassifier(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, {
				id: "test-classifier",
				evaluate: () => ({ kind: "select", choice: "deny", rationale: 'deny tool "bash_bg" (group shell) for role writer' }),
			});
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "bash_bg", "shell");
			// Human-ask flow must still be live: broadcast fired, pending grant set.
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1, "observe mode must still broadcast tool_permission_needed");
			assert.ok(session.pendingGrantRequest, "observe mode must still create a pending grant request");

			// Unblock the promise the same way a user clicking Deny would.
			manager.denyToolPermission(session.id, "bash_bg");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false });

			const ring = hub.getDecisionTrace();
			assert.equal(ring.length, 1, "the seam's outcome must still be recorded via dispatchDecision's own trace");
			assert.equal(ring[0].point, "tool-call");
			assert.equal(ring[0].decisionKind, "tool-approve");
			assert.deepEqual(ring[0].consulted, ["test-classifier"]);
			assert.deepEqual(ring[0].decision, { kind: "select", choice: "deny", rationale: 'deny tool "bash_bg" (group shell) for role writer' });
		});

		it("records a select(allow) but still runs the full human-ask flow (no auto-grant)", async () => {
			const hub = makeHub();
			hub.registerDecisionClassifier(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, {
				id: "test-classifier",
				evaluate: () => ({ kind: "select", choice: "allow", rationale: 'allow tool "read_file" (group fs) for role writer' }),
			});
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "read_file", "fs");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1, "observe mode must still broadcast even for a select(allow)");
			assert.ok(session.pendingGrantRequest);

			manager.denyToolPermission(session.id, "read_file");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false });

			const ring = hub.getDecisionTrace();
			assert.equal(ring.length, 1);
			assert.equal((ring[0].decision as any).choice, "allow");
		});

		it("abstains (and records the abstain) when zero classifiers are registered — byte-identical case", async () => {
			const hub = makeHub();
			hub.allowDecisionPoint(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND);
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "bash", "shell");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1);
			manager.denyToolPermission(session.id, "bash");
			await grantPromise;

			const ring = hub.getDecisionTrace();
			assert.equal(ring.length, 1);
			assert.deepEqual(ring[0].decision, { kind: "abstain" });
			assert.deepEqual(ring[0].consulted, []);
		});
	});

	describe("enforce mode (BOBBIT_CLF_TOOL_APPROVE=enforce)", () => {
		it("auto-denies immediately on select(deny) — no broadcast, no pending grant, no timer", async () => {
			process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
			const hub = makeHub();
			hub.registerDecisionClassifier(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, {
				id: "test-classifier",
				evaluate: () => ({ kind: "select", choice: "deny", rationale: 'deny tool "bash_bg" (group shell) for role writer' }),
			});
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const result = await manager.requestToolGrant(session.id, "bash_bg", "shell");
			assert.deepEqual(result, { granted: false, reason: 'deny tool "bash_bg" (group shell) for role writer' });
			assert.equal(grantBroadcasts(client).length, 0, "auto-deny must never broadcast tool_permission_needed");
			assert.equal(session.pendingGrantRequest, undefined, "auto-deny must never create a pending grant request");
		});

		it("does NOT auto-grant on select(allow) — still runs the human-ask flow (CQ-03 widening deferred)", async () => {
			process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
			const hub = makeHub();
			hub.registerDecisionClassifier(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, {
				id: "test-classifier",
				evaluate: () => ({ kind: "select", choice: "allow", rationale: 'allow tool "read_file" (group fs) for role writer' }),
			});
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "read_file", "fs");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1, "select(allow) must still go through the human-ask flow this wave");
			assert.ok(session.pendingGrantRequest);

			manager.denyToolPermission(session.id, "read_file");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false });
		});

		it("runs the normal human-ask flow on abstain, same as observe mode", async () => {
			process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
			const hub = makeHub();
			hub.allowDecisionPoint(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND);
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "bash", "shell");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1);
			manager.denyToolPermission(session.id, "bash");
			await grantPromise;
		});
	});

	describe("byte-identical fallbacks", () => {
		it("is byte-identical (no crash, normal human-ask flow) with no lifecycleHub attached at all — even in enforce mode", async () => {
			process.env.BOBBIT_CLF_TOOL_APPROVE = "enforce";
			const manager = makeManager();
			const { session, client } = putSession(manager);
			assert.equal(manager.lifecycleHub, undefined);

			const grantPromise = manager.requestToolGrant(session.id, "bash", "shell");
			assert.equal(grantBroadcasts(client).length, 1, "no hub ⇒ normal flow regardless of the enforce flag");
			assert.ok(session.pendingGrantRequest);
			manager.denyToolPermission(session.id, "bash");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false });
		});

		it("is fail-open (no throw, normal human-ask flow) when a hub is attached but the pair was never allow-listed", async () => {
			// A bare LifecycleHub with nothing allow-listed would THROW on
			// dispatchDecision (CLF-W0b's allow-list rejection) — requestToolGrant
			// must swallow that, not propagate it.
			const hub = makeHub();
			const manager = makeManager({ hub });
			const { session, client } = putSession(manager);

			const grantPromise = manager.requestToolGrant(session.id, "bash", "shell");
			await waitForPendingGrant(session);
			assert.equal(grantBroadcasts(client).length, 1, "unregistered pair must still reach the human-ask flow, not throw");
			assert.ok(session.pendingGrantRequest);
			manager.denyToolPermission(session.id, "bash");
			const result = await grantPromise;
			assert.deepEqual(result, { granted: false });
		});
	});
});
