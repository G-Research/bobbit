import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/follow-tail.html");
const BUNDLE = path.resolve("tests/fixtures/follow-tail-bundle.js");
const ENTRY = path.resolve("tests/fixtures/follow-tail-entry.ts");
const SOURCE = path.resolve("src/app/follow-tail.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(SOURCE).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const TEST_PAGE = `file://${FIXTURE}`;

test.describe("follow-tail scroll preservation", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);
	});

	test("delta == 0 is a no-op (no scrollTop write)", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).__appendContent(20, 30);
			(window as any).__reconcile(); // initialize lock at bottom
			(window as any).__setScrollTopSpy();
			(window as any).__reconcile(); // delta=0
			(window as any).__reconcile();
		});
		const count = await page.evaluate(() => (window as any).__getScrollTopSetCount());
		expect(count).toBe(0);
	});

	test("stick-to-bottom on positive delta", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).__appendContent(20, 30);
			(window as any).__reconcile();
			// Now we're at bottom. Append more content and reconcile.
			(window as any).__appendContent(10, 30);
			(window as any).__reconcile();
		});
		const s = await page.evaluate(() => (window as any).__getScroll());
		expect(s.scrollHeight - s.scrollTop - s.clientHeight).toBeLessThan(5);
	});

	test("user wheel unsticks", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).__appendContent(20, 30);
			(window as any).__reconcile();
			const el = document.getElementById("scroll")!;
			el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
			(window as any).__scrollTo(50);
			el.dispatchEvent(new Event("scroll"));
			(window as any).__appendContent(10, 30);
			(window as any).__reconcile();
		});
		const s = await page.evaluate(() => (window as any).__getScroll());
		expect(s.scrollTop).toBeLessThan(100); // didn't snap to bottom
	});

	test("user touchstart unsticks", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).__appendContent(20, 30);
			(window as any).__reconcile();
			const el = document.getElementById("scroll")!;
			el.dispatchEvent(new Event("touchstart"));
			(window as any).__scrollTo(50);
			el.dispatchEvent(new Event("scroll"));
			(window as any).__appendContent(10, 30);
			(window as any).__reconcile();
		});
		const s = await page.evaluate(() => (window as any).__getScroll());
		expect(s.scrollTop).toBeLessThan(100);
	});

	test("PageUp / ArrowUp keys unstick", async ({ page }) => {
		for (const key of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]) {
			await page.evaluate((k) => {
				const c = document.getElementById("content")!;
				while (c.firstChild) c.removeChild(c.firstChild);
				(window as any).__appendContent(20, 30);
				(window as any).__reconcile();
				const el = document.getElementById("scroll")!;
				el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
				(window as any).__scrollTo(50);
				(window as any).__appendContent(10, 30);
				(window as any).__reconcile();
			}, key);
			const s = await page.evaluate(() => (window as any).__getScroll());
			expect(s.scrollTop, `key=${key}`).toBeLessThan(100);
		}
	});

	test("5px tail tolerance keeps stickToBottom", async ({ page }) => {
		const stayed = await page.evaluate(() => {
			(window as any).__appendContent(20, 30);
			(window as any).__reconcile();
			const el = document.getElementById("scroll")!;
			// Position 4px above bottom (within tail).
			el.scrollTop = el.scrollHeight - el.clientHeight - 4;
			el.dispatchEvent(new Event("scroll"));
			// Now grow content; if we were still sticky we should snap to bottom.
			(window as any).__appendContent(5, 30);
			(window as any).__reconcile();
			return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
		});
		expect(stayed).toBe(true);
	});

	test("5px tail miss unsticks", async ({ page }) => {
		const stuck = await page.evaluate(() => {
			(window as any).__appendContent(20, 30);
			(window as any).__reconcile();
			const el = document.getElementById("scroll")!;
			el.scrollTop = el.scrollHeight - el.clientHeight - 20;
			el.dispatchEvent(new Event("scroll"));
			(window as any).__appendContent(5, 30);
			(window as any).__reconcile();
			return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
		});
		expect(stuck).toBe(false);
	});

	test("programmatic-scroll echo does NOT flip stickToBottom", async ({ page }) => {
		// Append, reconcile (programmatic scroll to bottom). The synthetic scroll
		// event is consumed by the latch — stickToBottom should remain true.
		const ok = await page.evaluate(async () => {
			(window as any).__appendContent(20, 30);
			(window as any).__reconcile();
			(window as any).__appendContent(10, 30);
			(window as any).__reconcile(); // programmatic scroll fires
			// Wait one tick for the synthetic scroll event handler.
			await new Promise((r) => setTimeout(r, 20));
			// Now grow more — if stickToBottom is still true, we'll snap to bottom.
			(window as any).__appendContent(10, 30);
			(window as any).__reconcile();
			const el = document.getElementById("scroll")!;
			return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
		});
		expect(ok).toBe(true);
	});

	test("textarea selection preservation across .value rewrite", async ({ page }) => {
		const sel = await page.evaluate(async () => {
			const ta = document.getElementById("ta") as HTMLTextAreaElement;
			ta.value = "Hello world this is a test of selection preservation logic okay";
			(window as any).__reconcileTa(); // attach listeners
			ta.focus();
			ta.setSelectionRange(20, 30);
			ta.dispatchEvent(new Event("keyup"));
			// Lit-style rewrite: change value, reconcile.
			ta.value = ta.value + " more content appended at the end here";
			(window as any).__reconcileTa();
			return { start: ta.selectionStart, end: ta.selectionEnd };
		});
		expect(sel.start).toBe(20);
		expect(sel.end).toBe(30);
	});
});
