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
	agentEndPredicate,
	type WsMsg,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.describe("archived session footer model", () => {
	test("initial connect to archived session pushes persisted model in state frame", async () => {
		// 1. Create a fresh session
		const sessionId = await createSession();

		// 2. Connect, set a non-default model, send a prompt to trigger persistence
		const ws1 = await connectWs(sessionId);
		ws1.send({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-20250514" });
		ws1.send({ type: "prompt", text: "hello" });
		await ws1.waitFor(agentEndPredicate(), 10_000);

		// Wait for model + persistence
		await pollUntil(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (!resp.ok) return false;
			const data = await resp.json();
			return data.modelProvider === "anthropic" && data.modelId === "claude-sonnet-4-20250514";
		}, { timeoutMs: 5_000, intervalMs: 50, label: "model persisted" });

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
				return model?.provider === "anthropic" && model?.id === "claude-sonnet-4-20250514";
			},
			5_000,
		).catch(() => {});

		const stateMessages = ws2.messages.filter((m: WsMsg) => m.type === "state");
		const archivedStates = stateMessages.filter((m: WsMsg) => (m.data as any)?.archived === true);

		// 7. There MUST be at least one state frame, and it MUST carry the model
		const hasArchivedModelFrame = archivedStates.some((m: WsMsg) => {
			const model = (m.data as any)?.model;
			return model?.provider === "anthropic" && model?.id === "claude-sonnet-4-20250514";
		});

		expect(hasArchivedModelFrame,
			`Expected an archived state frame with model anthropic/claude-sonnet-4-20250514 ` +
			`on initial connect (no get_state sent). ` +
			`Got ${stateMessages.length} state frames, ${archivedStates.length} archived. ` +
			`State data: ${JSON.stringify(stateMessages.map(m => m.data))}`
		).toBe(true);

		ws2.close();
	});
});
