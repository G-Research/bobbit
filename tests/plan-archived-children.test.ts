/**
 * Plan tab — archived/completed children inclusion.
 *
 * Pins the contract that the Plan-tab data layer
 * (`computePlanStepsForGoal`) and the descendant-walk helper
 * (`collectDescendants`) BOTH include archived and completed children
 * by default. The historical bug (subgoals cb75426e / 4581f8a5) flipped
 * a filter from "all" to "live only" so dozens of merged/archived
 * children silently vanished from the Plan tab.
 *
 * Cases:
 *  - default includes archived
 *  - default includes complete
 *  - liveOnly:true excludes archived
 *  - liveOnly:true keeps live in-progress / blocked
 *  - collectDescendants includes archived descendants
 *
 * Every assertion uses the word `archived` in the case name so
 * future agents can grep `archived` and locate the contract.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Module-load shims: `goal-dashboard-plan-tab.ts` transitively imports
// `state.ts`, which touches localStorage at module init. Polyfill before
// importing the module under test (same pattern as proposal-helpers.test.ts).
function makeFakeStorage() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => { m.set(k, v); },
		removeItem: (k: string) => { m.delete(k); },
		clear: () => { m.clear(); },
	};
}
(globalThis as any).localStorage = makeFakeStorage();
(globalThis as any).window ??= { location: { origin: "http://localhost" }, addEventListener: () => {} };
// lit-html (transitively imported by goal-dashboard-plan-tab.ts) calls
// document.createTreeWalker at module init. Stub the methods it needs so
// the import resolves without a real DOM.
const _treeWalkerStub = { nextNode: () => null, currentNode: null as any, firstChild: () => null, nextSibling: () => null };
const _createElementStub = (): any => ({
	content: { firstChild: null, appendChild: () => {}, childNodes: [] },
	innerHTML: "",
	appendChild: () => {},
	setAttribute: () => {},
});
(globalThis as any).document ??= {
	documentElement: { dataset: {}, style: { setProperty: () => {} } },
	createTreeWalker: () => _treeWalkerStub,
	createElement: _createElementStub,
	createElementNS: _createElementStub,
	createDocumentFragment: () => ({ appendChild: () => {}, childNodes: [] }),
	createTextNode: (t: string) => ({ data: t, nodeValue: t }),
	createComment: () => ({}),
	addEventListener: () => {},
	dispatchEvent: () => {},
};

const planTab = await import("../src/app/goal-dashboard-plan-tab.ts");
const computePlanStepsForGoal = planTab.computePlanStepsForGoal;
const { collectDescendants } = await import("../src/server/agent/goal-descendants.ts");
type Goal = import("../src/app/state.ts").Goal;

function goal(over: Partial<Goal> & { id: string; title: string }): Goal {
	return {
		id: over.id,
		title: over.title,
		cwd: over.cwd ?? "/tmp/x",
		state: over.state ?? "todo",
		spec: over.spec ?? "x",
		createdAt: over.createdAt ?? 0,
		updatedAt: over.updatedAt ?? 0,
		parentGoalId: over.parentGoalId,
		rootGoalId: over.rootGoalId,
		spawnedFromPlanId: over.spawnedFromPlanId,
		archived: over.archived,
		archivedAt: over.archivedAt,
		paused: over.paused,
	} as Goal;
}

describe("computePlanStepsForGoal — archived children visibility", () => {
	const parent: Goal = goal({ id: "P", title: "Parent" });
	const liveInProgress: Goal = goal({
		id: "live-ip",
		title: "Live in-progress",
		parentGoalId: "P",
		spawnedFromPlanId: "p-live-ip",
		state: "in-progress",
		createdAt: 1,
	});
	const archivedComplete: Goal = goal({
		id: "archived-complete",
		title: "Archived complete child",
		parentGoalId: "P",
		spawnedFromPlanId: "p-archived",
		state: "complete",
		archived: true,
		archivedAt: 1234,
		createdAt: 2,
	});
	const liveBlocked: Goal = goal({
		id: "live-blocked",
		title: "Live blocked",
		parentGoalId: "P",
		spawnedFromPlanId: "p-blocked",
		state: "blocked",
		createdAt: 3,
	});
	// Completed (NOT archived) — the liveOnly filter must hide this too,
	// not just archived children. The button is labelled "Live only" so
	// terminal-state children (complete/shelved) must NOT remain.
	const completedLive: Goal = goal({
		id: "completed-live",
		title: "Completed (not archived)",
		parentGoalId: "P",
		spawnedFromPlanId: "p-completed-live",
		state: "complete",
		createdAt: 4,
	});
	const shelvedLive: Goal = goal({
		id: "shelved-live",
		title: "Shelved (not archived)",
		parentGoalId: "P",
		spawnedFromPlanId: "p-shelved-live",
		state: "shelved",
		createdAt: 5,
	});
	const allGoals: Goal[] = [parent, liveInProgress, archivedComplete, liveBlocked, completedLive, shelvedLive];

	it("default (no opts) INCLUDES archived child in plan steps", () => {
		const steps = computePlanStepsForGoal(parent, allGoals);
		const planIds = steps.map(s => s.planId);
		assert.ok(planIds.includes("p-archived"),
			`expected archived child planId in steps; got ${JSON.stringify(planIds)}`);
		assert.ok(planIds.includes("p-live-ip"));
		assert.ok(planIds.includes("p-blocked"));
		assert.ok(planIds.includes("p-completed-live"),
			"completed (non-archived) child must appear by default");
		assert.ok(planIds.includes("p-shelved-live"),
			"shelved (non-archived) child must appear by default");
		assert.equal(steps.length, 5, "all five direct children should appear by default");
	});

	it("default (no opts) INCLUDES completed child in plan steps", () => {
		// Same fixture covers this — archivedComplete is both archived AND
		// state==="complete". An additional non-archived complete child is
		// not strictly needed but is asserted to pin the semantics: state
		// must not filter on its own.
		const liveComplete: Goal = goal({
			id: "live-complete",
			title: "Completed (not archived)",
			parentGoalId: "P",
			spawnedFromPlanId: "p-live-complete",
			state: "complete",
			createdAt: 4,
		});
		const goals = [parent, liveInProgress, liveComplete];
		const steps = computePlanStepsForGoal(parent, goals);
		const planIds = steps.map(s => s.planId);
		assert.ok(planIds.includes("p-live-complete"),
			"completed (non-archived) child must appear in default plan");
	});

	it("liveOnly:true EXCLUDES archived AND completed/terminal children, keeps only live", () => {
		const steps = computePlanStepsForGoal(parent, allGoals, { liveOnly: true } as any);
		const planIds = steps.map(s => s.planId);
		assert.ok(!planIds.includes("p-archived"),
			`liveOnly:true must exclude archived child; got ${JSON.stringify(planIds)}`);
		assert.ok(!planIds.includes("p-completed-live"),
			`liveOnly:true must ALSO exclude completed (non-archived) child; got ${JSON.stringify(planIds)}`);
		assert.ok(!planIds.includes("p-shelved-live"),
			`liveOnly:true must ALSO exclude shelved (non-archived) child; got ${JSON.stringify(planIds)}`);
		assert.ok(planIds.includes("p-live-ip"), "liveOnly:true must keep live in-progress");
		assert.ok(planIds.includes("p-blocked"), "liveOnly:true must keep live blocked");
		assert.equal(steps.length, 2, "liveOnly:true must leave exactly the two live children (in-progress + blocked)");
	});

	it("liveOnly:true keeps a todo child (todo is a live, non-terminal state)", () => {
		const todoChild: Goal = goal({
			id: "todo-child",
			title: "Todo child",
			parentGoalId: "P",
			spawnedFromPlanId: "p-todo",
			state: "todo",
			createdAt: 6,
		});
		const goals = [parent, todoChild, completedLive, archivedComplete];
		const steps = computePlanStepsForGoal(parent, goals, { liveOnly: true } as any);
		const planIds = steps.map(s => s.planId);
		assert.ok(planIds.includes("p-todo"), "liveOnly:true must keep todo child");
		assert.ok(!planIds.includes("p-completed-live"));
		assert.ok(!planIds.includes("p-archived"));
		assert.equal(steps.length, 1);
	});

	it("liveOnly:false explicitly is equivalent to default — archived child still INCLUDED", () => {
		const steps = computePlanStepsForGoal(parent, allGoals, { liveOnly: false } as any);
		const planIds = steps.map(s => s.planId);
		assert.ok(planIds.includes("p-archived"),
			"liveOnly:false must NOT hide archived child");
	});
});

describe("collectDescendants — archived descendants inclusion", () => {
	it("INCLUDES archived descendants by default (no opts to opt out)", () => {
		const goals = [
			{ id: "P" },
			{ id: "live-child", parentGoalId: "P", archived: false },
			{ id: "archived-child", parentGoalId: "P", archived: true },
			{ id: "archived-grandchild", parentGoalId: "archived-child", archived: true },
		];
		const out = collectDescendants("P", goals);
		const ids = new Set(out.map(g => g.id));
		assert.ok(ids.has("archived-child"),
			"archived direct child must appear in collectDescendants output");
		assert.ok(ids.has("archived-grandchild"),
			"archived grandchild (descendant of archived child) must appear");
		assert.ok(ids.has("live-child"));
		assert.equal(out.length, 3, "all three descendants should be returned");
	});
});
