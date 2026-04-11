/**
 * Unit fixture tests for personality selector chip UI (PI-22).
 * Tests the chip toggle behavior from src/app/dialogs.ts lines 760-790.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/personality-selector.html").replace(/\\/g, "/")}`;

test.describe("Personality selector chips", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("renders a chip for each available personality", async ({ page }) => {
		const chips = page.locator(".chip");
		await expect(chips).toHaveCount(3);
	});

	test("chip shows personality label text", async ({ page }) => {
		const labels = await page.locator(".chip").allTextContents();
		expect(labels).toEqual(["Concise", "Friendly", "Formal"]);
	});

	test("chip title attribute shows description", async ({ page }) => {
		const titles = await page.locator(".chip").evaluateAll((els) =>
			els.map((el) => el.getAttribute("title")),
		);
		expect(titles).toEqual([
			"Short and direct responses",
			"Warm and approachable tone",
			"Professional and structured",
		]);
	});

	test("pre-selected personalities show as selected on render", async ({ page }) => {
		// Default fixture has 'friendly' pre-selected
		const friendlyChip = page.locator('.chip[data-name="friendly"]');
		await expect(friendlyChip).toHaveClass(/selected/);

		const conciseChip = page.locator('.chip[data-name="concise"]');
		await expect(conciseChip).not.toHaveClass(/selected/);
	});

	test("click unselected chip — becomes selected", async ({ page }) => {
		const conciseChip = page.locator('.chip[data-name="concise"]');
		await expect(conciseChip).not.toHaveClass(/selected/);

		await conciseChip.click();
		await expect(conciseChip).toHaveClass(/selected/);
	});

	test("click selected chip — becomes unselected", async ({ page }) => {
		const friendlyChip = page.locator('.chip[data-name="friendly"]');
		await expect(friendlyChip).toHaveClass(/selected/);

		await friendlyChip.click();
		await expect(friendlyChip).not.toHaveClass(/selected/);
	});

	test("multiple chips can be selected simultaneously", async ({ page }) => {
		// Start: only 'friendly' selected. Select 'concise' and 'formal' too.
		await page.locator('.chip[data-name="concise"]').click();
		await page.locator('.chip[data-name="formal"]').click();

		const selected = await page.evaluate(() => (window as any).getSelectedPersonalities());
		expect(selected).toContain("friendly");
		expect(selected).toContain("concise");
		expect(selected).toContain("formal");
		expect(selected).toHaveLength(3);

		// All chips should have selected class
		const selectedChips = page.locator(".chip.selected");
		await expect(selectedChips).toHaveCount(3);
	});

	test("deselecting all returns empty array", async ({ page }) => {
		// Deselect the only pre-selected chip
		await page.locator('.chip[data-name="friendly"]').click();

		const selected = await page.evaluate(() => (window as any).getSelectedPersonalities());
		expect(selected).toEqual([]);

		const selectedChips = page.locator(".chip.selected");
		await expect(selectedChips).toHaveCount(0);
	});

	test("selecting same as initial resets pendingPersonalities to null", async ({ page }) => {
		// Initial: ['friendly']. Select concise (pending becomes ['friendly','concise']),
		// then deselect concise (pending matches initial → resets to null).
		await page.locator('.chip[data-name="concise"]').click();
		let pending = await page.evaluate(() => (window as any).getPendingState());
		expect(pending).not.toBeNull();

		await page.locator('.chip[data-name="concise"]').click();
		pending = await page.evaluate(() => (window as any).getPendingState());
		expect(pending).toBeNull();
	});

	test("selected chip has primary color styling, unselected has muted", async ({ page }) => {
		const selectedChip = page.locator('.chip[data-name="friendly"]');
		const unselectedChip = page.locator('.chip[data-name="concise"]');

		// Selected chip: primary color background
		const selectedBg = await selectedChip.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		);
		expect(selectedBg).toContain("99, 102, 241"); // indigo primary

		// Unselected chip: muted/gray background
		const unselectedBg = await unselectedChip.evaluate(
			(el) => getComputedStyle(el).backgroundColor,
		);
		expect(unselectedBg).toContain("128, 128, 128"); // gray muted
	});

	test("setPersonalities reconfigures chips from scratch", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setPersonalities(
				[
					{ name: "pirate", label: "Pirate", description: "Arr matey" },
					{ name: "poet", label: "Poet", description: "Speaks in verse" },
				],
				["pirate"],
			);
		});

		const chips = page.locator(".chip");
		await expect(chips).toHaveCount(2);

		const labels = await chips.allTextContents();
		expect(labels).toEqual(["Pirate", "Poet"]);

		await expect(page.locator('.chip[data-name="pirate"]')).toHaveClass(/selected/);
		await expect(page.locator('.chip[data-name="poet"]')).not.toHaveClass(/selected/);
	});

	test("no initial selection — all chips start unselected", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setPersonalities(
				[
					{ name: "a", label: "Alpha", description: "First" },
					{ name: "b", label: "Beta", description: "Second" },
				],
				[],
			);
		});

		const selectedChips = page.locator(".chip.selected");
		await expect(selectedChips).toHaveCount(0);

		const selected = await page.evaluate(() => (window as any).getSelectedPersonalities());
		expect(selected).toEqual([]);
	});
});
