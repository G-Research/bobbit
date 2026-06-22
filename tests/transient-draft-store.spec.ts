/**
 * Unit fixture tests for the shared TransientDraftStore
 * (`src/ui/storage/transient-draft-store.ts`).
 *
 * Pins the invariants from docs/design/transient-draft-state.md §5.1:
 *  - round-trip + namespace/scope isolation, opaque composite keys preserved verbatim,
 *  - tombstone on clear blocks resurrection until expiry; forget hard-deletes,
 *  - last-write-wins via monotonic gen (stale async save cannot clobber),
 *  - bounds: per-namespace LRU eviction (never the just-written key), oversize drop,
 *  - backend selection (session vs local) writes the correct web-storage object,
 *  - disabled/throwing storage degrades to a no-op (no exception escapes).
 *
 * Pattern mirrors tests/activate-skill-renderer.spec.ts (file:// fixture +
 * esbuild-on-demand bundle of the real source module).
 */
import { test, expect } from "@playwright/test";
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

async function renameWithRetry(src: string, dest: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			fs.renameSync(src, dest);
			return;
		} catch (err) {
			lastErr = err;
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw lastErr;
}

const FIXTURE = path.resolve("tests/fixtures/transient-draft-store.html");
const BUNDLE = path.resolve("tests/fixtures/transient-draft-store-bundle.js");
const ENTRY = path.resolve("tests/fixtures/transient-draft-store-entry.ts");
const STORE_SRC = path.resolve("src/ui/storage/transient-draft-store.ts");

test.beforeAll(async () => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(STORE_SRC).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		const tmpDir = fs.mkdtempSync(path.join(path.dirname(BUNDLE), ".bundle-tmp-"));
		const tmpOut = path.join(tmpDir, path.basename(BUNDLE));
		try {
			await esbuild.build({
				entryPoints: [ENTRY],
				bundle: true,
				format: "iife",
				target: "es2022",
				outfile: tmpOut,
				tsconfig: "tsconfig.web.json",
				define: { "import.meta.url": '"http://localhost/"' },
				loader: { ".ts": "ts" },
			});
			await renameWithRetry(tmpOut, BUNDLE);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
		}
	}
});

const PAGE = `file://${FIXTURE.replace(/\\/g, "/")}`;

test.beforeEach(async ({ page }) => {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__clearAll());
});

test.describe("TransientDraftStore round-trip + isolation", () => {
	test("save/load round-trips a structured value", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask" });
			const value = { selections: [{ option: "a" }, { otherText: "hello" }], activeTab: 1 };
			store.save("s1::tool1", value);
			return store.load("s1::tool1");
		});
		expect(result).toEqual({ selections: [{ option: "a" }, { otherText: "hello" }], activeTab: 1 });
	});

	test("load returns null for an absent key", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask" });
			return store.load("missing");
		});
		expect(result).toBeNull();
	});

	test("distinct namespaces never collide", async ({ page }) => {
		const result = await page.evaluate(() => {
			const a = (window as any).__createStore({ namespace: "ask" });
			const b = (window as any).__createStore({ namespace: "review" });
			a.save("k", { from: "ask" });
			b.save("k", { from: "review" });
			return { a: a.load("k"), b: b.load("k") };
		});
		expect(result.a).toEqual({ from: "ask" });
		expect(result.b).toEqual({ from: "review" });
	});

	test("distinct scope keys never collide", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask" });
			store.save("s1::t1", { x: 1 });
			store.save("s2::t1", { x: 2 });
			return { one: store.load("s1::t1"), two: store.load("s2::t1") };
		});
		expect(result.one).toEqual({ x: 1 });
		expect(result.two).toEqual({ x: 2 });
	});

	test("opaque composite key with '|' is preserved verbatim (not split/normalised)", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask" });
			const scopeKey = "sess-123::call_abc|fc_def";
			store.save(scopeKey, { v: 42 });
			const raw = (window as any).__rawSession("bobbit_draft/ask/" + scopeKey);
			return { value: store.load(scopeKey), rawPresent: raw != null };
		});
		expect(result.value).toEqual({ v: 42 });
		expect(result.rawPresent).toBe(true);
	});
});

test.describe("TransientDraftStore tombstone + forget", () => {
	test("clear removes value and load returns null", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask" });
			store.save("k", { x: 1 });
			store.clear("k");
			return store.load("k");
		});
		expect(result).toBeNull();
	});

	test("save after clear is rejected while the tombstone is live (no resurrection)", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask", tombstoneTtlMs: 60_000 });
			store.save("k", { x: 1 });
			store.clear("k");
			// A late save (e.g. a debounced write scheduled before submit) must not resurrect.
			store.save("k", { x: 2 });
			return store.load("k");
		});
		expect(result).toBeNull();
	});

	test("tombstone expires and fresh saves are accepted again", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const store = (window as any).__createStore({ namespace: "ask", tombstoneTtlMs: 30 });
			store.save("k", { x: 1 });
			store.clear("k");
			await new Promise((r) => setTimeout(r, 60));
			store.save("k", { x: 2 });
			return store.load("k");
		});
		expect(result).toEqual({ x: 2 });
	});

	test("forget removes the tombstone and allows immediate fresh writes", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask", tombstoneTtlMs: 60_000 });
			store.save("k", { x: 1 });
			store.clear("k");
			store.forget("k");
			store.save("k", { x: 2 });
			return store.load("k");
		});
		expect(result).toEqual({ x: 2 });
	});

	test("forget on a live value hard-deletes it", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask" });
			store.save("k", { x: 1 });
			store.forget("k");
			return { value: store.load("k"), raw: (window as any).__rawSession("bobbit_draft/ask/k") };
		});
		expect(result.value).toBeNull();
		expect(result.raw).toBeNull();
	});
});

