/**
 * Unit tests for src/app/theme-init.ts — the boot-time theme normalization that
 * keeps the shared <theme-toggle> from ever showing the ambiguous "system"
 * (Monitor) icon.
 *
 * Pure module (no DOM beyond `window.matchMedia` + `localStorage`), so it runs
 * as a node:test with those globals mocked on globalThis. The module's
 * import-time self-call is a no-op here because `window` is undefined at import.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { normalizeThemePreference } from "../src/app/theme-init.ts";

function makeLocalStorage(initial?: string): { store: { theme?: string }; ls: Storage } {
	const store: { theme?: string } = {};
	if (initial !== undefined) store.theme = initial;
	const ls = {
		getItem: (k: string) => (k === "theme" && store.theme !== undefined ? store.theme : null),
		setItem: (k: string, v: string) => { if (k === "theme") store.theme = v; },
		removeItem: (k: string) => { if (k === "theme") delete store.theme; },
		clear: () => { delete store.theme; },
		key: () => null,
		length: 0,
	} as unknown as Storage;
	return { store, ls };
}

function install(opts: { stored?: string; prefersDark?: boolean; noMatchMedia?: boolean }): { theme?: string } {
	const { store, ls } = makeLocalStorage(opts.stored);
	Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
	const win: Record<string, unknown> = {};
	if (!opts.noMatchMedia) {
		win.matchMedia = (_q: string) => ({ matches: opts.prefersDark === true });
	}
	Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
	return store;
}

afterEach(() => {
	Object.defineProperty(globalThis, "window", { value: undefined, configurable: true, writable: true });
	Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
});

describe("theme-init — normalizeThemePreference", () => {
	it("pins an unset theme to dark when the system prefers dark", () => {
		const store = install({ prefersDark: true });
		normalizeThemePreference();
		assert.equal(store.theme, "dark");
	});

	it("pins an unset theme to light when the system prefers light", () => {
		const store = install({ prefersDark: false });
		normalizeThemePreference();
		assert.equal(store.theme, "light");
	});

	it("normalizes an explicit 'system' value to the resolved theme", () => {
		const store = install({ stored: "system", prefersDark: true });
		normalizeThemePreference();
		assert.equal(store.theme, "dark");
	});

	it("leaves an explicit 'light' preference untouched", () => {
		const store = install({ stored: "light", prefersDark: true });
		normalizeThemePreference();
		assert.equal(store.theme, "light");
	});

	it("leaves an explicit 'dark' preference untouched", () => {
		const store = install({ stored: "dark", prefersDark: false });
		normalizeThemePreference();
		assert.equal(store.theme, "dark");
	});

	it("defaults to light when matchMedia is unavailable", () => {
		const store = install({ noMatchMedia: true });
		normalizeThemePreference();
		assert.equal(store.theme, "light");
	});

	it("is a no-op when window is undefined (e.g. SSR / node import)", () => {
		// localStorage present but window undefined → must not throw or write.
		const { store, ls } = makeLocalStorage();
		Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
		Object.defineProperty(globalThis, "window", { value: undefined, configurable: true, writable: true });
		normalizeThemePreference();
		assert.equal(store.theme, undefined);
	});
});
