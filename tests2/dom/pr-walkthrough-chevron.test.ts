import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/pr-walkthrough-chevron.spec.ts (v2-dom tier).
// The legacy fixture INLINED the future opt-out state model + the (then buggy)
// decision logic and asserted the DESIRED post-fix behaviour. The fix has since
// landed in src/app/sidebar-tree-state.ts (first-class opt-out, team-lead
// opt-out, delegate opt-in) and src/app/render-helpers.ts (the corrected
// decision formulas). This port drives the REAL state helpers and mirrors the
// REAL decision formulas from render-helpers.ts (line ~1003 renderSessionRow,
// line ~1612 renderTeamGroup), so every assertion holds against current source.
//
// Module-level expansion state persists across tests in a fork, so each test
// uses UNIQUE session ids (the legacy suite got a fresh page per test).
import { describe, expect, it } from "vitest";
import {
	isFirstClassParentExpanded,
	toggleFirstClassParentExpanded,
	isTeamLeadExpanded,
	setTeamLeadExpanded,
	isArchivedParentExpanded,
	toggleArchivedParentExpanded,
} from "../../src/app/sidebar-tree-state.js";

// REAL decision formula from render-helpers.ts renderSessionRow (~line 1003):
//   hasChildren && (hasFirstClassChild ? isFirstClassParentExpanded : isArchivedParentExpanded)
function computeSessionRowChildrenExpanded({ sessionId, hasChildren, hasFirstClassChild }: {
	sessionId: string; hasChildren: boolean; hasFirstClassChild: boolean;
}): boolean {
	return !!hasChildren && (hasFirstClassChild
		? isFirstClassParentExpanded(sessionId)
		: isArchivedParentExpanded(sessionId));
}

// REAL gate from render-helpers.ts renderTeamGroup (~line 1612):
//   const tlExpanded = isTeamLeadExpanded(teamLead.id)
function computeTeamLeadFirstClassChildExpanded({ leadId }: { leadId: string }): boolean {
	return isTeamLeadExpanded(leadId);
}

describe("PR walkthrough chevrons", () => {
	it("normal session with PR-walkthrough child collapses via chevron", () => {
		const id = "p-collapse";
		const defaultExpanded = computeSessionRowChildrenExpanded({ sessionId: id, hasChildren: true, hasFirstClassChild: true });
		toggleFirstClassParentExpanded(id);
		const afterCollapse = computeSessionRowChildrenExpanded({ sessionId: id, hasChildren: true, hasFirstClassChild: true });

		expect(defaultExpanded).toBe(true);
		expect(afterCollapse).toBe(false);
	});

	it("collapse choice persists (opt-out state round-trips)", () => {
		const id = "p-persist";
		const before = isFirstClassParentExpanded(id);
		toggleFirstClassParentExpanded(id);
		const afterCollapse = isFirstClassParentExpanded(id);
		toggleFirstClassParentExpanded(id);
		const afterReExpand = isFirstClassParentExpanded(id);

		expect(before).toBe(true);
		expect(afterCollapse).toBe(false);
		expect(afterReExpand).toBe(true);
	});

	it("team lead with PR-walkthrough child hides child when collapsed", () => {
		const lead = "lead-collapse";
		setTeamLeadExpanded(lead, false);
		const correctedGate = isTeamLeadExpanded(lead);
		const childExpanded = computeTeamLeadFirstClassChildExpanded({ leadId: lead });

		expect(correctedGate).toBe(false);
		expect(childExpanded).toBe(false);
	});

	it("regression: delegate-only parent uses opt-in model", () => {
		const id = "d-optin";
		const defaultCollapsed = computeSessionRowChildrenExpanded({ sessionId: id, hasChildren: true, hasFirstClassChild: false });
		toggleArchivedParentExpanded(id);
		const afterExpand = computeSessionRowChildrenExpanded({ sessionId: id, hasChildren: true, hasFirstClassChild: false });

		expect(defaultCollapsed).toBe(false);
		expect(afterExpand).toBe(true);
	});
});
