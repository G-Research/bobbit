/**
 * Unit tests for Phase 2 Opt-H — virtualise eager-tail.
 *
 * Verifies that the `virtualiseTail` perf flag replaces the fixed
 * `DEFER_EAGER_TAIL = 8` eager-tail with a viewport-driven eager set:
 *   - flag ON, 200 fat assistant messages (~408px est-height each),
 *     800px viewport → eager set is 2–3 items (the bottom-most ones that
 *     fit in the viewport), the rest are placeholders.
 *   - flag ON, 5 messages whose total est-height fits in the viewport →
 *     every item is eager (short-transcript edge case).
 *   - flag OFF (Opt-A baseline) → the historical `DEFER_EAGER_TAIL = 8`
 *     fixed eager-tail is preserved, regardless of message size.
 *
 * Strict: when `virtualiseTail` is OFF the rendered DOM must match the
 * Opt-A baseline byte-for-byte (covered by the existing
 * `tests/defer-offscreen-render.spec.ts` — those tests still pass under
 * the new code path because OFF goes through the same constant tail).
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.ts";

const FIXTURE = path.resolve("tests/fixtures/virtualise-tail.html");
const BUNDLE = path.resolve("tests/fixtures/virtualise-tail-bundle.js");
const ENTRY = path.resolve("tests/fixtures/virtualise-tail-entry.ts");
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
	await page.waitForFunction(() => (window as any).__ready === true, null, {
		timeout: 10_000,
	});
	await page.evaluate(() => {
		const c = document.getElementById("container")!;
		c.innerHTML = '<div id="slot"></div>';
		try { localStorage.removeItem("bobbitPerfFlags"); } catch { /* swallow */ }
		(window as any).__reloadPerfFlags();
	});
}

test.describe("MessageList — virtualiseTail flag", () => {
	test("flag ON, 200 fat messages, 800px viewport → only viewport-fill eager", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setViewportHeight(800);
			(window as any).__setPerfFlag("deferOffscreenRender", true);
			(window as any).__setPerfFlag("virtualiseTail", true);
			(window as any).__mountMessageList("slot", { count: 200, kind: "fat" });
		});
		// 200 deferred-block wrappers, one per item.
		const deferred = await page.evaluate(() => (window as any).__countDeferred());
		expect(deferred).toBe(200);

		// Each fat assistant message is ~408px est-height. Viewport 800px →
		// cumulative-from-bottom: 408 (1) < 800; 816 (2) > 800. So 2 are eager,
		// the rest are placeholders.
		const eager = await page.evaluate(() => (window as any).__countAssistantMessages());
		const placeholders = await page.evaluate(() => (window as any).__countPlaceholders());
		expect(eager).toBe(2);
		expect(placeholders).toBe(198);
	});

	test("flag ON, short transcript (5 fat msgs) → all eager", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setViewportHeight(8000); // tall viewport, fits all
			(window as any).__setPerfFlag("deferOffscreenRender", true);
			(window as any).__setPerfFlag("virtualiseTail", true);
			(window as any).__mountMessageList("slot", { count: 5, kind: "fat" });
		});
		const deferred = await page.evaluate(() => (window as any).__countDeferred());
		expect(deferred).toBe(5);
		const placeholders = await page.evaluate(() => (window as any).__countPlaceholders());
		expect(placeholders).toBe(0);
		const eager = await page.evaluate(() => (window as any).__countAssistantMessages());
		expect(eager).toBe(5);
	});

	test("flag OFF (Opt-A baseline) → fixed eager-tail of 8 regardless of size", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setViewportHeight(800);
			(window as any).__setPerfFlag("deferOffscreenRender", true);
			(window as any).__setPerfFlag("virtualiseTail", false);
			(window as any).__mountMessageList("slot", { count: 200, kind: "fat" });
		});
		const deferred = await page.evaluate(() => (window as any).__countDeferred());
		expect(deferred).toBe(200);
		// Last 8 eager, the other 192 placeholders — byte-for-byte Opt-A.
		const eager = await page.evaluate(() => (window as any).__countAssistantMessages());
		expect(eager).toBe(8);
		const placeholders = await page.evaluate(() => (window as any).__countPlaceholders());
		expect(placeholders).toBe(192);
	});

	test("flag ON with single very tall message → that one message stays eager", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			// Viewport tiny so a single fat message (~408px) overflows it.
			(window as any).__setViewportHeight(100);
			(window as any).__setPerfFlag("deferOffscreenRender", true);
			(window as any).__setPerfFlag("virtualiseTail", true);
			(window as any).__mountMessageList("slot", { count: 10, kind: "fat" });
		});
		// At least the bottom-most item is always eager so the user sees
		// something at first paint even if a single message is taller than
		// the viewport.
		const eager = await page.evaluate(() => (window as any).__countAssistantMessages());
		expect(eager).toBeGreaterThanOrEqual(1);
		expect(eager).toBeLessThanOrEqual(2);
	});
});
