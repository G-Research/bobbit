/**
 * Regression: renderSidebarBobbitCanvas must memoize its per-layer
 * canvas.toDataURL() encodes.
 *
 * toDataURL() is a synchronous, main-thread PNG encode (~5-9ms per call for
 * these small canvases). The sidebar re-renders on every WS status tick, and
 * each sprite issues up to 4 encodes (body + blink + eye + accessory). Without
 * memoization a ~20-session sidebar burned ~200ms of blocking work per render
 * event. Every data-URL is a pure function of a small discrete input set, so
 * repeat renders of identical opts must reuse the cached URL and call
 * toDataURL() ONLY on the first render.
 *
 * This spec FAILS on the pre-memoization behaviour (4 encodes × N renders) and
 * also guards key correctness (different pixel-affecting opts ⇒ different URL;
 * hue-rotate, applied as CSS, ⇒ same URL).
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/sidebar-bobbit-datauri-cache.html");
const BUNDLE = path.resolve("tests/fixtures/sidebar-bobbit-datauri-cache-bundle.js");
const ENTRY = path.resolve("tests/fixtures/sidebar-bobbit-datauri-cache-entry.ts");
const SOURCES = [
	ENTRY,
	path.resolve("src/ui/bobbit-render.ts"),
	path.resolve("src/ui/bobbit-sprite-data.ts"),
	path.resolve("src/app/session-colors.ts"),
];

function fileUrl(file: string): string {
	return `file://${file.replace(/\\/g, "/")}`;
}

test.beforeAll(() => {
	const sourceMtime = Math.max(...SOURCES.map(source => fs.statSync(source).mtimeMs));
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < sourceMtime;
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

/** Install a toDataURL spy BEFORE any module loads so module-level caches are
 *  fresh per page and every encode is counted. Records each produced URL. */
async function installSpyAndLoad(page: import("@playwright/test").Page): Promise<void> {
	await page.addInitScript(() => {
		(window as any).__dataUrlCalls = 0;
		(window as any).__dataUrls = [] as string[];
		const original = HTMLCanvasElement.prototype.toDataURL;
		HTMLCanvasElement.prototype.toDataURL = function (...args: any[]) {
			(window as any).__dataUrlCalls = ((window as any).__dataUrlCalls ?? 0) + 1;
			const url = Reflect.apply(original, this, args);
			(window as any).__dataUrls.push(url);
			return url;
		} as any;
	});
	await page.goto(fileUrl(FIXTURE));
	await page.waitForFunction(() => (window as any).__ready === true);
}

