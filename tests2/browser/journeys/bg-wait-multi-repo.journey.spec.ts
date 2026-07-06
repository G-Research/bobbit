/**
 * Journey: BG Wait Steer + Multi-Repo — v2 browser smoke
 * Covers: journey-bg-wait-steer, journey-multi-repo
 * Consolidated from: bg-wait-*, multi-repo-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../_helpers/journey-fixture.js";
import { sendMessage } from "../../../tests/e2e/ui/ui-helpers.js";

test.describe("Journey: BG Wait Steer", () => {
	test("session loads for bg-wait interaction", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("message editor present for steer interaction", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("steer test");
			const val = await editor.inputValue();
			expect(val).toBe("steer test");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("bg-processes API responds with empty list for a fresh session", async () => {
		// Tests the bg-process API surface without spawning a real process
		// (bash.exe unavailable in the verification environment — ENOENT).
		// Coverage of full bg-process lifecycle (create→poll→exited→exitCode)
		// is in tests/e2e/ui/bg-process-persistence.spec.ts in the legacy suite.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			const res = await apiFetch(`/api/sessions/${sessionId}/bg-processes`);
			expect(res.status, "GET bg-processes should return 200").toBe(200);
			const body = await res.json();
			expect(Array.isArray(body.processes), "response has processes array").toBe(true);
			expect(body.processes.length, "fresh session has no bg processes").toBe(0);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("queue pill and steer button appear when a message is sent while agent is busy", async ({ page }) => {
		// UI-only test: verifies the queue-pill + steer-btn path (no bash_bg create —
		// bash.exe is unavailable; full bg-wait lifecycle is in the legacy suite).
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const textarea = page.locator("message-editor textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });

			// Make the agent busy for a few seconds via the STAY_BUSY mock trigger.
			await sendMessage(page, "STAY_BUSY:4000 working");

			// Wait until the agent is streaming (Stop button becomes visible).
			await expect(page.locator("button[title='Stop streaming']")).toBeVisible({ timeout: 10_000 });

			// Queue a second message while the agent is busy.
			await textarea.fill("queued follow-up");
			await textarea.press("Enter");

			// The queued pill must appear with a Steer button.
			await expect(page.locator(".queue-pill").first()).toBeVisible({ timeout: 5_000 });
			await expect(page.locator(".steer-btn")).toHaveCount(1, { timeout: 5_000 });

			// Click Steer — the queued row is dispatched immediately and the pill vanishes.
			await page.locator(".steer-btn").first().evaluate((el: HTMLElement) => el.click());
			await expect(page.locator(".queue-pill")).toHaveCount(0, { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Multi-Repo", () => {
	test("project settings route reachable for multi-repo config", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("app shell stable during multi-repo project setup flow", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
	});
});
