/**
 * Regression test: archived sessions must include the persisted model in the
 * `state` frame on initial WebSocket connect, not just on `get_state`.
 *
 * Before the fix, the archived auth_ok branch in handler.ts sent only
 * `auth_ok` / `session_status` / `session_title` and NO state frame. The
 * client's hardcoded default in remote-agent.ts (claude-opus-4-6) leaked
 * into the footer model picker, until the user reconnected (which fires
 * `get_state`).
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	connectWs,
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
	expect(sawTarget, `${context}: expected first authoritative Opus 4.8 state; got states ${JSON.stringify(messages.filter(m => m.type === "state").map(m => m.data))}`).toBe(true);
	expect(badBeforeTarget, `${context}: older Opus fallback state must not appear before ${OPUS_48}`).toEqual([]);
}

test.describe("archived session footer model", () => {
	test("initial connect to archived Opus 4.8 session pushes persisted model without fallback flash", async () => {
		// 1. Create a fresh session
		const sessionId = await createSession();

		// 2. Connect, select Opus 4.8, and wait for persistence.
		const ws1 = await connectWs(sessionId);
		ws1.send({ type: "set_model", provider: "anthropic", modelId: OPUS_48 });

		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === "anthropic" && data.modelId === OPUS_48;
		}, { timeoutMs: 5_000, intervalMs: 50, label: "Opus 4.8 model persisted" });

		const closed1 = new Promise<void>(r => ws1.ws.once("close", () => r()));
		ws1.close();
		await closed1;

		// 3. Archive the session
		const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(delResp.ok).toBe(true);

		// 4. Wait for archival to settle so reconnect routes through the archived branch
		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions?include=archived`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return Array.isArray(data.sessions) &&
				data.sessions.some((s: any) => s.id === sessionId && s.archived);
		}, { timeoutMs: 5_000, intervalMs: 50, label: "session archived" });

		// 5. Fresh connect — DO NOT send get_state. The fix requires the server
		// to push the model state proactively on auth_ok.
		const ws2 = await connectWs(sessionId);

		// 6. Wait for a state frame carrying the persisted model
		await ws2.waitFor(
			(m: WsMsg) => {
				if (m.type !== "state") return false;
				const model = (m.data as any)?.model;
				return model?.provider === "anthropic" && model?.id === OPUS_48;
			},
			5_000,
		).catch(() => {});

		const stateMessages = ws2.messages.filter((m: WsMsg) => m.type === "state");
		const archivedStates = stateMessages.filter((m: WsMsg) => (m.data as any)?.archived === true);
		expectNoFallbackBeforeOpus48(stateMessages, "archived initial connect");

		// 7. There MUST be at least one archived state frame, and it MUST carry the model.
		const hasArchivedModelFrame = archivedStates.some((m: WsMsg) => {
			const model = (m.data as any)?.model;
			return model?.provider === "anthropic" && model?.id === OPUS_48;
		});

		expect(hasArchivedModelFrame,
			`Expected an archived state frame with model anthropic/${OPUS_48} ` +
			`on initial connect (no get_state sent). ` +
			`Got ${stateMessages.length} state frames, ${archivedStates.length} archived. ` +
			`State data: ${JSON.stringify(stateMessages.map(m => m.data))}`
		).toBe(true);

		ws2.close();
	});
});
