/**
 * Unit tests for the shared hierarchical-cascade framework — pure BFS
 * helper `walkGoalSubtree` and its async runner `cascadeSubtree`.
 *
 * These pin the contract documented in `src/server/agent/goal-subtree.ts`:
 * walk-through archived/filtered nodes, cycle defence, depth cap,
 * top-down vs bottom-up order, and partial-failure semantics.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	walkGoalSubtree,
	cascadeSubtree,
	SUBTREE_WALK_DEFAULT_DEPTH_CAP,
} from "../src/server/agent/goal-subtree.ts";
import type { PersistedGoal } from "../src/server/agent/goal-store.ts";

/**
 * Minimal helper to fabricate a PersistedGoal — the walk only reads
 * `id`, `parentGoalId`, `archived`, plus whatever fields the caller's
 * filter consults. Cast through unknown so the test stays decoupled
 * from PersistedGoal's full surface.
 */
function g(
	id: string,
	parentGoalId?: string,
	extra: Partial<PersistedGoal> = {},
): PersistedGoal {
	return { id, parentGoalId, ...extra } as unknown as PersistedGoal;
}

describe("walkGoalSubtree", () => {
	it("empty subtree: root only, includeRoot:true (default) returns [root]", () => {
		const goals = [g("root")];
		const out = walkGoalSubtree("root", goals);
		assert.deepEqual(out.map(x => x.id), ["root"]);
	});

	it("includeRoot:false returns []", () => {
		const goals = [g("root")];
		const out = walkGoalSubtree("root", goals, { includeRoot: false });
		assert.deepEqual(out, []);
	});

	it("linear chain top-down BFS order [root, A, B, C]", () => {
		const goals = [
			g("root"),
			g("A", "root"),
			g("B", "A"),
			g("C", "B"),
		];
		const out = walkGoalSubtree("root", goals);
		assert.deepEqual(out.map(x => x.id), ["root", "A", "B", "C"]);
	});

	it("branching BFS by depth band [root, A, B, C, D]", () => {
		const goals = [
			g("root"),
			g("A", "root"),
			g("B", "root"),
			g("C", "A"),
			g("D", "A"),
		];
		const out = walkGoalSubtree("root", goals);
		// depth 0: root; depth 1: A,B (insertion order); depth 2: C,D.
		assert.deepEqual(out.map(x => x.id), ["root", "A", "B", "C", "D"]);
	});

	it("archived walk-through: archived node excluded, but its live descendants included", () => {
		const goals = [
			g("root"),
			g("archA", "root", { archived: true }),
			g("liveB", "archA"),
		];
		const out = walkGoalSubtree("root", goals);
		assert.deepEqual(out.map(x => x.id), ["root", "liveB"]);
	});

	it("includeArchived:true returns the archived node too", () => {
		const goals = [
			g("root"),
			g("archA", "root", { archived: true }),
			g("liveB", "archA"),
		];
		const out = walkGoalSubtree("root", goals, { includeArchived: true });
		assert.deepEqual(out.map(x => x.id).sort(), ["archA", "liveB", "root"].sort());
	});

	it("maxDepth cap: chain of 40 → returns at most 32 (root + 31 descendants by default)", () => {
		const goals: PersistedGoal[] = [g("g0")];
		for (let i = 1; i < 40; i++) goals.push(g(`g${i}`, `g${i - 1}`));
		const out = walkGoalSubtree("g0", goals);
		// Cap counts BFS iterations from the root frontier; under the
		// default cap the walk must not exceed DEFAULT_DEPTH_CAP+1 entries.
		assert.ok(
			out.length <= SUBTREE_WALK_DEFAULT_DEPTH_CAP + 1,
			`expected <= ${SUBTREE_WALK_DEFAULT_DEPTH_CAP + 1}, got ${out.length}`,
		);
		// Sanity: the immediate child is first descendant.
		assert.equal(out[0].id, "g0");
		assert.equal(out[1].id, "g1");
	});

	it("cycle defence: direct self-parent does not hang", () => {
		const goals = [
			g("root", "root"), // pathological self-loop
			g("C", "root"),
		];
		const out = walkGoalSubtree("root", goals);
		assert.deepEqual(out.map(x => x.id).sort(), ["C", "root"].sort());
	});

	it("filter: filtered node not in output, but its children ARE walked", () => {
		const goals = [
			g("root"),
			g("hidden", "root", { state: "shelved" as PersistedGoal["state"] }),
			g("visible", "hidden"),
		];
		const out = walkGoalSubtree("root", goals, {
			filter: (n) => n.state !== "shelved",
		});
		assert.deepEqual(out.map(x => x.id), ["root", "visible"]);
	});
});

describe("cascadeSubtree", () => {
	it("linear chain bottom-up: apply called in [C, B, A, root] order", async () => {
		const goals = [
			g("root"),
			g("A", "root"),
			g("B", "A"),
			g("C", "B"),
		];
		const visited: string[] = [];
		const result = await cascadeSubtree("root", goals, {}, {
			order: "bottom-up",
			apply: async (n) => { visited.push(n.id); return n.id; },
		});
		assert.deepEqual(visited, ["C", "B", "A", "root"]);
		assert.equal(result.errors.length, 0);
		assert.equal(result.processed.length, 4);
	});

	it("apply error collected, walk continues (default stopOnError:false)", async () => {
		const goals = [
			g("root"),
			g("A", "root"),
			g("B", "root"),
		];
		const visited: string[] = [];
		const result = await cascadeSubtree("root", goals, {}, {
			order: "top-down",
			apply: async (n) => {
				visited.push(n.id);
				if (n.id === "A") throw new Error("boom-A");
				return n.id;
			},
		});
		// All three were visited — error did not stop the walk.
		assert.deepEqual(visited.sort(), ["A", "B", "root"].sort());
		assert.equal(result.processed.length, 2);
		assert.equal(result.errors.length, 1);
		assert.equal(result.errors[0].goalId, "A");
		assert.match(result.errors[0].error.message, /boom-A/);
	});

	it("stopOnError:true stops after first error", async () => {
		const goals = [
			g("root"),
			g("A", "root"),
			g("B", "root"),
		];
		const visited: string[] = [];
		await cascadeSubtree("root", goals, {}, {
			order: "top-down",
			stopOnError: true,
			apply: async (n) => {
				visited.push(n.id);
				if (n.id === "root") throw new Error("boom-root");
				return n.id;
			},
		});
		assert.deepEqual(visited, ["root"]);
	});
});
