import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/remote-agent-outbox.spec.ts (v2-dom tier).
// Drives the REAL RemoteAgent.send()/getQueue()/_flushOutbox() (was an esbuild
// file:// bundle) with a fake WebSocket whose readyState the test controls.
// session-manager is imported FIRST so it owns the session-manager⇄pack-panels
// import cycle before remote-agent pulls it in (TDZ guard); safe-markdown-block
// is pre-imported so any fire-and-forget lazy define resolves during the test
// rather than racing env teardown.
import { afterEach, describe, expect, it } from "vitest";
import { installConfirmedSessionModelPersistence } from "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import "../../src/ui/lazy/safe-markdown-block.js";
import { setRenderApp, state } from "../../src/app/state.js";

const OPEN = 1;
const CLOSED = 3;

let renderCount = 0;
setRenderApp(() => { renderCount++; });

function makeAgent(readyState: number) {
	const ra: any = new RemoteAgent();
	const sentFrames: string[] = [];
	ra.ws = { readyState, send: (s: string) => sentFrames.push(s) };
	ra.__sentFrames = sentFrames;
	ra.__queueUpdates = [];
	ra.onQueueUpdate = (q: any) => ra.__queueUpdates.push(q);
	return ra;
}

const snapshot = (ra: any) => ({
	outboxLen: ra._pendingOutbox.length,
	sent: ra.__sentFrames.map((s: string) => JSON.parse(s)),
	queue: ra.getQueue(),
	messages: ra._state.messages.length,
	providerAuthRequired: ra._state.providerAuthRequired,
	autoRetryPending: ra._state.autoRetryPending,
	queueUpdateCount: ra.__queueUpdates.length,
});

const nextRenderFrame = () => new Promise<void>((resolve) => {
	requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

afterEach(() => {
	state.showHeadquartersInProjectLists = false;
	localStorage.clear();
});

describe("RemoteAgent live preference sync", () => {
	it("preferences_changed keeps Headquarters visibility state in sync", async () => {
		const ra = makeAgent(OPEN);

		state.showHeadquartersInProjectLists = true;
		renderCount = 0;
		await ra.handleServerMessage({
			type: "preferences_changed",
			preferences: { showHeadquartersInProjectLists: false },
		});
		await nextRenderFrame();
		const hidden = {
			visible: state.showHeadquartersInProjectLists,
			renders: renderCount,
		};

		renderCount = 0;
		await ra.handleServerMessage({
			type: "preferences_changed",
			preferences: {},
		});
		await nextRenderFrame();
		const defaultVisible = {
			visible: state.showHeadquartersInProjectLists,
			renders: renderCount,
		};

		expect(hidden.visible).toBe(false);
		expect(hidden.renders).toBeGreaterThan(0);
		expect(defaultVisible.visible).toBe(true);
		expect(defaultVisible.renders).toBeGreaterThan(0);
	});
});

describe("RemoteAgent model switch reconciliation", () => {
	const modelA = { provider: "openai-codex", id: "gpt-5.5", contextWindow: 128000 };
	const modelB = { provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200000 };

	it("reconciles optimistic display from authoritative state and refreshes after SET_MODEL_FAILED", async () => {
		const ra = makeAgent(OPEN);
		const events: any[] = [];
		ra.subscribe((event: any) => events.push(event));

		await ra.handleServerMessage({ type: "state", data: { model: modelA } });
		ra.setModel(modelB);
		expect(ra.state.model).toMatchObject(modelB);

		await ra.handleServerMessage({ type: "state", data: { model: modelA } });
		await ra.handleServerMessage({ type: "error", code: "SET_MODEL_FAILED", message: "read-back mismatch" });

		expect(ra.state.model).toMatchObject(modelA);
		expect(snapshot(ra).sent).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "set_model", provider: modelB.provider, modelId: modelB.id }),
			expect.objectContaining({ type: "get_state" }),
		]));
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "state_update", data: expect.objectContaining({ model: modelA }) }),
		]));
	});

	it("persists only server-confirmed model states, not optimistic selections", async () => {
		const ra = makeAgent(OPEN);
		installConfirmedSessionModelPersistence(ra, "session-model-test");
		const saved = () => JSON.parse(localStorage.getItem("session.session-model-test.model") || "null");

		await ra.handleServerMessage({ type: "state", data: { model: modelA } });
		expect(saved()).toMatchObject({ provider: modelA.provider, modelId: modelA.id });

		ra.setModel(modelB);
		expect(saved()).toMatchObject({ provider: modelA.provider, modelId: modelA.id });

		await ra.handleServerMessage({ type: "error", code: "SET_MODEL_FAILED", message: "rejected" });
		expect(saved()).toMatchObject({ provider: modelA.provider, modelId: modelA.id });

		await ra.handleServerMessage({ type: "state", data: { model: modelB } });
		expect(saved()).toMatchObject({ provider: modelB.provider, modelId: modelB.id });
	});
});