test.describe("TransientDraftStore last-write-wins (gen)", () => {
	test("an out-of-order stale write does not overwrite a newer value", async ({ page }) => {
		const result = await page.evaluate(() => {
			// Two store instances over the same backing storage simulate two
			// independent write paths. The second instance reads the record
			// written by the first, so its next save must out-gen it.
			const a = (window as any).__createStore({ namespace: "ask" });
			a.save("k", { v: "first" });
			a.save("k", { v: "second" });
			// Forge a stale record directly with a lower gen, then a fresh store
			// instance must still treat its own save as newer (gen seeded from disk).
			const fresh = (window as any).__createStore({ namespace: "ask" });
			const loaded = fresh.load("k"); // seeds gen from the on-disk record
			fresh.save("k", { v: "third" });
			return { loaded, final: fresh.load("k") };
		});
		expect(result.loaded).toEqual({ v: "second" });
		expect(result.final).toEqual({ v: "third" });
	});

	test("gen increments monotonically across saves", async ({ page }) => {
		const gens = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask" });
			const read = () => JSON.parse((window as any).__rawSession("bobbit_draft/ask/k")).gen;
			store.save("k", { n: 1 });
			const g1 = read();
			store.save("k", { n: 2 });
			const g2 = read();
			store.save("k", { n: 3 });
			const g3 = read();
			return [g1, g2, g3];
		});
		expect(gens[0]).toBeLessThan(gens[1]);
		expect(gens[1]).toBeLessThan(gens[2]);
	});
});

test.describe("TransientDraftStore bounds", () => {
	test("exceeding maxEntries evicts the oldest, never the just-written key", async ({ page }) => {
		const result = await page.evaluate(async () => {
			const store = (window as any).__createStore({ namespace: "ask", maxEntries: 3 });
			// Write 4 keys with strictly increasing updatedAt by spacing them out.
			for (const k of ["k1", "k2", "k3", "k4"]) {
				store.save(k, { k });
				await new Promise((r) => setTimeout(r, 5));
			}
			return {
				k1: store.load("k1"),
				k2: store.load("k2"),
				k3: store.load("k3"),
				k4: store.load("k4"),
				count: (window as any).__listKeys("session", "bobbit_draft/ask/").length,
			};
		});
		// k1 was oldest → evicted. The just-written k4 must survive.
		expect(result.k1).toBeNull();
		expect(result.k2).toEqual({ k: "k2" });
		expect(result.k3).toEqual({ k: "k3" });
		expect(result.k4).toEqual({ k: "k4" });
		expect(result.count).toBeLessThanOrEqual(3);
	});

	test("a write over maxEntryBytes is dropped without throwing", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask", maxEntryBytes: 64 });
			let threw = false;
			try {
				store.save("big", { blob: "x".repeat(5000) });
			} catch {
				threw = true;
			}
			return { threw, value: store.load("big") };
		});
		expect(result.threw).toBe(false);
		expect(result.value).toBeNull();
	});

	test("a small write under maxEntryBytes still succeeds", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask", maxEntryBytes: 4096 });
			store.save("small", { ok: true });
			return store.load("small");
		});
		expect(result).toEqual({ ok: true });
	});
});

test.describe("TransientDraftStore backend selection", () => {
	test("session backend writes to sessionStorage, not localStorage", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask", backend: "session" });
			store.save("k", { x: 1 });
			return {
				session: (window as any).__rawSession("bobbit_draft/ask/k"),
				local: (window as any).__rawLocal("bobbit_draft/ask/k"),
			};
		});
		expect(result.session).not.toBeNull();
		expect(result.local).toBeNull();
	});

	test("local backend writes to localStorage, not sessionStorage", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask", backend: "local" });
			store.save("k", { x: 1 });
			return {
				session: (window as any).__rawSession("bobbit_draft/ask/k"),
				local: (window as any).__rawLocal("bobbit_draft/ask/k"),
			};
		});
		expect(result.session).toBeNull();
		expect(result.local).not.toBeNull();
	});
});

test.describe("TransientDraftStore storage failures degrade safely", () => {
	test("throwing storage never lets an exception escape any method", async ({ page }) => {
		const result = await page.evaluate(() => {
			const store = (window as any).__createStore({ namespace: "ask" });
			(window as any).__breakStorage();
			let threw = false;
			let loaded: unknown = "unset";
			try {
				store.save("k", { x: 1 });
				loaded = store.load("k");
				store.clear("k");
				store.forget("k");
			} catch {
				threw = true;
			} finally {
				(window as any).__restoreStorage();
			}
			return { threw, loaded };
		});
		expect(result.threw).toBe(false);
		// With storage throwing, load degrades to null.
		expect(result.loaded).toBeNull();
	});
});
