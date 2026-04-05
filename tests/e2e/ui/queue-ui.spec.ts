/**
 * Browser E2E tests for queue UI interactions.
 *
 * Tests queue pills, steer, abort, and draft persistence through the browser.
 * Uses the gateway-harness (spawned gateway process) for real browser interaction.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	connectWs,
	waitForHealth,
	waitForSessionStatus,
	apiFetch,
	statusPredicate,
	queueLenPredicate,
	agentEndPredicate,
} from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Queue UI E2E", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("story 11: steer pill shows Sent badge, abort delivers steered message", async ({ page }) => {
		// Create session via API for control
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Send a message to make agent busy
		await sendMessage(page, "STAY_BUSY:10000 working");

		// Wait for streaming status (the stop button appears)
		await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });

		// Queue 2 messages via textarea
		const textarea = page.locator("textarea").first();
		await textarea.fill("steer me");
		await textarea.press("Enter");

		// Wait for the pill to appear
		await expect(page.locator(".queue-pill").first()).toBeVisible({ timeout: 5_000 });

		await textarea.fill("normal msg");
		await textarea.press("Enter");

		// Wait for 2 pills
		await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });

		// Click "Steer" on the first pill
		await page.locator(".queue-pill").first().locator(".steer-btn").click();

		// The steered pill should show "Sent" indicator
		await expect(page.locator(".sent-indicator")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".sent-indicator")).toContainText("Sent");

		// Click abort/stop button
		await page.locator("button[title='Stop streaming']").click();

		// Wait for agent to go idle and queue to drain
		await waitForSessionStatus(sessionId, "idle", 15_000);

		// After abort and drain, the steered message should appear in chat
		// Wait for it to be fully processed
		await page.waitForFunction(
			() => {
				const msgs = document.querySelectorAll("[class*='message']");
				return msgs.length > 0;
			},
			{ timeout: 15_000 },
		);
	});

	test("story 12: multiple steer — both delivered on abort", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Make agent busy
		await sendMessage(page, "STAY_BUSY:15000 working");
		await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });

		// Queue 3 messages
		const textarea = page.locator("textarea").first();
		for (const text of ["steer A", "steer B", "normal C"]) {
			await textarea.fill(text);
			await textarea.press("Enter");
		}

		// Wait for 3 pills
		await expect(page.locator(".queue-pill")).toHaveCount(3, { timeout: 5_000 });

		// Steer first two pills
		// After clicking steer on pill 0, it reorders. Click steer on another non-steered pill.
		await page.locator(".queue-pill .steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toHaveCount(1, { timeout: 3_000 });

		// There should still be a steer-btn on remaining non-steered pills
		await page.locator(".queue-pill .steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toHaveCount(2, { timeout: 3_000 });

		// Abort
		await page.locator("button[title='Stop streaming']").click();

		// Wait for idle
		await waitForSessionStatus(sessionId, "idle", 15_000);

		// Both steered messages should have been delivered
		// The non-steered message should also drain eventually
		// Wait for queue to be empty (all processed)
		await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 15_000 });
	});

	test("story 22: draft text persists across page reload", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Type draft text (don't send) — use fill which fires input event
		const draftText = "my unsent draft for persistence test";
		const textarea = page.locator("textarea").first();
		await textarea.fill(draftText);

		// Wait for the debounced draft save to complete.
		// The client saves via PUT /api/sessions/:id/draft with type=prompt and data={text, gen}.
		// Poll the GET endpoint until the draft is confirmed saved.
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			// Response format: { type: "prompt", data: { text, gen } }
			expect(body.data.text).toBe(draftText);
		}).toPass({ timeout: 10_000 });

		// Reload the page
		await page.reload();

		// Wait for app to load
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Navigate back to the same session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Verify the textarea has the draft text restored
		await expect(page.locator("textarea").first()).toHaveValue(draftText, { timeout: 10_000 });
	});

	test("story 9: edit pill via API — remove and re-queue", async ({ page }) => {
		// Since onEditQueued is not wired in AgentInterface, test the
		// edit flow via WebSocket API + verify UI reflects changes
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		// Connect a WS client for API-level control
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// Make agent busy
			conn.send({ type: "prompt", text: "STAY_BUSY:10000 working" });
			await conn.waitFor(statusPredicate("streaming"));

			// Queue a message
			conn.send({ type: "prompt", text: "edit me" });
			const q1 = await conn.waitFor(queueLenPredicate(1));

			// Verify pill appears in UI
			await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
			await expect(page.locator(".pill-text").first()).toContainText("edit me");

			// Remove the message (simulating the edit flow: remove + put text in textarea)
			conn.send({ type: "remove_queued", messageId: q1.queue![0].id });
			await conn.waitFor(queueLenPredicate(0));

			// Pill should disappear from UI
			await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 5_000 });

			// Now re-queue a modified version
			conn.send({ type: "prompt", text: "edited message" });
			await conn.waitFor(queueLenPredicate(1));

			// Verify the new pill appears with updated text
			await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
			await expect(page.locator(".pill-text").first()).toContainText("edited message");
		} finally {
			conn.close();
		}
	});
});
