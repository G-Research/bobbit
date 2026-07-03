import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sidebarTreeKey } from "../src/app/sidebar-tree-builder.ts";

const STORAGE_KEY = "bobbit-sidebar-tree-state:v1";
const LEGACY_EXPANDED_GOALS_KEY = "bobbit-expanded-goals";

const realLocalStorage = (globalThis as any).localStorage;
const realWindow = (globalThis as any).window;

interface FakeStorage {
	store: Map<string, string>;
	ls: Storage;
}

function makeFakeStorage(initial?: Record<string, string>): FakeStorage {
	const store = new Map<string, string>(Object.entries(initial ?? {}));
	const ls = {
		get length() { return store.size; },
		clear: () => { store.clear(); },
		getItem: (key: string) => store.get(key) ?? null,
		key: (index: number) => [...store.keys()][index] ?? null,
		removeItem: (key: string) => { store.delete(key); },
		setItem: (key: string, value: string) => { store.set(key, String(value)); },
	} as Storage;
	return { store, ls };
}

function installBrowserGlobals(initial?: Record<string, string>): FakeStorage {
	const fake = makeFakeStorage(initial);
	Object.defineProperty(globalThis, "localStorage", { value: fake.ls, configurable: true, writable: true });
	Object.defineProperty(globalThis, "window", {
		value: {
			innerWidth: 1024,
			addEventListener: () => {},
			removeEventListener: () => {},
		},
		configurable: true,
		writable: true,
	});
	return fake;
}

function storedUnifiedExpansion(store: Map<string, string>): Record<string, string> {
	const raw = store.get(STORAGE_KEY);
	return raw ? JSON.parse(raw).expansion : {};
}

afterEach(() => {
	if (realLocalStorage === undefined) delete (globalThis as any).localStorage;
	else Object.defineProperty(globalThis, "localStorage", { value: realLocalStorage, configurable: true, writable: true });

	if (realWindow === undefined) delete (globalThis as any).window;
	else Object.defineProperty(globalThis, "window", { value: realWindow, configurable: true, writable: true });
});

test("saveExpandedGoals does not let stale legacy expanded goals override explicit collapsed unified preferences", async () => {
	const { store } = installBrowserGlobals({
		[LEGACY_EXPANDED_GOALS_KEY]: JSON.stringify(["goal-live", "goal-archived"]),
	});
	const stateModule = await import(`../src/app/state.ts?legacy-goals-${Date.now()}-${Math.random()}`);
	const sidebarTreeState = await import("../src/app/sidebar-tree-state.js");

	assert.equal(sidebarTreeState.isGoalExpanded("goal-live"), true, "legacy expanded goal should migrate initially");

	sidebarTreeState.setGoalExpanded("goal-live", false);
	assert.equal(sidebarTreeState.getSidebarTreePreference({ kind: "goal", goalId: "goal-live" }), "collapsed");
	assert.equal(stateModule.expandedGoals.has("goal-live"), true, "legacy compatibility set remains stale until saved");

	stateModule.saveExpandedGoals();

	assert.equal(sidebarTreeState.isGoalExpanded("goal-live"), false, "save must not re-expand an explicitly collapsed goal");
	assert.deepEqual(
		JSON.parse(store.get(LEGACY_EXPANDED_GOALS_KEY) ?? "[]"),
		["goal-live", "goal-archived"],
		"compatibility save must not rewrite stale durable legacy storage",
	);
	assert.equal(storedUnifiedExpansion(store)[sidebarTreeKey({ kind: "goal", goalId: "goal-live" })], "collapsed");

	const reloadedSidebarTreeState = await import(`../src/app/sidebar-tree-state.ts?legacy-goals-reload-${Date.now()}-${Math.random()}`);
	assert.equal(reloadedSidebarTreeState.isGoalExpanded("goal-live"), false, "stale legacy expansion must not override stored unified collapse on reload");
	assert.equal(reloadedSidebarTreeState.getSidebarTreePreference({ kind: "goal", goalId: "goal-live" }), "collapsed");

	stateModule.state.goals = [
		{ id: "goal-live", archived: false },
		{ id: "goal-archived", archived: true },
	] as any;
	stateModule.state.archivedSessions = [];
	stateModule.resetArchivedExpandState();

	assert.equal(sidebarTreeState.isGoalExpanded("goal-live"), false, "resetting archived expansion must not re-expand stale non-archived goals");
	assert.equal(sidebarTreeState.getSidebarTreePreference({ kind: "goal", goalId: "goal-archived" }), undefined);
	assert.deepEqual(
		JSON.parse(store.get(LEGACY_EXPANDED_GOALS_KEY) ?? "[]"),
		["goal-live", "goal-archived"],
		"archived reset must not rewrite stale durable legacy storage",
	);
	assert.equal(storedUnifiedExpansion(store)[sidebarTreeKey({ kind: "goal", goalId: "goal-live" })], "collapsed");
	assert.equal(storedUnifiedExpansion(store)[sidebarTreeKey({ kind: "goal", goalId: "goal-archived" })], undefined);
});
