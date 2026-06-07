/**
 * Unit tests for `collectDescendants` — pure BFS helper that powers
 * `GET /api/goals/:id/descendants`.
 *
 * Covers: simple parent+child, multi-level nesting, no descendants,
 * malformed cycle defence (depth cap), and the case where the root
 * itself is not present in the input list.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	collectDescendants,
	DESCENDANT_WALK_DEPTH_CAP,
	type DescendantWalkGoal,
} from "../src/server/agent/goal-descendants.ts";

interface G extends DescendantWalkGoal {
	id: string;
	parentGoalId?: string;
	title?: string;
}

describe("collectDescendants", () => {
	it("returns the single child of a simple parent → child relationship", () => {
		const goals: G[] = [
			{ id: "P" },
			{ id: "C", parentGoalId: "P" },
		];
		const out = collectDescendants("P", goals);
		assert.equal(out.length, 1);
		assert.equal(out[0].id, "C");
	});

	it("does NOT include the root itself", () => {
		const goals: G[] = [
			{ id: "P" },
			{ id: "C1", parentGoalId: "P" },
			{ id: "C2", parentGoalId: "P" },
		];
		const out = collectDescendants("P", goals);
		assert.deepEqual(new Set(out.map(g => g.id)), new Set(["C1", "C2"]));
	});

	it("walks multi-level descendants (depth 3)", () => {
		const goals: G[] = [
			{ id: "P" },
			{ id: "C", parentGoalId: "P" },
			{ id: "GC", parentGoalId: "C" },
			{ id: "GGC", parentGoalId: "GC" },
		];
		const out = collectDescendants("P", goals);
		assert.deepEqual(new Set(out.map(g => g.id)), new Set(["C", "GC", "GGC"]));
	});

	it("excludes unrelated goals", () => {
		const goals: G[] = [
			{ id: "P" },
			{ id: "C", parentGoalId: "P" },
			{ id: "OTHER" },
			{ id: "OTHER_C", parentGoalId: "OTHER" },
		];
		const out = collectDescendants("P", goals);
		assert.deepEqual(out.map(g => g.id), ["C"]);
	});

	it("returns [] when goal has no descendants", () => {
		const goals: G[] = [
			{ id: "P" },
			{ id: "OTHER" },
		];
		const out = collectDescendants("P", goals);
		assert.deepEqual(out, []);
	});

	it("returns [] when root is not present in the input list", () => {
		const goals: G[] = [
			{ id: "A" },
			{ id: "B", parentGoalId: "A" },
		];
		const out = collectDescendants("MISSING", goals);
		assert.deepEqual(out, []);
	});

	it("returns [] when rootId is empty string", () => {
		const goals: G[] = [
			{ id: "A" },
			{ id: "B", parentGoalId: "A" },
		];
		const out = collectDescendants("", goals);
		assert.deepEqual(out, []);
	});

	it("defends against direct self-cycle (parent === self)", () => {
		const goals: G[] = [
			{ id: "P", parentGoalId: "P" }, // pathological self-loop
			{ id: "C", parentGoalId: "P" },
		];
		const out = collectDescendants("P", goals);
		// P is the root and is excluded; only C is reported.
		assert.deepEqual(out.map(g => g.id), ["C"]);
	});

	it("defends against indirect cycle (A → B → A)", () => {
		const goals: G[] = [
			{ id: "A", parentGoalId: "B" },
			{ id: "B", parentGoalId: "A" },
		];
		// Walk from A: child = B. B's "child" would be A, which is `seen` → skipped.
		const out = collectDescendants("A", goals);
		assert.deepEqual(out.map(g => g.id), ["B"]);
	});

	it("does not traverse deeper than the depth cap on malformed chains", () => {
		// Build a long chain: g0 → g1 → g2 → ... so depth = i.
		// Walk should yield exactly DESCENDANT_WALK_DEPTH_CAP descendants
		// (one per BFS step).
		const goals: G[] = [];
		const total = DESCENDANT_WALK_DEPTH_CAP + 10;
		for (let i = 0; i < total; i++) {
			goals.push({ id: `g${i}`, parentGoalId: i > 0 ? `g${i - 1}` : undefined });
		}
		const out = collectDescendants("g0", goals);
		// At most DESCENDANT_WALK_DEPTH_CAP descendants are visited.
		assert.ok(
			out.length <= DESCENDANT_WALK_DEPTH_CAP,
			`expected <= ${DESCENDANT_WALK_DEPTH_CAP} descendants, got ${out.length}`,
		);
		// And the first descendant returned is the immediate child.
		assert.equal(out[0].id, "g1");
	});

	it("returns full goal records (preserves caller's extra fields)", () => {
		interface RichGoal extends DescendantWalkGoal {
			id: string;
			parentGoalId?: string;
			title: string;
			archived: boolean;
		}
		const goals: RichGoal[] = [
			{ id: "P", title: "parent", archived: false },
			{ id: "C", parentGoalId: "P", title: "child", archived: true },
		];
		const out = collectDescendants("P", goals);
		assert.equal(out.length, 1);
		assert.equal(out[0].title, "child");
		assert.equal(out[0].archived, true);
	});
});
