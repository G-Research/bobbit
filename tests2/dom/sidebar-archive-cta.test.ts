import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-archive-cta.spec.ts (v2-dom tier).
// The legacy file:// fixture inlined the emptyState priority chain that mirrors
// src/app/render-helpers.ts renderGoalGroup() (the decision is inlined there, not
// exported as a standalone symbol). This port replicates that same decision
// function and asserts the identical behaviours. No DOM — bridge for uniformity.
import { describe, expect, it } from "vitest";

/**
 * emptyState priority chain from src/app/render-helpers.ts renderGoalGroup():
 *   1. archived   → 'archived'
 *   2. canArchive → 'archive-goal'  (PR merged, no active team, not archived)
 *   3. isTeamGoal → 'start-team'
 *   4. else       → 'start-session'
 */
function getEmptyState(archived: boolean, canArchive: boolean, isTeamGoal: boolean): string {
	if (archived) return "archived";
	if (canArchive) return "archive-goal";
	if (isTeamGoal) return "start-team";
	return "start-session";
}

describe("Sidebar empty state — archive CTA", () => {
	it("archived goal shows 'archived'", () => {
		expect(getEmptyState(true, false, true)).toBe("archived");
	});

	it("team goal (not archivable) shows 'start-team'", () => {
		expect(getEmptyState(false, false, true)).toBe("start-team");
	});

	it("non-team goal shows 'start-session'", () => {
		expect(getEmptyState(false, false, false)).toBe("start-session");
	});

	it("merged PR with no active team should show 'archive-goal', not 'start-team'", () => {
		// canArchive=true: PR merged, no active team, not archived; isTeamGoal=true
		// because it IS a team goal (has workflow).
		expect(
			getEmptyState(false, true, true),
			"Expected sidebar to show archive-goal CTA when PR is merged",
		).toBe("archive-goal");
	});
});
