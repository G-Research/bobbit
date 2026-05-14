// ============================================================================
// Phase 2C — prefetch-on-hover cache behaviour.
//
// Drives the helpers from a file:// fixture with a stubbed `window.fetch`
// that counts calls per URL. Verifies:
//   - hover triggers a single fetch (debounce coalesces rapid repeats)
//   - subsequent gatewayFetch() consumes the cached promise → 0 extra
//     network calls
//   - cache is single-use (a second gatewayFetch falls through)
//   - flag off ⇒ no prefetch occurs
//   - cache is bounded at PREFETCH_MAX_ENTRIES
//   - entries older than PREFETCH_TTL_MS are evicted on read
//   - non-GET requests bypass the prefetch cache
// ============================================================================
import { test, expect } from "@playwright/test";
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/prefetch-on-hover.html");
const BUNDLE = path.resolve("tests/fixtures/prefetch-on-hover-bundle.js");
const ENTRY = path.resolve("tests/fixtures/prefetch-on-hover-entry.ts");
const API_SRC = path.resolve("src/app/api.ts");
const FLAGS_SRC = path.resolve("src/app/perf-flags.ts");

test.beforeAll(async () => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(API_SRC).mtimeMs,
		fs.statSync(FLAGS_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		await esbuild.build({
			entryPoints: [ENTRY],
			bundle: true,
			format: "iife",
			target: "es2022",
			outfile: BUNDLE,
			tsconfig: "tsconfig.web.json",
			define: { "import.meta.url": '"http://localhost/"' },
			loader: { ".ts": "ts" },
			logLevel: "silent",
		});
	}
});

const PAGE = `file://${FIXTURE}`;

