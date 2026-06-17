/**
 * Browser E2E (Tier 2.5) — repro for the live-session bug observed after the
 * steer-subsystem rewrite (commit 08dd4424) and partial-fix PR #474.
 *
 * Real-session symptom (mobile, real Claude agent, claude-opus-4-7):
 *   1. Send a prompt that starts a long foreground bash (`sleep 30`).
 *   2. Queue two messages "Steer1", "Steer2" while busy.
 *   3. Click Steer on each pill.
 *   4. Click Stop.
 *   5. Wait \u2014 nothing happens. The queued steers never reach the agent.
 *      They only get processed after the user sends a fresh prompt.
 *
 * Why mock tests passed but live failed:
 *   pi-agent-core's `runWithLifecycle` (agent.js ~L298-322) emits the
 *   terminal `agent_end` from `handleRunFailure` *before* the outer
 *   try/finally's `finishRun()` clears `activeRun`. Any synchronous
 *   `prompt()` call from an `agent_end` listener (e.g. bobbit's drainQueue
 *   reaching for steered rows) therefore rejects/responds with
 *   "Agent is already processing." Bobbit's drainQueue:
 *     - Optimistically sets status="streaming"
 *     - Calls rpcClient.prompt(steeredText) \u2014 fails synchronously
 *     - .catch only logs; the steered rows are gone from the queue
 *   Steered rows are lost, and only a fresh user prompt (which goes
 *   through enqueuePrompt instead of drainQueue) eventually breaks the
 *   stall.
 *
 * MOCK_ABORT_BUSY=1 enables the in-process mock to reproduce that exact
 * race: the abort handler sets `_busyOverride=true` for one microtask, so
 * any prompt() call from an agent_end listener synchronously fails.
 *
 * Contract under test:
 *   queued+steered rows must reach the agent without further user input.
 *   Both <user-message> rows must render after Stop.
 */
import { test, expect } from "./fixtures.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

async function clickAllSteerButtons(page: any): Promise<void> {
	let remaining = await page.locator(".queue-pill .steer-btn").count();
	while (remaining > 0) {
		await page.locator(".queue-pill .steer-btn").first().evaluate((el: HTMLElement) => el.click());
		await expect.poll(async () => page.locator(".queue-pill .steer-btn").count(), { timeout: 5_000 }).toBeLessThan(remaining);
		remaining = await page.locator(".queue-pill .steer-btn").count();
	}
}

async function clickStopIfPresent(page: any): Promise<void> {
	const stop = page.locator("button[title='Stop streaming']").first();
	if (await stop.count() === 0) return;
	await stop.evaluate((el: HTMLElement) => el.click()).catch(() => { /* already settled */ });
}

test.describe("steer subsystem \u2014 queue + steer + abort with busy-race", () => {
	test.beforeAll(async () => {
		// Switch the in-process mock bridge to the real-agent-shape race:
		// agent_end emits while activeRun still set, so any synchronous
		// prompt() from a listener responds {success:false, error:"Agent is
		// already processing."}.
		process.env.MOCK_ABORT_BUSY = "1";
		await waitForHealth();
	});

	test.afterAll(() => {
		delete process.env.MOCK_ABORT_BUSY;
	});

	test("queued+steered messages drain after Stop even when prompt() races against finishRun", async ({ page, rec }) => {
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

		await clickAllSteerButtons(page);
		await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 5_000 });
		await rec.capture("Both pills steered and dispatched");

		await clickStopIfPresent(page);
		await rec.capture("Stop clicked if still streaming \u2014 abort with busy race");

		// Both steered texts must reach the agent without any further user
		// input, even though the synchronous-on-agent_end prompt() call
		// rejects due to the not-yet-cleared activeRun flag.
		await expect(
			page.locator("user-message").filter({ hasText: "Steer1" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await rec.capture("Steer1 user-message rendered");

		await expect(
			page.locator("user-message").filter({ hasText: "Steer2" }).first(),
		).toBeVisible({ timeout: 5_000 });
		await rec.capture("Steer2 user-message rendered");

		await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 10_000 });
		await rec.capture("Queue drained");
	});
});
