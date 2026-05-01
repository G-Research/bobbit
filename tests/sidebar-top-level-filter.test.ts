/**
 * Pinned regression: child goals appearing at the project root in the
 * sidebar in addition to under their parent ("Anna Lytics" team-lead
 * showing both nested under Brisket and as a sibling at the top of the
 * project tree).
 *
 * `renderGoalGroup` recurses into children via `getChildGoals` \u2014 the
 * top-level `goals.map(renderGoalGroup)` must therefore see only goals
 * with `parentGoalId === undefined`, otherwise children render twice.
 *
 * `filterTopLevelGoals(goals)` is the single resolution rule used by
 * every sidebar entry point (desktop expanded, desktop collapsed,
 * mobile, archived-by-project bucketing). Pure / sort-preserving.
 *
 * Pinned cases:
 *   - empty list \u2192 empty list
 *   - all top-level (no parentGoalId) \u2192 unchanged
 *   - mixed parents + children \u2192 only parents kept
 *   - child of a child (deeply nested) \u2192 dropped at the top level\n *     (any non-empty `parentGoalId` is filtered, regardless of depth)\n *   - sort order preserved\n *   - parentGoalId = empty string treated as falsy (top-level)\n *   - shape robustness against extra fields\n */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { filterTopLevelGoals } from "../src/app/sidebar-nesting.ts";

// Local Goal-like type — we deliberately avoid importing from
// `src/app/state.ts` (and the Lit/DOM transitive deps it pulls in via
// `render-helpers.ts`) so this unit file runs cleanly under tsx's
// node-test runner without any browser shims.
interface Goal {
	id: string;
	title: string;
	state: string;
	archived: boolean;
	createdAt: number;
	updatedAt: number;
	spec: string;
	cwd: string;
	projectId: string;
	parentGoalId?: string;
}

function makeGoal(partial: Partial<Goal> & { id: string; title: string }): Goal {
	return {
		id: partial.id,
		title: partial.title,
		state: partial.state ?? "in-progress",
		archived: partial.archived ?? false,
		createdAt: partial.createdAt ?? Date.now(),
		updatedAt: partial.updatedAt ?? Date.now(),
		spec: partial.spec ?? "",
		cwd: partial.cwd ?? "/tmp",
		projectId: partial.projectId ?? "p1",
		// parentGoalId omitted unless explicitly set
		...partial,
	} as Goal;
}

describe("filterTopLevelGoals", () => {
	it("returns an empty list when given an empty list", () => {
		assert.deepEqual(filterTopLevelGoals([]), []);
	});

	it("returns all goals unchanged when none have a parentGoalId", () => {
		const goals = [
			makeGoal({ id: "g1", title: "Top-level A" }),
			makeGoal({ id: "g2", title: "Top-level B" }),
			makeGoal({ id: "g3", title: "Top-level C" }),
		];
		const result = filterTopLevelGoals(goals);
		assert.equal(result.length, 3);
		assert.deepEqual(result.map(g => g.id), ["g1", "g2", "g3"]);
	});

	it("drops children of any parent (the headline regression case)", () => {
		// This is the exact agent-memory bucket: parent goal "Brisket"
		// has child "Anna Lytics", and "Anna Lytics" was rendered both
		// nested under Brisket and as a top-level sibling.
		const parent = makeGoal({ id: "brisket", title: "Build agent-memory v1.0" });
		const child1 = makeGoal({ id: "anna-1", title: "v0.1 Foundation", parentGoalId: "brisket" });
		const child2 = makeGoal({ id: "anna-2", title: "v0.1 Foundation #2", parentGoalId: "brisket" });
		const goals = [parent, child1, child2];

		const result = filterTopLevelGoals(goals);
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "brisket");
	});

	it("drops grandchildren and any deeper descendant (any non-empty parentGoalId is filtered)", () => {
		const parent = makeGoal({ id: "p1", title: "Parent" });
		const child = makeGoal({ id: "c1", title: "Child", parentGoalId: "p1" });
		const grandchild = makeGoal({ id: "gc1", title: "Grandchild", parentGoalId: "c1" });
		const greatGrandchild = makeGoal({ id: "ggc1", title: "Great-Grandchild", parentGoalId: "gc1" });
		const goals = [parent, child, grandchild, greatGrandchild];

		const result = filterTopLevelGoals(goals);
		assert.deepEqual(result.map(g => g.id), ["p1"]);
	});

	it("preserves the input sort order on the kept goals", () => {
		// Caller passes goals already sorted by createdAt; the helper must
		// not reorder.
		const a = makeGoal({ id: "a", title: "A", createdAt: 1000 });
		const child = makeGoal({ id: "c", title: "C", createdAt: 1500, parentGoalId: "a" });
		const b = makeGoal({ id: "b", title: "B", createdAt: 2000 });
		const goals = [a, child, b];

		const result = filterTopLevelGoals(goals);
		assert.deepEqual(result.map(g => g.id), ["a", "b"]);
	});

	it("treats parentGoalId='' (empty string) as falsy / top-level", () => {
		// Defensive: server should never emit empty strings, but the UI
		// shouldn't crash if it does. JavaScript truthiness on the empty
		// string is `false`, so an empty parentGoalId looks top-level to
		// the existing render-helpers `g.parentGoalId === parentId` check
		// elsewhere; we mirror that here.
		const top = makeGoal({ id: "top", title: "Top", parentGoalId: "" });
		const result = filterTopLevelGoals([top]);
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "top");
	});

	it("ignores extra goal fields (only `parentGoalId` is read)", () => {
		// Defence in depth: if Goal grows new fields, the filter must
		// remain stable.
		const g1 = makeGoal({ id: "g1", title: "Top" }) as any;
		g1.brandNewField = "ignored";
		g1.someArrayField = [1, 2, 3];
		const g2 = makeGoal({ id: "g2", title: "Child", parentGoalId: "g1" }) as any;
		g2.unrelated = { nested: { deeply: true } };

		const result = filterTopLevelGoals([g1, g2]);
		assert.deepEqual(result.map(g => g.id), ["g1"]);
	});

	it("does NOT mutate the input array", () => {
		const goals = [
			makeGoal({ id: "p", title: "Parent" }),
			makeGoal({ id: "c", title: "Child", parentGoalId: "p" }),
		];
		const before = goals.map(g => g.id);
		filterTopLevelGoals(goals);
		const after = goals.map(g => g.id);
		assert.deepEqual(before, after);
	});

	it("returns a NEW array (not a reference to the input)", () => {
		const goals = [makeGoal({ id: "p", title: "Parent" })];
		const result = filterTopLevelGoals(goals);
		assert.notEqual(result, goals);
		assert.deepEqual(result.map(g => g.id), ["p"]);
	});
});
