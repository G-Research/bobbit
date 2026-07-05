/**
 * Regression coverage for the live per-session model-state frame emitted after
 * selecting Claude Fable 5.
 *
 * Upstream pi-ai ships correct metadata for `claude-fable-5`
 * (contextWindow 1_000_000, maxTokens 128_000, reasoning true,
 * thinkingLevelMap {off:null, xhigh:"xhigh"}). Bobbit's bug was that live
 * `state.model` frames were derived from `inferMeta` alone — the `/claude/`
 * catch-all — which clobbered those values (200k / reasoning:false) and never
 * carried `thinkingLevelMap`, so the client hid the thinking selector and
 * showed a 200k context window.
 *
 * After the fix, `resolveModelStateMeta` (registry cache → pi-ai catalog →
 * inferMeta) backs every broadcast site, so both the on-selection frame and
 * the reconnect-rehydration frame carry Fable's authoritative metadata.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	connectWs,
	type WsConnection,
	type WsMsg,
} from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

const FABLE_MAP = { off: null, xhigh: "xhigh" } as const;

/**
 * A state frame is the correct Fable frame once it reports the 1M context
 * window — this discriminates it from any earlier placeholder/default frame.
 */
function fableModel(message: WsMsg): any | undefined {
	if (message.type !== "state") return undefined;
	const model = (message.data as any)?.model;
	if (model && model.id === "claude-fable-5" && model.contextWindow === 1_000_000) return model;
	return undefined;
}

function assertFableModel(model: any, context: string) {
	expect(model, `${context}: expected a Fable model frame`).toBeTruthy();
	expect(model.contextWindow, `${context}: contextWindow`).toBe(1_000_000);
	expect(model.reasoning, `${context}: reasoning`).toBe(true);
	expect(model.thinkingLevelMap, `${context}: thinkingLevelMap`).toEqual(FABLE_MAP);
}

async function closeWs(ws: WsConnection) {
	const closed = new Promise<void>(r => ws.ws.once("close", () => r()));
	ws.close();
	await closed;
}

test.describe("Fable model-state frame", () => {
	test("selection emits correct metadata and it survives reconnect", async () => {
		const sessionId = await createSession();

		const ws1 = await connectWs(sessionId);
		const cursor = ws1.messageCount();
		ws1.send({ type: "set_model", provider: "anthropic", modelId: "claude-fable-5" });

		// Live on-selection frame must carry Fable's authoritative metadata.
		await ws1.waitForFrom(cursor, (m: WsMsg) => !!fableModel(m), 10_000);
		const liveModel = ws1.messages.slice(cursor).map(fableModel).find(Boolean);
		assertFableModel(liveModel, "on selection");

		// Wait for persistence so the reconnect exercises rehydration.
		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === "anthropic" && data.modelId === "claude-fable-5";
		}, { timeoutMs: 5_000, intervalMs: 50, label: "Fable model persisted" });

		await closeWs(ws1);

		// Reconnect → the rehydrated frame must carry the same correct values.
		const ws2 = await connectWs(sessionId);
		ws2.send({ type: "get_state" });
		await ws2.waitFor((m: WsMsg) => !!fableModel(m), 10_000);
		const rehydratedModel = ws2.messages.map(fableModel).find(Boolean);
		assertFableModel(rehydratedModel, "after reconnect");

		ws2.close();
	});
});
