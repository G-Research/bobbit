/**
 * Unit tests for src/app/sidebar-font-scale.ts \u2014 the pure helpers that drive
 * the user-adjustable sidebar font-size setting.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	SIDEBAR_FONT_SCALE_DEFAULT,
	SIDEBAR_FONT_SCALE_KEY,
	SIDEBAR_FONT_SCALE_STOPS,
	clampSidebarFontScale,
	loadSidebarFontScale,
	nearestStop,
} from "../src/app/sidebar-font-scale.ts";

// Minimal in-memory localStorage shim so loadSidebarFontScale() takes the
// "real" branch instead of the early `typeof localStorage === "undefined"`
// fallback.
function installLocalStorageShim(): { reset: () => void } {
	const store = new Map<string, string>();
	const shim: Storage = {
		get length() { return store.size; },
		clear: () => store.clear(),
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		key: (i: number) => Array.from(store.keys())[i] ?? null,
		removeItem: (k: string) => { store.delete(k); },
		setItem: (k: string, v: string) => { store.set(k, String(v)); },
	};
	(globalThis as any).localStorage = shim;
	return { reset: () => store.clear() };
}

describe("sidebar-font-scale: stops layout", () => {
	it("ships exactly the 5 stops the design doc specifies, in ascending order", () => {
		assert.equal(SIDEBAR_FONT_SCALE_STOPS.length, 5);
		const labels = SIDEBAR_FONT_SCALE_STOPS.map(s => s.label);
		assert.deepEqual(labels, ["Smallest", "Small", "Default", "Large", "Largest"]);
		const values = SIDEBAR_FONT_SCALE_STOPS.map(s => s.value);
		assert.deepEqual(values, [0.85, 0.92, 1.00, 1.10, 1.22]);
		// Ascending invariant
		for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1]);
	});

	it("Default stop equals SIDEBAR_FONT_SCALE_DEFAULT (=1.0)", () => {
		assert.equal(SIDEBAR_FONT_SCALE_DEFAULT, 1.0);
		const def = SIDEBAR_FONT_SCALE_STOPS.find(s => s.id === "default");
		assert.ok(def);
		assert.equal(def!.value, SIDEBAR_FONT_SCALE_DEFAULT);
	});
});

describe("clampSidebarFontScale", () => {
	it("returns default for NaN / Infinity / non-numeric", () => {
		assert.equal(clampSidebarFontScale(NaN), 1.0);
		assert.equal(clampSidebarFontScale(Infinity), 1.0);
		assert.equal(clampSidebarFontScale(-Infinity), 1.0);
		// @ts-expect-error \u2014 explicit non-number coverage
		assert.equal(clampSidebarFontScale("nope"), 1.0);
		// @ts-expect-error
		assert.equal(clampSidebarFontScale(undefined), 1.0);
	});

	it("clamps below the smallest stop value", () => {
		assert.equal(clampSidebarFontScale(0.5), 0.85);
		assert.equal(clampSidebarFontScale(0), 0.85);
		assert.equal(clampSidebarFontScale(-2), 0.85);
	});

	it("clamps above the largest stop value", () => {
		assert.equal(clampSidebarFontScale(3), 1.22);
		assert.equal(clampSidebarFontScale(2.0), 1.22);
	});

	it("passes through valid in-range values without snapping", () => {
		assert.equal(clampSidebarFontScale(1.0), 1.0);
		assert.equal(clampSidebarFontScale(0.95), 0.95);
		assert.equal(clampSidebarFontScale(1.10), 1.10);
	});
});

describe("nearestStop", () => {
	it("returns Default for an exact 1.0", () => {
		assert.equal(nearestStop(1.0).id, "default");
	});

	it("snaps a value between Small (0.92) and Default (1.0) toward the closer stop", () => {
		assert.equal(nearestStop(0.95).id, "small");   // 0.95 is closer to 0.92 (\u0394 0.03) than 1.00 (\u0394 0.05)
		assert.equal(nearestStop(0.97).id, "default"); // 0.97 closer to 1.00 (\u0394 0.03) than 0.92 (\u0394 0.05)
	});

	it("clamps out-of-range scales before snapping", () => {
		assert.equal(nearestStop(2.0).id, "largest");
		assert.equal(nearestStop(0.1).id, "smallest");
		assert.equal(nearestStop(NaN).id, "default");
	});

	it("snaps each stop value to itself", () => {
		for (const s of SIDEBAR_FONT_SCALE_STOPS) {
			assert.equal(nearestStop(s.value).id, s.id);
		}
	});
});

describe("loadSidebarFontScale", () => {
	let shim: { reset: () => void };
	beforeEach(() => { shim = installLocalStorageShim(); });
	afterEach(() => { shim.reset(); delete (globalThis as any).localStorage; });

	it("returns default when localStorage is empty", () => {
		assert.equal(loadSidebarFontScale(), 1.0);
	});

	it("reads a valid persisted multiplier", () => {
		localStorage.setItem(SIDEBAR_FONT_SCALE_KEY, "1.10");
		assert.equal(loadSidebarFontScale(), 1.10);
	});

	it("clamps a too-large persisted value", () => {
		localStorage.setItem(SIDEBAR_FONT_SCALE_KEY, "5");
		assert.equal(loadSidebarFontScale(), 1.22);
	});

	it("clamps a too-small persisted value", () => {
		localStorage.setItem(SIDEBAR_FONT_SCALE_KEY, "0.1");
		assert.equal(loadSidebarFontScale(), 0.85);
	});

	it("falls back to default for an invalid (non-numeric) persisted value", () => {
		localStorage.setItem(SIDEBAR_FONT_SCALE_KEY, "garbage");
		assert.equal(loadSidebarFontScale(), 1.0);
	});

	it("falls back to default when localStorage is absent (SSR-safe)", () => {
		delete (globalThis as any).localStorage;
		assert.equal(loadSidebarFontScale(), 1.0);
	});
});
