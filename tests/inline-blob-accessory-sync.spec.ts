import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/inline-blob-accessory-sync.html")}`;

/**
 * Reproducing test for the inline blob accessory animation desync bug.
 *
 * On the Roles page, inline bobbit blobs use --bobbit-eye-delay to stagger
 * eye animations. The sprite gets animation-delay via:
 *   .bobbit-blob--inline .bobbit-blob__sprite { animation-delay: var(--bobbit-eye-delay) }
 *
 * But accessories (magnifier, bandana, palette, pencil, shield, set-square, flask)
 * do NOT get the same animation-delay override, so their idle animations start
 * at t=0 regardless of the blob's --bobbit-eye-delay. This causes them to
 * desync from the eye animation.
 */
test.describe("Inline blob accessory animation-delay sync", () => {
	const accessories = [
		{ name: "magnifier", delay: "3s" },
		{ name: "bandana",   delay: "5s" },
		{ name: "palette",   delay: "2s" },
		{ name: "pencil",    delay: "4s" },
		{ name: "shield",    delay: "7s" },
		{ name: "set-square", delay: "1s" },
		{ name: "flask",     delay: "6s" },
	];

	test("sprite gets animation-delay from --bobbit-eye-delay (control)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// The sprite DOES get the delay — this is the existing working rule
		const sprite = page.locator('[data-testid="blob-magnifier"] .bobbit-blob__sprite');
		const spriteDelay = await sprite.evaluate(
			(el: HTMLElement) => getComputedStyle(el).animationDelay,
		);
		expect(spriteDelay).toBe("3s");
	});

	for (const { name, delay } of accessories) {
		test(`${name} accessory animation-delay should match --bobbit-eye-delay (${delay})`, async ({ page }) => {
			await page.goto(TEST_PAGE);

			const accessory = page.locator(`[data-testid="blob-${name}"] .bobbit-blob__${name}`);
			const accessoryDelay = await accessory.evaluate(
				(el: HTMLElement) => getComputedStyle(el).animationDelay,
			);

			// BUG: accessories don't inherit the --bobbit-eye-delay as animation-delay.
			// They should have the same delay as the sprite to stay in sync.
			expect(accessoryDelay, `accessory animation-delay should match --bobbit-eye-delay`).toBe(delay);
		});
	}
});
