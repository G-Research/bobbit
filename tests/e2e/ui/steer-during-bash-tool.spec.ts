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
	createSession,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

test.describe("steer subsystem — queue + steer + abort with errored agent_end", () => {
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

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await rec.capture("Empty composer ready");

		// 1. Long busy bash.
		await sendMessage(page, "STAY_BUSY:30000 working");
		await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });
		await rec.capture("Agent busy — bash tool running");

		// 2. Queue two messages.
		const textarea = page.locator("textarea").first();
		await textarea.fill("Steer1");
		await textarea.press("Enter");
		await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
		await textarea.fill("Steer2");
		await textarea.press("Enter");
		await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });
		await rec.capture("Two messages queued");

		// 3. Mark both as steered.
		await page.locator(".queue-pill .steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toHaveCount(1, { timeout: 5_000 });
		await page.locator(".queue-pill .steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toHaveCount(2, { timeout: 5_000 });
		await rec.capture("Both pills steered");

		// 4. Stop.
		await page.locator("button[title='Stop streaming']").click();
		await rec.capture("Stop clicked — abort with error stopReason");

		// 5. Both steered texts must reach the agent without any further user
		//    input. Queued+steered rows that sat in promptQueue while the
		//    abort fired must be drained automatically once the bridge settles.
		//    A failure here means: lastTurnErrored=true is gating drainQueue
		//    off, and the rows stay parked until a fresh enqueuePrompt does
		//    the implicit unstick.
		await expect(
			page.locator("user-message").filter({ hasText: "Steer1" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await rec.capture("Steer1 user-message rendered");

		await expect(
			page.locator("user-message").filter({ hasText: "Steer2" }).first(),
		).toBeVisible({ timeout: 5_000 });
		await rec.capture("Steer2 user-message rendered");

		await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 10_000 });
		await rec.capture("Queue drained — bug not present");
	});
});