test.describe("prefetch-on-hover cache", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(PAGE);
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 15_000 });
		// Clean state per test.
		await page.evaluate(() => {
			const pf: any = (window as any).__prefetch;
			pf.resetCache();
			pf.setPerfFlag("prefetchOnHover", true);
			pf.reloadPerfFlags();
			(window as any).__fetchCounts = {};
		});
	});

	test("flag off — prefetchUrl is a no-op", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			pf.setPerfFlag("prefetchOnHover", false);
			pf.reloadPerfFlags();
			pf.prefetchSession("abc");
			pf.prefetchGoal("xyz");
			await new Promise((r) => setTimeout(r, 10));
			return { cacheSize: pf.cacheSize(), counts: { ...(window as any).__fetchCounts } };
		});
		expect(result.cacheSize).toBe(0);
		expect(Object.values(result.counts).reduce((a: number, b: any) => a + (b as number), 0)).toBe(0);
	});

	test("hover triggers exactly one fetch, debounce coalesces repeats", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			// Three rapid hovers within the debounce window → one fetch.
			pf.prefetchSession("s1");
			pf.prefetchSession("s1");
			pf.prefetchSession("s1");
			await new Promise((r) => setTimeout(r, 10));
			return { counts: { ...(window as any).__fetchCounts }, cacheSize: pf.cacheSize() };
		});
		const sessionUrls = Object.keys(result.counts).filter((u) => u.endsWith("/api/sessions/s1"));
		expect(sessionUrls).toHaveLength(1);
		expect(result.counts[sessionUrls[0]]).toBe(1);
		expect(result.cacheSize).toBe(1);
	});

	test("subsequent gatewayFetch consumes cached promise (no second network call)", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			pf.prefetchSession("s2");
			// Yield once so the prefetch fetch resolves before consume.
			await new Promise((r) => setTimeout(r, 5));
			const res = await pf.gatewayFetch("/api/sessions/s2");
			const body = await res.json();
			return {
				counts: { ...(window as any).__fetchCounts },
				body,
				cacheSizeAfter: pf.cacheSize(),
			};
		});
		const sessionUrls = Object.keys(result.counts).filter((u) => u.endsWith("/api/sessions/s2"));
		expect(sessionUrls).toHaveLength(1);
		expect(result.counts[sessionUrls[0]]).toBe(1);
		expect(result.body.url).toContain("/api/sessions/s2");
		// Cache is single-use — consume removed the entry.
		expect(result.cacheSizeAfter).toBe(0);
	});

	test("cache is single-use — a second gatewayFetch falls through to a fresh fetch", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			pf.prefetchSession("s3");
			await new Promise((r) => setTimeout(r, 5));
			await pf.gatewayFetch("/api/sessions/s3");
			await pf.gatewayFetch("/api/sessions/s3");
			return { counts: { ...(window as any).__fetchCounts } };
		});
		const sessionUrls = Object.keys(result.counts).filter((u) => u.endsWith("/api/sessions/s3"));
		expect(sessionUrls).toHaveLength(1);
		// Prefetch (1) + second uncached gatewayFetch (1) = 2 network calls.
		expect(result.counts[sessionUrls[0]]).toBe(2);
	});

	test("non-GET bypasses the prefetch cache", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			pf.prefetchSession("s4");
			await new Promise((r) => setTimeout(r, 5));
			await pf.gatewayFetch("/api/sessions/s4", { method: "DELETE" });
			return {
				counts: { ...(window as any).__fetchCounts },
				cacheSize: pf.cacheSize(),
			};
		});
		const sessionUrls = Object.keys(result.counts).filter((u) => u.endsWith("/api/sessions/s4"));
		expect(sessionUrls).toHaveLength(1);
		// Prefetch GET (1) + DELETE (1) = 2 network calls. Cache entry remains.
		expect(result.counts[sessionUrls[0]]).toBe(2);
		expect(result.cacheSize).toBe(1);
	});

	test("cache is bounded at PREFETCH_MAX_ENTRIES", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			const max: number = pf.PREFETCH_MAX_ENTRIES;
			for (let i = 0; i < max + 5; i++) pf.prefetchSession(`bulk-${i}`);
			await new Promise((r) => setTimeout(r, 5));
			return { max, cacheSize: pf.cacheSize() };
		});
		expect(result.cacheSize).toBe(result.max);
	});

	test("stale entries (>TTL) evicted on prefetch and not returned on consume", async ({ page }) => {
		// Stub performance.now/Date so we can time-travel past the TTL without
		// actually sleeping for 30s.
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			const ttl: number = pf.PREFETCH_TTL_MS;
			const originalNow = performance.now.bind(performance);
			let offset = 0;
			(performance as any).now = () => originalNow() + offset;
			try {
				pf.prefetchSession("stale");
				await new Promise((r) => setTimeout(r, 5));
				// Time-travel past TTL.
				offset = ttl + 1000;
				// Consume — should return null (fall through), causing a fresh fetch.
				const res = await pf.gatewayFetch("/api/sessions/stale");
				await res.json();
				return {
					counts: { ...(window as any).__fetchCounts },
				};
			} finally {
				(performance as any).now = originalNow;
			}
		});
		const sessionUrls = Object.keys(result.counts).filter((u) => u.endsWith("/api/sessions/stale"));
		expect(sessionUrls).toHaveLength(1);
		// Prefetch (1) + uncached fetch after stale (1) = 2 network calls.
		expect(result.counts[sessionUrls[0]]).toBe(2);
	});

	test("prefetchGoal hits /api/goals/:id", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			pf.prefetchGoal("g1");
			await new Promise((r) => setTimeout(r, 5));
			return { counts: { ...(window as any).__fetchCounts } };
		});
		const goalUrls = Object.keys(result.counts).filter((u) => u.endsWith("/api/goals/g1"));
		expect(goalUrls).toHaveLength(1);
		expect(result.counts[goalUrls[0]]).toBe(1);
	});

	test("prefetch failures are swallowed and clear the cache entry", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const pf: any = (window as any).__prefetch;
			// Swap fetch to reject.
			const stub = (window as any).__stubFetch;
			window.fetch = (() => Promise.reject(new Error("network down"))) as any;
			pf.prefetchSession("err");
			// Wait for the rejection to settle.
			await new Promise((r) => setTimeout(r, 20));
			const sizeAfterReject = pf.cacheSize();
			// Restore the counted stub so the consume path can fetch.
			window.fetch = stub;
			(window as any).__fetchCounts = {};
			const res = await pf.gatewayFetch("/api/sessions/err");
			await res.json();
			return {
				sizeAfterReject,
				counts: { ...(window as any).__fetchCounts },
			};
		});
		// Failure removed the cache entry.
		expect(result.sizeAfterReject).toBe(0);
		// The follow-up gatewayFetch hit the network (uncached) exactly once.
		const urls = Object.keys(result.counts).filter((u) => u.endsWith("/api/sessions/err"));
		expect(urls).toHaveLength(1);
		expect(result.counts[urls[0]]).toBe(1);
	});
});
