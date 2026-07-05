// CLF-W1b: `SessionManager.enqueuePrompt` wiring for the F14 thinking router.
//
// Pins the wave's core safety property — OBSERVE MODE ONLY: a registered
// router that SELECTS xhigh for an 'ultrathink' prompt must never change the
// session's actual thinking level or the text dispatched to the agent (no
// `setThinkingLevel` call, no prompt mutation). It only (a) gets recorded via
// `LifecycleHub.dispatchDecision`'s own trace and (b) gets stamped onto the
// `QueuedMessage` row when the prompt is queued rather than dispatched
// directly (the "QueuedMessage decision stamping gap" fix, design doc §10
// Wave 1). Also pins the byte-identical-without-registration cases: no hub
// attached, and a hub attached but the (point,kind) pair never registered
// (e.g. a bare test `LifecycleHub`) — both must behave exactly like today,
// never throwing out of `enqueuePrompt`.
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-thinking-router-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { LifecycleHub } = await import("../src/server/agent/lifecycle-hub.ts");
const { ContextTraceStore } = await import("../src/server/agent/context-trace-store.ts");
const { registerThinkingRouterClassifier, THINKING_ROUTER_CLASSIFIER_ID } = await import("../src/server/agent/thinking-router-classifier.ts");

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
 *  mirrors the stub idiom in tests/lifecycle-hub-dispatch-decision.test.ts.
 *  No `dispatch()` call ever runs in these tests, so there is never an active
 *  TraceEntry: any recorded decision falls to the in-memory ring
 *  (`getDecisionTrace()`), which is exactly what these tests assert on. */
function makeHub(): InstanceType<typeof LifecycleHub> {
	return new LifecycleHub({
		registry: emptyRegistry(),
		moduleHost: {} as any,
		trace: new ContextTraceStore(path.join(tmpRoot, "never-written-trace-dir")),
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
	});
}

function makeManager(opts?: { withRegisteredHub?: boolean; withUnregisteredHub?: boolean }): any {
	const manager: any = new SessionManager();
	manager._testStore = {
		update: mock.fn(() => {}),
		get: mock.fn(() => undefined),
	};
	if (opts?.withRegisteredHub) {
		const hub = makeHub();
		registerThinkingRouterClassifier(hub);
		manager.lifecycleHub = hub;
	} else if (opts?.withUnregisteredHub) {
		manager.lifecycleHub = makeHub();
	}
	managers.push(manager);
	return manager;
}

