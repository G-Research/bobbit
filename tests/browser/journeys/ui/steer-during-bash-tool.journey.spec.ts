/**
 * Browser E2E (Tier 2.5) — repro for the bug observed on master after the
 * steer-subsystem rewrite (commit 08dd4424).
 *
 * Real-session symptom: user runs a long bash, queues two messages, marks
 * them as steered, clicks Stop. The agent appears to receive nothing — the
 * steered texts only get processed once a fresh prompt is sent.
 *
 * The current mock's explicit abort lifecycle matches the bridge contract.
 * Its post-abort steer-drop mode mirrors Pi accepting steer text after the
 * active loop has exited; both accepted messages must still surface after Stop.
 *
 * Run with capture on:
 *   RECORDSCREEN=1 npm run test:e2e -- steer-during-bash-tool.spec.ts
 */
import { test, expect } from "../../../support/harnesses/browser/legacy-ui/fixtures.js";
import {
	connectWs,
	createSession,
	queueLenPredicate,
	toolStartPredicate,
	waitForHealth,
	waitForSessionStatus,
	type WsConnection,
	type WsMsg,
} from "../../_helpers/e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "../../../support/harnesses/browser/legacy-ui/ui-helpers.js";

async function clickAllSteerButtonsAndStop(page: any): Promise<{ steered: number; stopped: boolean }> {
	// Dispatch the already-decided user sequence in one browser task so the
	// first Steer render cannot remove the second Steer or Stop control.
	return page.evaluate(() => {
		const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".queue-pill .steer-btn"));
		for (const button of buttons) button.click();
		const stop = document.querySelector<HTMLButtonElement>('button[title="Stop current turn"]');
		stop?.click();
		return { steered: buttons.length, stopped: !!stop };
	});
}

function userMessageIncludes(text: string): (m: WsMsg) => boolean {
	return (m) => m.type === "event"
		&& m.data?.type === "message_end"
		&& m.data?.message?.role === "user"
		&& JSON.stringify(m.data.message).includes(text);
}

async function waitForSteeredEchoes(conn: WsConnection, cursor: number): Promise<void> {
	await conn.waitForFrom(cursor, userMessageIncludes("Steer1"), 20_000);
	await conn.waitForFrom(cursor, userMessageIncludes("Steer2"), 20_000);
}

test.describe("steer subsystem — queue + steer + abort recovery", () => {
	test.setTimeout(90_000);

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("queued+steered messages must drain after Stop without requiring a fresh user prompt", async ({ page, rec, gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const mockAgent = gateway.sessionManager.getSession(sessionId)?.rpcClient?._agent;
		expect(mockAgent, "abort-reconcile journey requires the in-process mock bridge").toBeTruthy();
		// Configure this exact session, not worker-global process state. In the
		// current fidelity mode Pi drops steer text only after the abort window.
		mockAgent.env.MOCK_STEER_QUEUE_DROP = "1";
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await page.waitForFunction((id) => {
				return window.location.hash.includes(`/session/${id}`)
					&& (window as any).bobbitState?.selectedSessionId === id;
			}, sessionId, { timeout: 15_000 });
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await rec.capture("Empty composer ready");

			// 1. Long busy bash. Wait for the server-side tool start, not just
			//    the early UI streaming state, so queued rows cannot race a turn
			//    that has not actually entered the abortable bash body yet.
			await sendMessage(page, "STAY_BUSY:30000 working");
			await conn.waitFor(toolStartPredicate("Bash"), 15_000);
			await expect(page.getByRole("button", { name: "Stop current turn" })).toBeVisible({ timeout: 10_000 });
			await rec.capture("Agent busy — bash tool running");

			// 2. Queue two messages. Confirm both the visible pills and the
			//    authoritative server queue so later assertions are not racing a
			//    client-only render delay.
			const textarea = page.locator("textarea").first();
			let cursor = conn.messageCount();
			await textarea.fill("Steer1");
			await textarea.press("Enter");
			await conn.waitForFrom(cursor, queueLenPredicate(1), 10_000);
			await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
			cursor = conn.messageCount();
			await textarea.fill("Steer2");
			await textarea.press("Enter");
			await conn.waitForFrom(cursor, queueLenPredicate(2), 10_000);
			await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });
			await expect(page.locator(".queue-pill .steer-btn")).toHaveCount(2, { timeout: 5_000 });
			await rec.capture("Two messages queued");

			// 3–4. Promote both queued rows, then Stop the same active turn.
			const steerCursor = conn.messageCount();
			expect(await clickAllSteerButtonsAndStop(page)).toEqual({ steered: 2, stopped: true });
			await rec.capture("Both pills steered and Stop clicked");

			// 5. Both steered texts must reach the agent without any further user
			//    input. Queued+steered rows that sat in promptQueue while the
			//    abort fired must be drained automatically once the bridge settles.
			//    A failure here means: lastTurnErrored=true is gating drainQueue
			//    off, and the rows stay parked until a fresh enqueuePrompt does
			//    the implicit unstick.
			await waitForSteeredEchoes(conn, steerCursor);
			await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 10_000 });
		} finally {
			delete mockAgent.env.MOCK_STEER_QUEUE_DROP;
			conn.close();
		}
	});
});
