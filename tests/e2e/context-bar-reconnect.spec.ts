/**
 * Regression coverage for model state hydration after WebSocket reconnect.
 *
 * A persisted model must be pushed back to the client immediately on reconnect
 * so the footer/context bar never renders the hardcoded remote-agent placeholder
 * (or an older Claude Opus default) as authoritative state.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	connectWs,
	agentEndPredicate,
	type WsConnection,
	type WsMsg,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const OPUS_48 = "claude-opus-4-8";
const FALLBACK_MODEL_IDS = new Set(["claude-opus-4-7", "claude-opus-4-6", "claude-opus-4"]);

function stateModelId(message: WsMsg): string | undefined {
	return message.type === "state" ? (message.data as any)?.model?.id : undefined;
}

function expectNoFallbackBeforeOpus48(messages: WsMsg[], context: string) {
	const badBeforeTarget: string[] = [];
	let sawTarget = false;
	for (const message of messages) {
		const id = stateModelId(message);
		if (!id) continue;
		if (id === OPUS_48) {
			sawTarget = true;
			break;
		}
		if (FALLBACK_MODEL_IDS.has(id)) badBeforeTarget.push(id);
	}
	expect(sawTarget, `${context}: expected Opus 4.8 state; got ${JSON.stringify(messages.filter(m => m.type === "state").map(m => m.data))}`).toBe(true);
	expect(badBeforeTarget, `${context}: older Opus fallback state must not appear before ${OPUS_48}`).toEqual([]);
}

async function waitForPersistedOpus48(sessionId: string) {
	await pollUntil(async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		if (!resp.ok) return false;
		const data = await resp.json();
		return data.modelProvider === "anthropic" && data.modelId === OPUS_48;
	}, { timeoutMs: 5_000, intervalMs: 50, label: "Opus 4.8 model persisted" });
}

async function closeWs(ws: WsConnection) {
	const closed = new Promise<void>(r => ws.ws.once("close", () => r()));
	ws.close();
	await closed;
}

test.describe("model state after reconnect", () => {
	let sessionId: string;

	test.beforeEach(async () => {
		sessionId = await createSession();
	});

	test("reconnect sends state with correct contextWindow for persisted model", async () => {
		const ws1 = await connectWs(sessionId);
		ws1.send({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-20250514" });

		// Send a prompt so eventBuffer has content and reconnect exercises the
		// proactive getState path, not only the persisted fallback path.
		ws1.send({ type: "prompt", text: "hello" });
		await ws1.waitFor(agentEndPredicate(), 10_000);

		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === "anthropic" && data.modelId === "claude-sonnet-4-20250514";
		}, { timeoutMs: 5_000, intervalMs: 50, label: "model persisted" });

		await closeWs(ws1);

		const ws2 = await connectWs(sessionId);
		ws2.send({ type: "get_state" });
		await ws2.waitFor(
			(m: WsMsg) =>
				m.type === "state" &&
				(m.data as any)?.model?.contextWindow === 1_000_000,
			5_000,
		).catch(() => {});

		const stateMessages = ws2.messages.filter((m: WsMsg) => m.type === "state");
		const hasCorrectContextWindow = stateMessages.some((m: WsMsg) => {
			const model = (m.data as any)?.model;
			return model && model.contextWindow === 1_000_000;
		});
		const contextWindows = stateMessages
			.map((m: WsMsg) => (m.data as any)?.model?.contextWindow)
			.filter((v: unknown) => v !== undefined);

		expect(hasCorrectContextWindow,
			`Expected at least one state message with contextWindow === 1000000 after reconnect, ` +
			`but got contextWindow values: [${contextWindows.join(", ")}] ` +
			`from ${stateMessages.length} state message(s). ` +
			`State data: ${JSON.stringify(stateMessages.map(m => m.data))}`
		).toBe(true);

		ws2.close();
	});

	test("Opus 4.8 displays after selection and survives reconnect without older Opus flash", async () => {
		const ws1 = await connectWs(sessionId);

		// Selection path: the client sends set_model, then displays the selected
		// model from the next state hydration without substituting an older Opus.
		const selectionCursor = ws1.messageCount();
		ws1.send({ type: "set_model", provider: "anthropic", modelId: OPUS_48 });
		ws1.send({ type: "get_state" });
		await ws1.waitForFrom(
			selectionCursor,
			(m: WsMsg) => stateModelId(m) === OPUS_48,
			5_000,
		).catch(() => {});
		expectNoFallbackBeforeOpus48(ws1.messages.slice(selectionCursor), "after selection");
		await waitForPersistedOpus48(sessionId);

		await closeWs(ws1);

		// Reconnect/reload path: a fresh socket must receive the persisted Opus 4.8
		// state immediately, before any placeholder/older Opus state can be shown.
		const ws2 = await connectWs(sessionId);
		await ws2.waitFor((m: WsMsg) => stateModelId(m) === OPUS_48, 5_000).catch(() => {});
		expectNoFallbackBeforeOpus48(ws2.messages, "reconnect initial state");
		ws2.close();
	});
});
