// ============================================================================
// Unit tests for cold-load nav spans (`nav.session.cold` / `nav.goal.cold`).
//
// The implementation lives in `src/app/main.ts::installColdNavObserver`. We
// extract that function's source from a fresh esbuild transpile of `main.ts`
// (no bundling — main.ts is wired into the whole UI graph, which other
// coders own concurrently) and `eval` it into the page context wired to the
// real `perf-trace` module. This exercises the production source without
// bundling main.ts's heavy dependency graph.
//
// File:// fixture style — runs in a real browser via Playwright.
// ============================================================================

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/perf-trace-cold-spans.html");
const BUNDLE = path.resolve("tests/fixtures/perf-trace-cold-spans-bundle.js");
const ENTRY = path.resolve("tests/fixtures/perf-trace-cold-spans-entry.ts");
const PERF_TRACE_TS = path.resolve("src/app/perf-trace.ts");
const MAIN_TS = path.resolve("src/app/main.ts");

let coldObserverSrc = "";

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(PERF_TRACE_TS).mtimeMs);
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

	// Transpile main.ts in isolation (no --bundle): we only want a JS string
	// with TypeScript stripped, not the full UI dependency graph. Then extract
	// the `installColdNavObserver` function block.
	const transpiled = execSync(
		[
			`npx esbuild ${MAIN_TS}`,
			"--target=es2022 --format=esm",
			"--tsconfig=tsconfig.web.json",
		].join(" "),
		{ stdio: ["ignore", "pipe", "pipe"] },
	).toString("utf8");

	const match = transpiled.match(
		/function installColdNavObserver\([\s\S]*?\n\}\s*\n(?=installColdNavObserver|\nfunction|\nconst|\nlet|\nvar|\nif|\nawait|\nexport)/,
	);
	if (!match) {
		throw new Error(
			"Could not extract installColdNavObserver from transpiled main.ts. " +
			"The function may have been renamed or removed — re-check src/app/main.ts.",
		);
	}
	coldObserverSrc = match[0];
});

const TEST_PAGE = `file://${FIXTURE}`;

// Helper: install the production observer source into the page, wired to the
// test's perf-trace module. Returns the page handle for chaining.
async function setupObserverInPage(page: import("@playwright/test").Page): Promise<void> {
	await page.goto(TEST_PAGE);
	await page.waitForFunction(() => (window as any).__ready === true);
	await page.evaluate((src) => {
		const pt = (window as any).__perfTrace;
		pt.setEnabled(true);
		pt.clear();
		// Wire up perfRecord / perfIsEnabled as the function expects, then
		// eval the production source so it captures the real impl.
		(window as any).perfRecord = pt.record;
		(window as any).perfIsEnabled = pt.isEnabled;
		// eslint-disable-next-line no-new-func
		const factory = new Function(
			"perfRecord", "perfIsEnabled",
			src + "\nreturn installColdNavObserver;",
		);
		(window as any).__installColdNavObserver = factory(pt.record, pt.isEnabled);
	}, coldObserverSrc);
}