test.describe("Sidebar bobbit data-URL memoization", () => {
	test("default idle preview bobbits keep the breathing animation", async ({ page }) => {
		await installSpyAndLoad(page);

		const result = await page.evaluate(() => {
			const api = (window as any).__sidebarBobbit;
			const host = document.getElementById("host")!;
			api.renderDefaultPreviewInto(host, {
				status: "idle",
				accessory: api.ACCESSORY_DEFS["crown"],
			});
			const outer = host.firstElementChild as HTMLElement;
			return {
				style: outer.getAttribute("style") ?? "",
				animation: outer.style.animation,
				filter: outer.style.filter,
				width: outer.style.width,
				height: outer.style.height,
				accessoryLayerCount: host.querySelectorAll("img").length - 1,
			};
		});

		expect(result.style).toContain("bobbit-breathe");
		expect(result.animation).toContain("bobbit-breathe");
		expect(result.filter).toBe("saturate(0.4)");
		expect(result.width).toBe("20px");
		expect(result.height).toBe("19px");
		expect(result.accessoryLayerCount).toBe(1);
	});

	test("explicit static sidebar idle bobbits render without inline animation while preserving idle styling", async ({ page }) => {
		await installSpyAndLoad(page);

		const result = await page.evaluate(() => {
			const api = (window as any).__sidebarBobbit;
			const host = document.getElementById("host")!;
			api.renderStaticSidebarStatusInto(host, "idle", false, false, false, "crown");
			const outer = host.querySelector(".sidebar-bobbit-status-test > span") as HTMLElement;
			return {
				style: outer.getAttribute("style") ?? "",
				animation: outer.style.animation,
				inlineAnimations: Array.from(host.querySelectorAll<HTMLElement>("[style]")).map(el => el.style.animation).filter(Boolean),
				filter: outer.style.filter,
				width: outer.style.width,
				height: outer.style.height,
				accessoryLayerCount: host.querySelectorAll("img").length - 1,
			};
		});

		expect(result.style).not.toContain("bobbit-breathe");
		expect(result.animation).toBe("");
		expect(result.inlineAnimations).toEqual([]);
		expect(result.filter).toBe("saturate(0.4)");
		expect(result.width).toBe("20px");
		expect(result.height).toBe("19px");
		expect(result.accessoryLayerCount).toBe(1);
	});

	test("static sidebar status rendering preserves busy and unread animations without idle breathing", async ({ page }) => {
		await installSpyAndLoad(page);

		const result = await page.evaluate(() => {
			const api = (window as any).__sidebarBobbit;
			const host = document.getElementById("host")!;
			const capture = () => {
				const outer = host.querySelector(".sidebar-bobbit-status-test > span") as HTMLElement;
				return {
					style: outer.getAttribute("style") ?? "",
					animation: outer.style.animation,
					blinkCount: host.querySelectorAll(".bobbit-sidebar-unread-blink").length,
					pulseCount: host.querySelectorAll(".bobbit-unread-pulse").length,
				};
			};

			api.renderStaticSidebarStatusInto(host, "streaming");
			const streaming = capture();
			api.renderStaticSidebarStatusInto(host, "busy");
			const busy = capture();
			api.renderStaticSidebarStatusInto(host, "idle", false, false, false, "bandana", false, true);
			const unreadIdle = capture();
			api.renderStaticSidebarStatusInto(host, "idle");
			const plainIdle = capture();

			return { streaming, busy, unreadIdle, plainIdle };
		});

		expect(result.streaming.style).toContain("bobbit-bob");
		expect(result.streaming.style).not.toContain("bobbit-breathe");
		expect(result.busy.style).toContain("bobbit-bob");
		expect(result.busy.style).not.toContain("bobbit-breathe");
		expect(result.unreadIdle.style).not.toContain("bobbit-breathe");
		expect(result.unreadIdle.animation).toBe("");
		expect(result.unreadIdle.blinkCount).toBe(1);
		expect(result.unreadIdle.pulseCount).toBe(1);
		expect(result.plainIdle.style).not.toContain("bobbit-breathe");
		expect(result.plainIdle.animation).toBe("");
		expect(result.plainIdle.blinkCount).toBe(0);
		expect(result.plainIdle.pulseCount).toBe(0);
	});

	test("identical opts: toDataURL runs once on first render, never again", async ({ page }) => {
		await installSpyAndLoad(page);

		const N = 8;
		const result = await page.evaluate((n) => {
			const api = (window as any).__sidebarBobbit;
			const host = document.getElementById("host")!;
			// Selected + unread + accessory: exercises all four layers
			// (body, blink, eye, accessory) so the first render encodes 4 times.
			const opts = {
				status: "idle",
				isSelected: true,
				unread: true,
				accessory: api.ACCESSORY_DEFS["crown"],
			};
			(window as any).__dataUrlCalls = 0;
			for (let i = 0; i < n; i++) api.renderInto(host, opts);
			return { calls: (window as any).__dataUrlCalls };
		}, N);

		// First render encodes the 4 distinct layers; every subsequent identical
		// render is a pure cache hit. Pre-memoization this would be 4 * N = 32.
		expect(result.calls).toBe(4);
		expect(result.calls).toBeLessThan(4 * N);
	});

	test("single-layer sprite: only one encode across many renders", async ({ page }) => {
		await installSpyAndLoad(page);

		const N = 10;
		const calls = await page.evaluate((n) => {
			const api = (window as any).__sidebarBobbit;
			const host = document.getElementById("host")!;
			// Plain streaming sprite: body layer only (no blink, no eye overlay,
			// no accessory) ⇒ exactly one encode total.
			const opts = { status: "streaming", accessory: api.NO_ACCESSORY };
			(window as any).__dataUrlCalls = 0;
			for (let i = 0; i < n; i++) api.renderInto(host, opts);
			return (window as any).__dataUrlCalls;
		}, N);

		expect(calls).toBe(1);
	});

	test("hue-rotate is CSS-only: does not produce a distinct cached bitmap", async ({ page }) => {
		await installSpyAndLoad(page);

		const calls = await page.evaluate(() => {
			const api = (window as any).__sidebarBobbit;
			const host = document.getElementById("host")!;
			(window as any).__dataUrlCalls = 0;
			// Same pixel inputs, different hue. Hue is applied as a CSS filter on
			// the <img>, never baked into the bitmap, so both share one encode.
			api.renderInto(host, { status: "streaming", hueRotate: 0, accessory: api.NO_ACCESSORY });
			api.renderInto(host, { status: "streaming", hueRotate: 90, accessory: api.NO_ACCESSORY });
			api.renderInto(host, { status: "streaming", hueRotate: -60, accessory: api.NO_ACCESSORY });
			return (window as any).__dataUrlCalls;
		});

		expect(calls).toBe(1);
	});

	test("key correctness: pixel-affecting opts produce DIFFERENT cached URLs", async ({ page }) => {
		await installSpyAndLoad(page);

		const urls = await page.evaluate(() => {
			const api = (window as any).__sidebarBobbit;
			const host = document.getElementById("host")!;
			const grab = () => {
				(window as any).__dataUrls = [];
				return (window as any).__dataUrls as string[];
			};

			// 1. Body palette differs by status bucket (canonical vs starting vs terminated).
			grab();
			api.renderInto(host, { status: "idle", accessory: api.NO_ACCESSORY });
			const canonicalBody = (window as any).__dataUrls.slice();
			grab();
			api.renderInto(host, { status: "starting", accessory: api.NO_ACCESSORY });
			const startingBody = (window as any).__dataUrls.slice();
			grab();
			api.renderInto(host, { status: "terminated", accessory: api.NO_ACCESSORY });
			const terminatedBody = (window as any).__dataUrls.slice();

			// 2. isSelected changes the body eye color AND adds an eye overlay.
			grab();
			api.renderInto(host, { status: "idle", isSelected: true, accessory: api.NO_ACCESSORY });
			const selected = (window as any).__dataUrls.slice();

			// 3. unread changes gaze (right) and pose vs sleeping idle.
			grab();
			api.renderInto(host, { status: "idle", unread: true, accessory: api.NO_ACCESSORY });
			const unread = (window as any).__dataUrls.slice();

			// 4. Different accessories ⇒ different accessory bitmaps.
			grab();
			api.renderInto(host, { status: "idle", accessory: api.ACCESSORY_DEFS["crown"] });
			const crown = (window as any).__dataUrls.slice();
			grab();
			api.renderInto(host, { status: "idle", accessory: api.ACCESSORY_DEFS["bandana"] });
			const bandana = (window as any).__dataUrls.slice();

			return {
				canonicalBody: canonicalBody[0],
				startingBody: startingBody[0],
				terminatedBody: terminatedBody[0],
				selectedFirst: selected[0],
				unreadFirst: unread[0],
				crownAcc: crown[crown.length - 1],
				bandanaAcc: bandana[bandana.length - 1],
			};
		});

		// Status buckets ⇒ distinct body bitmaps (palette).
		expect(urls.canonicalBody).not.toEqual(urls.startingBody);
		expect(urls.canonicalBody).not.toEqual(urls.terminatedBody);
		expect(urls.startingBody).not.toEqual(urls.terminatedBody);
		// isSelected and unread change the body bitmap vs plain idle.
		expect(urls.selectedFirst).not.toEqual(urls.canonicalBody);
		expect(urls.unreadFirst).not.toEqual(urls.canonicalBody);
		// Distinct accessories ⇒ distinct accessory bitmaps.
		expect(urls.crownAcc).not.toEqual(urls.bandanaAcc);
		// Sanity: encodes are non-empty PNG data URLs.
		expect(urls.canonicalBody.startsWith("data:image/png")).toBe(true);
	});

	test("idle vs streaming must NOT collide: idle sleeps (eyes closed), streaming is awake", async ({ page }) => {
		await installSpyAndLoad(page);

		// Reads the rendered body <img src> directly (not the spy) so a cache HIT
		// vs MISS both report the final bitmap. Both "idle" and "streaming" share
		// the same palette bucket ("canonical") and identical option booleans, so
		// a key built only from the status BUCKET would alias them onto one cache
		// entry — and the second render would silently reuse the first's bitmap.
		// They differ in pixels: idle resolves to the sleeping (eyes-closed) pose,
		// streaming to the awake (eyes-open) pose. This pins that distinction.
		const r = await page.evaluate(() => {
			const api = (window as any).__sidebarBobbit;
			const bodySrc = (opts: any) => {
				const h = document.createElement("div");
				document.body.appendChild(h);
				api.renderInto(h, { accessory: api.NO_ACCESSORY, ...opts });
				return h.querySelector("img")!.getAttribute("src");
			};
			return {
				idle: bodySrc({ status: "idle" }),
				streaming: bodySrc({ status: "streaming" }),
				busy: bodySrc({ status: "busy" }),
			};
		});

		// idle (sleeping) must differ from the awake non-idle statuses, even though
		// all three map to the "canonical" palette bucket.
		expect(r.idle).not.toEqual(r.streaming);
		expect(r.idle).not.toEqual(r.busy);
		// streaming and busy are both awake canonical bodies ⇒ legitimately equal.
		expect(r.streaming).toEqual(r.busy);
	});
});
