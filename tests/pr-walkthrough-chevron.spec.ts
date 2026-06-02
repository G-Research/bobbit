/**
 * Reproducing test for the "PR walkthrough chevrons" bug.
 *
 * Two bugs, both in src/app/render-helpers.ts, caused by first-class child
 * sessions (PR walkthroughs) FORCING their parent's children to render
 * expanded, overriding the chevron toggle:
 *   - Bug #1 renderSessionRow (~826): `autoExpanded` is permanently true when a
 *     PR-walkthrough child exists, so the chevron toggle has no visible effect.
 *   - Bug #2 renderTeamGroup (~1277): the lead's first-class children are gated
 *     by an independent `leadChildRowsExpanded` instead of the team-lead
 *     `tlExpanded`, so collapsing the lead never hides the first-class child.
 *
 * The fix introduces a NEW persisted OPT-OUT state in src/app/state.ts
 * (collapsedFirstClassParents + set/toggle/is helpers, default expanded,
 * persisted to localStorage `bobbit-collapsed-first-class-parents`) and routes
 * the decision logic through it / through the team-lead state.
 *
 * These tests assert the DESIRED (post-fix) behavior. The two collapse
 * assertions are expected to FAIL against the current (buggy) fixture logic;
 * the regression guards are expected to PASS both before and after the fix.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/pr-walkthrough-chevron.html")}`;

test.describe("PR walkthrough chevrons", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		// Clear localStorage to start fresh
		await page.evaluate(() => localStorage.clear());
		// Reload to re-initialize state from clean localStorage
		await page.goto(TEST_PAGE);
	});

	test("normal session with PR-walkthrough child collapses via chevron", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__chevron;

			// Default: a parent with a PR-walkthrough child renders its children expanded.
			const defaultExpanded = c.computeSessionRowChildrenExpanded({
				sessionId: "p",
				hasChildren: true,
				hasFirstClassChild: true,
			});

			// Click the chevron => toggle the first-class opt-out state to collapsed.
			c.toggleFirstClassParentExpanded("p");

			// Recompute: the child must now be HIDDEN.
			const afterCollapse = c.computeSessionRowChildrenExpanded({
				sessionId: "p",
				hasChildren: true,
				hasFirstClassChild: true,
			});

			return { defaultExpanded, afterCollapse };
		});

		// Default expanded — holds for both buggy and fixed logic.
		expect(result.defaultExpanded).toBe(true);
		// BUG: buggy logic returns true regardless of the toggle, so this FAILS.
		expect(result.afterCollapse).toBe(false);
	});

	test("collapse choice persists in localStorage", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__chevron;

			// Default expanded.
			const before = c.isFirstClassParentExpanded("p");

			// Collapse, then read the persisted opt-out state.
			c.toggleFirstClassParentExpanded("p");
			const afterCollapse = c.isFirstClassParentExpanded("p");

			// Re-toggle back to expanded.
			c.toggleFirstClassParentExpanded("p");
			const afterReExpand = c.isFirstClassParentExpanded("p");

			return { before, afterCollapse, afterReExpand };
		});

		expect(result.before).toBe(true);
		expect(result.afterCollapse).toBe(false);
		expect(result.afterReExpand).toBe(true);
	});

	test("team lead with PR-walkthrough child hides child when collapsed", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__chevron;

			// Collapse the team lead via the team-lead chevron.
			c.setTeamLeadExpanded("lead", false);

			// The corrected gate for the lead's first-class child should follow
			// the team-lead expansion state.
			const correctedGate = c.isTeamLeadExpanded("lead");

			// The buggy helper still force-expands the first-class child.
			const buggyChildExpanded = c.computeTeamLeadFirstClassChildExpanded({
				leadId: "lead",
				hasFirstClassChild: true,
				archivedLeadChildrenCount: 0,
			});

			return { correctedGate, buggyChildExpanded };
		});

		// Corrected gate: collapsing the lead hides the first-class child.
		expect(result.correctedGate).toBe(false);
		// BUG: buggy logic returns true (force-expanded), so this FAILS.
		expect(result.buggyChildExpanded).toBe(false);
	});

	test("regression: delegate-only parent uses opt-in model", async ({ page }) => {
		const result = await page.evaluate(() => {
			const c = (window as any).__chevron;

			// Delegate-only parent (no first-class child) is collapsed by default.
			const defaultCollapsed = c.computeSessionRowChildrenExpanded({
				sessionId: "d",
				hasChildren: true,
				hasFirstClassChild: false,
			});

			// Opt-in expand via the chevron.
			c.toggleArchivedParentExpanded("d");
			const afterExpand = c.computeSessionRowChildrenExpanded({
				sessionId: "d",
				hasChildren: true,
				hasFirstClassChild: false,
			});

			return { defaultCollapsed, afterExpand };
		});

		// Opt-in: default collapsed, expands after toggle. Holds before & after fix.
		expect(result.defaultCollapsed).toBe(false);
		expect(result.afterExpand).toBe(true);
	});
});