describe("RemoteAgent provider auth recovery", () => {
	it("stores a redacted provider_auth_required event and clears it on retry, new prompt, model switch, and agent_start", async () => {
		const makeEvent = () => ({
			type: "provider_auth_required",
			provider: "openrouter",
			source: "direct prompt",
			reason: "missing-api-key",
			message: "OpenRouter API key is missing. Add or fix the API key in Settings, switch provider, then retry.",
			error: "No API key found for openrouter: sk-or-secret-never-render",
			actions: [
				{ type: "open_settings", label: "Fix API key in Settings" },
				{ type: "retry", label: "Retry after fixing credentials" },
				{ type: "switch_provider", label: "Switch provider" },
				{ type: "abort_respawn", label: "Abort/respawn agent" },
			],
		});

		const retryAgent = makeAgent(OPEN);
		retryAgent.handleAgentEvent(makeEvent());
		const stored = snapshot(retryAgent).providerAuthRequired;
		retryAgent.retry();
		const afterRetry = snapshot(retryAgent);

		const promptAgent = makeAgent(OPEN);
		promptAgent.handleAgentEvent(makeEvent());
		await promptAgent.prompt("after key fix");
		const afterPrompt = snapshot(promptAgent);

		const modelAgent = makeAgent(OPEN);
		modelAgent.handleAgentEvent(makeEvent());
		modelAgent.setModel({ provider: "anthropic", id: "claude-test", contextWindow: 1 });
		const afterModel = snapshot(modelAgent);

		const startAgent = makeAgent(OPEN);
		startAgent.handleAgentEvent(makeEvent());
		startAgent.handleAgentEvent({ type: "agent_start" });
		const afterStart = snapshot(startAgent);

		expect(stored).toMatchObject({
			provider: "openrouter",
			source: "direct prompt",
			reason: "missing-api-key",
		});
		expect(JSON.stringify(stored)).not.toContain("sk-or-secret-never-render");
		expect(afterRetry.providerAuthRequired).toBeNull();
		expect(afterRetry.sent.at(-1)).toMatchObject({ type: "retry" });
		expect(afterPrompt.providerAuthRequired).toBeNull();
		expect(afterPrompt.sent.at(-1)).toMatchObject({ type: "prompt", text: "after key fix" });
		expect(afterModel.providerAuthRequired).toBeNull();
		expect(afterModel.sent.at(-1)).toMatchObject({ type: "set_model", provider: "anthropic", modelId: "claude-test" });
		expect(afterStart.providerAuthRequired).toBeNull();
	});
});

describe("RemoteAgent send outbox (S2)", () => {
	it("offline prompt is queued as a pending pill (no drop, no false 'sent' bubble) and flushes on reconnect", async () => {
		const ra = makeAgent(CLOSED);
		await ra.prompt("lost-xyz");
		const offline = snapshot(ra);
		// Reconnect: socket opens, auth_ok would call _flushOutbox.
		ra.ws.readyState = OPEN;
		ra._flushOutbox();
		const afterFlush = snapshot(ra);

		// While offline: queued, not sent; surfaced as an unsent pill; no transcript bubble.
		expect(offline.sent).toHaveLength(0);
		expect(offline.outboxLen).toBe(1);
		expect(offline.messages).toBe(0);
		expect(offline.queue).toHaveLength(1);
		expect(offline.queue[0].text).toBe("lost-xyz");
		expect(offline.queue[0].unsent).toBe(true);
		expect(offline.queueUpdateCount).toBeGreaterThan(0);
		// After reconnect flush: delivered exactly once, outbox cleared.
		expect(afterFlush.outboxLen).toBe(0);
		expect(afterFlush.sent).toHaveLength(1);
		expect(afterFlush.sent[0]).toMatchObject({ type: "prompt", text: "lost-xyz" });
	});

	it("only prompt/steer/retry are buffered; control frames are dropped", async () => {
		const ra = makeAgent(CLOSED);
		await ra.prompt("p1");
		ra.steer("s1");
		ra.retry();
		(ra as any).send({ type: "get_state" }); // control frame — must NOT queue
		(ra as any).send({ type: "ping" });
		const r = snapshot(ra);

		// prompt + steer + retry queued (3); get_state/ping dropped.
		expect(r.outboxLen).toBe(3);
		// Only prompt + steer have pill rows (retry has no text).
		expect(r.queue).toHaveLength(2);
		expect(r.queue.map((q: any) => q.text).sort()).toEqual(["p1", "s1"]);
		expect(r.queue.find((q: any) => q.text === "s1").isSteered).toBe(true);
	});

	it("outbox is bounded at OUTBOX_MAX (oldest dropped)", async () => {
		const ra = makeAgent(CLOSED);
		for (let i = 0; i < 60; i++) (ra as any).send({ type: "prompt", text: `m${i}` });
		const snap = snapshot(ra);
		expect(snap.outboxLen).toBe(50); // OUTBOX_MAX
		expect(snap.queue[0]?.text).toBe("m10"); // m0..m9 evicted
		expect(snap.queue[snap.queue.length - 1]?.text).toBe("m59");
	});

	it("removeQueued drops a pending-unsent row locally", async () => {
		const ra = makeAgent(CLOSED);
		await ra.prompt("droppable");
		const id = snapshot(ra).queue[0].id;
		ra.removeQueued(id);
		const r = snapshot(ra);
		expect(r.outboxLen).toBe(0);
		expect(r.queue).toHaveLength(0);
		expect(r.sent).toHaveLength(0); // no remove_queued sent to server for a never-sent row
	});
});
