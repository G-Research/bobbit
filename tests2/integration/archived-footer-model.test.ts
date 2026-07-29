/**
 * Regression test: archived sessions must include the persisted model/thinking
 * tuple in the `state` frame on initial WebSocket connect and `get_state`.
 *
 * Archived sessions never have a live bridge to correct a placeholder. Their
 * durable provider/model/effective-thinking tuple is therefore authoritative.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	connectWs,
	type WsMsg,
} from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

const OPUS_5 = { provider: "anthropic", id: "claude-opus-5", thinkingLevel: "xhigh" } as const;
const FALLBACK_MODEL_IDS = new Set(["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4"]);

function stateModelId(message: WsMsg): string | undefined {
	return message.type === "state" ? (message.data as any)?.model?.id : undefined;
}

function isArchivedOpus5State(message: WsMsg): boolean {
	if (message.type !== "state") return false;
	const state = message.data as any;
	return state?.archived === true
		&& state?.model?.provider === OPUS_5.provider
		&& state?.model?.id === OPUS_5.id;
}

function expectNoPlaceholderBeforeOpus5Xhigh(messages: WsMsg[], context: string): void {
	const badBeforeTarget: string[] = [];
	let sawTarget = false;
	for (const message of messages) {
		const id = stateModelId(message);
		if (!id) continue;
		const thinkingLevel = (message.data as any)?.thinkingLevel;
		if (id === OPUS_5.id && thinkingLevel === OPUS_5.thinkingLevel) {
			sawTarget = true;
			break;
		}
		if (id === OPUS_5.id || FALLBACK_MODEL_IDS.has(id)) {
			badBeforeTarget.push(`${id}/${thinkingLevel ?? "missing"}`);
		}
	}
	expect(sawTarget, `${context}: expected first authoritative Opus 5/xhigh state; got states ${JSON.stringify(messages.filter(m => m.type === "state").map(m => m.data))}`).toBe(true);
	expect(badBeforeTarget, `${context}: placeholder model/thinking state must not appear before ${OPUS_5.id}/${OPUS_5.thinkingLevel}`).toEqual([]);
}

test.describe("archived session footer model", () => {
	test("archived Opus 5 session restores xhigh on connect and get_state without a placeholder flash", async ({ gateway }) => {
		// 1. Create a fresh session, select Opus 5/xhigh, and wait for the exact
		// verified tuple to become durable before archival.
		const sessionId = await createSession();
		const ws1 = await connectWs(sessionId);
		const selectionCursor = ws1.messageCount();
		ws1.send({
			type: "set_model",
			provider: OPUS_5.provider,
			modelId: OPUS_5.id,
			thinkingLevel: OPUS_5.thinkingLevel,
		});
		await ws1.waitForFrom(
			selectionCursor,
			(message) => message.type === "state"
				&& (message.data as any)?.model?.provider === OPUS_5.provider
				&& (message.data as any)?.model?.id === OPUS_5.id
				&& (message.data as any)?.thinkingLevel === OPUS_5.thinkingLevel,
			10_000,
		);
		await pollUntil(async () => {
			const persisted = gateway.sessionManager.getPersistedSession(sessionId);
			return persisted?.modelProvider === OPUS_5.provider
				&& persisted.modelId === OPUS_5.id
				&& persisted.effectiveThinkingLevel === OPUS_5.thinkingLevel;
		}, { timeoutMs: 5_000, intervalMs: 50, label: "Opus 5/xhigh tuple persisted" });

		const closed1 = new Promise<void>(resolve => ws1.ws.once("close", () => resolve()));
		ws1.close();
		await closed1;

		// 2. Archive the session and wait until reconnect routes through the
		// archived, read-only WebSocket branch.
		const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(delResp.ok).toBe(true);
		await pollUntil(async () => {
			const archived = gateway.sessionManager.getArchivedSession(sessionId);
			return archived?.modelProvider === OPUS_5.provider
				&& archived.modelId === OPUS_5.id
				&& archived.effectiveThinkingLevel === OPUS_5.thinkingLevel;
		}, { timeoutMs: 5_000, intervalMs: 50, label: "Opus 5/xhigh session archived" });

		// 3. Fresh connect — do not send get_state until the proactive archived
		// frame has proven the complete durable tuple.
		const ws2 = await connectWs(sessionId);
		const initial = await ws2.waitFor(isArchivedOpus5State, 5_000);
		expect(initial.data).toMatchObject({
			archived: true,
			thinkingLevel: OPUS_5.thinkingLevel,
			model: {
				provider: OPUS_5.provider,
				id: OPUS_5.id,
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			},
		});
		expectNoPlaceholderBeforeOpus5Xhigh(ws2.messages, "archived initial connect");

		// The read-only get_state response uses the same authoritative builder.
		const getStateCursor = ws2.messageCount();
		ws2.send({ type: "get_state" });
		const refreshed = await ws2.waitForFrom(getStateCursor, isArchivedOpus5State, 5_000);
		expect((refreshed.data as any)?.thinkingLevel).toBe(OPUS_5.thinkingLevel);
		expect((refreshed.data as any)?.thinkingLevel).not.toBe("medium");

		ws2.close();
	});
});