test.describe("installColdNavObserver", () => {
	test.beforeEach(async ({ page }) => {
		await setupObserverInPage(page);
	});

	test("session sentinel emits nav.session.cold with positive duration", async ({ page }) => {
		const entry = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			const install = (window as any).__installColdNavObserver;
			const target = document.createElement("div");
			document.body.appendChild(target);
			const bootT0 = performance.now() - 25; // simulate 25ms since boot
			install(target, bootT0);
			await new Promise((r) => setTimeout(r, 1));
			target.setAttribute("data-perf-ready", "session");
			// MutationObserver delivers async — wait one task tick.
			await new Promise((r) => setTimeout(r, 5));
			document.body.removeChild(target);
			return pt.entries().find((e: any) => e.name === "nav.session.cold");
		});
		expect(entry).toBeTruthy();
		expect(entry.name).toBe("nav.session.cold");
		expect(entry.dur).toBeGreaterThan(0);
	});

	test("goal sentinel emits nav.goal.cold", async ({ page }) => {
		const entry = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			const install = (window as any).__installColdNavObserver;
			const target = document.createElement("div");
			document.body.appendChild(target);
			install(target, performance.now() - 10);
			await new Promise((r) => setTimeout(r, 1));
			target.setAttribute("data-perf-ready", "goal");
			await new Promise((r) => setTimeout(r, 5));
			document.body.removeChild(target);
			return pt.entries().find((e: any) => e.name === "nav.goal.cold");
		});
		expect(entry).toBeTruthy();
		expect(entry.name).toBe("nav.goal.cold");
		expect(entry.dur).toBeGreaterThan(0);
	});

	test("one-shot: subsequent attribute changes do not emit additional cold spans", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			const install = (window as any).__installColdNavObserver;
			const target = document.createElement("div");
			document.body.appendChild(target);
			install(target, performance.now() - 5);
			await new Promise((r) => setTimeout(r, 1));
			target.setAttribute("data-perf-ready", "session");
			await new Promise((r) => setTimeout(r, 5));
			target.setAttribute("data-perf-ready", "loading");
			await new Promise((r) => setTimeout(r, 5));
			target.setAttribute("data-perf-ready", "goal");
			await new Promise((r) => setTimeout(r, 5));
			target.setAttribute("data-perf-ready", "session");
			await new Promise((r) => setTimeout(r, 5));
			document.body.removeChild(target);
			return pt.entries()
				.map((e: any) => e.name)
				.filter((n: string) => n.startsWith("nav.") && n.endsWith(".cold"));
		});
		expect(result).toEqual(["nav.session.cold"]);
	});

	test("non-sentinel attribute values do not emit a cold span", async ({ page }) => {
		const cold = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			const install = (window as any).__installColdNavObserver;
			const target = document.createElement("div");
			document.body.appendChild(target);
			install(target, performance.now());
			await new Promise((r) => setTimeout(r, 1));
			target.setAttribute("data-perf-ready", "loading");
			await new Promise((r) => setTimeout(r, 5));
			target.setAttribute("data-perf-ready", "");
			await new Promise((r) => setTimeout(r, 5));
			document.body.removeChild(target);
			return pt.entries().map((e: any) => e.name).filter((n: string) => n.endsWith(".cold"));
		});
		expect(cold).toEqual([]);
	});

	test("attribute set BEFORE install: emits immediately and skips the observer", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			const install = (window as any).__installColdNavObserver;
			const target = document.createElement("div");
			target.setAttribute("data-perf-ready", "session");
			document.body.appendChild(target);
			install(target, performance.now() - 1);
			// No tick: synchronous emit when attribute is pre-set.
			const after = pt.entries().map((e: any) => e.name);
			target.setAttribute("data-perf-ready", "goal");
			await new Promise((r) => setTimeout(r, 5));
			const finalNames = pt.entries().map((e: any) => e.name);
			document.body.removeChild(target);
			return { after, finalNames };
		});
		expect(result.after).toEqual(["nav.session.cold"]);
		expect(result.finalNames).toEqual(["nav.session.cold"]);
	});

	test("returns no-op (no entry) when perf is disabled", async ({ page }) => {
		const cold = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			const install = (window as any).__installColdNavObserver;
			pt.setEnabled(false);
			pt.clear();
			const target = document.createElement("div");
			document.body.appendChild(target);
			install(target, performance.now() - 5);
			await new Promise((r) => setTimeout(r, 1));
			target.setAttribute("data-perf-ready", "session");
			await new Promise((r) => setTimeout(r, 5));
			document.body.removeChild(target);
			pt.setEnabled(true);
			return pt.entries().map((e: any) => e.name).filter((n: string) => n.endsWith(".cold"));
		});
		expect(cold).toEqual([]);
	});

	test("ignores null/undefined target gracefully and returns a disposer", async ({ page }) => {
		const ok = await page.evaluate(() => {
			const install = (window as any).__installColdNavObserver;
			const r1 = install(null, performance.now());
			const r2 = install(undefined, performance.now());
			return typeof r1 === "function" && typeof r2 === "function";
		});
		expect(ok).toBe(true);
	});

	test("sessionId from location.hash is captured in detail", async ({ page }) => {
		const detail = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			const install = (window as any).__installColdNavObserver;
			pt.clear();
			location.hash = "#/session/abc-123";
			const target = document.createElement("div");
			document.body.appendChild(target);
			install(target, performance.now() - 5);
			await new Promise((r) => setTimeout(r, 1));
			target.setAttribute("data-perf-ready", "session");
			await new Promise((r) => setTimeout(r, 5));
			document.body.removeChild(target);
			const entry = pt.entries().find((e: any) => e.name === "nav.session.cold");
			location.hash = "";
			return entry?.detail;
		});
		expect(detail).toEqual({ sessionId: "abc-123" });
	});

	test("goalId from location.hash is captured in detail", async ({ page }) => {
		const detail = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			const install = (window as any).__installColdNavObserver;
			pt.clear();
			location.hash = "#/goal/g-42";
			const target = document.createElement("div");
			document.body.appendChild(target);
			install(target, performance.now() - 5);
			await new Promise((r) => setTimeout(r, 1));
			target.setAttribute("data-perf-ready", "goal");
			await new Promise((r) => setTimeout(r, 5));
			document.body.removeChild(target);
			const entry = pt.entries().find((e: any) => e.name === "nav.goal.cold");
			location.hash = "";
			return entry?.detail;
		});
		expect(detail).toEqual({ goalId: "g-42" });
	});
});
