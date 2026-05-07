/**
 * Browser E2E for the sidebar font-size setting.
 *
 * Covers: Appearance subheader render, slider \u2192 sidebar root computed size
 * scaling, child element ratio preservation, persistence across reload (no
 * FOUC), Reset, and the chat-transcript invariant (unaffected).
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const SCALE_KEY = "bobbit:sidebar-font-scale";

test.describe("Sidebar font scale (full-stack UI)", () => {
	test.beforeEach(async ({ page }) => {
		// Start each test from a clean baseline so we don't inherit a stale
		// scale from a previous test.
		await openApp(page);
		await page.evaluate((k) => localStorage.removeItem(k), SCALE_KEY);
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
	});

	test("Appearance subheader and control render in System \u2192 General @smoke", async ({ page }) => {
		await navigateToHash(page, "#/settings/system/general");

		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='general-appearance-heading']")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator("[data-testid='sidebar-font-scale-slider']")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Default");
		await expect(page.locator("[data-testid='sidebar-font-scale-reset']")).toBeVisible();
	});

	test("moving slider to Largest scales the sidebar root proportionally; Reset restores baseline", async ({ page }) => {
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("[data-testid='sidebar-font-scale-slider']")).toBeVisible({ timeout: 10_000 });

		// Helper to read the computed font-size of the sidebar root and a known
		// non-12px child-text element inside it. We sample any element with an
		// inline `font-size: ...em` style \u2014 those are the converted hard-coded
		// sizes that depend on the sidebar root inheriting our scaled base.
		const measure = async () => {
			return await page.evaluate(() => {
				const root = document.querySelector("[data-testid='sidebar-expanded']") as HTMLElement | null;
				if (!root) return null;
				const rootSize = parseFloat(getComputedStyle(root).fontSize);
				// Find any descendant whose inline style sets font-size in em.
				const emChild = Array.from(root.querySelectorAll<HTMLElement>("[style*='font-size'][style*='em']"))[0];
				const emChildSize = emChild ? parseFloat(getComputedStyle(emChild).fontSize) : null;
				const cssVar = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-font-scale").trim();
				return { rootSize, emChildSize, cssVar };
			});
		};

		const baseline = await measure();
		expect(baseline).not.toBeNull();
		expect(baseline!.rootSize).toBeGreaterThan(0);
		expect(baseline!.cssVar).toBe("1");
		// Default sidebar base is 12 px.
		expect(Math.round(baseline!.rootSize)).toBe(12);
		const baselineChild = baseline!.emChildSize!;
		expect(baselineChild).toBeGreaterThan(0);

		// Move slider to Largest (index 4 \u2192 multiplier 1.22).
		const slider = page.locator("[data-testid='sidebar-font-scale-slider']");
		await slider.evaluate((el: HTMLInputElement) => {
			el.value = "4";
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Largest");

		const scaled = await measure();
		expect(scaled).not.toBeNull();
		expect(parseFloat(scaled!.cssVar)).toBeCloseTo(1.22, 2);
		// Sidebar root grew by the scale factor.
		expect(scaled!.rootSize).toBeGreaterThan(baseline!.rootSize);
		expect(scaled!.rootSize / baseline!.rootSize).toBeCloseTo(1.22, 1);
		// The em-relative child grew by the same ratio (\u00b1 0.05 to absorb sub-pixel rounding).
		expect(scaled!.emChildSize! / baselineChild).toBeCloseTo(1.22, 1);

		// Click Reset.
		await page.locator("[data-testid='sidebar-font-scale-reset']").click();
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Default");
		const reset = await measure();
		expect(parseFloat(reset!.cssVar)).toBeCloseTo(1.0, 2);
		expect(Math.round(reset!.rootSize)).toBe(12);
	});

	test("scale persists across full reload with no FOUC", async ({ page }) => {
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("[data-testid='sidebar-font-scale-slider']")).toBeVisible({ timeout: 10_000 });

		// Set Largest.
		await page.locator("[data-testid='sidebar-font-scale-slider']").evaluate((el: HTMLInputElement) => {
			el.value = "4";
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Largest");

		// Confirm written to localStorage.
		const persisted = await page.evaluate((k) => localStorage.getItem(k), SCALE_KEY);
		expect(parseFloat(persisted ?? "")).toBeCloseTo(1.22, 2);

		// Reload \u2014 the CSS variable must already reflect the saved scale on the
		// very first paint (state.ts module load). We assert by reading the CSS
		// variable immediately after reload completes; a non-persisted setting
		// would land back on "1".
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });

		const cssVarAfterReload = await page.evaluate(
			() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-font-scale").trim(),
		);
		expect(parseFloat(cssVarAfterReload)).toBeCloseTo(1.22, 2);

		// Slider state also survives the round-trip.
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Largest", { timeout: 5_000 });
		const sliderValue = await page.locator("[data-testid='sidebar-font-scale-slider']").inputValue();
		expect(sliderValue).toBe("4");
	});

	test("activity dot is exactly 6px at Default scale (no nested em compounding)", async ({ page }) => {
		// Inject a synthetic activity-dot inside the expanded sidebar so the test
		// is independent of whether any session has unseen activity. We mirror the
		// production markup exactly: a parent span with `font-size: 0.9167em` and
		// a child dot using the calc() expression we just installed.
		await page.evaluate(() => {
			const root = document.querySelector("[data-testid='sidebar-expanded']") as HTMLElement | null;
			if (!root) throw new Error("sidebar-expanded missing");
			const parent = document.createElement("span");
			parent.setAttribute("data-testid", "test-dot-parent");
			parent.style.fontSize = "0.9167em";
			const dot = document.createElement("span");
			dot.setAttribute("data-testid", "test-activity-dot");
			dot.style.fontSize = "calc(0.375rem * var(--sidebar-font-scale, 1))";
			dot.style.lineHeight = "1";
			dot.textContent = "\u25cf";
			parent.appendChild(dot);
			root.appendChild(parent);
		});

		const dotSize = await page.locator("[data-testid='test-activity-dot']").evaluate(
			(el) => parseFloat(getComputedStyle(el).fontSize),
		);
		// Acceptance criterion 5: pixel-for-pixel default. Allow 0.5 px tolerance
		// for sub-pixel rounding across browser engines.
		expect(dotSize).toBeGreaterThan(5.5);
		expect(dotSize).toBeLessThan(6.5);

		// And it scales with the slider, not against it.
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("[data-testid='sidebar-font-scale-slider']")).toBeVisible({ timeout: 10_000 });
		await page.locator("[data-testid='sidebar-font-scale-slider']").evaluate((el: HTMLInputElement) => {
			el.value = "4";
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Largest");
		// The synthetic node may not survive a re-render that wipes the sidebar
		// subtree, so re-inject if it's gone.
		const stillThere = await page.locator("[data-testid='test-activity-dot']").count();
		if (stillThere === 0) {
			await page.evaluate(() => {
				const root = document.querySelector("[data-testid='sidebar-expanded']") as HTMLElement | null;
				if (!root) return;
				const parent = document.createElement("span");
				parent.setAttribute("data-testid", "test-dot-parent");
				parent.style.fontSize = "0.9167em";
				const dot = document.createElement("span");
				dot.setAttribute("data-testid", "test-activity-dot");
				dot.style.fontSize = "calc(0.375rem * var(--sidebar-font-scale, 1))";
				dot.style.lineHeight = "1";
				dot.textContent = "\u25cf";
				parent.appendChild(dot);
				root.appendChild(parent);
			});
		}
		const scaledDot = await page.locator("[data-testid='test-activity-dot']").evaluate(
			(el) => parseFloat(getComputedStyle(el).fontSize),
		);
		expect(scaledDot / dotSize).toBeCloseTo(1.22, 1);
	});

	test("mobile sidebar text-sm element scales with the slider", async ({ page }) => {
		// Switch to mobile viewport. The mobile landing renders a different DOM
		// tree wrapped in `.sidebar-root`. Its tab strip used `text-sm` Tailwind
		// classes that the conversion replaced with `font-size: 1.1667em` so they
		// inherit the scaled base.
		await page.setViewportSize({ width: 375, height: 667 });
		await page.reload();
		// The mobile Roles tab is a stable always-rendered hook in the mobile
		// sidebar tab strip.
		const rolesBtn = page.locator("button").filter({ hasText: /^\s*Roles\s*$/ }).first();
		await expect(rolesBtn).toBeVisible({ timeout: 15_000 });

		// Sanity: it lives inside a sidebar-root container.
		const inSidebarRoot = await rolesBtn.evaluate((el) => !!el.closest(".sidebar-root"));
		expect(inSidebarRoot).toBe(true);

		const baseline = await rolesBtn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(baseline).toBeGreaterThan(0);

		// Drive the scale change via localStorage + the same applier the slider
		// would use, then re-render. We avoid navigating to the settings page
		// because on mobile the app may swap routes and unmount the tab strip.
		await page.evaluate(([key, val]) => {
			localStorage.setItem(key as string, String(val));
			document.documentElement.style.setProperty("--sidebar-font-scale", String(val));
		}, [SCALE_KEY, 1.22]);

		const scaled = await rolesBtn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(scaled).toBeGreaterThan(baseline);
		expect(scaled / baseline).toBeCloseTo(1.22, 1);
	});

	test("chat transcript root font-size is unaffected by sidebar scale", async ({ page }) => {
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.locator("[data-testid='sidebar-font-scale-slider']")).toBeVisible({ timeout: 10_000 });

		// Pick a stable, always-rendered chat-area target. The header h1 lives in
		// the main pane outside the sidebar, so it is the cleanest "untouched"
		// witness that does not require a session to exist.
		const chatRefSelector = "h1";
		const baselineChat = await page.locator(chatRefSelector).first().evaluate(
			(el) => parseFloat(getComputedStyle(el).fontSize),
		);

		// Crank scale to Largest.
		await page.locator("[data-testid='sidebar-font-scale-slider']").evaluate((el: HTMLInputElement) => {
			el.value = "4";
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Largest");

		const afterChat = await page.locator(chatRefSelector).first().evaluate(
			(el) => parseFloat(getComputedStyle(el).fontSize),
		);
		expect(afterChat).toBeCloseTo(baselineChat, 1);

		// And to Smallest \u2014 still unchanged.
		await page.locator("[data-testid='sidebar-font-scale-slider']").evaluate((el: HTMLInputElement) => {
			el.value = "0";
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await expect(page.locator("[data-testid='sidebar-font-scale-label']")).toHaveText("Smallest");

		const afterSmallChat = await page.locator(chatRefSelector).first().evaluate(
			(el) => parseFloat(getComputedStyle(el).fontSize),
		);
		expect(afterSmallChat).toBeCloseTo(baselineChat, 1);
	});
});
