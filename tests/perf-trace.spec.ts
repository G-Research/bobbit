// ============================================================================
// Unit tests for src/app/perf-trace.ts
//
// File:// fixture style — bundled with esbuild, run in a real browser. The
// cost-when-disabled invariant requires a real JS engine and `performance.now`
// so this can't be a plain Node test.
// ============================================================================

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/perf-trace.html");
const BUNDLE = path.resolve("tests/fixtures/perf-trace-bundle.js");
const ENTRY = path.resolve("tests/fixtures/perf-trace-entry.ts");
const SOURCE = path.resolve("src/app/perf-trace.ts");

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

test.describe("perf-trace primitive", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true);
		// Default state: enabled = false; clear ring between tests.
		await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(false);
			pt.clear();
		});
	});

	test("enabled=false: entries() empty after spans", async ({ page }) => {
		const len = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.mark("foo");
			const h = pt.startSpan("bar");
			h.end();
			pt.measure("baz", () => 42);
			pt.record("qux", 5);
			return pt.entries().length;
		});
		expect(len).toBe(0);
	});

	test("enabled=false: startSpan returns shared no-op singleton (no per-call allocation)", async ({ page }) => {
		const same = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			const a = pt.startSpan("x");
			const b = pt.startSpan("y", { foo: 1 });
			const c = pt.startSpan("z");
			return a === b && b === c;
		});
		expect(same).toBe(true);
	});

	test("enabled=false: 100k startSpan calls produce no entries and no significant heap growth", async ({ page }) => {
		const { entries, heapGrowthMb } = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			const mem = (performance as any).memory;
			const before = mem ? mem.usedJSHeapSize : 0;
			for (let i = 0; i < 100_000; i++) {
				const h = pt.startSpan("noop");
				h.end();
			}
			const after = mem ? mem.usedJSHeapSize : 0;
			return {
				entries: pt.entries().length,
				heapGrowthMb: (after - before) / (1024 * 1024),
			};
		});
		expect(entries).toBe(0);
		// Negligible is generous — JIT artefacts can add a few MB. The point of
		// the test is to catch the failure mode where every call allocates a
		// fresh closure (which would balloon to tens or hundreds of MB).
		expect(heapGrowthMb).toBeLessThan(10);
	});

	test("enabled=true: spans recorded in order with positive durations", async ({ page }) => {
		const result = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			pt.clear();
			const a = pt.startSpan("a");
			a.end();
			const b = pt.startSpan("b");
			b.end();
			const c = pt.startSpan("c");
			c.end();
			return pt.entries().map((e: any) => ({ name: e.name, dur: e.dur }));
		});
		expect(result.map((r: any) => r.name)).toEqual(["a", "b", "c"]);
		for (const r of result) expect(r.dur).toBeGreaterThanOrEqual(0);
	});

	test("ring buffer drops oldest when full", async ({ page }) => {
		const names = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			pt.setRingSize(3); // also clears
			for (const n of ["a", "b", "c", "d", "e"]) {
				const h = pt.startSpan(n);
				h.end();
			}
			return pt.entries().map((e: any) => e.name);
		});
		expect(names).toEqual(["c", "d", "e"]);
	});

	test("measure propagates return value", async ({ page }) => {
		const v = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			pt.clear();
			return pt.measure("m", () => 7 * 6);
		});
		expect(v).toBe(42);
	});

	test("measure propagates synchronous exceptions and still records the span", async ({ page }) => {
		const result = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			pt.clear();
			let caught: string | null = null;
			try {
				pt.measure("boom", () => { throw new Error("nope"); });
			} catch (e: any) {
				caught = e.message;
			}
			return { caught, entries: pt.entries().map((e: any) => e.name) };
		});
		expect(result.caught).toBe("nope");
		expect(result.entries).toEqual(["boom"]);
	});

	test("measureAsync propagates promise resolution", async ({ page }) => {
		const v = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			pt.clear();
			return pt.measureAsync("async-ok", async () => {
				await new Promise((r) => setTimeout(r, 5));
				return "ok";
			});
		});
		expect(v).toBe("ok");
	});

	test("measureAsync propagates promise rejection and records span", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			pt.clear();
			let caught: string | null = null;
			try {
				await pt.measureAsync("async-fail", async () => { throw new Error("kaboom"); });
			} catch (e: any) {
				caught = e.message;
			}
			return { caught, entries: pt.entries().map((e: any) => e.name) };
		});
		expect(result.caught).toBe("kaboom");
		expect(result.entries).toEqual(["async-fail"]);
	});

	test("window.__bobbitPerf is exposed when enabled", async ({ page }) => {
		const keys = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			const w = (window as any).__bobbitPerf;
			return w ? Object.keys(w).sort() : null;
		});
		expect(keys).not.toBeNull();
		// Must include the surface specified in §2.1 of the design doc.
		for (const k of ["entries", "clear", "mark", "startSpan", "measure", "setEnabled", "setRingSize"]) {
			expect(keys).toContain(k);
		}
	});

	test("record stores duration without measuring", async ({ page }) => {
		const e = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			pt.clear();
			pt.record("from-elsewhere", 123.4, { source: "test" });
			return pt.entries();
		});
		expect(e.length).toBe(1);
		expect(e[0].name).toBe("from-elsewhere");
		expect(e[0].dur).toBeCloseTo(123.4, 1);
		expect(e[0].detail).toEqual({ source: "test" });
	});

	test("detail is merged from startSpan + end({extra})", async ({ page }) => {
		const detail = await page.evaluate(() => {
			const pt = (window as any).__perfTrace;
			pt.setEnabled(true);
			pt.clear();
			const h = pt.startSpan("merged", { a: 1, b: 2 });
			h.end({ b: 3, c: 4 });
			return pt.entries()[0].detail;
		});
		expect(detail).toEqual({ a: 1, b: 3, c: 4 });
	});
});
