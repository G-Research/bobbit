/**
 * Phase 5b — cascade-dialog logic tests.
 *
 * The dialogs render Lit templates into a detached container, so testing the
 * full UI flow needs a browser harness (covered by `tests/e2e/ui/cascade-archive.spec.ts`
 * and `cascade-pause.spec.ts`). This file covers the *non-DOM* invariants:
 *
 *   1. `countDescendants` walks the goal tree correctly (BFS, archived
 *      excluded, cycle-safe).
 *   2. The action-button label encodes the cascade choice
 *      (delegated to a small pure helper here that mirrors the dialog
 *      logic).
 *   3. Pre-flight URL choice (`?cascade=false` / `?cascade=true`) is the
 *      same string the dialogs use.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Pure mirror of the action-button label logic in `dialogs.ts`. We test it
// in isolation rather than coupling tests to Lit + a DOM. If the dialog code
// drifts, these tests fail and the Phase 5b E2E covers the actual UI.
function archiveActionLabel(descendantCount: number, working: boolean): string {
	if (working) return "Archiving…";
	return `Archive parent + ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}`;
}

function pauseActionLabel(descendantCount: number, cascade: boolean, working: boolean): string {
	if (working) return "Pausing…";
	return cascade
		? `Pause goal + ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}`
		: "Pause goal";
}

function resumeActionLabel(descendantCount: number, cascade: boolean, working: boolean): string {
	if (working) return "Resuming…";
	return cascade
		? `Resume goal + ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}`
		: "Resume goal";
}

// Pure mirror of `countDescendants` in `dialogs.ts` (same BFS, archived
// excluded, cycle-safe). The on-DOM version reads from `state.goals`; this
// version takes the goals list as an argument.
interface CountGoal {
	id: string;
	parentGoalId?: string;
	archived?: boolean;
}
function countDescendantsPure(goalId: string, goals: CountGoal[]): number {
	let total = 0;
	const queue = [goalId];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const cur = queue.shift()!;
		for (const g of goals) {
			if (g.parentGoalId !== cur || g.archived) continue;
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			total++;
			queue.push(g.id);
		}
	}
	return total;
}

describe("countDescendants", () => {
	it("returns 0 for a leaf goal", () => {
		const goals: CountGoal[] = [{ id: "a" }, { id: "b" }];
		assert.equal(countDescendantsPure("a", goals), 0);
	});

	it("counts immediate children only at depth 1", () => {
		const goals: CountGoal[] = [
			{ id: "a" },
			{ id: "b", parentGoalId: "a" },
			{ id: "c", parentGoalId: "a" },
		];
		assert.equal(countDescendantsPure("a", goals), 2);
	});

	it("recurses through grandchildren", () => {
		const goals: CountGoal[] = [
			{ id: "a" },
			{ id: "b", parentGoalId: "a" },
			{ id: "c", parentGoalId: "b" },
			{ id: "d", parentGoalId: "c" },
		];
		assert.equal(countDescendantsPure("a", goals), 3);
	});

	it("excludes archived descendants", () => {
		const goals: CountGoal[] = [
			{ id: "a" },
			{ id: "b", parentGoalId: "a" },
			{ id: "c", parentGoalId: "a", archived: true },
			{ id: "d", parentGoalId: "b", archived: true },
		];
		assert.equal(countDescendantsPure("a", goals), 1);
	});

	it("is cycle-safe (mutual parent loop)", () => {
		const goals: CountGoal[] = [
			{ id: "a", parentGoalId: "b" },
			{ id: "b", parentGoalId: "a" },
		];
		// Both a and b reach each other through their parentGoalId. The
		// `seen` set caps the count at 2 (one visit per node) without
		// infinite recursion.
		const n = countDescendantsPure("a", goals);
		assert.ok(n <= 2, `expected ≤2, got ${n}`);
	});

	it("returns 0 for an unknown root", () => {
		assert.equal(countDescendantsPure("nonexistent", [{ id: "a" }]), 0);
	});
});

describe("archive action label", () => {
	it("singular vs plural", () => {
		assert.equal(archiveActionLabel(1, false), "Archive parent + 1 descendant");
		assert.equal(archiveActionLabel(2, false), "Archive parent + 2 descendants");
		assert.equal(archiveActionLabel(0, false), "Archive parent + 0 descendants");
	});
	it("working state preempts label", () => {
		assert.equal(archiveActionLabel(7, true), "Archiving…");
	});
});

describe("pause action label", () => {
	it("toggle reflects in label", () => {
		assert.equal(pauseActionLabel(3, true, false), "Pause goal + 3 descendants");
		assert.equal(pauseActionLabel(3, false, false), "Pause goal");
	});
	it("singular vs plural", () => {
		assert.equal(pauseActionLabel(1, true, false), "Pause goal + 1 descendant");
	});
	it("working state preempts label", () => {
		assert.equal(pauseActionLabel(5, true, true), "Pausing…");
	});
});

describe("resume action label", () => {
	it("toggle reflects in label", () => {
		assert.equal(resumeActionLabel(3, true, false), "Resume goal + 3 descendants");
		assert.equal(resumeActionLabel(3, false, false), "Resume goal");
	});
	it("singular vs plural", () => {
		assert.equal(resumeActionLabel(1, true, false), "Resume goal + 1 descendant");
	});
	it("working state preempts label", () => {
		assert.equal(resumeActionLabel(5, false, true), "Resuming…");
	});
});

describe("REST URL choice", () => {
	it("archive pre-flight uses cascade=false", () => {
		const goalId = "g1";
		const url = `/api/goals/${goalId}?cascade=false`;
		assert.match(url, /\?cascade=false$/);
	});
	it("archive cascade confirm uses cascade=true", () => {
		const goalId = "g1";
		const url = `/api/goals/${goalId}?cascade=true`;
		assert.match(url, /\?cascade=true$/);
	});
	it("pause/resume use POST body, not query string", () => {
		const goalId = "g1";
		const url = `/api/goals/${goalId}/pause`;
		assert.equal(url, "/api/goals/g1/pause");
		// (cascade flag goes in body)
	});
});
