/**
 * Unit tests for `GoalStore` nested-goals additions:
 *   - Lazy migration of legacy persisted goals (rootGoalId, mergeTarget defaults)
 *   - Secondary indexes (childrenByParent, byRoot)
 *   - getChildren / getDescendants / getAncestors / isDescendantOf helpers
 *
 * See `docs/design/nested-goals.md` §1.1, §1.2, §1.4.
 *
 * Filename note: written as `*.test.ts` (not `*.spec.ts`) to run under
 * `tsx --test` against `src/` — matches the precedent set by
 * `tests/inline-workflow-load.test.ts`. The task spec named the file
 * `*.spec.ts` but `.spec.ts` files run through Playwright against `dist/`
 * and require `npm run build:server` first, which is the wrong harness for
 * a pure-source node:test unit test.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";

let stateDir: string;

beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-store-nesting-"));
});

function writeGoals(goals: unknown[]): void {
	fs.writeFileSync(path.join(stateDir, "goals.json"), JSON.stringify(goals, null, 2));
}

function makeGoal(overrides: Partial<PersistedGoal> & { id: string }): PersistedGoal {
	return {
		title: overrides.title ?? `Goal ${overrides.id}`,
		cwd: "/tmp",
		state: "todo",
		spec: "",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as PersistedGoal;
}

describe("GoalStore lazy migration (design §1.4)", () => {
	it("applies rootGoalId = id and mergeTarget = master to a top-level legacy goal", () => {
		writeGoals([
			{ id: "g1", title: "legacy", cwd: "/tmp", state: "todo", spec: "", createdAt: 1, updatedAt: 1 },
		]);
		const store = new GoalStore(stateDir);
		const g = store.get("g1");
		assert.ok(g);
		assert.equal(g.rootGoalId, "g1");
		assert.equal(g.mergeTarget, "master");
		assert.equal(g.parentGoalId, undefined);
	});

	it("does NOT rewrite the persisted file just because of lazy defaults", () => {
		const original = [
			{ id: "g1", title: "legacy", cwd: "/tmp", state: "todo", spec: "", createdAt: 1, updatedAt: 1 },
		];
		writeGoals(original);
		const beforeMtime = fs.statSync(path.join(stateDir, "goals.json")).mtimeMs;
		// Wait long enough that mtimeMs would change if rewritten
		const start = Date.now();
		while (Date.now() - start < 20) { /* spin */ }
		const _store = new GoalStore(stateDir);
		const afterMtime = fs.statSync(path.join(stateDir, "goals.json")).mtimeMs;
		assert.equal(beforeMtime, afterMtime, "load() must not rewrite the persisted file");
	});

	it("backfills rootGoalId for a child whose record lacks it on disk", () => {
		writeGoals([
			{ id: "root", title: "r", cwd: "/tmp", state: "todo", spec: "", createdAt: 1, updatedAt: 1 },
			{ id: "child", title: "c", cwd: "/tmp", state: "todo", spec: "", createdAt: 2, updatedAt: 2, parentGoalId: "root" },
		]);
		const store = new GoalStore(stateDir);
		const child = store.get("child");
		assert.ok(child);
		assert.equal(child.rootGoalId, "root");
		assert.equal(child.mergeTarget, "parent", "child without explicit mergeTarget defaults to parent");
	});

	it("preserves explicit mergeTarget = master on a top-level goal", () => {
		writeGoals([
			{ id: "g1", title: "x", cwd: "/tmp", state: "todo", spec: "", createdAt: 1, updatedAt: 1, mergeTarget: "master" },
		]);
		const store = new GoalStore(stateDir);
		assert.equal(store.get("g1")?.mergeTarget, "master");
	});

	it("does not touch existing nested-goals fields on goals that already have them", () => {
		writeGoals([
			{
				id: "root",
				title: "r",
				cwd: "/tmp",
				state: "todo",
				spec: "",
				createdAt: 1,
				updatedAt: 1,
				rootGoalId: "root",
				mergeTarget: "master",
				divergencePolicy: "balanced",
				maxConcurrentChildren: 5,
				replanCount: 2,
				paused: true,
			},
		]);
		const store = new GoalStore(stateDir);
		const g = store.get("root");
		assert.equal(g?.divergencePolicy, "balanced");
		assert.equal(g?.maxConcurrentChildren, 5);
		assert.equal(g?.replanCount, 2);
		assert.equal(g?.paused, true);
	});

	it("still applies the swarm → team and skipArtifactRequirements legacy migrations", () => {
		writeGoals([
			{ id: "g1", title: "x", cwd: "/tmp", state: "todo", spec: "", createdAt: 1, updatedAt: 1, swarm: true, skipArtifactRequirements: ["a"] },
		]);
		const store = new GoalStore(stateDir);
		const g = store.get("g1") as PersistedGoal & { swarm?: boolean; skipArtifactRequirements?: unknown };
		assert.equal(g.team, true);
		assert.equal(g.swarm, undefined);
		assert.deepEqual(g.skipGateRequirements, ["a"]);
		assert.equal(g.skipArtifactRequirements, undefined);
	});
});

