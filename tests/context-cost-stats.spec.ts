/**
 * Unit fixture tests for context usage bar, cost display, and stats bar overview.
 * Covers PI-17 (Context usage bar), PI-18 (Cost display), PI-23 (Stats bar overview).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/context-cost-stats.html").replace(/\\/g, "/")}`;

test.describe("PI-17: Context usage bar", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("bar renders with percentage fill based on usage/limit", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(25000, 5000, 200000));
		const width = await page.evaluate(() => (window as any).getBarWidth());
		expect(width).toBe("15%"); // 30000/200000 = 15%
		const pct = await page.evaluate(() => (window as any).getPctText());
		expect(pct).toBe("15%");
	});

	test("color is blue (primary) below 75%", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(50000, 10000, 200000));
		// 60000/200000 = 30%
		const color = await page.evaluate(() => (window as any).getBarColor());
		expect(color).toContain("--primary");
	});

	test("color is amber/warning at 75-89%", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(120000, 30000, 200000));
		// 150000/200000 = 75%
		const color = await page.evaluate(() => (window as any).getBarColor());
		expect(color).toContain("--warning");
	});

	test("color is red/destructive at 90%+", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(150000, 35000, 200000));
		// 185000/200000 = 93%
		const color = await page.evaluate(() => (window as any).getBarColor());
		expect(color).toContain("--destructive");
	});

	test("tooltip shows 'Context: X / Y tokens (Z%)'", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(5000, 3000, 200000));
		// 8000/200000 = 4%
		const tooltip = await page.evaluate(() => (window as any).getTooltip());
		expect(tooltip).toBe("Context: 8.0k / 200k tokens (4%)");
	});

	test("tooltip formats small token counts without k suffix", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(500, 200, 200000));
		// 700 tokens
		const tooltip = await page.evaluate(() => (window as any).getTooltip());
		expect(tooltip).toBe("Context: 700 / 200k tokens (0%)");
	});

	test("tooltip formats mid-range token counts with decimal k", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(3000, 1500, 200000));
		// 4500 tokens → 4.5k
		const tooltip = await page.evaluate(() => (window as any).getTooltip());
		expect(tooltip).toBe("Context: 4.5k / 200k tokens (2%)");
	});

	test("stale state shows dash with 0% bar", async ({ page }) => {
		// Set some usage first, then go stale
		await page.evaluate(() => (window as any).setUsage(100000, 50000, 200000));
		await page.evaluate(() => (window as any).setStale(true));

		const width = await page.evaluate(() => (window as any).getBarWidth());
		expect(width).toBe("0%");
		const pct = await page.evaluate(() => (window as any).getPctText());
		expect(pct).toBe("—");
		const tooltip = await page.evaluate(() => (window as any).getTooltip());
		expect(tooltip).toContain("unknown");
	});

	test("bar width capped at 100% for overflow", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(180000, 50000, 200000));
		// 230000/200000 = 115% → capped to 100%
		const width = await page.evaluate(() => (window as any).getBarWidth());
		expect(width).toBe("100%");
	});

	test("boundary: exactly 75% shows warning color", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(100000, 50000, 200000));
		// 150000/200000 = 75%
		const color = await page.evaluate(() => (window as any).getBarColor());
		expect(color).toContain("--warning");
	});

	test("boundary: exactly 90% shows destructive color", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(130000, 50000, 200000));
		// 180000/200000 = 90%
		const color = await page.evaluate(() => (window as any).getBarColor());
		expect(color).toContain("--destructive");
	});

	test("no context bar when contextWindow is 0", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(5000, 3000, 0));
		const html = await page.evaluate(() => document.getElementById('context-area')!.innerHTML);
		expect(html).toBe("");
	});
});

test.describe("PI-18: Cost display", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("cost text shows formatted dollar amount", async ({ page }) => {
		await page.evaluate(() => (window as any).setCost(0.42));
		const text = await page.evaluate(() => (window as any).getCostText());
		expect(text).toBe("$0.4");
	});

	test("cost formats values >= $1 as whole numbers", async ({ page }) => {
		await page.evaluate(() => (window as any).setCost(3.7));
		const text = await page.evaluate(() => (window as any).getCostText());
		expect(text).toBe("$4");
	});

	test("cost formats zero-decimal values without trailing zero", async ({ page }) => {
		await page.evaluate(() => (window as any).setCost(0.01));
		const text = await page.evaluate(() => (window as any).getCostText());
		expect(text).toBe("$0");
	});

	test("no cost shown when value is 0", async ({ page }) => {
		await page.evaluate(() => (window as any).setCost(0));
		const text = await page.evaluate(() => (window as any).getCostText());
		expect(text).toBe("");
	});

	test("click toggles cost popover open", async ({ page }) => {
		await page.evaluate(() => (window as any).setCost(1.5));
		expect(await page.evaluate(() => (window as any).isPopoverOpen())).toBe(false);

		await page.click("#cost-area");
		expect(await page.evaluate(() => (window as any).isPopoverOpen())).toBe(true);
	});

	test("click again closes cost popover", async ({ page }) => {
		await page.evaluate(() => (window as any).setCost(1.5));

		await page.click("#cost-area");
		expect(await page.evaluate(() => (window as any).isPopoverOpen())).toBe(true);

		await page.click("#cost-area");
		expect(await page.evaluate(() => (window as any).isPopoverOpen())).toBe(false);
	});

	test("popover shows cost breakdown heading with total", async ({ page }) => {
		await page.evaluate(() => (window as any).setCost(2.5));
		await page.click("#cost-area");

		const popoverText = await page.evaluate(() =>
			document.getElementById('cost-popover')!.textContent
		);
		expect(popoverText).toContain("Cost Breakdown");
		expect(popoverText).toContain("$3"); // formatCost(2.5) = $3
	});
});

test.describe("PI-23: Stats bar overview", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("all stats render together: model, context bar, cost", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setModel('claude-sonnet-4-20250514');
			(window as any).setUsage(50000, 10000, 200000);
			(window as any).setCost(0.8);
		});

		// Model button
		const modelText = await page.evaluate(() =>
			document.getElementById('model-button')!.textContent
		);
		expect(modelText).toBe("claude-sonnet-4-20250514");

		// Context bar
		const pct = await page.evaluate(() => (window as any).getPctText());
		expect(pct).toBe("30%");

		// Cost
		const cost = await page.evaluate(() => (window as any).getCostText());
		expect(cost).toBe("$0.8");
	});

	test("stats update reactively when data changes", async ({ page }) => {
		// Initial state
		await page.evaluate(() => {
			(window as any).setUsage(10000, 5000, 200000);
			(window as any).setCost(0.1);
		});
		expect(await page.evaluate(() => (window as any).getPctText())).toBe("8%");
		expect(await page.evaluate(() => (window as any).getCostText())).toBe("$0.1");

		// Update usage — simulates new message arriving
		await page.evaluate(() => (window as any).setUsage(80000, 20000, 200000));
		expect(await page.evaluate(() => (window as any).getPctText())).toBe("50%");

		// Update cost
		await page.evaluate(() => (window as any).setCost(1.2));
		expect(await page.evaluate(() => (window as any).getCostText())).toBe("$1");
	});

	test("model change updates model button", async ({ page }) => {
		await page.evaluate(() => (window as any).setModel('gpt-4o'));
		const text = await page.evaluate(() =>
			document.getElementById('model-button')!.textContent
		);
		expect(text).toBe("gpt-4o");

		await page.evaluate(() => (window as any).setModel('claude-opus-4-20250514'));
		const text2 = await page.evaluate(() =>
			document.getElementById('model-button')!.textContent
		);
		expect(text2).toBe("claude-opus-4-20250514");
	});

	test("context bar transitions from normal to stale and back", async ({ page }) => {
		await page.evaluate(() => (window as any).setUsage(50000, 10000, 200000));
		expect(await page.evaluate(() => (window as any).getPctText())).toBe("30%");

		// Go stale (simulates compaction)
		await page.evaluate(() => (window as any).setStale(true));
		expect(await page.evaluate(() => (window as any).getPctText())).toBe("—");

		// New response arrives — back to normal
		await page.evaluate(() => (window as any).setUsage(30000, 8000, 200000));
		expect(await page.evaluate(() => (window as any).getPctText())).toBe("19%");
	});

	test("empty model hides model button", async ({ page }) => {
		await page.evaluate(() => (window as any).setModel(''));
		const btn = await page.evaluate(() => document.getElementById('model-button'));
		expect(btn).toBeNull();
	});
});
