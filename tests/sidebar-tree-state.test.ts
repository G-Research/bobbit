import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sidebarTreeKey } from "../src/app/sidebar-tree-builder.ts";
import type { SidebarTreeNodeKey } from "../src/app/sidebar-tree-builder.ts";

const STORAGE_KEY = "bobbit-sidebar-tree-state:v1";
const realLocalStorage = (globalThis as any).localStorage;

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

function installStorage(initial?: Record<string, string>): FakeStorage {
	const fake = makeFakeStorage(initial);
	Object.defineProperty(globalThis, "localStorage", { value: fake.ls, configurable: true, writable: true });
	return fake;
}

async function importFresh(tag: string): Promise<typeof import("../src/app/sidebar-tree-state.ts")> {
	return await import(`../src/app/sidebar-tree-state.ts?${tag}-${Date.now()}-${Math.random()}`);
}

function storedExpansion(store: Map<string, string>): Record<string, string> {
	const raw = store.get(STORAGE_KEY);
	return raw ? JSON.parse(raw).expansion : {};
}

function key(input: SidebarTreeNodeKey): string {
	return sidebarTreeKey(input);
}

beforeEach(() => {
	installStorage();
});

afterEach(() => {
	if (realLocalStorage === undefined) delete (globalThis as any).localStorage;
	else Object.defineProperty(globalThis, "localStorage", { value: realLocalStorage, configurable: true, writable: true });
});

