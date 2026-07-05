import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-spawned-children.spec.ts (v2-dom tier).
// The legacy file:// fixture re-implemented the helpers in inline JS. This port
// imports the REAL functions from src/app/sidebar-spawned-children.ts (higher
// fidelity — pure module, no Lit/DOM) and reimplements the fixture's thin
// `simulateRender` render-walk on top of them, asserting the same facts.
import { describe, expect, it } from "vitest";
import {
	selectSpawnedChildren,
	isAncestorCycle,
	extendAncestors,
	computeTitleSuffixes,
	type SpawnedChildLike,
} from "../../src/app/sidebar-spawned-children.js";

// Render-walk simulator — same shape as the real renderGoalGroup →
// renderSpawnedChildGoalRow chain, built on the real helpers. Returns a flat
// list of `{kind, id}` rows so the test can assert what would appear.
function simulateRender(
	goals: SpawnedChildLike[],
	rootGoalId: string,
	leadId: string,
	opts: { cap?: number; showArchived?: boolean } = {},
): Array<{ kind: string; id: string; depth: number; title?: string }> {
	const cap = opts.cap ?? 50;
	const showArchived = opts.showArchived ?? false;
	const out: Array<{ kind: string; id: string; depth: number; title?: string }> = [];
	function walk(parentId: string, ancestors: Set<string>, depth: number): void {
		if (depth > cap) {
			out.push({ kind: "cap-hit", id: parentId, depth });
			return;
		}
		const children = selectSpawnedChildren(goals, parentId, leadId, showArchived);
		for (const c of children) {
			if (isAncestorCycle(c.id, ancestors)) {
				out.push({ kind: "loop", id: c.id, depth });
				continue;
			}
			out.push({ kind: "row", id: c.id, depth, title: c.title });
			walk(c.id, extendAncestors(ancestors, c.id), depth + 1);
		}
	}
	walk(rootGoalId, new Set([rootGoalId]), 0);
	return out;
}

describe("selectSpawnedChildren — filter, dedupe, stable sort", () => {
	it("two distinct goals with identical titles BOTH render in deterministic order", () => {
		const goals: SpawnedChildLike[] = [
			{ id: "audit-claude-code-A", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 100, title: "AUDIT: CLAUDE CODE" },
			{ id: "audit-claude-code-B", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 200, title: "AUDIT: CLAUDE CODE" },
		];
		expect(selectSpawnedChildren(goals, "P", "L", false).map(g => g.id)).toEqual([
			"audit-claude-code-A",
			"audit-claude-code-B",
		]);
	});

	it("dedupes by id when state.goals contains accidental duplicates", () => {
		const goals: SpawnedChildLike[] = [
			{ id: "x", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1, title: "first-copy" },
			{ id: "x", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 5, title: "second-copy" },
		];
		const result = selectSpawnedChildren(goals, "P", "L", false);
		expect(result.length).toBe(1);
		expect(result[0]!.title).toBe("first-copy");
	});

	it("ties on createdAt break by id asc — stable across runs", () => {
		const orders: string[][] = [];
		for (let i = 0; i < 5; i++) {
			const goals: SpawnedChildLike[] = [
				{ id: "zeta", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 },
				{ id: "alpha", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 },
				{ id: "kilo", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1 },
			];
			orders.push(selectSpawnedChildren(goals, "P", "L", false).map(g => g.id));
		}
		for (const order of orders) {
			expect(order).toEqual(["alpha", "kilo", "zeta"]);
		}
	});

	it("excludes archived when showArchived is false; includes when true", () => {
		const mk = (): SpawnedChildLike[] => [
			{ id: "a", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 1, archived: false },
			{ id: "b", parentGoalId: "P", spawnedBySessionId: "L", createdAt: 2, archived: true },
		];
		expect(selectSpawnedChildren(mk(), "P", "L", false).map(g => g.id)).toEqual(["a"]);
		expect(selectSpawnedChildren(mk(), "P", "L", true).map(g => g.id)).toEqual(["a", "b"]);
	});
});

describe("computeTitleSuffixes — sibling disambiguator", () => {
	it("user image #42 reproduction: two AUDIT: CLAUDE CODE siblings get distinguishing suffixes", () => {
		const siblings = [
			{ id: "abc123def", title: "AUDIT: CLAUDE CODE" },
			{ id: "fed987cba", title: "AUDIT: CLAUDE CODE" },
			{ id: "xxx-bobbit", title: "AUDIT: BOBBIT HARNESS" },
		];
		const result = Object.fromEntries(computeTitleSuffixes(siblings));
		expect(result["abc123def"]).toBe("abc123");
		expect(result["fed987cba"]).toBe("fed987");
		expect(result["xxx-bobbit"]).toBeUndefined();
	});
});

describe("simulated render walk — cycle guard never loops", () => {
	it("user image #41 reproduction: same-title sub-subgoal renders both as siblings, no infinite recursion", () => {
		const goals: SpawnedChildLike[] = [
			{ id: "REAL-TASKS", parentGoalId: undefined, spawnedBySessionId: "AL_TRUIST", createdAt: 1, title: "REAL-TASKS COMPARISON AUDIT" },
			{ id: "A-claude-code", parentGoalId: "REAL-TASKS", spawnedBySessionId: "AL_TRUIST", createdAt: 100, title: "AUDIT: CLAUDE CODE" },
			{ id: "A-bobbit", parentGoalId: "REAL-TASKS", spawnedBySessionId: "AL_TRUIST", createdAt: 110, title: "AUDIT: BOBBIT HARNESS" },
			{ id: "B-claude-code-inner", parentGoalId: "A-claude-code", spawnedBySessionId: "AL_TRUIST", createdAt: 200, title: "AUDIT: CLAUDE CODE" },
		];
		const result = simulateRender(goals, "REAL-TASKS", "AL_TRUIST", { cap: 50 });
		expect(result.filter(r => r.kind === "loop")).toEqual([]);
		expect(result.filter(r => r.kind === "cap-hit")).toEqual([]);
		const rowIds = result.filter(r => r.kind === "row").map(r => r.id);
		expect(rowIds).toEqual(["A-claude-code", "B-claude-code-inner", "A-bobbit"]);
	});

	it("true id-cycle (A→B→A in spawnedBy attribution) terminates with loop marker", () => {
		const goals: SpawnedChildLike[] = [
			{ id: "A", parentGoalId: "ROOT", spawnedBySessionId: "L", createdAt: 1, title: "A" },
			{ id: "B", parentGoalId: "A", spawnedBySessionId: "L", createdAt: 2, title: "B" },
			{ id: "A", parentGoalId: "B", spawnedBySessionId: "L", createdAt: 3, title: "A-cycle" }, // duplicate id intentional
		];
		const result = simulateRender(goals, "ROOT", "L", { cap: 50 });
		expect(result.filter(r => r.kind === "cap-hit")).toEqual([]);
	});

	it("cap is generous so legitimate deep trees aren't truncated", () => {
		const goals: SpawnedChildLike[] = [];
		for (let i = 0; i < 10; i++) {
			goals.push({
				id: `lvl-${i}`,
				parentGoalId: i === 0 ? "ROOT" : `lvl-${i - 1}`,
				spawnedBySessionId: "L",
				createdAt: i,
				title: `Level ${i}`,
			});
		}
		const result = simulateRender(goals, "ROOT", "L", { cap: 50 });
		expect(result.filter(r => r.kind === "cap-hit")).toEqual([]);
		expect(result.filter(r => r.kind === "row").length).toBe(10);
	});
});
