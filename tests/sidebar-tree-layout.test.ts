import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	SIDEBAR_TREE_INDENT_DEFAULT_PX,
	SIDEBAR_TREE_INDENT_KEY,
	SIDEBAR_TREE_INDENT_MAX_PX,
	SIDEBAR_TREE_INDENT_MIN_PX,
	applySidebarTreeLayoutVars,
	clampSidebarTreeIndentPx,
	loadSidebarTreeIndentPx,
	loadSidebarTreeLayoutPreference,
	resetSidebarTreeIndentPreference,
	saveSidebarTreeIndentPx,
	sidebarTreeCollapsedIndentPx,
	sidebarTreeIndentPxToLayout,
} from "../src/app/sidebar-tree-layout.ts";

function installLocalStorageShim(): Map<string, string> {
	const store = new Map<string, string>();
	(globalThis as any).localStorage = {
		get length() { return store.size; },
		clear: () => store.clear(),
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		key: (index: number) => Array.from(store.keys())[index] ?? null,
		removeItem: (key: string) => { store.delete(key); },
		setItem: (key: string, value: string) => { store.set(key, String(value)); },
	} satisfies Storage;
	return store;
}

function installThrowingLocalStorageShim(): void {
	(globalThis as any).localStorage = {
		get length() { throw new DOMException("denied", "SecurityError"); },
		clear: () => { throw new DOMException("denied", "SecurityError"); },
		getItem: () => { throw new DOMException("denied", "SecurityError"); },
		key: () => { throw new DOMException("denied", "SecurityError"); },
		removeItem: () => { throw new DOMException("denied", "SecurityError"); },
		setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
	} satisfies Storage;
}

function installDocumentStyleShim(): Map<string, string> {
	const vars = new Map<string, string>();
	(globalThis as any).document = {
		documentElement: {
			style: {
				setProperty: (name: string, value: string) => { vars.set(name, value); },
			},
		},
	};
	return vars;
}

afterEach(() => {
	delete (globalThis as any).localStorage;
	delete (globalThis as any).document;
});

describe("sidebar tree indent preference helpers", () => {
	it("clamps invalid, rounded, and out-of-range values", () => {
		assert.equal(clampSidebarTreeIndentPx(Number.NaN), SIDEBAR_TREE_INDENT_DEFAULT_PX);
		assert.equal(clampSidebarTreeIndentPx(Infinity), SIDEBAR_TREE_INDENT_DEFAULT_PX);
		// @ts-expect-error explicit non-number coverage
		assert.equal(clampSidebarTreeIndentPx("18"), SIDEBAR_TREE_INDENT_DEFAULT_PX);
		// @ts-expect-error explicit missing-value coverage
		assert.equal(clampSidebarTreeIndentPx(undefined), SIDEBAR_TREE_INDENT_DEFAULT_PX);
		assert.equal(clampSidebarTreeIndentPx(7), SIDEBAR_TREE_INDENT_MIN_PX);
		assert.equal(clampSidebarTreeIndentPx(29), SIDEBAR_TREE_INDENT_MAX_PX);
		assert.equal(clampSidebarTreeIndentPx(18.4), 18);
		assert.equal(clampSidebarTreeIndentPx(18.5), 19);
	});

	it("derives fixed-base layout and collapsed indentation", () => {
		assert.deepEqual(sidebarTreeIndentPxToLayout(24), {
			version: 1,
			indentMode: "comfortable",
			baseIndentPx: 5,
			nestedGoalIndentPx: 24,
		});
		assert.deepEqual(sidebarTreeIndentPxToLayout(99), {
			version: 1,
			indentMode: "comfortable",
			baseIndentPx: 5,
			nestedGoalIndentPx: 28,
		});
		assert.equal(sidebarTreeCollapsedIndentPx(8), 3);
		assert.equal(sidebarTreeCollapsedIndentPx(16), 5);
		assert.equal(sidebarTreeCollapsedIndentPx(28), 6);
	});
});

describe("sidebar tree indent storage", () => {
	let store: Map<string, string>;
	beforeEach(() => { store = installLocalStorageShim(); });

	it("loads the default when storage is empty, unavailable, or corrupt", () => {
		assert.equal(loadSidebarTreeIndentPx(), SIDEBAR_TREE_INDENT_DEFAULT_PX);
		localStorage.setItem(SIDEBAR_TREE_INDENT_KEY, "garbage");
		assert.equal(loadSidebarTreeIndentPx(), SIDEBAR_TREE_INDENT_DEFAULT_PX);
		delete (globalThis as any).localStorage;
		assert.equal(loadSidebarTreeIndentPx(), SIDEBAR_TREE_INDENT_DEFAULT_PX);
	});

	it("loads and clamps persisted values", () => {
		localStorage.setItem(SIDEBAR_TREE_INDENT_KEY, "22");
		assert.equal(loadSidebarTreeIndentPx(), 22);
		assert.deepEqual(loadSidebarTreeLayoutPreference(), { version: 1, indentMode: "comfortable", baseIndentPx: 5, nestedGoalIndentPx: 22 });
		localStorage.setItem(SIDEBAR_TREE_INDENT_KEY, "2");
		assert.equal(loadSidebarTreeIndentPx(), SIDEBAR_TREE_INDENT_MIN_PX);
		localStorage.setItem(SIDEBAR_TREE_INDENT_KEY, "200");
		assert.equal(loadSidebarTreeIndentPx(), SIDEBAR_TREE_INDENT_MAX_PX);
	});

	it("saves clamped values and resets to the default", () => {
		assert.equal(saveSidebarTreeIndentPx(99), SIDEBAR_TREE_INDENT_MAX_PX);
		assert.equal(store.get(SIDEBAR_TREE_INDENT_KEY), String(SIDEBAR_TREE_INDENT_MAX_PX));
		assert.equal(resetSidebarTreeIndentPreference(), SIDEBAR_TREE_INDENT_DEFAULT_PX);
		assert.equal(store.get(SIDEBAR_TREE_INDENT_KEY), String(SIDEBAR_TREE_INDENT_DEFAULT_PX));
	});

	it("tolerates throwing storage and still returns the effective value", () => {
		installThrowingLocalStorageShim();
		assert.equal(loadSidebarTreeIndentPx(), SIDEBAR_TREE_INDENT_DEFAULT_PX);
		assert.equal(saveSidebarTreeIndentPx(22), 22);
		assert.equal(resetSidebarTreeIndentPreference(), SIDEBAR_TREE_INDENT_DEFAULT_PX);
	});
});

describe("applySidebarTreeLayoutVars", () => {
	it("writes runtime variables to documentElement", () => {
		const vars = installDocumentStyleShim();
		applySidebarTreeLayoutVars(24);
		assert.equal(vars.get("--sidebar-tree-base-indent"), "5px");
		assert.equal(vars.get("--sidebar-tree-nested-goal-indent"), "24px");
		assert.equal(vars.get("--sidebar-tree-collapsed-indent"), "6px");
	});

	it("is safe without document", () => {
		delete (globalThis as any).document;
		assert.doesNotThrow(() => applySidebarTreeLayoutVars(24));
	});
});
