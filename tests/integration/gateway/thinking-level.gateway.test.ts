/**
 * E2E tests for thinking level support.
 *
 * Covers:
 * - set_thinking_level WS command is handled without error
 * - Persisted Opus 5/xhigh is authoritative in fallback state frames
 */
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import {
	createSession,
	connectWs,
	type WsConnection,
	type WsMsg,
} from "./_helpers/e2e/e2e-setup.js";
import { pollUntil } from "../../e2e/_helpers/test-utils/cleanup.js";

const OPUS_5 = { provider: "anthropic", id: "claude-opus-5", thinkingLevel: "xhigh" } as const;

function isOpus5State(message: WsMsg): boolean {
	if (message.type !== "state") return false;
	const state = message.data as any;
	return state?.model?.provider === OPUS_5.provider && state?.model?.id === OPUS_5.id;
}

async function closeWs(conn: WsConnection): Promise<void> {
	const closed = new Promise<void>((resolve) => conn.ws.once("close", () => resolve()));
	conn.close();
	await closed;
}

test.describe("Thinking Level", () => {

	test("set_thinking_level is handled by the server", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			// Wait for initial state
			await conn.waitFor((m) => m.type === "queue_update");

			// Clear messages for clean assertions
			conn.messages.length = 0;

			// Send set_thinking_level
			conn.send({ type: "set_thinking_level", level: "high" });

			// The server should NOT respond with an error.
			// On the broken codebase, it responds with:
			//   { type: "error", message: "Unknown message type", code: "UNKNOWN_TYPE" }
			// negative-window assertion (intentional sleep): we want to verify no
			// error frame arrives within a bounded window.
			await new Promise((r) => setTimeout(r, 500));

			const errors = conn.messages.filter(
				(m) => m.type === "error" && m.code === "UNKNOWN_TYPE",
			);
			expect(
				errors.length,
				"set_thinking_level not recognized by server",
			).toBe(0);
		} finally {
			conn.close();
		}
	});

	test("fallback model state restores the durable Opus 5/xhigh tuple", async ({ gateway }) => {
		const sessionId = await createSession();
		let selectedConn: WsConnection | undefined = await connectWs(sessionId);
		let fallbackConn: WsConnection | undefined;
		let originalStatus: string | undefined;

		try {
			const selectionCursor = selectedConn.messageCount();
			selectedConn.send({
				type: "set_model",
				provider: OPUS_5.provider,
				modelId: OPUS_5.id,
				thinkingLevel: OPUS_5.thinkingLevel,
			});
			await selectedConn.waitForFrom(
				selectionCursor,
				(message) => isOpus5State(message) && (message.data as any)?.thinkingLevel === OPUS_5.thinkingLevel,
				10_000,
			);
			await pollUntil(async () => {
				const persisted = gateway.sessionManager.getPersistedSession(sessionId);
				return persisted?.modelProvider === OPUS_5.provider
					&& persisted.modelId === OPUS_5.id
					&& persisted.effectiveThinkingLevel === OPUS_5.thinkingLevel;
			}, { timeoutMs: 5_000, intervalMs: 50, label: "Opus 5/xhigh tuple persisted before fallback" });

			await closeWs(selectedConn);
			selectedConn = undefined;

			// A preparing reconnect cannot query the live bridge, so handler.ts must
			// hydrate the complete authoritative tuple from durable session state.
			const session = gateway.sessionManager.getSession(sessionId);
			if (!session) throw new Error(`missing live session ${sessionId}`);
			originalStatus = session.status;
			session.status = "preparing";

			fallbackConn = await connectWs(sessionId);
			const fallback = await fallbackConn.waitFor(isOpus5State, 5_000);
			expect(fallback.data).toMatchObject({
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

			const opusFrames = fallbackConn.messages.filter(isOpus5State);
			expect(opusFrames.map((message) => (message.data as any)?.thinkingLevel)).toEqual([OPUS_5.thinkingLevel]);
			expect(opusFrames.some((message) => (message.data as any)?.thinkingLevel === "medium")).toBe(false);
		} finally {
			const session = gateway.sessionManager.getSession(sessionId);
			if (session && originalStatus) session.status = originalStatus as typeof session.status;
			selectedConn?.close();
			fallbackConn?.close();
		}
	});
});