describe("sidebar-tree-state", () => {
	it("uses the representative durable defaults for unified tree node kinds", async () => {
		const state = await importFresh("defaults");
		const cases: Array<{ name: string; key: SidebarTreeNodeKey; expected: boolean }> = [
			{ name: "project", key: { kind: "project", projectId: "project" }, expected: true },
			{ name: "project sessions", key: { kind: "project-sessions", projectId: "project" }, expected: true },
			{ name: "staff", key: { kind: "project-staff", projectId: "project" }, expected: true },
			{ name: "archived", key: { kind: "project-archived", projectId: "project" }, expected: true },
			{ name: "parent goal", key: { kind: "goal", goalId: "parent-goal" }, expected: false },
			{ name: "sub-goal", key: { kind: "goal", goalId: "child-goal" }, expected: false },
			{ name: "team lead", key: { kind: "team-lead", sessionId: "team-session" }, expected: true },
			{ name: "first-class child sessions", key: { kind: "session-children", sessionId: "parent-session", childClass: "first-class" }, expected: true },
			{ name: "live delegate children", key: { kind: "session-children", sessionId: "parent-session", childClass: "delegate" }, expected: false },
			{ name: "archived delegate children", key: { kind: "session-children", sessionId: "parent-session", childClass: "archived-delegate" }, expected: false },
			{ name: "session leaf", key: { kind: "session", sessionId: "leaf-session" }, expected: false },
		];

		for (const testCase of cases) {
			assert.equal(state.sidebarTreeDefaultExpanded(testCase.key), testCase.expected, testCase.name);
			assert.equal(state.isSidebarTreeExpanded(testCase.key), testCase.expected, testCase.name);
		}
		assert.equal(state.isProjectExpanded("project"), true);
		assert.equal(state.isUngroupedExpanded("project"), true);
		assert.equal(state.isStaffExpanded("project"), true);
		assert.equal(state.isArchivedSectionExpanded("project"), true);
		assert.equal(state.isGoalExpanded("child-goal"), false);
		assert.equal(state.isTeamLeadExpanded("team-session"), true);
		assert.equal(state.isFirstClassParentExpanded("parent-session"), true);
		assert.equal(state.isArchivedParentExpanded("parent-session"), false);

		const input = state.sidebarTreeExpansionInput();
		assert.equal(input.defaultExpanded?.({ kind: "session", sessionId: "leaf" }, true), true);
		assert.equal(input.isExpanded?.({ kind: "session", sessionId: "leaf" }, true), true);
	});

	it("persists explicit expanded/collapsed preferences over defaults", async () => {
		const { store } = installStorage();
		const state = await importFresh("explicit");

		state.setGoalExpanded("goal-1", true);
		state.setSidebarTreeExpanded({ kind: "project", projectId: "project-1" }, false);

		assert.equal(state.isGoalExpanded("goal-1"), true);
		assert.equal(state.isProjectExpanded("project-1"), false);
		assert.deepEqual(storedExpansion(store), {
			[key({ kind: "goal", goalId: "goal-1" })]: "expanded",
			[key({ kind: "project", projectId: "project-1" })]: "collapsed",
		});

		state.clearSidebarTreePreference({ kind: "project", projectId: "project-1" });
		assert.equal(state.isProjectExpanded("project-1"), true);
	});

	it("keeps canonical keys separate for identical raw ids", async () => {
		const { store } = installStorage();
		const state = await importFresh("separation");
		const id = "same/raw id";

		state.setSidebarTreeExpanded({ kind: "project", projectId: id }, false);
		state.setSidebarTreeExpanded({ kind: "goal", goalId: id }, true);
		state.setSidebarTreeExpanded({ kind: "team-lead", sessionId: id }, false);
		state.setSidebarTreeExpanded({ kind: "session-children", sessionId: id, childClass: "first-class" }, false);
		state.setSidebarTreeExpanded({ kind: "session-children", sessionId: id, childClass: "delegate" }, true);
		state.setSidebarTreeExpanded({ kind: "session-children", sessionId: id, childClass: "archived-delegate" }, true);

		assert.equal(state.isProjectExpanded(id), false);
		assert.equal(state.isGoalExpanded(id), true);
		assert.equal(state.isTeamLeadExpanded(id), false);
		assert.equal(state.isFirstClassParentExpanded(id), false);
		assert.equal(state.isArchivedParentExpanded(id), true);
		assert.equal(Object.keys(storedExpansion(store)).length, 6);
	});

	it("reloads explicit preferences from storage across fresh module imports", async () => {
		const { store } = installStorage();
		const first = await importFresh("reload-first");

		first.setSidebarTreeExpanded({ kind: "project", projectId: "project" }, false);
		first.setSidebarTreeExpanded({ kind: "project-sessions", projectId: "project" }, false);
		first.setSidebarTreeExpanded({ kind: "project-staff", projectId: "project" }, false);
		first.setSidebarTreeExpanded({ kind: "project-archived", projectId: "project" }, false);
		first.setGoalExpanded("sub-goal", true);
		first.setTeamLeadExpanded("team-session", false);
		first.setFirstClassParentExpanded("parent-session", false);
		first.setArchivedParentExpanded("parent-session", true);

		const second = await importFresh("reload-second");

		assert.equal(second.isProjectExpanded("project"), false);
		assert.equal(second.isUngroupedExpanded("project"), false);
		assert.equal(second.isStaffExpanded("project"), false);
		assert.equal(second.isArchivedSectionExpanded("project"), false);
		assert.equal(second.isGoalExpanded("sub-goal"), true);
		assert.equal(second.isTeamLeadExpanded("team-session"), false);
		assert.equal(second.isFirstClassParentExpanded("parent-session"), false);
		assert.equal(second.isArchivedParentExpanded("parent-session"), true);
		assert.deepEqual(storedExpansion(store), {
			[key({ kind: "goal", goalId: "sub-goal" })]: "expanded",
			[key({ kind: "project", projectId: "project" })]: "collapsed",
			[key({ kind: "project-archived", projectId: "project" })]: "collapsed",
			[key({ kind: "project-sessions", projectId: "project" })]: "collapsed",
			[key({ kind: "project-staff", projectId: "project" })]: "collapsed",
			[key({ kind: "session-children", sessionId: "parent-session", childClass: "archived-delegate" })]: "expanded",
			[key({ kind: "session-children", sessionId: "parent-session", childClass: "delegate" })]: "expanded",
			[key({ kind: "session-children", sessionId: "parent-session", childClass: "first-class" })]: "collapsed",
			[key({ kind: "team-lead", sessionId: "team-session" })]: "collapsed",
		});
	});

	it("migrates every legacy key without deleting legacy entries", async () => {
		const { store } = installStorage({
			"bobbit-expanded-projects": JSON.stringify(["collapsed:project-collapsed", "project-expanded"]),
			"bobbit-expanded-goals": JSON.stringify(["goal-expanded"]),
			"bobbit-collapsed-ungrouped": JSON.stringify(["project-sessions-collapsed"]),
			"bobbit-collapsed-staff": JSON.stringify(["project-staff-collapsed"]),
			"bobbit-archived-collapsed-projects": JSON.stringify(["project-archived-collapsed"]),
			"bobbit-collapsed-team-leads": JSON.stringify(["team-lead-collapsed"]),
			"bobbit-collapsed-first-class-parents": JSON.stringify(["first-class-collapsed"]),
			"bobbit-expanded-delegate-parents": JSON.stringify(["archived-delegate-expanded"]),
		});
		const state = await importFresh("migration");

		assert.equal(state.isProjectExpanded("project-collapsed"), false);
		assert.equal(state.isProjectExpanded("project-expanded"), true);
		assert.equal(state.isGoalExpanded("goal-expanded"), true);
		assert.equal(state.isUngroupedExpanded("project-sessions-collapsed"), false);
		assert.equal(state.isStaffExpanded("project-staff-collapsed"), false);
		assert.equal(state.isArchivedSectionExpanded("project-archived-collapsed"), false);
		assert.equal(state.isTeamLeadExpanded("team-lead-collapsed"), false);
		assert.equal(state.isFirstClassParentExpanded("first-class-collapsed"), false);
		assert.equal(state.isSidebarTreeExpanded({ kind: "session-children", sessionId: "archived-delegate-expanded", childClass: "delegate" }), true);
		assert.equal(state.isArchivedParentExpanded("archived-delegate-expanded"), true);
		assert.ok(store.has("bobbit-expanded-goals"));
		assert.ok(store.has("bobbit-expanded-delegate-parents"));
	});

	it("keeps new-state preferences over conflicting legacy values", async () => {
		installStorage({
			[STORAGE_KEY]: JSON.stringify({
				version: 1,
				expansion: {
					[key({ kind: "goal", goalId: "goal" })]: "collapsed",
					[key({ kind: "project", projectId: "project" })]: "expanded",
				},
			}),
			"bobbit-expanded-goals": JSON.stringify(["goal"]),
			"bobbit-expanded-projects": JSON.stringify(["collapsed:project"]),
		});
		const state = await importFresh("precedence");

		assert.equal(state.isGoalExpanded("goal"), false);
		assert.equal(state.isProjectExpanded("project"), true);
	});

	it("ignores corrupted, missing, wrong-version, and throwing storage", async () => {
		installStorage({ [STORAGE_KEY]: "not-json" });
		let state = await importFresh("corrupt-json");
		assert.equal(state.isProjectExpanded("p"), true);
		assert.equal(state.isGoalExpanded("g"), false);

		installStorage({ [STORAGE_KEY]: JSON.stringify({ version: 2, expansion: { [key({ kind: "goal", goalId: "legacy" })]: "expanded" } }) });
		state = await importFresh("wrong-version");
		assert.equal(state.isGoalExpanded("legacy"), false);

		delete (globalThis as any).localStorage;
		state = await importFresh("missing-storage");
		assert.equal(state.isTeamLeadExpanded("lead"), true);

		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get() { throw new Error("storage unavailable"); },
		});
		state = await importFresh("throwing-storage");
		assert.equal(state.isArchivedParentExpanded("archived"), false);
	});

	it("does not let automatic expansion override explicit collapse or persist expanded defaults", async () => {
		const { store } = installStorage();
		const state = await importFresh("auto");

		state.collapseSidebarTreeNode({ kind: "goal", goalId: "parent" });
		state.expandSidebarTreeNode({ kind: "goal", goalId: "parent" }, { explicit: false });
		assert.equal(state.isGoalExpanded("parent"), false);
		assert.equal(storedExpansion(store)[key({ kind: "goal", goalId: "parent" })], "collapsed");

		state.collapseSidebarTreeNode({ kind: "project", projectId: "default-expanded-project" });
		state.expandSidebarTreeNode({ kind: "project", projectId: "default-expanded-project" }, { explicit: false });
		assert.equal(state.isProjectExpanded("default-expanded-project"), false);
		assert.equal(storedExpansion(store)[key({ kind: "project", projectId: "default-expanded-project" })], "collapsed");

		state.setFirstClassParentExpanded("default-expanded-children", false);
		state.expandSidebarTreeNode({ kind: "session-children", sessionId: "default-expanded-children", childClass: "first-class" }, { explicit: false });
		assert.equal(state.isFirstClassParentExpanded("default-expanded-children"), false);
		assert.equal(storedExpansion(store)[key({ kind: "session-children", sessionId: "default-expanded-children", childClass: "first-class" })], "collapsed");

		state.expandSidebarTreeNode({ kind: "team-lead", sessionId: "default-expanded" }, { explicit: false });
		assert.equal(state.isTeamLeadExpanded("default-expanded"), true);
		assert.equal(storedExpansion(store)[key({ kind: "team-lead", sessionId: "default-expanded" })], undefined);

		state.expandSidebarTreeNode({ kind: "session-children", sessionId: "default-expanded-children-without-pref", childClass: "first-class" }, { explicit: false });
		assert.equal(state.isFirstClassParentExpanded("default-expanded-children-without-pref"), true);
		assert.equal(storedExpansion(store)[key({ kind: "session-children", sessionId: "default-expanded-children-without-pref", childClass: "first-class" })], undefined);

		state.expandSidebarTreeNode({ kind: "goal", goalId: "top-level" }, { explicit: false });
		assert.equal(state.isGoalExpanded("top-level"), true);
		assert.equal(storedExpansion(store)[key({ kind: "goal", goalId: "top-level" })], "expanded");
	});

	it("distinguishes live first-class/delegate and archived delegate defaults", async () => {
		const state = await importFresh("delegate-defaults");

		assert.equal(state.isFirstClassParentExpanded("session"), true);
		assert.equal(state.isSidebarTreeExpanded({ kind: "session-children", sessionId: "session", childClass: "first-class" }), true);
		assert.equal(state.isSidebarTreeExpanded({ kind: "session-children", sessionId: "session", childClass: "delegate" }), false);
		assert.equal(state.isArchivedParentExpanded("session"), false);
	});

	it("resets archived goal and session expansion preferences only", async () => {
		const { store } = installStorage();
		const state = await importFresh("reset-archived");

		state.setGoalExpanded("archived-goal", true);
		state.setGoalExpanded("live-goal", true);
		state.setTeamLeadExpanded("archived-session", false);
		state.setFirstClassParentExpanded("archived-session", false);
		state.setArchivedParentExpanded("archived-session", true);
		state.setArchivedParentExpanded("live-session", true);

		state.resetArchivedSidebarTreeExpansion({ archivedGoalIds: ["archived-goal"], archivedSessionIds: ["archived-session"] });

		assert.equal(state.getSidebarTreePreference({ kind: "goal", goalId: "archived-goal" }), undefined);
		assert.equal(state.isGoalExpanded("live-goal"), true);
		assert.equal(state.getSidebarTreePreference({ kind: "team-lead", sessionId: "archived-session" }), undefined);
		assert.equal(state.getSidebarTreePreference({ kind: "session-children", sessionId: "archived-session", childClass: "first-class" }), undefined);
		assert.equal(state.getSidebarTreePreference({ kind: "session-children", sessionId: "archived-session", childClass: "delegate" }), undefined);
		assert.equal(state.getSidebarTreePreference({ kind: "session-children", sessionId: "archived-session", childClass: "archived-delegate" }), undefined);
		assert.equal(state.isArchivedParentExpanded("live-session"), true);
		assert.equal(storedExpansion(store)[key({ kind: "goal", goalId: "archived-goal" })], undefined);
	});
});
