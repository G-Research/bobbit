import { test, expect } from "./gateway-harness.js";
import {
	readE2EToken,
	apiFetch,
	connectWs,
	deleteSession,
	nonGitCwd,
	agentEndPredicate,
} from "./e2e-setup.js";

/**
 * Test for wizard greeting flow.
 *
 * Validates that when a prompt is sent to a goal assistant session via
 * WebSocket, the agent processes it and responds. The mock agent replies
 * with "OK" — what matters is that the prompt reaches the server and
 * triggers an assistant response (proving the WS plumbing works).
 */

test.describe("Wizard greeting regression", () => {
	test.setTimeout(120_000);

	let token: string;
	const cleanupSessionIds: string[] = [];

	test.beforeAll(() => {
		token = readE2EToken();
	});

	test.afterAll(async () => {
		for (const id of cleanupSessionIds) {
			await deleteSession(id);
		}
	});

	test("goal assistant session auto-prompts and agent responds with greeting", async () => {
		// 1. Create a goal assistant session via REST
		const res = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				assistantType: "goal",
			}),
		});
		expect(res.status).toBe(201);
		const { id: sessionId } = await res.json();
		cleanupSessionIds.push(sessionId);

		// 2. Connect via WebSocket
		const ws = await connectWs(sessionId);

		// 3. Send the auto-prompt (same text the client sends)
		ws.send({ type: "prompt", text: "Start the goal creation session." });

		// 4. Wait for the agent turn to complete
		await ws.waitFor(agentEndPredicate(), 60_000);

		// 5. Find the assistant message_end event
		const assistantMsgEnd = ws.messages.find(
			(m) => m.type === "event"
				&& m.data?.type === "message_end"
				&& m.data?.message?.role === "assistant",
		);
		expect(
			assistantMsgEnd,
			"Expected an assistant message_end event after sending the auto-prompt",
		).toBeTruthy();

		// 6. Verify the assistant produced some content
		const content = assistantMsgEnd!.data.message.content;
		const text = Array.isArray(content)
			? content.map((b: any) => b.text || "").join("")
			: typeof content === "string" ? content : "";
		expect(text.length).toBeGreaterThan(0);

		ws.close();
	});
});
