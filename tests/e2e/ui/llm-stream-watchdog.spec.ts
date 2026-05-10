/**
 * Browser E2E — LLM stream-inactivity watchdog.
 *
 * Drives the watchdog from end-to-end:
 *   1. Sets `BOBBIT_LLM_STREAM_TIMEOUT_MS` low enough to fire within the test
 *      timeout. The watchdog re-reads env on every event
 *      (`resolveWatchdogConfigFromEnv` in `stream-watchdog.ts`) so a flip
 *      taken before the prompt is sent is honoured.
 *   2. Sends a `STREAM_STALL:<ms>` prompt to the mock agent — the mock emits
 *      `agent_start` then sleeps, mimicking a wedged upstream LLM stream.
 *   3. Asserts the session leaves `streaming` (the watchdog aborted) and
 *      `lastTurnErrored: true` on the session API after MAX_RETRIES + 1
 *      attempts.
 *   4. Asserts a follow-up prompt still works \u2014 the implicit-unstick path
 *      hasn't kicked in yet because only one surfaced stall has occurred.
 *
 * See the design doc on the goal (goal-llm-stream-305c45a1) and
 * `src/server/agent/stream-watchdog.ts`.
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

// Watchdog timing constants. Keep them tight \u2014 each surfaced stall takes
// roughly `(maxRetries + 1) * timeoutMs`, so 500 ms \u00d7 3 attempts ~= 1.5 s.
const TIMEOUT_MS = 500;
const MAX_RETRIES = 2;
// Stall duration must dwarf (timeout * (max+1)) so the mock-agent doesn't
// finish its STREAM_STALL tick before the watchdog has fired all attempts.
const STALL_MS = 30_000;

test.describe("LLM stream-inactivity watchdog", () => {
	test.beforeAll(async () => {
		process.env.BOBBIT_LLM_STREAM_TIMEOUT_MS = String(TIMEOUT_MS);
		process.env.BOBBIT_LLM_STREAM_MAX_RETRIES = String(MAX_RETRIES);
		await waitForHealth();
	});

	test.afterAll(async () => {
		// Restore defaults so other workers / serial tests aren't affected
		// (gateway-harness is worker-scoped; tests within a worker still
		// share env). 30 s is the production default.
		process.env.BOBBIT_LLM_STREAM_TIMEOUT_MS = "30000";
		process.env.BOBBIT_LLM_STREAM_MAX_RETRIES = "2";
	});

	test("stalled stream surfaces an error after MAX_RETRIES+1 attempts; session unwedges", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Mock will emit agent_start then sleep STALL_MS without further frames.
		// The watchdog should fire (timeout=500ms) twice silently, then surface
		// after the third stall. Session leaves `streaming`.
		await sendMessage(page, `STREAM_STALL:${STALL_MS}`);
		await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 5_000 });

		// Allow time for: stall 1 (\u2248 500 ms) + retry + stall 2 + retry + stall 3 + abort.
		// With timeout=500ms and tick=250ms, three stalls take \u2248 1.5\u20132 s.
		await waitForSessionStatus(sessionId, "idle", 10_000);

		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.ok).toBe(true);
		const data = await resp.json() as { lastTurnErrored: boolean; consecutiveErrorTurns: number };
		expect(data.lastTurnErrored, "watchdog must mark the surfaced stall as errored").toBe(true);
		// Exactly 1 \u2014 silent retries do NOT bump the counter; only the surface
		// does. The mock-agent emits production-shape
		// `message_end{stopReason:"error", errorMessage:"Request aborted"}` on
		// every abort (matching real agent fidelity), so the suppression flag
		// (`suppressNextErrorMessageEnd`) is what keeps this at 1 instead of 3.
		expect(data.consecutiveErrorTurns, "consecutiveErrorTurns must bump by exactly 1 (not 3)").toBe(1);

		// Transcript must show the user-visible stalled-stream text. The UI
		// reads `errorMessage` from `message_end` events (Messages.ts); the
		// surfaced-stall path emits a synthetic `message_end` so this string
		// reaches the chat. Without the synthetic-event wiring the user would
		// see only the generic "Request aborted".
		await expect(
			page.getByText(/stream stalled/i).first(),
		).toBeVisible({ timeout: 5_000 });

		// Implicit-unstick path: a single surfaced stall still allows the next
		// prompt to dispatch (the cap is MAX_CONSECUTIVE_ERROR_TURNS = 3).
		await sendMessage(page, "follow-up after stall");
		await waitForSessionStatus(sessionId, "idle", 15_000);
	});

	test("silent retry recovers — fresh frames after one stall, no surfaced error", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await sendMessage(page, `STREAM_STALL_THEN_REPLY:30000`);
		// After one stall + one silent retry, the agent recovers cleanly.
		await waitForSessionStatus(sessionId, "idle", 10_000);

		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		const data = await resp.json() as { lastTurnErrored: boolean; consecutiveErrorTurns: number };
		expect(data.lastTurnErrored, "silent retry must produce a clean turn").toBe(false);
		expect(data.consecutiveErrorTurns, "no surfaced stall, counter stays 0").toBe(0);

		await expect(page.getByText(/RECOVERED/).first()).toBeVisible({ timeout: 5_000 });
		// PR #539 invariant: no duplicate user echoes.
		const userMessages = await page.locator("user-message").count();
		expect(userMessages, "exactly one user-message row").toBe(1);
		// No "Request aborted" rows visible — the abort frame is suppressed.
		await expect(page.getByText(/request aborted/i)).toHaveCount(0);
	});

	test("surfaced stall shows a working Retry button on the last assistant message", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await sendMessage(page, `STREAM_STALL:${STALL_MS}`);
		await waitForSessionStatus(sessionId, "idle", 10_000);
		await expect(page.getByText(/stream stalled/i).first()).toBeVisible({ timeout: 5_000 });

		const retryBtn = page.getByTestId("retry-button");
		await expect(retryBtn).toBeVisible();
		await retryBtn.click();
		await waitForSessionStatus(sessionId, "streaming", 5_000);
		// Don't wait for full recovery (it'll stall again) — just confirm the
		// click re-dispatched the original prompt.
	});
});
