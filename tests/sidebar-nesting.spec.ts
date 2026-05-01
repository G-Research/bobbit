/**
 * Unit tests for sidebar nested-goal rendering (docs/design/nested-goals.md §10.1)
 * AND session-to-goal-group categorization (sidebar tree). The latter cases
 * (SB-00-*) were ported from the now-deleted tests/sidebar-hierarchy.spec.ts
 * during F7 cleanup.
 *
 * Nested-goal rendering (parent → child goals via parentGoalId):
 *   SB-NEST-1  Direct-child enumeration filters archived + sorts by createdAt
 *   SB-NEST-2  Descendant count is transitive and cycle-safe
 *   SB-NEST-3  n/m count badge counts only immediate children
 *   SB-NEST-4  No children → leaf render (no "show more" link)
 *   SB-NEST-5  Children within depth cap → recurse on each
 *   SB-NEST-6  Children at MAX_GOAL_DEPTH → "show more" link with descendant count
 *   SB-NEST-7  Cycle in parentGoalId chain does not infinite-loop the counter
 *
 * Session-to-goal hierarchy (sessions → sidebar tree):
 *   SB-00-*    Categorization, tree building, delegate nesting, archived visibility,
 *              recursive delegates, edge cases.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-nesting.html")}`;

declare global {
	interface Window {
		MAX_GOAL_DEPTH: number;
		getChildGoalsFrom: (parentId: string, goals: any[]) => any[];
		getArchivedChildGoalsFrom: (parentId: string, goals: any[]) => any[];
		countDescendantsFrom: (goalId: string, goals: any[]) => number;
		computeChildCountBadge: (parentId: string, goals: any[]) => { complete: number; total: number; label: string } | null;
		decideRender: (goal: any, depth: number, goals: any[]) => { kind: "leaf" } | { kind: "show-more"; count: number } | { kind: "recurse"; childIds: string[] };
		buildLinearChain: (depth: number) => any[];
		__hierarchy: {
			categorizeSession: (session: any, goals: any[]) => { section: string; goalId?: string; parentSessionId?: string };
			buildSidebarTree: (sessions: any[], archivedSessions: any[], goals: any[], showArchived: boolean) => any;
			getVisibleSessionIds: (tree: any, showArchived: boolean) => string[];
			isTopLevel: (tree: any, sessionId: string) => boolean;
		};
	}
}

test.describe("SB-NEST-1: getChildGoalsFrom — filtering and ordering", () => {
	test("returns immediate children only, not grandchildren", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false },
				{ id: "a1", parentGoalId: "a", createdAt: 4, archived: false },
			];
			return window.getChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual(["a", "b"]);
	});

	test("excludes archived children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: true },
				{ id: "c", parentGoalId: "root", createdAt: 4, archived: false },
			];
			return window.getChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual(["a", "c"]);
	});

	test("sorts by createdAt ascending regardless of input order", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "later", parentGoalId: "root", createdAt: 99, archived: false },
				{ id: "early", parentGoalId: "root", createdAt: 1, archived: false },
				{ id: "mid", parentGoalId: "root", createdAt: 50, archived: false },
			];
			return window.getChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual(["early", "mid", "later"]);
	});

	test("returns empty array when no children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false }];
			return window.getChildGoalsFrom("root", goals);
		});
		expect(ids).toEqual([]);
	});
});

test.describe("SB-NEST-2: countDescendantsFrom — transitive count", () => {
	test("returns 0 for a leaf", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			const goals = [{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false }];
			return window.countDescendantsFrom("root", goals);
		});
		expect(n).toBe(0);
	});

	test("counts a 3-level subtree (1 child + 2 grandchildren = 3)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "a1", parentGoalId: "a", createdAt: 3, archived: false },
				{ id: "a2", parentGoalId: "a", createdAt: 4, archived: false },
			];
			return window.countDescendantsFrom("root", goals);
		});
		expect(n).toBe(3);
	});

	test("excludes archived descendants", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: true },
				{ id: "a1", parentGoalId: "a", createdAt: 4, archived: false },
			];
			return window.countDescendantsFrom("root", goals);
		});
		expect(n).toBe(2);
	});

	test("does not count the goal itself", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
			];
			return window.countDescendantsFrom("root", goals);
		});
		expect(n).toBe(1);
	});
});

test.describe("SB-NEST-3: computeChildCountBadge — n/m label", () => {
	test("returns null when no children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const badge = await page.evaluate(() => {
			const goals = [{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" }];
			return window.computeChildCountBadge("root", goals);
		});
		expect(badge).toBeNull();
	});

	test("counts only immediate children (not grandchildren)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const badge = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "complete" },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false, state: "in-progress" },
				{ id: "c", parentGoalId: "root", createdAt: 4, archived: false, state: "in-progress" },
				// grandchildren must NOT count
				{ id: "a1", parentGoalId: "a", createdAt: 5, archived: false, state: "complete" },
				{ id: "a2", parentGoalId: "a", createdAt: 6, archived: false, state: "complete" },
			];
			return window.computeChildCountBadge("root", goals);
		});
		expect(badge).toEqual({ complete: 1, total: 3, label: "1/3" });
	});

	test("3/3 when all children are complete", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const badge = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "complete" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "complete" },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false, state: "complete" },
				{ id: "c", parentGoalId: "root", createdAt: 4, archived: false, state: "complete" },
			];
			return window.computeChildCountBadge("root", goals);
		});
		expect(badge?.label).toBe("3/3");
		expect(badge?.complete).toBe(3);
	});

	test("excludes archived children from total", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const badge = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "complete" },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: true, state: "complete" },
			];
			return window.computeChildCountBadge("root", goals);
		});
		expect(badge?.label).toBe("1/1");
	});
});

test.describe("SB-NEST-4 / SB-NEST-5 / SB-NEST-6: depth-cap render decisions", () => {
	test("leaf goal at any depth renders as leaf", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const goals = [{ id: "leaf", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" }];
			return window.decideRender(goals[0], 0, goals);
		});
		expect(result).toEqual({ kind: "leaf" });
	});

	test("goal with children at depth 0 recurses", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false, state: "in-progress" },
			];
			return window.decideRender(goals[0], 0, goals);
		});
		expect(result.kind).toBe("recurse");
		expect((result as any).childIds).toEqual(["a", "b"]);
	});

	test("goal with children at depth 4 (one below cap) still recurses", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const root = { id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" };
			const a = { id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" };
			return window.decideRender(root, 4, [root, a]);
		});
		expect(result.kind).toBe("recurse");
	});

	test("goal with children at depth MAX_GOAL_DEPTH yields show-more with descendant count", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			// 3-level subtree under "root": 1 child + 2 grandchildren = 3 descendants
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" },
				{ id: "a1", parentGoalId: "a", createdAt: 3, archived: false, state: "in-progress" },
				{ id: "a2", parentGoalId: "a", createdAt: 4, archived: false, state: "in-progress" },
			];
			return window.decideRender(goals[0], window.MAX_GOAL_DEPTH, goals);
		});
		expect(result.kind).toBe("show-more");
		expect((result as any).count).toBe(3);
	});

	test("3-level tree rendered from depth 0 traverses fully (no show-more)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visits = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" },
				{ id: "a1", parentGoalId: "a", createdAt: 3, archived: false, state: "in-progress" },
				{ id: "a2", parentGoalId: "a", createdAt: 4, archived: false, state: "in-progress" },
				{ id: "b", parentGoalId: "root", createdAt: 5, archived: false, state: "complete" },
			];
			const log: Array<{ id: string; depth: number; kind: string }> = [];
			const walk = (g: any, depth: number) => {
				const r = window.decideRender(g, depth, goals);
				log.push({ id: g.id, depth, kind: r.kind });
				if (r.kind === "recurse") {
					for (const cid of r.childIds) {
						const child = goals.find(x => x.id === cid)!;
						walk(child, depth + 1);
					}
				}
			};
			walk(goals[0], 0);
			return log;
		});
		expect(visits.find(v => v.kind === "show-more")).toBeUndefined();
		expect(visits.map(v => v.id)).toEqual(["root", "a", "a1", "a2", "b"]);
		expect(visits.find(v => v.id === "a")?.depth).toBe(1);
		expect(visits.find(v => v.id === "a1")?.depth).toBe(2);
	});

	test("a 7-deep linear chain renders depth 0..4 inline, then show-more at depth 5", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const visits = await page.evaluate(() => {
			// Chain: goal-0 -> goal-1 -> ... -> goal-6  (depth 7)
			const goals = window.buildLinearChain(7);
			goals.forEach(g => g.state = "in-progress");
			const log: Array<{ id: string; depth: number; kind: string; count?: number }> = [];
			const walk = (g: any, depth: number) => {
				const r = window.decideRender(g, depth, goals);
				log.push({ id: g.id, depth, kind: r.kind, count: (r as any).count });
				if (r.kind === "recurse") {
					for (const cid of r.childIds) {
						const child = goals.find(x => x.id === cid)!;
						walk(child, depth + 1);
					}
				}
			};
			walk(goals[0], 0);
			return log;
		});
		// goal-0 at depth 0 recurses, goal-1..goal-4 recurse (depths 1..4),
		// goal-5 at depth 5 hits the cap → show-more (descendants = 1, just goal-6).
		// goal-6 must NOT appear (we stopped at the cap).
		expect(visits.map(v => v.id)).toEqual(["goal-0", "goal-1", "goal-2", "goal-3", "goal-4", "goal-5"]);
		expect(visits[5]).toEqual({ id: "goal-5", depth: 5, kind: "show-more", count: 1 });
	});
});

test.describe("SB-NEST-7: cycle safety", () => {
	test("a cycle in parentGoalId does not infinite-loop countDescendantsFrom", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const n = await page.evaluate(() => {
			// Pathological: goal-a's parent is goal-b, goal-b's parent is goal-a.
			// Server-side cycle prevention should make this impossible, but the
			// renderer must not melt down if a malformed snapshot ever sneaks in.
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false, state: "in-progress" },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false, state: "in-progress" },
				{ id: "b", parentGoalId: "a", createdAt: 3, archived: false, state: "in-progress" },
				// inject cycle: pretend the snapshot also lists "a" with parent="b"
				{ id: "a", parentGoalId: "b", createdAt: 2, archived: false, state: "in-progress" },
			];
			return window.countDescendantsFrom("root", goals);
		});
		// Even with a duplicate id forming a back-edge, the visited set bounds
		// the walk and the counter terminates.
		expect(n).toBeGreaterThanOrEqual(2);
		expect(n).toBeLessThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// SB-00: Sidebar hierarchy and nesting (ported from sidebar-hierarchy.spec.ts).
//
// Tests the session categorization and tree-building logic that determines
// where each session appears in the sidebar: goal groups, ungrouped, staff,
// or nested as a delegate.
// ---------------------------------------------------------------------------

const mockSessions = [
	// Team goal sessions
	{ id: "lead1", role: "team-lead", teamGoalId: "goal1", goalId: "goal1", status: "idle" },
	{ id: "member1", teamGoalId: "goal1", teamLeadSessionId: "lead1", status: "idle" },
	{ id: "member2", teamGoalId: "goal1", teamLeadSessionId: "lead1", status: "idle" },
	{ id: "delegate-of-member1", delegateOf: "member1", status: "idle" },

	// Non-team goal sessions
	{ id: "session-in-goal2", goalId: "goal2", status: "idle" },
	{ id: "delegate-of-goal2-session", delegateOf: "session-in-goal2", status: "idle" },

	// Ungrouped
	{ id: "ungrouped1", status: "idle" },
	{ id: "ungrouped2", status: "idle" },
	{ id: "delegate-of-ungrouped1", delegateOf: "ungrouped1", status: "idle" },

	// Staff
	{ id: "staff1", staffId: "my-staff", status: "idle" },
];

const mockArchivedSessions = [
	{ id: "archived-member3", teamGoalId: "goal1", teamLeadSessionId: "lead1", archived: true, status: "terminated" },
	{ id: "archived-delegate-of-lead", delegateOf: "lead1", archived: true, status: "terminated" },
];

const mockGoals = [
	{ id: "goal1", title: "Team Goal", team: true, archived: false },
	{ id: "goal2", title: "Solo Goal", team: false, archived: false },
];

test.describe("SB-00: Sidebar hierarchy and nesting", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
	});

	// ── Placement / categorization ───────────────────────────────────

	test("team member with teamGoalId is categorized under that goal", async ({ page }) => {
		const cat = await page.evaluate((s) => window.__hierarchy.categorizeSession(s, []), mockSessions[1]);
		expect(cat).toEqual({ section: "team-goal", goalId: "goal1" });
	});

	test("session with goalId is categorized under that goal", async ({ page }) => {
		const cat = await page.evaluate((s) => window.__hierarchy.categorizeSession(s, []), mockSessions[4]);
		expect(cat).toEqual({ section: "goal", goalId: "goal2" });
	});

	test("session with delegateOf is categorized as delegate", async ({ page }) => {
		const cat = await page.evaluate((s) => window.__hierarchy.categorizeSession(s, []), mockSessions[3]);
		expect(cat).toEqual({ section: "delegate", parentSessionId: "member1" });
	});

	test("ungrouped session is categorized as ungrouped", async ({ page }) => {
		const cat = await page.evaluate((s) => window.__hierarchy.categorizeSession(s, []), mockSessions[6]);
		expect(cat).toEqual({ section: "ungrouped" });
	});

	test("staff session is categorized as staff", async ({ page }) => {
		const cat = await page.evaluate((s) => window.__hierarchy.categorizeSession(s, []), mockSessions[9]);
		expect(cat).toEqual({ section: "staff" });
	});

	test("team lead with teamGoalId is categorized under that goal", async ({ page }) => {
		const cat = await page.evaluate((s) => window.__hierarchy.categorizeSession(s, []), mockSessions[0]);
		// team lead has both goalId and teamGoalId — teamGoalId takes priority
		expect(cat).toEqual({ section: "team-goal", goalId: "goal1" });
	});

	// ── Tree building ────────────────────────────────────────────

	test("buildSidebarTree places team lead under goal group", async ({ page }) => {
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
				return { hasTeamLead: !!goalGroup?.teamLead, leadId: goalGroup?.teamLead?.id };
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(result.hasTeamLead).toBe(true);
		expect(result.leadId).toBe("lead1");
	});

	test("team members grouped under their lead", async ({ page }) => {
		const memberIds = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
				return goalGroup.teamMembers.map((m: any) => m.id);
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(memberIds).toContain("member1");
		expect(memberIds).toContain("member2");
		expect(memberIds).not.toContain("lead1");
	});

	test("delegates nested under parent, not at top level", async ({ page }) => {
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				const isTop = window.__hierarchy.isTopLevel(tree, "delegate-of-member1");
				const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
				const member1 = goalGroup.teamMembers.find((m: any) => m.id === "member1");
				const delegateInMember = member1?.delegates?.some((d: any) => d.id === "delegate-of-member1");
				return { isTop, delegateInMember };
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(result.isTop).toBe(false);
		expect(result.delegateInMember).toBe(true);
	});

	test("delegate of goal2 session nested under parent in non-team goal", async ({ page }) => {
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				const isTop = window.__hierarchy.isTopLevel(tree, "delegate-of-goal2-session");
				const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal2");
				const parent = goalGroup.nonTeamSessions.find((s: any) => s.id === "session-in-goal2");
				const delegateNested = parent?.delegates?.some((d: any) => d.id === "delegate-of-goal2-session");
				return { isTop, delegateNested };
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(result.isTop).toBe(false);
		expect(result.delegateNested).toBe(true);
	});

	test("ungrouped sessions in ungrouped section", async ({ page }) => {
		const ids = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				return tree.ungrouped.map((s: any) => s.id);
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(ids).toContain("ungrouped1");
		expect(ids).toContain("ungrouped2");
		expect(ids).not.toContain("delegate-of-ungrouped1");
	});

	test("staff in staff section", async ({ page }) => {
		const ids = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				return tree.staff.map((s: any) => s.id);
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(ids).toContain("staff1");
	});

	test("delegate never appears at top level of any section", async ({ page }) => {
		const delegateIds = ["delegate-of-member1", "delegate-of-goal2-session", "delegate-of-ungrouped1"];
		const results = await page.evaluate(
			({ sessions, archived, goals, delegateIds }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				return delegateIds.map((id: string) => ({
					id,
					isTop: window.__hierarchy.isTopLevel(tree, id),
				}));
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals, delegateIds },
		);
		for (const r of results) {
			expect(r.isTop, `${r.id} should not be top-level`).toBe(false);
		}
	});

	// ── Visibility with showArchived=false ────────────────────────────

	test("only live sessions visible when showArchived=false", async ({ page }) => {
		const ids = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				return window.__hierarchy.getVisibleSessionIds(tree, false);
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(ids).not.toContain("archived-member3");
		expect(ids).not.toContain("archived-delegate-of-lead");
		expect(ids).toContain("lead1");
		expect(ids).toContain("member1");
	});

	// ── Visibility with showArchived=true ─────────────────────────────

	test("archived team member visible under live lead when showArchived=true", async ({ page }) => {
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
				const archivedMemberIds = goalGroup.archivedMembers.map((m: any) => m.id);
				return { archivedMemberIds, inLiveSection: true };
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(result.archivedMemberIds).toContain("archived-member3");
	});

	test("archived delegate visible when showArchived=true", async ({ page }) => {
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
				const leadDelegates = goalGroup.teamLead.delegates.map((d: any) => d.id);
				return { leadDelegates };
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(result.leadDelegates).toContain("archived-delegate-of-lead");
	});

	test("both live and archived members present when showArchived=true", async ({ page }) => {
		const ids = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				return window.__hierarchy.getVisibleSessionIds(tree, true);
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(ids).toContain("lead1");
		expect(ids).toContain("member1");
		expect(ids).toContain("archived-member3");
		expect(ids).toContain("archived-delegate-of-lead");
	});

	// ── Archived goal ───────────────────────────────────────────

	test("archived goal hidden when showArchived=false", async ({ page }) => {
		const archivedGoals = [{ id: "goal-old", title: "Old Goal", team: true, archived: true }];
		const archivedSessions = [
			{ id: "old-lead", role: "team-lead", teamGoalId: "goal-old", archived: true, status: "terminated" },
		];
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				return { archivedGroupCount: tree.archivedGoalGroups.length };
			},
			{ sessions: [], archived: archivedSessions, goals: archivedGoals },
		);
		expect(result.archivedGroupCount).toBe(0);
	});

	test("archived goal with full tree in archived section when showArchived=true", async ({ page }) => {
		const archivedGoals = [{ id: "goal-old", title: "Old Goal", team: true, archived: true }];
		const archivedSessions = [
			{ id: "old-lead", role: "team-lead", teamGoalId: "goal-old", archived: true, status: "terminated" },
			{ id: "old-member", teamGoalId: "goal-old", teamLeadSessionId: "old-lead", archived: true, status: "terminated" },
		];
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				const group = tree.archivedGoalGroups[0];
				return {
					archivedGroupCount: tree.archivedGoalGroups.length,
					goalId: group?.goal?.id,
					hasContent: !!group,
				};
			},
			{ sessions: [], archived: archivedSessions, goals: archivedGoals },
		);
		expect(result.archivedGroupCount).toBe(1);
		expect(result.goalId).toBe("goal-old");
	});

	// ── Recursive delegates ───────────────────────────────────────

	test("delegate of delegate nests correctly", async ({ page }) => {
		const sessions = [
			{ id: "parent", status: "idle" },
			{ id: "child", delegateOf: "parent", status: "idle" },
			{ id: "grandchild", delegateOf: "child", status: "idle" },
		];
		const result = await page.evaluate(
			({ sessions }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, [], [], false);
				const parentTop = window.__hierarchy.isTopLevel(tree, "parent");
				const childTop = window.__hierarchy.isTopLevel(tree, "child");
				const grandchildTop = window.__hierarchy.isTopLevel(tree, "grandchild");
				return {
					ungroupedIds: tree.ungrouped.map((s: any) => s.id),
					parentTop,
					childTop,
					grandchildTop,
				};
			},
			{ sessions },
		);
		expect(result.ungroupedIds).toContain("parent");
		expect(result.ungroupedIds).not.toContain("child");
		expect(result.ungroupedIds).not.toContain("grandchild");
		expect(result.parentTop).toBe(true);
		expect(result.childTop).toBe(false);
		expect(result.grandchildTop).toBe(false);
	});

	test("recursive delegates in goal nest correctly", async ({ page }) => {
		const sessions = [
			{ id: "goal-session", goalId: "goal2", status: "idle" },
			{ id: "del1", delegateOf: "goal-session", status: "idle" },
			{ id: "del2", delegateOf: "del1", status: "idle" },
		];
		const goals = [{ id: "goal2", title: "Solo Goal", team: false, archived: false }];

		const result = await page.evaluate(
			({ sessions, goals }) => {
				const tree = window.__hierarchy.buildSidebarTree(sessions, [], goals, false);
				const group = tree.goalGroups[0];
				const parent = group.nonTeamSessions.find((s: any) => s.id === "goal-session");
				const del1 = parent?.delegates?.find((d: any) => d.id === "del1");
				const del2 = del1?.delegates?.find((d: any) => d.id === "del2");
				return {
					parentHasDelegates: parent?.delegates?.length > 0,
					del1Found: !!del1,
					del2NestedUnderDel1: !!del2,
					del1TopLevel: window.__hierarchy.isTopLevel(tree, "del1"),
					del2TopLevel: window.__hierarchy.isTopLevel(tree, "del2"),
				};
			},
			{ sessions, goals },
		);
		expect(result.parentHasDelegates).toBe(true);
		expect(result.del1Found).toBe(true);
		expect(result.del2NestedUnderDel1).toBe(true);
		expect(result.del1TopLevel).toBe(false);
		expect(result.del2TopLevel).toBe(false);
	});

	// ── Edge cases ─────────────────────────────────────────────

	test("empty sessions produces empty tree", async ({ page }) => {
		const result = await page.evaluate(() => {
			const tree = window.__hierarchy.buildSidebarTree([], [], [], false);
			return {
				goalGroups: tree.goalGroups.length,
				ungrouped: tree.ungrouped.length,
				staff: tree.staff.length,
				archivedGoalGroups: tree.archivedGoalGroups.length,
			};
		});
		expect(result.goalGroups).toBe(0);
		expect(result.ungrouped).toBe(0);
		expect(result.staff).toBe(0);
		expect(result.archivedGoalGroups).toBe(0);
	});

	test("session with both goalId and teamGoalId uses teamGoalId", async ({ page }) => {
		const cat = await page.evaluate(
			(s) => window.__hierarchy.categorizeSession(s, []),
			{ id: "x", goalId: "g1", teamGoalId: "g1", status: "idle" },
		);
		expect(cat.section).toBe("team-goal");
	});

	test("delegateOf takes priority over goalId", async ({ page }) => {
		const cat = await page.evaluate(
			(s) => window.__hierarchy.categorizeSession(s, []),
			{ id: "x", goalId: "g1", delegateOf: "parent1", status: "idle" },
		);
		expect(cat.section).toBe("delegate");
		expect(cat.parentSessionId).toBe("parent1");
	});
});

// Pinned regression: when `state.showArchived` is on, archived child
// goals must render INLINE under their parent (mirrors archived-session
// behaviour) rather than being dumped to a flat per-project bucket.
// `getArchivedChildGoalsFrom` is the parallel of `getChildGoalsFrom`
// but selects archived children; rendering is gated upstream by the
// caller checking `state.showArchived`.
test.describe("SB-NEST-ARCH: getArchivedChildGoalsFrom — archived-child enumeration", () => {
	test("returns immediate archived children only, not live children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "live-child", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "archived-child", parentGoalId: "root", createdAt: 3, archived: true },
			];
			return window.getArchivedChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual(["archived-child"]);
	});

	test("returns multiple archived children sorted by createdAt ASC", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "later-archived", parentGoalId: "root", createdAt: 99, archived: true },
				{ id: "early-archived", parentGoalId: "root", createdAt: 5, archived: true },
				{ id: "mid-archived", parentGoalId: "root", createdAt: 50, archived: true },
			];
			return window.getArchivedChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual(["early-archived", "mid-archived", "later-archived"]);
	});

	test("returns empty list when no archived children exist", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: false },
			];
			return window.getArchivedChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual([]);
	});

	test("does not return grandchildren — only IMMEDIATE archived children", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const ids = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "child", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "archived-grandchild", parentGoalId: "child", createdAt: 3, archived: true },
			];
			return window.getArchivedChildGoalsFrom("root", goals).map(g => g.id);
		});
		expect(ids).toEqual([]);
	});

	test("is the exact dual of getChildGoalsFrom — their union covers all immediate children", async ({ page }) => {
		// Defensive invariant: live + archived children of a parent should
		// equal all goals with that parentGoalId. No leak in either direction.
		await page.goto(TEST_PAGE);
		const { live, archived, all } = await page.evaluate(() => {
			const goals = [
				{ id: "root", parentGoalId: undefined, createdAt: 1, archived: false },
				{ id: "a", parentGoalId: "root", createdAt: 2, archived: false },
				{ id: "b", parentGoalId: "root", createdAt: 3, archived: true },
				{ id: "c", parentGoalId: "root", createdAt: 4, archived: false },
				{ id: "d", parentGoalId: "root", createdAt: 5, archived: true },
			];
			return {
				live: window.getChildGoalsFrom("root", goals).map(g => g.id),
				archived: window.getArchivedChildGoalsFrom("root", goals).map(g => g.id),
				all: goals.filter(g => g.parentGoalId === "root").map(g => g.id),
			};
		});
		expect(live).toEqual(["a", "c"]);
		expect(archived).toEqual(["b", "d"]);
		expect([...live, ...archived].sort()).toEqual(all.sort());
	});
});
