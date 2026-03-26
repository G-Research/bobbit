import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/session-cache.html")}`;

test.describe("Session message cache", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		// Clear cache between tests
		await page.evaluate(() => (window as any).__cache.clearMessageCache());
	});

	test("cacheMessages stores and getCachedMessages retrieves correctly", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__cache;
			const msgs = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
			c.cacheMessages("s1", msgs);
			return c.getCachedMessages("s1");
		});
		expect(result).toEqual([{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
	});

	test("returns null for uncached sessions", async ({ page }) => {
		const result = await page.evaluate(() => {
			return (window as any).__cache.getCachedMessages("nonexistent");
		});
		expect(result).toBeNull();
	});

	test("evictCachedMessages removes entry", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__cache;
			c.cacheMessages("s1", [{ role: "user", content: "a" }]);
			c.evictCachedMessages("s1");
			return c.getCachedMessages("s1");
		});
		expect(result).toBeNull();
	});

	test("clearMessageCache removes all entries", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__cache;
			c.cacheMessages("s1", [{ content: "a" }]);
			c.cacheMessages("s2", [{ content: "b" }]);
			c.cacheMessages("s3", [{ content: "c" }]);
			c.clearMessageCache();
			return {
				size: c.getCacheSize(),
				s1: c.getCachedMessages("s1"),
				s2: c.getCachedMessages("s2"),
				s3: c.getCachedMessages("s3"),
			};
		});
		expect(result.size).toBe(0);
		expect(result.s1).toBeNull();
		expect(result.s2).toBeNull();
		expect(result.s3).toBeNull();
	});

	test("LRU eviction at 20-session limit evicts oldest first", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__cache;
			// Fill 20 sessions
			for (let i = 0; i < 20; i++) {
				c.cacheMessages(`s${i}`, [{ id: i }]);
			}
			// Add 21st — should evict s0 (oldest)
			c.cacheMessages("s20", [{ id: 20 }]);
			return {
				size: c.getCacheSize(),
				s0: c.getCachedMessages("s0"),
				s1: c.getCachedMessages("s1"),
				s20: c.getCachedMessages("s20"),
			};
		});
		expect(result.size).toBe(20);
		expect(result.s0).toBeNull(); // evicted
		expect(result.s1).toEqual([{ id: 1 }]); // still present
		expect(result.s20).toEqual([{ id: 20 }]); // newest
	});

	test("shallow copy: modifying returned array does not affect cache", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__cache;
			c.cacheMessages("s1", [{ role: "user", content: "original" }]);

			// Modify the returned array
			const retrieved = c.getCachedMessages("s1");
			retrieved.push({ role: "assistant", content: "injected" });
			retrieved[0].content = "mutated";

			// Re-retrieve — the pushed element should not be there
			const fresh = c.getCachedMessages("s1");
			return { length: fresh.length, firstContent: fresh[0].content };
		});
		// Array length unaffected (shallow copy prevents push from affecting cache)
		expect(result.length).toBe(1);
		// Note: shallow copy means the inner object IS shared — mutation of
		// object properties does propagate. This is by design (performance).
		// The key guarantee is that array structure is independent.
	});

	test("re-caching updates LRU order so entry is not evicted", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__cache;
			// Fill 20 sessions: s0..s19
			for (let i = 0; i < 20; i++) {
				c.cacheMessages(`s${i}`, [{ id: i }]);
			}
			// Re-cache s0 to bump it to most-recent
			c.cacheMessages("s0", [{ id: 0, bumped: true }]);
			// Add s20 — should evict s1 (now the oldest), NOT s0
			c.cacheMessages("s20", [{ id: 20 }]);
			return {
				size: c.getCacheSize(),
				s0: c.getCachedMessages("s0"),
				s1: c.getCachedMessages("s1"),
				s20: c.getCachedMessages("s20"),
			};
		});
		expect(result.size).toBe(20);
		expect(result.s0).toEqual([{ id: 0, bumped: true }]); // survived, updated
		expect(result.s1).toBeNull(); // evicted as the new oldest
		expect(result.s20).toEqual([{ id: 20 }]);
	});

	test("caching stores a copy — mutating source does not affect cache", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__cache;
			const original = [{ role: "user", content: "hello" }];
			c.cacheMessages("s1", original);
			// Mutate the source array
			original.push({ role: "assistant", content: "injected" });
			return c.getCachedMessages("s1");
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ role: "user", content: "hello" });
	});
});
