import { test, expect } from "@playwright/test";
import {
	readE2EToken,
	apiFetch,
	connectWs,
	deleteSession,
	nonGitCwd,
	messageEndPredicate,
} from "./e2e-setup.js";

/**
 * Reproducing test for the wizard greeting regression.
 *
 * When creating a new assistant/wizard session (e.g. goal), the client-side
 * code in session-manager.ts should send an auto-prompt ("Start the goal
 * creation session.") so the agent responds with a greeting.
 *
 * The bug: the auto-prompt fires too late in connectToSession() — after
 * multiple await points that create a race window where the WS becomes
 * unavailable, causing remote.send() to silently drop the message.
 *
 * This test creates a goal assistant session and connects via WebSocket,
 * then waits for the agent to produce a greeting. Since the auto-prompt
 * is sent by client-side code (not the server), and this test connects
 * directly via WS without the browser client, the prompt is never sent —
 * demonstrating that the server alone does not trigger the greeting.
 * The test expects the assistant greeting to appear within 15 seconds;
 * when the bug is present, no greeting appears and the test times out.
 *
 * After the fix, the browser client will reliably send the auto-prompt
 * immediately after WS connect, and a full browser E2E test (like the
 * one in goals.spec.ts) will verify the complete flow.
 *
 * Run with:
 *   npm run build:server && npx playwright test tests/e2e/wizard-greeting.spec.ts --config playwright-e2e.config.ts
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
		// 1. Create a goal assistant session via REST (same as clicking "New goal")
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

		// 2. Connect via WebSocket — the same as remote.connect() in the client.
		//    In the real app, session-manager.ts should fire the auto-prompt
		//    immediately after this connection. Due to the bug, the auto-prompt
		//    either fires too late or is silently dropped.
		const ws = await connectWs(sessionId);

		// 3. Wait for the agent to respond with a greeting.
		//    If the auto-prompt was sent (either by server-side logic or client),
		//    the agent will respond. If no prompt arrives, this times out.
		let gotGreeting = false;
		try {
			const assistantMsg = await ws.waitFor(
				messageEndPredicate("assistant"),
				15_000,
			);
			gotGreeting = !!assistantMsg;
		} catch {
			// Timeout — no greeting received
			gotGreeting = false;
		}

		// 4. Assert that the greeting was received.
		//    This fails when the bug is present because no auto-prompt is sent.
		expect(
			gotGreeting,
			"Expected agent to respond with a greeting after goal assistant session was created. " +
			"No assistant message was received — the auto-prompt was likely not sent due to the race condition in session-manager.ts.",
		).toBe(true);

		ws.close();
	});
});
