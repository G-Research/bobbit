/**
 * Browser E2E — full user flow: send-while-`bash_bg wait`-is-blocking + steer.
 *
 * Closes the gap between the two existing specs:
 *   - tests/e2e/bg-wait-steer-abort.spec.ts  — server-only: pokes
 *     `bgProcessManager.abortAllWaits()` directly, no UI.
 *   - tests/e2e/ui/queue-ui.spec.ts (PI-10)  — UI steer pill flow, but no bg
 *     process and no wait-abort assertion.
 *
 * This test exercises the real user flow end-to-end:
 *   1. Open the app, send a prompt that puts the agent into a long tool call.
 *   2. Spawn a real background process via REST and start a long-poll wait
 *      (the same wait that an in-agent `bash_bg wait` call would issue).
 *   3. While the agent is busy and the wait is parked, the user types a
 *      follow-up in the textarea, presses Enter (queued pill appears), and
 *      clicks the Steer button.
 *   4. Clicking Steer promotes the queued row, immediately dequeues the
 *      steered front group, and calls `_dispatchSteer()` while the agent is
 *      streaming. `_dispatchSteer()` owns `bgProcessManager.abortAllWaits()`,
 *      so any in-flight `bash_bg wait` long-poll is unblocked with
 *      `aborted:true` — the bg process itself is left running.
 *   5. The steered text is rendered as a user-message in the chat,
 *      proving the steer text actually reached the agent.
 *
 * Together the assertions guarantee that:
 *   - The UI steer button reaches the server (sent-indicator appears).
 *   - The bash_bg-wait abort hook on the steer-dispatch path actually fires
 *     (wait returns aborted:true within the timeout, bg proc still running).
 *   - The steer is delivered to the agent (user-message rendered in chat).
 *
 * If any of those wires regress in isolation — e.g. someone removes the
 * `bg.abortAllWaits` call from `_dispatchSteer`, or queued promotion stops
 * dispatching immediately while streaming — this single test catches it.
 */
import { test, expect } from "./fixtures.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
	apiFetch,
} from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

// Long-running bg command — must outlive the entire test so we can assert it
// is still running after the wait is aborted.
const SLEEP_CMD = process.platform === "win32"
	? "ping -n 60 127.0.0.1 >NUL"
	: "sleep 60";

test.describe("bash_bg wait + steer — end-to-end user flow", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("queue + steer while bg-wait is parked aborts the wait and delivers the steer mid-turn", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await rec.capture("Empty composer ready");

		// 1. Make the agent busy. STAY_BUSY:<ms> emits tool_execution_start
		//    ("Bash sleep"), ticks for <ms>, then emits tool_execution_end.
		//    The steered message is batched and dispatched on that _end event,
		//    so the busy window has to be long enough for us to (a) start the
		//    bg wait, (b) queue a message, (c) click Steer — comfortably ~5s.
		await sendMessage(page, "STAY_BUSY:5000 working");
		await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });
		await rec.capture("Agent busy — Stop button visible");

		// 2. Spawn a real long-running bg process attached to this session,
		//    then start a long-poll wait with a generous timeout. Don't await
		//    the wait yet — it should park inside the BgProcessManager until
		//    the steer dispatch unblocks it.
		const bgRes = await apiFetch(`/api/sessions/${sessionId}/bg-processes`, {
			method: "POST",
			body: JSON.stringify({ command: SLEEP_CMD, name: "sleeper-steer" }),
		});
		expect(bgRes.status).toBe(201);
		const bg = await bgRes.json();

		const waitStart = Date.now();
		const waitPromise = apiFetch(
			`/api/sessions/${sessionId}/bg-processes/${bg.id}/wait?timeout=60`,
		).then(async (r) => ({ status: r.status, body: await r.json() as {
			aborted: boolean;
			timedOut: boolean;
			info: { status: string };
		} }));
		await rec.capture("Bg sleeper running, wait long-poll parked");

		// 3. Queue a follow-up message via the UI textarea (the real user path).
		const textarea = page.locator("textarea").first();
		await textarea.fill("steer-during-bg-wait");
		await textarea.press("Enter");
		await expect(page.locator(".queue-pill").first()).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".steer-btn")).toHaveCount(1);
		await rec.capture("Follow-up queued — pill visible, Steer button armed");

		// 4. Click the Steer pill → server marks isSteered, dequeues the
		//    steered front group, and immediately calls _dispatchSteer while
		//    the agent is streaming.
		await page.locator(".steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".sent-indicator")).toContainText("Sent");
		await rec.capture("Steer clicked — sent-indicator shows Sent");

		// 5. Streaming `steerQueued` immediately calls _dispatchSteer, and
		//    _dispatchSteer owns `bgProcessManager.abortAllWaits(sessionId)`.
		//    The parked wait resolves with `aborted:true` immediately on the
		//    click — NOT after the busy tool's 5000ms `tool_execution_end`
		//    fires. The bg process itself keeps running. Without this, a
		//    steer-on-queue while the agent is parked in bash_bg.wait would be
		//    deferred until the wait completed naturally (could be minutes).
		const result = await waitPromise;
		const elapsed = Date.now() - waitStart;
		expect(result.status).toBe(200);
		expect(result.body.aborted).toBe(true);
		expect(result.body.timedOut).toBe(false);
		expect(result.body.info.status).toBe("running");
		// The wait must abort well before the 5000ms busy-tool boundary. 3000ms
		// is a generous ceiling: slow CI takes ~500ms wall-time end-to-end for
		// the click → ws → steerQueued → _dispatchSteer → abortAllWaits chain.
		// A regression that makes queued promotion wait for the busy tool's
		// _end event would push elapsed past 5000ms, which this assertion catches.
		expect(elapsed).toBeLessThan(3_000);

		// 6. Steer text actually reached the agent — its handlePrompt round-trip
		//    renders a user-message containing the steered text.
		await expect(
			page.locator("user-message").filter({ hasText: "steer-during-bg-wait" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await rec.capture("steered user-message rendered — steer reached agent");

		// 7. After all the dust settles, the bg process is still running.
		const listRes = await apiFetch(`/api/sessions/${sessionId}/bg-processes`);
		const list = await listRes.json();
		const proc = (list.processes as Array<{ id: string; status: string }>).find(
			(p) => p.id === bg.id,
		);
		expect(proc).toBeTruthy();
		expect(proc!.status).toBe("running");

		// Cleanup: kill the bg process so the worker doesn't leak it.
		await apiFetch(`/api/sessions/${sessionId}/bg-processes/${bg.id}`, {
			method: "DELETE",
		}).catch(() => { /* best-effort */ });
	});
});
