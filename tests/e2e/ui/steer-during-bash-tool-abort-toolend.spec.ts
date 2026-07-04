/**
 * Browser E2E (Tier 2.5) — repro for the live-session bug actually observed
 * by the user (after PR #474 + #475).
 *
 * Real-session symptom (real Claude agent, captured via live-server drive
 * harness at .bobbit/notes/drive-live-bug.mjs): user runs a long bash, queues
 * Steer1+Steer2, marks them steered, clicks Stop. Pills clear, but neither
 * <user-message> renders. Steers only get processed once a fresh prompt is
 * sent.
 *
 * Why mock tests in #474 / #475 passed but live failed:
 *
 *   When the bash tool is interrupted, the real bash extension emits
 *   `tool_execution_end` (because the underlying bash process is killed).
 *   The default mock did not — it returned early on abort. Bobbit's
 *   `_handleAgentEvent` `tool_execution_end` handler then dispatches steered
 *   rows via `rpcClient.steer(batchText)`. The SDK accepts the text and
 *   pushes it onto `_steeringMessages`, but the agent loop is in the middle
 *   of an abort — it never consumes those messages. Meanwhile bobbit's
 *   ledger entry was pushed AFTER the await, so `agent_end` runs
 *   `_reconcileAfterAbort` against an empty ledger and there's nothing to
 *   re-enqueue. The steers vanish.
 *
 * Two-part fix in this commit:
 *   1. `_dispatchSteer` now records the in-flight ledger entry BEFORE the
 *      await, so an abort firing during the steer RPC can still see it and
 *      re-enqueue via `_reconcileAfterAbort`. On RPC failure the entry is
 *      spliced back out.
 *   2. `tool_execution_end` handler now SKIPS dispatching steers when
 *      `session.status === "aborting"`. The post-abort `drainQueue` becomes
 *      the single dispatch site — no double-fire (which would deliver the
 *      same text twice once the agent restarts), no orphan entries on the
 *      SDK's `_steeringMessages` queue.
 *
 * MOCK_ABORT_TOOL_END=1 makes the in-process mock emit `tool_execution_end`
 * on abort (matches the real bash extension's behaviour).
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

test.describe("steer subsystem — queue + steer + abort with tool_execution_end on abort", () => {
	test.setTimeout(90_000);

	test.beforeAll(async () => {
		// Make the mock emit tool_execution_end on abort (real bash extension
		// behaviour) AND drop steer text when the loop has just been aborted
		// (real SDK behaviour: _steeringMessages populated but loop exited
		// before consuming). Without these two flags the in-process mock
		// hides the real-agent failure mode this PR fixes.
		process.env.MOCK_ABORT_TOOL_END = "1";
		process.env.MOCK_STEER_QUEUE_DROP = "1";
		await waitForHealth();
	});

	test.afterAll(() => {
		delete process.env.MOCK_ABORT_TOOL_END;
		delete process.env.MOCK_STEER_QUEUE_DROP;
	});

	test("queued+steered messages drain after Stop with tool_execution_end on abort — no duplicates", async ({ page, rec }) => {
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

			// Wait for the server-side Bash tool start, not just the early streaming
			// UI state. The long busy window keeps the turn abortable under broad-suite
			// load; the per-test timeout is larger so missing steer delivery still fails
			// on the post-Stop echo/render assertions instead of closing the page first.
			await sendMessage(page, "STAY_BUSY:30000 working");
			await conn.waitFor(toolStartPredicate("Bash"), 15_000);
			await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });
			await rec.capture("Agent busy — bash tool running");

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

			const steerCursor = conn.messageCount();
			await clickAllSteerButtons(page);
			await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 5_000 });
			await rec.capture("Both pills steered and dispatched");

			await clickStopIfPresent(page);
			await rec.capture("Stop clicked if still streaming");

			// Both steered texts must reach the agent without any further user input.
			// First wait on the authoritative WS echo so delivery failures do not get
			// misreported as client-render timing, then assert the user-visible rows.
			await waitForSteeredEchoes(conn, steerCursor);
			await expect(
				page.locator("user-message").filter({ hasText: "Steer1" }).first(),
			).toBeVisible({ timeout: 10_000 });
			await rec.capture("Steer1 user-message rendered");

			await expect(
				page.locator("user-message").filter({ hasText: "Steer2" }).first(),
			).toBeVisible({ timeout: 10_000 });
			await rec.capture("Steer2 user-message rendered");

			// Critical: no duplicate <user-message>. The earlier (#475) iteration
			// re-enqueued correctly but ALSO let rpcClient.steer succeed, so the
			// SDK queued the text on _steeringMessages while drainQueue ran a
			// fresh prompt() with the same text — ending up with the steered
			// content rendered twice in the chat. The fix gates dispatch when
			// status is 'aborting' so drainQueue is the single dispatch site.
			const steer1Count = await page.locator("user-message").filter({ hasText: "Steer1" }).count();
			const steer2Count = await page.locator("user-message").filter({ hasText: "Steer2" }).count();
			expect(steer1Count).toBe(1);
			expect(steer2Count).toBe(1);

			await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 10_000 });
			await rec.capture("Queue drained, no duplicates");
		} finally {
			conn.close();
		}
	});
});