function cleanupManager(manager: any): void {
	if (manager._statusHeartbeatTimer) {
		clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	for (const session of manager.sessions?.values?.() ?? []) {
		if (session.pendingAutoRetryTimer) clearTimeout(session.pendingAutoRetryTimer);
	}
	manager.sessionsWithConnectedClients?.clear();
	manager.sessions?.clear();
}

function putSession(manager: any, overrides: Record<string, any> = {}): any {
	const client = makeClient();
	const session = {
		id: "s-thinking",
		title: "Thinking router test",
		titleGenerated: true,
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 0,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set([client]),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		streamingStartedAt: undefined,
		modelProvider: "openrouter",
		rpcClient: {
			prompt: mock.fn(async () => ({ success: true })),
			setThinkingLevel: mock.fn(async () => ({ success: true })),
		},
		...overrides,
	};
	manager.sessions.set(session.id, session);
	return { session, client };
}

afterEach(() => {
	while (managers.length > 0) cleanupManager(managers.pop());
	delete process.env.BOBBIT_CLF_THINKING_ROUTER;
});

describe("SessionManager.enqueuePrompt — F14 thinking router (CLF-W1b, observe mode)", () => {
	it("records a real xhigh SELECT for an 'ultrathink' prompt but never applies it (no setThinkingLevel, dispatch text unchanged)", async () => {
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager);

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.prompt.mock.callCount(), 1);
		assert.equal(
			session.rpcClient.prompt.mock.calls[0].arguments[0],
			"ultrathink: redesign the auth flow end to end",
			"observe mode must not rewrite the dispatched prompt text",
		);
		assert.equal(
			session.rpcClient.setThinkingLevel.mock.callCount(),
			0,
			"observe mode must never call setThinkingLevel — the session's live thinking level is untouched this wave",
		);

		const ring = manager.lifecycleHub.getDecisionTrace();
		assert.equal(ring.length, 1, "the router's outcome must still be recorded via dispatchDecision's own trace");
		assert.equal(ring[0].point, "user-prompt-submit");
		assert.equal(ring[0].decisionKind, "thinking");
		assert.deepEqual(ring[0].consulted, [THINKING_ROUTER_CLASSIFIER_ID]);
		assert.equal(ring[0].decision.kind, "select");
		assert.equal((ring[0].decision as any).choice, "xhigh");
	});

	it("abstains (and records the abstain) for an ordinary prompt with no override keyword", async () => {
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager);

		await manager.enqueuePrompt(session.id, "fix this typo in the README");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0);
		const ring = manager.lifecycleHub.getDecisionTrace();
		assert.equal(ring.length, 1);
		assert.deepEqual(ring[0].decision, { kind: "abstain" });
	});

	it("stamps the thinkingDecision onto the QueuedMessage row when the prompt is queued rather than dispatched directly", async () => {
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager, { status: "streaming" });

		await manager.enqueuePrompt(session.id, "ultrathink about the queueing bug");

		assert.equal(session.rpcClient.prompt.mock.callCount(), 0, "busy session must queue, not dispatch directly");
		assert.equal(session.promptQueue.length, 1);
		const queued = session.promptQueue.peek();
		assert.ok(queued?.thinkingDecision, "queued-path decision-stamping gap fix: the row must carry the computed decision");
		assert.equal(queued!.thinkingDecision!.classifierId, THINKING_ROUTER_CLASSIFIER_ID);
		assert.deepEqual(queued!.thinkingDecision!.decision, { kind: "select", choice: "xhigh", confidence: 1, rationale: "matched deterministic rule 'ultrathink'" });
		assert.equal(typeof queued!.thinkingDecision!.ts, "number");

		// Still observe-mode: queueing a decision never applies it either.
		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0);
	});

	it("does not stamp a QueuedMessage when the router abstains", async () => {
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager, { status: "streaming" });

		await manager.enqueuePrompt(session.id, "just a normal follow-up message");

		const queued = session.promptQueue.peek();
		assert.ok(queued);
		assert.deepEqual(queued!.thinkingDecision?.decision, { kind: "abstain" });
	});

	it("is byte-identical (no crash, no stamping) with no lifecycleHub attached at all", async () => {
		const manager = makeManager();
		const { session } = putSession(manager);
		assert.equal(manager.lifecycleHub, undefined);

		await manager.enqueuePrompt(session.id, "ultrathink but there is no hub wired");

		assert.equal(session.rpcClient.prompt.mock.callCount(), 1);
		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0);
	});

	it("is fail-open (no throw, no stamping) when a hub is attached but the pair was never registered", async () => {
		const manager = makeManager({ withUnregisteredHub: true });
		const { session } = putSession(manager);

		// A bare LifecycleHub with nothing registered would THROW on
		// dispatchDecision (CLF-W0b's allow-list rejection) — enqueuePrompt
		// must swallow that, not propagate it.
		await manager.enqueuePrompt(session.id, "ultrathink but the router was never registered on this hub");

		assert.equal(session.rpcClient.prompt.mock.callCount(), 1, "prompt must still dispatch despite the unregistered pair");
		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0);
	});

	it("queues without a thinkingDecision stamp when the hub pair is unregistered", async () => {
		const manager = makeManager({ withUnregisteredHub: true });
		const { session } = putSession(manager, { status: "streaming" });

		await manager.enqueuePrompt(session.id, "ultrathink but unregistered, and busy");

		assert.equal(session.promptQueue.length, 1);
		assert.equal(session.promptQueue.peek()?.thinkingDecision, undefined);
	});
});