describe("GoalStore secondary indexes (design §1.2)", () => {
	it("getChildren returns immediate children sorted by createdAt ASC", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "root", rootGoalId: "root", mergeTarget: "master" }));
		store.put(makeGoal({ id: "c2", parentGoalId: "root", rootGoalId: "root", mergeTarget: "parent", createdAt: 200 }));
		store.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root", mergeTarget: "parent", createdAt: 100 }));
		const kids = store.getChildren("root");
		assert.deepEqual(kids.map(g => g.id), ["c1", "c2"]);
	});

	it("getChildren returns [] for an unknown parent", () => {
		const store = new GoalStore(stateDir);
		assert.deepEqual(store.getChildren("nope"), []);
	});

	it("getDescendants returns the entire subtree including the root", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "root", rootGoalId: "root", createdAt: 1 }));
		store.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root", createdAt: 2 }));
		store.put(makeGoal({ id: "c2", parentGoalId: "root", rootGoalId: "root", createdAt: 3 }));
		store.put(makeGoal({ id: "gc1", parentGoalId: "c1", rootGoalId: "root", createdAt: 4 }));
		store.put(makeGoal({ id: "gc2", parentGoalId: "c1", rootGoalId: "root", createdAt: 5 }));
		const descs = store.getDescendants("root");
		assert.deepEqual(descs.map(g => g.id), ["root", "c1", "c2", "gc1", "gc2"]);
	});

	it("getDescendants returns [] for an unknown root", () => {
		const store = new GoalStore(stateDir);
		assert.deepEqual(store.getDescendants("missing"), []);
	});

	it("getAncestors returns the chain root-first, excluding the starting goal", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "gc1", parentGoalId: "c1", rootGoalId: "root" }));
		store.put(makeGoal({ id: "ggc1", parentGoalId: "gc1", rootGoalId: "root" }));
		const ancestors = store.getAncestors("ggc1");
		assert.deepEqual(ancestors.map(g => g.id), ["root", "c1", "gc1"]);
	});

	it("getAncestors returns [] for a top-level goal", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "root", rootGoalId: "root" }));
		assert.deepEqual(store.getAncestors("root"), []);
	});

	it("getAncestors returns [] for an unknown goal", () => {
		const store = new GoalStore(stateDir);
		assert.deepEqual(store.getAncestors("missing"), []);
	});

	it("isDescendantOf returns true for a transitive descendant", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "gc1", parentGoalId: "c1", rootGoalId: "root" }));
		assert.equal(store.isDescendantOf("gc1", "root"), true);
		assert.equal(store.isDescendantOf("c1", "root"), true);
	});

	it("isDescendantOf returns false for the goal itself or unrelated goals", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "other", rootGoalId: "other" }));
		assert.equal(store.isDescendantOf("root", "root"), false);
		assert.equal(store.isDescendantOf("c1", "other"), false);
		assert.equal(store.isDescendantOf("root", "c1"), false);
	});

	it("indexes are maintained on remove()", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "c2", parentGoalId: "root", rootGoalId: "root" }));
		assert.equal(store.getChildren("root").length, 2);
		store.remove("c1");
		assert.deepEqual(store.getChildren("root").map(g => g.id), ["c2"]);
		assert.deepEqual(store.getDescendants("root").map(g => g.id).sort(), ["c2", "root"]);
	});

	it("indexes are maintained on update() when parentGoalId / rootGoalId change", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "rootA", rootGoalId: "rootA" }));
		store.put(makeGoal({ id: "rootB", rootGoalId: "rootB" }));
		store.put(makeGoal({ id: "x", parentGoalId: "rootA", rootGoalId: "rootA" }));
		assert.deepEqual(store.getChildren("rootA").map(g => g.id), ["x"]);
		assert.deepEqual(store.getChildren("rootB"), []);

		// Re-parent x onto rootB (theoretical — re-parenting isn't supported
		// at the application level but the index must still react correctly).
		store.update("x", { parentGoalId: "rootB", rootGoalId: "rootB" });

		assert.deepEqual(store.getChildren("rootA"), []);
		assert.deepEqual(store.getChildren("rootB").map(g => g.id), ["x"]);
		assert.deepEqual(store.getDescendants("rootB").map(g => g.id).sort(), ["rootB", "x"]);
		assert.deepEqual(store.getDescendants("rootA").map(g => g.id), ["rootA"]);
	});

	it("archived goals stay in indexes (live/archived filter is read-time)", () => {
		const store = new GoalStore(stateDir);
		store.put(makeGoal({ id: "root", rootGoalId: "root" }));
		store.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root" }));
		store.archive("c1");
		assert.deepEqual(store.getChildren("root").map(g => g.id), ["c1"], "archived goal still appears");
		assert.deepEqual(store.getDescendants("root").map(g => g.id).sort(), ["c1", "root"]);
	});

	it("indexes survive a load() round-trip from disk", () => {
		// First store creates the goals
		{
			const store = new GoalStore(stateDir);
			store.put(makeGoal({ id: "root", rootGoalId: "root", createdAt: 1 }));
			store.put(makeGoal({ id: "c1", parentGoalId: "root", rootGoalId: "root", createdAt: 2 }));
			store.put(makeGoal({ id: "gc1", parentGoalId: "c1", rootGoalId: "root", createdAt: 3 }));
		}
		// Second store reads from disk and rebuilds indexes
		const reloaded = new GoalStore(stateDir);
		assert.deepEqual(reloaded.getChildren("root").map(g => g.id), ["c1"]);
		assert.deepEqual(reloaded.getChildren("c1").map(g => g.id), ["gc1"]);
		assert.deepEqual(reloaded.getDescendants("root").map(g => g.id), ["root", "c1", "gc1"]);
		assert.deepEqual(reloaded.getAncestors("gc1").map(g => g.id), ["root", "c1"]);
	});
});
