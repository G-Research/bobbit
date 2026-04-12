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

	test("PI-10: steer pill shows Sent badge, steer delivered mid-turn without abort", async ({ page }) => {
		// PI-10: Queue a message, click Steer, verify delivery WITHOUT aborting.
		// The mock agent emits [STEER_RECEIVED] text when it gets a steer RPC,
		// which appears in the chat as visible text.
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

		// PI-10 step 1: Queue a message while agent is streaming
		const textarea = page.locator("textarea").first();
		await textarea.fill("steer me now");
		await textarea.press("Enter");

		// Queued pill appears with muted styling and Steer button
		await expect(page.locator(".queue-pill").first()).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".steer-btn")).toHaveCount(1);

		// PI-10 step 2: Click Steer → pill shows "Sent", dispatched immediately
		await page.locator(".steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".sent-indicator")).toContainText("Sent");

		// PI-10 step 3: Agent receives the steer at the next tool boundary.
		// The mock agent emits [STEER_RECEIVED] which appears in chat.
		// Verify it appears WITHOUT clicking abort.
		await expect(
			page.getByText("STEER_RECEIVED").first(),
		).toBeVisible({ timeout: 10_000 });
	});

	test("PI-10b: batch steer — two pills promoted, both delivered without abort", async ({ page }) => {
		// PI-10b: Queue two messages, click Steer on each, verify both are
		// delivered as a batch mid-turn without requiring abort.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Make agent busy
		await sendMessage(page, "STAY_BUSY:15000 working");
		await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });

		// PI-10b steps 1-2: Queue two messages
		const textarea = page.locator("textarea").first();
		await textarea.fill("batch steer A");
		await textarea.press("Enter");
		await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });

		await textarea.fill("batch steer B");
		await textarea.press("Enter");
		await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });

		// PI-10b step 3: Click Steer on pill 1
		await page.locator(".queue-pill .steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toHaveCount(1, { timeout: 3_000 });

		// PI-10b step 4: Click Steer on pill 2
		await page.locator(".queue-pill .steer-btn").first().click();
		await expect(page.locator(".sent-indicator")).toHaveCount(2, { timeout: 3_000 });

		// PI-10b step 5: Agent receives both steers at the next tool boundary.
		// The mock agent emits [STEER_RECEIVED] in chat.
		// Verify delivery WITHOUT aborting.
		await expect(
			page.getByText("STEER_RECEIVED").first(),
		).toBeVisible({ timeout: 10_000 });
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

		// Draft restore is async (fires after session connects, messages load, and
		// _setupPromptDraftHandlers runs). A Lit re-render can race with the restore,
		// momentarily clearing the textarea. Use toPass to retry the full check.
		await expect(async () => {
			const val = await page.locator("textarea").first().inputValue();
			expect(val).toBe(draftText);
		}).toPass({ intervals: [500, 1000, 1000, 2000, 2000], timeout: 20_000 });
	});

	test("story 9: edit pill — remove, modify, re-queue at end", async ({ page }) => {
		// Note: onEditQueued is wired in AgentInterface by a separate task.
		// This test verifies the full edit flow via WS API (remove + re-queue)
		// and validates the UI reflects all changes correctly. When onEditQueued
		// is wired, the pencil button click triggers the same API operations.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// Make agent busy
			conn.send({ type: "prompt", text: "STAY_BUSY:15000 working" });
			await conn.waitFor(statusPredicate("streaming"));

			// Queue 2 messages
			conn.send({ type: "prompt", text: "edit me" });
			await conn.waitFor(queueLenPredicate(1));
			conn.send({ type: "prompt", text: "keep me" });
			const q2 = await conn.waitFor(queueLenPredicate(2));

			// Verify both pills appear in UI in order
			await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });
			await expect(page.locator(".pill-text").nth(0)).toContainText("edit me");
			await expect(page.locator(".pill-text").nth(1)).toContainText("keep me");

			// Simulate edit: remove the first pill
			conn.send({ type: "remove_queued", messageId: q2.queue![0].id });
			await conn.waitFor(queueLenPredicate(1));

			// UI should show only "keep me"
			await expect(page.locator(".queue-pill")).toHaveCount(1, { timeout: 5_000 });
			await expect(page.locator(".pill-text").first()).toContainText("keep me");

			// Re-queue modified version — should appear AFTER "keep me"
			conn.send({ type: "prompt", text: "edited message" });
			await conn.waitFor(queueLenPredicate(2));

			// Verify order: "keep me" first (original), "edited message" at end
			await expect(page.locator(".queue-pill")).toHaveCount(2, { timeout: 5_000 });
			await expect(page.locator(".pill-text").nth(0)).toContainText("keep me");
			await expect(page.locator(".pill-text").nth(1)).toContainText("edited message");
		} finally {
			conn.close();
		}
	});

	test("story 24: draft cleared after sending message", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Type draft text (don't send yet)
		const textarea = page.locator("textarea").first();
		await textarea.fill("draft to be cleared");

		// Wait for the debounced draft save to complete via API polling
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.data.text).toBe("draft to be cleared");
		}).toPass({ timeout: 10_000 });

		// Send the message (press Enter)
		await textarea.press("Enter");

		// Wait for agent to respond and go idle
		await waitForSessionStatus(sessionId, "idle", 15_000);

		// Reload the page
		await page.reload();

		// Wait for app to load
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Navigate back to the same session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Verify textarea is empty — draft was cleared on send
		await expect(page.locator("textarea").first()).toHaveValue("", { timeout: 10_000 });
	});
});
