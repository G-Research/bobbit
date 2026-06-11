/**
 * "Replace bobbit sprite with text" chat-blob E2E tests.
 *
 * Covers the General-settings toggle that swaps the animated chat-blob sprite
 * for an animated status-text label (Idle / Busy / Compacting / Ended):
 *   • the toggle renders immediately BELOW the "Show message timestamps" row;
 *   • enabling it replaces the sprite canvas with a `.bobbit-blob-text` label;
 *   • the preference persists across a full page reload;
 *   • disabling it restores the sprite canvas.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";

const EXPECTED_WORDS = ["Idle", "Busy", "Compacting", "Ended"];

test.describe("Replace bobbit sprite with text", () => {
	test("toggle sits below timestamps, swaps sprite for text, persists, and reverts", async ({ page }) => {
		// Create a session with content so the chat blob renders.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
		await sendMessage(page, "hello");
		await waitForAgentResponse(page);
		await waitForSessionStatus(sessionId, "idle");

		// Sprite canvas is present while the setting is OFF (default).
		const spriteCanvas = page.locator("canvas.bobbit-blob__sprite").first();
		const textLabel = page.locator(".bobbit-blob-text").first();
		await expect(spriteCanvas).toBeVisible({ timeout: 10_000 });
		await expect(textLabel).toHaveCount(0);

		// --- Settings: toggle appears immediately below "Show message timestamps" ---
		await navigateToHash(page, "#/settings/system/general");
		const toggle = page.getByTestId("general-replace-bobbit-with-text");
		await expect(toggle).toBeVisible({ timeout: 10_000 });

		const timestampsLabel = page.getByText("Show message timestamps", { exact: true });
		const playSoundToggle = page.getByTestId("general-play-finish-sound");
		await expect(timestampsLabel).toBeVisible();
		await expect(playSoundToggle).toBeVisible();

		const orderY = async () => {
			const ts = await timestampsLabel.boundingBox();
			const rep = await toggle.boundingBox();
			const snd = await playSoundToggle.boundingBox();
			return { ts: ts!.y, rep: rep!.y, snd: snd!.y };
		};
		const { ts, rep, snd } = await orderY();
		// Replace-with-text row is below the timestamps row and above play-sound.
		expect(rep).toBeGreaterThan(ts);
		expect(snd).toBeGreaterThan(rep);

		// --- Enable: sprite canvas gone, status-text label present ---
		await expect(toggle).not.toBeChecked();
		await toggle.click();
		await expect(toggle).toBeChecked();

		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		await expect(textLabel).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("canvas.bobbit-blob__sprite")).toHaveCount(0);
		// Label content is one of the known status words.
		const labelText = (await textLabel.getAttribute("aria-label")) ?? "";
		expect(EXPECTED_WORDS).toContain(labelText);

		// --- Persistence across a full reload ---
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		await expect(textLabel).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("canvas.bobbit-blob__sprite")).toHaveCount(0);

		// Toggle still reflects the persisted ON state in settings.
		await navigateToHash(page, "#/settings/system/general");
		const toggleAfterReload = page.getByTestId("general-replace-bobbit-with-text");
		await expect(toggleAfterReload).toBeChecked({ timeout: 10_000 });

		// --- Disable: sprite canvas restored, text label gone ---
		await toggleAfterReload.click();
		await expect(toggleAfterReload).not.toBeChecked();

		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		await expect(page.locator("canvas.bobbit-blob__sprite").first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(".bobbit-blob-text")).toHaveCount(0);

		await deleteSession(sessionId);
	});
});
