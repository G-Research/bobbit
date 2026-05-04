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
 *   The default mock did not \u2014 it returned early on abort. Bobbit's
 *   `_handleAgentEvent` `tool_execution_end` handler then dispatches steered
 *   rows via `rpcClient.steer(batchText)`. The SDK accepts the text and
 *   pushes it onto `_steeringMessages`, but the agent loop is in the middle
 *   of an abort \u2014 it never consumes those messages. Meanwhile bobbit's
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
 *      `session.status === \"aborting\"`. The post-abort `drainQueue` becomes
 *      the single dispatch site \u2014 no double-fire (which would deliver the
 *      same text twice once the agent restarts), no orphan entries on the
 *      SDK's `_steeringMessages` queue.
 *
 * MOCK_ABORT_TOOL_END=1 makes the in-process mock emit `tool_execution_end`
 * on abort (matches the real bash extension's behaviour).
 */
import { test, expect } from "./fixtures.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

test.describe("steer subsystem \u2014 queue + steer + abort with tool_execution_end on abort", () => {
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

	test("queued+steered messages drain after Stop with tool_execution_end on abort \u2014 no duplicates", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await rec.capture("Empty composer ready");

		await sendMessage(page, "STAY_BUSY:30000 working");
		await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });
		await rec.capture("Agent busy \u2014 long bash running");

		const textarea = page.locator("textarea").first();
		await textarea.fill("Steer1");
		await textarea.press("Enter");
		await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
		await textarea.fill("Steer2");
		await textarea.press("Enter");
		await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });
		await rec.capture("Two messages queued");

		await page.locator(".queue-pill .steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toHaveCount(1, { timeout: 5_000 });
		await page.locator(".queue-pill .steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toHaveCount(2, { timeout: 5_000 });
		await rec.capture("Both pills steered");

		await page.locator("button[title='Stop streaming']").click();
		await rec.capture("Stop clicked");

		// Both steered texts must reach the agent without any further user input.
		await expect(
			page.locator("user-message").filter({ hasText: "Steer1" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await rec.capture("Steer1 user-message rendered");

		await expect(
			page.locator("user-message").filter({ hasText: "Steer2" }).first(),
		).toBeVisible({ timeout: 5_000 });
		await rec.capture("Steer2 user-message rendered");

		// Critical: no duplicate <user-message>. The earlier (#475) iteration
		// re-enqueued correctly but ALSO let rpcClient.steer succeed, so the
		// SDK queued the text on _steeringMessages while drainQueue ran a
		// fresh prompt() with the same text \u2014 ending up with the steered
		// content rendered twice in the chat. The fix gates dispatch when
		// status is 'aborting' so drainQueue is the single dispatch site.
		const steer1Count = await page.locator("user-message").filter({ hasText: "Steer1" }).count();
		const steer2Count = await page.locator("user-message").filter({ hasText: "Steer2" }).count();
		expect(steer1Count).toBe(1);
		expect(steer2Count).toBe(1);

		await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 10_000 });
		await rec.capture("Queue drained, no duplicates");
	});
});
