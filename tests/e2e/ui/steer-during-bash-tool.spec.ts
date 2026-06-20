/**
 * Browser E2E (Tier 2.5) — repro for the bug observed on master after the
 * steer-subsystem rewrite (commit 08dd4424).
 *
 * Real-session symptom: user runs a long bash, queues two messages, marks
 * them as steered, clicks Stop. The agent appears to receive nothing — the
 * steered texts only get processed once a fresh prompt is sent.
 *
 * Why the default mock path passes (and why this test wires MOCK_ABORT_AS_ERROR=1):
 * the real Claude bridge surfaces an aborted in-flight turn as an assistant
 * `message_end` with `stopReason:"error"` BEFORE the terminal `agent_end`.
 * That sets `session.lastTurnErrored=true`, which gates `drainQueue` off in
 * the `agent_end` handler (session-manager.ts ~line 1715). Steered rows
 * sitting in `promptQueue` therefore stay parked until the next user prompt
 * implicitly unsticks the session.
 *
 * The default mock emits a clean `agent_end` on abort (no error stopReason),
 * so existing tests don't exercise this path. The MOCK_ABORT_AS_ERROR=1 env
 * switches the mock to real-agent-shape abort behaviour.
 *
 * Run with capture on:
 *   RECORDSCREEN=1 npm run test:e2e -- steer-during-bash-tool.spec.ts
 */
import { test, expect } from "./fixtures.js";
import {
	connectWs,
	createSession,
	queueLenPredicate,
	toolStartPredicate,
	waitForHealth,
	waitForSessionStatus,
	type WsConnection,
	type WsMsg,
} from "../e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "./ui-helpers.js";

async function clickAllSteerButtons(page: any): Promise<void> {
	const buttons = page.locator(".queue-pill .steer-btn");
	let remaining = await buttons.count();
	while (remaining > 0) {
		// Under full-suite load, a queued row can drain between the count above
		// and the click. Query synchronously in the page so a vanished button is
		// treated as already drained instead of waiting for a selector that
		// should not reappear.
		const clicked = await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>(".queue-pill .steer-btn");
			if (!button) return false;
			button.click();
			return true;
		});

		if (clicked) {
			await expect.poll(async () => buttons.count(), { timeout: 5_000 }).toBeLessThan(remaining);
		}

		remaining = await buttons.count();
	}
}

async function clickStopIfPresent(page: any): Promise<void> {
	const stop = page.locator("button[title='Stop streaming']").first();
	if (await stop.count() === 0) return;
	await stop.evaluate((el: HTMLElement) => el.click()).catch(() => { /* already settled */ });
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

test.describe("steer subsystem — queue + steer + abort with errored agent_end", () => {
	test.setTimeout(90_000);

	test.beforeAll(async () => {
		// Switch the in-process mock bridge to real-agent-shape abort: the
		// abort handler emits a `message_end` with `stopReason:"error"` before
		// `agent_end`, mirroring what the real Claude bridge does.
		process.env.MOCK_ABORT_AS_ERROR = "1";
		await waitForHealth();
	});

	test.afterAll(() => {
		delete process.env.MOCK_ABORT_AS_ERROR;
	});

	test("queued+steered messages must drain after Stop without requiring a fresh user prompt", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
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
			await sendMessage(page, "STAY_BUSY:10000 working");
			await conn.waitFor(toolStartPredicate("Bash"), 15_000);
			await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });
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
			await rec.capture("Two messages queued");

			// 3. Mark both as steered.
			const steerCursor = conn.messageCount();
			await clickAllSteerButtons(page);
			await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 5_000 });
			await rec.capture("Both pills steered and dispatched");

			// 4. Stop if the stream is still active. Immediate queued-steer
			//    dispatch may already have interrupted the mock turn; in that case
			//    the shortened busy window keeps the fallback path bounded.
			await clickStopIfPresent(page);
			await rec.capture("Stop clicked if still streaming — abort with error stopReason");

			// 5. Both steered texts must reach the agent without any further user
			//    input. Queued+steered rows that sat in promptQueue while the
			//    abort fired must be drained automatically once the bridge settles.
			//    A failure here means: lastTurnErrored=true is gating drainQueue
			//    off, and the rows stay parked until a fresh enqueuePrompt does
			//    the implicit unstick.
			await waitForSteeredEchoes(conn, steerCursor);
		} finally {
			conn.close();
		}
	});
});