// CLF-W3: `BOBBIT_CLF_THINKING_ROUTER=enforce` apply mode. The three-state
// flag mirrors `BOBBIT_CLF_TOOL_APPROVE` (isToolApproveEnforceMode): absent or
// any value other than the exact string "enforce" (including "observe") must
// stay byte-identical to the CLF-W1b describe block above — pinned again here
// explicitly rather than assumed, since this is the block most likely to
// regress if a future change widens the enforce check.
describe("SessionManager.enqueuePrompt — F14 thinking router apply mode (CLF-W3)", () => {
	it("applies the classifier's exact selection via setThinkingLevel and marks the recorded outcome applied:true", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager);

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 1);
		assert.equal(session.rpcClient.setThinkingLevel.mock.calls[0].arguments[0], "xhigh");

		const ring = manager.lifecycleHub.getDecisionTrace();
		assert.equal(ring.length, 1);
		assert.equal(ring[0].decision.kind, "select");
		assert.equal(ring[0].applied, true, "the transparency row must show applied:true when apply mode actually applies a select");
	});

	it("never calls setThinkingLevel on an abstain, even in enforce mode", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager);

		await manager.enqueuePrompt(session.id, "fix this typo in the README");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0);
		const ring = manager.lifecycleHub.getDecisionTrace();
		assert.deepEqual(ring[0].decision, { kind: "abstain" });
		assert.equal(ring[0].applied, undefined, "applied is not meaningful for an abstain and must not be set");
	});

	it("loses to an explicit user-pinned thinking level — never overridden downward", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager, { thinkingLevelUserPinned: true });

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0, "an explicit user pin must never be overridden by the classifier");
		const ring = manager.lifecycleHub.getDecisionTrace();
		assert.equal(ring[0].decision.kind, "select", "the decision is still recorded for telemetry even though it's not applied");
		assert.equal(ring[0].applied, false, "recorded outcome must reflect that apply was skipped");
	});

	it("loses to a role-level thinkingLevel override — never overridden downward", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		manager.configCascade = {
			resolveRoleThinkingLevel: (roleName: string, projectId?: string) => (roleName === "docs-writer" && projectId === "proj-a" ? "low" : undefined),
		};
		const { session } = putSession(manager, { role: "docs-writer", projectId: "proj-a" });

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0, "a role-level thinkingLevel override must never be overridden by the classifier");
		const ring = manager.lifecycleHub.getDecisionTrace();
		assert.equal(ring[0].decision.kind, "select");
		assert.equal(ring[0].applied, false);
	});

	it("is byte-identical to observe mode when BOBBIT_CLF_THINKING_ROUTER is explicitly 'observe'", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "observe";
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager);

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0);
		const ring = manager.lifecycleHub.getDecisionTrace();
		assert.equal(ring[0].applied, false);
	});

	it("applies immediately even when the prompt itself is only queued (busy session) — the apply is about live session state, not this turn's dispatch", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager, { status: "streaming" });

		await manager.enqueuePrompt(session.id, "ultrathink about the queueing bug");

		assert.equal(session.rpcClient.prompt.mock.callCount(), 0, "busy session must still queue the prompt itself");
		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 1, "but the apply is not gated on direct dispatch");
		assert.equal(session.rpcClient.setThinkingLevel.mock.calls[0].arguments[0], "xhigh");
	});

	it("does not persist the applied level as spawnPinnedThinkingLevel — the apply is turn-scoped, not sticky", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager);

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 1);
		assert.equal(session.spawnPinnedThinkingLevel, undefined, "apply mode must not mutate spawnPinnedThinkingLevel");
	});

	it("restores the pre-apply thinking level exactly once on the next abstain", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager, { spawnPinnedThinkingLevel: "medium" });

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 1);
		assert.equal(session.rpcClient.setThinkingLevel.mock.calls[0].arguments[0], "xhigh");
		assert.equal(session.thinkingRouterAppliedBaseline, "medium");

		await manager.enqueuePrompt(session.id, "now do the simple follow-up");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 2);
		assert.equal(session.rpcClient.setThinkingLevel.mock.calls[1].arguments[0], "medium");
		assert.equal(session.thinkingRouterAppliedBaseline, undefined, "restore must clear the transient marker");

		await manager.enqueuePrompt(session.id, "one more ordinary prompt");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 2, "cleared marker must not restore again");
	});

	it("clears the classifier marker without restoring after an explicit user thinking-level change", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager, { spawnPinnedThinkingLevel: "medium" });

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");
		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 1);
		assert.equal(session.thinkingRouterAppliedBaseline, "medium");

		session.spawnPinnedThinkingLevel = "high";
		session.thinkingLevelUserPinned = true;

		await manager.enqueuePrompt(session.id, "ultrathink again, but the user already picked high");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 1, "user-pinned thinking level must win; no baseline restore");
		assert.equal(session.thinkingRouterAppliedBaseline, undefined, "user change clears the classifier-applied marker");
		const ring = manager.lifecycleHub.getDecisionTrace();
		assert.equal(ring[1].decision.kind, "select");
		assert.equal(ring[1].applied, false);
	});

	it("does not apply when BOBBIT_CLF_THINKING_ROUTER is unset (default remains observe)", async () => {
		delete process.env.BOBBIT_CLF_THINKING_ROUTER;
		const manager = makeManager({ withRegisteredHub: true });
		const { session } = putSession(manager);

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 0);
	});

	it("clamps the applied level against the session's current bound model before calling setThinkingLevel", async () => {
		process.env.BOBBIT_CLF_THINKING_ROUTER = "enforce";
		const manager = makeManager({ withRegisteredHub: true });
		// An unrecognized model id falls to aigw-manager's DEFAULT_META
		// (`reasoning: false`), which clamps every requested level down to "off"
		// (thinking-levels.ts: `reasoning === false` ⇒ only "off" is supported).
		// A made-up id (rather than a real non-reasoning model) so this test
		// doesn't depend on pi-ai's live catalog data for any specific model.
		manager._testStore.get = mock.fn(() => ({ modelProvider: "some-custom-provider", modelId: "totally-fake-model-xyz" }));
		const { session } = putSession(manager);

		await manager.enqueuePrompt(session.id, "ultrathink: redesign the auth flow end to end");

		assert.equal(session.rpcClient.setThinkingLevel.mock.callCount(), 1);
		assert.notEqual(
			session.rpcClient.setThinkingLevel.mock.calls[0].arguments[0],
			"xhigh",
			"a model resolved as non-reasoning must never receive an unsupported 'xhigh' literal — same defense-in-depth as ws/handler.ts's set_thinking_level and tryApplyDefaultThinkingLevel",
		);
	});
});
