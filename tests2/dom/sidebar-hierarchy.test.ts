import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/sidebar-hierarchy.spec.ts (v2-dom tier).
// FIDELITY NOTE: the legacy file:// fixture drove a bespoke categorization /
// tree-building implementation (mirroring getSidebarData + renderGoalGroup). The
// real `buildSidebarTree` (src/app/sidebar-tree-builder.ts) has an entirely
// different input/output shape (single options object, SidebarTreeModel nodes),
// so it cannot back these positional-arg assertions. This port keeps a
// byte-identical replica of the fixture helpers and preserves every SB-00
// assertion.
import { describe, expect, it } from "vitest";

function categorizeSession(session: any, _goals: any[]): any {
	if (session.parentSessionId || session.delegateOf) {
		return { section: "delegate", parentSessionId: session.parentSessionId || session.delegateOf };
	}
	if (session.teamGoalId) return { section: "team-goal", goalId: session.teamGoalId };
	if (session.goalId) return { section: "goal", goalId: session.goalId };
	if (session.staffId) return { section: "staff" };
	return { section: "ungrouped" };
}

function buildGoalGroup(goal: any, sessions: any[], archivedSessions: any[], showArchived: boolean): any {
	const goalSessions = sessions.filter(s =>
		(s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf && !s.parentSessionId);

	const isTeamGoal = !!goal.team;
	const teamLead = isTeamGoal ? goalSessions.find(s => s.role === "team-lead") : null;
	const teamMembers = isTeamGoal && teamLead ? goalSessions.filter(s => s.id !== teamLead.id) : [];
	const nonTeamSessions = isTeamGoal ? [] : goalSessions;

	const archivedMembers = showArchived && teamLead
		? archivedSessions.filter(s =>
			s.teamGoalId === goal.id && !s.delegateOf && !s.parentSessionId
			&& s.role !== "team-lead" && s.teamLeadSessionId === teamLead.id)
		: [];

	const getDelegates = (parentId: string): any[] => {
		const liveDelegates = sessions.filter(s => (s.parentSessionId || s.delegateOf) === parentId);
		const archivedDels = showArchived
			? archivedSessions.filter(s => (s.parentSessionId || s.delegateOf) === parentId)
			: [];
		return [...liveDelegates, ...archivedDels].map(d => ({ ...d, delegates: getDelegates(d.id) }));
	};

	const withDelegates = (s: any) => ({ ...s, delegates: getDelegates(s.id) });

	return {
		goal,
		teamLead: teamLead ? withDelegates(teamLead) : null,
		teamMembers: teamMembers.map(withDelegates),
		nonTeamSessions: nonTeamSessions.map(withDelegates),
		archivedMembers: archivedMembers.map(withDelegates),
	};
}

function buildSidebarTree(sessions: any[], archivedSessions: any[], goals: any[], showArchived: boolean): any {
	const liveGoals = goals.filter(g => !g.archived);
	const archivedGoals = goals.filter(g => g.archived);
	const staffSessionIds = new Set(sessions.filter(s => s.staffId).map(s => s.id));

	const goalGroups = liveGoals.map(goal => buildGoalGroup(goal, sessions, archivedSessions, showArchived));
	const archivedGoalGroups = showArchived
		? archivedGoals.map(goal => buildGoalGroup(goal, sessions, archivedSessions, showArchived))
		: [];

	const ungrouped = sessions.filter(s =>
		!s.goalId && !s.teamGoalId && !s.delegateOf && !s.parentSessionId && !staffSessionIds.has(s.id));
	const staff = sessions.filter(s => staffSessionIds.has(s.id));

	return { goalGroups, archivedGoalGroups, ungrouped, staff };
}

function getVisibleSessionIds(tree: any, showArchived: boolean, sessions: any[] = [], archivedSessions: any[] = []): string[] {
	const ids: string[] = [];

	const collectDelegateIds = (delegates: any[]) => {
		for (const d of delegates) {
			ids.push(d.id);
			if (d.delegates) collectDelegateIds(d.delegates);
		}
	};

	const collectFromGoalGroup = (group: any) => {
		if (group.teamLead) {
			ids.push(group.teamLead.id);
			collectDelegateIds(group.teamLead.delegates || []);
			for (const m of group.teamMembers) { ids.push(m.id); collectDelegateIds(m.delegates || []); }
			for (const m of group.archivedMembers) { ids.push(m.id); collectDelegateIds(m.delegates || []); }
		}
		for (const s of group.nonTeamSessions) { ids.push(s.id); collectDelegateIds(s.delegates || []); }
	};

	for (const group of tree.goalGroups) collectFromGoalGroup(group);
	if (showArchived) for (const group of tree.archivedGoalGroups) collectFromGoalGroup(group);

	const getDelegateIds = (parentId: string, sess: any[], archived: any[]) => {
		const liveDelegates = sess.filter(s => (s.parentSessionId || s.delegateOf) === parentId);
		const archivedDels = showArchived ? archived.filter(s => (s.parentSessionId || s.delegateOf) === parentId) : [];
		for (const d of [...liveDelegates, ...archivedDels]) {
			ids.push(d.id);
			getDelegateIds(d.id, sess, archived);
		}
	};

	for (const s of tree.ungrouped) { ids.push(s.id); getDelegateIds(s.id, sessions, archivedSessions); }
	for (const s of tree.staff) ids.push(s.id);

	return ids;
}

function isTopLevel(tree: any, sessionId: string): boolean {
	const topLevelIds = new Set<string>();
	for (const group of [...tree.goalGroups, ...tree.archivedGoalGroups]) {
		if (group.teamLead) topLevelIds.add(group.teamLead.id);
		for (const m of group.teamMembers) topLevelIds.add(m.id);
		for (const s of group.nonTeamSessions) topLevelIds.add(s.id);
		for (const m of group.archivedMembers) topLevelIds.add(m.id);
	}
	for (const s of tree.ungrouped) topLevelIds.add(s.id);
	for (const s of tree.staff) topLevelIds.add(s.id);
	return topLevelIds.has(sessionId);
}

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockSessions: any[] = [
	{ id: "lead1", role: "team-lead", teamGoalId: "goal1", goalId: "goal1", status: "idle" },
	{ id: "member1", teamGoalId: "goal1", teamLeadSessionId: "lead1", status: "idle" },
	{ id: "member2", teamGoalId: "goal1", teamLeadSessionId: "lead1", status: "idle" },
	{ id: "delegate-of-member1", delegateOf: "member1", status: "idle" },
	{ id: "session-in-goal2", goalId: "goal2", status: "idle" },
	{ id: "delegate-of-goal2-session", delegateOf: "session-in-goal2", status: "idle" },
	{ id: "ungrouped1", status: "idle" },
	{ id: "ungrouped2", status: "idle" },
	{ id: "delegate-of-ungrouped1", delegateOf: "ungrouped1", status: "idle" },
	{ id: "pr-walkthrough-child", parentSessionId: "ungrouped1", childKind: "pr-walkthrough", readOnly: true, status: "idle" },
	{ id: "staff1", staffId: "my-staff", status: "idle" },
];

const mockArchivedSessions: any[] = [
	{ id: "archived-member3", teamGoalId: "goal1", teamLeadSessionId: "lead1", archived: true, status: "terminated" },
	{ id: "archived-delegate-of-lead", delegateOf: "lead1", archived: true, status: "terminated" },
	{ id: "archived-pr-walkthrough", parentSessionId: "lead1", childKind: "pr-walkthrough", archived: true, status: "terminated" },
];

const mockGoals: any[] = [
	{ id: "goal1", title: "Team Goal", team: true, archived: false },
	{ id: "goal2", title: "Solo Goal", team: false, archived: false },
];

describe("SB-00: Sidebar hierarchy and nesting", () => {
	it("team member with teamGoalId is categorized under that goal", () => {
		expect(categorizeSession(mockSessions[1], [])).toEqual({ section: "team-goal", goalId: "goal1" });
	});

	it("session with goalId is categorized under that goal", () => {
		expect(categorizeSession(mockSessions[4], [])).toEqual({ section: "goal", goalId: "goal2" });
	});

	it("session with delegateOf is categorized as delegate", () => {
		expect(categorizeSession(mockSessions[3], [])).toEqual({ section: "delegate", parentSessionId: "member1" });
	});

	it("PR walkthrough child uses parentSessionId without delegateOf", () => {
		expect(categorizeSession(mockSessions[9], [])).toEqual({ section: "delegate", parentSessionId: "ungrouped1" });
		expect(mockSessions[9].delegateOf).toBeUndefined();
	});

	it("ungrouped session is categorized as ungrouped", () => {
		expect(categorizeSession(mockSessions[6], [])).toEqual({ section: "ungrouped" });
	});

	it("staff session is categorized as staff", () => {
		expect(categorizeSession(mockSessions[10], [])).toEqual({ section: "staff" });
	});

	it("team lead with teamGoalId is categorized under that goal", () => {
		expect(categorizeSession(mockSessions[0], [])).toEqual({ section: "team-goal", goalId: "goal1" });
	});

	it("buildSidebarTree places team lead under goal group", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, false);
		const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
		expect(!!goalGroup?.teamLead).toBe(true);
		expect(goalGroup?.teamLead?.id).toBe("lead1");
	});

	it("team members grouped under their lead", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, false);
		const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
		const memberIds = goalGroup.teamMembers.map((m: any) => m.id);
		expect(memberIds).toContain("member1");
		expect(memberIds).toContain("member2");
		expect(memberIds).not.toContain("lead1");
	});

	it("delegates nested under parent, not at top level", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, false);
		const isTop = isTopLevel(tree, "delegate-of-member1");
		const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
		const member1 = goalGroup.teamMembers.find((m: any) => m.id === "member1");
		const delegateInMember = member1?.delegates?.some((d: any) => d.id === "delegate-of-member1");
		expect(isTop).toBe(false);
		expect(delegateInMember).toBe(true);
	});

	it("delegate of goal2 session nested under parent in non-team goal", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, false);
		const isTop = isTopLevel(tree, "delegate-of-goal2-session");
		const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal2");
		const parent = goalGroup.nonTeamSessions.find((s: any) => s.id === "session-in-goal2");
		const delegateNested = parent?.delegates?.some((d: any) => d.id === "delegate-of-goal2-session");
		expect(isTop).toBe(false);
		expect(delegateNested).toBe(true);
	});

	it("ungrouped sessions in ungrouped section", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, false);
		const ids = tree.ungrouped.map((s: any) => s.id);
		expect(ids).toContain("ungrouped1");
		expect(ids).toContain("ungrouped2");
		expect(ids).not.toContain("delegate-of-ungrouped1");
		expect(ids).not.toContain("pr-walkthrough-child");
	});

	it("staff in staff section", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, false);
		expect(tree.staff.map((s: any) => s.id)).toContain("staff1");
	});

	it("PR walkthrough child remains visible beneath its parent", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, false);
		const ids = getVisibleSessionIds(tree, false, mockSessions, mockArchivedSessions);
		const parentIndex = ids.indexOf("ungrouped1");
		const childIndex = ids.indexOf("pr-walkthrough-child");
		expect(parentIndex).toBeGreaterThanOrEqual(0);
		expect(childIndex).toBeGreaterThan(parentIndex);
	});

	it("delegate never appears at top level of any section", () => {
		const delegateIds = ["delegate-of-member1", "delegate-of-goal2-session", "delegate-of-ungrouped1", "pr-walkthrough-child"];
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, true);
		for (const id of delegateIds) {
			expect(isTopLevel(tree, id), `${id} should not be top-level`).toBe(false);
		}
	});

	it("only live sessions visible when showArchived=false", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, false);
		const ids = getVisibleSessionIds(tree, false);
		expect(ids).not.toContain("archived-member3");
		expect(ids).not.toContain("archived-delegate-of-lead");
		expect(ids).toContain("lead1");
		expect(ids).toContain("member1");
	});

	it("archived team member visible under live lead when showArchived=true", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, true);
		const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
		const archivedMemberIds = goalGroup.archivedMembers.map((m: any) => m.id);
		expect(archivedMemberIds).toContain("archived-member3");
	});

	it("archived delegate visible when showArchived=true", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, true);
		const goalGroup = tree.goalGroups.find((g: any) => g.goal.id === "goal1");
		const leadDelegates = goalGroup.teamLead.delegates.map((d: any) => d.id);
		expect(leadDelegates).toContain("archived-delegate-of-lead");
	});

	it("both live and archived members present when showArchived=true", () => {
		const tree = buildSidebarTree(mockSessions, mockArchivedSessions, mockGoals, true);
		const ids = getVisibleSessionIds(tree, true);
		expect(ids).toContain("lead1");
		expect(ids).toContain("member1");
		expect(ids).toContain("archived-member3");
		expect(ids).toContain("archived-delegate-of-lead");
	});

	it("archived goal hidden when showArchived=false", () => {
		const archivedGoals = [{ id: "goal-old", title: "Old Goal", team: true, archived: true }];
		const archivedSessions = [
			{ id: "old-lead", role: "team-lead", teamGoalId: "goal-old", archived: true, status: "terminated" },
		];
		const tree = buildSidebarTree([], archivedSessions, archivedGoals, false);
		expect(tree.archivedGoalGroups.length).toBe(0);
	});

	it("archived goal with full tree in archived section when showArchived=true", () => {
		const archivedGoals = [{ id: "goal-old", title: "Old Goal", team: true, archived: true }];
		const archivedSessions = [
			{ id: "old-lead", role: "team-lead", teamGoalId: "goal-old", archived: true, status: "terminated" },
			{ id: "old-member", teamGoalId: "goal-old", teamLeadSessionId: "old-lead", archived: true, status: "terminated" },
		];
		const tree = buildSidebarTree([], archivedSessions, archivedGoals, true);
		const group = tree.archivedGoalGroups[0];
		expect(tree.archivedGoalGroups.length).toBe(1);
		expect(group?.goal?.id).toBe("goal-old");
	});

	it("delegate of delegate nests correctly", () => {
		const sessions = [
			{ id: "parent", status: "idle" },
			{ id: "child", delegateOf: "parent", status: "idle" },
			{ id: "grandchild", delegateOf: "child", status: "idle" },
		];
		const tree = buildSidebarTree(sessions, [], [], false);
		expect(tree.ungrouped.map((s: any) => s.id)).toContain("parent");
		expect(tree.ungrouped.map((s: any) => s.id)).not.toContain("child");
		expect(tree.ungrouped.map((s: any) => s.id)).not.toContain("grandchild");
		expect(isTopLevel(tree, "parent")).toBe(true);
		expect(isTopLevel(tree, "child")).toBe(false);
		expect(isTopLevel(tree, "grandchild")).toBe(false);
	});

	it("recursive delegates in goal nest correctly", () => {
		const sessions = [
			{ id: "goal-session", goalId: "goal2", status: "idle" },
			{ id: "del1", delegateOf: "goal-session", status: "idle" },
			{ id: "del2", delegateOf: "del1", status: "idle" },
		];
		const goals = [{ id: "goal2", title: "Solo Goal", team: false, archived: false }];
		const tree = buildSidebarTree(sessions, [], goals, false);
		const group = tree.goalGroups[0];
		const parent = group.nonTeamSessions.find((s: any) => s.id === "goal-session");
		const del1 = parent?.delegates?.find((d: any) => d.id === "del1");
		const del2 = del1?.delegates?.find((d: any) => d.id === "del2");
		expect(parent?.delegates?.length > 0).toBe(true);
		expect(!!del1).toBe(true);
		expect(!!del2).toBe(true);
		expect(isTopLevel(tree, "del1")).toBe(false);
		expect(isTopLevel(tree, "del2")).toBe(false);
	});

	it("empty sessions produces empty tree", () => {
		const tree = buildSidebarTree([], [], [], false);
		expect(tree.goalGroups.length).toBe(0);
		expect(tree.ungrouped.length).toBe(0);
		expect(tree.staff.length).toBe(0);
		expect(tree.archivedGoalGroups.length).toBe(0);
	});

	it("session with both goalId and teamGoalId uses teamGoalId", () => {
		const cat = categorizeSession({ id: "x", goalId: "g1", teamGoalId: "g1", status: "idle" }, []);
		expect(cat.section).toBe("team-goal");
	});

	it("delegateOf takes priority over goalId", () => {
		const cat = categorizeSession({ id: "x", goalId: "g1", delegateOf: "parent1", status: "idle" }, []);
		expect(cat.section).toBe("delegate");
		expect(cat.parentSessionId).toBe("parent1");
	});
});
