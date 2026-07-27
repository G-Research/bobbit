/**
 * Regression coverage for model state hydration after WebSocket reconnect.
 *
 * A persisted model must be pushed back to the client immediately on reconnect
 * so the footer/context bar never renders the hardcoded remote-agent placeholder
 * (or an older Claude Opus default) as authoritative state.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	connectWs,
	agentEndPredicate,
	type WsConnection,
	type WsMsg,
} from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

const OPUS_5 = { provider: "anthropic", id: "claude-opus-5", thinkingLevel: "xhigh" } as const;
const STALE_MODEL_IDS = new Set(["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4"]);

function stateModelId(message: WsMsg): string | undefined {
	return message.type === "state" ? (message.data as any)?.model?.id : undefined;
}

function isOpus5XhighState(message: WsMsg): boolean {
	if (message.type !== "state") return false;
	const state = message.data as any;
	return state?.model?.provider === OPUS_5.provider
		&& state?.model?.id === OPUS_5.id
		&& state?.thinkingLevel === OPUS_5.thinkingLevel;
}

function expectNoStaleModelBeforeOpus5(messages: WsMsg[], context: string) {
	const staleBeforeTarget: string[] = [];
	let sawTarget = false;
	for (const message of messages) {
		const id = stateModelId(message);
		if (!id) continue;
		if (isOpus5XhighState(message)) {
			sawTarget = true;
			break;
		}
		if (STALE_MODEL_IDS.has(id)) staleBeforeTarget.push(id);
	}
	expect(sawTarget, `${context}: expected Opus 5/xhigh state; got ${JSON.stringify(messages.filter(m => m.type === "state").map(m => m.data))}`).toBe(true);
	expect(staleBeforeTarget, `${context}: stale/placeholder Opus state must not appear before ${OPUS_5.id}`).toEqual([]);
}

async function waitForPersistedOpus5Xhigh(gateway: any, sessionId: string) {
	await pollUntil(async () => {
		const persisted = gateway.sessionManager.getPersistedSession(sessionId);
		return persisted?.modelProvider === OPUS_5.provider
			&& persisted.modelId === OPUS_5.id
			&& persisted.effectiveThinkingLevel === OPUS_5.thinkingLevel;
	}, { timeoutMs: 5_000, intervalMs: 50, label: "Opus 5/xhigh tuple persisted" });
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
		ws1.send({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" });

		// Send a prompt so eventBuffer has content and reconnect exercises the
		// proactive getState path, not only the persisted fallback path.
		ws1.send({ type: "prompt", text: "hello" });
		await ws1.waitFor(agentEndPredicate(), 10_000);

		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === "anthropic" && data.modelId === "claude-sonnet-5";
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

	test("combined Opus 5/xhigh selection persists and reconnects without a stale model flash", async ({ gateway }) => {
		const ws1 = await connectWs(sessionId);

		// One combined request crosses the real gateway/mock-agent path. The exact
		// verified tuple must be returned and durably committed together.
		const selectionCursor = ws1.messageCount();
		ws1.send({
			type: "set_model",
			provider: OPUS_5.provider,
			modelId: OPUS_5.id,
			thinkingLevel: OPUS_5.thinkingLevel,
		});
		const selected = await ws1.waitForFrom(selectionCursor, isOpus5XhighState, 10_000);
		expect((selected.data as any).model).toMatchObject({
			provider: OPUS_5.provider,
			id: OPUS_5.id,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		expectNoStaleModelBeforeOpus5(ws1.messages.slice(selectionCursor), "after combined selection");
		await waitForPersistedOpus5Xhigh(gateway, sessionId);

		// Populate the event buffer so reconnect exercises authoritative live-state
		// hydration rather than only the persisted fallback response.
		ws1.send({ type: "prompt", text: "Opus 5 reconnect tuple" });
		await ws1.waitFor(agentEndPredicate(), 10_000);
		await closeWs(ws1);

		const ws2 = await connectWs(sessionId);
		await ws2.waitFor(isOpus5XhighState, 10_000);
		expectNoStaleModelBeforeOpus5(ws2.messages, "reconnect initial state");
		await waitForPersistedOpus5Xhigh(gateway, sessionId);
		ws2.close();
	});
});
