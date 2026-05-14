/**
 * Unit tests for Phase 2 Opt-A — defer off-screen transcript render.
 *
 * Covers:
 *   1. `<deferred-block eager>` renders the real template synchronously
 *      (no placeholder), so the perf-flag-OFF path is overhead-free.
 *   2. `<deferred-block>` (non-eager) renders a placeholder; on
 *      `IntersectionObserver` intersection, swaps in the real template via
 *      requestIdleCallback.
 *   3. `Ctrl+F` (and `DeferredBlock.forceResolveAll()`) resolve every live
 *      block immediately so native browser-find sees the full transcript.
 *   4. `<message-list>` with the `deferOffscreenRender` perf flag OFF emits
 *      NO `<deferred-block>` wrappers — the historical render path is
 *      preserved bit-for-bit.
 *   5. With the perf flag ON, `<message-list>` wraps every item in a
 *      `<deferred-block>`; the bottom tail (last 8) is eager, the rest are
 *      placeholders.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.ts";

const FIXTURE = path.resolve("tests/fixtures/defer-offscreen-render.html");
const BUNDLE = path.resolve("tests/fixtures/defer-offscreen-render-bundle.js");
const ENTRY = path.resolve("tests/fixtures/defer-offscreen-render-entry.ts");
const DEFERRED_SRC = path.resolve("src/ui/components/DeferredBlock.ts");
const MESSAGELIST_SRC = path.resolve("src/ui/components/MessageList.ts");
const PERFFLAGS_SRC = path.resolve("src/app/perf-flags.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, DEFERRED_SRC, MESSAGELIST_SRC, PERFFLAGS_SRC],
	});
	if (!fs.existsSync(BUNDLE)) throw new Error(`bundle missing: ${BUNDLE}`);
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.evaluate(() => {
		const c = document.getElementById("container")!;
		c.innerHTML = '<div id="slot"></div>';
		// Start each test with a clean flag set.
		try { localStorage.removeItem("bobbitPerfFlags"); } catch { /* swallow */ }
		(window as any).__reloadPerfFlags();
	});
}

test.describe("DeferredBlock — eager path", () => {
	test("eager=true renders real template immediately; no placeholder", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__mountDeferredBlock("slot", { eager: true, text: "HELLO" });
		});
		await expect(page.locator("deferred-block [data-real-content]")).toHaveCount(1);
		await expect(page.locator("deferred-block [data-real-content]")).toContainText("HELLO");
		await expect(page.locator(".deferred-block-placeholder")).toHaveCount(0);
	});
});

test.describe("DeferredBlock — defer path", () => {
	test("placeholder shown initially; resolves on intersection", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__mountDeferredBlock("slot", { eager: false, text: "LAZY" });
		});

		// Placeholder phase: min-height div present, no real content yet.
		await expect(page.locator("deferred-block .deferred-block-placeholder")).toHaveCount(1);
		await expect(page.locator("deferred-block [data-real-content]")).toHaveCount(0);

		// Drive intersection. The observer callback is registered in a
		// microtask after connectedCallback, so give it one tick.
		await page.evaluate(async () => {
			await new Promise((r) => queueMicrotask(() => r(null)));
			const ok = (window as any).__triggerIntersection("deferred-block", true);
			if (!ok) throw new Error("IO callback not registered on deferred-block");
		});

		await expect(page.locator("deferred-block [data-real-content]")).toContainText("LAZY");
		await expect(page.locator("deferred-block .deferred-block-placeholder")).toHaveCount(0);
	});

	test("Ctrl+F resolves all live placeholders", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const slot = document.getElementById("slot")!;
			slot.innerHTML = '<div id="a"></div><div id="b"></div><div id="c"></div>';
			(window as any).__mountDeferredBlock("a", { eager: false, text: "A" });
			(window as any).__mountDeferredBlock("b", { eager: false, text: "B" });
			(window as any).__mountDeferredBlock("c", { eager: false, text: "C" });
		});

		await expect(page.locator(".deferred-block-placeholder")).toHaveCount(3);
		await expect(page.locator("[data-real-content]")).toHaveCount(0);

		await page.evaluate(() => (window as any).__pressCtrlF());

		await expect(page.locator("[data-real-content]")).toHaveCount(3);
		await expect(page.locator(".deferred-block-placeholder")).toHaveCount(0);
	});

	test("forceResolveAll() resolves all live placeholders directly", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			const slot = document.getElementById("slot")!;
			slot.innerHTML = '<div id="a"></div><div id="b"></div>';
			(window as any).__mountDeferredBlock("a", { eager: false, text: "A" });
			(window as any).__mountDeferredBlock("b", { eager: false, text: "B" });
		});
		await expect(page.locator(".deferred-block-placeholder")).toHaveCount(2);
		await page.evaluate(() => (window as any).__forceResolveAll());
		await expect(page.locator("[data-real-content]")).toHaveCount(2);
	});
});

test.describe("MessageList — perf-flag gating", () => {
	test("flag OFF: no <deferred-block> wrappers (historical path preserved)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setPerfFlag("deferOffscreenRender", false);
			(window as any).__mountMessageList("slot", { count: 20 });
		});
		const deferred = await page.evaluate(() => (window as any).__countDeferred());
		expect(deferred).toBe(0);
		// All 20 user-messages render directly.
		await expect(page.locator("message-list user-message")).toHaveCount(20);
	});

	test("flag ON: every item wrapped; tail (last 8) eager, rest placeholders", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setPerfFlag("deferOffscreenRender", true);
			(window as any).__mountMessageList("slot", { count: 20 });
		});
		const deferred = await page.evaluate(() => (window as any).__countDeferred());
		expect(deferred).toBe(20);

		// The bottom 8 items are eager — they render their <user-message>
		// inline immediately. The other 12 are placeholders.
		const eager = await page.evaluate(() => (window as any).__countUserMessages());
		expect(eager).toBe(8);
		const placeholders = await page.evaluate(() => (window as any).__countPlaceholders());
		expect(placeholders).toBe(12);
	});

	test("flag ON with N <= tail size: every item renders eagerly", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setPerfFlag("deferOffscreenRender", true);
			(window as any).__mountMessageList("slot", { count: 5 });
		});
		// All 5 wrapped, all eager (no placeholders).
		const deferred = await page.evaluate(() => (window as any).__countDeferred());
		expect(deferred).toBe(5);
		const placeholders = await page.evaluate(() => (window as any).__countPlaceholders());
		expect(placeholders).toBe(0);
		await expect(page.locator("message-list user-message")).toHaveCount(5);
	});
});
