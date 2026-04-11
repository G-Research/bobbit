/**
 * SB-00: Sidebar hierarchy and nesting tests.
 *
 * Tests the session categorization and tree-building logic that determines
 * where each session appears in the sidebar: goal groups, ungrouped, staff,
 * or nested as a delegate.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-hierarchy.html")}`;

// ---------------------------------------------------------------------------
// Shared mock data (injected into page.evaluate)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("SB-00: Sidebar hierarchy and nesting", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
	});

	// ── Placement / categorization ────────────────────────────────────

	test("team member with teamGoalId is categorized under that goal", async ({ page }) => {
		const cat = await page.evaluate((s) => (window as any).__hierarchy.categorizeSession(s, []), mockSessions[1]);
		expect(cat).toEqual({ section: "team-goal", goalId: "goal1" });
	});

	test("session with goalId is categorized under that goal", async ({ page }) => {
		const cat = await page.evaluate((s) => (window as any).__hierarchy.categorizeSession(s, []), mockSessions[4]);
		expect(cat).toEqual({ section: "goal", goalId: "goal2" });
	});

	test("session with delegateOf is categorized as delegate", async ({ page }) => {
		const cat = await page.evaluate((s) => (window as any).__hierarchy.categorizeSession(s, []), mockSessions[3]);
		expect(cat).toEqual({ section: "delegate", parentSessionId: "member1" });
	});

	test("ungrouped session is categorized as ungrouped", async ({ page }) => {
		const cat = await page.evaluate((s) => (window as any).__hierarchy.categorizeSession(s, []), mockSessions[6]);
		expect(cat).toEqual({ section: "ungrouped" });
	});

	test("staff session is categorized as staff", async ({ page }) => {
		const cat = await page.evaluate((s) => (window as any).__hierarchy.categorizeSession(s, []), mockSessions[9]);
		expect(cat).toEqual({ section: "staff" });
	});

	test("team lead with teamGoalId is categorized under that goal", async ({ page }) => {
		const cat = await page.evaluate((s) => (window as any).__hierarchy.categorizeSession(s, []), mockSessions[0]);
		// team lead has both goalId and teamGoalId — teamGoalId takes priority
		expect(cat).toEqual({ section: "team-goal", goalId: "goal1" });
	});

	// ── Tree building ─────────────────────────────────────────────────

	test("buildSidebarTree places team lead under goal group", async ({ page }) => {
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, false);
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, false);
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				const isTop = (window as any).__hierarchy.isTopLevel(tree, "delegate-of-member1");
				// Find delegate under member1
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				const isTop = (window as any).__hierarchy.isTopLevel(tree, "delegate-of-goal2-session");
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				return tree.ungrouped.map((s: any) => s.id);
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(ids).toContain("ungrouped1");
		expect(ids).toContain("ungrouped2");
		// Delegates should NOT be in ungrouped
		expect(ids).not.toContain("delegate-of-ungrouped1");
	});

	test("staff in staff section", async ({ page }) => {
		const ids = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, false);
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				return delegateIds.map((id: string) => ({
					id,
					isTop: (window as any).__hierarchy.isTopLevel(tree, id),
				}));
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals, delegateIds },
		);
		for (const r of results) {
			expect(r.isTop, `${r.id} should not be top-level`).toBe(false);
		}
	});

	// ── Visibility with showArchived=false ─────────────────────────────

	test("only live sessions visible when showArchived=false", async ({ page }) => {
		const ids = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, false);
				return (window as any).__hierarchy.getVisibleSessionIds(tree, false);
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(ids).not.toContain("archived-member3");
		expect(ids).not.toContain("archived-delegate-of-lead");
		// Live sessions present
		expect(ids).toContain("lead1");
		expect(ids).toContain("member1");
	});

	// ── Visibility with showArchived=true ──────────────────────────────

	test("archived team member visible under live lead when showArchived=true", async ({ page }) => {
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, true);
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
				// archived-delegate-of-lead should be nested under lead1
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				return (window as any).__hierarchy.getVisibleSessionIds(tree, true);
			},
			{ sessions: mockSessions, archived: mockArchivedSessions, goals: mockGoals },
		);
		expect(ids).toContain("lead1");
		expect(ids).toContain("member1");
		expect(ids).toContain("archived-member3");
		expect(ids).toContain("archived-delegate-of-lead");
	});

	// ── Archived goal ──────────────────────────────────────────────────

	test("archived goal hidden when showArchived=false", async ({ page }) => {
		const archivedGoals = [{ id: "goal-old", title: "Old Goal", team: true, archived: true }];
		const archivedSessions = [
			{ id: "old-lead", role: "team-lead", teamGoalId: "goal-old", archived: true, status: "terminated" },
		];
		const result = await page.evaluate(
			({ sessions, archived, goals }) => {
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, false);
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, archived, goals, true);
				const group = tree.archivedGoalGroups[0];
				return {
					archivedGroupCount: tree.archivedGoalGroups.length,
					goalId: group?.goal?.id,
					// Archived sessions with teamGoalId are in archivedSessions list;
					// the build logic needs to look in archivedSessions too
					hasContent: !!group,
				};
			},
			{ sessions: [], archived: archivedSessions, goals: archivedGoals },
		);
		expect(result.archivedGroupCount).toBe(1);
		expect(result.goalId).toBe("goal-old");
	});

	// ── Recursive delegates ────────────────────────────────────────────

	test("delegate of delegate nests correctly", async ({ page }) => {
		const sessions = [
			{ id: "parent", status: "idle" },
			{ id: "child", delegateOf: "parent", status: "idle" },
			{ id: "grandchild", delegateOf: "child", status: "idle" },
		];
		const result = await page.evaluate(
			({ sessions }) => {
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, [], [], false);
				// parent is ungrouped
				const parentTop = (window as any).__hierarchy.isTopLevel(tree, "parent");
				const childTop = (window as any).__hierarchy.isTopLevel(tree, "child");
				const grandchildTop = (window as any).__hierarchy.isTopLevel(tree, "grandchild");

				// Verify nesting: ungrouped has only "parent" at top level
				// but delegates are found via getDelegates in the build.
				// For ungrouped, delegates aren't in the tree entries directly
				// since ungrouped is a flat list. However, delegates should NOT
				// appear at top level.
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
				const tree = (window as any).__hierarchy.buildSidebarTree(sessions, [], goals, false);
				const group = tree.goalGroups[0];
				const parent = group.nonTeamSessions.find((s: any) => s.id === "goal-session");
				const del1 = parent?.delegates?.find((d: any) => d.id === "del1");
				const del2 = del1?.delegates?.find((d: any) => d.id === "del2");
				return {
					parentHasDelegates: parent?.delegates?.length > 0,
					del1Found: !!del1,
					del2NestedUnderDel1: !!del2,
					del1TopLevel: (window as any).__hierarchy.isTopLevel(tree, "del1"),
					del2TopLevel: (window as any).__hierarchy.isTopLevel(tree, "del2"),
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

	// ── Edge cases ─────────────────────────────────────────────────────

	test("empty sessions produces empty tree", async ({ page }) => {
		const result = await page.evaluate(() => {
			const tree = (window as any).__hierarchy.buildSidebarTree([], [], [], false);
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
		// The team lead has both goalId and teamGoalId — teamGoalId should take priority
		const cat = await page.evaluate(
			(s) => (window as any).__hierarchy.categorizeSession(s, []),
			{ id: "x", goalId: "g1", teamGoalId: "g1", status: "idle" },
		);
		expect(cat.section).toBe("team-goal");
	});

	test("delegateOf takes priority over goalId", async ({ page }) => {
		const cat = await page.evaluate(
			(s) => (window as any).__hierarchy.categorizeSession(s, []),
			{ id: "x", goalId: "g1", delegateOf: "parent1", status: "idle" },
		);
		expect(cat.section).toBe("delegate");
		expect(cat.parentSessionId).toBe("parent1");
	});
});
