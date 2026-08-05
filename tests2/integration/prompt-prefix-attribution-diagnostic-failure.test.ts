// v2-native — diagnostic attribution failures must not alter agent delivery or provider-hook output.
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import { createPrefixSeed } from "../../src/server/agent/prompt-prefix-attribution.ts";
import { apiFetch, createSession, deleteSession } from "./_e2e/e2e-setup.js";
import { test as gatewayTest } from "./_e2e/in-process-harness.js";

const managers: any[] = [];

function makeManager(): any {
	const manager: any = new SessionManager({ projectContextManager: {} as any, stateDir: "/memfs/prefix-diagnostic-failure" });
	manager._statusHeartbeatTimer && clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	manager.projectContextManager = null;
	manager._testStore = { get: vi.fn(() => undefined), update: vi.fn(() => {}) };
	managers.push(manager);
	return manager;
}

afterEach(() => {
	for (const manager of managers.splice(0)) {
		manager.sessions.clear();
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
	}
});

describe("prompt-prefix attribution diagnostic failure isolation", () => {
	test("keeps setup seeds restart-owned and leaves a throwing recorder outside steer delivery", async () => {
		const manager = makeManager();
		const seed = createPrefixSeed({ system: "system", tools: "tools", skills: "skills", sessionSetupDynamicContext: [] });
		const session: any = {
			id: "diagnostic-failure",
			status: "streaming",
			clients: new Set(),
			promptQueue: new PromptQueue(),
		};
		manager.sessions.set(session.id, session);
		manager._prefixSeeds.set(session.id, seed);
		manager._prefixTraceStore = {
			readPrefixAttribution: () => { throw new Error("injected trace read failure"); },
			appendPrefixAttribution: () => { throw new Error("injected trace write failure"); },
		};

		expect(() => manager.setupPromptPrefixAttribution(session, true)).not.toThrow();
		expect(session.prefixSeed).toBe(seed);
		expect(manager._prefixSeeds.has(session.id)).toBe(false);
		expect(session.prefixAttributionRecorder).toBeUndefined();

		// A restarted session owns its transferred seed; it must not depend on the
		// staging map that was deliberately cleared after setup.
		manager._prefixTraceStore = { readPrefixAttribution: () => [], appendPrefixAttribution: () => {} };
		expect(() => manager.setupPromptPrefixAttribution(session, true)).not.toThrow();
		expect(session.prefixAttributionRecorder).toBeDefined();
		expect(manager._prefixSeeds.has(session.id)).toBe(false);

		const queued = session.promptQueue.enqueue("steer survives diagnostics", { isSteered: true });
		const steer = vi.fn(async () => ({ success: true }));
		session.rpcClient = { steer };
		session.prefixAttributionRecorder = {
			beginDispatch: () => { throw new Error("injected canonicalization failure"); },
		};
		session.prefixAttributionBridge = true;
		manager.preparePromptAuthorDispatch = () => ({ piText: "steer survives diagnostics" });
		await expect(manager._dispatchSteer(session, [queued])).resolves.toBeUndefined();
		expect(steer).toHaveBeenCalledOnce();
		expect(session.promptQueue.toArray()).toEqual([]);
		expect(session.inFlightSteerTexts).toHaveLength(1);
		expect(session.prefixPendingSequence).toBeUndefined();
		expect(session.prefixAttributionRecorder).toBeUndefined();

		session.prefixAttributionRecorder = {
			finalizeBeforePrompt: () => { throw new Error("injected trace write failure"); },
		};
		session.prefixPendingSequence = 7;
		expect(() => manager.finalizePromptPrefixAttribution(session.id, [{ content: "dynamic" }])).not.toThrow();
		expect(session.prefixPendingSequence).toBeUndefined();
		expect(session.prefixAttributionRecorder).toBeUndefined();
	});
});

gatewayTest.describe("provider hook attribution failure isolation", () => {
	let sessionId = "";

	gatewayTest.afterEach(async () => {
		if (sessionId) await deleteSession(sessionId);
		sessionId = "";
	});

	gatewayTest("returns budgeted dynamic blocks when attribution finalization throws", async ({ gateway }) => {
		sessionId = await createSession();
		const manager: any = gateway.sessionManager;
		const originalFinalize = manager.finalizePromptPrefixAttribution;
		const originalHub = manager.lifecycleHub;
		manager.finalizePromptPrefixAttribution = () => { throw new Error("injected finalization failure"); };
		manager.lifecycleHub = {
			dispatch: async () => ({ blocks: [{ id: "dynamic", providerId: "test", title: "Dynamic", content: "safe", tokenEstimate: 1 }] }),
		};
		try {
			const response = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
				method: "POST",
				body: JSON.stringify({ prompt: "delivery must survive diagnostics" }),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ content: expect.stringContaining("safe"), blocks: [{ id: "dynamic" }] });
		} finally {
			manager.finalizePromptPrefixAttribution = originalFinalize;
			manager.lifecycleHub = originalHub;
		}
	});
});
