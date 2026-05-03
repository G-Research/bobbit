/**
 * E2E test for PWA Resume v2 §E — static skeleton in index.html.
 *
 * Covers:
 *   1. Skeleton root `#bobbit-skeleton` exists in the initial HTML response
 *      (verifiable by JS-disabled context fetch).
 *   2. After the app finishes booting, the skeleton is hidden
 *      (display:none + hidden attr) and pointer-events is none.
 *   3. The inline `<style id="bobbit-skeleton-css">` block is < 1 kB gzipped.
 */
import { test, expect } from "../gateway-harness.js";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openApp } from "./ui-helpers.js";
import { base } from "../e2e-setup.js";

test.describe("PWA Resume v2 §E — static skeleton", () => {
	test("skeleton element exists in the served HTML response", async ({ request }) => {
		// Fetch the raw index HTML (no JS execution).
		const res = await request.get(`${base()}/`);
		expect(res.ok()).toBe(true);
		const html = await res.text();
		expect(html).toContain('id="bobbit-skeleton"');
		expect(html).toContain('id="bobbit-skeleton-css"');
		// Skeleton must be in <body> (not <head>) so it parses as DOM. The
		// app's main script is `type="module"` and therefore deferred, so
		// source order vs. the script tag does not matter — module scripts
		// run after the document is parsed regardless of placement (Vite
		// hoists them into <head>).
		const skeletonIdx = html.indexOf('id="bobbit-skeleton"');
		const bodyIdx = html.indexOf("<body");
		expect(skeletonIdx).toBeGreaterThan(0);
		expect(bodyIdx).toBeGreaterThan(0);
		expect(skeletonIdx).toBeGreaterThan(bodyIdx);
		// Confirm the bootstrap script is type="module" (deferred) so the
		// browser will paint the skeleton before executing app JS.
		expect(html).toMatch(/<script[^>]*type="module"/);
	});

	test("skeleton is hidden and pointer-events:none after first paint", async ({ page }) => {
		await openApp(page);
		// At this point Settings is visible — main.ts has hit markPaint("init:first-paint").
		const result = await page.evaluate(() => {
			const sk = document.getElementById("bobbit-skeleton");
			if (!sk) return { exists: false, display: "", pe: "", hidden: false };
			const cs = getComputedStyle(sk);
			return {
				exists: true,
				display: cs.display,
				pe: cs.pointerEvents,
				hidden: sk.hasAttribute("hidden"),
			};
		});
		expect(result.exists).toBe(true);
		expect(result.display).toBe("none");
		expect(result.pe).toBe("none");
		expect(result.hidden).toBe(true);
	});

	test("inline skeleton CSS block is < 1 kB gzipped", async () => {
		// Read source index.html (this test is unit-shaped but lives here to
		// keep §E coverage co-located).
		const path = resolve(process.cwd(), "index.html");
		const html = readFileSync(path, "utf8");
		const m = html.match(
			/<style id="bobbit-skeleton-css">([\s\S]*?)<\/style>/,
		);
		expect(m).not.toBeNull();
		const css = m![1];
		const gz = gzipSync(Buffer.from(css, "utf8")).length;
		expect(gz).toBeLessThan(1024);
	});
});
