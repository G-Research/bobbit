/**
 * Unit tests for Phase 2 Opt-G — defer syntax highlighting.
 *
 * Covers:
 *   1. Flag OFF: `codeBlock(...)` emits `<code-block>` directly, no
 *      `<deferred-code-block>` wrapper (historical path preserved).
 *   2. Flag ON: emits `<deferred-code-block>` which renders a plain
 *      placeholder `<pre data-pending-highlight>` synchronously; the
 *      real `<code-block>` only mounts after an idle callback fires.
 *   3. The placeholder text content equals the source code (so
 *      browser-find / a11y tools see the code immediately).
 *   4. Disconnecting the element before idle fires cancels the upgrade
 *      cleanly (no late upgrade against a detached host).
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.ts";

const FIXTURE = path.resolve("tests/fixtures/defer-syntax-highlight.html");
const BUNDLE = path.resolve("tests/fixtures/defer-syntax-highlight-bundle.js");
const ENTRY = path.resolve("tests/fixtures/defer-syntax-highlight-entry.ts");
const SRC = path.resolve("src/ui/components/syntax-highlight.ts");
const PERFFLAGS_SRC = path.resolve("src/app/perf-flags.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SRC, PERFFLAGS_SRC],
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
		try { localStorage.removeItem("bobbitPerfFlags"); } catch { /* swallow */ }
		(window as any).__reloadPerfFlags();
	});
}

test.describe("codeBlock — flag OFF (default)", () => {
	test("emits <code-block> directly, no wrapper", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__mountCodeBlock("slot", "const x = 1;", "javascript");
		});
		// No wrapper element. The real <code-block> stub renders and gets the
		// `data-real-code-block` marker on connectedCallback.
		expect(await page.evaluate(() => (window as any).__countDeferred())).toBe(0);
		expect(await page.evaluate(() => (window as any).__countCodeBlock())).toBe(1);
		expect(await page.evaluate(() => (window as any).__countPending())).toBe(0);
	});
});

test.describe("codeBlock — flag ON", () => {
	test("placeholder synchronous, real <code-block> arrives on idle", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setPerfFlag("deferSyntaxHighlight", true);
			(window as any).__mountCodeBlock("slot", "const x = 1;", "javascript");
		});

		// Phase 1 (synchronous): wrapper present, placeholder pre rendered,
		// no real <code-block> yet.
		expect(await page.evaluate(() => (window as any).__countDeferred())).toBe(1);
		expect(await page.evaluate(() => (window as any).__countPending())).toBe(1);
		expect(await page.evaluate(() => (window as any).__countCodeBlock())).toBe(0);

		// Placeholder visible source text matches the code — browser-find /
		// a11y can already see it.
		const text = await page.locator("[data-pending-highlight]").textContent();
		expect(text).toBe("const x = 1;");

		// Phase 2 (after idle): upgrade to <code-block>.
		await page.evaluate(() => (window as any).__idleFlush());
		await expect(page.locator("code-block[data-real-code-block]")).toHaveCount(1);
		expect(await page.evaluate(() => (window as any).__countPending())).toBe(0);
	});

	test("placeholder carries the language as a marker attribute", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setPerfFlag("deferSyntaxHighlight", true);
			(window as any).__mountCodeBlock("slot", "<html></html>", "html");
		});
		const lang = await page.locator("[data-pending-highlight]").getAttribute("data-pending-highlight");
		expect(lang).toBe("html");
		// hljs class hook present so the eventual upgrade swaps inside the
		// same visual envelope.
		await expect(page.locator("pre.hljs.language-html")).toHaveCount(1);
	});

	test("disconnect before idle cancels upgrade — no late <code-block>", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setPerfFlag("deferSyntaxHighlight", true);
			(window as any).__mountCodeBlock("slot", "x", "text");
			// Tear the host out before flushing idle work.
			const slot = document.getElementById("slot")!;
			slot.innerHTML = "";
		});
		await page.evaluate(() => (window as any).__idleFlush());
		expect(await page.evaluate(() => (window as any).__countDeferred())).toBe(0);
		expect(await page.evaluate(() => (window as any).__countCodeBlock())).toBe(0);
	});
});
